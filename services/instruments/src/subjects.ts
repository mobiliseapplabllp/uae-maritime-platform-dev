import type { PoolClient } from 'pg';
import { EVENTS, type EventEnvelope, type SubjectKind } from '@maritime/contracts';
import type { Queryable } from '@maritime/service-kit';
import { certStatus } from '@maritime/world';

/* Subject resolution and issue-time dependency checks. The licensing lifecycle is identical whoever the instrument is
 * issued against; what differs is how the subject is named and what must be true before it can be issued. The facts
 * those checks need (register status, certificates, docking) are projected locally from the read-model events of the
 * owning services, so issuing never makes a synchronous call into another domain. */
export type SubjectModel = 'Company' | 'Vessel' | 'Seafarer' | 'Berth';
export const MODEL_BY_KIND: Record<SubjectKind, SubjectModel> = { COMPANY: 'Company', VESSEL: 'Vessel', SEAFARER: 'Seafarer', PORT_FACILITY: 'Berth', MET_INSTITUTION: 'Company' };
export interface SubjectCert { type: string; expiryDate: string }
export interface SubjectFacts { name?: string; imo?: string; cdcNo?: string; code?: string; terminal?: string; certificates?: SubjectCert[]; nextDryDock?: string | null; real?: boolean; [k: string]: unknown }
export interface SubjectRecord { model: SubjectModel; id: string; label: string; status: string; facts: SubjectFacts }
/** Every check returns { check, passed, blocking, detail }. Advisory by default: the engine records them on the instrument and blocks issue only on a failed check marked blocking, so an officer can still issue against a documented exception. */
export interface Check { check: string; passed: boolean; blocking: boolean; detail: string }
type Row = Record<string, any>;

export async function resolveSubject(c: Queryable, kind: SubjectKind, id: string | null | undefined): Promise<SubjectRecord | null> {
  if (!id) return null;
  const r = await c.query<SubjectRecord>('SELECT model, id, label, status, facts FROM subjects WHERE model = $1 AND id = $2', [MODEL_BY_KIND[kind] ?? 'Company', String(id)]);
  return r.rows[0] ?? null;
}
/** Human label for a subject, used as the denormalised entityName. */
export function labelFor(kind: SubjectKind, s: SubjectRecord | null): string {
  if (!s) return '';
  const f = s.facts ?? {}; const name = f.name ?? s.label ?? '';
  if (kind === 'VESSEL') return `${name}${f.imo ? ` (IMO ${f.imo})` : ''}`;
  if (kind === 'SEAFARER') return `${name}${f.cdcNo ? ` (CDC ${f.cdcNo})` : ''}`;
  if (kind === 'PORT_FACILITY') return `${name || f.code || ''}${f.code && name ? ` (${f.code})` : ''}`;
  return name;
}
const day = (d: string | Date) => new Date(d).toISOString().slice(0, 10);
const states = (certs: SubjectCert[] | undefined, now: Date) => (certs ?? []).map((c) => ({ type: c.type, state: certStatus(c.expiryDate, now) }));
function vesselChecks(s: SubjectRecord, now: Date): Check[] {
  const certs = states(s.facts.certificates, now); const expired = certs.filter((c) => c.state === 'EXPIRED'); const expiring = certs.filter((c) => c.state === 'EXPIRING');
  const dock = s.facts.nextDryDock ? new Date(s.facts.nextDryDock) : null; const dockLapsed = !!dock && dock.getTime() < now.getTime();
  return [
    { check: 'Vessel is on the active register', passed: s.status === 'ACTIVE', blocking: true, detail: s.status === 'ACTIVE' ? 'Active' : `Vessel status is ${s.status}` },
    { check: 'Statutory certificates in force', passed: expired.length === 0, blocking: true, detail: expired.length ? `${expired.length} expired: ${expired.map((c) => c.type).join(', ')}` : `${certs.length} certificates, none expired` },
    { check: 'No certificate expiring inside the window', passed: expiring.length === 0, blocking: false, detail: expiring.length ? `${expiring.length} expiring shortly: ${expiring.map((c) => c.type).join(', ')}` : 'None expiring' },
    { check: 'Class docking survey current', passed: !dockLapsed, blocking: false, detail: dockLapsed ? `Docking lapsed ${day(dock!)}` : dock ? `Next docking ${day(dock)}` : 'Not recorded' },
  ];
}
function seafarerChecks(s: SubjectRecord, now: Date): Check[] {
  const docs = states(s.facts.certificates, now); const expired = docs.filter((d) => d.state === 'EXPIRED'); const medical = docs.find((d) => /medical/i.test(d.type));
  return [
    { check: 'Seafarer documents in force', passed: expired.length === 0, blocking: true, detail: expired.length ? `${expired.length} expired: ${expired.map((d) => d.type).join(', ')}` : `${docs.length} documents, none expired` },
    { check: 'Medical fitness certificate valid', passed: !!medical && medical.state !== 'EXPIRED', blocking: true, detail: medical ? `Medical is ${medical.state.toLowerCase()}` : 'No medical fitness certificate on record' },
  ];
}
const companyChecks = (s: SubjectRecord): Check[] => [{ check: 'Company is on the directory and not blacklisted', passed: s.status !== 'BLACKLISTED' && s.status !== 'INACTIVE', blocking: true, detail: s.status === 'BLACKLISTED' ? 'Company is blacklisted' : s.status === 'INACTIVE' ? 'Company is inactive on the directory' : 'In good standing' }];
const facilityChecks = (s: SubjectRecord): Check[] => [{ check: 'Port facility is operational', passed: s.status === 'OPERATIONAL', blocking: false, detail: `Facility status is ${s.status}` }];
/** Run the dependency checks for a subject. Returns [] when nothing is linked. */
export function checksFor(kind: SubjectKind, s: SubjectRecord | null, now = new Date()): Check[] {
  if (!s) return [];
  if (kind === 'VESSEL') return vesselChecks(s, now);
  if (kind === 'SEAFARER') return seafarerChecks(s, now);
  if (kind === 'PORT_FACILITY') return facilityChecks(s);
  return companyChecks(s);
}
export const blockingFailures = (checks: Check[]) => checks.filter((c) => c.blocking && !c.passed);

/** Upsert merges facts so a certificate list projected earlier survives a later status-only update. */
export async function upsertSubject(c: Queryable, s: SubjectRecord) {
  await c.query('INSERT INTO subjects(model, id, label, status, facts) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (model, id) DO UPDATE SET label = EXCLUDED.label, status = EXCLUDED.status, facts = subjects.facts || EXCLUDED.facts, updated_at = now()', [s.model, String(s.id), s.label ?? '', s.status ?? '', JSON.stringify(s.facts ?? {})]);
}
const certsOf = (list: Row[] | undefined): SubjectCert[] => (list ?? []).map((x) => ({ type: x.certType ?? x.type, expiryDate: x.expiryDate })).filter((x) => x.type && x.expiryDate);
const DELETE_MODEL: Record<string, SubjectModel> = { vessel: 'Vessel', seafarer: 'Seafarer', company: 'Company', berth: 'Berth' };
/** Applies a read-model or master-data event to the subject projection. Returns whether the event was relevant. */
export async function projectSubjectEvent(c: PoolClient, event: EventEnvelope): Promise<boolean> {
  const d = (event.data ?? {}) as Row;
  if (event.type === EVENTS.readModel.upserted) {
    const e: Row = d.entity ?? {}; if (!e.id && d.kind !== 'vesselCertificate') return false;
    switch (d.kind) {
      case 'vessel': await upsertSubject(c, { model: 'Vessel', id: e.id, label: e.name ?? '', status: e.status ?? 'ACTIVE', facts: { name: e.name, imo: e.imo, nextDryDock: e.nextDryDock ?? null, real: !!e.real, ...(Array.isArray(e.certificates) ? { certificates: certsOf(e.certificates) } : {}) } }); return true;
      case 'vesselCertificate': {
        if (!e.vesselId || !e.certType) return false;
        const cur = await c.query<SubjectRecord>('SELECT model, id, label, status, facts FROM subjects WHERE model = $1 AND id = $2 FOR UPDATE', ['Vessel', String(e.vesselId)]);
        const facts: SubjectFacts = cur.rows[0]?.facts ?? { name: e.vesselName };
        const certificates = (facts.certificates ?? []).filter((x) => x.type !== e.certType); if (e.expiryDate) certificates.push({ type: e.certType, expiryDate: e.expiryDate });
        await upsertSubject(c, { model: 'Vessel', id: e.vesselId, label: cur.rows[0]?.label ?? e.vesselName ?? '', status: cur.rows[0]?.status ?? 'ACTIVE', facts: { ...facts, certificates } }); return true;
      }
      case 'seafarer': await upsertSubject(c, { model: 'Seafarer', id: e.id, label: e.name ?? '', status: e.status ?? 'ACTIVE', facts: { name: e.name, cdcNo: e.cdcNo, ...(Array.isArray(e.certificates) ? { certificates: certsOf(e.certificates) } : {}) } }); return true;
      case 'company': await upsertSubject(c, { model: 'Company', id: e.id, label: e.name ?? '', status: e.status ?? 'ACTIVE', facts: { name: e.name, code: e.code } }); return true;
      case 'berth': await upsertSubject(c, { model: 'Berth', id: e.id, label: e.name ?? e.code ?? '', status: e.status ?? 'OPERATIONAL', facts: { name: e.name, code: e.code, terminal: e.terminal } }); return true;
      default: return false;
    }
  }
  if (event.type === EVENTS.readModel.deleted && DELETE_MODEL[d.kind] && d.id) { await c.query('DELETE FROM subjects WHERE model = $1 AND id = $2', [DELETE_MODEL[d.kind], String(d.id)]); return true; }
  if (event.type === EVENTS.mdm.companyUpserted && d.company?.id) { const co = d.company; await upsertSubject(c, { model: 'Company', id: co.id, label: co.name ?? '', status: co.status ?? 'ACTIVE', facts: { name: co.name, code: co.code } }); return true; }
  if (event.type === EVENTS.mdm.vesselUpserted && d.vesselId) { await upsertSubject(c, { model: 'Vessel', id: d.vesselId, label: d.name ?? '', status: d.status ?? 'ACTIVE', facts: { name: d.name, imo: d.imo } }); return true; }
  return false;
}
