import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, type PageQuery } from '@maritime/contracts';
import {
  AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, badRequest, conflict, enqueue, escapeLike,
  eventFromContext, forbidden, getContext, notFound, paged, parsePage, withTx, zod, type Principal,
} from '@maritime/service-kit';
import { allowedResidency, type Env } from './env';
import {
  ENVIRONMENTS, MODEL_TASKS, canMove, deploymentToApi, modelToApi, trainingToApi, versionToApi,
  type DeploymentRow, type Environment, type ModelRow, type TrainingRunRow, type VersionRow, type VersionStatus,
} from './registry';

const KEY = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,63}$/, 'key must be lowercase letters, digits, dots, dashes');
const ar = z.string().max(400).optional().nullable();
const createModel = z.object({
  key: KEY, name: z.string().min(2).max(160), nameAr: ar, task: z.enum(MODEL_TASKS),
  purpose: z.string().max(2000).default(''), purposeAr: z.string().max(2000).optional().nullable(),
  owner: z.string().max(120).default(''), framework: z.string().max(80).default(''),
  residencyRegion: z.string().min(2).max(24).default('AE'), residencyNote: z.string().max(400).default(''),
});
const createVersion = z.object({
  artifactRef: z.string().max(400).default(''), framework: z.string().max(80).default(''),
  trainingRunId: z.string().uuid().optional().nullable(),
  metrics: z.record(z.unknown()).default({}), params: z.record(z.unknown()).default({}),
  changeNote: z.string().max(500).default('Initial version'),
});
const noteOnly = z.object({ note: z.string().max(500).default('') });
const deployBody = z.object({ environment: z.enum(ENVIRONMENTS), endpoint: z.string().max(300).default(''), replicas: z.number().int().min(1).max(64).default(1), note: z.string().max(500).default('') });
const startTraining = z.object({ datasetRef: z.string().max(400).default(''), datasetRows: z.number().int().min(0).default(0), params: z.record(z.unknown()).default({}), note: z.string().max(500).default('') });
const finishTraining = z.object({ status: z.enum(['SUCCEEDED', 'FAILED']), metrics: z.record(z.unknown()).default({}), note: z.string().max(500).default('') });

const SORT: Record<string, string> = { key: 'key', name: 'name', task: 'task', status: 'status', createdAt: 'created_at', updatedAt: 'updated_at' };
const actor = () => getContext()?.actor ?? { id: 'system', name: 'system' };

/**
 * The model registry and its lifecycle.
 *
 * A model that informs a regulatory decision is subject to the same discipline as the decision: which
 * version was in force, who approved it, when it changed, and where it physically ran. All four are columns
 * here rather than facts held in someone's deployment notes.
 */
@Controller('ai-platform/models')
export class ModelsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  private async model(key: string): Promise<ModelRow> {
    const r = await this.pool.query<ModelRow>('SELECT * FROM models WHERE key = $1', [key]);
    if (!r.rows[0]) throw notFound(`No model "${key}"`);
    return r.rows[0];
  }
  private async version(modelId: string, v: number): Promise<VersionRow> {
    const r = await this.pool.query<VersionRow>('SELECT * FROM model_versions WHERE model_id = $1 AND version = $2', [modelId, v]);
    if (!r.rows[0]) throw notFound(`No version ${v}`);
    return r.rows[0];
  }
  private async emit(c: PoolClient, type: string, model: ModelRow, extra: Record<string, unknown> = {}) {
    await enqueue(c, eventFromContext(this.env.SERVICE_NAME, type, { modelId: model.id, key: model.key, name: model.name, task: model.task, ...extra }, { subject: `Model:${model.key}` }));
  }
  /** `set` carries only the columns this transition owns; `updated_at` is this method's business, and adding
   * it to `set` as well is how one ends up assigning the same column twice in one statement. */
  private async move(c: PoolClient, model: ModelRow, ver: VersionRow, to: VersionStatus, set = '', args: unknown[] = []): Promise<VersionRow> {
    if (!canMove(ver.status, to)) throw conflict(`Version ${ver.version} is ${ver.status.toLowerCase()} and cannot become ${to.toLowerCase()}`);
    const assignments = ['status = $2', ...(set ? [set] : []), 'updated_at = now()'].join(', ');
    const r = await c.query<VersionRow>(`UPDATE model_versions SET ${assignments} WHERE id = $1 RETURNING *`, [ver.id, to, ...args]);
    return r.rows[0];
  }

  @RequirePerm('models.view') @Get()
  async list(@Query() query: PageQuery & { task?: string; status?: string }) {
    const p = parsePage(query, { defaultSort: 'key', sortable: Object.keys(SORT) });
    const where: string[] = []; const args: unknown[] = [];
    if (query.task) { args.push(String(query.task).toUpperCase()); where.push(`task = $${args.length}`); }
    if (query.status) { args.push(String(query.status).toUpperCase()); where.push(`status = $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(key ILIKE $${args.length} OR name ILIKE $${args.length} OR purpose ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM models ${w}`, args);
    const rows = await this.pool.query<ModelRow>(`SELECT * FROM models ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir}, id LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    const live = await this.pool.query<{ model_id: string; environment: Environment; version: number }>(
      `SELECT model_id, environment, version FROM deployments WHERE status = 'ACTIVE' AND model_id = ANY($1::uuid[])`, [rows.rows.map((r) => r.id)]);
    const byModel = new Map<string, Partial<Record<Environment, number>>>();
    for (const d of live.rows) byModel.set(d.model_id, { ...(byModel.get(d.model_id) ?? {}), [d.environment]: d.version });
    return paged(rows.rows.map((r) => ({ ...modelToApi(r), serving: byModel.get(r.id) ?? {} })), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  @RequirePerm('models.manage') @Post()
  async create(@Body(zod(createModel)) b: z.infer<typeof createModel>) {
    const existing = await this.pool.query('SELECT 1 FROM models WHERE key = $1', [b.key]);
    if (existing.rowCount) throw conflict(`A model with key "${b.key}" already exists`);
    return withTx(this.pool, async (c) => {
      const r = await c.query<ModelRow>(
        `INSERT INTO models(key, name, name_ar, task, purpose, purpose_ar, owner, framework, residency_region, residency_note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [b.key, b.name, b.nameAr ?? null, b.task, b.purpose, b.purposeAr ?? null, b.owner, b.framework, b.residencyRegion.toUpperCase(), b.residencyNote, actor().name]);
      const row = r.rows[0];
      await this.emit(c, EVENTS.ai.modelRegistered, row, { residency: row.residency_region });
      await this.audit.record(c, { action: 'CREATE', entity: 'Model', entityId: row.id, entityLabel: row.key, after: modelToApi(row), note: `Registered ${row.task.toLowerCase()} model` });
      return modelToApi(row);
    });
  }

  @RequirePerm('models.view') @Get(':key')
  async get(@Param('key') key: string) {
    const m = await this.model(key);
    const [versions, deployments, training, baseline] = await Promise.all([
      this.pool.query<VersionRow>('SELECT * FROM model_versions WHERE model_id = $1 ORDER BY version DESC', [m.id]),
      this.pool.query<DeploymentRow>('SELECT * FROM deployments WHERE model_id = $1 ORDER BY deployed_at DESC LIMIT 20', [m.id]),
      this.pool.query<TrainingRunRow>('SELECT * FROM training_runs WHERE model_id = $1 ORDER BY started_at DESC LIMIT 20', [m.id]),
      this.pool.query<{ version: number; sample_size: number }>('SELECT version, sample_size FROM baselines WHERE model_id = $1', [m.id]),
    ]);
    return {
      ...modelToApi(m),
      versions: versions.rows.map(versionToApi),
      deployments: deployments.rows.map(deploymentToApi),
      trainingRuns: training.rows.map(trainingToApi),
      baselines: baseline.rows.map((b) => ({ version: b.version, sampleSize: b.sample_size })),
    };
  }

  @RequirePerm('models.manage') @Post(':key/versions')
  async newVersion(@Param('key') key: string, @Body(zod(createVersion)) b: z.infer<typeof createVersion>) {
    const m = await this.model(key);
    return withTx(this.pool, async (c) => {
      const next = await c.query<{ v: number }>('SELECT COALESCE(max(version), 0) + 1 AS v FROM model_versions WHERE model_id = $1', [m.id]);
      const version = next.rows[0].v;
      const r = await c.query<VersionRow>(
        `INSERT INTO model_versions(model_id, version, artifact_ref, framework, training_run_id, metrics, params, change_note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [m.id, version, b.artifactRef, b.framework || m.framework, b.trainingRunId ?? null, JSON.stringify(b.metrics), JSON.stringify(b.params), b.changeNote, actor().name]);
      await this.audit.record(c, { action: 'CREATE', entity: 'ModelVersion', entityId: r.rows[0].id, entityLabel: `${m.key} v${version}`, after: versionToApi(r.rows[0]), note: b.changeNote });
      return versionToApi(r.rows[0]);
    });
  }

  @RequirePerm('models.view') @Get(':key/versions')
  async versions(@Param('key') key: string) {
    const m = await this.model(key);
    const r = await this.pool.query<VersionRow>('SELECT * FROM model_versions WHERE model_id = $1 ORDER BY version DESC', [m.id]);
    return r.rows.map(versionToApi);
  }

  @RequirePerm('models.manage') @Post(':key/versions/:v/validate')
  async validate(@Param('key') key: string, @Param('v') v: string, @Body(zod(noteOnly)) b: z.infer<typeof noteOnly>) {
    const m = await this.model(key); const ver = await this.version(m.id, Number(v));
    return withTx(this.pool, async (c) => {
      const moved = await this.move(c, m, ver, 'VALIDATED', 'validated_by = $3', [actor().name]);
      await this.audit.record(c, { action: 'UPDATE', entity: 'ModelVersion', entityId: moved.id, entityLabel: `${m.key} v${moved.version}`, before: { status: ver.status }, after: { status: moved.status }, note: b.note || 'Validated against its metrics' });
      return versionToApi(moved);
    });
  }

  /**
   * Approval is a person, and not the same person who created the version.
   *
   * A model that scores an inspection target or reads a certificate is evidence in a regulatory process; a
   * platform that lets its author wave it through has a maker-checker rule for licences and none for the
   * thing that recommends them.
   */
  @RequirePerm('models.manage') @Post(':key/versions/:v/approve')
  async approve(@Param('key') key: string, @Param('v') v: string, @Body(zod(noteOnly)) b: z.infer<typeof noteOnly>, @CurrentUser() user: Principal) {
    const m = await this.model(key); const ver = await this.version(m.id, Number(v));
    if (ver.created_by && ver.created_by === (user.name || actor().name)) {
      throw forbidden('A model version must be approved by someone other than the person who created it');
    }
    return withTx(this.pool, async (c) => {
      const moved = await this.move(c, m, ver, 'APPROVED', 'approved_by = $3, approved_at = now()', [user.name || actor().name]);
      await this.emit(c, EVENTS.ai.modelApproved, m, { version: moved.version, approvedBy: moved.approved_by });
      await this.audit.record(c, { action: 'APPROVE', entity: 'ModelVersion', entityId: moved.id, entityLabel: `${m.key} v${moved.version}`, before: { status: ver.status }, after: { status: moved.status, approvedBy: moved.approved_by }, note: b.note || 'Approved for deployment' });
      return versionToApi(moved);
    });
  }

  /**
   * Deployment, with the two conditions that make the registry worth keeping: the version has been approved
   * by a second person, and production only accepts a model whose inference runs in an allowed region.
   *
   * The residency check is here rather than in a deployment script because a script is a thing someone can
   * skip. `ALLOWED_PROD_RESIDENCY` is what turns the platform's hosting commitment into a refusal.
   */
  @RequirePerm('models.deploy') @Post(':key/versions/:v/deploy')
  async deploy(@Param('key') key: string, @Param('v') v: string, @Body(zod(deployBody)) b: z.infer<typeof deployBody>) {
    const m = await this.model(key); const ver = await this.version(m.id, Number(v));
    if (ver.status !== 'APPROVED' && ver.status !== 'DEPLOYED') throw conflict(`Version ${ver.version} is ${ver.status.toLowerCase()} — only an approved version can be deployed`);
    const allowed = allowedResidency(this.env);
    if (b.environment === 'PROD' && !allowed.includes(m.residency_region.toUpperCase())) {
      throw badRequest(`Model "${m.key}" runs in ${m.residency_region} and production accepts only ${allowed.join(', ')}`, { residency: m.residency_region, allowed });
    }
    return withTx(this.pool, async (c) => {
      const previous = await c.query<DeploymentRow>(`UPDATE deployments SET status = 'SUPERSEDED', retired_at = now() WHERE model_id = $1 AND environment = $2 AND status = 'ACTIVE' RETURNING *`, [m.id, b.environment]);
      const d = await c.query<DeploymentRow>(
        `INSERT INTO deployments(model_id, version, environment, endpoint, replicas, residency_region, note, deployed_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [m.id, ver.version, b.environment, b.endpoint, b.replicas, m.residency_region, b.note, actor().name]);
      if (ver.status !== 'DEPLOYED') await this.move(c, m, ver, 'DEPLOYED');
      if (b.environment === 'PROD') await c.query('UPDATE models SET current_version = $2, updated_at = now() WHERE id = $1', [m.id, ver.version]);
      await this.emit(c, EVENTS.ai.modelDeployed, m, { version: ver.version, environment: b.environment, residency: m.residency_region, supersededVersion: previous.rows[0]?.version ?? null });
      await this.audit.record(c, { action: 'DEPLOY', entity: 'Model', entityId: m.id, entityLabel: `${m.key} v${ver.version}`, before: previous.rows[0] ? { version: previous.rows[0].version, environment: b.environment } : null, after: deploymentToApi(d.rows[0]), note: b.note || `Deployed to ${b.environment}` });
      return deploymentToApi(d.rows[0]);
    });
  }

  @RequirePerm('models.deploy') @Post(':key/versions/:v/retire')
  async retire(@Param('key') key: string, @Param('v') v: string, @Body(zod(noteOnly)) b: z.infer<typeof noteOnly>) {
    const m = await this.model(key); const ver = await this.version(m.id, Number(v));
    return withTx(this.pool, async (c) => {
      const moved = await this.move(c, m, ver, 'RETIRED', 'retired_at = now()', []);
      await c.query(`UPDATE deployments SET status = 'ROLLED_BACK', retired_at = now() WHERE model_id = $1 AND version = $2 AND status = 'ACTIVE'`, [m.id, ver.version]);
      if (m.current_version === ver.version) await c.query('UPDATE models SET current_version = NULL, updated_at = now() WHERE id = $1', [m.id]);
      await this.emit(c, EVENTS.ai.modelRetired, m, { version: ver.version });
      await this.audit.record(c, { action: 'RETIRE', entity: 'ModelVersion', entityId: moved.id, entityLabel: `${m.key} v${moved.version}`, before: { status: ver.status }, after: { status: moved.status }, note: b.note || 'Retired' });
      return versionToApi(moved);
    });
  }

  @RequirePerm('models.view') @Get(':key/deployments')
  async deployments(@Param('key') key: string) {
    const m = await this.model(key);
    const r = await this.pool.query<DeploymentRow>('SELECT * FROM deployments WHERE model_id = $1 ORDER BY deployed_at DESC', [m.id]);
    return r.rows.map(deploymentToApi);
  }

  @RequirePerm('models.manage') @Post(':key/training-runs')
  async startTraining(@Param('key') key: string, @Body(zod(startTraining)) b: z.infer<typeof startTraining>) {
    const m = await this.model(key);
    const r = await this.pool.query<TrainingRunRow>(
      'INSERT INTO training_runs(model_id, dataset_ref, dataset_rows, params, note, initiated_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [m.id, b.datasetRef, b.datasetRows, JSON.stringify(b.params), b.note, actor().name]);
    return trainingToApi(r.rows[0]);
  }

  /** A failed run is kept. "We tried this and it was worse" is the part of the history that stops it being retried. */
  @RequirePerm('models.manage') @Post(':key/training-runs/:id/finish')
  async finishTraining(@Param('key') key: string, @Param('id') id: string, @Body(zod(finishTraining)) b: z.infer<typeof finishTraining>) {
    const m = await this.model(key);
    const r = await this.pool.query<TrainingRunRow>(
      `UPDATE training_runs SET status = $3, metrics = $4, note = COALESCE(NULLIF($5, ''), note), finished_at = now()
       WHERE id = $1 AND model_id = $2 AND status = 'RUNNING' RETURNING *`,
      [id, m.id, b.status, JSON.stringify(b.metrics), b.note]);
    if (!r.rows[0]) throw notFound('No running training run with that id for this model');
    return trainingToApi(r.rows[0]);
  }

  @RequirePerm('models.view') @Get(':key/training-runs')
  async trainingRuns(@Param('key') key: string) {
    const m = await this.model(key);
    const r = await this.pool.query<TrainingRunRow>('SELECT * FROM training_runs WHERE model_id = $1 ORDER BY started_at DESC', [m.id]);
    return r.rows.map(trainingToApi);
  }
}
