import { type TenancyScope, EVENTS, getJurisdiction, makeEvent, type Actor, type EventEnvelope } from '@maritime/contracts';
import { scopeWhere, enqueue, eventFromContext, nextNumber, type Queryable } from '@maritime/service-kit';
import { REGISTRATION_SCOPE } from './scope';
import type { Env } from './env';
import { iso, type Row, type VesselRow } from './vessels';
import { portName, shareLedger, requiredEvidence, type Check } from './registry';

/* One file with the registrar — the row, what the screens read off it, and the events it publishes.
 * The register itself (a ship's registry_* columns) is written only by a grant; see registrations.controller. */

export interface RegistrationRow {
  id: string; application_no: string; kind: string; vessel_id: string | null; vessel_name: string; imo: string; port_of_registry: string;
  applicant: Row; owners: Row[]; tonnage: Row; previous_flag: string; previous_registry: string; previous_official_number: string;
  evidence: Row[]; encumbrances: Row[]; carving_note: Row | null; amendment: Row | null; deletion: Row | null;
  status: string; checks: Check[]; assigned_to_id: string | null; assigned_to: string; official_number: string; certificate_no: string;
  granted_on: Date | null; granted_by: string; certificate_expires_on: Date | null; fee: Row; decision: Row | null;
  submitted_at: Date | null; due_at: Date | null; closed_at: Date | null; history: Row[]; created_at: Date; updated_at: Date;
}

export const CLOSED_STATUSES = ['GRANTED', 'REJECTED', 'WITHDRAWN'];
export const OPEN_STATUSES = ['SUBMITTED', 'UNDER_SCRUTINY', 'CARVING_NOTE_ISSUED', 'SURVEY_COMPLETE', 'APPROVED'];

export const slaBreached = (r: RegistrationRow, now = new Date()) => !!(r.due_at && !r.closed_at && new Date(r.due_at) < now);

/** The file as the register list and the file screen read it. */
export function registrationApi(r: RegistrationRow, profile: string, now = new Date()) {
  return {
    id: r.id, applicationNo: r.application_no, kind: r.kind, vesselId: r.vessel_id, vesselName: r.vessel_name, imo: r.imo,
    portOfRegistry: r.port_of_registry, portOfRegistryName: portName(r.port_of_registry, profile),
    applicant: r.applicant ?? {}, owners: r.owners ?? [], tonnage: r.tonnage ?? {},
    previousFlag: r.previous_flag, previousRegistry: r.previous_registry, previousOfficialNumber: r.previous_official_number,
    evidence: r.evidence ?? [], encumbrances: r.encumbrances ?? [], carvingNote: r.carving_note, amendment: r.amendment, deletion: r.deletion,
    status: r.status, checks: r.checks ?? [], assignedToId: r.assigned_to_id, assignedTo: r.assigned_to,
    officialNumber: r.official_number, certificateNo: r.certificate_no, grantedOn: iso(r.granted_on), grantedBy: r.granted_by,
    certificateExpiresOn: iso(r.certificate_expires_on), fee: r.fee ?? {}, decision: r.decision,
    submittedAt: iso(r.submitted_at), dueAt: iso(r.due_at), closedAt: iso(r.closed_at), history: r.history ?? [],
    slaBreached: slaBreached(r, now), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
    /** The read model keys registrations on `number`; the register calls the same thing an application number. */
    number: r.application_no,
  };
}
export type RegistrationApi = ReturnType<typeof registrationApi>;

/** The detail record: the same file plus the resolved ship, the evidence this journey needs and the share ledger. */
export function registrationDetail(r: RegistrationRow, vessel: Row | null, profile: string, now = new Date()) {
  return { ...registrationApi(r, profile, now), vessel, requiredEvidence: requiredEvidence(registrationApi(r, profile, now), profile), shareLedger: shareLedger(r.owners ?? [], profile) };
}

/* The choke point for one application, so the tenancy filter is here and not in the handlers. */
export async function findRegistration(c: Queryable, ref: string, scope: TenancyScope): Promise<RegistrationRow | null> {
  const where = ['(id::text = $1 OR application_no = $1)']; const args: unknown[] = [ref];
  scopeWhere(scope, where, args, REGISTRATION_SCOPE);
  const r = await c.query<RegistrationRow>(`SELECT * FROM registrations WHERE ${where.join(' AND ')}`, args);
  return r.rows[0] ?? null;
}
export async function lockRegistration(c: Queryable, ref: string, scope: TenancyScope): Promise<RegistrationRow | null> {
  const where = ['(id::text = $1 OR application_no = $1)']; const args: unknown[] = [ref];
  scopeWhere(scope, where, args, REGISTRATION_SCOPE);
  const r = await c.query<RegistrationRow>(`SELECT * FROM registrations WHERE ${where.join(' AND ')} FOR UPDATE`, args);
  return r.rows[0] ?? null;
}

const COLS: Record<string, string> = {
  vesselName: 'vessel_name', portOfRegistry: 'port_of_registry', applicant: 'applicant', owners: 'owners', tonnage: 'tonnage',
  previousFlag: 'previous_flag', previousRegistry: 'previous_registry', previousOfficialNumber: 'previous_official_number',
  evidence: 'evidence', encumbrances: 'encumbrances', carvingNote: 'carving_note', amendment: 'amendment', deletion: 'deletion',
  status: 'status', checks: 'checks', assignedToId: 'assigned_to_id', assignedTo: 'assigned_to', officialNumber: 'official_number',
  certificateNo: 'certificate_no', grantedOn: 'granted_on', grantedBy: 'granted_by', certificateExpiresOn: 'certificate_expires_on',
  fee: 'fee', decision: 'decision', submittedAt: 'submitted_at', dueAt: 'due_at', closedAt: 'closed_at', history: 'history',
};
export type Patch = Record<string, unknown>;
export async function updateRegistration(c: Queryable, id: string, patch: Patch): Promise<RegistrationRow> {
  const keys = Object.keys(patch).filter((k) => COLS[k] && patch[k] !== undefined);
  if (!keys.length) { const r = await c.query<RegistrationRow>('SELECT * FROM registrations WHERE id = $1', [id]); return r.rows[0]; }
  const vals = keys.map((k) => { const v = patch[k]; return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v; });
  const r = await c.query<RegistrationRow>(`UPDATE registrations SET ${keys.map((k, i) => `${COLS[k]} = $${i + 2}`).concat('updated_at = now()').join(', ')} WHERE id = $1 RETURNING *`, [id, ...vals]);
  return r.rows[0];
}

/** Applications run in one chronological series per calendar year. */
export const nextApplicationNo = (c: Queryable, env: Env, now = new Date()) => nextNumber(c, `${env.REG_PREFIX}-${now.getUTCFullYear()}`, `${env.REG_PREFIX}-${now.getUTCFullYear()}-`, 5);

/* Official numbers are allocated in one unbroken series across the register, not per port: the number
 * identifies the ship for the life of the entry and must never be reused, so it is taken from the highest
 * ever allocated rather than from a count of live entries. */
export async function nextOfficialNumber(c: Queryable, profile: string): Promise<string> {
  const base = getJurisdiction(profile).registry.officialNumberBase;
  const r = await c.query<{ n: string | null }>(`SELECT max(official_number::bigint)::text AS n FROM registrations WHERE official_number ~ '^[0-9]+$'`);
  const highest = r.rows[0]?.n ? Number(r.rows[0].n) + 1 : base;
  return String(Math.max(highest, base));
}

/** Every file write publishes the API-shaped snapshot first, then the business event. */
export async function publishRegistration(c: Queryable, env: Env, r: RegistrationRow, opts: { event?: string; data?: Row; cause?: EventEnvelope; actor?: Actor } = {}) {
  const entity = registrationApi(r, env.JURISDICTION);
  const mk = <T,>(type: string, data: T) => (opts.cause
    ? makeEvent({ type, source: env.SERVICE_NAME, data, subject: r.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor })
    : eventFromContext(env.SERVICE_NAME, type, data, { subject: r.id, actor: opts.actor }));
  await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'registration', entity }));
  if (opts.event) await enqueue(c, mk(opts.event, { registrationId: r.id, applicationNo: r.application_no, kind: r.kind, vesselId: r.vessel_id, vesselName: r.vessel_name, imo: r.imo, status: r.status, registration: entity, ...(opts.data ?? {}) }));
  return entity;
}
export async function publishRegistrationDeleted(c: Queryable, env: Env, r: RegistrationRow) {
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.deleted, { kind: 'registration', id: r.id }, { subject: r.id }));
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.ships.registrationDeleted, { registrationId: r.id, applicationNo: r.application_no, vesselId: r.vessel_id }, { subject: r.id }));
}

/* The transcript of registry — the extract a bank, a purchaser or a foreign administration asks for.
 * Assembled from the granted applications rather than stored, so it cannot drift from the register. */
export function transcriptOf(vessel: VesselRow, rows: RegistrationRow[], profile: string) {
  const j = getJurisdiction(profile);
  const granted = rows.filter((r) => r.status === 'GRANTED').sort((a, b) => (a.granted_on?.getTime() ?? 0) - (b.granted_on?.getTime() ?? 0));
  const current = [...granted].reverse().find((r) => r.kind === 'PERMANENT' || r.kind === 'PROVISIONAL') ?? null;
  const closure = granted.find((r) => r.kind === 'DELETION') ?? null;
  const ownershipAmendment = [...granted].reverse().find((r) => r.kind === 'AMENDMENT' && (r.amendment?.types ?? []).includes('OWNERSHIP') && (r.owners ?? []).length);
  const owners = ownershipAmendment?.owners ?? current?.owners ?? [];
  return {
    vessel: { id: vessel.id, name: vessel.name, imo: vessel.imo, flag: vessel.flag, type: vessel.type, grt: vessel.grt, built: vessel.built },
    registry: {
      state: vessel.registry_state, officialNumber: vessel.official_number, portOfRegistry: vessel.registry_port, certificateNo: vessel.certificate_no,
      registeredOn: iso(vessel.registered_on), certificateExpiresOn: iso(vessel.certificate_expires_on), closedOn: iso(vessel.closed_on), closureReason: vessel.closure_reason,
    },
    registrar: j.registry.registrar,
    portOfRegistry: vessel.registry_port ? { code: vessel.registry_port, name: portName(vessel.registry_port, profile) } : null,
    firstRegistered: iso(current?.granted_on ?? null), tonnage: current?.tonnage ?? null,
    owners, shareLedger: shareLedger(owners, profile),
    encumbrances: granted.flatMap((r) => r.encumbrances ?? []).filter((e: Row) => !e.dischargedOn),
    closure: closure ? { reason: closure.deletion?.reason, newFlag: closure.deletion?.newFlag, certificateNo: closure.deletion?.certificateNo, effectiveOn: closure.deletion?.effectiveOn ?? null } : null,
    entries: granted.map((r) => ({ applicationNo: r.application_no, kind: r.kind, certificateNo: r.certificate_no, grantedOn: iso(r.granted_on), grantedBy: r.granted_by, note: r.kind === 'AMENDMENT' ? (r.amendment?.types ?? []).join(', ') : '' })),
  };
}

/** The registry's own landing analytics: the queue, its SLA and where the fleet stands on the register. */
export function registryDashboard(rows: RegistrationRow[], fleet: { registry_state: string; certificate_expires_on: Date | null }[], profile: string, now = new Date()) {
  const D = 86_400_000;
  const open = rows.filter((r) => !CLOSED_STATUSES.includes(r.status) && r.status !== 'DRAFT');
  const breached = open.filter((r) => r.due_at && new Date(r.due_at) < now);
  const closed = rows.filter((r) => r.closed_at && r.submitted_at);
  const avgDays = closed.length ? Math.round((closed.reduce((s, r) => s + (new Date(r.closed_at!).getTime() - new Date(r.submitted_at!).getTime()), 0) / closed.length / D) * 10) / 10 : 0;
  const byState = new Map<string, number>();
  for (const v of fleet) byState.set(v.registry_state, (byState.get(v.registry_state) ?? 0) + 1);
  const byKind = new Map<string, number>(); const byPort = new Map<string, number>();
  for (const r of rows) byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
  for (const r of rows.filter((x) => x.status === 'GRANTED')) byPort.set(r.port_of_registry, (byPort.get(r.port_of_registry) ?? 0) + 1);
  // a provisional certificate that runs out leaves a ship with no valid certificate of registry at all, so it is the one expiry worth surfacing
  const provisionalExpiring = fleet.filter((v) => v.registry_state === 'PROVISIONAL' && v.certificate_expires_on && new Date(v.certificate_expires_on).getTime() < now.getTime() + 60 * D).length;
  return {
    total: rows.length, open: open.length, breached: breached.length,
    granted: rows.filter((r) => r.status === 'GRANTED').length, rejected: rows.filter((r) => r.status === 'REJECTED').length,
    avgDecisionDays: avgDays, slaCompliance: open.length ? Math.round(((open.length - breached.length) / open.length) * 100) : 100,
    registered: byState.get('REGISTERED') ?? 0, provisional: byState.get('PROVISIONAL') ?? 0, closedEntries: byState.get('CLOSED') ?? 0, unregistered: byState.get('UNREGISTERED') ?? 0,
    provisionalExpiring,
    byKind: [...byKind.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count),
    byPort: [...byPort.entries()].sort((a, b) => b[1] - a[1]).map(([code, count]) => ({ code, name: portName(code, profile), count })),
  };
}
