import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS } from '@maritime/contracts';
import {
  AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, conflict, enqueue, eventFromContext,
  getContext, notFound, withTx, zod, type Principal,
} from '@maritime/service-kit';
import type { Env } from './env';
import { ENVIRONMENTS, type DeploymentRow, type Environment, type ModelRow } from './registry';
import { HttpProvider, StubProvider, percentiles, serve, type ServingProvider } from './serving';

const features = z.record(z.unknown()).default({});
const inferBody = z.object({
  features, fields: z.array(z.string().max(80)).max(40).optional(),
  subject: z.string().max(120).default(''), environment: z.enum(ENVIRONMENTS).optional(),
});
/* Inline content is capped well below the body limit: a document or a recording belongs in the documents
 * service, and this endpoint takes a reference to it. The inline field exists for a page of text or a short
 * clip, not as a second file store. */
const CONTENT_MAX = 64_000;
const visionBody = z.object({
  modelKey: z.string().max(64).default('document-extraction'),
  documentRef: z.string().max(300).optional(),
  content: z.string().max(CONTENT_MAX).optional(),
  pages: z.number().int().min(1).max(500).default(1),
  fields: z.array(z.string().max(80)).min(1).max(40),
  hints: z.record(z.unknown()).default({}),
  subject: z.string().max(120).default(''),
});
const speechBody = z.object({
  modelKey: z.string().max(64).default('speech-transcription'),
  audioRef: z.string().max(300).optional(),
  durationSec: z.number().min(0).max(7200).default(0),
  language: z.string().max(12).default('en'),
  transcriptHint: z.string().max(CONTENT_MAX).optional(),
  subject: z.string().max(120).default(''),
});

const actor = () => getContext()?.actor ?? { id: 'system', name: 'system' };

/**
 * Serving, and the evidence for the latency commitment.
 *
 * A model answers only from a deployment: a version sitting approved in the registry is not servable, and a
 * request for one is refused and recorded as refused. That is what makes the deployment table the answer to
 * "what decided this", rather than a description of what someone believes is running.
 */
@Controller('ai-platform')
export class ServingController {
  private readonly provider: ServingProvider;
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {
    this.provider = env.SERVING_MODE === 'live' && env.SERVING_ENDPOINT
      ? new HttpProvider(env.SERVING_ENDPOINT, env.SERVING_TOKEN)
      : new StubProvider();
  }

  private async live(key: string, environment?: Environment): Promise<{ model: ModelRow; deployment: DeploymentRow }> {
    const m = await this.pool.query<ModelRow>('SELECT * FROM models WHERE key = $1', [key]);
    const model = m.rows[0];
    if (!model) throw notFound(`No model "${key}"`);
    if (model.status !== 'ACTIVE') throw conflict(`Model "${key}" is retired`);
    // Without an explicit environment, serve the most production-like deployment there is: a model live in
    // PROD answers from PROD, one still in test answers from test, and the response says which.
    const order = environment ? [environment] : ['PROD', 'UAT', 'DEV'];
    const d = await this.pool.query<DeploymentRow>(
      `SELECT * FROM deployments WHERE model_id = $1 AND status = 'ACTIVE' AND environment = ANY($2::text[])
       ORDER BY array_position($2::text[], environment) LIMIT 1`, [model.id, order]);
    if (!d.rows[0]) throw conflict(`Model "${key}" has no active deployment${environment ? ` in ${environment}` : ''}`);
    return { model, deployment: d.rows[0] };
  }

  /** Writes the inference row. Called on every path, including the ones that failed. */
  private async record(row: {
    model: ModelRow | null; key: string; version: number; environment: string; status: string;
    latencyMs: number; withinSla: boolean; features: Record<string, unknown>; output: Record<string, unknown>;
    confidence: number; subject: string; error?: string;
  }, user: Principal) {
    const correlation = getContext()?.correlationId ?? null;
    await withTx(this.pool, async (c) => {
      await c.query(
        `INSERT INTO inferences(model_key, model_id, version, environment, status, latency_ms, within_sla, features, output, confidence, subject, actor, correlation_id, error)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [row.key, row.model?.id ?? null, row.version, row.environment, row.status, row.latencyMs, row.withinSla,
          JSON.stringify(row.features), JSON.stringify(row.output), row.confidence, row.subject,
          JSON.stringify({ id: user.id, name: user.name }), correlation, row.error ?? null]);
      /* A breach is published, not only stored. The latency commitment is a service level someone is
       * accountable for, and a number nobody is told about is not a service level. */
      if (!row.withinSla && row.model) {
        await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.ai.inferenceBreached, {
          key: row.key, version: row.version, environment: row.environment, latencyMs: row.latencyMs,
          budgetMs: this.env.INFERENCE_SLA_MS, status: row.status,
        }, { subject: `Model:${row.key}` }));
      }
    });
  }

  @RequirePerm('ai.use') @Post('infer/:key')
  async infer(@Param('key') key: string, @Body(zod(inferBody)) b: z.infer<typeof inferBody>, @CurrentUser() user: Principal) {
    let model: ModelRow | null = null; let deployment: DeploymentRow | null = null;
    try {
      ({ model, deployment } = await this.live(key, b.environment));
    } catch (err) {
      await this.record({ model: null, key, version: 0, environment: b.environment ?? 'PROD', status: 'REFUSED', latencyMs: 0, withinSla: true, features: b.features, output: {}, confidence: 0, subject: b.subject, error: err instanceof Error ? err.message : 'refused' }, user);
      throw err;
    }
    const outcome = await serve(this.provider, { modelKey: model.key, task: model.task, version: deployment.version, features: b.features, fields: b.fields, subject: b.subject }, this.env.INFERENCE_SLA_MS);
    await this.record({ model, key: model.key, version: deployment.version, environment: deployment.environment, status: outcome.status, latencyMs: outcome.latencyMs, withinSla: outcome.withinSla, features: b.features, output: outcome.output, confidence: outcome.confidence, subject: b.subject, error: outcome.error }, user);
    if (outcome.status !== 'OK') throw conflict(`${outcome.error ?? 'Inference failed'} (${outcome.latencyMs} ms against a ${this.env.INFERENCE_SLA_MS} ms budget)`);
    return {
      model: model.key, version: deployment.version, environment: deployment.environment,
      residency: model.residency_region, mode: this.provider.mode,
      output: outcome.output, confidence: outcome.confidence,
      latencyMs: outcome.latencyMs, budgetMs: this.env.INFERENCE_SLA_MS, withinSla: outcome.withinSla,
    };
  }

  /** Document extraction. A certificate photographed at a gangway is the case this exists for. */
  @RequirePerm('ai.use') @Post('vision/extract')
  async vision(@Body(zod(visionBody)) b: z.infer<typeof visionBody>, @CurrentUser() user: Principal) {
    const { model, deployment } = await this.live(b.modelKey);
    const feat = { ...b.hints, documentRef: b.documentRef ?? '', pages: b.pages, contentLength: b.content?.length ?? 0 };
    const outcome = await serve(this.provider, { modelKey: model.key, task: model.task, version: deployment.version, features: feat, fields: b.fields, subject: b.subject }, this.env.INFERENCE_SLA_MS);
    await this.record({ model, key: model.key, version: deployment.version, environment: deployment.environment, status: outcome.status, latencyMs: outcome.latencyMs, withinSla: outcome.withinSla, features: feat, output: outcome.output, confidence: outcome.confidence, subject: b.subject, error: outcome.error }, user);
    if (outcome.status !== 'OK') throw conflict(outcome.error ?? 'Extraction failed');
    return { model: model.key, version: deployment.version, residency: model.residency_region, mode: this.provider.mode, ...outcome.output, confidence: outcome.confidence, latencyMs: outcome.latencyMs, withinSla: outcome.withinSla };
  }

  /** Transcription. A VHF exchange or a port-control recording attached to an incident. */
  @RequirePerm('ai.use') @Post('speech/transcribe')
  async speech(@Body(zod(speechBody)) b: z.infer<typeof speechBody>, @CurrentUser() user: Principal) {
    const { model, deployment } = await this.live(b.modelKey);
    const feat = { audioRef: b.audioRef ?? '', durationSec: b.durationSec, language: b.language, transcriptHint: b.transcriptHint ?? '' };
    const outcome = await serve(this.provider, { modelKey: model.key, task: model.task, version: deployment.version, features: feat, subject: b.subject }, this.env.INFERENCE_SLA_MS);
    await this.record({ model, key: model.key, version: deployment.version, environment: deployment.environment, status: outcome.status, latencyMs: outcome.latencyMs, withinSla: outcome.withinSla, features: feat, output: outcome.output, confidence: outcome.confidence, subject: b.subject, error: outcome.error }, user);
    if (outcome.status !== 'OK') throw conflict(outcome.error ?? 'Transcription failed');
    return { model: model.key, version: deployment.version, residency: model.residency_region, mode: this.provider.mode, ...outcome.output, confidence: outcome.confidence, latencyMs: outcome.latencyMs, withinSla: outcome.withinSla };
  }

  /**
   * The serving report: what the latency actually was, per model, against the budget.
   *
   * Percentiles rather than a mean, because a mean under five seconds is compatible with one caller in
   * twenty waiting thirty — and it is the caller waiting thirty who reports the platform as broken.
   */
  @RequirePerm('models.view') @Get('serving/stats')
  async stats(@Query('days') daysRaw?: string) {
    const days = Math.min(365, Math.max(1, Number(daysRaw) || 30));
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.pool.query<{ model_key: string; version: number; status: string; latency_ms: number; within_sla: boolean }>(
      'SELECT model_key, version, status, latency_ms, within_sla FROM inferences WHERE at >= $1', [since]);
    const byModel = new Map<string, { latencies: number[]; total: number; breaches: number; failures: number }>();
    for (const r of rows.rows) {
      const e = byModel.get(r.model_key) ?? { latencies: [], total: 0, breaches: 0, failures: 0 };
      e.total += 1;
      if (r.status === 'OK') e.latencies.push(r.latency_ms);
      if (!r.within_sla) e.breaches += 1;
      if (r.status !== 'OK') e.failures += 1;
      byModel.set(r.model_key, e);
    }
    const models = [...byModel.entries()].map(([key, e]) => ({
      model: key, calls: e.total, failures: e.failures, breaches: e.breaches,
      withinSlaPct: e.total ? Math.round(((e.total - e.breaches) / e.total) * 1000) / 10 : 100,
      latencyMs: percentiles(e.latencies),
    })).sort((a, b) => b.calls - a.calls);
    const all = rows.rows.filter((r) => r.status === 'OK').map((r) => r.latency_ms);
    const breaches = rows.rows.filter((r) => !r.within_sla).length;
    return {
      windowDays: days, budgetMs: this.env.INFERENCE_SLA_MS, mode: this.provider.mode,
      calls: rows.rows.length, breaches,
      withinSlaPct: rows.rows.length ? Math.round(((rows.rows.length - breaches) / rows.rows.length) * 1000) / 10 : 100,
      latencyMs: percentiles(all), models,
    };
  }
}
