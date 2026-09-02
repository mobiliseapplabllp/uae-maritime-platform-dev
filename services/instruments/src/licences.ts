import { EVENTS, LICENSE_TRANSITIONS, SUBJECT_PERMS, getJurisdiction, numberPrefixOf, makeEvent, type Actor, type EventEnvelope, type InstrumentClass, type LicenseStatus, type SubjectKind } from '@maritime/contracts';
import { badRequest, conflict, enqueue, eventFromContext, nextNumber, type Queryable } from '@maritime/service-kit';
import { addMonths, certStatus, stableId, type WorldEndorsement } from '@maritime/world';
import type { Env } from './env';
import type { Signature, SigningService, Verification } from './signing';
import { forceState, isStatutory, nonExpiring, termMonthsOf, CERT_LABEL, CONVENTION, typeLabel, classLabel, type ForceState } from './statutory';
import { checksFor, blockingFailures, resolveSubject, MODEL_BY_KIND, type Check } from './subjects';

/* The register row and everything the engine does to it that both the API and the event consumer need: numbering,
 * issue (checks, term, signature, mirror), transitions and the read-model snapshot every write publishes. */
export interface Row {
  id: string; license_no: string; subject_kind: string; subject_id: string | null; subject_model: string | null; instrument_class: string; entity_name: string; entity_type: string; status: string;
  issue_checks: Check[]; contact_person: string; phone: string; email: string; address: string; tax_id: string; applied_date: Date; issue_date: Date | null; expiry_date: Date | null; conditions: string;
  performance_rating: string; audits: LicenceAudit[]; endorsements: WorldEndorsement[]; signature: Signature | null; history: HistoryEntry[]; issuer: string; request_id: string | null; request_no: string | null; reminded_at: Date | null; created_at: Date; updated_at: Date;
}
export interface HistoryEntry { from: string; to: string; at: string; by: string; note: string }
export interface LicenceAudit { date: string; auditorId?: string | null; auditor: string; result: 'SATISFACTORY' | 'OBSERVATIONS' | 'NON_CONFORMITY'; remarks: string }
const iso = (d: Date | string | null | undefined): string | null => (d ? new Date(d).toISOString() : null);
export const issuerFor = (profile: string) => getJurisdiction(profile).authority.split(' (')[0];

export const toApi = (r: Row) => ({
  id: r.id, licenseNo: r.license_no, subjectKind: r.subject_kind as SubjectKind, subjectId: r.subject_id, subjectRef: r.subject_id, subjectModel: r.subject_model, instrumentClass: r.instrument_class as InstrumentClass, classLabel: classLabel(r.instrument_class),
  entityName: r.entity_name, entityType: r.entity_type, typeLabel: typeLabel(r.entity_type), typeLabelAr: typeLabel(r.entity_type, true), status: r.status as LicenseStatus, issueChecks: r.issue_checks ?? [],
  contactPerson: r.contact_person, phone: r.phone, email: r.email, address: r.address, taxId: r.tax_id, appliedDate: iso(r.applied_date)!, issueDate: iso(r.issue_date), expiryDate: iso(r.expiry_date), conditions: r.conditions,
  performanceRating: Number(r.performance_rating), audits: r.audits ?? [], endorsements: r.endorsements ?? [], signature: r.signature ?? null, history: r.history ?? [], issuer: r.issuer, requestId: r.request_id, requestNo: r.request_no, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
});
export type LicenceApi = ReturnType<typeof toApi>;
const statutoryDoc = (r: Row) => ({ status: r.status, entityType: r.entity_type, issueDate: iso(r.issue_date), expiryDate: iso(r.expiry_date), endorsements: r.endorsements ?? [] });
export const forceOf = (r: Row, now = new Date()): ForceState => forceState(statutoryDoc(r), now);
/** One instrument with everything a holder or an inspector needs: whether it is in force, where it stands against its survey schedule, and whether its signature still matches the record. */
export async function detail(r: Row, signing: SigningService, client?: Queryable, now = new Date()) {
  const api = toApi(r); const force = forceOf(r, now);
  const verification: Verification | null = api.signature?.value ? await signing.verify({ ...api, signature: api.signature }, client) : null;
  return { ...api, statutory: isStatutory(r.entity_type), nonExpiring: nonExpiring(r.entity_type), convention: CONVENTION[r.entity_type] ?? '', certificateName: CERT_LABEL[r.entity_type] ?? '', inForce: force.inForce, forceReason: force.reason, endorsementState: force.endorsements, signature: verification ? { ...api.signature, verification } : null };
}
/** The API-shaped snapshot reporting and search project; the signature value itself stays in the register. */
export function readModelOf(r: Row, now = new Date()) {
  const api = toApi(r); const force = forceOf(r, now); const { signature, ...rest } = api;
  return { ...rest, number: api.licenseNo, statutory: isStatutory(r.entity_type), inForce: force.inForce, forceReason: force.reason, signed: !!signature?.value, auditsCount: api.audits.length, endorsementsCount: api.endorsements.length };
}
/** A statutory ship certificate is copied onto the ship's own certificate list, keyed on the printed certificate name so a reissue replaces the entry. */
export function mirrorOf(r: Row, now = new Date()) {
  if (r.subject_kind !== 'VESSEL' || !r.subject_id || !isStatutory(r.entity_type) || r.status !== 'ISSUED' || !r.issue_date || !r.expiry_date) return null;
  const label = CERT_LABEL[r.entity_type]; if (!label) return null;
  const force = forceOf(r, now);
  return { id: stableId('vcert', `${r.subject_id}:${label}`), vesselId: r.subject_id, vesselName: r.entity_name.replace(/\s*\(IMO \d+\)\s*$/, ''), certType: label, number: r.license_no, issuer: r.issuer, issueDate: iso(r.issue_date), expiryDate: iso(r.expiry_date),
    remarks: nonExpiring(r.entity_type) ? `Issued under ${CONVENTION[r.entity_type]}. Not renewed on a term — reissued on any change to the ship.` : `Issued on the register under ${CONVENTION[r.entity_type] ?? 'the applicable convention'}`,
    instrumentId: r.id, onRegister: true, inForce: force.inForce, forceReason: force.reason, signed: !!r.signature?.value, state: certStatus(r.expiry_date, now) };
}

export const permBaseFor = (kind: string) => SUBJECT_PERMS[kind as SubjectKind] ?? 'facilities';
export async function nextLicenceNumber(c: Queryable, type: string, now = new Date()) { const prefix = `${numberPrefixOf(type)}-${now.getUTCFullYear()}`; return nextNumber(c, prefix, `${prefix}-`); }
export async function findLicence(c: Queryable, idOrNo: string): Promise<Row | null> {
  const r = await c.query<Row>('SELECT * FROM licences WHERE id::text = $1 OR license_no = $1', [idOrNo]); return r.rows[0] ?? null;
}
export async function lockLicence(c: Queryable, idOrNo: string): Promise<Row | null> {
  const r = await c.query<Row>('SELECT * FROM licences WHERE id::text = $1 OR license_no = $1 FOR UPDATE', [idOrNo]); return r.rows[0] ?? null;
}
export interface NewLicence {
  licenseNo: string; subjectKind: SubjectKind; subjectId: string | null; subjectModel: string | null; instrumentClass: InstrumentClass; entityName: string; entityType: string; status: LicenseStatus;
  contactPerson?: string; phone?: string; email?: string; address?: string; taxId?: string; conditions?: string; appliedDate?: Date | string; issuer: string; requestId?: string | null; requestNo?: string | null; history: HistoryEntry[]; issueChecks?: Check[];
}
export async function insertLicence(c: Queryable, n: NewLicence): Promise<Row> {
  const r = await c.query<Row>('INSERT INTO licences(license_no, subject_kind, subject_id, subject_model, instrument_class, entity_name, entity_type, status, contact_person, phone, email, address, tax_id, conditions, applied_date, issuer, request_id, request_no, history, issue_checks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *',
    [n.licenseNo, n.subjectKind, n.subjectId, n.subjectModel, n.instrumentClass, n.entityName, n.entityType, n.status, n.contactPerson ?? '', n.phone ?? '', n.email ?? '', n.address ?? '', n.taxId ?? '', n.conditions ?? '', n.appliedDate ? new Date(n.appliedDate) : new Date(), n.issuer, n.requestId ?? null, n.requestNo ?? null, JSON.stringify(n.history), JSON.stringify(n.issueChecks ?? [])]);
  return r.rows[0];
}
const COLS: Record<string, string> = { status: 'status', entityName: 'entity_name', entityType: 'entity_type', instrumentClass: 'instrument_class', issueChecks: 'issue_checks', contactPerson: 'contact_person', phone: 'phone', email: 'email', address: 'address', taxId: 'tax_id', issueDate: 'issue_date', expiryDate: 'expiry_date', conditions: 'conditions', performanceRating: 'performance_rating', audits: 'audits', endorsements: 'endorsements', signature: 'signature', history: 'history', remindedAt: 'reminded_at' };
export type Patch = Partial<{ status: string; entityName: string; entityType: string; instrumentClass: string; issueChecks: Check[]; contactPerson: string; phone: string; email: string; address: string; taxId: string; issueDate: Date | null; expiryDate: Date | null; conditions: string; performanceRating: number; audits: LicenceAudit[]; endorsements: WorldEndorsement[]; signature: Signature | null; history: HistoryEntry[]; remindedAt: Date | null }>;
export async function updateLicence(c: Queryable, id: string, patch: Patch): Promise<Row> {
  const keys = Object.keys(patch).filter((k) => COLS[k] && (patch as Record<string, unknown>)[k] !== undefined);
  const vals = keys.map((k) => { const v = (patch as Record<string, unknown>)[k]; return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v; });
  const r = await c.query<Row>(`UPDATE licences SET ${keys.map((k, i) => `${COLS[k]} = $${i + 2}`).concat('updated_at = now()').join(', ')} WHERE id = $1 RETURNING *`, [id, ...vals]);
  return r.rows[0];
}
/** Every write ends by publishing the snapshot (and the ship's mirrored certificate for a statutory instrument), so reporting, search and the fleet screens never lag the register. */
export async function publishState(c: Queryable, env: Env, r: Row, opts: { event?: string; data?: Record<string, unknown>; cause?: EventEnvelope; actor?: Actor } = {}) {
  const mk = <T,>(type: string, data: T) => opts.cause ? makeEvent({ type, source: env.SERVICE_NAME, data, subject: r.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor }) : eventFromContext(env.SERVICE_NAME, type, data, { subject: r.id, actor: opts.actor });
  if (opts.event) await enqueue(c, mk(opts.event, { instrumentId: r.id, number: r.license_no, licenseNo: r.license_no, entityName: r.entity_name, entityType: r.entity_type, typeLabel: typeLabel(r.entity_type), instrumentClass: r.instrument_class, subjectKind: r.subject_kind, subjectId: r.subject_id, status: r.status, issueDate: iso(r.issue_date), expiryDate: iso(r.expiry_date), requestId: r.request_id, requestNo: r.request_no, ...(opts.data ?? {}) }));
  await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'instrument', entity: readModelOf(r) }));
  const mirror = mirrorOf(r); if (mirror) await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'vesselCertificate', entity: mirror }));
}

export interface IssueOptions { now?: Date; by: string; note?: string; override?: boolean; expiryDate?: string | Date | null; validityMonths?: number | null; authority: 'OFFICER' | 'APPLICATION'; applicationRef?: string }
/* Issue, wherever the issue came from — an officer moving a register entry to ISSUED or the service engine granting an application — produces the same artefact: dependency checks recorded on the instrument, a term, a signature over the register facts, and a statutory ship certificate mirrored onto the ship. Reinstatement after suspension keeps the original term and signature. */
export async function issue(c: Queryable, deps: { env: Env; signing: SigningService }, row: Row, o: IssueOptions): Promise<{ row: Row; checks: Check[] }> {
  const now = o.now ?? new Date(); const from = row.status; const reinstate = from === 'SUSPENDED';
  if (!(LICENSE_TRANSITIONS[from as LicenseStatus] ?? []).includes('ISSUED')) throw conflict(`A ${from.replace(/_/g, ' ').toLowerCase()} ${classLabel(row.instrument_class).toLowerCase()} cannot move to issued`);
  const patch: Patch = { status: 'ISSUED' }; let checks: Check[] = row.issue_checks ?? [];
  if (!reinstate) {
    checks = checksFor(row.subject_kind as SubjectKind, await resolveSubject(c, row.subject_kind as SubjectKind, row.subject_id), now);
    const blocked = blockingFailures(checks);
    if (blocked.length) {
      if (o.authority === 'OFFICER' && !o.override) throw conflict(`Cannot issue — ${blocked.map((x) => x.detail).join('; ')}`);
      if (o.authority === 'OFFICER' && !o.note) throw badRequest('An override requires a written reason');
      checks = [...checks, o.authority === 'OFFICER' ? { check: 'Officer override', passed: true, blocking: false, detail: o.note! } : { check: 'Approved application', passed: true, blocking: false, detail: `Issued under ${o.applicationRef ?? 'an approved application'} notwithstanding: ${blocked.map((x) => x.detail).join('; ')}` }];
    }
    const months = o.validityMonths ?? termMonthsOf(row.entity_type);
    patch.issueChecks = checks; patch.issueDate = now; patch.expiryDate = o.expiryDate ? new Date(o.expiryDate) : addMonths(now, months);
    if (patch.expiryDate.getTime() <= now.getTime()) throw badRequest('The expiry date must fall after the issue date');
    patch.signature = deps.signing.sign({ licenseNo: row.license_no, entityType: row.entity_type, subjectKind: row.subject_kind, subjectId: row.subject_id, entityName: row.entity_name, issueDate: patch.issueDate, expiryDate: patch.expiryDate });
  }
  patch.history = [...(row.history ?? []), { from, to: 'ISSUED', at: now.toISOString(), by: o.by, note: o.note ?? (reinstate ? 'Reinstated' : '') }];
  const updated = await updateLicence(c, row.id, patch);
  return { row: updated, checks };
}
