import { Body, Controller, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS } from '@maritime/contracts';
import { AuditClient, KIT_ENV, KIT_POOL, ServiceOnly, enqueue, eventFromContext, notFound, withTx, zod } from '@maritime/service-kit';
import type { Env } from './env';
import { versionToApi, type ModelRow, type TrainingRunRow, type VersionRow } from './registry';

/*
 * The registry's service face: the model server reports a fit it executed, and the registry records it as a training
 * run and a version — a draft, carrying the metrics that were measured, for a person to validate and another to
 * approve. Reporting is idempotent: a version the registry already knows is brought up to date, never duplicated, so
 * the model server can tell the registry about everything it holds on every boot.
 */
const trainedBody = z.object({
  version: z.number().int().min(1),
  artifactRef: z.string().max(400), framework: z.string().max(80).default(''), featureSet: z.string().max(40).default(''),
  params: z.record(z.unknown()).default({}), metrics: z.record(z.unknown()).default({}),
  datasetRef: z.string().max(400).default(''), datasetRows: z.number().int().min(0).default(0),
  note: z.string().max(500).default(''), initiatedBy: z.string().max(120).default('ai-models'),
  startedAt: z.string().datetime({ offset: true }).optional(), finishedAt: z.string().datetime({ offset: true }).optional(),
});

@Controller('ai-platform/internal')
export class InternalController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  @ServiceOnly() @Post('models/:key/trained')
  async trained(@Param('key') key: string, @Body(zod(trainedBody)) b: z.infer<typeof trainedBody>) {
    const m = await this.pool.query<ModelRow>('SELECT * FROM models WHERE key = $1', [key]);
    const model = m.rows[0];
    if (!model) throw notFound(`No model "${key}" in the registry — a fit is recorded only against a registered model`);
    return withTx(this.pool, async (c) => {
      const existing = (await c.query<VersionRow>('SELECT * FROM model_versions WHERE model_id = $1 AND version = $2', [model.id, b.version])).rows[0] ?? null;
      const started = b.startedAt ? new Date(b.startedAt) : new Date(); const finished = b.finishedAt ? new Date(b.finishedAt) : new Date();
      const note = b.note || `${b.featureSet ? `${b.featureSet}: ` : ''}fitted on ${b.datasetRows} rows`;
      let run: TrainingRunRow;
      if (existing?.training_run_id) {
        run = (await c.query<TrainingRunRow>(
          `UPDATE training_runs SET dataset_ref = $2, dataset_rows = $3, params = $4, metrics = $5, status = 'SUCCEEDED', note = $6, initiated_by = $7, started_at = $8, finished_at = $9 WHERE id = $1 RETURNING *`,
          [existing.training_run_id, b.datasetRef, b.datasetRows, JSON.stringify(b.params), JSON.stringify(b.metrics), note, b.initiatedBy, started, finished])).rows[0];
      } else {
        run = (await c.query<TrainingRunRow>(
          `INSERT INTO training_runs(model_id, dataset_ref, dataset_rows, params, metrics, status, note, initiated_by, started_at, finished_at) VALUES ($1,$2,$3,$4,$5,'SUCCEEDED',$6,$7,$8,$9) RETURNING *`,
          [model.id, b.datasetRef, b.datasetRows, JSON.stringify(b.params), JSON.stringify(b.metrics), note, b.initiatedBy, started, finished])).rows[0];
      }
      let version: VersionRow; let created = false;
      if (existing) {
        version = (await c.query<VersionRow>(
          `UPDATE model_versions SET artifact_ref = $2, framework = COALESCE(NULLIF($3, ''), framework), training_run_id = $4, metrics = $5, params = $6, change_note = COALESCE(NULLIF($7, ''), change_note), updated_at = now() WHERE id = $1 RETURNING *`,
          [existing.id, b.artifactRef, b.framework, run.id, JSON.stringify(b.metrics), JSON.stringify(b.params), b.note])).rows[0];
      } else {
        created = true;
        version = (await c.query<VersionRow>(
          `INSERT INTO model_versions(model_id, version, artifact_ref, framework, training_run_id, metrics, params, status, change_note, created_by, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,'DRAFT',$8,$9,$10) RETURNING *`,
          [model.id, b.version, b.artifactRef, b.framework || model.framework, run.id, JSON.stringify(b.metrics), JSON.stringify(b.params), note, b.initiatedBy, finished])).rows[0];
      }
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.ai.modelTrained, { modelId: model.id, key: model.key, name: model.name, task: model.task, version: version.version, status: version.status, created, metrics: b.metrics, datasetRows: b.datasetRows, initiatedBy: b.initiatedBy }, { subject: `Model:${model.key}` }));
      await this.audit.record(c, { action: 'TRAIN', entity: 'ModelVersion', entityId: version.id, entityLabel: `${model.key} v${version.version}`, before: existing ? { metrics: existing.metrics, artifactRef: existing.artifact_ref } : null, after: { metrics: b.metrics, artifactRef: b.artifactRef, datasetRows: b.datasetRows }, note: created ? `Fitted by ${b.initiatedBy}: ${note}` : `Fit reported again by ${b.initiatedBy}: ${note}`, actor: { id: 'ai-models', name: 'Model server', kind: 'system' } });
      return { ...versionToApi(version), trainingRunId: run.id, created };
    });
  }
}
