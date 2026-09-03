import { EVENTS, makeEvent, type Actor, type EventEnvelope, type TransitionTable } from '@maritime/contracts';
import { enqueue, eventFromContext, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';

/* The regulated-company directory and the port-facility register.
 *
 * Master data owns the golden record of a company — who it is, its registration, its address. What is
 * owned here is the regulatory overlay on that same identifier: the standing this administration
 * grants the company, the reason its standing last changed, the compliance audits carried out against
 * it and the performance rating those audits earn. The instruments a company holds are not duplicated
 * here either: they belong to the instrument register and arrive as a local read-model snapshot, which
 * is what the company record shows and what the renewal work list is built from.
 *
 * A rating is not a field somebody types. It is computed from the audit history, weighted so that a
 * finding from last month counts for more than one from four years ago — which is why recording an
 * audit moves it and editing the company does not. */

export type Row = Record<string, any>;
export const D = 86_400_000;
export const YEAR = 365.25 * D;
export const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());
export const dateOnly = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString().slice(0, 10));
export const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));

export const COMPANY_CATEGORIES = ['AGENCY', 'TERMINAL_OPERATOR', 'SERVICE_PROVIDER', 'SUPPLIER', 'INSTITUTE'] as const;
export const COMPANY_STATUS = ['ACTIVE', 'SUSPENDED', 'BLACKLISTED', 'INACTIVE'] as const;
export type CompanyStatus = (typeof COMPANY_STATUS)[number];
/* Standing moves one step at a time and every step away from good standing carries a reason.
 * Blacklisting is not the end of a company's life — a blacklisted operator can be restored — but it
 * can never be quietly downgraded to a suspension, because that would rewrite what was decided. */
export const COMPANY_STATUS_TRANSITIONS: TransitionTable<CompanyStatus> = {
  ACTIVE: ['SUSPENDED', 'BLACKLISTED', 'INACTIVE'],
  SUSPENDED: ['ACTIVE', 'BLACKLISTED', 'INACTIVE'],
  BLACKLISTED: ['ACTIVE', 'INACTIVE'],
  INACTIVE: ['ACTIVE'],
};
/** Leaving good standing is a decision taken against a company, so it is never recorded without one. */
export const REASONED_STATUS: CompanyStatus[] = ['SUSPENDED', 'BLACKLISTED', 'INACTIVE'];

/** `LICENCE` reads as `Licence` — the printed name of the class the instrument register issued under. */
export const classLabel = (k: string | null | undefined) => { const c = k || 'LICENCE'; return c.charAt(0) + c.slice(1).toLowerCase(); };

export const AUDIT_RESULTS = ['SATISFACTORY', 'OBSERVATIONS', 'NON_CONFORMITY'] as const;
export type AuditResult = (typeof AUDIT_RESULTS)[number];
export const SUBJECT_KINDS = ['COMPANY', 'FACILITY'] as const;
export const FACILITY_TYPES = ['BERTH', 'TERMINAL', 'JETTY', 'YARD', 'SPM', 'ANCHORAGE'] as const;
export const FACILITY_STATUS = ['OPERATIONAL', 'MAINTENANCE', 'CLOSED'] as const;
/* ISPS standing of a port facility: a Statement of Compliance in force, an interim one, one that has
 * run out, one withdrawn by the administration, or a facility the Code does not reach. */
export const ISPS_STATUS = ['COMPLIANT', 'PROVISIONAL', 'EXPIRED', 'SUSPENDED', 'NOT_APPLICABLE'] as const;
export const OBLIGATION_KINDS = ['AUDIT_FINDING', 'RENEWAL', 'CONDITION', 'DOCUMENT'] as const;
export const OBLIGATION_STATUS = ['OPEN', 'CLEARED'] as const;

export interface CompanyRow {
  id: string; code: string; name: string; name_ar: string | null; category: string; types: string[];
  contact_name: string; contact_email: string; contact_phone: string; tax_id: string; registration_no: string; address: string; city: string;
  status: string; status_reason: string; status_changed_at: Date | null; status_changed_by_id: string | null; status_changed_by: string;
  rating: string; onboarded_at: string | null; remarks: string; real: boolean; created_at: Date; updated_at: Date;
}
export interface StatusRow { id: string; company_id: string; from_status: string; to_status: string; reason: string; at: Date; by_id: string | null; by: string }
export interface FacilityRow {
  id: string; code: string; name: string; name_ar: string | null; facility_type: string; terminal: string; berth_type: string;
  operator_id: string | null; operator_name: string; isps_status: string; isps_level: number; soc_no: string; soc_expiry: Date | null;
  psso_name: string; psso_phone: string; capabilities: string[]; loa_max: string | null; draft_max: string | null;
  capacity_value: string | null; capacity_unit: string; status: string; remarks: string; created_at: Date; updated_at: Date;
}
export interface AuditRow {
  id: string; number: string; subject_kind: string; subject_id: string; subject_name: string; audited_on: Date;
  auditor_id: string | null; auditor: string; result: string; scope: string; remarks: string; instrument_id: string | null; instrument_no: string; created_at: Date;
}
export interface ObligationRow {
  id: string; subject_kind: string; subject_id: string; subject_name: string; kind: string; title: string; detail: string; source_ref: string;
  due_at: Date | null; status: string; raised_at: Date; raised_by_id: string | null; raised_by: string;
  cleared_at: Date | null; cleared_by_id: string | null; cleared_by: string; clearance_note: string;
}
export interface InstrumentRow {
  id: string; number: string; subject_kind: string; subject_id: string | null; entity_name: string; entity_type: string; type_label: string;
  instrument_class: string; class_label: string; status: string; applied_date: Date | null; issue_date: Date | null; expiry_date: Date | null;
  statutory: boolean; in_force: boolean; signed: boolean; performance_rating: string | null; audits_count: number; conditions: string; updated_at: Date;
}

/* -------------------------------------------------------------------------- API shapes --- */

export const auditApi = (a: AuditRow) => ({
  id: a.id, number: a.number, subjectKind: a.subject_kind, subjectId: a.subject_id, subjectName: a.subject_name,
  date: iso(a.audited_on)!, auditorId: a.auditor_id, auditor: a.auditor, result: a.result, scope: a.scope, remarks: a.remarks,
  instrumentId: a.instrument_id, instrumentNo: a.instrument_no, createdAt: iso(a.created_at),
});
export type AuditApi = ReturnType<typeof auditApi>;

export const obligationApi = (o: ObligationRow, now = new Date()) => ({
  id: o.id, subjectKind: o.subject_kind, subjectId: o.subject_id, subjectName: o.subject_name, kind: o.kind, title: o.title, detail: o.detail,
  sourceRef: o.source_ref, dueAt: iso(o.due_at), status: o.status, raisedAt: iso(o.raised_at)!, raisedBy: o.raised_by,
  clearedAt: iso(o.cleared_at), clearedBy: o.cleared_by, clearanceNote: o.clearance_note,
  overdue: o.status === 'OPEN' && !!o.due_at && new Date(o.due_at).getTime() < now.getTime(),
});
export type ObligationApi = ReturnType<typeof obligationApi>;

export const statusEntryApi = (h: StatusRow) => ({ from: h.from_status, to: h.to_status, reason: h.reason, at: iso(h.at)!, by: h.by, byId: h.by_id });

/** One instrument as the local snapshot holds it — the register's own record stays in the instruments service. */
export const instrumentApi = (i: InstrumentRow, now = new Date()) => ({
  id: i.id, licenseNo: i.number, number: i.number, subjectKind: i.subject_kind, subjectId: i.subject_id, entityName: i.entity_name,
  entityType: i.entity_type, typeLabel: i.type_label, instrumentClass: i.instrument_class, classLabel: i.class_label, status: i.status,
  appliedDate: iso(i.applied_date), issueDate: iso(i.issue_date), expiryDate: iso(i.expiry_date), statutory: i.statutory, inForce: i.in_force,
  signed: i.signed, performanceRating: num(i.performance_rating), audits: i.audits_count, conditions: i.conditions,
  daysToExpiry: i.expiry_date ? Math.round((new Date(i.expiry_date).getTime() - now.getTime()) / D) : null,
  expired: !!i.expiry_date && new Date(i.expiry_date).getTime() < now.getTime(),
});
export type InstrumentApi = ReturnType<typeof instrumentApi>;

export interface CompanyExtras { instruments?: InstrumentApi[]; audits?: AuditApi[]; obligations?: ObligationApi[]; history?: ReturnType<typeof statusEntryApi>[]; facilities?: FacilityApi[] }
/** The company as the directory, the detail screen and every read-model event see it. */
export function companyApi(c: CompanyRow, extra: CompanyExtras = {}) {
  const instruments = extra.instruments ?? [];
  const audits = extra.audits ?? [];
  const obligations = extra.obligations ?? [];
  return {
    id: c.id, code: c.code, name: c.name, nameAr: c.name_ar, category: c.category, types: c.types ?? [],
    contactName: c.contact_name, contactEmail: c.contact_email, contactPhone: c.contact_phone,
    taxId: c.tax_id, registrationNo: c.registration_no, address: c.address, city: c.city,
    status: c.status, statusReason: c.status_reason, statusChangedAt: iso(c.status_changed_at), statusChangedBy: c.status_changed_by,
    rating: Number(c.rating), onboardedAt: c.onboarded_at, remarks: c.remarks, real: c.real,
    instruments, instrumentsHeld: instruments.length,
    inForce: instruments.filter((i) => i.status === 'ISSUED' && i.inForce).length,
    expiringSoon: instruments.filter((i) => i.status === 'ISSUED' && i.daysToExpiry != null && i.daysToExpiry >= 0 && i.daysToExpiry <= 90).length,
    audits, auditCount: audits.length, lastAuditAt: audits[0]?.date ?? null, lastAuditResult: audits[0]?.result ?? null,
    nonConformities: audits.filter((a) => a.result === 'NON_CONFORMITY').length,
    obligations, openObligations: obligations.filter((o) => o.status === 'OPEN').length,
    overdueObligations: obligations.filter((o) => o.status === 'OPEN' && o.overdue).length,
    facilities: extra.facilities ?? [],
    history: extra.history ?? [],
    createdAt: iso(c.created_at), updatedAt: iso(c.updated_at),
  };
}
export type CompanyApi = ReturnType<typeof companyApi>;

export interface FacilityExtras { instruments?: InstrumentApi[]; audits?: AuditApi[]; obligations?: ObligationApi[] }
export function facilityApi(f: FacilityRow, extra: FacilityExtras = {}, now = new Date()) {
  const instruments = extra.instruments ?? [];
  const audits = extra.audits ?? [];
  return {
    id: f.id, code: f.code, name: f.name, nameAr: f.name_ar, facilityType: f.facility_type, terminal: f.terminal, berthType: f.berth_type,
    operatorId: f.operator_id, operatorName: f.operator_name,
    ispsStatus: f.isps_status, ispsLevel: f.isps_level, socNo: f.soc_no, socExpiry: iso(f.soc_expiry),
    ispsInForce: f.isps_status === 'COMPLIANT' && (!f.soc_expiry || new Date(f.soc_expiry).getTime() > now.getTime()),
    pssoName: f.psso_name, pssoPhone: f.psso_phone,
    capabilities: f.capabilities ?? [], loaMax: num(f.loa_max), draftMax: num(f.draft_max),
    capacity: num(f.capacity_value), capacityUnit: f.capacity_unit, status: f.status, remarks: f.remarks,
    instruments, instrumentsHeld: instruments.length, audits, auditCount: audits.length,
    lastAuditAt: audits[0]?.date ?? null, lastAuditResult: audits[0]?.result ?? null,
    obligations: extra.obligations ?? [], openObligations: (extra.obligations ?? []).filter((o) => o.status === 'OPEN').length,
    createdAt: iso(f.created_at), updatedAt: iso(f.updated_at),
  };
}
export type FacilityApi = ReturnType<typeof facilityApi>;

/* ----------------------------------------------------------------------------- ratings --- */

export const AUDIT_SCORE: Record<string, number> = { SATISFACTORY: 5, OBSERVATIONS: 3.5, NON_CONFORMITY: 2 };
/* A performance rating is the recency-weighted mean of the last eight audits: an audit from this year
 * counts for roughly twice one from two years ago, and nothing older than about a decade moves it much.
 * A subject with no audit history has no rating to give — the caller keeps whatever it had. */
export function ratingFrom(audits: { date: string | Date; result: string }[], now = new Date()): number | null {
  const recent = [...audits].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()).slice(0, 8);
  if (!recent.length) return null;
  let weighted = 0; let weight = 0;
  for (const a of recent) {
    const years = Math.max(0, (now.getTime() - new Date(a.date).getTime()) / YEAR);
    const w = Math.max(0.25, 1 / (1 + years / 2));
    weighted += (AUDIT_SCORE[a.result] ?? 3.5) * w;
    weight += w;
  }
  return Math.round((weighted / weight) * 10) / 10;
}

export type Verdict = { ok: true } | { ok: false; error: string };
const label = (s: string) => String(s || '').replace(/_/g, ' ').toLowerCase();
/** Whether a company's standing may move, and whether the move needs a reason on it. */
export function canChangeStatus(from: string, to: string, reason: string): Verdict {
  const allowed = (COMPANY_STATUS_TRANSITIONS as Record<string, string[]>)[from];
  if (!allowed) return { ok: false, error: `Unknown company status "${from}"` };
  if (from === to) return { ok: false, error: `The company is already ${label(to)}` };
  if (!allowed.includes(to)) return { ok: false, error: `A ${label(from)} company cannot become ${label(to)}` };
  if (REASONED_STATUS.includes(to as CompanyStatus) && !String(reason ?? '').trim()) return { ok: false, error: `A company is not ${label(to)} without a reason on the record` };
  return { ok: true };
}

/* -------------------------------------------------------------------------- publishing --- */

/** The read-model shape reporting projects under the `company` kind. */
export const companyReadModel = (c: CompanyApi) => ({ id: c.id, code: c.code, name: c.name, category: c.category, status: c.status, address: c.address, taxId: c.taxId });

export interface PublishOptions { event?: string; data?: Row; cause?: EventEnvelope; actor?: Actor }
export async function publishCompany(c: Queryable, env: Env, row: CompanyRow, extra: CompanyExtras, opts: PublishOptions = {}): Promise<CompanyApi> {
  const entity = companyApi(row, extra);
  const mk = <T,>(type: string, data: T) => (opts.cause
    ? makeEvent({ type, source: env.SERVICE_NAME, data, subject: row.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor })
    : eventFromContext(env.SERVICE_NAME, type, data, { subject: row.id, actor: opts.actor }));
  await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'company', entity: companyReadModel(entity) }));
  if (opts.event) {
    await enqueue(c, mk(opts.event, {
      companyId: row.id, code: row.code, name: row.name, category: row.category, status: row.status,
      rating: Number(row.rating), company: entity, ...(opts.data ?? {}),
    }));
  }
  return entity;
}
export async function publishCompanyDeleted(c: Queryable, env: Env, row: CompanyRow) {
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.deleted, { kind: 'company', id: row.id }, { subject: row.id }));
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.facilities.companyDeleted, { companyId: row.id, code: row.code, name: row.name }, { subject: row.id }));
}
/** Port facilities have no projection of their own in reporting; their changes are announced as domain events. */
export async function publishFacility(c: Queryable, env: Env, row: FacilityRow, extra: FacilityExtras, event: string, data: Row = {}): Promise<FacilityApi> {
  const entity = facilityApi(row, extra);
  await enqueue(c, eventFromContext(env.SERVICE_NAME, event, {
    facilityId: row.id, code: row.code, name: row.name, facilityType: row.facility_type, operatorId: row.operator_id,
    operatorName: row.operator_name, ispsStatus: row.isps_status, status: row.status, facility: entity, ...data,
  }, { subject: row.id }));
  return entity;
}

/* --------------------------------------------------------------------------- dashboard --- */

export interface DirectoryInput {
  companies: { status: string; category: string; rating: number; openObligations: number }[];
  facilities: { ispsStatus: string; status: string; facilityType: string }[];
  instruments: { status: string; expiryDate: string | null; subjectKind: string }[];
  audits: { date: string; result: string }[];
}
/** The directory dashboard: who is on the register, in what standing, and what is coming up. */
export function directoryDashboard(input: DirectoryInput, now = new Date(), renewalWindowDays = 90) {
  const { companies, facilities, instruments, audits } = input;
  const window = now.getTime() + renewalWindowDays * D;
  const rated = companies.filter((c) => c.rating > 0);
  const byCategory = [...new Set(companies.map((c) => c.category))].map((category) => {
    const list = companies.filter((c) => c.category === category);
    return { category, total: list.length, active: list.filter((c) => c.status === 'ACTIVE').length };
  }).sort((a, b) => b.total - a.total || a.category.localeCompare(b.category));
  const byIsps = [...new Set(facilities.map((f) => f.ispsStatus))].map((ispsStatus) => ({ ispsStatus, total: facilities.filter((f) => f.ispsStatus === ispsStatus).length }))
    .sort((a, b) => b.total - a.total || a.ispsStatus.localeCompare(b.ispsStatus));
  const issued = instruments.filter((i) => i.status === 'ISSUED');
  const expiring = issued.filter((i) => i.expiryDate && new Date(i.expiryDate).getTime() > now.getTime() && new Date(i.expiryDate).getTime() <= window);
  const expired = issued.filter((i) => i.expiryDate && new Date(i.expiryDate).getTime() <= now.getTime());
  const lastYear = audits.filter((a) => new Date(a.date).getTime() > now.getTime() - YEAR);
  return {
    kpis: {
      companies: companies.length,
      active: companies.filter((c) => c.status === 'ACTIVE').length,
      suspended: companies.filter((c) => c.status === 'SUSPENDED').length,
      blacklisted: companies.filter((c) => c.status === 'BLACKLISTED').length,
      inactive: companies.filter((c) => c.status === 'INACTIVE').length,
      averageRating: rated.length ? Math.round((rated.reduce((s, c) => s + c.rating, 0) / rated.length) * 10) / 10 : 0,
      facilities: facilities.length,
      ispsCompliant: facilities.filter((f) => f.ispsStatus === 'COMPLIANT').length,
      instrumentsHeld: issued.length,
      dueForRenewal: expiring.length,
      expired: expired.length,
      auditsLastYear: lastYear.length,
      nonConformities: lastYear.filter((a) => a.result === 'NON_CONFORMITY').length,
      openObligations: companies.reduce((s, c) => s + c.openObligations, 0),
    },
    byCategory,
    byStatus: COMPANY_STATUS.map((status) => ({ status, total: companies.filter((c) => c.status === status).length })),
    byIsps,
    byFacilityType: [...new Set(facilities.map((f) => f.facilityType))].map((facilityType) => ({ facilityType, total: facilities.filter((f) => f.facilityType === facilityType).length }))
      .sort((a, b) => b.total - a.total || a.facilityType.localeCompare(b.facilityType)),
    auditResults: AUDIT_RESULTS.map((result) => ({ result, total: lastYear.filter((a) => a.result === result).length })),
  };
}
export type DirectoryDashboard = ReturnType<typeof directoryDashboard>;
