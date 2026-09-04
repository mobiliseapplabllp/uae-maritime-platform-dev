import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS } from '@maritime/contracts';
import {
  AuditClient, KIT_ENV, KIT_POOL, RequirePerm, badRequest, conflict, enqueue, eventFromContext,
  getContext, notFound, withTx, zod,
} from '@maritime/service-kit';
import type { Env } from './env';
import { baselineToApi, driftToApi, type BaselineRow, type DriftRunRow, type ModelRow } from './registry';
import { compare, summarise, type Distribution } from './drift';

const captureBody = z.object({
  version: z.number().int().positive(),
  fromDays: z.number().int().min(1).max(365).default(90),
  buckets: z.number().int().min(2).max(20).default(10),
  note: z.string().max(500).default(''),
});
const runBody = z.object({ version: z.number().int().positive().optional(), days: z.number().int().min(1).max(365).optional() });
const actor = () => getContext()?.actor ?? { id: 'system', name: 'system' };

interface InferenceSample { features: Record<string, unknown>; output: Record<string, unknown> }

/** The scalar an output distribution is built from: a score, a value, or the label if neither is present. */
const outputValue = (output: Record<string, unknown>): unknown =>
  (typeof output.score === 'number' ? output.score : typeof output.value === 'number' ? output.value : output.label ?? null);

/**
 * Drift.
 *
 * The registry says what a model is; this says whether the world it was fitted to still looks like the world
 * it is being asked about. Both halves are needed — a model that was approved on last year's traffic and has
 * been quietly answering about a different traffic mix ever since is the failure this is here to surface,
 * and it is invisible to accuracy monitoring when no ground truth comes back for months.
 */
@Controller('ai-platform/drift')
export class DriftController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  private async model(key: string): Promise<ModelRow> {
    const r = await this.pool.query<ModelRow>('SELECT * FROM models WHERE key = $1', [key]);
    if (!r.rows[0]) throw notFound(`No model "${key}"`);
    return r.rows[0];
  }
  private async samples(key: string, from: Date, to: Date): Promise<InferenceSample[]> {
    const r = await this.pool.query<InferenceSample>(
      `SELECT features, output FROM inferences WHERE model_key = $1 AND status = 'OK' AND at >= $2 AND at < $3 ORDER BY at`, [key, from, to]);
    return r.rows;
  }
  /** Pivots rows of features into columns of values — the shape a distribution is built from. */
  private columns(rows: InferenceSample[]): Record<string, unknown[]> {
    const out: Record<string, unknown[]> = {};
    for (const row of rows) for (const [k, v] of Object.entries(row.features ?? {})) (out[k] ??= []).push(v);
    return out;
  }

  /**
   * Captures the reference distribution a version is judged against.
   *
   * It is captured explicitly rather than derived on the fly, because a baseline that moves with the data
   * can never detect that the data moved. This is the one operation whose omission makes the whole feature
   * report "stable" forever, so a drift run refuses to answer without one.
   */
  @RequirePerm('models.manage') @Post(':key/baseline')
  async capture(@Param('key') key: string, @Body(zod(captureBody)) b: z.infer<typeof captureBody>) {
    const m = await this.model(key);
    const to = new Date(); const from = new Date(to.getTime() - b.fromDays * 86_400_000);
    const rows = await this.samples(m.key, from, to);
    if (rows.length < this.env.DRIFT_MIN_SAMPLE) {
      throw badRequest(`A baseline needs at least ${this.env.DRIFT_MIN_SAMPLE} successful inferences; this window has ${rows.length}`, { sampleSize: rows.length, required: this.env.DRIFT_MIN_SAMPLE });
    }
    const cols = this.columns(rows);
    const featureDists: Record<string, Distribution> = {};
    for (const [name, values] of Object.entries(cols)) featureDists[name] = summarise(values, { buckets: b.buckets });
    const outputs = rows.map((r) => outputValue(r.output ?? {})).filter((v) => v !== null && v !== undefined);
    const outputDist = outputs.length ? summarise(outputs, { buckets: b.buckets }) : null;

    return withTx(this.pool, async (c) => {
      const r = await c.query<BaselineRow>(
        `INSERT INTO baselines(model_id, version, captured_from, captured_to, sample_size, features, output, note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (model_id, version) DO UPDATE SET captured_from = EXCLUDED.captured_from, captured_to = EXCLUDED.captured_to,
           sample_size = EXCLUDED.sample_size, features = EXCLUDED.features, output = EXCLUDED.output, note = EXCLUDED.note, created_by = EXCLUDED.created_by
         RETURNING *`,
        [m.id, b.version, from, to, rows.length, JSON.stringify(featureDists), JSON.stringify(outputDist ?? {}), b.note, actor().name]);
      await this.audit.record(c, { action: 'CREATE', entity: 'ModelBaseline', entityId: r.rows[0].id, entityLabel: `${m.key} v${b.version}`, after: baselineToApi(r.rows[0]), note: b.note || `Captured from ${rows.length} inferences` });
      return { ...baselineToApi(r.rows[0]), featureCount: Object.keys(featureDists).length, hasOutputBaseline: !!outputDist };
    });
  }

  @RequirePerm('models.view') @Get(':key/baseline')
  async baseline(@Param('key') key: string, @Query('version') v?: string) {
    const m = await this.model(key);
    const r = await this.pool.query<BaselineRow>(
      v ? 'SELECT * FROM baselines WHERE model_id = $1 AND version = $2' : 'SELECT * FROM baselines WHERE model_id = $1 ORDER BY version DESC LIMIT 1',
      v ? [m.id, Number(v)] : [m.id]);
    if (!r.rows[0]) throw notFound(`No baseline captured for "${key}"${v ? ` version ${v}` : ''}`);
    return baselineToApi(r.rows[0]);
  }

  /** Runs the comparison and records it. Insufficient data is a recorded outcome, not a silent pass. */
  @RequirePerm('models.manage') @Post(':key/run')
  async run(@Param('key') key: string, @Body(zod(runBody)) b: z.infer<typeof runBody>) {
    const m = await this.model(key);
    const bl = await this.pool.query<BaselineRow>(
      b.version ? 'SELECT * FROM baselines WHERE model_id = $1 AND version = $2' : 'SELECT * FROM baselines WHERE model_id = $1 ORDER BY version DESC LIMIT 1',
      b.version ? [m.id, b.version] : [m.id]);
    const baseline = bl.rows[0];
    if (!baseline) throw conflict(`Model "${key}" has no captured baseline, so there is nothing to compare against`);

    const days = b.days ?? this.env.DRIFT_WINDOW_DAYS;
    const to = new Date(); const from = new Date(to.getTime() - days * 86_400_000);
    // The observed window starts where the baseline ended: comparing a period against a baseline captured
    // from the same rows measures nothing but rounding.
    const windowFrom = from > baseline.captured_to ? from : baseline.captured_to;
    const rows = await this.samples(m.key, windowFrom, to);
    const outputs = rows.map((r) => outputValue(r.output ?? {})).filter((v) => v !== null && v !== undefined);
    const outputBaseline = baseline.output && 'bins' in baseline.output ? (baseline.output as Distribution) : undefined;

    const result = compare(
      { features: baseline.features, output: outputBaseline },
      { features: this.columns(rows), output: outputs },
      { minSample: this.env.DRIFT_MIN_SAMPLE, thresholds: { moderate: this.env.DRIFT_PSI_MODERATE, significant: this.env.DRIFT_PSI_SIGNIFICANT } });

    return withTx(this.pool, async (c) => {
      const r = await c.query<DriftRunRow>(
        `INSERT INTO drift_runs(model_id, version, baseline_id, window_from, window_to, sample_size, verdict, max_psi, results, run_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [m.id, baseline.version, baseline.id, windowFrom, to, result.sampleSize, result.verdict, result.maxPsi, JSON.stringify(result.features), actor().name]);
      /* A significant reading is published so the agent-governance surface and whoever owns the model both
       * hear about it. A drift report nobody is told about is a log file. */
      if (result.verdict === 'SIGNIFICANT') {
        await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.ai.modelDrifted, {
          key: m.key, version: baseline.version, verdict: result.verdict, maxPsi: result.maxPsi,
          sampleSize: result.sampleSize, features: result.features.slice(0, 5).map((f) => ({ feature: f.feature, psi: f.psi })),
        }, { subject: `Model:${m.key}` }));
      }
      return { ...driftToApi(r.rows[0]), thresholds: { moderate: this.env.DRIFT_PSI_MODERATE, significant: this.env.DRIFT_PSI_SIGNIFICANT }, minSample: this.env.DRIFT_MIN_SAMPLE };
    });
  }

  @RequirePerm('models.view') @Get(':key')
  async history(@Param('key') key: string) {
    const m = await this.model(key);
    const [runs, baselines] = await Promise.all([
      this.pool.query<DriftRunRow>('SELECT * FROM drift_runs WHERE model_id = $1 ORDER BY at DESC LIMIT 50', [m.id]),
      this.pool.query<BaselineRow>('SELECT * FROM baselines WHERE model_id = $1 ORDER BY version DESC', [m.id]),
    ]);
    return {
      model: m.key,
      thresholds: { moderate: this.env.DRIFT_PSI_MODERATE, significant: this.env.DRIFT_PSI_SIGNIFICANT },
      baselines: baselines.rows.map(baselineToApi),
      runs: runs.rows.map(driftToApi),
    };
  }
}
