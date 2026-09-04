import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, REQUEST_OPEN_STATUS, hasPerm, type PageQuery } from '@maritime/contracts';
import { scopeOfRecord, scopeWhere, visibleTo, KIT_ENV, KIT_POOL, AuditClient, CurrentUser, RequirePerm, zod, paged, parsePage, escapeLike, notFound, badRequest, conflict, withTx, enqueue, eventFromContext, nextNumber, type Principal } from '@maritime/service-kit';
import type { Env } from './env';
import type { DefinitionContent, FormField } from './schema';
import { WORKFLOW_ENGINE, WorkflowEngine, type EngineActor, type RequestDocument, type RequestState, type TransitionResult } from './engine';
import { contentOf, loadDefinition, loadPublished, loadRequest, loadVersion, noteToApi, requestToApi, saveRequest, type NoteRow, type RequestRow, type VersionRow } from './repo';
import { REQUEST_SCOPE } from './scope';

const createSchema = z.object({
  definitionKey: z.string().max(120).optional(), definitionId: z.string().max(80).optional(),
  subjectId: z.string().max(80).optional().nullable(), subjectName: z.string().max(200).optional().nullable(), subject: z.record(z.unknown()).default({}),
  formData: z.record(z.unknown()).default({}), documents: z.array(z.object({ code: z.string().max(60), documentId: z.string().max(80).optional().nullable(), name: z.string().max(200).default('') })).default([]),
  applicant: z.object({ name: z.string().max(160).optional(), email: z.string().max(200).optional(), phone: z.string().max(40).optional(), organisation: z.string().max(200).optional(), organisationCode: z.string().max(40).optional() }).default({}),
  draft: z.boolean().default(false), note: z.string().max(1000).default(''),
}).refine((b) => !!(b.definitionKey || b.definitionId), { message: 'definitionKey is required' });
const transitionSchema = z.object({ action: z.string().regex(/^[a-z][a-z0-9_]*$/), note: z.string().max(2000).default(''), payload: z.record(z.unknown()).default({}) });
const issueSchema = z.object({ note: z.string().max(2000).default('') });
const documentSchema = z.object({ code: z.string().max(60), documentId: z.string().max(80).optional().nullable(), name: z.string().max(200).default(''), notes: z.string().max(500).default('') });
const verifySchema = z.object({ verified: z.boolean().default(true), notes: z.string().max(500).optional() });
const assignSchema = z.object({ userId: z.string().max(80).nullable(), name: z.string().max(160).default('') });
const noteSchema = z.object({ body: z.string().min(1).max(4000), internal: z.boolean().optional() });
const paymentSchema = z.object({ reference: z.string().max(80).default(''), paidAt: z.string().datetime().optional() });
const SORT: Record<string, string> = { createdAt: 'created_at', updatedAt: 'updated_at', submittedAt: 'submitted_at', slaDueAt: 'sla_due_at', number: 'number', status: 'status', definitionName: 'definition_name', subjectName: 'subject_name', category: 'category' };
const isStaff = (u: Principal) => hasPerm(u.perms, 'services.assess') || hasPerm(u.perms, 'services.approve') || hasPerm(u.perms, 'services.manage');
const actorOf = (u: Principal): EngineActor => ({ id: u.id, name: u.name, email: u.email, perms: u.perms, kind: u.kind });
const OPTION_VALUE = (o: string | { value: string }) => (typeof o === 'string' ? o : o.value);

/** Validates submitted form data against the version's form: required fields (respecting visibility), types, options and declared constraints. */
export async function validateFormData(content: DefinitionContent, data: Record<string, unknown>, visible: (f: FormField) => Promise<boolean>): Promise<string[]> {
  const problems: string[] = [];
  for (const f of content.form.fields) {
    const v = data[f.key]; const present = v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
    if (!(await visible(f))) continue;
    if (f.required && !present) { problems.push(`${f.label} is required`); continue; }
    if (!present) continue;
    const c = f.validation;
    if (f.type === 'number') { if (typeof v !== 'number' || !Number.isFinite(v)) problems.push(`${f.label} must be a number`); else { if (c.min !== undefined && v < c.min) problems.push(`${f.label} must be at least ${c.min}`); if (c.max !== undefined && v > c.max) problems.push(`${f.label} must be at most ${c.max}`); } }
    else if (f.type === 'date') { if (typeof v !== 'string' || Number.isNaN(Date.parse(v))) problems.push(`${f.label} must be a date`); }
    else if (f.type === 'boolean') { if (typeof v !== 'boolean') problems.push(`${f.label} must be true or false`); }
    else if (f.type === 'select') { if (f.options.length && !f.options.some((o) => OPTION_VALUE(o) === String(v))) problems.push(`${f.label}: "${String(v)}" is not one of the options`); }
    else if (f.type === 'multiselect') { if (!Array.isArray(v)) problems.push(`${f.label} must be a list`); else for (const x of v) if (f.options.length && !f.options.some((o) => OPTION_VALUE(o) === String(x))) problems.push(`${f.label}: "${String(x)}" is not one of the options`); }
    else if (typeof v === 'string') { if (c.minLength !== undefined && v.length < c.minLength) problems.push(`${f.label} must be at least ${c.minLength} characters`); if (c.maxLength !== undefined && v.length > c.maxLength) problems.push(`${f.label} must be at most ${c.maxLength} characters`); if (c.pattern && !new RegExp(c.pattern).test(v)) problems.push(`${f.label} has an invalid format`); }
  }
  return problems;
}

/** The request register: applications lodged against published definitions and driven by the workflow engine. Applicants see and act on their own requests only. */
@Controller('services/requests')
export class RequestsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, @Inject(WORKFLOW_ENGINE) private readonly engine: WorkflowEngine, private readonly audit: AuditClient) {}
  /* Whose applications a reader may see, in one place.
   *
   * A company-scoped reader sees their company's — their colleagues' included, which is the point: an
   * agency with two desks is one applicant, and each of them seeing only what they personally keyed in was
   * the gap this closes. Anyone else who is not staff still sees only what they lodged themselves, because
   * with no company behind them there is nothing else to narrow by. Staff, scoped nationally, see all of
   * it. In every case the answer for an application outside the set is "not found" rather than a refusal
   * that would confirm it exists.
   */
  private async own(q: Pool | PoolClient, id: string, user: Principal, lock = false): Promise<RequestRow> {
    const row = await loadRequest(q, id, lock);
    if (!visibleTo(user.scope, { company: row.scope_company }, REQUEST_SCOPE)) throw notFound('Request not found');
    if (!isStaff(user) && !this.partitioned(user) && row.applicant?.userId !== user.id) throw notFound('Request not found');
    return row;
  }
  /** Whether this reader's own scope narrows the register for them. */
  private partitioned(user: Principal): boolean {
    const where: string[] = []; return scopeWhere(user.scope, where, [], REQUEST_SCOPE);
  }
  private version(q: Pool | PoolClient, row: RequestRow): Promise<VersionRow> { return loadVersion(q, row.definition_id, row.definition_version, row.environment as VersionRow['environment']); }
  private async persist(c: PoolClient, before: RequestRow, r: TransitionResult, note: string): Promise<RequestRow> {
    const saved = await saveRequest(c, r.request);
    for (const e of r.events) await enqueue(c, e);
    await this.audit.record(c, { action: 'TRANSITION', entity: 'ServiceRequest', entityId: saved.id, entityLabel: `${saved.number}: ${r.entry.from} → ${r.entry.to}`, before: { status: before.status, state: before.current_state, assignee: before.assignee }, after: { status: saved.status, state: saved.current_state, assignee: saved.assignee, fees: saved.fees, effects: r.effects }, note });
    return saved;
  }
  private async touch(c: PoolClient, row: RequestRow, type: string, data: Record<string, unknown>) {
    const subject = `ServiceRequest:${row.number}`;
    await enqueue(c, eventFromContext(this.env.SERVICE_NAME, type, { requestId: row.id, requestNo: row.number, definitionKey: row.definition_key, ...data }, { subject }));
    await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.readModel.upserted, { kind: 'serviceRequest', entity: requestToApi(row) }, { subject }));
  }
  private async withActions(row: RequestRow, user: Principal) {
    const ver = await this.version(this.pool, row); const content = contentOf(ver); const state = requestToApi(row);
    const stateDef = content.workflow.states.find((s) => s.key === row.current_state);
    return { ...state, availableActions: this.engine.availableActions(content, state, actorOf(user)), stateLabel: stateDef?.label ?? row.current_state, stateLabelAr: stateDef?.labelAr ?? null,
      definition: { key: row.definition_key, name: row.definition_name, nameAr: row.definition_name_ar, version: ver.version, form: content.form, documents: content.documents, sla: content.sla, outputs: content.outputs, states: content.workflow.states.map((s) => ({ key: s.key, label: s.label, labelAr: s.labelAr ?? null, kind: s.kind })) } };
  }

  @RequirePerm('services.view') @Get()
  async list(@Query() query: PageQuery & Record<string, string | undefined>, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: '-createdAt', sortable: Object.keys(SORT) });
    const where: string[] = []; const args: unknown[] = [];
    const staff = isStaff(user);
    /* The company partition first: it is the reader's standing. The personal filter then applies to anyone
     * who asked for it, and to a non-staff reader with no company behind them — for whom it is the only
     * thing there is to narrow by. */
    const partitioned = scopeWhere(user.scope, where, args, REQUEST_SCOPE);
    if (query.mine === 'true' || (!staff && !partitioned)) { args.push(user.id); where.push(`applicant->>'userId' = $${args.length}`); }
    if (query.status) { args.push(String(query.status).toUpperCase().split(',')); where.push(`status = ANY($${args.length}::text[])`); }
    if (query.definition) { args.push(query.definition); where.push(`(definition_key = $${args.length} OR definition_id::text = $${args.length})`); }
    if (query.category) { args.push(query.category); where.push(`category = $${args.length}`); }
    if (query.subjectKind) { args.push(String(query.subjectKind).toUpperCase()); where.push(`subject_kind = $${args.length}`); }
    if (query.subjectId) { args.push(query.subjectId); where.push(`subject_id = $${args.length}`); }
    if (query.assignee) { args.push(query.assignee === 'me' ? user.id : query.assignee); where.push(`assignee->>'userId' = $${args.length}`); }
    if (query.open === 'true') { args.push([...REQUEST_OPEN_STATUS]); where.push(`status = ANY($${args.length}::text[])`); }
    if (query.breached === 'true') where.push('closed_at IS NULL AND sla_due_at IS NOT NULL AND sla_due_at < now()');
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(number ILIKE $${args.length} OR applicant->>'name' ILIKE $${args.length} OR subject_name ILIKE $${args.length} OR definition_name ILIKE $${args.length} OR coalesce(definition_name_ar, '') ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM service_requests ${w}`, args);
    const rows = await this.pool.query<RequestRow>(`SELECT * FROM service_requests ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, id LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map((r) => { const s = requestToApi(r); return { ...s, timeline: undefined, documents: undefined, formData: undefined, checks: undefined, documentCount: r.documents?.length ?? 0 }; }), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }
  /** Lodge an application: validated against the published definition, numbered, created as a draft and — unless `draft` — submitted at once. */
  @RequirePerm('services.apply', 'services.assess', 'services.manage') @Post()
  async create(@Body(zod(createSchema)) b: z.infer<typeof createSchema>, @CurrentUser() user: Principal) {
    const def = await loadDefinition(this.pool, (b.definitionKey ?? b.definitionId)!);
    const ver = await loadPublished(this.pool, def.id, this.env.RUNTIME_ENVIRONMENT);
    if (def.status !== 'PUBLISHED' || !ver) throw notFound(`No published service for ${def.key} in ${this.env.RUNTIME_ENVIRONMENT}`);
    const content = contentOf(ver);
    if (def.subject_kind !== 'NONE' && !b.subjectId) throw badRequest(`This service must be lodged against a ${def.subject_kind.replace(/_/g, ' ').toLowerCase()}`);
    const visCtx = { form: b.formData, subject: { kind: def.subject_kind, id: b.subjectId ?? null, name: b.subjectName ?? '', ...b.subject }, applicant: b.applicant };
    const problems = await validateFormData(content, b.formData, async (f) => f.visibleWhen === undefined || !!(await this.engine.evaluateExpr(f.visibleWhen, visCtx)));
    if (problems.length) throw badRequest(`Required information missing: ${problems.join('; ')}`, { problems });
    const unknown = b.documents.filter((d) => !content.documents.some((x) => x.code === d.code)).map((d) => d.code);
    if (unknown.length) throw badRequest(`Unknown document codes: ${unknown.join(', ')}`);
    return withTx(this.pool, async (c) => {
      const now = this.engine.now(); const year = now.getUTCFullYear();
      const number = await nextNumber(c, `sr:${year}`, `SR-${year}-`, 5);
      const start = this.engine.startState(content);
      /* The author's own scope decides who the application belongs to, not what the body claims: a
       * company-scoped applicant cannot lodge one into another company's register by naming it. */
      const organisationCode = scopeOfRecord(user.scope).company ?? b.applicant.organisationCode ?? '';
      const applicant = { userId: user.id, name: b.applicant.name ?? user.name, email: b.applicant.email ?? user.email ?? '', phone: b.applicant.phone ?? '', organisation: b.applicant.organisation ?? '', organisationCode };
      const documents: RequestDocument[] = b.documents.map((d) => ({ code: d.code, documentId: d.documentId ?? null, name: d.name || `${d.code}.pdf`, uploadedAt: now.toISOString(), verified: false, verifiedBy: null, verifiedAt: null, notes: '' }));
      const timeline = [{ from: '', to: start.key, action: 'create', at: now.toISOString(), by: { id: user.id, name: user.name }, note: b.note || 'Application started' }];
      const ins = await c.query<RequestRow>(
        `INSERT INTO service_requests(number, definition_id, definition_key, definition_name, definition_name_ar, definition_version, environment, category, domain, subject_kind, subject_id, subject_name, subject, applicant, status, current_state, form_data, documents, timeline, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'DRAFT',$15,$16,$17,$18,$19) RETURNING *`,
        [number, def.id, def.key, def.name, def.name_ar, ver.version, ver.environment, def.category, def.domain, def.subject_kind, b.subjectId ?? null, b.subjectName ?? '', JSON.stringify(b.subject), JSON.stringify(applicant), start.key, JSON.stringify(b.formData), JSON.stringify(documents), JSON.stringify(timeline), user.id]);
      let row = ins.rows[0];
      await this.audit.record(c, { action: 'CREATE', entity: 'ServiceRequest', entityId: row.id, entityLabel: `${row.number} — ${def.name}`, after: { number: row.number, definitionKey: def.key, subjectId: row.subject_id, applicant } });
      await this.touch(c, row, EVENTS.workflow.requestCreated, { definitionName: def.name, subjectKind: def.subject_kind, subjectId: row.subject_id, applicant });
      if (!b.draft) {
        const submit = content.workflow.transitions.find((t) => t.from === start.key && t.action === 'submit') ?? content.workflow.transitions.find((t) => t.from === start.key);
        if (!submit) throw conflict('The workflow has no transition out of its START state');
        const r = await this.engine.transition(requestToApi(row), content, submit.action, actorOf(user), b.note);
        row = await this.persist(c, row, r, b.note);
      }
      const state = requestToApi(row);
      return { ...state, availableActions: this.engine.availableActions(content, state, actorOf(user)) };
    });
  }
  @RequirePerm('services.view') @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: Principal) { return this.withActions(await this.own(this.pool, id, user), user); }
  @RequirePerm('services.view') @Get(':id/timeline')
  async timeline(@Param('id') id: string, @CurrentUser() user: Principal) {
    const row = await this.own(this.pool, id, user);
    const notes = await this.pool.query<NoteRow>(`SELECT * FROM request_notes WHERE request_id = $1 ${isStaff(user) ? '' : 'AND internal = false'} ORDER BY created_at`, [row.id]);
    return { number: row.number, status: row.status, currentState: row.current_state, slaDueAt: row.sla_due_at, slaBreached: requestToApi(row).slaBreached, timeline: row.timeline, notes: notes.rows.map(noteToApi) };
  }
  @RequirePerm('services.view') @Get(':id/notes')
  async notes(@Param('id') id: string, @CurrentUser() user: Principal) { const row = await this.own(this.pool, id, user); const r = await this.pool.query<NoteRow>(`SELECT * FROM request_notes WHERE request_id = $1 ${isStaff(user) ? '' : 'AND internal = false'} ORDER BY created_at`, [row.id]); return r.rows.map(noteToApi); }
  /** Any workflow action; the engine decides whether the caller may take it from the current state. */
  @RequirePerm('services.view') @Post(':id/transition')
  async transition(@Param('id') id: string, @Body(zod(transitionSchema)) b: z.infer<typeof transitionSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const row = await this.own(c, id, user, true); const content = contentOf(await this.version(c, row));
      const r = await this.engine.transition(requestToApi(row), content, b.action, actorOf(user), b.note, b.payload);
      const saved = await this.persist(c, row, r, b.note);
      const state = requestToApi(saved);
      return { ...state, availableActions: this.engine.availableActions(content, state, actorOf(user)), effects: r.effects, entry: r.entry };
    });
  }
  /** Issue the instrument of an approved request: the workflow's `issue` action, which hands the request to the instruments service. */
  @RequirePerm('services.approve', 'services.manage') @Post(':id/issue')
  async issue(@Param('id') id: string, @Body(zod(issueSchema)) b: z.infer<typeof issueSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const row = await this.own(c, id, user, true); const content = contentOf(await this.version(c, row));
      if (!content.outputs.instrumentType) throw badRequest('This service does not issue an instrument');
      const r = await this.engine.transition(requestToApi(row), content, 'issue', actorOf(user), b.note);
      const saved = await this.persist(c, row, r, b.note);
      return { ...requestToApi(saved), instrument: saved.issued_instrument, effects: r.effects };
    });
  }
  @RequirePerm('services.view') @Post(':id/documents')
  async addDocument(@Param('id') id: string, @Body(zod(documentSchema)) b: z.infer<typeof documentSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const row = await this.own(c, id, user, true); const content = contentOf(await this.version(c, row));
      if (row.closed_at) throw conflict('The request is closed');
      const def = content.documents.find((d) => d.code === b.code); if (!def) throw badRequest(`Unknown document code ${b.code}`);
      const now = new Date().toISOString();
      const doc: RequestDocument = { code: b.code, documentId: b.documentId ?? null, name: b.name || `${b.code}.pdf`, uploadedAt: now, verified: false, verifiedBy: null, verifiedAt: null, notes: b.notes };
      const documents = [...row.documents.filter((d) => d.code !== b.code), doc];
      const r = await c.query<RequestRow>('UPDATE service_requests SET documents = $2, updated_at = now() WHERE id = $1 RETURNING *', [row.id, JSON.stringify(documents)]);
      await this.audit.record(c, { action: 'DOC_ADD', entity: 'ServiceRequest', entityId: row.id, entityLabel: `${row.number} — ${def.label}`, after: doc });
      await this.touch(c, r.rows[0], EVENTS.workflow.requestDocument, { code: b.code, label: def.label, change: 'ATTACHED', documentId: doc.documentId });
      return { ...requestToApi(r.rows[0]), document: doc };
    });
  }
  @RequirePerm('services.assess', 'services.manage') @Put(':id/documents/:code')
  async verifyDocument(@Param('id') id: string, @Param('code') code: string, @Body(zod(verifySchema)) b: z.infer<typeof verifySchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const row = await this.own(c, id, user, true);
      const doc = row.documents.find((d) => d.code === code); if (!doc) throw notFound('Document not found on this request');
      const now = new Date().toISOString();
      const next: RequestDocument = { ...doc, verified: b.verified, verifiedBy: b.verified ? user.name : null, verifiedAt: b.verified ? now : null, notes: b.notes ?? doc.notes };
      const r = await c.query<RequestRow>('UPDATE service_requests SET documents = $2, updated_at = now() WHERE id = $1 RETURNING *', [row.id, JSON.stringify(row.documents.map((d) => (d.code === code ? next : d)))]);
      await this.audit.record(c, { action: 'DOC_VERIFY', entity: 'ServiceRequest', entityId: row.id, entityLabel: `${row.number} — ${code}`, before: doc, after: next });
      await this.touch(c, r.rows[0], EVENTS.workflow.requestDocument, { code, change: b.verified ? 'VERIFIED' : 'UNVERIFIED', verifiedBy: user.name });
      return { ...requestToApi(r.rows[0]), document: next };
    });
  }
  @RequirePerm('services.assess', 'services.manage') @Post(':id/assign')
  async assign(@Param('id') id: string, @Body(zod(assignSchema)) b: z.infer<typeof assignSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const row = await this.own(c, id, user, true);
      if (row.closed_at) throw conflict('The request is closed');
      const assignee = b.userId ? { userId: b.userId === 'me' ? user.id : b.userId, name: b.name || (b.userId === 'me' ? user.name : b.userId) } : null;
      const timeline = [...row.timeline, { from: row.current_state, to: row.current_state, action: 'assign', at: new Date().toISOString(), by: { id: user.id, name: user.name }, note: assignee ? `Assigned to ${assignee.name}` : 'Unassigned' }];
      const r = await c.query<RequestRow>('UPDATE service_requests SET assignee = $2, timeline = $3, updated_at = now() WHERE id = $1 RETURNING *', [row.id, assignee ? JSON.stringify(assignee) : null, JSON.stringify(timeline)]);
      await this.audit.record(c, { action: 'ASSIGN', entity: 'ServiceRequest', entityId: row.id, entityLabel: row.number, before: row.assignee, after: assignee });
      await this.touch(c, r.rows[0], EVENTS.workflow.requestAssigned, { assignee, by: { id: user.id, name: user.name } });
      return requestToApi(r.rows[0]);
    });
  }
  @RequirePerm('services.view') @Post(':id/notes')
  async addNote(@Param('id') id: string, @Body(zod(noteSchema)) b: z.infer<typeof noteSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const row = await this.own(c, id, user);
      const internal = isStaff(user) ? b.internal ?? true : false;
      const n = await c.query<NoteRow>('INSERT INTO request_notes(request_id, author, body, internal) VALUES ($1, $2, $3, $4) RETURNING *', [row.id, JSON.stringify({ id: user.id, name: user.name }), b.body, internal]);
      await this.audit.record(c, { action: 'NOTE', entity: 'ServiceRequest', entityId: row.id, entityLabel: row.number, after: { internal, length: b.body.length } });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.workflow.requestNoted, { requestId: row.id, requestNo: row.number, noteId: n.rows[0].id, internal, author: { id: user.id, name: user.name } }, { subject: `ServiceRequest:${row.number}` }));
      return noteToApi(n.rows[0]);
    });
  }
  /** Records the fee as paid (collections happen in revenue; this keeps the application's own payment fact current). */
  @RequirePerm('invoices.pay', 'services.assess', 'services.manage') @Post(':id/payment')
  async payment(@Param('id') id: string, @Body(zod(paymentSchema)) b: z.infer<typeof paymentSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const row = await this.own(c, id, user, true); const state: RequestState = requestToApi(row);
      if (!state.fees || state.fees.total <= 0) throw conflict('No fee is due on this request');
      const payment = { status: 'PAID' as const, amount: state.fees.total, currency: state.fees.currency, paidAt: b.paidAt ?? new Date().toISOString(), reference: b.reference };
      const r = await c.query<RequestRow>('UPDATE service_requests SET payment = $2, updated_at = now() WHERE id = $1 RETURNING *', [row.id, JSON.stringify(payment)]);
      await this.audit.record(c, { action: 'PAYMENT', entity: 'ServiceRequest', entityId: row.id, entityLabel: row.number, before: state.payment, after: payment });
      await this.touch(c, r.rows[0], EVENTS.workflow.requestTransitioned, { from: row.current_state, to: row.current_state, action: 'payment', status: row.status, actor: { id: user.id, name: user.name }, payment });
      return requestToApi(r.rows[0]);
    });
  }
}
