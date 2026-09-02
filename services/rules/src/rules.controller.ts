import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, RULE_SET_KINDS, RULE_VERSION_TRANSITIONS, canTransition, type PageQuery, type RuleSetKind, type RuleVersionStatus } from '@maritime/contracts';
import { KIT_ENV, KIT_POOL, AuditClient, RequirePerm, zod, paged, parsePage, escapeLike, notFound, conflict, badRequest, withTx, enqueue, eventFromContext, getContext, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { compileDefinition, evaluateRuleSet, normaliseDefinition, type RuleDefinition, type RuleResult } from './engine';
import { evaluate, compile, ExprError, type Expr } from './expr';

export interface SetRow { id: string; key: string; name: string; name_ar: string | null; kind: RuleSetKind; description: string; description_ar: string | null; created_by: string | null; created_at: Date; updated_at: Date; latest_version?: number | null; published_version?: number | null; draft_version?: number | null }
export interface VerRow { id: string; rule_set_id: string; version: number; status: RuleVersionStatus; definition: RuleDefinition; parameters: Record<string, unknown>; change_note: string; created_by: string | null; published_by: string | null; published_at: Date | null; retired_at: Date | null; created_at: Date; updated_at: Date }
export const setToApi = (r: SetRow) => ({ id: r.id, key: r.key, name: r.name, nameAr: r.name_ar, kind: r.kind, description: r.description, descriptionAr: r.description_ar, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
  ...(r.latest_version !== undefined ? { latestVersion: r.latest_version == null ? null : Number(r.latest_version), publishedVersion: r.published_version == null ? null : Number(r.published_version), draftVersion: r.draft_version == null ? null : Number(r.draft_version) } : {}) });
export const verToApi = (v: VerRow, full = true) => ({ id: v.id, ruleSetId: v.rule_set_id, version: v.version, status: v.status, ...(full ? { definition: v.definition, parameters: v.parameters } : {}), changeNote: v.change_note, createdBy: v.created_by, publishedBy: v.published_by, publishedAt: v.published_at, retiredAt: v.retired_at, createdAt: v.created_at, updatedAt: v.updated_at });

const KEY = z.string().regex(/^[a-z0-9][a-z0-9._-]{1,79}$/, 'key must be lowercase letters, digits, dots, dashes');
const params = z.record(z.unknown());
const createSchema = z.object({ key: KEY, name: z.string().min(2).max(160), nameAr: z.string().max(160).optional().nullable(), kind: z.enum(RULE_SET_KINDS), description: z.string().max(2000).optional().default(''), descriptionAr: z.string().max(2000).optional().nullable(), definition: z.unknown().optional(), parameters: params.optional().default({}), changeNote: z.string().max(500).optional().default('Initial draft') });
const draftSchema = z.object({ definition: z.unknown().optional(), parameters: params.optional(), changeNote: z.string().max(500).optional() });
const testSchema = z.object({ context: z.record(z.unknown()).optional().default({}), parameters: params.optional(), now: z.string().datetime().optional() });
const evaluateSchema = z.object({ key: KEY, version: z.coerce.number().int().positive().optional(), context: z.record(z.unknown()).optional().default({}), now: z.string().datetime().optional() });
const SORT: Record<string, string> = { key: 's.key', name: 's.name', kind: 's.kind', createdAt: 's.created_at', updatedAt: 's.updated_at' };
const SKELETON: Record<RuleSetKind, RuleDefinition> = { FEE: { lines: [] }, ELIGIBILITY: { checks: [] }, VALIDATION: { checks: [] }, SLA: { days: 10 } };
const actor = () => getContext()?.actor ?? { id: 'system', name: 'system', kind: 'system' };
const SET_SQL = `SELECT s.*, (SELECT max(version) FROM rule_set_versions v WHERE v.rule_set_id = s.id) AS latest_version,
  (SELECT version FROM rule_set_versions v WHERE v.rule_set_id = s.id AND v.status = 'PUBLISHED' ORDER BY version DESC LIMIT 1) AS published_version,
  (SELECT version FROM rule_set_versions v WHERE v.rule_set_id = s.id AND v.status = 'DRAFT' ORDER BY version DESC LIMIT 1) AS draft_version FROM rule_sets s`;

/** Shared by the user-facing and the service-only controllers: load and evaluate a rule set by key. */
export class RuleEvaluator {
  constructor(private readonly pool: Pool, private readonly env: Env) {}
  exprOptions(now?: Date) { return { maxDepth: this.env.EXPR_MAX_DEPTH, timeoutMs: this.env.EXPR_TIMEOUT_MS, now }; }
  async loadSet(q: Queryable, key: string): Promise<SetRow> { const r = await q.query<SetRow>(`${SET_SQL} WHERE s.key = $1`, [key]); if (!r.rows[0]) throw notFound(`Rule set ${key} not found`); return r.rows[0]; }
  async loadVersion(q: Queryable, setId: string, version?: number): Promise<VerRow> {
    const r = version == null ? await q.query<VerRow>("SELECT * FROM rule_set_versions WHERE rule_set_id = $1 AND status = 'PUBLISHED' ORDER BY version DESC LIMIT 1", [setId]) : await q.query<VerRow>('SELECT * FROM rule_set_versions WHERE rule_set_id = $1 AND version = $2', [setId, version]);
    if (!r.rows[0]) throw notFound(version == null ? 'No published version of this rule set' : `Version ${version} not found`);
    return r.rows[0];
  }
  run(set: SetRow, ver: VerRow, context: Record<string, unknown>, parameters?: Record<string, unknown>, now?: string) {
    try {
      const result = evaluateRuleSet(set.kind, ver.definition, parameters ?? ver.parameters, context, this.exprOptions(now ? new Date(now) : undefined));
      return { key: set.key, name: set.name, nameAr: set.name_ar, version: ver.version, status: ver.status, ...result } as { key: string; name: string; nameAr: string | null; version: number; status: string } & RuleResult;
    } catch (e) { if (e instanceof ExprError || e instanceof Error) throw badRequest(`Rule set ${set.key} v${ver.version} failed: ${(e as Error).message}`); throw e; }
  }
  async evaluateByKey(key: string, version: number | undefined, context: Record<string, unknown>, now?: string) {
    const set = await this.loadSet(this.pool, key); const ver = await this.loadVersion(this.pool, set.id, version);
    return this.run(set, ver, context, undefined, now);
  }
  evaluateExpr(expr: Expr, context: Record<string, unknown>, tables?: Record<string, unknown>, now?: string) {
    try { return { value: evaluate(expr, { ...context, now: (now ? new Date(now) : new Date()).toISOString() }, { ...this.exprOptions(now ? new Date(now) : undefined), tables }) }; }
    catch (e) { if (e instanceof ExprError) throw badRequest(`Expression failed: ${e.message}`); throw e; }
  }
}

@Controller('rules')
export class RulesController {
  private readonly ev: RuleEvaluator;
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) { this.ev = new RuleEvaluator(pool, env); }
  private async hist(c: PoolClient, setId: string, version: number | null, action: string, note = '') { await c.query('INSERT INTO rule_set_history(rule_set_id, version, action, actor, note) VALUES ($1, $2, $3, $4, $5)', [setId, version, action, JSON.stringify(actor()), note]); }
  /** Every mutation publishes its domain event and the read-model snapshot of the rule set so reporting and the workflow cache stay current. */
  private async emit(c: PoolClient, type: string, set: SetRow, ver: VerRow | null, extra: Record<string, unknown> = {}) {
    await enqueue(c, eventFromContext(this.env.SERVICE_NAME, type, { ruleSetId: set.id, key: set.key, kind: set.kind, name: set.name, version: ver?.version ?? null, status: ver?.status ?? null, ...extra }, { subject: `RuleSet:${set.key}` }));
    await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.readModel.upserted, { kind: 'ruleSet', entity: { ...setToApi(set), version: ver?.version ?? null, versionStatus: ver?.status ?? null } }, { subject: `RuleSet:${set.key}` }));
  }
  /** Normalises and compiles a definition. A skeleton (no lines or checks yet) is accepted for drafts; publishing is strict. */
  private validated(kind: RuleSetKind, definition: unknown, parameters: Record<string, unknown>, strict: boolean): RuleDefinition {
    if (definition === undefined) return SKELETON[kind];
    const body = Array.isArray(definition) ? definition : definition && typeof definition === 'object' ? ((definition as Record<string, unknown>).lines ?? (definition as Record<string, unknown>).checks) : undefined;
    if (Array.isArray(body) && body.length === 0 && !strict && kind !== 'SLA') return SKELETON[kind];
    const def = normaliseDefinition(kind, definition);
    const problems = compileDefinition(kind, def, parameters);
    if (problems.length) throw badRequest(`Definition does not compile: ${problems.join('; ')}`, { problems });
    return def;
  }

  @RequirePerm('services.view') @Get()
  async list(@Query() query: PageQuery & { kind?: string; q?: string }) {
    const p = parsePage(query, { defaultSort: 'key', sortable: Object.keys(SORT) });
    const where: string[] = []; const args: unknown[] = [];
    if (query.kind) { args.push(String(query.kind).toUpperCase()); where.push(`s.kind = $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(s.key ILIKE $${args.length} OR s.name ILIKE $${args.length} OR coalesce(s.name_ar, '') ILIKE $${args.length} OR s.description ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM rule_sets s ${w}`, args);
    const rows = await this.pool.query<SetRow>(`${SET_SQL} ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir}, s.id LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(setToApi), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }
  @RequirePerm('services.manage') @Post()
  async create(@Body(zod(createSchema)) b: z.infer<typeof createSchema>) {
    const def = this.validated(b.kind, b.definition, b.parameters, false);
    return withTx(this.pool, async (c) => {
      const exists = await c.query('SELECT 1 FROM rule_sets WHERE key = $1', [b.key]); if (exists.rowCount) throw conflict(`Rule set ${b.key} already exists`);
      const s = await c.query<SetRow>('INSERT INTO rule_sets(key, name, name_ar, kind, description, description_ar, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *', [b.key, b.name, b.nameAr ?? null, b.kind, b.description, b.descriptionAr ?? null, actor().id]);
      const v = await c.query<VerRow>('INSERT INTO rule_set_versions(rule_set_id, version, status, definition, parameters, change_note, created_by) VALUES ($1, 1, \'DRAFT\', $2, $3, $4, $5) RETURNING *', [s.rows[0].id, JSON.stringify(def), JSON.stringify(b.parameters), b.changeNote, actor().id]);
      await this.hist(c, s.rows[0].id, 1, 'CREATE', b.changeNote);
      await this.audit.record(c, { action: 'CREATE', entity: 'RuleSet', entityId: s.rows[0].id, entityLabel: b.key, after: { ...setToApi(s.rows[0]), version: verToApi(v.rows[0]) } });
      await this.emit(c, EVENTS.rules.rulesetCreated, s.rows[0], v.rows[0]);
      return { ...setToApi({ ...s.rows[0], latest_version: 1, published_version: null, draft_version: 1 }), versions: [verToApi(v.rows[0])] };
    });
  }
  @RequirePerm('services.view') @Post('evaluate')
  async evaluate(@Body(zod(evaluateSchema)) b: z.infer<typeof evaluateSchema>) { return this.ev.evaluateByKey(b.key, b.version, b.context, b.now); }
  @RequirePerm('services.view') @Post('compile')
  async compileExpr(@Body(zod(z.object({ expr: z.unknown(), parameters: params.optional() }))) b: { expr: unknown; parameters?: Record<string, unknown> }) { return compile(b.expr, { maxDepth: this.env.EXPR_MAX_DEPTH, tables: b.parameters }); }

  @RequirePerm('services.view') @Get(':key')
  async get(@Param('key') key: string) {
    const set = await this.ev.loadSet(this.pool, key);
    const versions = await this.pool.query<VerRow>('SELECT * FROM rule_set_versions WHERE rule_set_id = $1 ORDER BY version', [set.id]);
    const published = versions.rows.find((v) => v.status === 'PUBLISHED') ?? null;
    return { ...setToApi(set), published: published ? verToApi(published) : null, versions: versions.rows.map((v) => verToApi(v, false)) };
  }
  @RequirePerm('services.view') @Get(':key/versions')
  async versions(@Param('key') key: string) { const set = await this.ev.loadSet(this.pool, key); const r = await this.pool.query<VerRow>('SELECT * FROM rule_set_versions WHERE rule_set_id = $1 ORDER BY version', [set.id]); return r.rows.map((v) => verToApi(v)); }
  @RequirePerm('services.view') @Get(':key/versions/:v')
  async version(@Param('key') key: string, @Param('v') v: string) { const set = await this.ev.loadSet(this.pool, key); return verToApi(await this.ev.loadVersion(this.pool, set.id, Number(v))); }
  @RequirePerm('services.view') @Get(':key/history')
  async history(@Param('key') key: string) {
    const set = await this.ev.loadSet(this.pool, key);
    const r = await this.pool.query<{ id: string; version: number | null; action: string; actor: Record<string, unknown>; note: string; at: Date }>('SELECT id, version, action, actor, note, at FROM rule_set_history WHERE rule_set_id = $1 ORDER BY id DESC LIMIT 500', [set.id]);
    return r.rows.map((h) => ({ id: Number(h.id), version: h.version, action: h.action, actor: h.actor, note: h.note, at: h.at }));
  }
  /** A new draft copied from the latest version; only one draft per rule set at a time. */
  @RequirePerm('services.manage') @Post(':key/versions')
  async draft(@Param('key') key: string, @Body(zod(draftSchema)) b: z.infer<typeof draftSchema>) {
    return withTx(this.pool, async (c) => {
      const set = await this.ev.loadSet(c, key);
      const latest = await c.query<VerRow>('SELECT * FROM rule_set_versions WHERE rule_set_id = $1 ORDER BY version DESC LIMIT 1 FOR UPDATE', [set.id]);
      const open = await c.query('SELECT version FROM rule_set_versions WHERE rule_set_id = $1 AND status = \'DRAFT\'', [set.id]); if (open.rowCount) throw conflict(`Version ${open.rows[0].version} is still a draft`);
      const base = latest.rows[0]; const parameters = b.parameters ?? base?.parameters ?? {};
      const def = b.definition !== undefined ? this.validated(set.kind, b.definition, parameters, false) : base?.definition ?? SKELETON[set.kind];
      const next = (base?.version ?? 0) + 1;
      const v = await c.query<VerRow>('INSERT INTO rule_set_versions(rule_set_id, version, status, definition, parameters, change_note, created_by) VALUES ($1, $2, \'DRAFT\', $3, $4, $5, $6) RETURNING *', [set.id, next, JSON.stringify(def), JSON.stringify(parameters), b.changeNote ?? `Draft from v${base?.version ?? 0}`, actor().id]);
      await this.hist(c, set.id, next, 'DRAFT', b.changeNote ?? '');
      await this.audit.record(c, { action: 'CREATE', entity: 'RuleSetVersion', entityId: v.rows[0].id, entityLabel: `${key} v${next}`, after: verToApi(v.rows[0]) });
      await this.emit(c, EVENTS.rules.versionDrafted, set, v.rows[0]);
      return verToApi(v.rows[0]);
    });
  }
  @RequirePerm('services.manage') @Put(':key/versions/:v')
  async edit(@Param('key') key: string, @Param('v') vs: string, @Body(zod(draftSchema)) b: z.infer<typeof draftSchema>) {
    return withTx(this.pool, async (c) => {
      const set = await this.ev.loadSet(c, key); const ver = await this.ev.loadVersion(c, set.id, Number(vs));
      if (ver.status !== 'DRAFT') throw conflict(`Version ${ver.version} is ${ver.status.toLowerCase()}; only a draft can be edited`);
      const parameters = b.parameters ?? ver.parameters;
      const def = b.definition !== undefined ? this.validated(set.kind, b.definition, parameters, false) : ver.definition;
      if (b.definition === undefined && b.parameters !== undefined) { const problems = compileDefinition(set.kind, def, parameters); if (problems.length) throw badRequest(`Definition does not compile with these parameters: ${problems.join('; ')}`, { problems }); }
      const r = await c.query<VerRow>('UPDATE rule_set_versions SET definition = $1, parameters = $2, change_note = $3, updated_at = now() WHERE id = $4 RETURNING *', [JSON.stringify(def), JSON.stringify(parameters), b.changeNote ?? ver.change_note, ver.id]);
      await this.hist(c, set.id, ver.version, 'EDIT', b.changeNote ?? '');
      await this.audit.record(c, { action: 'UPDATE', entity: 'RuleSetVersion', entityId: ver.id, entityLabel: `${key} v${ver.version}`, before: verToApi(ver), after: verToApi(r.rows[0]) });
      await this.emit(c, EVENTS.rules.versionUpdated, set, r.rows[0]);
      return verToApi(r.rows[0]);
    });
  }
  /** Publishing retires the previously published version so exactly one version is live. */
  @RequirePerm('services.manage') @Post(':key/versions/:v/publish')
  async publish(@Param('key') key: string, @Param('v') vs: string, @Body(zod(z.object({ note: z.string().max(500).optional() }))) b: { note?: string }) {
    return withTx(this.pool, async (c) => {
      const set = await this.ev.loadSet(c, key); const ver = await this.ev.loadVersion(c, set.id, Number(vs));
      if (!canTransition(RULE_VERSION_TRANSITIONS, ver.status, 'PUBLISHED')) throw conflict(`Version ${ver.version} is ${ver.status.toLowerCase()} and cannot be published`);
      this.validated(set.kind, ver.definition, ver.parameters, true);
      const retired = await c.query<VerRow>("UPDATE rule_set_versions SET status = 'RETIRED', retired_at = now(), updated_at = now() WHERE rule_set_id = $1 AND status = 'PUBLISHED' RETURNING *", [set.id]);
      const r = await c.query<VerRow>("UPDATE rule_set_versions SET status = 'PUBLISHED', published_at = now(), published_by = $2, updated_at = now() WHERE id = $1 RETURNING *", [ver.id, actor().id]);
      await c.query('UPDATE rule_sets SET updated_at = now() WHERE id = $1', [set.id]);
      await this.hist(c, set.id, ver.version, 'PUBLISH', b.note ?? '');
      for (const old of retired.rows) { await this.hist(c, set.id, old.version, 'RETIRE', `Superseded by v${ver.version}`); await this.emit(c, EVENTS.rules.retired, set, old); }
      await this.audit.record(c, { action: 'PUBLISH', entity: 'RuleSetVersion', entityId: ver.id, entityLabel: `${key} v${ver.version}`, before: { status: ver.status }, after: { status: 'PUBLISHED', retired: retired.rows.map((x) => x.version) }, note: b.note });
      await this.emit(c, EVENTS.rules.published, set, r.rows[0], { definition: r.rows[0].definition, parameters: r.rows[0].parameters, publishedAt: r.rows[0].published_at, retired: retired.rows.map((x) => x.version) });
      return { ...verToApi(r.rows[0]), retired: retired.rows.map((x) => x.version) };
    });
  }
  @RequirePerm('services.manage') @Post(':key/versions/:v/retire')
  async retire(@Param('key') key: string, @Param('v') vs: string, @Body(zod(z.object({ note: z.string().max(500).optional() }))) b: { note?: string }) {
    return withTx(this.pool, async (c) => {
      const set = await this.ev.loadSet(c, key); const ver = await this.ev.loadVersion(c, set.id, Number(vs));
      if (!canTransition(RULE_VERSION_TRANSITIONS, ver.status, 'RETIRED')) throw conflict(`Version ${ver.version} is already retired`);
      const r = await c.query<VerRow>("UPDATE rule_set_versions SET status = 'RETIRED', retired_at = now(), updated_at = now() WHERE id = $1 RETURNING *", [ver.id]);
      await this.hist(c, set.id, ver.version, 'RETIRE', b.note ?? '');
      await this.audit.record(c, { action: 'RETIRE', entity: 'RuleSetVersion', entityId: ver.id, entityLabel: `${key} v${ver.version}`, before: { status: ver.status }, after: { status: 'RETIRED' }, note: b.note });
      await this.emit(c, EVENTS.rules.retired, set, r.rows[0]);
      return verToApi(r.rows[0]);
    });
  }
  /** Dry run of any version against a sample context — no side effects, diagnostics included. */
  @RequirePerm('services.view') @Post(':key/versions/:v/test')
  async test(@Param('key') key: string, @Param('v') vs: string, @Body(zod(testSchema)) b: z.infer<typeof testSchema>) {
    const set = await this.ev.loadSet(this.pool, key); const ver = await this.ev.loadVersion(this.pool, set.id, Number(vs));
    const parameters = b.parameters ?? ver.parameters;
    const problems = compileDefinition(set.kind, ver.definition, parameters);
    if (problems.length) return { key, version: ver.version, kind: set.kind, ok: false, problems, result: null };
    const started = process.hrtime.bigint();
    const result = this.ev.run(set, ver, b.context, parameters, b.now);
    return { key, version: ver.version, kind: set.kind, ok: true, problems: [], durationMs: Number(process.hrtime.bigint() - started) / 1e6, result };
  }
}
