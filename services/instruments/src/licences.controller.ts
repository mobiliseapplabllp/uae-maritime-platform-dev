import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, ENDORSEMENT_KINDS, ENDORSEMENT_RESULTS, INSTRUMENT_CLASSES, LICENSE_STATUS, LICENSE_TRANSITIONS, LICENSE_TYPES, LICENSE_TYPES_BY_SUBJECT, SUBJECT_KINDS, hasPerm, instrumentClassOf, typeAllowedFor, type LicenseStatus, type PageQuery, type SubjectKind } from '@maritime/contracts';
import { scopeOfRecord, scopeWhere, KIT_ENV, KIT_POOL, AuditClient, CurrentUser, RequirePerm, zod, paged, parsePage, escapeLike, notFound, badRequest, conflict, forbidden, withTx, enqueue, eventFromContext, type Principal } from '@maritime/service-kit';
import { LICENCE_SCOPE } from './scope';
import { STATUTORY_TYPES, INSTRUMENT_TYPE_LABEL, type WorldEndorsement } from '@maritime/world';
import type { Env } from './env';
import { SigningService } from './signing';
import { endorsementSchedule, endorsementState, isStatutory, termMonthsOf, CERT_LABEL, CONVENTION, SURVEY_REGIME, classLabel } from './statutory';
import { checksFor, resolveSubject, labelFor, MODEL_BY_KIND } from './subjects';
import { toApi, detail, issue, findLicence, lockLicence, insertLicence, updateLicence, publishState, nextLicenceNumber, permBaseFor, issuerFor, type Row, type Patch, type LicenceAudit } from './licences';

/* Permissions follow the subject: a vessel instrument is the registry's business, a seafarer certificate the crew desk's, everything else the port-companies desk's. The facilities and certificates groups reach every register, as in the reference. */
const VIEW_ANY = ['facilities.view', 'certificates.view', 'vessels.view', 'seafarers.view'];
const MANAGE_ANY = ['facilities.manage', 'certificates.manage', 'vessels.edit', 'seafarers.edit'];
const APPROVE_ANY = ['facilities.approve', 'certificates.manage', 'vessels.edit', 'seafarers.edit'];
const viewPerms = (kind: string) => [`${permBaseFor(kind)}.view`, 'facilities.view', 'certificates.view'];
const managePerms = (kind: string) => [`${permBaseFor(kind)}.manage`, `${permBaseFor(kind)}.edit`, 'facilities.manage', 'certificates.manage'];
const approvePerms = (kind: string, type: string) => ['facilities.approve', ...(kind === 'VESSEL' || kind === 'SEAFARER' ? [`${permBaseFor(kind)}.edit`] : []), ...(isStatutory(type) ? ['certificates.manage'] : [])];
const assertAny = (user: Principal, perms: string[], what: string) => { if (!perms.some((p) => hasPerm(user.perms, p))) throw forbidden(`You don't have permission to ${what}`); };
const allowedKinds = (user: Principal): SubjectKind[] => SUBJECT_KINDS.filter((k) => viewPerms(k).some((p) => hasPerm(user.perms, p)));

const subjectKind = z.enum(SUBJECT_KINDS); const status = z.enum(LICENSE_STATUS);
const text = (max: number) => z.string().trim().max(max);
const createSchema = z.object({
  subjectKind: subjectKind.default('COMPANY'), subjectRef: z.string().trim().max(80).optional().nullable(), subjectId: z.string().trim().max(80).optional().nullable(),
  holderCode: z.string().trim().max(40).optional(),
  entityType: z.string().trim().min(1).max(60), entityName: text(200).optional(), contactPerson: text(120).optional(), phone: text(40).optional(), email: z.string().trim().max(160).optional(), address: text(400).optional(), taxId: text(40).optional(), conditions: text(2000).optional(), performanceRating: z.number().min(0).max(5).optional(),
});
const updateSchema = z.object({ entityName: text(200).optional(), entityType: z.string().trim().min(1).max(60).optional(), contactPerson: text(120).optional(), phone: text(40).optional(), email: z.string().trim().max(160).optional(), address: text(400).optional(), taxId: text(40).optional(), conditions: text(2000).optional(), expiryDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional().nullable(), performanceRating: z.number().min(0).max(5).optional() });
const transitionSchema = z.object({ to: status, note: text(2000).optional(), expiryDate: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional().nullable(), override: z.boolean().optional() });
const auditSchema = z.object({ date: z.string().datetime({ offset: true }).or(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).optional(), auditor: text(120).optional(), auditorId: text(80).optional().nullable(), result: z.enum(['SATISFACTORY', 'OBSERVATIONS', 'NON_CONFORMITY']), remarks: text(2000).optional() });
const endorseSchema = z.object({ kind: z.enum(ENDORSEMENT_KINDS), anniversary: z.string().optional().nullable(), completedOn: z.string().optional().nullable(), surveyor: text(120).optional(), organisation: text(120).optional(), place: text(120).optional(), result: z.enum(ENDORSEMENT_RESULTS).default('ENDORSED'), remarks: text(2000).optional() });
const SORT: Record<string, string> = { createdAt: 'created_at', licenseNo: 'license_no', entityName: 'entity_name', entityType: 'entity_type', status: 'status', expiryDate: 'expiry_date', issueDate: 'issue_date', appliedDate: 'applied_date', performanceRating: 'performance_rating', subjectKind: 'subject_kind', instrumentClass: 'instrument_class' };
const RATING_DELTA: Record<string, number> = { SATISFACTORY: 0.1, OBSERVATIONS: 0, NON_CONFORMITY: -0.5 };
type ListQuery = PageQuery & { entityType?: string; status?: string; subjectKind?: string; instrumentClass?: string; subjectRef?: string; subjectId?: string; statutory?: string; expiringDays?: string; inForce?: string };

@Controller()
export class LicencesController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient, private readonly signing: SigningService) {}

  /** Reference data the studio and the screens need to build an application form or a filter bar. */
  @RequirePerm(...VIEW_ANY) @Get('licenses/meta')
  meta() {
    return { subjectKinds: SUBJECT_KINDS, classes: INSTRUMENT_CLASSES, licenseTypes: LICENSE_TYPES, typesBySubject: LICENSE_TYPES_BY_SUBJECT, statuses: LICENSE_STATUS, transitions: LICENSE_TRANSITIONS, endorsementKinds: ENDORSEMENT_KINDS, endorsementResults: ENDORSEMENT_RESULTS, statutoryTypes: STATUTORY_TYPES,
      types: LICENSE_TYPES.map((t) => ({ value: t, label: INSTRUMENT_TYPE_LABEL[t]?.[0] ?? t, labelAr: INSTRUMENT_TYPE_LABEL[t]?.[1] ?? null, instrumentClass: instrumentClassOf(t), classLabel: classLabel(instrumentClassOf(t)), statutory: isStatutory(t), termMonths: termMonthsOf(t), convention: CONVENTION[t] ?? null, surveyRegime: SURVEY_REGIME[t] ?? null, certificateName: CERT_LABEL[t] ?? null })), signingKey: this.signing.publicKey() };
  }
  @RequirePerm(...VIEW_ANY) @Get('licenses')
  async list(@Query() query: ListQuery, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: '-createdAt', sortable: Object.keys(SORT), maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    const kinds = allowedKinds(user); if (!kinds.length) throw forbidden("You don't have permission to view instruments");
    args.push(kinds); where.push(`subject_kind = ANY($${args.length})`);
    const eq = (col: string, v: string | undefined) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
    eq('entity_type', query.entityType); eq('status', query.status); eq('subject_kind', query.subjectKind); eq('instrument_class', query.instrumentClass); eq('subject_id', query.subjectRef || query.subjectId);
    if (query.statutory === 'true' || query.statutory === 'false') { args.push(STATUTORY_TYPES); where.push(`${query.statutory === 'true' ? '' : 'NOT '}(entity_type = ANY($${args.length}))`); }
    const days = Number(query.expiringDays); if (Number.isFinite(days) && days > 0) { args.push(Math.min(days, 3650)); where.push(`status = 'ISSUED' AND expiry_date IS NOT NULL AND expiry_date <= now() + ($${args.length} || ' days')::interval`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(license_no ILIKE $${args.length} OR entity_name ILIKE $${args.length} OR contact_person ILIKE $${args.length})`); }
    /* The subject-kind gate above answers which kinds of instrument this reader's permissions cover; this
     * answers whose instruments they are. Both apply, and neither may widen the other. */
    scopeWhere(user.scope, where, args, LICENCE_SCOPE);
    const w = `WHERE ${where.join(' AND ')}`;
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM licences ${w}`, args);
    const rows = await this.pool.query<Row>(`SELECT * FROM licences ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, id LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(toApi), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }
  @RequirePerm(...MANAGE_ANY) @Post('licenses')
  async create(@Body(zod(createSchema)) b: z.infer<typeof createSchema>, @CurrentUser() user: Principal) {
    const kind = b.subjectKind; const type = b.entityType.toUpperCase();
    assertAny(user, managePerms(kind), `manage ${kind.toLowerCase().replace('_', ' ')} instruments`);
    if (!typeAllowedFor(kind, type)) throw badRequest(`${type} is not an instrument type issued to a ${kind.toLowerCase().replace('_', ' ')}`);
    const subjectId = b.subjectRef || b.subjectId || null;
    return withTx(this.pool, async (c) => {
      const subject = await resolveSubject(c, kind, subjectId);
      if (subjectId && !subject) throw notFound(`${MODEL_BY_KIND[kind]} ${subjectId} is not on the register`);
      const entityName = labelFor(kind, subject) || (b.entityName ?? '').trim();
      if (!entityName) throw badRequest('Either a linked subject or an entity name is required');
      const now = new Date();
      /* Who holds it, as distinct from what it is issued against. An applicant scoped to a company holds
       * their own instrument; an officer raising one on someone's behalf names the holder, and if neither
       * says, it is held by nobody rather than by whoever happened to key it in. */
      const holderCode = scopeOfRecord(user.scope).company ?? b.holderCode ?? '';
      const row = await insertLicence(c, { licenseNo: await nextLicenceNumber(c, type, now), holderCode, subjectKind: kind, subjectId, subjectModel: subjectId ? MODEL_BY_KIND[kind] : null, instrumentClass: instrumentClassOf(type), entityName, entityType: type, status: 'APPLIED',
        contactPerson: b.contactPerson, phone: b.phone, email: b.email, address: b.address, taxId: b.taxId, conditions: b.conditions, appliedDate: now, issuer: issuerFor(this.env.JURISDICTION), history: [{ from: '', to: 'APPLIED', at: now.toISOString(), by: user.name, note: 'Application received' }] });
      if (b.performanceRating != null) await updateLicence(c, row.id, { performanceRating: b.performanceRating });
      const fresh = (await findLicence(c, row.id, user.scope))!;
      await this.audit.record(c, { action: 'CREATE', entity: 'License', entityId: fresh.id, entityLabel: fresh.license_no, after: toApi(fresh) });
      await publishState(c, this.env, fresh, { event: EVENTS.instruments.applied });
      return toApi(fresh);
    });
  }
  @RequirePerm(...VIEW_ANY) @Get('licenses/:id')
  async get(@Param('id') id: string, @CurrentUser() user: Principal) {
    const row = await findLicence(this.pool, id, user.scope); if (!row) throw notFound('Instrument not found');
    assertAny(user, viewPerms(row.subject_kind), 'view this register');
    return detail(row, this.signing, this.pool);
  }
  @RequirePerm(...MANAGE_ANY) @Put('licenses/:id')
  async update(@Param('id') id: string, @Body(zod(updateSchema)) b: z.infer<typeof updateSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const row = await lockLicence(c, id, user.scope); if (!row) throw notFound('Instrument not found');
      assertAny(user, managePerms(row.subject_kind), 'edit this register');
      const patch: Patch = {};
      const signedTouched = (b.entityName !== undefined && b.entityName !== row.entity_name) || (b.entityType !== undefined && b.entityType.toUpperCase() !== row.entity_type) || (b.expiryDate !== undefined && (b.expiryDate ? new Date(b.expiryDate).getTime() : null) !== (row.expiry_date ? row.expiry_date.getTime() : null));
      if (row.status === 'ISSUED' && signedTouched) throw conflict('The holder, type and expiry of an issued instrument are signed facts and cannot be edited; suspend and re-issue instead');
      if (b.entityType !== undefined) { const t = b.entityType.toUpperCase(); if (!typeAllowedFor(row.subject_kind as SubjectKind, t)) throw badRequest(`${t} is not an instrument type issued to a ${row.subject_kind.toLowerCase().replace('_', ' ')}`); patch.entityType = t; patch.instrumentClass = instrumentClassOf(t); }
      if (b.entityName !== undefined) { if (!b.entityName && !row.subject_id) throw badRequest('An entity name is required'); if (b.entityName) patch.entityName = b.entityName; }
      for (const k of ['contactPerson', 'phone', 'email', 'address', 'taxId', 'conditions', 'performanceRating'] as const) if (b[k] !== undefined) (patch as Record<string, unknown>)[k] = b[k];
      if (b.expiryDate !== undefined) patch.expiryDate = b.expiryDate ? new Date(b.expiryDate) : null;
      const updated = Object.keys(patch).length ? await updateLicence(c, row.id, patch) : row;
      await this.audit.record(c, { action: 'UPDATE', entity: 'License', entityId: row.id, entityLabel: row.license_no, before: toApi(row), after: toApi(updated) });
      await publishState(c, this.env, updated, { event: EVENTS.instruments.updated });
      return toApi(updated);
    });
  }
  @RequirePerm(...MANAGE_ANY) @Delete('licenses/:id')
  async remove(@Param('id') id: string, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const row = await lockLicence(c, id, user.scope); if (!row) throw notFound('Instrument not found');
      assertAny(user, managePerms(row.subject_kind), 'edit this register');
      if (!['APPLIED', 'UNDER_REVIEW', 'REJECTED'].includes(row.status)) throw conflict('An issued instrument is a register entry and cannot be deleted; suspend or revoke it instead');
      await c.query('DELETE FROM licences WHERE id = $1', [row.id]);
      await this.audit.record(c, { action: 'DELETE', entity: 'License', entityId: row.id, entityLabel: row.license_no, before: toApi(row) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.readModel.deleted, { kind: 'instrument', id: row.id }, { subject: row.id }));
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.instruments.deleted, { instrumentId: row.id, number: row.license_no, entityName: row.entity_name, subjectKind: row.subject_kind, subjectId: row.subject_id }, { subject: row.id }));
      return { deleted: true, id: row.id };
    });
  }
  /** Dry run of the issue checks — what would block issue today, without changing anything. */
  @RequirePerm(...VIEW_ANY) @Get('licenses/:id/checks')
  async checks(@Param('id') id: string, @CurrentUser() user: Principal) {
    const row = await findLicence(this.pool, id, user.scope); if (!row) throw notFound('Instrument not found');
    assertAny(user, viewPerms(row.subject_kind), 'view this register');
    const subject = await resolveSubject(this.pool, row.subject_kind as SubjectKind, row.subject_id);
    const checks = checksFor(row.subject_kind as SubjectKind, subject, new Date());
    return { subjectKind: row.subject_kind, subjectId: row.subject_id, subjectLinked: !!subject, checks, blocking: checks.filter((x) => x.blocking && !x.passed).length, canIssue: (LICENSE_TRANSITIONS[row.status as LicenseStatus] ?? []).includes('ISSUED') && !checks.some((x) => x.blocking && !x.passed) };
  }
  @RequirePerm(...APPROVE_ANY) @Post('licenses/:id/transition')
  async transition(@Param('id') id: string, @Body(zod(transitionSchema)) b: z.infer<typeof transitionSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const row = await lockLicence(c, id, user.scope); if (!row) throw notFound('Instrument not found');
      assertAny(user, approvePerms(row.subject_kind, row.entity_type), 'decide on this register');
      const allowed = LICENSE_TRANSITIONS[row.status as LicenseStatus] ?? [];
      if (!allowed.includes(b.to)) throw conflict(`Cannot move from ${row.status} to ${b.to}; allowed: ${allowed.join(', ') || 'none'}`);
      if (['SUSPENDED', 'REVOKED', 'REJECTED'].includes(b.to) && !b.note) throw badRequest('A note is required for this decision');
      const now = new Date(); const before = toApi(row); let updated: Row;
      if (b.to === 'ISSUED') updated = (await issue(c, { env: this.env, signing: this.signing }, row, { now, by: user.name, note: b.note, override: b.override, expiryDate: b.expiryDate ?? null, authority: 'OFFICER' })).row;
      else updated = await updateLicence(c, row.id, { status: b.to, history: [...(row.history ?? []), { from: row.status, to: b.to, at: now.toISOString(), by: user.name, note: b.note ?? '' }] });
      const eventOf: Record<string, string> = { ISSUED: row.status === 'SUSPENDED' ? EVENTS.instruments.reinstated : EVENTS.instruments.issued, SUSPENDED: EVENTS.instruments.suspended, REVOKED: EVENTS.instruments.revoked, REJECTED: EVENTS.instruments.rejected, UNDER_REVIEW: EVENTS.instruments.updated };
      await this.audit.record(c, { action: 'TRANSITION', entity: 'License', entityId: row.id, entityLabel: row.license_no, before, after: toApi(updated), note: `${row.status} → ${b.to}${b.note ? `: ${b.note}` : ''}` });
      await publishState(c, this.env, updated, { event: eventOf[b.to], data: { from: row.status, note: b.note ?? '', by: { id: user.id, name: user.name }, override: !!b.override } });
      return detail(updated, this.signing, c, now);
    });
  }
  /** A recorded audit moves the performance rating: satisfactory nudges it up, a non-conformity knocks it down. */
  @RequirePerm(...MANAGE_ANY) @Post('licenses/:id/audits')
  async addAudit(@Param('id') id: string, @Body(zod(auditSchema)) b: z.infer<typeof auditSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const row = await lockLicence(c, id, user.scope); if (!row) throw notFound('Instrument not found');
      assertAny(user, managePerms(row.subject_kind), 'audit this register');
      const entry: LicenceAudit = { date: (b.date ? new Date(b.date) : new Date()).toISOString(), auditorId: b.auditorId ?? user.id, auditor: b.auditor || user.name, result: b.result, remarks: b.remarks ?? '' };
      const rating = Math.max(0, Math.min(5, Number(row.performance_rating) + RATING_DELTA[b.result]));
      const updated = await updateLicence(c, row.id, { audits: [...(row.audits ?? []), entry], performanceRating: Math.round(rating * 10) / 10 });
      await this.audit.record(c, { action: 'AUDIT_ADD', entity: 'License', entityId: row.id, entityLabel: row.license_no, after: entry });
      await publishState(c, this.env, updated, { event: EVENTS.instruments.audited, data: { result: b.result, auditor: entry.auditor, remarks: entry.remarks, performanceRating: Number(updated.performance_rating) } });
      return toApi(updated);
    });
  }
  /** The survey schedule a statutory certificate runs on, with what has been endorsed against it. */
  @RequirePerm(...VIEW_ANY) @Get('licenses/:id/endorsements')
  async endorsements(@Param('id') id: string, @CurrentUser() user: Principal) {
    const row = await findLicence(this.pool, id, user.scope); if (!row) throw notFound('Instrument not found');
    assertAny(user, viewPerms(row.subject_kind), 'view this register');
    if (!isStatutory(row.entity_type)) return { statutory: false, schedule: [], recorded: row.endorsements ?? [], inForce: row.status === 'ISSUED', reason: 'Not a statutory certificate' };
    const now = new Date(); const d = await detail(row, this.signing, this.pool, now);
    return { statutory: true, convention: CONVENTION[row.entity_type], regime: SURVEY_REGIME[row.entity_type] ?? null, schedule: d.endorsementState?.schedule ?? endorsementSchedule(row.entity_type, d.issueDate, d.expiryDate), next: d.endorsementState?.next ?? null, overdue: d.endorsementState?.overdue ?? 0, due: d.endorsementState?.due ?? 0, refused: d.endorsementState?.refused ?? 0, recorded: row.endorsements ?? [], inForce: d.inForce, reason: d.forceReason };
  }
  /** Record a survey endorsement. NOT_ENDORSED needs a reason and takes the certificate out of force at once; ENDORSED clears the window it answers. */
  @RequirePerm(...MANAGE_ANY) @Post('licenses/:id/endorsements')
  async endorse(@Param('id') id: string, @Body(zod(endorseSchema)) b: z.infer<typeof endorseSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const row = await lockLicence(c, id, user.scope); if (!row) throw notFound('Instrument not found');
      assertAny(user, [...managePerms(row.subject_kind), 'certificates.manage'], 'endorse this certificate');
      if (!isStatutory(row.entity_type)) throw badRequest('Only statutory certificates carry survey endorsements');
      if (row.status !== 'ISSUED') throw conflict('Only an issued certificate can be endorsed');
      if (b.result === 'NOT_ENDORSED' && !b.remarks) throw badRequest('State why the certificate was not endorsed');
      const now = new Date(); const completedOn = b.completedOn ? new Date(b.completedOn) : now;
      if (completedOn.getTime() > now.getTime() + 86400000) throw badRequest('A survey cannot be recorded before it is held');
      const st = endorsementState({ status: row.status, entityType: row.entity_type, issueDate: row.issue_date?.toISOString() ?? null, expiryDate: row.expiry_date?.toISOString() ?? null, endorsements: row.endorsements ?? [] }, now);
      const window = b.anniversary ? null : st.schedule.filter((s) => s.kind === b.kind && s.state !== 'ENDORSED').sort((x, y) => Math.abs(x.anniversary.getTime() - completedOn.getTime()) - Math.abs(y.anniversary.getTime() - completedOn.getTime()))[0] ?? null;
      const entry: WorldEndorsement = { kind: b.kind, anniversary: b.anniversary ? new Date(b.anniversary).toISOString() : (window?.anniversary ?? completedOn).toISOString(), completedOn: completedOn.toISOString(), surveyor: b.surveyor || user.name, organisation: b.organisation ?? '', place: b.place ?? '', result: b.result, remarks: b.remarks ?? '' };
      const updated = await updateLicence(c, row.id, { endorsements: [...(row.endorsements ?? []), entry] });
      await this.audit.record(c, { action: 'ENDORSE', entity: 'License', entityId: row.id, entityLabel: row.license_no, after: entry, note: `${b.kind} survey ${b.result.toLowerCase().replace(/_/g, ' ')}` });
      await publishState(c, this.env, updated, { event: b.result === 'NOT_ENDORSED' ? EVENTS.instruments.endorsementRefused : EVENTS.instruments.endorsed, data: { kind: b.kind, result: b.result, surveyor: entry.surveyor, organisation: entry.organisation, remarks: entry.remarks, completedOn: entry.completedOn } });
      return detail(updated, this.signing, c, now);
    });
  }
  /** Every instrument held by one subject, for the vessel, seafarer, company and facility screens. */
  @RequirePerm(...VIEW_ANY) @Get('instruments/subjects/:kind/:id')
  async forSubject(@Param('kind') kindRaw: string, @Param('id') id: string, @CurrentUser() user: Principal) {
    const kind = kindRaw.toUpperCase() as SubjectKind; if (!SUBJECT_KINDS.includes(kind)) throw badRequest('Unknown subject kind');
    assertAny(user, viewPerms(kind), 'view this register');
    const rows = await this.pool.query<Row>('SELECT * FROM licences WHERE subject_kind = $1 AND subject_id = $2 ORDER BY created_at DESC', [kind, id]);
    const now = new Date(); const list = await Promise.all(rows.rows.map((r) => detail(r, this.signing, this.pool, now)));
    return paged(list, { total: list.length, page: 1, limit: Math.max(1, list.length) });
  }
  /** Issued instruments running out inside the window, soonest first — the renewal work list. */
  @RequirePerm(...VIEW_ANY) @Get('instruments/expiring')
  async expiring(@Query() query: { days?: string; subjectKind?: string; limit?: string }, @CurrentUser() user: Principal) {
    const days = Math.min(3650, Math.max(1, Number(query.days) || 90)); const limit = Math.min(500, Math.max(1, Number(query.limit) || 100));
    const kinds = allowedKinds(user).filter((k) => !query.subjectKind || k === query.subjectKind.toUpperCase()); if (!kinds.length) throw forbidden("You don't have permission to view instruments");
    const rows = await this.pool.query<Row>(`SELECT * FROM licences WHERE status = 'ISSUED' AND subject_kind = ANY($1) AND expiry_date IS NOT NULL AND expiry_date <= now() + ($2 || ' days')::interval ORDER BY expiry_date ASC LIMIT ${limit}`, [kinds, String(days)]);
    const now = new Date();
    return paged(rows.rows.map((r) => ({ ...toApi(r), daysLeft: Math.ceil((r.expiry_date!.getTime() - now.getTime()) / 86400000), expired: r.expiry_date!.getTime() < now.getTime() })), { total: rows.rowCount ?? 0, page: 1, limit });
  }
}
