/* The receivables dashboard: what the desk has billed, what it has collected and how well it collects.
 *
 * The measures are the ones a finance director reads. Days sales outstanding is the open book against the daily run-rate
 * of the last ninety days; the collection effectiveness index is what was collectable in those ninety days against what
 * was collected; the ageing splits every open invoice by how far past its due date it stands, in the buckets collections
 * desks work. Every figure is worked from the invoices and their recorded payments — nothing is estimated. */
export type Instant = Date | string | number | null | undefined;
export interface ArPayment { at: Instant; amount: number; method?: string }
export interface ArLine { code?: string; description?: string; amount?: number }
export interface ArInvoice {
  id: string; number: string; status: string; proforma?: boolean; total: number; paidAmount: number; taxAmount: number;
  issuedAt: Instant; dueAt: Instant; paidAt: Instant; createdAt: Instant; remindedAt?: Instant;
  billTo: string; vesselName: string; lines: ArLine[]; payments: ArPayment[];
}
export interface ArOptions { currency: string; termsDays: number }
export const LINE_LABELS: Record<string, string> = {
  PD: 'Port dues', WFC: 'Wharfage — containers', WFB: 'Wharfage — dry bulk', WFL: 'Wharfage — liquid bulk', WFR: 'Wharfage — RoRo', WF: 'Wharfage',
  TUG: 'Tug assistance', PIL: 'Pilotage', WTR: 'Fresh water', ANC: 'Anchorage', BH: 'Berth hire', GAR: 'Garbage', MOOR: 'Mooring', LH: 'Line handling', OTHER: 'Other services',
};
const D = 86_400_000;
const ms = (d: Instant) => (d == null || d === '' ? NaN : new Date(d).getTime());
const has = (d: Instant) => !Number.isNaN(ms(d));
const inWin = (d: Instant, from: number, to: number) => has(d) && ms(d) >= from && ms(d) < to;
const r2 = (n: number) => Math.round(n * 100) / 100;
const r1 = (n: number) => Math.round(n * 10) / 10;
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const isoOf = (d: Instant) => (has(d) ? new Date(ms(d)).toISOString() : null);
export const AGEING_BUCKETS = ['Current', '1–30', '31–60', '61–90', '90+'] as const;
export const bucketOf = (daysPastDue: number) => (daysPastDue <= 0 ? 'Current' : daysPastDue <= 30 ? '1–30' : daysPastDue <= 60 ? '31–60' : daysPastDue <= 90 ? '61–90' : '90+');

/** Payments an invoice had received by a moment. An invoice without itemised payments but marked paid counts its total from its paid date. */
const paidBy = (i: ArInvoice, asOf: number) => {
  if (i.payments?.length) return sum(i.payments.filter((p) => has(p.at) && ms(p.at) <= asOf).map((p) => Number(p.amount) || 0));
  return has(i.paidAt) && ms(i.paidAt) <= asOf ? Number(i.paidAmount) || 0 : 0;
};
const paymentsOf = (i: ArInvoice): ArPayment[] => (i.payments?.length ? i.payments : has(i.paidAt) && Number(i.paidAmount) > 0 ? [{ at: i.paidAt, amount: Number(i.paidAmount), method: 'TRANSFER' }] : []);

export function receivablesDashboard(invoices: ArInvoice[], now = new Date(), opts: ArOptions = { currency: 'AED', termsDays: 30 }) {
  const t = now.getTime();
  const d90 = t - 90 * D; const y12 = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1);
  const startMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1); const prevMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  const startYear = Date.UTC(now.getUTCFullYear(), 0, 1);
  const prevSameDays = Math.min(startMonth, prevMonth + (t - startMonth)); // month to date against the same days of last month
  const book = invoices.filter((i) => (i.status === 'ISSUED' || i.status === 'PAID') && has(i.issuedAt));
  const outstandingOf = (i: ArInvoice, asOf = t) => (has(i.issuedAt) && ms(i.issuedAt) <= asOf ? Math.max(0, Number(i.total) - paidBy(i, asOf)) : 0);
  const billed = (from: number, to: number) => r2(sum(book.filter((i) => inWin(i.issuedAt, from, to)).map((i) => Number(i.total))));
  const collected = (from: number, to: number) => r2(sum(book.flatMap(paymentsOf).filter((p) => inWin(p.at, from, to)).map((p) => Number(p.amount) || 0)));
  const arOf = (asOf: number) => r2(sum(book.map((i) => outstandingOf(i, asOf))));

  // --- the open book
  const open = book.filter((i) => outstandingOf(i) > 0);
  const overdue = open.filter((i) => has(i.dueAt) && ms(i.dueAt) < t);
  const ar = arOf(t);
  const ageing = AGEING_BUCKETS.map((bucket) => ({ bucket, count: 0, amount: 0 }));
  for (const i of open) { const days = has(i.dueAt) ? (t - ms(i.dueAt)) / D : 0; const b = ageing.find((x) => x.bucket === bucketOf(days))!; b.count += 1; b.amount = r2(b.amount + outstandingOf(i)); }

  // --- the ninety-day yardsticks
  const billed90 = billed(d90, t);
  const dsoDays = billed90 > 0 ? r1(ar / (billed90 / 90)) : null;
  const beginAr = arOf(d90); const endCurrentAr = r2(sum(open.filter((i) => !has(i.dueAt) || ms(i.dueAt) >= t).map((i) => outstandingOf(i))));
  const ceiDen = beginAr + billed90 - endCurrentAr;
  const ceiPct = ceiDen > 0 ? Math.max(0, Math.min(100, Math.round(((beginAr + billed90 - ar) / ceiDen) * 100))) : null;
  const settled90 = book.filter((i) => i.status === 'PAID' && inWin(i.paidAt, d90, t) && has(i.issuedAt));
  const daysToPay = settled90.map((i) => (ms(i.paidAt) - ms(i.issuedAt)) / D);
  const onTime = settled90.filter((i) => !has(i.dueAt) || ms(i.paidAt) <= ms(i.dueAt));

  // --- the year, month by month
  const byMonth = Array.from({ length: 12 }, (_, k) => {
    const from = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11 + k, 1); const to = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 10 + k, 1);
    const d = new Date(from);
    return { key: `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`, month: d.toLocaleString('en-GB', { month: 'short', year: '2-digit', timeZone: 'UTC' }), billed: billed(from, to), collected: collected(from, to), invoices: book.filter((i) => inWin(i.issuedAt, from, to)).length };
  });

  // --- where the money comes from
  const issued12 = book.filter((i) => inWin(i.issuedAt, y12, t));
  const lineMap = new Map<string, { code: string; label: string; amount: number; invoices: number }>();
  for (const i of issued12) {
    const seen = new Set<string>();
    for (const l of i.lines ?? []) {
      const code = String(l.code || 'OTHER').toUpperCase(); const acc = lineMap.get(code) ?? { code, label: LINE_LABELS[code] ?? String(l.description || code), amount: 0, invoices: 0 };
      acc.amount += Number(l.amount) || 0; if (!seen.has(code)) { acc.invoices += 1; seen.add(code); } lineMap.set(code, acc);
    }
  }
  const lineTotal = sum([...lineMap.values()].map((l) => l.amount));
  const byLine = [...lineMap.values()].map((l) => ({ ...l, amount: r2(l.amount), sharePct: pct(l.amount, lineTotal) })).sort((a, b) => b.amount - a.amount);
  const debtorMap = new Map<string, { name: string; invoices: number; billed: number; outstanding: number; overdue: number; daysToPay: number[] }>();
  for (const i of book) {
    const name = i.billTo || '—'; const acc = debtorMap.get(name) ?? { name, invoices: 0, billed: 0, outstanding: 0, overdue: 0, daysToPay: [] };
    if (inWin(i.issuedAt, y12, t)) { acc.invoices += 1; acc.billed += Number(i.total); if (i.status === 'PAID' && has(i.paidAt)) acc.daysToPay.push((ms(i.paidAt) - ms(i.issuedAt)) / D); }
    const o = outstandingOf(i); acc.outstanding += o; if (o > 0 && has(i.dueAt) && ms(i.dueAt) < t) acc.overdue += o;
    debtorMap.set(name, acc);
  }
  const debtors = [...debtorMap.values()].map((d) => ({ name: d.name, invoices: d.invoices, billed: r2(d.billed), outstanding: r2(d.outstanding), overdue: r2(d.overdue), avgDaysToPay: d.daysToPay.length ? r1(sum(d.daysToPay) / d.daysToPay.length) : null }))
    .sort((a, b) => b.outstanding - a.outstanding || b.billed - a.billed || a.name.localeCompare(b.name)).slice(0, 8);
  const methodMap = new Map<string, { method: string; count: number; amount: number }>();
  for (const p of book.flatMap(paymentsOf).filter((p) => inWin(p.at, y12, t))) { const m = String(p.method || 'TRANSFER').toUpperCase(); const acc = methodMap.get(m) ?? { method: m, count: 0, amount: 0 }; acc.count += 1; acc.amount += Number(p.amount) || 0; methodMap.set(m, acc); }
  const methods = [...methodMap.values()].map((m) => ({ ...m, amount: r2(m.amount) })).sort((a, b) => b.amount - a.amount);

  const drafts = invoices.filter((i) => i.status === 'DRAFT'); const cancelled12 = invoices.filter((i) => i.status === 'CANCELLED' && inWin(i.issuedAt ?? i.createdAt, y12, t));
  const overdueList = overdue.map((i) => ({ id: i.id, number: i.number, vesselName: i.vesselName, billTo: i.billTo, total: r2(Number(i.total)), outstanding: r2(outstandingOf(i)), dueAt: isoOf(i.dueAt), daysOverdue: Math.floor((t - ms(i.dueAt)) / D), reminded: has(i.remindedAt) }))
    .sort((a, b) => b.outstanding - a.outstanding || b.daysOverdue - a.daysOverdue).slice(0, 10);
  const billed12 = billed(y12, t); const collected12 = collected(y12, t);
  return {
    currency: opts.currency, termsDays: opts.termsDays,
    kpis: {
      billedMtd: billed(startMonth, t), billedPrevMonth: billed(prevMonth, prevSameDays), billedYtd: billed(startYear, t), billed12m: billed12,
      collectedMtd: collected(startMonth, t), collectedYtd: collected(startYear, t), collected12m: collected12,
      outstanding: ar, openInvoices: open.length, overdueAmount: r2(sum(overdue.map((i) => outstandingOf(i)))), overdueCount: overdue.length,
      dsoDays, ceiPct, avgDaysToPay: daysToPay.length ? r1(sum(daysToPay) / daysToPay.length) : null, paidOnTimePct: settled90.length ? pct(onTime.length, settled90.length) : null, settled90d: settled90.length,
      collectionRate12mPct: billed12 > 0 ? pct(collected12, billed12) : null,
      vatMtd: r2(sum(book.filter((i) => inWin(i.issuedAt, startMonth, t)).map((i) => Number(i.taxAmount) || 0))),
      remindersDue: overdue.filter((i) => !has(i.remindedAt)).length,
      drafts: { count: drafts.length, total: r2(sum(drafts.map((i) => Number(i.total)))), proforma: drafts.filter((i) => i.proforma).length },
      cancelled12m: { count: cancelled12.length, total: r2(sum(cancelled12.map((i) => Number(i.total)))) },
    },
    targets: { dsoDays: opts.termsDays + 10, ceiPct: 90, paidOnTimePct: 80, currentSharePct: 80 },
    ageing, byMonth, byLine, debtors, methods, overdueList,
    generatedAt: now.toISOString(),
  };
}
export type ReceivablesDashboard = ReturnType<typeof receivablesDashboard>;
