import type { Pool, PoolClient } from 'pg';
import { withTx } from '@maritime/service-kit';
import { modelDef, type ModelDef } from './catalogue';
import { buildDataset, recordDataset, type Dataset } from './datasets';
import { train, type Metrics, type Model, type TrainParams } from './gbdt';
import type { Env } from './env';
import type { PlatformClient, RegistryOutcome } from './platform';

/*
 * A training run is a fit that was executed here: the dataset it read, the parameters it used, the metrics read off
 * the held-out rows, and the artefact it became. A run that could not fit stays on the record with its reason.
 */
export class TrainingRefused extends Error { constructor(message: string) { super(message); this.name = 'TrainingRefused'; } }

export interface TrainRequest {
  key: string; featureSet?: string; params?: Partial<TrainParams>; note?: string; initiatedBy: string;
  /** A version to fit and keep: the seed fits a lineage under fixed numbers; a request takes the next one. */
  version?: number;
}
export interface ArtefactRow { id: string; model_key: string; version: number; task: string; model: Model; feature_schema: unknown[]; metrics: Metrics & { featureSet?: string }; training_run_id: string | null; created_at: Date }
export interface RunRow { id: string; model_key: string; dataset_id: string | null; params: Record<string, unknown>; metrics: Record<string, unknown>; status: string; error: string | null; initiated_by: string; version: number | null; registry_version: number | null; registry_run_id: string | null; started_at: Date; finished_at: Date | null; duration_ms: number | null }
export interface TrainingOutcome { run: RunRow; artefact: ArtefactRow; dataset: Dataset; registry: RegistryOutcome | null }

export const defaultParams = (env: Env): TrainParams => ({ rounds: env.TRAIN_ROUNDS, depth: env.TRAIN_DEPTH, learningRate: env.TRAIN_LEARNING_RATE, minLeaf: env.TRAIN_MIN_LEAF, holdout: env.TRAIN_HOLDOUT, seed: env.TRAIN_SEED, patience: env.TRAIN_PATIENCE });
export const artifactRef = (key: string, version: number) => `ai-models://${key}/${version}`;
export const FRAMEWORK = 'gradient-boosted trees (ai-models)';

export const runApi = (r: RunRow) => ({
  id: r.id, model: r.model_key, datasetId: r.dataset_id, params: r.params, metrics: r.metrics, status: r.status, error: r.error, initiatedBy: r.initiated_by,
  version: r.version, registryVersion: r.registry_version, registryRunId: r.registry_run_id, startedAt: r.started_at, finishedAt: r.finished_at, durationMs: r.duration_ms,
});
/** An artefact as the API shows it: everything but the trees, which are the model's business alone. */
export const artefactApi = (a: ArtefactRow) => ({
  id: a.id, model: a.model_key, version: a.version, task: a.task, artifactRef: artifactRef(a.model_key, a.version), framework: FRAMEWORK,
  featureSet: a.metrics.featureSet ?? null, features: (a.feature_schema as { name: string }[]).map((f) => f.name), schema: a.feature_schema,
  metrics: a.metrics, trees: a.model.trees.length, depth: a.model.depth, learningRate: a.model.lr, trainingRunId: a.training_run_id, createdAt: a.created_at,
});

async function nextVersion(c: PoolClient, key: string): Promise<number> {
  const r = await c.query<{ v: number }>('SELECT COALESCE(max(version), 0) + 1 AS v FROM artefacts WHERE model_key = $1', [key]);
  return r.rows[0].v;
}

/** Tells the registry about one artefact; the outcome is recorded on the run, never thrown. */
export async function reportToRegistry(pool: Pool, platform: PlatformClient, a: ArtefactRow, run: RunRow | null, dataset: { id: string | null; rows: number }): Promise<RegistryOutcome> {
  const out = await platform.trained(a.model_key, {
    version: a.version, artifactRef: artifactRef(a.model_key, a.version), framework: FRAMEWORK, featureSet: a.metrics.featureSet ?? '',
    params: run?.params ?? {}, metrics: { ...a.metrics }, datasetRef: dataset.id ? `ai-models://datasets/${dataset.id}` : '', datasetRows: dataset.rows,
    note: run ? String(run.params.note ?? '') : '', initiatedBy: run?.initiated_by ?? 'ai-models',
    startedAt: (run?.started_at ?? a.created_at).toISOString(), finishedAt: (run?.finished_at ?? a.created_at).toISOString(),
  });
  if (run) {
    if (out.ok) await pool.query('UPDATE training_runs SET registry_version = $2, registry_run_id = $3 WHERE id = $1', [run.id, out.version, out.trainingRunId]);
    else await pool.query('UPDATE training_runs SET registry_run_id = NULL, registry_version = NULL WHERE id = $1', [run.id]);
  }
  return out;
}

/**
 * Fits a model on the rows it can read now. The fit itself is synchronous and short — the platform's tabular questions
 * fit in well under a second on a laptop — so the run is a request that answers with its result rather than a job to
 * poll. The registry is told afterwards; whether it could be reached is part of the outcome.
 */
export async function runTraining(pool: Pool, env: Env, platform: PlatformClient | null, req: TrainRequest): Promise<TrainingOutcome> {
  const def: ModelDef | undefined = modelDef(req.key);
  if (!def) throw new TrainingRefused(`no model "${req.key}" in the catalogue`);
  const params: TrainParams = { ...defaultParams(env), ...Object.fromEntries(Object.entries(req.params ?? {}).filter(([, v]) => v !== undefined && v !== null)) } as TrainParams;
  const dataset = await buildDataset(pool, env, def, req.featureSet);
  const started = new Date(); const t0 = process.hrtime.bigint();
  const elapsed = () => Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  const recorded = { ...params, featureSet: dataset.featureSet.name, note: req.note ?? '' };

  if (dataset.rows.length < env.TRAIN_MIN_ROWS) {
    await pool.query(`INSERT INTO training_runs(model_key, params, status, error, initiated_by, started_at, finished_at, duration_ms) VALUES ($1,$2,'FAILED',$3,$4,$5,now(),$6)`,
      [def.key, JSON.stringify(recorded), `too few rows to fit: ${dataset.rows.length} of the ${env.TRAIN_MIN_ROWS} needed`, req.initiatedBy, started, elapsed()]);
    throw new TrainingRefused(`${def.key} has ${dataset.rows.length} rows to learn from and needs at least ${env.TRAIN_MIN_ROWS}`);
  }

  const { run, artefact } = await withTx(pool, async (c) => {
    const datasetId = await recordDataset(c, dataset);
    const r = await c.query<RunRow>(`INSERT INTO training_runs(model_key, dataset_id, params, initiated_by, started_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [def.key, datasetId, JSON.stringify(recorded), req.initiatedBy, started]);
    const run = r.rows[0];
    let fitted: { model: Model; metrics: Metrics };
    try {
      fitted = train(dataset.rows, def.task, params, dataset.declared);
    } catch (e) {
      const failed = await c.query<RunRow>(`UPDATE training_runs SET status = 'FAILED', error = $2, finished_at = now(), duration_ms = $3 WHERE id = $1 RETURNING *`, [run.id, (e as Error).message, elapsed()]);
      throw new TrainingRefused(`the fit failed: ${failed.rows[0].error}`);
    }
    const version = req.version ?? (await nextVersion(c, def.key));
    const metrics = { ...fitted.metrics, featureSet: dataset.featureSet.name };
    const a = await c.query<ArtefactRow>(
      `INSERT INTO artefacts(model_key, version, task, model, feature_schema, metrics, training_run_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (model_key, version) DO UPDATE SET task = EXCLUDED.task, model = EXCLUDED.model, feature_schema = EXCLUDED.feature_schema, metrics = EXCLUDED.metrics, training_run_id = EXCLUDED.training_run_id, created_at = now()
       RETURNING *`,
      [def.key, version, def.task, JSON.stringify(fitted.model), JSON.stringify(fitted.model.features), JSON.stringify(metrics), run.id]);
    const done = await c.query<RunRow>(`UPDATE training_runs SET status = 'SUCCEEDED', metrics = $2, version = $3, finished_at = now(), duration_ms = $4 WHERE id = $1 RETURNING *`,
      [run.id, JSON.stringify(metrics), version, elapsed()]);
    return { run: done.rows[0], artefact: a.rows[0] };
  });

  const registry = platform ? await reportToRegistry(pool, platform, artefact, run, { id: run.dataset_id, rows: dataset.rows.length }) : null;
  const fresh = await pool.query<RunRow>('SELECT * FROM training_runs WHERE id = $1', [run.id]);
  return { run: fresh.rows[0], artefact, dataset, registry };
}
