import type { PoolClient } from 'pg';
import { EVENTS, MET_LICENSE_TYPES, makeEvent, type Actor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, badRequest, conflict, enqueue, eventFromContext, lookupOptions, notFound, recordScope, type Principal, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { D, daysLeft, iso, dateOnly, type Row } from './crew';
import { loadVocab, type Vocab } from './vocab';

/* The MET register — maritime education and training providers, and what each is approved to teach.
 *
 * An institution is a company on the directory, and its accreditation is an instrument whose annual cycle
 * the facilities service runs on the same engine as the six industry schemes. Neither of those is owned
 * here, and neither is asked for synchronously: the company's identity arrives as master-data events, and
 * the accreditation's standing arrives as `facilities.accreditation.*` events and is mirrored onto the row.
 * What this register owns is the overlay a training regulator needs beyond "licensed": the institution's
 * type, its capacity, its simulators and quality system, and the programme approvals under STCW I/8.
 *
 * Programmes and institution types are codes of the `metProgramme` and `metInstitutionType` masters; the
 * register validates against its mirror of them and prints the master's label. */

export const INSTITUTION_STATUS = ['ACTIVE', 'SUSPENDED', 'CLOSED'] as const;
export const ACCREDITATION_STATUS = ['NONE', 'CURRENT', 'DUE', 'EXPIRED', 'SUSPENDED', 'WITHDRAWN'] as const;
export const PROGRAMME_STATUS = ['PENDING', 'APPROVED', 'SUSPENDED', 'WITHDRAWN'] as const;
export const MET_SCOPE = { columns: ['company'] as const, publicToCompanies: false };

export interface InstitutionRow {
  id: string; company_id: string; code: string; name: string; name_ar: string; institution_type: string; city: string; address: string;
  contact_name: string; contact_email: string; contact_phone: string; status: string; status_reason: string;
  accreditation_status: string; accreditation_reason: string; accreditation_instrument_id: string | null; accreditation_instrument_no: string;
  accreditation_cycle_id: string | null; accreditation_cycle_no: number; accredited_from: Date | null; accredited_until: Date | null;
  instructors: number; capacity: number; simulators: string[]; quality_system: string; established_on: Date | null; remarks: string;
  scope_company: string; created_by: string; created_at: Date; updated_at: Date;
}
export interface ProgrammeRow {
  id: string; institution_id: string; programme: string; title: string; regulation: string; seats_per_intake: number; intakes_per_year: number;
  status: string; status_reason: string; approval_no: string; instrument_id: string | null; approved_on: Date | null; expires_on: Date | null; remarks: string; created_at: Date; updated_at: Date;
}

export const programmeApi = (p: ProgrammeRow) => ({
  id: p.id, institutionId: p.institution_id, programme: p.programme, title: p.title, regulation: p.regulation,
  seatsPerIntake: p.seats_per_intake, intakesPerYear: p.intakes_per_year, seatsPerYear: p.seats_per_intake * p.intakes_per_year,
  status: p.status, statusReason: p.status_reason, approvalNo: p.approval_no, instrumentId: p.instrument_id, approvedOn: iso(p.approved_on), expiresOn: iso(p.expires_on),
  expired: !!p.expires_on && p.expires_on.getTime() < Date.now() && p.status === 'APPROVED', remarks: p.remarks, createdAt: iso(p.created_at), updatedAt: iso(p.updated_at),
});
export type ProgrammeApi = ReturnType<typeof programmeApi>;

export function institutionApi(r: InstitutionRow, programmes: ProgrammeRow[] = [], now = new Date()) {
  const ps = programmes.map(programmeApi);
  const approved = ps.filter((p) => p.status === 'APPROVED');
  return {
    id: r.id, companyId: r.company_id, code: r.code, name: r.name, nameAr: r.name_ar, institutionType: r.institution_type, city: r.city, address: r.address,
    contactName: r.contact_name, contactEmail: r.contact_email, contactPhone: r.contact_phone, status: r.status, statusReason: r.status_reason,
    accreditation: {
      status: r.accreditation_status, reason: r.accreditation_reason, instrumentId: r.accreditation_instrument_id, instrumentNo: r.accreditation_instrument_no,
      cycleId: r.accreditation_cycle_id, cycleNo: r.accreditation_cycle_no, from: iso(r.accredited_from), until: iso(r.accredited_until),
      daysLeft: r.accredited_until ? daysLeft(r.accredited_until, now) : null,
    },
    accredited: r.accreditation_status === 'CURRENT' || r.accreditation_status === 'DUE',
    instructors: r.instructors, capacity: r.capacity, simulators: r.simulators ?? [], qualitySystem: r.quality_system, establishedOn: dateOnly(r.established_on), remarks: r.remarks,
    programmes: ps, programmeCount: ps.length, approvedProgrammes: approved.length, pendingProgrammes: ps.filter((p) => p.status === 'PENDING').length,
    suspendedProgrammes: ps.filter((p) => p.status === 'SUSPENDED').length, seatsPerYear: approved.reduce((t, p) => t + p.seatsPerYear, 0),
    createdBy: r.created_by, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
  };
}
export type InstitutionApi = ReturnType<typeof institutionApi>;

export const programmesOf = async (c: Queryable, institutionId: string) => (await c.query<ProgrammeRow>('SELECT * FROM met_programmes WHERE institution_id = $1 ORDER BY status, programme', [institutionId])).rows;
export async function loadInstitution(c: Queryable, ref: string, lock = false): Promise<InstitutionRow | null> {
  const r = await c.query<InstitutionRow>(`SELECT * FROM met_institutions WHERE id::text = $1 OR upper(code) = upper($1) OR company_id = $1${lock ? ' FOR UPDATE' : ''}`, [ref]);
  return r.rows[0] ?? null;
}
export async function institutionEntity(c: Queryable, r: InstitutionRow, now = new Date()) { return institutionApi(r, await programmesOf(c, r.id), now); }

/** Every write publishes the API-shaped snapshot, then the business event. */
export async function publishInstitution(c: Queryable, env: Env, r: InstitutionRow, opts: { event?: string; data?: Row; cause?: EventEnvelope; actor?: Actor } = {}) {
  const entity = await institutionEntity(c, r);
  const mk = <T,>(type: string, data: T) => (opts.cause
    ? makeEvent({ type, source: env.SERVICE_NAME, data, subject: r.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor })
    : eventFromContext(env.SERVICE_NAME, type, data, { subject: r.id, actor: opts.actor }));
  await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'metInstitution', entity: { ...entity, scope: recordScope(r) } }));
  if (opts.event) await enqueue(c, mk(opts.event, { institutionId: r.id, code: r.code, name: r.name, companyId: r.company_id, accreditationStatus: r.accreditation_status, ...(opts.data ?? {}) }));
  return entity;
}

/* ------------------------------------------------------------------- the schemes --- */

/** The accreditation schemes that accredit a training provider: the `accreditationCategory` entries whose instrument is one of the MET instrument types. */
export async function metSchemeCodes(c: Queryable): Promise<string[]> {
  const all = await lookupOptions(c, 'accreditationCategory', { activeOnly: false });
  return all.filter((o) => (MET_LICENSE_TYPES as readonly string[]).includes(String(o.meta.instrumentType ?? ''))).map((o) => o.code);
}

/* ----------------------------------------------------------------------- writes --- */

export interface InstitutionInput {
  companyId: string; code: string; name: string; nameAr?: string; institutionType: string; city?: string; address?: string; contactName?: string; contactEmail?: string; contactPhone?: string;
  instructors?: number; capacity?: number; simulators?: string[]; qualitySystem?: string; establishedOn?: string | null; remarks?: string;
}
const COLS: Record<string, string> = { companyId: 'company_id', code: 'code', name: 'name', nameAr: 'name_ar', institutionType: 'institution_type', city: 'city', address: 'address', contactName: 'contact_name', contactEmail: 'contact_email', contactPhone: 'contact_phone', instructors: 'instructors', capacity: 'capacity', simulators: 'simulators', qualitySystem: 'quality_system', establishedOn: 'established_on', remarks: 'remarks' };

export async function registerInstitution(c: PoolClient, env: Env, audit: AuditClient, input: InstitutionInput, by: Principal | null): Promise<InstitutionRow> {
  const types = await loadVocab(c, 'metInstitutionType');
  const type = types.resolve(input.institutionType, 'institutionType');
  const dupe = await c.query('SELECT id FROM met_institutions WHERE upper(code) = upper($1) OR company_id = $2', [input.code, input.companyId]);
  if (dupe.rowCount) throw conflict(`${input.code} is already on the MET register`);
  const r = await c.query<InstitutionRow>(
    `INSERT INTO met_institutions(company_id, code, name, name_ar, institution_type, city, address, contact_name, contact_email, contact_phone, instructors, capacity, simulators, quality_system, established_on, remarks, scope_company, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [input.companyId, input.code.toUpperCase(), input.name, input.nameAr ?? '', type.code, input.city ?? '', input.address ?? '', input.contactName ?? '', input.contactEmail ?? '', input.contactPhone ?? '',
      input.instructors ?? 0, input.capacity ?? 0, JSON.stringify(input.simulators ?? []), input.qualitySystem ?? '', input.establishedOn || null, input.remarks ?? '', input.code.toUpperCase(), by?.name ?? '']);
  const row = r.rows[0];
  await audit.record(c, { action: 'MET_REGISTER', entity: 'MetInstitution', entityId: row.id, entityLabel: row.name, after: institutionApi(row) });
  await publishInstitution(c, env, row, { event: EVENTS.seafarers.metInstitutionRegistered });
  return row;
}

export async function updateInstitution(c: PoolClient, env: Env, audit: AuditClient, ref: string, patch: Partial<InstitutionInput>): Promise<InstitutionRow> {
  const before = await loadInstitution(c, ref, true);
  if (!before) throw notFound('MET institution not found');
  const values: Row = { ...patch };
  if (patch.institutionType !== undefined) values.institutionType = (await loadVocab(c, 'metInstitutionType')).resolve(patch.institutionType, 'institutionType').code;
  if (patch.code !== undefined) values.code = String(patch.code).toUpperCase();
  if (patch.simulators !== undefined) values.simulators = JSON.stringify(patch.simulators);
  if (patch.establishedOn === '') values.establishedOn = null;
  const keys = Object.keys(COLS).filter((k) => values[k] !== undefined);
  if (!keys.length) throw badRequest('Nothing to update');
  const row = (await c.query<InstitutionRow>(`UPDATE met_institutions SET ${keys.map((k, i) => `${COLS[k]} = $${i + 2}`).concat('updated_at = now()').join(', ')} WHERE id = $1 RETURNING *`, [before.id, ...keys.map((k) => values[k])])).rows[0];
  await audit.record(c, { action: 'MET_UPDATE', entity: 'MetInstitution', entityId: row.id, entityLabel: row.name, before: institutionApi(before), after: institutionApi(row) });
  await publishInstitution(c, env, row, { event: EVENTS.seafarers.metInstitutionUpdated, data: { changed: keys } });
  return row;
}

export async function setInstitutionStatus(c: PoolClient, env: Env, audit: AuditClient, ref: string, status: string, reason: string): Promise<InstitutionRow> {
  const before = await loadInstitution(c, ref, true);
  if (!before) throw notFound('MET institution not found');
  if (!(INSTITUTION_STATUS as readonly string[]).includes(status)) throw badRequest(`Unknown status ${status}`, { allowed: INSTITUTION_STATUS });
  if (before.status === status) return before;
  const row = (await c.query<InstitutionRow>('UPDATE met_institutions SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1 RETURNING *', [before.id, status, reason])).rows[0];
  await audit.record(c, { action: `MET_${status}`, entity: 'MetInstitution', entityId: row.id, entityLabel: row.name, before: { status: before.status }, after: { status }, note: reason });
  await publishInstitution(c, env, row, { event: EVENTS.seafarers.metInstitutionUpdated, data: { changed: ['status'], status, reason } });
  return row;
}

export interface ProgrammeInput { programme: string; seatsPerIntake?: number; intakesPerYear?: number; approvalNo?: string; approvedOn?: string | null; expiresOn?: string | null; status?: string; remarks?: string }

/** Approves (or files as pending) a programme from the master; the title and regulation are the master's, not the form's. */
export async function addProgramme(c: PoolClient, env: Env, audit: AuditClient, ref: string, input: ProgrammeInput, by: Principal | null): Promise<{ institution: InstitutionRow; programme: ProgrammeRow }> {
  const inst = await loadInstitution(c, ref, true);
  if (!inst) throw notFound('MET institution not found');
  if (inst.status !== 'ACTIVE') throw conflict(`${inst.name} is ${inst.status.toLowerCase()} — programmes cannot be added`);
  const master: Vocab = await loadVocab(c, 'metProgramme');
  const p = master.resolve(input.programme, 'programme');
  const status = input.status ?? (input.approvalNo ? 'APPROVED' : 'PENDING');
  if (!(PROGRAMME_STATUS as readonly string[]).includes(status)) throw badRequest(`Unknown programme status ${status}`, { allowed: PROGRAMME_STATUS });
  if (status === 'APPROVED' && !input.approvalNo) throw badRequest('An approved programme carries its approval number');
  const dupe = await c.query('SELECT id FROM met_programmes WHERE institution_id = $1 AND programme = $2', [inst.id, p.code]);
  if (dupe.rowCount) throw conflict(`${p.label} is already on ${inst.name}'s programme list`);
  const approvedOn = status === 'APPROVED' ? (input.approvedOn ? new Date(input.approvedOn) : new Date()) : null;
  const expiresOn = input.expiresOn ? new Date(input.expiresOn) : approvedOn ? new Date(approvedOn.getTime() + 5 * 365 * D) : null;
  const r = await c.query<ProgrammeRow>(
    `INSERT INTO met_programmes(institution_id, programme, title, regulation, seats_per_intake, intakes_per_year, status, approval_no, approved_on, expires_on, remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [inst.id, p.code, p.label, String(p.meta.regulation ?? ''), input.seatsPerIntake ?? 0, input.intakesPerYear ?? 1, status, input.approvalNo ?? '', approvedOn, expiresOn, input.remarks ?? '']);
  const programme = r.rows[0];
  await audit.record(c, { action: status === 'APPROVED' ? 'MET_PROGRAMME_APPROVED' : 'MET_PROGRAMME_FILED', entity: 'MetInstitution', entityId: inst.id, entityLabel: `${inst.name} — ${p.label}`, after: programmeApi(programme), note: by?.name ?? '' });
  await publishInstitution(c, env, inst, { event: status === 'APPROVED' ? EVENTS.seafarers.programmeApproved : EVENTS.seafarers.programmeChanged, data: { programmeId: programme.id, programme: p.code, title: p.label, status, approvalNo: programme.approval_no } });
  return { institution: inst, programme };
}

export async function updateProgramme(c: PoolClient, env: Env, audit: AuditClient, ref: string, programmeId: string, patch: Partial<ProgrammeInput> & { statusReason?: string }): Promise<ProgrammeRow> {
  const inst = await loadInstitution(c, ref, true);
  if (!inst) throw notFound('MET institution not found');
  const before = (await c.query<ProgrammeRow>('SELECT * FROM met_programmes WHERE id::text = $1 AND institution_id = $2 FOR UPDATE', [programmeId, inst.id])).rows[0];
  if (!before) throw notFound('Programme not found');
  if (patch.status && !(PROGRAMME_STATUS as readonly string[]).includes(patch.status)) throw badRequest(`Unknown programme status ${patch.status}`, { allowed: PROGRAMME_STATUS });
  if (patch.status === 'APPROVED' && !(patch.approvalNo ?? before.approval_no)) throw badRequest('An approved programme carries its approval number');
  const map: Record<string, string> = { seatsPerIntake: 'seats_per_intake', intakesPerYear: 'intakes_per_year', approvalNo: 'approval_no', approvedOn: 'approved_on', expiresOn: 'expires_on', status: 'status', statusReason: 'status_reason', remarks: 'remarks' };
  const values: Row = { ...patch };
  if (patch.status === 'APPROVED' && !before.approved_on && !patch.approvedOn) values.approvedOn = new Date();
  const keys = Object.keys(map).filter((k) => values[k] !== undefined);
  if (!keys.length) throw badRequest('Nothing to update');
  const row = (await c.query<ProgrammeRow>(`UPDATE met_programmes SET ${keys.map((k, i) => `${map[k]} = $${i + 2}`).concat('updated_at = now()').join(', ')} WHERE id = $1 RETURNING *`, [before.id, ...keys.map((k) => (values[k] === '' && /On$/.test(k) ? null : values[k]))])).rows[0];
  const statusChanged = patch.status && patch.status !== before.status;
  await audit.record(c, { action: statusChanged ? `MET_PROGRAMME_${row.status}` : 'MET_PROGRAMME_UPDATE', entity: 'MetInstitution', entityId: inst.id, entityLabel: `${inst.name} — ${row.title}`, before: programmeApi(before), after: programmeApi(row), note: patch.statusReason ?? '' });
  const event = row.status === 'WITHDRAWN' && statusChanged ? EVENTS.seafarers.programmeWithdrawn : row.status === 'APPROVED' && statusChanged ? EVENTS.seafarers.programmeApproved : EVENTS.seafarers.programmeChanged;
  await publishInstitution(c, env, inst, { event, data: { programmeId: row.id, programme: row.programme, title: row.title, status: row.status, reason: patch.statusReason ?? '', approvalNo: row.approval_no } });
  return row;
}

/* --------------------------------------------------- what arrives from elsewhere --- */

const CYCLE_STATUS_BY_EVENT: Record<string, string> = {
  [EVENTS.facilities.accreditationOpened]: 'CURRENT', [EVENTS.facilities.accreditationRenewed]: 'CURRENT', [EVENTS.facilities.accreditationDue]: 'DUE',
  [EVENTS.facilities.accreditationExpired]: 'EXPIRED', [EVENTS.facilities.accreditationSuspended]: 'SUSPENDED', [EVENTS.facilities.accreditationWithdrawn]: 'WITHDRAWN',
};
export const ACCREDITATION_EVENTS = Object.keys(CYCLE_STATUS_BY_EVENT);

/** A facilities accreditation event under a MET scheme moves the institution's mirrored standing. Answers whether it did. */
export async function applyAccreditationEvent(c: PoolClient, env: Env, audit: AuditClient, event: EventEnvelope): Promise<boolean> {
  const next = CYCLE_STATUS_BY_EVENT[event.type];
  if (!next) return false;
  const d = (event.data ?? {}) as Row;
  if (!d.companyId || !d.category || !(await metSchemeCodes(c)).includes(String(d.category))) return false;
  const inst = (await c.query<InstitutionRow>('SELECT * FROM met_institutions WHERE company_id = $1 FOR UPDATE', [String(d.companyId)])).rows[0];
  if (!inst) return false;
  const reason = String(d.reason ?? (d.change ? `Cycle ${d.change}` : d.daysLeft != null ? `${d.daysLeft} days to the end of the cycle` : ''));
  const row = (await c.query<InstitutionRow>(
    `UPDATE met_institutions SET accreditation_status = $2, accreditation_reason = $3, accreditation_instrument_id = COALESCE($4, accreditation_instrument_id), accreditation_instrument_no = COALESCE(NULLIF($5, ''), accreditation_instrument_no),
       accreditation_cycle_id = COALESCE($6, accreditation_cycle_id), accreditation_cycle_no = COALESCE($7, accreditation_cycle_no), accredited_from = COALESCE($8, accredited_from), accredited_until = COALESCE($9, accredited_until), updated_at = now()
     WHERE id = $1 RETURNING *`,
    [inst.id, next, reason, d.instrumentId ? String(d.instrumentId) : null, String(d.instrumentNo ?? ''), d.cycleId ? String(d.cycleId) : null, d.cycleNo != null ? Number(d.cycleNo) : null, d.startsOn ? new Date(d.startsOn) : null, d.endsOn ? new Date(d.endsOn) : null])).rows[0];
  await audit.record(c, { action: `MET_ACCREDITATION_${next}`, entity: 'MetInstitution', entityId: row.id, entityLabel: row.name, before: { accreditationStatus: inst.accreditation_status }, after: { accreditationStatus: next, cycleNo: row.accreditation_cycle_no }, note: reason, actor: { id: 'facilities', name: 'Facilities', kind: 'system' } });
  await publishInstitution(c, env, row, { event: EVENTS.seafarers.metAccreditationChanged, data: { previousStatus: inst.accreditation_status, status: next, reason, cycleNo: row.accreditation_cycle_no, until: iso(row.accredited_until) }, cause: event });
  return true;
}

/** An instrument snapshot raised against a MET institution: the accreditation itself, or a programme approval. */
export async function applyMetInstrument(c: PoolClient, env: Env, audit: AuditClient, e: Row, cause: EventEnvelope): Promise<boolean> {
  if (String(e.subjectKind ?? '') !== 'MET_INSTITUTION' || !e.subjectId) return false;
  const inst = (await c.query<InstitutionRow>('SELECT * FROM met_institutions WHERE company_id = $1 FOR UPDATE', [String(e.subjectId)])).rows[0];
  if (!inst) return false;
  const type = String(e.entityType ?? ''); const status = String(e.status ?? ''); const number = String(e.number ?? e.licenseNo ?? '');
  if (type === 'MET_INSTITUTION_ACCREDITATION') {
    // the cycle's standing is facilities' to say; the instrument itself is recorded, and stands in until the first cycle event arrives
    const standing = inst.accreditation_status === 'NONE' && status === 'ISSUED' ? 'CURRENT' : inst.accreditation_status;
    const row = (await c.query<InstitutionRow>(
      `UPDATE met_institutions SET accreditation_instrument_id = $2, accreditation_instrument_no = $3, accreditation_status = $4, accredited_from = COALESCE(accredited_from, $5), accredited_until = COALESCE($6, accredited_until), updated_at = now() WHERE id = $1 RETURNING *`,
      [inst.id, String(e.id), number, standing, e.issueDate ? new Date(e.issueDate) : null, e.expiryDate ? new Date(e.expiryDate) : null])).rows[0];
    await audit.record(c, { action: 'MET_INSTRUMENT_MIRRORED', entity: 'MetInstitution', entityId: row.id, entityLabel: row.name, after: { number, status, expiryDate: e.expiryDate ?? null }, note: 'Accreditation instrument mirrored from the instrument register', actor: { id: 'instruments', name: 'Instruments', kind: 'system' } });
    await publishInstitution(c, env, row, { cause });
    return true;
  }
  if (type === 'MET_PROGRAMME_APPROVAL') {
    const code = String(e.particulars?.programme ?? e.fields?.programme ?? e.data?.programme ?? e.programme ?? '');
    const target = code ? (await c.query<ProgrammeRow>('SELECT * FROM met_programmes WHERE institution_id = $1 AND (programme = $2 OR instrument_id = $3) FOR UPDATE', [inst.id, code, String(e.id)])).rows[0]
      : (await c.query<ProgrammeRow>('SELECT * FROM met_programmes WHERE institution_id = $1 AND instrument_id = $2 FOR UPDATE', [inst.id, String(e.id)])).rows[0];
    if (!target) {
      await audit.record(c, { action: 'MET_PROGRAMME_INSTRUMENT_UNLINKED', entity: 'MetInstitution', entityId: inst.id, entityLabel: inst.name, after: { number, status, programme: code || null }, note: 'A programme approval arrived that names no programme on the register — link it from the programme list', actor: { id: 'instruments', name: 'Instruments', kind: 'system' } });
      return true;
    }
    const next = status === 'ISSUED' ? 'APPROVED' : status === 'SUSPENDED' ? 'SUSPENDED' : status === 'REVOKED' ? 'WITHDRAWN' : target.status;
    const row = (await c.query<ProgrammeRow>('UPDATE met_programmes SET approval_no = $2, instrument_id = $3, status = $4, status_reason = $5, approved_on = COALESCE($6, approved_on), expires_on = COALESCE($7, expires_on), updated_at = now() WHERE id = $1 RETURNING *',
      [target.id, number || target.approval_no, String(e.id), next, next === target.status ? target.status_reason : `${number} ${status.toLowerCase()} on the instrument register`, e.issueDate ? new Date(e.issueDate) : null, e.expiryDate ? new Date(e.expiryDate) : null])).rows[0];
    await audit.record(c, { action: 'MET_PROGRAMME_INSTRUMENT_MIRRORED', entity: 'MetInstitution', entityId: inst.id, entityLabel: `${inst.name} — ${row.title}`, before: programmeApi(target), after: programmeApi(row), actor: { id: 'instruments', name: 'Instruments', kind: 'system' } });
    await publishInstitution(c, env, inst, { event: next !== target.status ? EVENTS.seafarers.programmeChanged : undefined, data: { programmeId: row.id, programme: row.programme, title: row.title, status: row.status, approvalNo: row.approval_no }, cause });
    return true;
  }
  return false;
}

/** Master data owns a company's identity; the register keeps its copy of the name current. */
export async function refreshInstitutionIdentity(c: Queryable, company: { id?: unknown; code?: unknown; name?: unknown; nameAr?: unknown; address?: unknown; contactName?: unknown; contactEmail?: unknown; contactPhone?: unknown }): Promise<InstitutionRow | null> {
  if (!company.id) return null;
  const r = await c.query<InstitutionRow>(
    `UPDATE met_institutions SET name = COALESCE(NULLIF($2, ''), name), name_ar = COALESCE(NULLIF($3, ''), name_ar), address = COALESCE(NULLIF($4, ''), address), contact_name = COALESCE(NULLIF($5, ''), contact_name),
       contact_email = COALESCE(NULLIF($6, ''), contact_email), contact_phone = COALESCE(NULLIF($7, ''), contact_phone), updated_at = now()
     WHERE company_id = $1 AND (name IS DISTINCT FROM COALESCE(NULLIF($2, ''), name) OR name_ar IS DISTINCT FROM COALESCE(NULLIF($3, ''), name_ar) OR address IS DISTINCT FROM COALESCE(NULLIF($4, ''), address)) RETURNING *`,
    [String(company.id), String(company.name ?? ''), String(company.nameAr ?? ''), String(company.address ?? ''), String(company.contactName ?? ''), String(company.contactEmail ?? ''), String(company.contactPhone ?? '')]);
  return r.rows[0] ?? null;
}

/* -------------------------------------------------------------------- dashboard --- */

export function metDashboard(institutions: InstitutionApi[], programmeMaster: { code: string; label: string; labelAr: string | null; meta: Record<string, unknown> }[], now = new Date()) {
  const active = institutions.filter((i) => i.status !== 'CLOSED');
  const byStatus = (s: string) => active.filter((i) => i.accreditation.status === s).length;
  const programmes = institutions.flatMap((i) => i.programmes.map((p) => ({ ...p, institution: i.name, institutionId: i.id })));
  const approved = programmes.filter((p) => p.status === 'APPROVED');
  const byProgramme = programmeMaster.map((m) => {
    const ps = approved.filter((p) => p.programme === m.code);
    return { programme: m.code, title: m.label, titleAr: m.labelAr, regulation: String(m.meta.regulation ?? ''), simulator: m.meta.simulator === true, providers: ps.length, seatsPerYear: ps.reduce((t, p) => t + p.seatsPerYear, 0) };
  }).sort((a, b) => b.providers - a.providers || b.seatsPerYear - a.seatsPerYear);
  const byType = [...new Set(active.map((i) => i.institutionType))].map((t) => ({ institutionType: t, institutions: active.filter((i) => i.institutionType === t).length, accredited: active.filter((i) => i.institutionType === t && i.accredited).length }));
  const attention = active.filter((i) => !i.accredited || i.suspendedProgrammes || (i.accreditation.daysLeft != null && i.accreditation.daysLeft <= 90))
    .map((i) => ({ id: i.id, code: i.code, name: i.name, accreditationStatus: i.accreditation.status, daysLeft: i.accreditation.daysLeft, suspendedProgrammes: i.suspendedProgrammes, pendingProgrammes: i.pendingProgrammes, reason: !i.accredited ? i.accreditation.reason || 'No accreditation in force' : i.suspendedProgrammes ? `${i.suspendedProgrammes} programme(s) suspended` : `Accreditation ends in ${i.accreditation.daysLeft} days` }))
    .sort((a, b) => (a.daysLeft ?? -1) - (b.daysLeft ?? -1));
  return {
    kpis: {
      institutions: active.length, accredited: byStatus('CURRENT') + byStatus('DUE'), due: byStatus('DUE'), expired: byStatus('EXPIRED'), suspended: byStatus('SUSPENDED'), unaccredited: byStatus('NONE') + byStatus('WITHDRAWN'),
      programmes: programmes.length, approved: approved.length, pending: programmes.filter((p) => p.status === 'PENDING').length, suspendedProgrammes: programmes.filter((p) => p.status === 'SUSPENDED').length,
      seatsPerYear: approved.reduce((t, p) => t + p.seatsPerYear, 0), instructors: active.reduce((t, i) => t + i.instructors, 0), simulatorCentres: active.filter((i) => i.simulators.length).length,
      programmesOffered: byProgramme.filter((p) => p.providers > 0).length, programmesInMaster: programmeMaster.length,
    },
    byType, byProgramme, attention: attention.slice(0, 10), generatedAt: now.toISOString(),
  };
}
