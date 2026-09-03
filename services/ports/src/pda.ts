import { getJurisdiction } from '@maritime/contracts';
import type { CallApi, PdaLine } from './calls';
import type { TariffHead } from './subjects';
import { DAY } from './history';

/* Pro-forma disbursement account: the pre-arrival cost estimate an agent carries, priced off the same rate card the invoice
 * will use. Amounts are rounded to two decimals per line, then summed in integer minor units so the total never drifts. */
export const round2 = (n: number) => Math.round(n * 100) / 100;
const toMinor = (n: number) => Math.round(n * 100);

export function computeTotals(raw: Omit<PdaLine, 'amount'>[], taxRatePct: number) {
  const lines: PdaLine[] = raw.map((l) => ({ ...l, amount: round2(l.qty * l.rate) }));
  const subtotalM = lines.reduce((s, l) => s + toMinor(l.amount), 0);
  const taxM = Math.round((subtotalM * taxRatePct) / 100);
  return { lines, subtotal: subtotalM / 100, taxAmount: taxM / 100, total: (subtotalM + taxM) / 100 };
}

const LIQUID = /CRUDE|POL|EDIBLE|LNG|LPG|CHEMICAL/i;
/** Which wharfage head a cargo parcel falls under: containers by TEU, ro-ro by unit, then liquid or dry bulk by commodity. */
export const wharfageCode = (op: { unit: string; cargoType: string }) => (op.unit === 'TEU' ? 'WFC' : op.unit === 'UNITS' ? 'WFR' : LIQUID.test(String(op.cargoType)) ? 'WFL' : 'WFB');

/** Lines already known from the call: GRT-based port dues, the services booked against it and wharfage on each cargo parcel. */
export function knownLines(call: CallApi, tariffs: Record<string, TariffHead>): Omit<PdaLine, 'amount'>[] {
  const out: Omit<PdaLine, 'amount'>[] = [];
  const push = (t: TariffHead | undefined, qty: number, suffix?: string) => { if (!t || !qty) return; out.push({ code: t.code, description: suffix ? `${t.name} — ${suffix}` : t.name, unit: t.unit, qty, rate: t.rate }); };
  if (call.vesselGrt) push(tariffs.PD, call.vesselGrt);
  for (const s of call.services) push(tariffs[s.tariffCode], s.qty || 1, s.description);
  for (const c of call.cargoOps) push(tariffs[wharfageCode(c)], c.qty, c.cargoType);
  return out;
}

export interface EstimateBasis { grt: number; plannedDays: number; tugs: number }
/** Tugs a call needs each way — the harbour rule of thumb, by length overall. */
export const tugsFor = (loa: number | null | undefined, over = 3, under = 2) => ((loa ?? 0) >= 250 ? over : under);
export function basisOf(call: CallApi, o: { tugsOver250?: number; tugsUnder250?: number } = {}): EstimateBasis {
  const grt = call.vesselGrt ?? 0;
  const plannedDays = call.etb && call.etd ? Math.max(1, Math.ceil((new Date(call.etd).getTime() - new Date(call.etb).getTime()) / DAY)) : 2;
  return { grt, plannedDays, tugs: tugsFor(call.vesselLoa, o.tugsOver250, o.tugsUnder250) };
}

/** The estimate: what the call already carries, then the standard pre-arrival heads every account shows. */
export function buildEstimate(call: CallApi, tariffs: Record<string, TariffHead>, jurisdiction: string) {
  const j = getJurisdiction(jurisdiction);
  const basis = basisOf(call);
  const raw = knownLines(call, tariffs);
  const have = new Set(raw.map((l) => l.code));
  const add = (code: string, qty: number, suffix: string) => { const t = tariffs[code]; if (!t || !qty || have.has(code)) return; raw.push({ code: t.code, description: `${t.name} — ${suffix}`, unit: t.unit, qty, rate: t.rate }); have.add(code); };
  add('PIL', 2, 'inward + outward');
  add('TUG', basis.tugs * 2, `${basis.tugs} tugs × 2 movements`);
  add('BH', basis.grt * basis.plannedDays, `${basis.plannedDays} days alongside (planned)`);
  const totals = computeTotals(raw, j.tax.ratePct);
  return { ...totals, taxRate: j.tax.ratePct, taxName: j.tax.name, currency: j.currency.code, basis };
}

export interface VarianceLine { code: string; estimated: number; actual: number; delta: number }
/** The estimate against the invoice that closed the call — the reconciliation every agent runs. */
export function variance(pdaLines: PdaLine[], invoice: { number: string; lines: PdaLine[]; total: number } | null, estimatedTotal: number) {
  if (!invoice) return null;
  const codes = new Set([...pdaLines.map((l) => l.code), ...invoice.lines.map((l) => l.code)]);
  const sum = (list: PdaLine[], code: string) => round2(list.filter((l) => l.code === code).reduce((s, l) => s + Number(l.amount || 0), 0));
  return {
    lines: [...codes].map((code) => { const estimated = sum(pdaLines, code); const actual = sum(invoice.lines, code); return { code, estimated, actual, delta: round2(actual - estimated) }; }),
    estimatedTotal, actualTotal: Number(invoice.total), delta: round2(Number(invoice.total) - estimatedTotal), invoiceNumber: invoice.number,
  };
}
