import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { DEFINITION_ENVIRONMENTS, DEFINITION_VERSION_TRANSITIONS, EVENTS, SUBJECT_KINDS, canTransition, type DefinitionEnvironment, type DefinitionVersionStatus, type PageQuery } from '@maritime/contracts';
import { KIT_ENV, KIT_POOL, AuditClient, RequirePerm, zod, paged, parsePage, escapeLike, conflict, badRequest, withTx, enqueue, eventFromContext, getContext, ApiError } from '@maritime/service-kit';
import type { Env } from './env';
import { contentSchema, parseContent, validateContent, diffContent, type DefinitionContent } from './schema';
import { defaultWorkflow, stageDaysFor, CATEGORY_AR, OWNER_MODULE_BY_DOMAIN } from './defaults';
import { WORKFLOW_ENGINE, WorkflowEngine, type RequestState } from './engine';
import { definitionToApi, versionToApi, contentOf, loadDefinition, loadVersion, loadPublished, previousEnvironment, ENV_ORDER, type DefinitionRow, type VersionRow } from './repo';

const KEY = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/, 'key must be lowercase letters, digits, dots, dashes');
const ENV = z.enum(DEFINITION_ENVIRONMENTS);
const ar = z.string().max(400).optional().nullable();
const createSchema = z.object({
  key: KEY, code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9-]{1,39}$/).optional(), name: z.string().min(2).max(200), nameAr: ar, category: z.string().min(2).max(80).default('General'), categoryAr: ar,
  domain: z.number().int().min(0).max(9).default(0), subjectKind: z.enum([...SUBJECT_KINDS, 'NONE']).default('NONE'), description: z.string().max(2000).default(''), descriptionAr: z.string().max(2000).optional().nullable(),
  ownerModule: z.string().max(40).optional(), issuesInstrument: z.string().max(60).optional().nullable(), autoApprovable: z.boolean().default(false), content: contentSchema.partial().optional(), changeNote: z.string().max(500).default('Initial draft'),
});
const editSchema = contentSchema.partial().extend({ changeNote: z.string().max(500).optional(), environment: ENV.optional() });
const noteSchema = z.object({ note: z.string().max(500).optional(), environment: ENV.optional() });
const promoteSchema = z.object({ to: ENV, note: z.string().max(500).optional() });
const draftSchema = z.object({ changeNote: z.string().max(500).optional(), fromVersion: z.number().int().positive().optional(), fromEnvironment: ENV.optional() });
const simulateSchema = z.object({
  environment: ENV.optional(), formData: z.record(z.unknown()).default({}), documents: z.array(z.object({ code: z.string().max(60), verified: z.boolean().default(true), name: z.string().max(200).default('') })).default([]),
  subject: z.record(z.unknown()).default({}), subjectId: z.string().max(80).optional().nullable(), subjectName: z.string().max(200).default('Simulated subject'),
  applicant: z.object({ userId: z.string().optional().nullable(), name: z.string().default('Simulated applicant'), email: z.string().default(''), phone: z.string().default(''), organisation: z.string().default('') }).default({}),
  actions: z.array(z.object({ action: z.string().max(60), note: z.string().max(1000).default(''), payload: z.record(z.unknown()).default({}) }).or(z.string().max(60))).min(1),
  actor: z.object({ id: z.string().default('simulator'), name: z.string().default('Simulator'), perms: z.array(z.string()).default(['*']) }).default({}), now: z.string().datetime().optional(),
});
const SORT: Record<string, string> = { name: 'd.name', key: 'd.key', code: 'd.code', category: 'd.category', status: 'd.status', createdAt: 'd.created_at', updatedAt: 'd.updated_at', domain: 'd.domain' };
const actor = () => getContext()?.actor ?? { id: 'system', name: 'system', kind: 'system' as const };
const envOf = (v: unknown): DefinitionEnvironment | undefined => { const e = String(v ?? '').toUpperCase(); return (DEFINITION_ENVIRONMENTS as readonly string[]).includes(e) ? (e as DefinitionEnvironment) : undefined; };
type Summary = { version: number; environment: string; status: string; changeNote: string; publishedAt: Date | null; updatedAt: Date };

/** The Service Studio's back end: definitions and their versions through draft → review → approval → publication, promoted DEV → UAT → PROD. */
@Controller('services/definitions')
export class DefinitionsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, @Inject(WORKFLOW_ENGINE) private readonly engine: WorkflowEngine, private readonly audit: AuditClient) {}
  private async summaries(ids: string[]): Promise<Record<string, Summary[]>> {
    if (!ids.length) return {};
    const r = await this.pool.query<{ definition_id: string; version: number; environment: string; status: string; change_note: string; published_at: Date | null; updated_at: Date }>('SELECT definition_id, version, environment, status, change_note, published_at, updated_at FROM service_definition_versions WHERE definition_id = ANY($1::uuid[]) ORDER BY version, array_position(ARRAY[\'DEV\',\'UAT\',\'PROD\'], environment)', [ids]);
    const out: Record<string, Summary[]> = {};
    for (const v of r.rows) (out[v.definition_id] ??= []).push({ version: v.version, environment: v.environment, status: v.status, changeNote: v.change_note, publishedAt: v.published_at, updatedAt: v.updated_at });
    return out;
  }
  private async emit(c: PoolClient, type: string, def: DefinitionRow, ver: VersionRow | null, extra: Record<string, unknown> = {}) {
    const subject = `ServiceDefinition:${def.key}`;
    await enqueue(c, eventFromContext(this.env.SERVICE_NAME, type, { definitionId: def.id, key: def.key, code: def.code, name: def.name, version: ver?.version ?? null, environment: ver?.environment ?? null, status: ver?.status ?? null, ...extra }, { subject }));
    await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.readModel.upserted, { kind: 'serviceDefinition', entity: { ...definitionToApi(def), version: ver?.version ?? null, environment: ver?.environment ?? null, versionStatus: ver?.status ?? null } }, { subject }));
  }
  private problems(content: DefinitionContent) { const problems = validateContent(content, { maxDepth: this.env.EXPR_MAX_DEPTH }); return { problems, errors: problems.filter((p) => p.severity === 'ERROR'), warnings: problems.filter((p) => p.severity === 'WARN') }; }
  private async move(c: PoolClient, def: DefinitionRow, ver: VersionRow, to: DefinitionVersionStatus, set: string, args: unknown[]): Promise<VersionRow> {
    if (!canTransition(DEFINITION_VERSION_TRANSITIONS, ver.status, to)) throw conflict(`Version ${ver.version} (${ver.environment}) is ${ver.status.toLowerCase().replace('_', ' ')} and cannot move to ${to.toLowerCase().replace('_', ' ')}`);
    const r = await c.query<VersionRow>(`UPDATE service_definition_versions SET status = $2, ${set}, updated_at = now() WHERE id = $1 RETURNING *`, [ver.id, to, ...args]);
    await c.query('UPDATE service_definitions SET updated_at = now() WHERE id = $1', [def.id]);
    return r.rows[0];
  }

  @RequirePerm('services.view') @Get()
  async list(@Query() query: PageQuery & { category?: string; subjectKind?: string; status?: string; domain?: string }) {
    const p = parsePage(query, { defaultSort: 'name', sortable: Object.keys(SORT) });
    const where: string[] = []; const args: unknown[] = [];
    if (query.category) { args.push(query.category); where.push(`d.category = $${args.length}`); }
    if (query.subjectKind) { args.push(String(query.subjectKind).toUpperCase()); where.push(`d.subject_kind = $${args.length}`); }
    if (query.status) { args.push(String(query.status).toUpperCase()); where.push(`d.status = $${args.length}`); }
    if (query.domain) { args.push(Number(query.domain)); where.push(`d.domain = $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(d.key ILIKE $${args.length} OR d.code ILIKE $${args.length} OR d.name ILIKE $${args.length} OR coalesce(d.name_ar, '') ILIKE $${args.length} OR d.description ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM service_definitions d ${w}`, args);
    const rows = await this.pool.query<DefinitionRow>(`SELECT d.* FROM service_definitions d ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir}, d.id LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    const sums = await this.summaries(rows.rows.map((r) => r.id));
    return paged(rows.rows.map((r) => ({ ...definitionToApi(r), versions: sums[r.id] ?? [] })), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }
  @RequirePerm('services.manage') @Post()
  async create(@Body(zod(createSchema)) b: z.infer<typeof createSchema>) {
    const sla = b.content?.sla?.days ?? 10;
    const content = parseContent({ ...b.content, workflow: b.content?.workflow ?? defaultWorkflow({ issuesInstrument: b.issuesInstrument, stageDays: stageDaysFor(sla) }), outputs: { ...(b.content?.outputs ?? {}), instrumentType: b.content?.outputs?.instrumentType ?? b.issuesInstrument ?? null } });
    const { errors } = this.problems(content);
    if (errors.length) throw badRequest(`Definition is not valid: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { problems: errors });
    return withTx(this.pool, async (c) => {
      const exists = await c.query('SELECT 1 FROM service_definitions WHERE key = $1 OR code = $2', [b.key, (b.code ?? b.key.replace(/\./g, '-')).toUpperCase()]); if (exists.rowCount) throw conflict(`Service ${b.key} already exists`);
      const d = await c.query<DefinitionRow>('INSERT INTO service_definitions(key, code, name, name_ar, category, category_ar, domain, subject_kind, description, description_ar, owner_module, issues_instrument, auto_approvable, status, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,\'DRAFT\',$14) RETURNING *',
        [b.key, (b.code ?? b.key.replace(/\./g, '-')).toUpperCase(), b.name, b.nameAr ?? null, b.category, b.categoryAr ?? CATEGORY_AR[b.category] ?? null, b.domain, b.subjectKind, b.description, b.descriptionAr ?? null, b.ownerModule ?? OWNER_MODULE_BY_DOMAIN[b.domain] ?? 'workflow', b.issuesInstrument ?? null, b.autoApprovable, actor().id]);
      const v = await c.query<VersionRow>('INSERT INTO service_definition_versions(definition_id, version, environment, status, form, documents, fees, sla, workflow, outputs, change_note, created_by) VALUES ($1, 1, \'DEV\', \'DRAFT\', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *',
        [d.rows[0].id, JSON.stringify(content.form), JSON.stringify(content.documents), JSON.stringify(content.fees), JSON.stringify(content.sla), JSON.stringify(content.workflow), JSON.stringify(content.outputs), b.changeNote, actor().id]);
      await this.audit.record(c, { action: 'CREATE', entity: 'ServiceDefinition', entityId: d.rows[0].id, entityLabel: d.rows[0].code, after: { ...definitionToApi(d.rows[0]), version: versionToApi(v.rows[0], false) } });
      await this.emit(c, EVENTS.workflow.definitionCreated, d.rows[0], v.rows[0]);
      return { ...definitionToApi(d.rows[0]), versions: [versionToApi(v.rows[0])] };
    });
  }
  @RequirePerm('services.view') @Get(':id')
  async get(@Param('id') id: string) {
    const def = await loadDefinition(this.pool, id);
    const sums = await this.summaries([def.id]); const live = await loadPublished(this.pool, def.id, this.env.RUNTIME_ENVIRONMENT);
    const environments = Object.fromEntries(ENV_ORDER.map((e) => [e, (sums[def.id] ?? []).filter((s) => s.environment === e)]));
    return { ...definitionToApi(def), versions: sums[def.id] ?? [], environments, runtimeEnvironment: this.env.RUNTIME_ENVIRONMENT, live: live ? versionToApi(live) : null };
  }
  @RequirePerm('services.view') @Get(':id/versions')
  async versions(@Param('id') id: string) { const def = await loadDefinition(this.pool, id); const r = await this.pool.query<VersionRow>('SELECT * FROM service_definition_versions WHERE definition_id = $1 ORDER BY version, array_position(ARRAY[\'DEV\',\'UAT\',\'PROD\'], environment)', [def.id]); return r.rows.map((v) => versionToApi(v, false)); }
  @RequirePerm('services.view') @Get(':id/versions/:v')
  async version(@Param('id') id: string, @Param('v') v: string, @Query('environment') environment?: string) { const def = await loadDefinition(this.pool, id); return versionToApi(await loadVersion(this.pool, def.id, Number(v), envOf(environment))); }
  @RequirePerm('services.view') @Get(':id/versions/:v/diff/:v2')
  async diff(@Param('id') id: string, @Param('v') v: string, @Param('v2') v2: string, @Query('environment') e1?: string, @Query('environment2') e2?: string) {
    const def = await loadDefinition(this.pool, id);
    const a = await loadVersion(this.pool, def.id, Number(v), envOf(e1)); const b = await loadVersion(this.pool, def.id, Number(v2), envOf(e2));
    const changes = diffContent(contentOf(a), contentOf(b));
    return { from: versionToApi(a, false), to: versionToApi(b, false), changes, summary: Object.fromEntries(['form', 'documents', 'fees', 'sla', 'workflow', 'outputs'].map((s) => [s, changes.filter((c) => c.path.startsWith(`$.${s}`)).length])) };
  }
  /** A new DEV draft, numbered after the highest version, copied from the live PROD version unless another source is named. One open DEV draft at a time. */
  @RequirePerm('services.manage') @Post(':id/versions')
  async draft(@Param('id') id: string, @Body(zod(draftSchema)) b: z.infer<typeof draftSchema>) {
    return withTx(this.pool, async (c) => {
      const def = await loadDefinition(c, id);
      const open = await c.query<{ version: number }>("SELECT version FROM service_definition_versions WHERE definition_id = $1 AND environment = 'DEV' AND status IN ('DRAFT', 'IN_REVIEW') ORDER BY version DESC LIMIT 1", [def.id]);
      if (open.rowCount) throw conflict(`Version ${open.rows[0].version} is still open in DEV`);
      const latest = await c.query<{ max: number | null }>('SELECT max(version) AS max FROM service_definition_versions WHERE definition_id = $1', [def.id]);
      const base = b.fromVersion ? await loadVersion(c, def.id, b.fromVersion, b.fromEnvironment) : (await loadPublished(c, def.id, 'PROD')) ?? (latest.rows[0].max ? await loadVersion(c, def.id, latest.rows[0].max) : null);
      const content = base ? contentOf(base) : parseContent({ workflow: defaultWorkflow({ issuesInstrument: def.issues_instrument }), outputs: { instrumentType: def.issues_instrument } });
      const next = (latest.rows[0].max ?? 0) + 1;
      const v = await c.query<VersionRow>('INSERT INTO service_definition_versions(definition_id, version, environment, status, form, documents, fees, sla, workflow, outputs, change_note, created_by, promoted_from) VALUES ($1, $2, \'DEV\', \'DRAFT\', $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *',
        [def.id, next, JSON.stringify(content.form), JSON.stringify(content.documents), JSON.stringify(content.fees), JSON.stringify(content.sla), JSON.stringify(content.workflow), JSON.stringify(content.outputs), b.changeNote ?? (base ? `Draft from v${base.version} (${base.environment})` : 'Initial draft'), actor().id, base ? `v${base.version}:${base.environment}` : null]);
      await this.audit.record(c, { action: 'CREATE', entity: 'ServiceDefinitionVersion', entityId: v.rows[0].id, entityLabel: `${def.code} v${next} DEV`, after: versionToApi(v.rows[0], false) });
      await this.emit(c, EVENTS.workflow.definitionUpdated, def, v.rows[0], { change: 'DRAFT' });
      return versionToApi(v.rows[0]);
    });
  }
  /** Drafts are edited in DEV only; the sections sent replace the stored ones, the rest stay. */
  @RequirePerm('services.manage') @Put(':id/versions/:v')
  async edit(@Param('id') id: string, @Param('v') vs: string, @Body(zod(editSchema)) b: z.infer<typeof editSchema>) {
    return withTx(this.pool, async (c) => {
      const def = await loadDefinition(c, id); const ver = await loadVersion(c, def.id, Number(vs), b.environment ?? 'DEV', true);
      if (ver.status !== 'DRAFT') throw conflict(`Version ${ver.version} (${ver.environment}) is ${ver.status.toLowerCase().replace('_', ' ')}; only a draft can be edited`);
      const before = contentOf(ver);
      const content = parseContent({ form: b.form ?? before.form, documents: b.documents ?? before.documents, fees: b.fees ?? before.fees, sla: b.sla ?? before.sla, workflow: b.workflow ?? before.workflow, outputs: b.outputs ?? before.outputs });
      const r = await c.query<VersionRow>('UPDATE service_definition_versions SET form = $2, documents = $3, fees = $4, sla = $5, workflow = $6, outputs = $7, change_note = $8, updated_at = now() WHERE id = $1 RETURNING *',
        [ver.id, JSON.stringify(content.form), JSON.stringify(content.documents), JSON.stringify(content.fees), JSON.stringify(content.sla), JSON.stringify(content.workflow), JSON.stringify(content.outputs), b.changeNote ?? ver.change_note]);
      await this.audit.record(c, { action: 'UPDATE', entity: 'ServiceDefinitionVersion', entityId: ver.id, entityLabel: `${def.code} v${ver.version} ${ver.environment}`, before: { changes: diffContent(before, content).length }, after: versionToApi(r.rows[0], false) });
      await this.emit(c, EVENTS.workflow.definitionUpdated, def, r.rows[0], { change: 'EDIT' });
      return { ...versionToApi(r.rows[0]), validation: this.problems(content) };
    });
  }
  @RequirePerm('services.view') @Post(':id/versions/:v/validate')
  async validate(@Param('id') id: string, @Param('v') vs: string, @Body() b: { environment?: string }) {
    const def = await loadDefinition(this.pool, id); const ver = await loadVersion(this.pool, def.id, Number(vs), envOf(b?.environment));
    const { problems, errors, warnings } = this.problems(contentOf(ver));
    return { key: def.key, version: ver.version, environment: ver.environment, ok: errors.length === 0, problems, errors: errors.length, warnings: warnings.length };
  }
  @RequirePerm('services.manage') @Post(':id/versions/:v/submit-review')
  async submitReview(@Param('id') id: string, @Param('v') vs: string, @Body(zod(noteSchema)) b: z.infer<typeof noteSchema>) {
    return withTx(this.pool, async (c) => {
      const def = await loadDefinition(c, id); const ver = await loadVersion(c, def.id, Number(vs), b.environment ?? 'DEV', true);
      const { errors } = this.problems(contentOf(ver)); if (errors.length) throw badRequest(`Definition is not valid: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { problems: errors });
      const r = await this.move(c, def, ver, 'IN_REVIEW', 'submitted_by = $3', [actor().id]);
      await this.audit.record(c, { action: 'SUBMIT_REVIEW', entity: 'ServiceDefinitionVersion', entityId: ver.id, entityLabel: `${def.code} v${ver.version} ${ver.environment}`, before: { status: ver.status }, after: { status: 'IN_REVIEW' }, note: b.note });
      await this.emit(c, EVENTS.workflow.definitionReviewRequested, def, r);
      return versionToApi(r, false);
    });
  }
  @RequirePerm('services.manage') @Post(':id/versions/:v/approve')
  async approve(@Param('id') id: string, @Param('v') vs: string, @Body(zod(noteSchema)) b: z.infer<typeof noteSchema>) {
    return withTx(this.pool, async (c) => {
      const def = await loadDefinition(c, id); const ver = await loadVersion(c, def.id, Number(vs), b.environment ?? 'DEV', true);
      const r = await this.move(c, def, ver, 'APPROVED', 'approved_by = $3', [actor().id]);
      await this.audit.record(c, { action: 'APPROVE', entity: 'ServiceDefinitionVersion', entityId: ver.id, entityLabel: `${def.code} v${ver.version} ${ver.environment}`, before: { status: ver.status }, after: { status: 'APPROVED' }, note: b.note });
      await this.emit(c, EVENTS.workflow.definitionApproved, def, r);
      return versionToApi(r, false);
    });
  }
  /** Back to the drawing board from review or approval. */
  @RequirePerm('services.manage') @Post(':id/versions/:v/reopen')
  async reopen(@Param('id') id: string, @Param('v') vs: string, @Body(zod(noteSchema)) b: z.infer<typeof noteSchema>) {
    return withTx(this.pool, async (c) => {
      const def = await loadDefinition(c, id); const ver = await loadVersion(c, def.id, Number(vs), b.environment ?? 'DEV', true);
      const r = await this.move(c, def, ver, 'DRAFT', 'submitted_by = NULL, approved_by = NULL, change_note = $3', [b.note ? `${ver.change_note} — reopened: ${b.note}` : ver.change_note]);
      await this.audit.record(c, { action: 'REOPEN', entity: 'ServiceDefinitionVersion', entityId: ver.id, entityLabel: `${def.code} v${ver.version} ${ver.environment}`, before: { status: ver.status }, after: { status: 'DRAFT' }, note: b.note });
      await this.emit(c, EVENTS.workflow.definitionUpdated, def, r, { change: 'REOPEN' });
      return versionToApi(r, false);
    });
  }
  /** Publishing in an environment retires that environment's previous live version; in PROD it becomes the catalogue's current version. */
  @RequirePerm('services.manage') @Post(':id/versions/:v/publish')
  async publish(@Param('id') id: string, @Param('v') vs: string, @Body(zod(noteSchema)) b: z.infer<typeof noteSchema>) {
    return withTx(this.pool, async (c) => {
      const def = await loadDefinition(c, id); const ver = await loadVersion(c, def.id, Number(vs), b.environment ?? 'DEV', true);
      const { errors } = this.problems(contentOf(ver)); if (errors.length) throw badRequest(`Definition is not valid: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { problems: errors });
      const retired = await c.query<VersionRow>("UPDATE service_definition_versions SET status = 'RETIRED', retired_at = now(), updated_at = now() WHERE definition_id = $1 AND environment = $2 AND status = 'PUBLISHED' AND id <> $3 RETURNING *", [def.id, ver.environment, ver.id]);
      const r = await this.move(c, def, ver, 'PUBLISHED', 'published_by = $3, published_at = now()', [actor().id]);
      let d = def;
      if (ver.environment === 'PROD') { const u = await c.query<DefinitionRow>("UPDATE service_definitions SET current_version = $2, status = 'PUBLISHED', updated_at = now() WHERE id = $1 RETURNING *", [def.id, ver.version]); d = u.rows[0]; }
      await this.audit.record(c, { action: 'PUBLISH', entity: 'ServiceDefinitionVersion', entityId: ver.id, entityLabel: `${def.code} v${ver.version} ${ver.environment}`, before: { status: ver.status }, after: { status: 'PUBLISHED', retired: retired.rows.map((x) => x.version) }, note: b.note });
      for (const old of retired.rows) await this.emit(c, EVENTS.workflow.definitionRetired, d, old, { supersededBy: ver.version });
      await this.emit(c, EVENTS.workflow.definitionPublished, d, r, { retired: retired.rows.map((x) => x.version) });
      return { ...versionToApi(r, false), retired: retired.rows.map((x) => x.version), definition: definitionToApi(d) };
    });
  }
  /** DEV → UAT → PROD, one step at a time, from a published source; the copy arrives approved and is published in its own environment. */
  @RequirePerm('services.manage') @Post(':id/versions/:v/promote')
  async promote(@Param('id') id: string, @Param('v') vs: string, @Body(zod(promoteSchema)) b: z.infer<typeof promoteSchema>) {
    const from = previousEnvironment(b.to); if (!from) throw badRequest(`Versions are promoted into UAT or PROD, not ${b.to}`);
    return withTx(this.pool, async (c) => {
      const def = await loadDefinition(c, id);
      const src = await loadVersion(c, def.id, Number(vs), from, true);
      if (src.status !== 'PUBLISHED') throw conflict(`Version ${src.version} must be published in ${from} before it is promoted to ${b.to} (it is ${src.status.toLowerCase().replace('_', ' ')})`);
      const { errors } = this.problems(contentOf(src)); if (errors.length) throw badRequest(`Definition is not valid: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`, { problems: errors });
      const existing = await c.query<VersionRow>('SELECT * FROM service_definition_versions WHERE definition_id = $1 AND version = $2 AND environment = $3 FOR UPDATE', [def.id, src.version, b.to]);
      if (existing.rows[0] && (existing.rows[0].status === 'PUBLISHED' || existing.rows[0].status === 'RETIRED')) throw conflict(`Version ${src.version} is already ${existing.rows[0].status.toLowerCase()} in ${b.to}`);
      const cols = [JSON.stringify(src.form), JSON.stringify(src.documents), JSON.stringify(src.fees), JSON.stringify(src.sla), JSON.stringify(src.workflow), JSON.stringify(src.outputs), b.note ?? `Promoted from ${from}`, actor().id, `v${src.version}:${from}`];
      const r = existing.rows[0]
        ? await c.query<VersionRow>('UPDATE service_definition_versions SET status = \'APPROVED\', form = $2, documents = $3, fees = $4, sla = $5, workflow = $6, outputs = $7, change_note = $8, approved_by = $9, promoted_from = $10, updated_at = now() WHERE id = $1 RETURNING *', [existing.rows[0].id, ...cols])
        : await c.query<VersionRow>('INSERT INTO service_definition_versions(definition_id, version, environment, status, form, documents, fees, sla, workflow, outputs, change_note, approved_by, promoted_from, created_by) VALUES ($1, $2, $3, \'APPROVED\', $4, $5, $6, $7, $8, $9, $10, $11, $12, $11) RETURNING *', [def.id, src.version, b.to, ...cols]);
      await this.audit.record(c, { action: 'PROMOTE', entity: 'ServiceDefinitionVersion', entityId: r.rows[0].id, entityLabel: `${def.code} v${src.version} ${from} → ${b.to}`, before: { environment: from, status: src.status }, after: { environment: b.to, status: 'APPROVED' }, note: b.note });
      await this.emit(c, EVENTS.workflow.definitionPromoted, def, r.rows[0], { from, to: b.to });
      return versionToApi(r.rows[0], false);
    });
  }
  @RequirePerm('services.manage') @Post(':id/versions/:v/retire')
  async retire(@Param('id') id: string, @Param('v') vs: string, @Body(zod(noteSchema)) b: z.infer<typeof noteSchema>) {
    return withTx(this.pool, async (c) => {
      const def = await loadDefinition(c, id); const ver = await loadVersion(c, def.id, Number(vs), b.environment ?? 'PROD', true);
      const r = await this.move(c, def, ver, 'RETIRED', 'retired_at = now(), change_note = $3', [b.note ? `${ver.change_note} — retired: ${b.note}` : ver.change_note]);
      let d = def;
      if (ver.environment === 'PROD' && def.current_version === ver.version) { const u = await c.query<DefinitionRow>("UPDATE service_definitions SET status = 'RETIRED', current_version = NULL, updated_at = now() WHERE id = $1 RETURNING *", [def.id]); d = u.rows[0]; }
      await this.audit.record(c, { action: 'RETIRE', entity: 'ServiceDefinitionVersion', entityId: ver.id, entityLabel: `${def.code} v${ver.version} ${ver.environment}`, before: { status: ver.status }, after: { status: 'RETIRED' }, note: b.note });
      await this.emit(c, EVENTS.workflow.definitionRetired, d, r);
      return { ...versionToApi(r, false), definition: definitionToApi(d) };
    });
  }
  /** Dry run: a virtual request walks the given actions through this version — nothing is stored, nothing is sent. */
  @RequirePerm('services.view') @Post(':id/versions/:v/simulate')
  async simulate(@Param('id') id: string, @Param('v') vs: string, @Body(zod(simulateSchema)) b: z.infer<typeof simulateSchema>) {
    const def = await loadDefinition(this.pool, id); const ver = await loadVersion(this.pool, def.id, Number(vs), b.environment);
    const content = contentOf(ver); const engine = b.now ? this.engine.withOptions({ now: () => new Date(b.now!) }) : this.engine;
    const start = engine.startState(content); const t0 = engine.now().toISOString();
    let req: RequestState = {
      id: '00000000-0000-4000-a000-000000000000', number: 'SR-SIM-00001', definitionId: def.id, definitionKey: def.key, definitionName: def.name, definitionNameAr: def.name_ar, definitionVersion: ver.version, environment: ver.environment, category: def.category, domain: def.domain,
      subjectKind: def.subject_kind, subjectId: b.subjectId ?? null, subjectName: b.subjectName, subject: b.subject, applicant: { userId: b.applicant.userId ?? null, name: b.applicant.name, email: b.applicant.email, phone: b.applicant.phone, organisation: b.applicant.organisation }, status: 'DRAFT', currentState: start.key,
      formData: b.formData, documents: b.documents.map((d) => ({ code: d.code, documentId: null, name: d.name || `${d.code}.pdf`, uploadedAt: t0, verified: d.verified, verifiedBy: d.verified ? 'Simulator' : null, verifiedAt: d.verified ? t0 : null, notes: '' })),
      fees: null, payment: null, assignee: null, checks: [], slaDueAt: null, slaBreached: false, slaBreachedAt: null, submittedAt: null, decidedAt: null, closedAt: null, issuedInstrument: null, timeline: [], createdBy: b.actor.id, createdAt: t0, updatedAt: t0,
    };
    const steps: Record<string, unknown>[] = []; let ok = true;
    for (const step of b.actions) {
      const s = typeof step === 'string' ? { action: step, note: '', payload: {} } : step;
      try {
        const r = await engine.transition(req, content, s.action, b.actor, s.note, s.payload);
        req = r.request;
        steps.push({ action: s.action, from: r.entry.from, to: r.entry.to, status: req.status, effects: r.effects, events: r.events.map((e) => e.type), fees: req.fees, slaDueAt: req.slaDueAt, checks: r.entry.checks ?? null, ok: true });
      } catch (e) {
        ok = false; const err = e instanceof ApiError ? { status: e.getStatus(), message: (e.getResponse() as { message?: string }).message ?? e.message, ...(e.extra ?? {}) } : { status: 500, message: (e as Error).message };
        steps.push({ action: s.action, from: req.currentState, ok: false, error: err }); break;
      }
    }
    return { key: def.key, version: ver.version, environment: ver.environment, ok, steps, request: { status: req.status, currentState: req.currentState, formData: req.formData, fees: req.fees, payment: req.payment, checks: req.checks, slaDueAt: req.slaDueAt, timeline: req.timeline, issuedInstrument: req.issuedInstrument }, availableActions: engine.availableActions(content, req, b.actor) };
  }
}
