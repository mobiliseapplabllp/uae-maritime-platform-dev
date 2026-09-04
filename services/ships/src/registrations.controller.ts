import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { NATIONAL_SCOPE, AMENDMENT_TYPES, DELETION_REASONS, EVENTS, REGISTRATION_TRANSITIONS, canTransition, getJurisdiction, type PageQuery, type RegistrationStatus } from '@maritime/contracts';
import { scopeWhere, AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, badRequest, conflict, escapeLike, notFound, nextNumber, paged, parsePage, withTx, zod, type Principal } from '@maritime/service-kit';
import { REGISTRATION_SCOPE } from './scope';
import type { Env } from './env';
import { findVessel, publishVessel, vesselApi, type Row, type VesselRow } from './vessels';
import {
  CLOSED_STATUSES, OPEN_STATUSES, findRegistration, lockRegistration, nextApplicationNo, nextOfficialNumber, publishRegistration,
  publishRegistrationDeleted, registrationApi, registrationDetail, registryDashboard, updateRegistration, type RegistrationRow,
} from './registrations';
import {
  CERT_SERIES, REGISTRATION_KINDS_SUPPORTED, SLA_DAYS, blocking, feesFor, isKnownPort, kindLabel, portName, reference,
  registrationChecks, type Check, type RegistrationKind,
} from './registry';

/* The Registrar of Ships, as a service.
 *
 * The rules live in registry.ts; this decides who may do what, fetches the two facts the rules cannot know
 * for themselves, and writes the result back onto the ship. The one method worth reading closely is grant():
 * that is the moment a ship acquires — or loses — its nationality, and the only place in the platform
 * allowed to write a ship's registry columns. */

const D = 86_400_000;
const text = (max: number) => z.string().trim().max(max);
const ownerSchema = z.object({
  name: text(200).min(1), address: text(300).default(''), nationality: text(120).default(''), shares: z.coerce.number().int().min(0).max(10_000).default(0),
  kind: z.enum(['INDIVIDUAL', 'BODY_CORPORATE', 'COOPERATIVE_SOCIETY']).default('BODY_CORPORATE'), registrationNo: text(80).default(''), companyId: text(80).nullable().optional(),
});
const tonnageSchema = z.object({ gross: z.coerce.number().min(0).nullable().optional(), net: z.coerce.number().min(0).nullable().optional(), measuredBy: text(120).default(''), certificateNo: text(80).default(''), measuredOn: z.string().nullable().optional() });
const applySchema = z.object({
  kind: z.enum(REGISTRATION_KINDS_SUPPORTED), vesselId: z.string().min(1), draft: z.boolean().optional(),
  portOfRegistry: text(10).optional(), vesselName: text(160).optional(),
  applicantName: text(200).optional(), applicantEmail: text(200).optional(), applicantPhone: text(60).optional(), capacity: text(80).optional(),
  owners: z.array(ownerSchema).max(64).optional(), tonnage: tonnageSchema.optional(),
  previousFlag: text(120).optional(), previousRegistry: text(200).optional(), previousOfficialNumber: text(80).optional(),
  evidence: z.array(z.object({ key: text(80).min(1), label: text(200).optional(), reference: text(120).optional(), issuedBy: text(200).optional(), issuedOn: z.string().nullable().optional(), fileName: text(200).optional() })).max(40).optional(),
  encumbrances: z.array(z.object({ kind: z.enum(['MORTGAGE', 'LIEN', 'CHARGE']).default('MORTGAGE'), holder: text(200).min(1), amount: z.coerce.number().min(0).default(0), currency: text(8).optional(), registeredOn: z.string().nullable().optional(), reference: text(120).optional() })).max(40).optional(),
  amendment: z.object({ types: z.array(z.enum(AMENDMENT_TYPES)).max(8), before: z.record(z.unknown()).optional(), after: z.record(z.unknown()).optional(), approvalReference: text(120).optional() }).optional(),
  deletion: z.object({ reason: z.enum(DELETION_REASONS), newFlag: text(120).optional(), effectiveOn: z.string().nullable().optional() }).optional(),
});
const updateSchema = z.object({
  owners: z.array(ownerSchema).max(64).optional(), tonnage: tonnageSchema.optional(), portOfRegistry: text(10).optional(), vesselName: text(160).optional(),
  previousFlag: text(120).optional(), previousRegistry: text(200).optional(), previousOfficialNumber: text(80).optional(),
  amendment: z.object({ types: z.array(z.enum(AMENDMENT_TYPES)).max(8), before: z.record(z.unknown()).optional(), after: z.record(z.unknown()).optional(), approvalReference: text(120).optional() }).optional(),
  deletion: z.object({ reason: z.enum(DELETION_REASONS), newFlag: text(120).optional(), effectiveOn: z.string().nullable().optional() }).optional(),
  assignedTo: text(160).optional(), assignedToId: text(80).optional(),
});
const evidenceSchema = z.object({ key: text(80).min(1), label: text(200).default(''), reference: text(120).default(''), issuedBy: text(200).default(''), issuedOn: z.string().nullable().optional(), fileName: text(200).default('') });
const encumbranceSchema = z.object({ kind: z.enum(['MORTGAGE', 'LIEN', 'CHARGE']).default('MORTGAGE'), holder: text(200).min(1), amount: z.coerce.number().min(0).default(0), currency: text(8).optional(), registeredOn: z.string().nullable().optional(), reference: text(120).default('') });
const transitionSchema = z.object({ to: z.string().min(1), note: text(2000).optional(), override: z.boolean().optional() });
const carvingSchema = z.object({ surveyor: text(160).min(1), compliedOn: z.string().nullable().optional(), remarks: text(1000).default('') });
const grantSchema = z.object({ note: text(2000).optional() }).partial();

const SORT: Record<string, string> = { applicationNo: 'application_no', kind: 'kind', status: 'status', vesselName: 'vessel_name', portOfRegistry: 'port_of_registry', officialNumber: 'official_number', submittedAt: 'submitted_at', grantedOn: 'granted_on', dueAt: 'due_at', createdAt: 'created_at' };
type ListQuery = PageQuery & { status?: string; kind?: string; portOfRegistry?: string; assignedTo?: string; vesselId?: string; open?: string; breached?: string };

@Controller('registrations')
export class RegistrationsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  private get profile() { return this.env.JURISDICTION; }
  private api(r: RegistrationRow) { return registrationApi(r, this.profile); }

  /** What only the database can answer: whether this ship already sits on the register, and the money owed against her. */
  private async contextFor(c: PoolClient | Pool, doc: RegistrationRow) {
    /* The ship behind an application the caller has already been permitted to read: part of that
     * record's own context, not a second lookup the reader has to qualify for again. */
    const vessel = doc.vessel_id ? await findVessel(c, doc.vessel_id, NATIONAL_SCOPE) : null;
    const state = vessel?.registry_state ?? 'UNREGISTERED';
    const other = doc.vessel_id
      ? await c.query<{ n: string }>(`SELECT count(*) AS n FROM registrations WHERE vessel_id = $1 AND kind = ANY($2) AND status = 'GRANTED' AND id <> $3`, [doc.vessel_id, ['PERMANENT', 'PROVISIONAL'], doc.id])
      : { rows: [{ n: '0' }] };
    const dues = doc.vessel_id
      ? await c.query<{ total: string | null; currency: string | null }>(`SELECT sum(total)::text AS total, min(currency) AS currency FROM invoices WHERE vessel_id = $1 AND status = 'ISSUED'`, [doc.vessel_id])
      : { rows: [{ total: null, currency: null }] };
    // a closed entry is not a subsisting one, and a ship on a provisional certificate is not "already registered"
    // for the purpose of her permanent registration — the provisional entry exists to be superseded by exactly this file
    const bridging = doc.kind === 'PERMANENT' && state === 'PROVISIONAL';
    return {
      vessel, bridging, onRegister: Number(other.rows[0].n) > 0 && state !== 'CLOSED' && !bridging,
      outstandingDues: Number(dues.rows[0]?.total ?? 0) || 0, currency: dues.rows[0]?.currency ?? getJurisdiction(this.profile).currency.code,
    };
  }
  private async runChecks(c: PoolClient | Pool, doc: RegistrationRow) {
    const ctx = await this.contextFor(c, doc);
    const checks = registrationChecks(this.api(doc), ctx.vessel, ctx, this.profile);
    return { checks, blocked: blocking(checks), ctx };
  }

  /* -------------------------------------------------------------------- reference --- */

  /** The jurisdiction's registry profile: registrar, statute, ports, share rules, fees and evidence per journey. */
  @RequirePerm('registry.view') @Get('reference')
  reference() { return reference(this.profile); }

  /** The registry's own landing analytics — the queue, its SLA, and where the fleet stands on the register. */
  @RequirePerm('registry.view') @Get('dashboard')
  async dashboard() {
    const [rows, fleet] = await Promise.all([
      this.pool.query<RegistrationRow>('SELECT * FROM registrations'),
      this.pool.query<{ registry_state: string; certificate_expires_on: Date | null }>('SELECT registry_state, certificate_expires_on FROM vessels'),
    ]);
    return registryDashboard(rows.rows, fleet.rows, this.profile);
  }

  /* ------------------------------------------------------------------ the register --- */

  @RequirePerm('registry.view') @Get()
  async list(@Query() query: ListQuery, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: '-createdAt', sortable: Object.keys(SORT), maxLimit: 200 });
    const where: string[] = []; const args: unknown[] = [];
    const eq = (col: string, v: string | undefined) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
    eq('status', query.status); eq('kind', query.kind); eq('port_of_registry', query.portOfRegistry); eq('assigned_to', query.assignedTo); eq('vessel_id', query.vesselId);
    if (String(query.open) === 'true') { args.push(OPEN_STATUSES); where.push(`status = ANY($${args.length})`); }
    if (String(query.breached) === 'true') where.push('closed_at IS NULL AND due_at < now()');
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(application_no ILIKE $${args.length} OR vessel_name ILIKE $${args.length} OR imo ILIKE $${args.length} OR official_number ILIKE $${args.length} OR certificate_no ILIKE $${args.length} OR applicant->>'name' ILIKE $${args.length})`); }
    scopeWhere(user.scope, where, args, REGISTRATION_SCOPE);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM registrations ${w}`, args);
    const rows = await this.pool.query<RegistrationRow>(`SELECT * FROM registrations ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, application_no DESC LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map((r) => this.api(r)), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  @RequirePerm('registry.view') @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: Principal) {
    const doc = await findRegistration(this.pool, id, user.scope);
    if (!doc) throw notFound('Registration not found');
    const vessel = doc.vessel_id ? await findVessel(this.pool, doc.vessel_id, user.scope) : null;
    return registrationDetail(doc, vessel ? vesselApi(vessel, this.profile) : null, this.profile);
  }

  /** Dry-run the statutory checks against the file as it stands right now — an officer sees what will block before deciding. */
  @RequirePerm('registry.view') @Get(':id/checks')
  async checks(@Param('id') id: string, @CurrentUser() user: Principal) {
    const doc = await findRegistration(this.pool, id, user.scope);
    if (!doc) throw notFound('Registration not found');
    const { checks, blocked } = await this.runChecks(this.pool, doc);
    return { applicationNo: doc.application_no, kind: doc.kind, checks, blocked };
  }

  /* ----------------------------------------------------------------------- lodging --- */

  @RequirePerm('registry.apply', 'registry.assess') @Post()
  async apply(@Body(zod(applySchema)) body: z.infer<typeof applySchema>, @CurrentUser() user: Principal) {
    const j = getJurisdiction(this.profile);
    return withTx(this.pool, async (c) => {
      const vessel = await findVessel(c, body.vesselId, user.scope);
      if (!vessel) throw notFound('No vessel found for this application');
      const port = String(body.portOfRegistry ?? j.registry.defaultPort).toUpperCase();
      if (!isKnownPort(port, this.profile)) throw badRequest(`${port} is not a declared port of registry`);

      // one open application per ship per journey — a second one would fork the file
      const open = await c.query<{ application_no: string }>('SELECT application_no FROM registrations WHERE vessel_id = $1 AND kind = $2 AND NOT (status = ANY($3)) LIMIT 1', [vessel.id, body.kind, CLOSED_STATUSES]);
      if (open.rowCount) throw conflict(`${open.rows[0].application_no} is already open for this ship`);

      /* The ship's standing on the register decides which journeys are even available to her. The assessment
       * checks test the same fact, but refusing at the counter beats accepting an application that can never
       * be granted and saying so weeks later. */
      const onRegister = vessel.registry_state === 'REGISTERED' || vessel.registry_state === 'PROVISIONAL';
      if ((body.kind === 'PERMANENT' || body.kind === 'PROVISIONAL') && onRegister) {
        const bridging = body.kind === 'PERMANENT' && vessel.registry_state === 'PROVISIONAL';
        if (!bridging) throw conflict(`${vessel.name} already holds a registry entry — official number ${vessel.official_number}`);
      }
      if ((body.kind === 'AMENDMENT' || body.kind === 'DELETION') && !onRegister) {
        throw conflict(`${vessel.name} is not on the register, so there is nothing to ${body.kind === 'DELETION' ? 'close' : 'alter'}`);
      }

      const now = new Date();
      const isDraft = body.draft === true;
      const fee = feesFor(this.profile)[body.kind as RegistrationKind] ?? 0;
      const applicationNo = await nextApplicationNo(c, this.env, now);
      const r = await c.query<RegistrationRow>(
        `INSERT INTO registrations(application_no, kind, vessel_id, vessel_name, imo, port_of_registry, applicant, owners, tonnage, previous_flag, previous_registry, previous_official_number,
           evidence, encumbrances, amendment, deletion, status, fee, submitted_at, due_at, history)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING *`,
        [applicationNo, body.kind, vessel.id, body.vesselName ?? vessel.name, vessel.imo, port,
          JSON.stringify({ name: body.applicantName ?? user?.name ?? '', email: body.applicantEmail ?? user?.email ?? '', phone: body.applicantPhone ?? '', capacity: body.capacity ?? 'Owner' }),
          JSON.stringify(body.owners ?? []), JSON.stringify(body.tonnage ?? {}), body.previousFlag ?? '', body.previousRegistry ?? '', body.previousOfficialNumber ?? '',
          JSON.stringify((body.evidence ?? []).map((e) => ({ id: randomUUID(), verified: false, verifiedBy: '', verifiedAt: null, createdAt: now.toISOString(), ...e }))),
          JSON.stringify((body.encumbrances ?? []).map((e) => ({ id: randomUUID(), currency: j.currency.code, registeredOn: now.toISOString(), dischargedOn: null, ...e }))),
          body.amendment ? JSON.stringify(body.amendment) : null, body.deletion ? JSON.stringify(body.deletion) : null,
          isDraft ? 'DRAFT' : 'SUBMITTED', JSON.stringify({ amount: fee, currency: j.currency.code, paid: false }),
          isDraft ? null : now, isDraft ? null : new Date(now.getTime() + (SLA_DAYS[body.kind as RegistrationKind] ?? 30) * D),
          JSON.stringify([{ from: '', to: isDraft ? 'DRAFT' : 'SUBMITTED', at: now.toISOString(), by: user?.name ?? 'system', note: `${kindLabel(body.kind)} registration lodged` }])]);
      const doc = r.rows[0];
      await this.audit.record(c, { action: 'CREATE', entity: 'VesselRegistration', entityId: doc.id, entityLabel: `${doc.application_no} — ${doc.vessel_name} (${kindLabel(doc.kind)})`, after: this.api(doc) });
      return publishRegistration(c, this.env, doc, { event: EVENTS.ships.registrationLodged });
    });
  }

  /** Amend a file that has not yet been decided. */
  @RequirePerm('registry.assess') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(updateSchema)) body: z.infer<typeof updateSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const doc = await lockRegistration(c, id, user.scope);
      if (!doc) throw notFound('Registration not found');
      if (CLOSED_STATUSES.includes(doc.status)) throw conflict(`A ${doc.status.toLowerCase()} application cannot be edited`);
      const patch: Record<string, unknown> = {};
      for (const f of ['owners', 'tonnage', 'previousFlag', 'previousRegistry', 'previousOfficialNumber', 'amendment', 'deletion', 'assignedTo', 'assignedToId', 'vesselName'] as const) {
        if ((body as Row)[f] !== undefined) patch[f] = (body as Row)[f];
      }
      if (body.portOfRegistry) {
        const port = body.portOfRegistry.toUpperCase();
        if (!isKnownPort(port, this.profile)) throw badRequest(`${port} is not a declared port of registry`);
        patch.portOfRegistry = port;
      }
      const next = await updateRegistration(c, doc.id, patch);
      await this.audit.record(c, { action: 'UPDATE', entity: 'VesselRegistration', entityId: doc.id, entityLabel: doc.application_no, before: this.api(doc), after: this.api(next) });
      return publishRegistration(c, this.env, next, { event: EVENTS.ships.registrationUpdated });
    });
  }

  /** A file nobody has acted on can be taken off the register list; anything lodged is history and stays. */
  @RequirePerm('registry.grant') @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const doc = await lockRegistration(c, id, user.scope);
      if (!doc) throw notFound('Registration not found');
      if (doc.status !== 'DRAFT') throw conflict('Only a draft application can be deleted — a lodged file is part of the register');
      await this.audit.record(c, { action: 'DELETE', entity: 'VesselRegistration', entityId: doc.id, entityLabel: doc.application_no, before: this.api(doc) });
      await c.query('DELETE FROM registrations WHERE id = $1', [doc.id]);
      await publishRegistrationDeleted(c, this.env, doc);
      return { deleted: true, id: doc.id };
    });
  }

  /* -------------------------------------------------------------------- evidence --- */

  @RequirePerm('registry.apply', 'registry.assess') @Post(':id/evidence')
  async addEvidence(@Param('id') id: string, @Body(zod(evidenceSchema)) body: z.infer<typeof evidenceSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const doc = await lockRegistration(c, id, user.scope);
      if (!doc) throw notFound('Registration not found');
      if (CLOSED_STATUSES.includes(doc.status)) throw conflict(`A ${doc.status.toLowerCase()} application cannot take further evidence`);
      const item = { id: randomUUID(), ...body, issuedOn: body.issuedOn ?? null, verified: false, verifiedBy: '', verifiedAt: null, createdAt: new Date().toISOString() };
      const next = await updateRegistration(c, doc.id, { evidence: [...(doc.evidence ?? []), item] });
      await this.audit.record(c, { action: 'DOC_ADD', entity: 'VesselRegistration', entityId: doc.id, entityLabel: `${doc.application_no} — ${body.key}`, after: item });
      return publishRegistration(c, this.env, next, { event: EVENTS.ships.registrationUpdated, data: { change: 'EVIDENCE_ADDED', key: body.key } });
    });
  }

  @RequirePerm('registry.assess') @Put(':id/evidence/:evidenceId')
  async verifyEvidence(@Param('id') id: string, @Param('evidenceId') evidenceId: string, @Body(zod(z.object({ verified: z.boolean().optional() }))) body: { verified?: boolean }, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const doc = await lockRegistration(c, id, user.scope);
      if (!doc) throw notFound('Registration not found');
      const list = doc.evidence ?? [];
      const item = list.find((e: Row) => String(e.id) === evidenceId);
      if (!item) throw notFound('Document not found on this application');
      const verified = body.verified !== false;
      const after = { ...item, verified, verifiedBy: verified ? user?.name ?? 'Registry' : '', verifiedAt: verified ? new Date().toISOString() : null };
      const next = await updateRegistration(c, doc.id, { evidence: list.map((e: Row) => (String(e.id) === evidenceId ? after : e)) });
      await this.audit.record(c, { action: 'DOC_VERIFY', entity: 'VesselRegistration', entityId: doc.id, entityLabel: `${doc.application_no} — ${item.key}`, before: item, after });
      return publishRegistration(c, this.env, next, { event: EVENTS.ships.registrationUpdated, data: { change: 'EVIDENCE_VERIFIED', key: item.key } });
    });
  }

  /* ----------------------------------------------------------------- encumbrances --- */

  @RequirePerm('registry.assess') @Post(':id/encumbrances')
  async addEncumbrance(@Param('id') id: string, @Body(zod(encumbranceSchema)) body: z.infer<typeof encumbranceSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const doc = await lockRegistration(c, id, user.scope);
      if (!doc) throw notFound('Registration not found');
      const item = { id: randomUUID(), ...body, currency: body.currency ?? getJurisdiction(this.profile).currency.code, registeredOn: body.registeredOn ?? new Date().toISOString(), dischargedOn: null };
      const next = await updateRegistration(c, doc.id, { encumbrances: [...(doc.encumbrances ?? []), item] });
      await this.audit.record(c, { action: 'ENCUMBRANCE_ADD', entity: 'VesselRegistration', entityId: doc.id, entityLabel: `${doc.application_no} — ${body.holder}`, after: item });
      return publishRegistration(c, this.env, next, { event: EVENTS.ships.registrationUpdated, data: { change: 'ENCUMBRANCE_ADDED', holder: body.holder } });
    });
  }

  @RequirePerm('registry.assess') @Put(':id/encumbrances/:encumbranceId')
  async dischargeEncumbrance(@Param('id') id: string, @Param('encumbranceId') encumbranceId: string, @Body(zod(z.object({ dischargedOn: z.string().nullable().optional() }))) body: { dischargedOn?: string | null }, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const doc = await lockRegistration(c, id, user.scope);
      if (!doc) throw notFound('Registration not found');
      const list = doc.encumbrances ?? [];
      const item = list.find((e: Row) => String(e.id) === encumbranceId);
      if (!item) throw notFound('Charge not found on this application');
      if (item.dischargedOn) throw conflict('This charge is already discharged');
      const after = { ...item, dischargedOn: body.dischargedOn ?? new Date().toISOString() };
      const next = await updateRegistration(c, doc.id, { encumbrances: list.map((e: Row) => (String(e.id) === encumbranceId ? after : e)) });
      await this.audit.record(c, { action: 'ENCUMBRANCE_DISCHARGE', entity: 'VesselRegistration', entityId: doc.id, entityLabel: `${doc.application_no} — ${item.holder}`, before: item, after });
      return publishRegistration(c, this.env, next, { event: EVENTS.ships.registrationUpdated, data: { change: 'ENCUMBRANCE_DISCHARGED', holder: item.holder } });
    });
  }

  /* -------------------------------------------------------------------- lifecycle --- */

  @RequirePerm('registry.assess') @Post(':id/transition')
  async transition(@Param('id') id: string, @Body(zod(transitionSchema)) body: z.infer<typeof transitionSchema>, @CurrentUser() user: Principal) {
    const to = body.to as RegistrationStatus;
    return withTx(this.pool, async (c) => {
      const doc = await lockRegistration(c, id, user.scope);
      if (!doc) throw notFound('Registration not found');
      if (to === 'GRANTED') throw badRequest('Use the grant endpoint — a grant writes the register');
      if (!canTransition(REGISTRATION_TRANSITIONS, doc.status as RegistrationStatus, to)) {
        throw conflict(`A ${kindLabel(doc.status)} application cannot move to ${kindLabel(to)}`);
      }
      if (to === 'REJECTED' && !body.note) throw badRequest('A reason is required to refuse an application');
      // only a first registration is carved and surveyed
      if ((to === 'CARVING_NOTE_ISSUED' || to === 'SURVEY_COMPLETE') && doc.kind !== 'PERMANENT') throw conflict(`A ${kindLabel(doc.kind)} application is not carved or surveyed`);
      if (to === 'SURVEY_COMPLETE' && !doc.carving_note?.compliedOn) throw conflict("Record the surveyor's compliance report before closing the survey");

      const now = new Date();
      const from = doc.status;
      const patch: Record<string, unknown> = { status: to };

      /* The official number is allocated with the carving note, not with the certificate: the number has to
       * exist before it can be cut into the beam, and once cut it is the ship's for the life of the entry. */
      if (to === 'CARVING_NOTE_ISSUED') {
        patch.officialNumber = await this.allocateOfficialNumber(c, doc, user?.name ?? 'Registry');
        patch.carvingNote = {
          ...(doc.carving_note ?? {}),
          number: doc.carving_note?.number || await nextNumber(c, `${doc.port_of_registry}/CMN/${now.getUTCFullYear()}`, `${doc.port_of_registry}/CMN/${now.getUTCFullYear()}/`),
          issuedOn: now.toISOString(), issuedBy: user?.name ?? 'Registry',
        };
      }
      if (to === 'APPROVED') {
        const { checks, blocked } = await this.runChecks(c, doc);
        if (blocked.length && !body.override) throw conflict(`Cannot approve — ${blocked.map((x) => x.detail).join('; ')}`);
        if (blocked.length && body.override && !body.note) throw badRequest('An override requires a written reason');
        const recorded: Check[] = blocked.length && body.override ? [...checks, { check: 'Registrar override', passed: true, blocking: false, detail: body.note! }] : checks;
        patch.checks = recorded;
      }
      if (to === 'SUBMITTED' && !doc.submitted_at) {
        patch.submittedAt = now;
        patch.dueAt = new Date(now.getTime() + (SLA_DAYS[doc.kind as RegistrationKind] ?? 30) * D);
      }
      if (to === 'REJECTED') { patch.decision = { outcome: 'REJECTED', by: user?.name ?? 'Registry', at: now.toISOString(), reason: body.note ?? '' }; patch.closedAt = now; }
      if (to === 'WITHDRAWN') patch.closedAt = now;
      if (to === 'UNDER_SCRUTINY' && !doc.assigned_to) { patch.assignedTo = user?.name ?? 'Registry'; patch.assignedToId = user?.id ?? null; }
      patch.history = [...(doc.history ?? []), { from, to, at: now.toISOString(), by: user?.name ?? 'Registry', note: body.note ?? '' }];

      const next = await updateRegistration(c, doc.id, patch);
      await this.audit.record(c, { action: 'TRANSITION', entity: 'VesselRegistration', entityId: doc.id, entityLabel: `${doc.application_no}: ${from} → ${to}`, before: { status: from }, after: { status: to }, note: body.note ?? '' });
      return publishRegistration(c, this.env, next, { event: EVENTS.ships.registrationTransitioned, data: { from, to, note: body.note ?? '', override: !!body.override } });
    });
  }

  /** The surveyor reports that the official number and tonnage are cut into the ship. */
  @RequirePerm('registry.assess') @Post(':id/carving-compliance')
  async carvingCompliance(@Param('id') id: string, @Body(zod(carvingSchema)) body: z.infer<typeof carvingSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const doc = await lockRegistration(c, id, user.scope);
      if (!doc) throw notFound('Registration not found');
      if (doc.status !== 'CARVING_NOTE_ISSUED') throw conflict('No carving note is outstanding on this application');
      const now = new Date();
      const carving = { ...(doc.carving_note ?? {}), compliedOn: body.compliedOn ?? now.toISOString(), surveyor: body.surveyor, remarks: body.remarks ?? '' };
      const next = await updateRegistration(c, doc.id, {
        carvingNote: carving,
        history: [...(doc.history ?? []), { from: doc.status, to: doc.status, at: now.toISOString(), by: user?.name ?? 'Registry', note: `Carving and marking reported complied by ${body.surveyor}` }],
      });
      await this.audit.record(c, { action: 'CARVING_COMPLIED', entity: 'VesselRegistration', entityId: doc.id, entityLabel: `${doc.application_no} — ${body.surveyor}`, before: doc.carving_note, after: carving });
      return publishRegistration(c, this.env, next, { event: EVENTS.ships.registrationTransitioned, data: { change: 'CARVING_COMPLIED', surveyor: body.surveyor } });
    });
  }

  /* ------------------------------------------------------------------------ grant --- */

  /* The register is written here and nowhere else.
   *
   * Whatever the journey, the same three things happen: the file is closed with a certificate number, the
   * ship's registry entry is brought into line with what was granted, and — where the entry is being closed —
   * the ship comes off the register. Doing it in one place is what keeps the ship record and the register
   * from ever disagreeing. */
  @RequirePerm('registry.grant') @Post(':id/grant')
  async grant(@Param('id') id: string, @Body(zod(grantSchema)) body: z.infer<typeof grantSchema>, @CurrentUser() user: Principal) {
    const j = getJurisdiction(this.profile);
    return withTx(this.pool, async (c) => {
      const doc = await lockRegistration(c, id, user.scope);
      if (!doc) throw notFound('Registration not found');
      if (doc.status !== 'APPROVED') throw conflict('Only an approved application can be granted');
      const vr = await c.query<VesselRow>('SELECT * FROM vessels WHERE id = $1 FOR UPDATE', [doc.vessel_id]);
      const vessel = vr.rows[0];
      if (!vessel) throw notFound('The vessel record for this application no longer exists');

      const now = new Date();
      const by = user?.name ?? 'Registry';
      const series = CERT_SERIES[doc.kind as RegistrationKind] ?? 'CR';
      const key = `${doc.port_of_registry}/${series}/${now.getUTCFullYear()}`;
      const certificateNo = await nextNumber(c, key, `${key}/`);
      const patch: Record<string, unknown> = { certificateNo, status: 'GRANTED', grantedOn: now, grantedBy: by, closedAt: now, decision: { outcome: 'GRANTED', by, at: now.toISOString(), reason: body.note ?? '' } };
      const before = { ...vesselApi(vessel, this.profile).registry };
      const vPatch: Record<string, unknown> = {};
      let officialNumber = doc.official_number;
      let expires: Date | null = null;
      let event: string = EVENTS.ships.registrationGranted;

      if (doc.kind === 'PERMANENT' || doc.kind === 'PROVISIONAL') {
        officialNumber = await this.allocateOfficialNumber(c, doc, by);
        const provisional = doc.kind === 'PROVISIONAL';
        if (provisional) expires = new Date(now.getTime() + j.registry.provisionalValidityMonths.value * 30.44 * D);
        Object.assign(vPatch, {
          registry_state: provisional ? 'PROVISIONAL' : 'REGISTERED', official_number: officialNumber, registry_port: doc.port_of_registry,
          certificate_no: certificateNo, registered_on: now, certificate_expires_on: expires, closed_on: null, closure_reason: '',
          port_of_registry: portName(doc.port_of_registry, this.profile), flag: j.name,
        });
        if (doc.tonnage?.gross) vPatch.grt = Math.round(Number(doc.tonnage.gross));
        patch.officialNumber = officialNumber;
        if (provisional) patch.certificateExpiresOn = expires;
        event = EVENTS.ships.vesselRegistered;
      }

      if (doc.kind === 'AMENDMENT') {
        const types: string[] = doc.amendment?.types ?? [];
        const after: Row = doc.amendment?.after ?? {};
        // record what the entry looked like before the alteration, so the transcript reads as a history rather than only a current state
        const amendment = { ...(doc.amendment ?? {}), before: { name: vessel.name, portOfRegistry: vessel.registry_port, grt: vessel.grt, owner: vessel.owner, manager: vessel.manager } };
        if (types.includes('NAME') && after.name) { vPatch.name = String(after.name); patch.vesselName = String(after.name); }
        if (types.includes('PORT_OF_REGISTRY') && after.portOfRegistry) {
          const port = String(after.portOfRegistry).toUpperCase();
          if (!isKnownPort(port, this.profile)) throw badRequest(`${port} is not a declared port of registry`);
          vPatch.registry_port = port; vPatch.port_of_registry = portName(port, this.profile);
        }
        if (types.includes('TONNAGE') && after.grt) vPatch.grt = Math.round(Number(after.grt));
        if (types.includes('OWNERSHIP') && after.owner) vPatch.owner = String(after.owner);
        if (types.includes('MANAGER') && after.manager) vPatch.manager = String(after.manager);
        vPatch.certificate_no = certificateNo;   // the certificate is reissued as altered
        patch.amendment = amendment;
      }

      if (doc.kind === 'DELETION') {
        const deletion: Row = { ...(doc.deletion ?? {}), certificateNo, issuedOn: now.toISOString(), effectiveOn: doc.deletion?.effectiveOn ?? now.toISOString() };
        patch.deletion = deletion;
        Object.assign(vPatch, { registry_state: 'CLOSED', closed_on: new Date(deletion.effectiveOn), closure_reason: deletion.reason ?? '' });
        if (deletion.newFlag) vPatch.flag = String(deletion.newFlag);
        // a ship off the register is no longer a ship of this flag; she stays on the fleet record as history but stops being operationally live
        vPatch.status = 'INACTIVE';
        event = EVENTS.ships.registryClosed;
      }

      patch.history = [...(doc.history ?? []), { from: 'APPROVED', to: 'GRANTED', at: now.toISOString(), by, note: `${certificateNo} issued` }];
      const next = await updateRegistration(c, doc.id, patch);
      const keys = Object.keys(vPatch);
      const updated = keys.length
        ? (await c.query<VesselRow>(`UPDATE vessels SET ${keys.map((k, i) => `${k} = $${i + 2}`).concat('updated_at = now()').join(', ')} WHERE id = $1 RETURNING *`, [vessel.id, ...keys.map((k) => vPatch[k])])).rows[0]
        : vessel;

      await this.audit.record(c, { action: 'GRANT', entity: 'VesselRegistration', entityId: doc.id, entityLabel: `${doc.application_no} → ${certificateNo}`, before, after: vesselApi(updated, this.profile).registry, note: body.note ?? '' });
      const registration = await publishRegistration(c, this.env, next, { event: EVENTS.ships.registrationGranted, data: { certificateNo, officialNumber, kind: doc.kind } });
      const vesselEntity = await publishVessel(c, this.env, updated, {
        event, data: { certificateNo, officialNumber, applicationNo: doc.application_no, kind: doc.kind, ...(doc.kind === 'DELETION' ? { reason: doc.deletion?.reason ?? '', newFlag: doc.deletion?.newFlag ?? '' } : {}) },
      });
      return { registration, vessel: { id: updated.id, name: updated.name, registry: vesselEntity.registry } };
    });
  }

  /* Allocate the official number. The number is the ship's for the life of the entry, so a permanent
   * registration bridging from a provisional one inherits it rather than taking a fresh one: a ship whose
   * official number changed halfway through her first year on the flag would be a ship nobody could trace. */
  private async allocateOfficialNumber(c: PoolClient, doc: RegistrationRow, by: string): Promise<string> {
    if (doc.official_number) return doc.official_number;
    /* The ship behind an application the caller has already been permitted to read: part of that
     * record's own context, not a second lookup the reader has to qualify for again. */
    const vessel = doc.vessel_id ? await findVessel(c, doc.vessel_id, NATIONAL_SCOPE) : null;
    if (doc.kind === 'PERMANENT' && vessel?.registry_state === 'PROVISIONAL' && vessel.official_number) {
      const prior = await c.query<RegistrationRow>(`SELECT * FROM registrations WHERE vessel_id = $1 AND kind = 'PROVISIONAL' AND status = 'GRANTED' ORDER BY granted_on DESC LIMIT 1`, [doc.vessel_id]);
      if (prior.rows[0]) {
        await updateRegistration(c, prior.rows[0].id, { history: [...(prior.rows[0].history ?? []), { from: 'GRANTED', to: 'GRANTED', at: new Date().toISOString(), by, note: `Superseded by ${doc.application_no}` }] });
      }
      return vessel.official_number;
    }
    return nextOfficialNumber(c, this.profile);
  }
}
