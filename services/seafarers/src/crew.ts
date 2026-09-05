import { EVENTS, makeEvent, type Actor, type EventEnvelope, type TenancyScope } from '@maritime/contracts';
import { certStatus } from '@maritime/world';
import { visibleTo, recordScope, enqueue, eventFromContext, type Queryable } from '@maritime/service-kit';
import { SEAFARER_SCOPE } from './scope';
import type { Env } from './env';
import { certRules, certVocab, type CertRule } from './vocab';

/* The seafarer register: the record, the documents that gate a sign-on, and the service book those tours
 * add up to. Documents issued by the instruments service are mirrored here read-only — the instrument
 * register, not the crew desk's copy, is the authority on what this administration issued. */

export type Row = Record<string, any>;
export const D = 86_400_000;
export const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());
export const dateOnly = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString().slice(0, 10));
export const SEAFARER_STATUS = ['ACTIVE', 'SHORE_LEAVE', 'SIGNED_OFF', 'SUSPENDED'] as const;
/** Whole days between sign-on and sign-off, never negative. */
export const seaDays = (from: Date | string, to: Date | string) => Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / D));
export const daysLeft = (expiry: Date | string, now = new Date()) => Math.floor((new Date(expiry).getTime() - now.getTime()) / D);

export interface SeafarerRow {
  id: string; cdc_no: string; seafarer_id: string; seafarer_id_label: string; national_id: string; national_id_label: string;
  name: string; dob: Date | null; nationality: string; rank: string; rank_code: string; phone: string; email: string; status: string;
  current_vessel_id: string | null; current_vessel_name: string | null; signed_on_at: Date | null; remarks: string;
  /** The recruitment and placement service holding the engagement, and the tenancy key derived from it. */
  manning_agent_code: string; manning_agent_name: string; scope_company: string;
  /** The labour ministry's last word on the engagement, when it was asked. */
  employment_check: EmploymentCheck | null;
  created_at: Date; updated_at: Date;
}
export interface EmploymentCheck { checkedAt: string; checkedBy: string; mode: string; callId?: string; emiratesId: string; employed: boolean; establishment: string; establishmentLicence: string; occupation: string; validTo: string | null }
export interface CertRow {
  id: string; seafarer_id: string; cert_type: string; cert_code: string; grade: string; number: string; issuer: string; issue_date: Date | null; expiry_date: Date;
  remarks: string; instrument_id: string | null; on_register: boolean; in_force: boolean | null; force_reason: string; signed: boolean;
  endorsement: Row | null; created_at: Date; updated_at: Date;
}
export interface ServiceRow {
  id: string; seafarer_id: string; vessel_id: string | null; vessel_name: string; imo: string; rank: string; rank_code: string;
  from_at: Date; to_at: Date; verified: boolean; verified_by: string; verified_at: Date | null; remarks: string; created_at: Date;
}

/* What kind of document a row is, for the checks that care: the master's `kind` when the row carries a code
 * the master knows, and the words on the row when it does not — a document mirrored from another register
 * under a label the master has not learned yet is still a medical if it says so. */
export const certKindOf = (certType: string, certCode: string, rules: CertRule[] = []): string => {
  const rule = certCode ? rules.find((r) => r.code === certCode) : undefined;
  if (rule?.kind) return rule.kind;
  if (isMedical(certType)) return 'MEDICAL';
  if (isCompetency(certType)) return 'COMPETENCY';
  if (isBasicSafety(certType) || /proficiency|fire|first aid|survival|security|tanker/i.test(certType)) return 'PROFICIENCY';
  if (/discharge|record book/i.test(certType)) return 'RECORD';
  if (/identity|card|passport/i.test(certType)) return 'IDENTITY';
  if (/endorsement/i.test(certType)) return 'ENDORSEMENT';
  return '';
};
export const certApi = (c: CertRow, now = new Date(), windowDays?: number, rules: CertRule[] = []) => ({
  id: c.id, certType: c.cert_type, certCode: c.cert_code, kind: certKindOf(c.cert_type, c.cert_code, rules), grade: c.grade, number: c.number, issuer: c.issuer, issueDate: iso(c.issue_date), expiryDate: iso(c.expiry_date)!,
  remarks: c.remarks, status: certStatus(c.expiry_date, now, windowDays), instrumentId: c.instrument_id, onRegister: c.on_register,
  inForce: c.in_force, forceReason: c.force_reason, signed: c.signed, endorsement: c.endorsement,
  /** An instrument-issued document is the register's record of it; the crew desk may not edit or delete it here. */
  readOnly: !!c.instrument_id,
});
export type CertApi = ReturnType<typeof certApi>;
export const serviceApi = (s: ServiceRow) => ({
  id: s.id, vesselId: s.vessel_id, vesselName: s.vessel_name, imo: s.imo, rank: s.rank, rankCode: s.rank_code,
  from: iso(s.from_at)!, to: iso(s.to_at)!, days: seaDays(s.from_at, s.to_at),
  verified: s.verified, verifiedBy: s.verified_by, verifiedAt: iso(s.verified_at), remarks: s.remarks,
});
export type ServiceApi = ReturnType<typeof serviceApi>;

export interface SeafarerExtras { certificates?: CertApi[]; seaService?: ServiceApi[] }
/** The record as every screen and every read-model event sees it; the summaries are computed, never stored. */
export function seafarerApi(s: SeafarerRow, extra: SeafarerExtras = {}) {
  const certificates = extra.certificates ?? [];
  const seaService = extra.seaService ?? [];
  return {
    id: s.id, cdcNo: s.cdc_no, seafarerId: s.seafarer_id, seafarerIdNo: s.seafarer_id, seafarerIdLabel: s.seafarer_id_label,
    nationalId: s.national_id, nationalIdLabel: s.national_id_label, name: s.name, dob: dateOnly(s.dob), nationality: s.nationality, rank: s.rank, rankCode: s.rank_code,
    phone: s.phone, email: s.email, status: s.status, currentVesselId: s.current_vessel_id, currentVesselName: s.current_vessel_name,
    signedOnAt: iso(s.signed_on_at), remarks: s.remarks,
    manningAgentCode: s.manning_agent_code, manningAgentName: s.manning_agent_name,
    manningAgent: s.manning_agent_code ? { code: s.manning_agent_code, name: s.manning_agent_name } : null,
    employmentCheck: s.employment_check ?? null,
    certAlerts: certificates.filter((c) => c.status !== 'VALID').length,
    totalSeaDays: seaService.reduce((t, x) => t + x.days, 0),
    seaServiceDays: seaService.reduce((t, x) => t + x.days, 0),
    serviceRecords: seaService.length,
    certificates, seaService,
    createdAt: iso(s.created_at), updatedAt: iso(s.updated_at),
  };
}
export type SeafarerApi = ReturnType<typeof seafarerApi>;

/* Every handler that touches one seafarer comes through here, so the tenancy filter lives here rather than
 * in the fourteen that call it: a reader the register is closed to is answered "not found", the same answer
 * a seafarer who was never on it would get. */
export async function findSeafarer(c: Queryable, ref: string, scope: TenancyScope): Promise<SeafarerRow | null> {
  const byId = /^[0-9a-f-]{36}$/i.test(ref);
  const r = await c.query<SeafarerRow>(byId ? 'SELECT * FROM seafarers WHERE id = $1' : 'SELECT * FROM seafarers WHERE cdc_no = $1', [ref]);
  const row = r.rows[0];
  // The row decides now that it names an agent: a reader outside the placement is answered as though the
  // record were not there, which is the same answer a seafarer who was never on the register would get.
  return row && visibleTo(scope, row, SEAFARER_SCOPE) ? row : null;
}
export async function certsOf(c: Queryable, id: string, now = new Date(), windowDays?: number, rules?: CertRule[]): Promise<CertApi[]> {
  const r = await c.query<CertRow>('SELECT * FROM seafarer_certificates WHERE seafarer_id = $1 ORDER BY expiry_date', [id]);
  const rl = rules ?? certRules(await certVocab(c));
  return r.rows.map((x) => certApi(x, now, windowDays, rl));
}
export async function serviceOf(c: Queryable, id: string): Promise<ServiceApi[]> {
  const r = await c.query<ServiceRow>('SELECT * FROM sea_service WHERE seafarer_id = $1 ORDER BY from_at DESC', [id]);
  return r.rows.map(serviceApi);
}
export async function seafarerEntity(c: Queryable, env: Env, s: SeafarerRow, now = new Date()): Promise<SeafarerApi> {
  return seafarerApi(s, { certificates: await certsOf(c, s.id, now, env.CERT_EXPIRING_DAYS), seaService: await serviceOf(c, s.id) });
}

/** Every write publishes the API-shaped snapshot first, then the business event. */
export async function publishSeafarer(c: Queryable, env: Env, s: SeafarerRow, opts: { event?: string; data?: Row; cause?: EventEnvelope; actor?: Actor } = {}) {
  const entity = await seafarerEntity(c, env, s);
  const mk = <T,>(type: string, data: T) => (opts.cause
    ? makeEvent({ type, source: env.SERVICE_NAME, data, subject: s.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor })
    : eventFromContext(env.SERVICE_NAME, type, data, { subject: s.id, actor: opts.actor }));
  await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'seafarer', entity: { ...entity, scope: recordScope(s) } }));
  if (opts.event) await enqueue(c, mk(opts.event, { seafarerId: s.id, name: s.name, rank: s.rank, cdcNo: s.cdc_no, status: s.status, currentVesselId: s.current_vessel_id, seafarer: entity, ...(opts.data ?? {}) }));
  return entity;
}
export async function publishSeafarerDeleted(c: Queryable, env: Env, s: SeafarerRow) {
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.deleted, { kind: 'seafarer', id: s.id }, { subject: s.id }));
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.seafarers.deleted, { seafarerId: s.id, name: s.name, cdcNo: s.cdc_no }, { subject: s.id }));
}

/* ------------------------------------------------------------------ the sign-on gate --- */

export interface Gate { failures: string[] }
/* "Medical" alone is not enough: medical first aid is a training certificate, and a seafarer holding a
 * current first-aid ticket and a lapsed fitness certificate is not fit to sail. */
export const isMedical = (t: string) => /medical/i.test(t) && !/first\s*aid/i.test(t);
export const isCompetency = (t: string) => /competency/i.test(t);
export const isBasicSafety = (t: string) => /stcw|basic safety/i.test(t);
/** Whether a held document is the one a master row names — by code when the row has one, by the words otherwise. */
const holds = (c: Pick<CertApi, 'certType' | 'certCode'>, rule: CertRule) => (c.certCode ? c.certCode === rule.code : c.certType.trim().toLowerCase() === rule.label.trim().toLowerCase());

/* A tour is longer than a port call, so a document that expires next month is a document that expires at
 * sea. Which documents a sign-on needs is the seafarerCertType master's to say — every entry it marks
 * mandatory must be on file and outlast the margin — and the gate names each one by the master's label. A
 * certificate of competency is skipped when the module setting turns that check off. An officer may still
 * override the gate, and the override is recorded against their name. When the master is empty the gate
 * falls back to the three documents no administration would sail without, so a mirror that never received
 * its seed fails safe rather than open. */
export function documentGate(certs: Pick<CertApi, 'certType' | 'certCode' | 'expiryDate'>[], env: Env, now = new Date(), rules: CertRule[] = []): Gate {
  const failures: string[] = [];
  const required = rules.filter((r) => r.mandatory && (env.COC_VERIFY_ON_SIGN_ON || r.kind !== 'COMPETENCY'));
  const check = (label: string, match: (c: Pick<CertApi, 'certType' | 'certCode'>) => boolean, required: boolean) => {
    const held = certs.filter(match);
    if (!held.length) { if (required) failures.push(`${label}: not on file`); return; }
    const best = [...held].sort((a, b) => b.expiryDate.localeCompare(a.expiryDate))[0];
    const days = daysLeft(best.expiryDate, now);
    if (days < 0) failures.push(`${label}: expired ${-days} days ago`);
    else if (days < env.SIGN_ON_MARGIN_DAYS) failures.push(`${label}: expires in ${days} days (tour would outlast it)`);
  };
  if (required.length) { for (const rule of required) check(rule.label, (c) => holds(c, rule), true); return { failures }; }
  check('Medical fitness (ILO/MLC)', (c) => isMedical(c.certType), true);
  if (env.COC_VERIFY_ON_SIGN_ON) check('Certificate of Competency', (c) => isCompetency(c.certType), true);
  check('STCW Basic Safety', (c) => isBasicSafety(c.certType), false);
  return { failures };
}

/* ------------------------------------------------------------------- crew dashboard --- */

export interface DashboardInput { id: string; name: string; rank: string; status: string; currentVesselName: string | null; certExpiries: { certType: string; expiryDate: string; kind?: string }[]; days: number }
/** The crew module's landing analytics: the roll, the rank mix, the document-expiry funnel and who to chase. */
export function crewDashboard(rows: DashboardInput[], env: Env, now = new Date()) {
  const byRank = new Map<string, number>();
  const funnel = { expired: 0, d30: 0, d90: 0, valid: 0 };
  let onboard = 0; let medicalIssues = 0; let days = 0;
  const alertList: { id: string; name: string; rank: string; vessel: string; alerts: number }[] = [];
  for (const s of rows) {
    byRank.set(s.rank, (byRank.get(s.rank) ?? 0) + 1);
    if (s.currentVesselName) onboard += 1;
    days += s.days;
    let alerts = 0;
    for (const c of s.certExpiries) {
      const left = daysLeft(c.expiryDate, now);
      if (left < 0) { funnel.expired += 1; alerts += 1; }
      else if (left <= 30) { funnel.d30 += 1; alerts += 1; }
      else if (left <= 90) funnel.d90 += 1;
      else funnel.valid += 1;
      if ((c.kind ? c.kind === 'MEDICAL' : isMedical(c.certType)) && left <= env.MEDICAL_EXPIRING_DAYS) medicalIssues += 1;
    }
    if (alerts) alertList.push({ id: s.id, name: s.name, rank: s.rank, vessel: s.currentVesselName ?? 'Ashore', alerts });
  }
  alertList.sort((a, b) => b.alerts - a.alerts);
  return {
    kpis: {
      roll: rows.length, onboard, ashore: rows.length - onboard, medicalIssues,
      avgSeaDays: rows.length ? Math.round(days / rows.length) : 0, medicalWindow: env.MEDICAL_EXPIRING_DAYS,
    },
    byRank: [...byRank.entries()].map(([rank, count]) => ({ rank, count })).sort((a, b) => b.count - a.count),
    funnel, alertList: alertList.slice(0, 10),
  };
}

/* ---------------------------------------------------------------------- hover card --- */

/** What the entity hover card shows for a seafarer — rank, where they are, and whether their papers are current. */
export function seafarerCard(s: SeafarerRow, certs: CertApi[], days: number) {
  const alerts = certs.filter((c) => c.status !== 'VALID').length;
  return {
    kind: 'seafarer', title: s.name, subtitle: `${s.rank}${s.nationality ? ` · ${s.nationality}` : ''}`, link: `/seafarers/${s.id}`,
    chips: [
      { label: s.status.replace(/_/g, ' ').toLowerCase(), tone: s.status === 'ACTIVE' ? 'success' : s.status === 'SUSPENDED' ? 'error' : 'default' },
      ...(alerts ? [{ label: `${alerts} document alert${alerts > 1 ? 's' : ''}`, tone: 'warning' }] : []),
    ],
    lines: [
      { label: 'CDC', value: s.cdc_no },
      { label: 'On board', value: s.current_vessel_name ?? 'Ashore' },
      { label: 'Signed on', value: iso(s.signed_on_at), kind: 'since' as const },
      { label: 'Sea service', value: `${days} days` },
    ],
  };
}
