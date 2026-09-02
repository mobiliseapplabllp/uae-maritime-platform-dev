import { getJurisdiction } from '@maritime/contracts';
import { Prng, D, H, HIST_START, stableId, iso, yearOf, makeSeries } from './prng';
import type { WorldPortCall, WorldCargoOp } from './operations';
import type { WorldVessel } from './vessels';
import type { WorldCompany } from './organisations';

export interface WorldTariffRevision { effectiveFrom: string; rate: number; previousRate: number; changePct: number; circular: string; note: string }
export interface WorldTariff { id: string; code: string; name: string; nameAr?: string; category: 'MARINE' | 'CARGO' | 'MISC'; unit: string; rate: number; currency: string; active: boolean; revisions: WorldTariffRevision[] }
export interface WorldInvoiceLine { code: string; description: string; unit: string; qty: number; rate: number; amount: number }
export interface WorldCallService { type: string; tariffCode: string; description: string; qty: number; unit: string }
export interface WorldInvoice {
  id: string; number: string; portCallId: string; vcn: string; vesselId: string; vesselName: string;
  billTo: { companyId: string | null; name: string; address: string; taxId: string; taxIdLabel: string };
  lines: WorldInvoiceLine[]; subtotal: number; taxName: string; taxRatePct: number; taxAmount: number; total: number; currency: string;
  status: 'DRAFT' | 'ISSUED' | 'PAID' | 'CANCELLED'; issuedAt: string | null; dueAt: string | null; paidAt: string | null; paymentRef: string; notes: string; createdAt: string;
}

// code, name, Arabic name, category, unit, rate in AED, rate in INR (reference rate card)
const DEFS: [string, string, string, WorldTariff['category'], string, number, number][] = [
  ['PD', 'Port dues', 'رسوم الميناء', 'MARINE', 'per GRT', 0.6, 12.5],
  ['BH', 'Berth hire', 'رسوم شغل الرصيف', 'MARINE', 'per GRT per day', 0.2, 4.2],
  ['PIL', 'Pilotage (in/out)', 'الإرشاد البحري (دخول/خروج)', 'MARINE', 'per movement', 3800, 85000],
  ['TUG', 'Tug assistance', 'مساعدة القاطرات', 'MARINE', 'per tug-movement', 2800, 62000],
  ['ANC', 'Anchorage charges', 'رسوم المرساة', 'MARINE', 'per day', 1100, 25000],
  ['WFC', 'Wharfage — containers', 'رسوم الرصيف — الحاويات', 'CARGO', 'per TEU', 42, 950],
  ['WFB', 'Wharfage — dry bulk / break bulk', 'رسوم الرصيف — البضائع السائبة والعامة', 'CARGO', 'per MT', 5.2, 118],
  ['WFL', 'Wharfage — liquid bulk', 'رسوم الرصيف — السوائب السائلة', 'CARGO', 'per MT', 4.3, 96],
  ['WFR', 'Wharfage — ro-ro units', 'رسوم الرصيف — وحدات الدحرجة', 'CARGO', 'per unit', 65, 1450],
  ['WTR', 'Fresh water supply', 'إمداد المياه العذبة', 'MISC', 'per MT', 12, 260],
  ['GBG', 'Garbage reception (MARPOL)', 'استقبال النفايات (ماربول)', 'MISC', 'per call', 800, 18000],
];
export const tariffCircularRef = (year: number) => `TAR-CIRC/${year}`;
const roundRate = (n: number) => (n >= 1000 ? Math.round(n / 100) * 100 : n >= 100 ? Math.round(n) : Math.round(n * 100) / 100);

/** Rate card with one revision per tariff year, walked back from today's rate so the published history and the current figure can never disagree. */
export function buildTariffs(profile: string, now: Date): WorldTariff[] {
  const j = getJurisdiction(profile); const ae = j.code === 'AE';
  return DEFS.map(([code, name, nameAr, category, unit, aed, inr], ti) => {
    const rate = ae ? aed : inr; const revisions: WorldTariffRevision[] = []; let cur = rate;
    for (let y = now.getUTCFullYear(); y >= HIST_START.getUTCFullYear(); y--) {
      const effectiveFrom = new Date(Date.UTC(y, ae ? 0 : 3, 1)); // tariff year opens 1 January (AE) or 1 April (IN)
      if (effectiveFrom.getTime() > now.getTime()) continue;
      const pct = 4 + ((ti * 3 + y) % 5); const prev = roundRate(cur / (1 + pct / 100));
      revisions.push({ effectiveFrom: iso(effectiveFrom), rate: cur, previousRate: prev, changePct: pct, circular: tariffCircularRef(y), note: `Annual tariff revision — ${pct}% on ${name.toLowerCase()}` });
      cur = prev;
    }
    revisions.reverse();
    return { id: stableId('tariff', code), code, name, nameAr: ae ? nameAr : undefined, category, unit, rate, currency: j.currency.code, active: true, revisions };
  });
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
const toMinor = (n: number) => Math.round(n * 100);
/** Reference invoice maths: lines are rounded to 2 dp, then subtotal and tax are summed in integer minor units so totals never drift. */
export function computeTotals(raw: Omit<WorldInvoiceLine, 'amount'>[], taxRatePct: number) {
  const lines = raw.map((l) => ({ ...l, amount: round2(l.qty * l.rate) }));
  const subtotalM = lines.reduce((s, l) => s + toMinor(l.amount), 0);
  const taxM = Math.round((subtotalM * taxRatePct) / 100);
  return { lines, subtotal: subtotalM / 100, taxAmount: taxM / 100, total: (subtotalM + taxM) / 100 };
}
const LIQUID = /CRUDE|POL|EDIBLE|LNG|LPG|CHEMICAL/i;
export const wharfageCode = (op: WorldCargoOp) => (op.unit === 'TEU' ? 'WFC' : op.unit === 'UNITS' ? 'WFR' : LIQUID.test(op.cargoType) ? 'WFL' : 'WFB');
/** GRT-based port dues, chargeable services and wharfage from cargo operations. */
export function buildInvoiceLines(call: WorldPortCall, vessel: WorldVessel, services: WorldCallService[], tariffs: Record<string, WorldTariff>): Omit<WorldInvoiceLine, 'amount'>[] {
  const out: Omit<WorldInvoiceLine, 'amount'>[] = [];
  const push = (t: WorldTariff | undefined, qty: number, suffix?: string) => { if (!t || !qty) return; out.push({ code: t.code, description: suffix ? `${t.name} — ${suffix}` : t.name, unit: t.unit, qty, rate: t.rate }); };
  push(tariffs.PD, vessel.grt);
  for (const s of services) push(tariffs[s.tariffCode], s.qty, s.description);
  for (const c of call.cargoOps) push(tariffs[wharfageCode(c)], c.qty, c.cargoType);
  return out;
}
/** The marine services a call consumed: pilot in and out, tugs each way, berth hire, and the optional extras. */
export function servicesFor(rng: Prng, call: WorldPortCall, vessel: WorldVessel): WorldCallService[] {
  const waitedH = call.ata && call.atb ? (new Date(call.atb).getTime() - new Date(call.ata).getTime()) / H : 0;
  const stayDays = call.atb && call.atd ? Math.max(1, Math.ceil((new Date(call.atd).getTime() - new Date(call.atb).getTime()) / D)) : 1;
  const tugs = vessel.loa > 250 ? 3 : 2;
  const out: WorldCallService[] = [
    { type: 'PILOTAGE', tariffCode: 'PIL', description: 'Pilot in + out', qty: 2, unit: 'movement' },
    { type: 'TUGS', tariffCode: 'TUG', description: `${tugs} tugs x 2 movements`, qty: tugs * 2, unit: 'tug-movement' },
    { type: 'BERTH_HIRE', tariffCode: 'BH', description: `${stayDays} day(s) alongside`, qty: vessel.grt * stayDays, unit: 'GRT-day' },
  ];
  if (rng.chance(0.4)) out.push({ type: 'FRESH_WATER', tariffCode: 'WTR', description: 'Fresh water at berth', qty: rng.int(40, 160), unit: 'MT' });
  if (rng.chance(0.5)) out.push({ type: 'GARBAGE', tariffCode: 'GBG', description: 'MARPOL garbage reception', qty: 1, unit: 'call' });
  if (waitedH > 24) out.push({ type: 'ANCHORAGE', tariffCode: 'ANC', description: 'Anchorage stay', qty: Math.ceil(waitedH / 24), unit: 'day' });
  return out;
}

/** One invoice per sailed call of the fictional fleet; the documented liner callers are never billed. Status follows the invoice's age. */
export function buildInvoices(rng: Prng, profile: string, portCalls: WorldPortCall[], vessels: WorldVessel[], companies: WorldCompany[], tariffs: WorldTariff[], now: Date, settleForVesselId: string | null): WorldInvoice[] {
  const j = getJurisdiction(profile); const ae = j.code === 'AE';
  const byCode = Object.fromEntries(tariffs.map((t) => [t.code, t]));
  const vById = new Map(vessels.map((v) => [v.id, v]));
  const agentByCode = new Map(companies.map((c) => [c.code, c]));
  const seq = makeSeries(); const out: WorldInvoice[] = [];
  const sailed = portCalls.filter((c) => c.status === 'SAILED' && c.atd).sort((a, b) => a.atd!.localeCompare(b.atd!));
  for (const call of sailed) {
    const v = vById.get(call.vesselId); if (!v || v.real) continue;
    const totals = computeTotals(buildInvoiceLines(call, v, servicesFor(rng, call, v), byCode), j.tax.ratePct);
    const issuedAt = new Date(new Date(call.atd!).getTime() + 2 * D); const y = yearOf(issuedAt);
    const ageD = (now.getTime() - issuedAt.getTime()) / D; const payLag = rng.int(7, 30);
    // an invoice can only be PAID once its payment lag has actually elapsed
    const status: WorldInvoice['status'] = ageD > 45 ? 'PAID' : ageD > payLag ? (rng.chance(0.6) ? 'PAID' : 'ISSUED') : ageD > 5 ? 'ISSUED' : 'DRAFT';
    const agent = agentByCode.get(call.agentCode); const paidAt = status === 'PAID' ? new Date(issuedAt.getTime() + payLag * D) : null;
    out.push({
      id: stableId('invoice', call.id), number: `${j.tax.invoicePrefix}/${y}/${seq(String(y))}`, portCallId: call.id, vcn: call.vcn, vesselId: v.id, vesselName: v.name,
      billTo: { companyId: agent?.id ?? null, name: agent?.name ?? call.agentCode, address: agent?.address ?? '', taxId: agent?.taxId ?? '', taxIdLabel: j.tax.registrationLabel },
      lines: totals.lines, subtotal: totals.subtotal, taxName: j.tax.name, taxRatePct: j.tax.ratePct, taxAmount: totals.taxAmount, total: totals.total, currency: j.currency.code,
      status, issuedAt: status === 'DRAFT' ? null : iso(issuedAt), dueAt: status === 'DRAFT' ? null : iso(issuedAt.getTime() + 30 * D), paidAt: paidAt ? iso(paidAt) : null,
      paymentRef: paidAt ? `${ae ? 'FT' : 'NEFT'}-${rng.int(100000, 999999)}` : '', notes: '', createdAt: iso(issuedAt),
    });
  }
  // the cancellation path, exercised: the two oldest still-issued invoices were disputed and cancelled — a paid invoice can never be cancelled
  out.filter((d) => d.status === 'ISSUED').slice(0, 2).forEach((d) => { d.status = 'CANCELLED'; d.paidAt = null; d.paymentRef = ''; d.notes = 'Disputed by the agent — cancelled and re-raised'; });
  // an owner does not get a ship off the register while it still owes the port money, so the closure applicant's account is settled before lodging
  for (const d of out) if (settleForVesselId && d.vesselId === settleForVesselId && d.status === 'ISSUED') { d.status = 'PAID'; d.paidAt = iso(now.getTime() - 16 * D); d.paymentRef = `${ae ? 'FT' : 'NEFT'}/${now.getUTCFullYear()}/CLS-${vById.get(d.vesselId)?.imo}`; }
  return out;
}
