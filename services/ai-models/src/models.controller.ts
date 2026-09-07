import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, conflict, notFound, withTx, zod, type Principal } from '@maritime/service-kit';
import { CATALOGUE, modelDef, type ModelDef } from './catalogue';
import { buildDataset, datasetApi } from './datasets';
import type { Env } from './env';
import { PlatformClient } from './platform';
import { TrainingRefused, artefactApi, artifactRef, defaultParams, reportToRegistry, runApi, runTraining, type ArtefactRow, type RunRow } from './training';

/*
 * The fitter's own face: what it can fit, what it has fitted, on what, how well — and the two things a person may ask of
 * it: fit a model again now, and tell the registry about every artefact it holds. Governance stays with the platform's
 * registry; a version fitted here is a draft there until a person validates and another approves it.
 */
const trainBody = z.object({
  featureSet: z.string().max(40).optional(),
  rounds: z.number().int().min(1).max(2000).optional(), depth: z.number().int().min(1).max(8).optional(),
  learningRate: z.number().min(0.001).max(1).optional(), minLeaf: z.number().int().min(1).max(500).optional(),
  holdout: z.number().min(0.05).max(0.5).optional(), seed: z.number().int().optional(), patience: z.number().int().min(0).max(500).optional(),
  note: z.string().max(500).default(''),
});
interface DatasetRow { id: string; model_key: string; built_at: Date; rows: number; positives: number | null; label_mean: string | null; label_std: string | null; feature_schema: unknown[]; sample: unknown[]; note: string }
const datasetRowApi = (d: DatasetRow) => ({ id: d.id, model: d.model_key, builtAt: d.built_at, rows: d.rows, positives: d.positives, labelMean: d.label_mean === null ? null : Number(d.label_mean), labelStd: d.label_std === null ? null : Number(d.label_std), schema: d.feature_schema, sample: d.sample, note: d.note });
const defApi = (d: ModelDef) => ({ key: d.key, task: d.task, name: d.name, description: d.description, label: d.label, unit: d.unit ?? null, features: d.features, featureSets: d.featureSets });

@Controller('ai-models')
export class ModelsController {
  private readonly platform: PlatformClient;
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {
    this.platform = new PlatformClient(env.AI_PLATFORM_URL, env.SERVICE_TOKEN);
  }
  private def(key: string): ModelDef { const d = modelDef(key); if (!d) throw notFound(`No model "${key}" in the catalogue`); return d; }

  private async served(days: number) {
    const r = await this.pool.query<{ model_key: string; calls: string; p50: string | null; p95: string | null; last: Date | null }>(
      `SELECT model_key, count(*) AS calls, percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50, percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) AS p95, max(at) AS last
       FROM inference_log WHERE at >= now() - ($1 || ' days')::interval GROUP BY model_key`, [String(days)]);
    return new Map(r.rows.map((x) => [x.model_key, { calls: Number(x.calls), p50Ms: x.p50 === null ? null : Math.round(Number(x.p50)), p95Ms: x.p95 === null ? null : Math.round(Number(x.p95)), lastAt: x.last }]));
  }

  @RequirePerm('models.view') @Get()
  async list() {
    const [artefacts, runs, served] = await Promise.all([
      this.pool.query<ArtefactRow>('SELECT * FROM artefacts ORDER BY model_key, version DESC'),
      this.pool.query<RunRow>('SELECT DISTINCT ON (model_key) * FROM training_runs ORDER BY model_key, started_at DESC'),
      this.served(30),
    ]);
    const counts = await this.pool.query<{ model_key: string; n: string; last: Date }>('SELECT model_key, count(*) AS n, max(started_at) AS last FROM training_runs GROUP BY model_key');
    return CATALOGUE.map((d) => {
      const mine = artefacts.rows.filter((a) => a.model_key === d.key);
      const c = counts.rows.find((x) => x.model_key === d.key);
      return {
        ...defApi(d), artefacts: mine.map(artefactApi), latest: mine[0] ? artefactApi(mine[0]) : null,
        lastRun: runs.rows.find((r) => r.model_key === d.key) ? runApi(runs.rows.find((r) => r.model_key === d.key)!) : null,
        runs: c ? Number(c.n) : 0, served: served.get(d.key) ?? { calls: 0, p50Ms: null, p95Ms: null, lastAt: null },
        defaults: defaultParams(this.env),
      };
    });
  }

  @RequirePerm('models.view') @Get(':key')
  async get(@Param('key') key: string) {
    const d = this.def(key);
    const [artefacts, runs, datasets, served] = await Promise.all([
      this.pool.query<ArtefactRow>('SELECT * FROM artefacts WHERE model_key = $1 ORDER BY version DESC', [key]),
      this.pool.query<RunRow>('SELECT * FROM training_runs WHERE model_key = $1 ORDER BY started_at DESC LIMIT 30', [key]),
      this.pool.query<DatasetRow>('SELECT * FROM datasets WHERE model_key = $1 ORDER BY built_at DESC LIMIT 10', [key]),
      this.served(30),
    ]);
    return { ...defApi(d), artefacts: artefacts.rows.map(artefactApi), runs: runs.rows.map(runApi), datasets: datasets.rows.map(datasetRowApi), served: served.get(key) ?? { calls: 0, p50Ms: null, p95Ms: null, lastAt: null }, defaults: defaultParams(this.env), minRows: this.env.TRAIN_MIN_ROWS };
  }

  /** The rows the model would be fitted on now — read, described and shown, not stored. */
  @RequirePerm('models.view') @Get(':key/dataset')
  async dataset(@Param('key') key: string) {
    const d = this.def(key);
    return datasetApi(await buildDataset(this.pool, this.env, d));
  }

  @RequirePerm('models.view') @Get(':key/artefacts/:version')
  async artefact(@Param('key') key: string, @Param('version') version: string) {
    this.def(key);
    const r = await this.pool.query<ArtefactRow>('SELECT * FROM artefacts WHERE model_key = $1 AND version = $2', [key, Number(version)]);
    if (!r.rows[0]) throw notFound(`${key} version ${version} was never fitted here`);
    return artefactApi(r.rows[0]);
  }

  /** Fit the model again, now, on the rows it can read; the result is a new version, reported to the registry as a draft. */
  @RequirePerm('models.manage') @Post(':key/train')
  async train(@Param('key') key: string, @Body(zod(trainBody)) b: z.infer<typeof trainBody>, @CurrentUser() user: Principal) {
    const d = this.def(key);
    if (b.featureSet && !d.featureSets.some((f) => f.name === b.featureSet)) throw conflict(`${key} has no feature set "${b.featureSet}" — the sets are ${d.featureSets.map((f) => f.name).join(', ')}`);
    let out;
    try {
      out = await runTraining(this.pool, this.env, this.platform, { key, featureSet: b.featureSet, params: { rounds: b.rounds, depth: b.depth, learningRate: b.learningRate, minLeaf: b.minLeaf, holdout: b.holdout, seed: b.seed, patience: b.patience }, note: b.note, initiatedBy: user.name });
    } catch (e) {
      if (e instanceof TrainingRefused) throw conflict(e.message);
      throw e;
    }
    await withTx(this.pool, (c) => this.audit.record(c, { action: 'TRAIN', entity: 'ModelVersion', entityId: out.artefact.id, entityLabel: `${key} v${out.artefact.version}`, after: { version: out.artefact.version, metrics: out.artefact.metrics, params: out.run.params, registry: out.registry }, note: b.note || `Fitted on ${out.dataset.stats.rows} rows` }));
    return { run: runApi(out.run), artefact: artefactApi(out.artefact), dataset: { rows: out.dataset.stats.rows, positives: out.dataset.stats.positives, featureSet: out.dataset.featureSet.name }, registry: out.registry };
  }

  /** Tell the registry about every artefact held here. Idempotent: a version it already knows is brought up to date. */
  @RequirePerm('models.manage') @Post('reconcile')
  async reconcile() {
    const artefacts = await this.pool.query<ArtefactRow>('SELECT * FROM artefacts ORDER BY model_key, version');
    const results = [];
    for (const a of artefacts.rows) {
      const run = a.training_run_id ? (await this.pool.query<RunRow>('SELECT * FROM training_runs WHERE id = $1', [a.training_run_id])).rows[0] ?? null : null;
      const rows = run?.dataset_id ? Number((await this.pool.query<{ rows: number }>('SELECT rows FROM datasets WHERE id = $1', [run.dataset_id])).rows[0]?.rows ?? 0) : 0;
      const out = await reportToRegistry(this.pool, this.platform, a, run, { id: run?.dataset_id ?? null, rows });
      results.push({ model: a.model_key, version: a.version, artifactRef: artifactRef(a.model_key, a.version), ...out });
    }
    return { artefacts: results.length, reported: results.filter((r) => r.ok).length, results };
  }
}
