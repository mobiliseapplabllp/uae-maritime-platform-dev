import type { PoolClient } from 'pg';
import { EVENTS, makeEvent, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, badRequest, conflict, enqueue, eventFromContext, lookupByCode, lookupOptions, notFound, type LookupOption, type Principal, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { D, cycleApi, cycleStateOn, iso, type CycleApi, type CycleRow, type Row, type VisitApi } from './directory';
import { raiseObligation } from './compliance';

/* The annual accreditation cycle.
 *
 * Six schemes — compass adjusting, life-saving and fire-fighting appliance servicing, small-vessel survey,
 * pest control and towage — accredit a company for a cycle and renew it into the next. The instrument
 * register issues the accreditation; this file owns what the desk does with it: the cycle it opened, the
 * visits it calls for, the reminders owed as it runs out, and what happens on the day it does.
 *
 * Nothing about a scheme is written here. Its cycle length, how many visits a cycle takes, when renewal is
 * reminded and how much it weighs in the rating are the `accreditationCategory` master's, read from this
 * service's mirror of it — so a seventh scheme is a row in Data Studio, not a release. */

export interface Scheme { category: string; label: string; labelAr: string | null; instrumentType: string; cycleMonths: number; visitsPerCycle: number; reminderDays: number[]; ratingWeight: number }
const MONTH = 30.4375 * D;

export const parseDays = (v: unknown, fallback: number[]): number[] => {
  const list = Array.isArray(v) ? v : typeof v === 'string' ? v.split(/[,\s]+/) : typeof v === 'number' ? [v] : [];
  const days = list.map((x) => String(x).trim()).filter(Boolean).map(Number).filter((n) => Number.isFinite(n) && n >= 0);
  return days.length ? [...new Set(days)].sort((a, b) => b - a) : fallback;
};
const schemeOf = (o: LookupOption, env: Env): Scheme => ({
  category: o.code, label: o.label, labelAr: o.labelAr, instrumentType: String(o.meta.instrumentType ?? o.code),
  cycleMonths: Math.max(1, Number(o.meta.cycleMonths) || 12), visitsPerCycle: Math.max(0, Number(o.meta.visitsPerCycle ?? 1)),
  reminderDays: parseDays(o.meta.reminderDays, parseDays(env.ACCREDITATION_REMINDER_DAYS, [90, 30, 7])), ratingWeight: Number(o.meta.ratingWeight) || 1,
});
/** Every accreditation scheme the master declares. */
export async function schemes(c: Queryable, env: Env): Promise<Scheme[]> { return (await lookupOptions(c, 'accreditationCategory')).map((o) => schemeOf(o, env)); }
export async function schemeFor(c: Queryable, env: Env, category: string): Promise<Scheme | null> {
  const o = await lookupByCode(c, 'accreditationCategory', category);
  return o?.active ? schemeOf(o, env) : null;
}
/** The scheme an instrument type accredits under, if any — by the master's `instrumentType`, or by the code itself. */
export async function schemeForInstrumentType(c: Queryable, env: Env, entityType: string): Promise<Scheme | null> {
  if (!entityType) return null;
  return (await schemes(c, env)).find((s) => s.instrumentType === entityType || s.category === entityType) ?? null;
}

export const addMonths = (d: Date, months: number) => { const x = new Date(d); x.setUTCMonth(x.getUTCMonth() + months); return x; };
/** When the next visit of a cycle falls due: visits are spread evenly through the cycle, each due three quarters of the way through its slot. */
export function nextVisitDue(startsOn: Date, endsOn: Date, visitsRequired: number, visitsDone: number): Date | null {
  if (visitsDone >= visitsRequired || visitsRequired <= 0) return null;
  const slot = (endsOn.getTime() - startsOn.getTime()) / visitsRequired;
  const due = new Date(startsOn.getTime() + slot * visitsDone + slot * 0.75);
  return due.getTime() > endsOn.getTime() ? endsOn : due;
}

export async function loadCycle(c: Queryable, id: string, lock = false): Promise<CycleRow> {
  const r = await c.query<CycleRow>(`SELECT * FROM accreditation_cycles WHERE id::text = $1${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!r.rows[0]) throw notFound('Accreditation cycle not found');
  return r.rows[0];
}
export async function latestCycle(c: Queryable, companyId: string, category: string, lock = false): Promise<CycleRow | null> {
  const r = await c.query<CycleRow>(`SELECT * FROM accreditation_cycles WHERE company_id = $1 AND category = $2 ORDER BY cycle_no DESC LIMIT 1${lock ? ' FOR UPDATE' : ''}`, [companyId, category]);
  return r.rows[0] ?? null;
}
export async function cyclesFor(c: Queryable, companyId: string, env: Env, now = new Date()): Promise<CycleApi[]> {
  const r = await c.query<CycleRow>('SELECT * FROM accreditation_cycles WHERE company_id = $1 ORDER BY category, cycle_no DESC', [companyId]);
  const all = await schemes(c, env); const days = (cat: string) => all.find((s) => s.category === cat)?.reminderDays ?? parseDays(env.ACCREDITATION_REMINDER_DAYS, [90, 30, 7]);
  return r.rows.map((row) => cycleApi(row, now, days(row.category)));
}
/** The latest cycle under each scheme — the company's accreditation position as the record shows it. */
export const positionOf = (cycles: CycleApi[]): CycleApi[] => {
  const seen = new Set<string>();
  return cycles.filter((x) => { if (seen.has(x.category)) return false; seen.add(x.category); return true; });
};

export interface OpenCycleInput { instrumentId?: string | null; instrumentNo?: string; startsOn: Date; endsOn?: Date | null; by?: Principal | null; cause?: EventEnvelope; reason?: string }
export interface OpenCycleResult { row: CycleRow; change: 'opened' | 'renewed' | 'updated' | 'reinstated'; previous: CycleRow | null }
const entityOf = (kind: 'COMPANY' | 'FACILITY') => (kind === 'COMPANY' ? 'Company' : 'PortFacility');

async function announce(c: Queryable, env: Env, type: string, data: Row, subject: string, cause?: EventEnvelope) {
  await enqueue(c, cause
    ? makeEvent({ type, source: env.SERVICE_NAME, data, subject, correlationId: cause.correlationid, causationId: cause.id, actor: cause.actor })
    : eventFromContext(env.SERVICE_NAME, type, data, { subject }));
}
const cyclePayload = (row: CycleRow, extra: Row = {}) => ({ cycleId: row.id, companyId: row.company_id, companyName: row.company_name, category: row.category, cycleNo: row.cycle_no, instrumentId: row.instrument_id, instrumentNo: row.instrument_no, startsOn: row.starts_on, endsOn: row.ends_on, status: row.status, ...extra });

/* Opening a cycle is the one write with judgement in it. The same instrument arriving twice is the same
 * cycle (dates refreshed, nothing announced twice); an instrument reinstated after suspension returns its
 * cycle to current; a new instrument under a scheme the company already holds renews — the previous cycle is
 * closed as RENEWED and the next one numbered after it, so the history reads as a line. */
export async function openCycle(c: PoolClient, env: Env, audit: AuditClient, company: { id: string; name: string }, category: string, input: OpenCycleInput): Promise<OpenCycleResult> {
  const scheme = await schemeFor(c, env, category);
  if (!scheme) throw badRequest(`"${category}" is not an active entry of the accreditationCategory master`, { category });
  const startsOn = new Date(input.startsOn); if (Number.isNaN(startsOn.getTime())) throw badRequest('The cycle start is not a date');
  const endsOn = input.endsOn ? new Date(input.endsOn) : addMonths(startsOn, scheme.cycleMonths);
  if (endsOn.getTime() <= startsOn.getTime()) throw badRequest('The cycle must end after it starts');
  const previous = await latestCycle(c, company.id, category, true);
  const by = input.by ?? null;

  if (previous && input.instrumentId && previous.instrument_id === input.instrumentId) {
    const reinstated = previous.status === 'SUSPENDED';
    const r = await c.query<CycleRow>(
      `UPDATE accreditation_cycles SET starts_on = $2, ends_on = $3, instrument_no = COALESCE(NULLIF($4, ''), instrument_no), status = CASE WHEN status IN ('SUSPENDED') THEN 'CURRENT' ELSE status END,
         status_reason = CASE WHEN status = 'SUSPENDED' THEN $5 ELSE status_reason END, updated_at = now() WHERE id = $1 RETURNING *`,
      [previous.id, startsOn, endsOn, input.instrumentNo ?? '', input.reason || 'Instrument reinstated']);
    const row = r.rows[0];
    if (reinstated) {
      await audit.record(c, { action: 'ACCREDITATION_REINSTATED', entity: 'Company', entityId: company.id, entityLabel: company.name, after: cycleApi(row), note: input.reason ?? '' });
      await announce(c, env, EVENTS.facilities.accreditationOpened, cyclePayload(row, { change: 'reinstated' }), company.id, input.cause);
    }
    return { row, change: reinstated ? 'reinstated' : 'updated', previous };
  }
  if (previous && (previous.status === 'CURRENT' || previous.status === 'DUE' || previous.status === 'EXPIRED' || previous.status === 'SUSPENDED')) {
    await c.query(`UPDATE accreditation_cycles SET status = 'RENEWED', status_reason = $2, updated_at = now() WHERE id = $1`, [previous.id, `Renewed — cycle ${previous.cycle_no + 1} opened`]);
  }
  const cycleNo = (previous?.cycle_no ?? 0) + 1;
  const r = await c.query<CycleRow>(
    `INSERT INTO accreditation_cycles(company_id, company_name, category, instrument_id, instrument_no, cycle_no, starts_on, ends_on, status, status_reason, visits_required, next_visit_due, granted_by_id, granted_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'CURRENT',$9,$10,$11,$12,$13) RETURNING *`,
    [company.id, company.name, category, input.instrumentId ?? null, input.instrumentNo ?? '', cycleNo, startsOn, endsOn, input.reason ?? (cycleNo === 1 ? 'Accreditation granted' : 'Accreditation renewed'),
      scheme.visitsPerCycle, nextVisitDue(startsOn, endsOn, scheme.visitsPerCycle, 0), by?.id ?? null, by?.name ?? '']);
  const row = r.rows[0];
  const renewed = cycleNo > 1;
  await audit.record(c, { action: renewed ? 'ACCREDITATION_RENEWED' : 'ACCREDITATION_GRANTED', entity: 'Company', entityId: company.id, entityLabel: company.name, after: cycleApi(row), note: input.reason ?? '' });
  await announce(c, env, renewed ? EVENTS.facilities.accreditationRenewed : EVENTS.facilities.accreditationOpened, cyclePayload(row, { change: renewed ? 'renewed' : 'opened', previousCycleId: previous?.id ?? null, scheme: scheme.label }), company.id, input.cause);
  return { row, change: renewed ? 'renewed' : 'opened', previous };
}

/** What an instrument's new status means for the cycle it runs: suspended, withdrawn, or nothing this file cares about. */
export async function closeCycleFromInstrument(c: PoolClient, env: Env, audit: AuditClient, instrumentId: string, status: 'SUSPENDED' | 'REVOKED', reason: string, cause?: EventEnvelope): Promise<CycleRow | null> {
  const found = await c.query<CycleRow>('SELECT * FROM accreditation_cycles WHERE instrument_id = $1 FOR UPDATE', [instrumentId]);
  const row = found.rows[0];
  if (!row || row.status === 'RENEWED' || row.status === 'WITHDRAWN') return null;
  const next = status === 'SUSPENDED' ? 'SUSPENDED' : 'WITHDRAWN';
  if (row.status === next) return row;
  const r = await c.query<CycleRow>('UPDATE accreditation_cycles SET status = $2, status_reason = $3, updated_at = now() WHERE id = $1 RETURNING *', [row.id, next, reason]);
  const updated = r.rows[0];
  await audit.record(c, { action: next === 'SUSPENDED' ? 'ACCREDITATION_SUSPENDED' : 'ACCREDITATION_WITHDRAWN', entity: 'Company', entityId: row.company_id, entityLabel: row.company_name, before: { status: row.status }, after: { status: next }, note: reason });
  await announce(c, env, next === 'SUSPENDED' ? EVENTS.facilities.accreditationSuspended : EVENTS.facilities.accreditationWithdrawn, cyclePayload(updated, { reason }), row.company_id, cause);
  return updated;
}

/* The daily sweep. Time moves two states on its own — a current cycle into its renewal window, and a cycle
 * past its end into expiry — and each is written once, announced once, and turned into one obligation the
 * company can see. Reminders are recorded on the cycle by the day they were owed at, so a sweep that runs
 * twice, or catches up after a weekend, reminds exactly once per milestone. */
export async function sweepAccreditations(c: PoolClient, env: Env, audit: AuditClient, now = new Date(), cause?: EventEnvelope) {
  const all = await schemes(c, env);
  const live = await c.query<CycleRow>("SELECT * FROM accreditation_cycles WHERE status IN ('CURRENT', 'DUE') ORDER BY ends_on FOR UPDATE SKIP LOCKED");
  let due = 0; let expired = 0; let reminded = 0;
  for (const row of live.rows) {
    const scheme = all.find((s) => s.category === row.category);
    const reminderDays = scheme?.reminderDays ?? parseDays(env.ACCREDITATION_REMINDER_DAYS, [90, 30, 7]);
    const state = cycleStateOn(row, now, reminderDays);
    const subject = { kind: 'COMPANY' as const, id: row.company_id, name: row.company_name };
    const renewalRef = `${row.instrument_no || row.id}:renewal`;
    if (state.status === 'EXPIRED') {
      const r = await c.query<CycleRow>(`UPDATE accreditation_cycles SET status = 'EXPIRED', status_reason = 'Cycle ended without renewal', updated_at = now() WHERE id = $1 RETURNING *`, [row.id]);
      await audit.record(c, { action: 'ACCREDITATION_EXPIRED', entity: 'Company', entityId: row.company_id, entityLabel: row.company_name, after: cycleApi(r.rows[0], now, reminderDays) });
      await raiseObligation(c, env, audit, subject, { kind: 'RENEWAL', title: `${scheme?.label ?? row.category} accreditation expired`, detail: `Cycle ${row.cycle_no} ended on ${iso(row.ends_on)?.slice(0, 10)}. Renewal is to be applied for before the company works under this scheme again.`, sourceRef: renewalRef, dueAt: iso(row.ends_on) });
      await announce(c, env, EVENTS.facilities.accreditationExpired, cyclePayload(r.rows[0], { scheme: scheme?.label ?? row.category, daysLeft: state.daysLeft }), row.company_id, cause);
      expired += 1;
      continue;
    }
    if (state.status !== 'DUE') continue;
    const already = new Set((row.reminders ?? []).map(Number));
    const owed = reminderDays.filter((d) => state.daysLeft <= d && !already.has(d));
    if (row.status !== 'DUE' || owed.length) {
      const next = [...already, ...owed].sort((a, b) => b - a);
      await c.query(`UPDATE accreditation_cycles SET status = 'DUE', status_reason = $2, reminders = $3, updated_at = now() WHERE id = $1`, [row.id, `Renewal due in ${state.daysLeft} day(s)`, JSON.stringify(next)]);
      if (row.status !== 'DUE') due += 1;
    }
    for (const day of owed) {
      await raiseObligation(c, env, audit, subject, { kind: 'RENEWAL', title: `Renew ${scheme?.label ?? row.category} accreditation`, detail: `Cycle ${row.cycle_no} ends on ${iso(row.ends_on)?.slice(0, 10)} (${state.daysLeft} days). Apply for renewal before it does.`, sourceRef: renewalRef, dueAt: iso(row.ends_on) });
      await announce(c, env, EVENTS.facilities.accreditationDue, cyclePayload({ ...row, status: 'DUE' }, { scheme: scheme?.label ?? row.category, daysLeft: state.daysLeft, reminderDay: day }), row.company_id, cause);
      reminded += 1;
    }
  }
  return { swept: live.rows.length, due, expired, reminded };
}

/* ------------------------------------------------------------------------- dashboard --- */

export interface SchemeSummary { category: string; label: string; labelAr: string | null; cycleMonths: number; companies: number; current: number; due: number; expired: number; suspended: number; withdrawn: number; visitsOverdue: number; averageRating: number | null }
/** The accreditation desk at a glance: every scheme, and where each company under it stands. */
export function accreditationDashboard(position: CycleApi[], visits: VisitApi[], all: Scheme[], now = new Date()) {
  const bySchemes: SchemeSummary[] = all.map((s) => {
    const rows = position.filter((p) => p.category === s.category);
    const rated = rows.filter((r) => r.rating != null);
    return {
      category: s.category, label: s.label, labelAr: s.labelAr, cycleMonths: s.cycleMonths, companies: rows.length,
      current: rows.filter((r) => r.status === 'CURRENT').length, due: rows.filter((r) => r.status === 'DUE').length, expired: rows.filter((r) => r.status === 'EXPIRED').length,
      suspended: rows.filter((r) => r.status === 'SUSPENDED').length, withdrawn: rows.filter((r) => r.status === 'WITHDRAWN').length,
      visitsOverdue: rows.filter((r) => r.visitOverdue).length,
      averageRating: rated.length ? Math.round((rated.reduce((n, r) => n + (r.rating ?? 0), 0) / rated.length) * 10) / 10 : null,
    };
  });
  const d30 = now.getTime() + 30 * D; const d90 = now.getTime() + 90 * D;
  const liveCycles = position.filter((p) => p.status === 'CURRENT' || p.status === 'DUE');
  const ends = (p: CycleApi) => new Date(p.endsOn ?? 0).getTime();
  const scheduled = visits.filter((v) => v.status === 'SCHEDULED');
  const completed = visits.filter((v) => v.status === 'COMPLETED');
  return {
    kpis: {
      schemes: all.length, accredited: liveCycles.length, companies: new Set(liveCycles.map((p) => p.companyId)).size,
      due: position.filter((p) => p.status === 'DUE').length, expired: position.filter((p) => p.status === 'EXPIRED').length, suspended: position.filter((p) => p.status === 'SUSPENDED').length,
      renewalsNext30: liveCycles.filter((p) => ends(p) <= d30).length, renewalsNext90: liveCycles.filter((p) => ends(p) <= d90).length,
      visitsScheduled: scheduled.length, visitsOverdue: scheduled.filter((v) => v.overdue).length + position.filter((p) => p.visitOverdue).length,
      visitsCompleted90: completed.filter((v) => v.visitedOn && new Date(v.visitedOn).getTime() >= now.getTime() - 90 * D).length,
      nonConformities90: completed.filter((v) => v.result === 'NON_CONFORMITY' && v.visitedOn && new Date(v.visitedOn).getTime() >= now.getTime() - 90 * D).length,
    },
    bySchemes,
    byStatus: ['CURRENT', 'DUE', 'EXPIRED', 'SUSPENDED', 'WITHDRAWN'].map((status) => ({ status, total: position.filter((p) => p.status === status).length })),
    renewals: liveCycles.filter((p) => ends(p) <= d90).sort((a, b) => ends(a) - ends(b)).slice(0, 12),
    visitsDue: [...scheduled].sort((a, b) => String(a.scheduledOn ?? '').localeCompare(String(b.scheduledOn ?? ''))).slice(0, 12),
    generatedAt: now.toISOString(),
  };
}
export type AccreditationDashboard = ReturnType<typeof accreditationDashboard>;

export { conflict };
