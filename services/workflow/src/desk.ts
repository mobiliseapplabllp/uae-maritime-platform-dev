/* The service desk's yardsticks: what came in and went out month by month, how old the open work is, what is about to
 * breach, and — over the last ninety days — how much was decided inside its service level, how long a decision took,
 * how often an application went through without a request for more information, and how much of the eligible work
 * went straight through. The fee position is read from the payments recorded on the applications themselves. */
import { REQUEST_OPEN_STATUS } from '@maritime/contracts';

type Instant = Date | string | number | null | undefined;
export interface DeskRow {
  status: string; category: string; definitionKey: string; subjectKind: string | null; auto: boolean; infoRequested: boolean;
  createdAt: Instant; submittedAt: Instant; decidedAt: Instant; closedAt: Instant; slaDueAt: Instant; slaBreachedAt: Instant;
  feesTotal: number; paymentStatus: string | null; paidAt: Instant;
}
const D = 86_400_000; const H = 3_600_000;
const ms = (d: Instant) => (d == null || d === '' ? NaN : new Date(d).getTime());
const has = (d: Instant) => !Number.isNaN(ms(d));
const inWin = (d: Instant, from: number, to: number) => has(d) && ms(d) >= from && ms(d) < to;
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : null);
const r1 = (n: number) => Math.round(n * 10) / 10; const r2 = (n: number) => Math.round(n * 100) / 100;
const median = (xs: number[]) => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return r1(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };
export const AGE_BUCKETS = ['0–7', '8–14', '15–30', '31–60', '60+'] as const;
export const ageBucket = (days: number) => (days <= 7 ? '0–7' : days <= 14 ? '8–14' : days <= 30 ? '15–30' : days <= 60 ? '31–60' : '60+');
const DECIDED = new Set(['APPROVED', 'ISSUED', 'REJECTED']);

export function deskDashboard(rows: DeskRow[], now = new Date()) {
  const t = now.getTime(); const d90 = t - 90 * D; const h48 = t + 48 * H;
  const startMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1); const prevMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1); const startYear = Date.UTC(now.getUTCFullYear(), 0, 1);
  const prevSameDays = Math.min(startMonth, prevMonth + (t - startMonth)); // month to date against the same days of last month
  const open = rows.filter((r) => (REQUEST_OPEN_STATUS as readonly string[]).includes(r.status));
  const series = Array.from({ length: 12 }, (_, k) => {
    const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + k, 1); const to = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 10 + k, 1); const d = new Date(from);
    return {
      key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, month: d.toLocaleString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }),
      received: rows.filter((r) => inWin(r.submittedAt, from, to)).length, decided: rows.filter((r) => DECIDED.has(r.status) && inWin(r.decidedAt, from, to)).length,
      issued: rows.filter((r) => r.status === 'ISSUED' && inWin(r.decidedAt, from, to)).length, breached: rows.filter((r) => inWin(r.slaBreachedAt, from, to)).length,
    };
  });
  const ageing = AGE_BUCKETS.map((bucket) => ({ bucket, count: 0 }));
  for (const r of open) { const since = has(r.submittedAt) ? r.submittedAt : r.createdAt; const days = has(since) ? (t - ms(since)) / D : 0; ageing.find((b) => b.bucket === ageBucket(days))!.count += 1; }
  const breachedOpen = open.filter((r) => has(r.slaDueAt) && ms(r.slaDueAt) < t);
  const atRisk = open.filter((r) => has(r.slaDueAt) && ms(r.slaDueAt) >= t && ms(r.slaDueAt) <= h48);
  const decided90 = rows.filter((r) => DECIDED.has(r.status) && inWin(r.decidedAt, d90, t) && has(r.submittedAt));
  const days = decided90.map((r) => (ms(r.decidedAt) - ms(r.submittedAt)) / D);
  const withinSla = decided90.filter((r) => !has(r.slaDueAt) || ms(r.decidedAt) <= ms(r.slaDueAt));
  const approved90 = decided90.filter((r) => r.status !== 'REJECTED');
  const autoDecided = decided90.filter((r) => r.auto);
  const straight = autoDecided.filter((r) => ms(r.decidedAt) - ms(r.submittedAt) <= D);
  const paid = rows.filter((r) => r.paymentStatus === 'PAID' && has(r.paidAt));
  const fees = (from: number, to: number) => r2(paid.filter((r) => inWin(r.paidAt, from, to)).reduce((s, r) => s + (Number(r.feesTotal) || 0), 0));
  const byStage = [...new Set(open.map((r) => r.status))].map((status) => ({ status, count: open.filter((r) => r.status === status).length, breached: breachedOpen.filter((r) => r.status === status).length })).sort((a, b) => b.count - a.count);
  const bySubjectKind = [...new Set(rows.map((r) => r.subjectKind || 'NONE'))].map((subjectKind) => ({ subjectKind, total: rows.filter((r) => (r.subjectKind || 'NONE') === subjectKind).length, open: open.filter((r) => (r.subjectKind || 'NONE') === subjectKind).length })).sort((a, b) => b.total - a.total);
  return {
    series, ageing, byStage, bySubjectKind,
    desk: {
      receivedMtd: rows.filter((r) => inWin(r.submittedAt, startMonth, t)).length, receivedPrevMonth: rows.filter((r) => inWin(r.submittedAt, prevMonth, prevSameDays)).length,
      decidedMtd: rows.filter((r) => DECIDED.has(r.status) && inWin(r.decidedAt, startMonth, t)).length, received12m: series.reduce((s, m) => s + m.received, 0), decided12m: series.reduce((s, m) => s + m.decided, 0),
      breachedOpen: breachedOpen.length, atRisk48h: atRisk.length,
      decided90d: decided90.length, withinSlaPct90d: pct(withinSla.length, decided90.length), medianDecisionDays90d: median(days), avgDecisionDays90d: days.length ? r1(days.reduce((s, x) => s + x, 0) / days.length) : null,
      firstTimeRightPct90d: pct(decided90.filter((r) => !r.infoRequested).length, decided90.length), approvalRatePct90d: pct(approved90.length, decided90.length),
      straightThroughPct90d: pct(straight.length, autoDecided.length), autoDecided90d: autoDecided.length,
      feesCollectedMtd: fees(startMonth, t), feesCollectedYtd: fees(startYear, t), feesCollected12m: fees(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1), t),
      feesOutstanding: r2(rows.filter((r) => r.paymentStatus === 'DUE').reduce((s, r) => s + (Number(r.feesTotal) || 0), 0)), feesDueCount: rows.filter((r) => r.paymentStatus === 'DUE').length,
      oldestOpenDays: open.length ? Math.max(...open.map((r) => { const since = has(r.submittedAt) ? r.submittedAt : r.createdAt; return has(since) ? Math.floor((t - ms(since)) / D) : 0; })) : 0,
    },
    targets: { withinSlaPct: 90, firstTimeRightPct: 80, straightThroughPct: 60 },
  };
}
export type DeskDashboard = ReturnType<typeof deskDashboard>;
