import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { KIT_ENV, KIT_POOL, ServiceOnly, notFound, zod } from '@maritime/service-kit';
import { modelDef } from './catalogue';
import { predict } from './gbdt';
import type { Env } from './env';
import { artefactApi, type ArtefactRow } from './training';

/*
 * Serving, on the contract the model platform calls: POST /v1/models/{key}/infer with the version the platform's
 * deployment names, the features, and the fields it wants. Only the platform calls this — on the service token, inside
 * the cluster — because the platform is where an inference is authorised, recorded, timed against the budget and
 * watched for drift. This server answers from an artefact or not at all: a version that was never fitted here is 404,
 * which the platform records as the model server refusing rather than as an answer.
 */
const inferBody = z.object({
  version: z.coerce.number().int().min(1),
  task: z.string().max(40).optional(),
  features: z.record(z.unknown()).default({}),
  fields: z.array(z.string().max(80)).max(40).optional(),
});
const r3 = (n: number) => Math.round(n * 1000) / 1000;

@Controller('v1/models')
export class ServingController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env) {}

  private async artefact(key: string, version: number): Promise<ArtefactRow> {
    const r = await this.pool.query<ArtefactRow>('SELECT * FROM artefacts WHERE model_key = $1 AND version = $2', [key, version]);
    if (!r.rows[0]) throw notFound(modelDef(key) ? `${key} version ${version} was never fitted on this server` : `No model "${key}" on this server`);
    return r.rows[0];
  }

  /** What this server holds for a model: the versions it can answer for, and how each was fitted. */
  @ServiceOnly() @Get(':key')
  async describe(@Param('key') key: string) {
    const def = modelDef(key);
    if (!def) throw notFound(`No model "${key}" on this server`);
    const r = await this.pool.query<ArtefactRow>('SELECT * FROM artefacts WHERE model_key = $1 ORDER BY version DESC', [key]);
    return { key: def.key, task: def.task, name: def.name, versions: r.rows.map(artefactApi) };
  }

  @ServiceOnly() @Post(':key/infer')
  async infer(@Param('key') key: string, @Body(zod(inferBody)) b: z.infer<typeof inferBody>) {
    const t0 = process.hrtime.bigint();
    const a = await this.artefact(key, b.version);
    const def = modelDef(key);
    const y = predict(a.model, b.features);
    const imputed = a.model.features.filter((f) => b.features[f.name] === undefined || b.features[f.name] === null || b.features[f.name] === '').map((f) => f.name);
    const unknown = a.model.features.filter((f) => f.kind === 'cat' && !imputed.includes(f.name) && !(f.categories ?? []).includes(String(b.features[f.name]))).map((f) => f.name);
    const output: Record<string, unknown> = a.task === 'CLASSIFICATION'
      ? { score: r3(y), label: y >= this.env.BAND_HIGH ? 'HIGH' : y >= this.env.BAND_MEDIUM ? 'MEDIUM' : 'LOW' }
      : { value: Math.round(y * 100) / 100, unit: def?.unit ?? null };
    // The fit's own confidence, lowered for every feature the caller left out: an answer from the medians is still an
    // answer, but it is not one to be as sure of.
    const confidence = r3(Math.max(0.05, (a.metrics.confidence ?? 0.5) * (1 - 0.15 * imputed.length - 0.1 * unknown.length)));
    const latencyMs = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
    await this.pool.query('INSERT INTO inference_log(model_key, version, latency_ms) VALUES ($1,$2,$3)', [key, a.version, latencyMs]);
    return { model: key, version: a.version, task: a.task, output: { ...output, imputed, unknown }, confidence, latencyMs };
  }
}
