import { randomUUID } from 'node:crypto';
import { NATIONAL_SCOPE, type TenancyScope, EVENTS, getJurisdiction, makeEvent, type Actor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, badRequest, conflict, enqueue, eventFromContext, nextNumber, type Queryable, scopeWhere, recordScope } from '@maritime/service-kit';
import { INVOICE_SCOPE } from './scope';
import type { Env } from './env';

/* The invoice row, the maths that raises one from a vessel call, and the snapshot every write publishes.
 * Money is computed in integer minor units and stored to two decimals, so a total can never drift from its lines. */
export const round2 = (n: number) => Math.round(n * 100) / 100;
const toMinor = (n: number) => Math.round(n * 100);
export const iso = (d: Date | string | null | undefined): string | null => (d == null || d === '' ? null : new Date(d).toISOString());
export const num = (v: unknown): number => (v == null || v === '' ? 0 : Number(v));

export const INVOICE_STATUSES = ['DRAFT', 'ISSUED', 'PAID', 'CANCELLED'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];
export const PAYMENT_METHODS = ['TRANSFER', 'CARD', 'CHEQUE', 'CASH', 'ADJUSTMENT'] as const;

export interface Line { code: string; description: string; unit: string; qty: number; rate: number; amount: number }
export interface BillTo { companyId: string | null; name: string; address: string; taxId: string; taxIdLabel: string }
export interface Payment { id: string; at: string; amount: number; ref: string; method: string; by: string; note: string }
export interface HistoryEntry { from: string; to: string; at: string; by: string; note: string }
/** The payment gateway's intent for an invoice, as last heard. */
export interface PaymentIntent { reference: string; status: string; redirectUrl?: string | null; amountMinor: number; currency: string; createdAt: string; updatedAt: string; mode: string; callId?: string; settledAt?: string | null; method?: string | null }
export interface Row {
  /** Tenancy partition, projected into the read models so reporting enforces the same predicate. */ scope_company: string;
  id: string; number: string; port_call_id: string | null; vcn: string; vessel_id: string | null; vessel_name: string; vessel_imo: string;
  bill_to: BillTo; lines: Line[]; subtotal: string | number; tax_name: string; tax_rate_pct: string | number; tax_amount: string | number; total: string | number; currency: string;
  status: string; proforma: boolean; issued_at: Date | null; due_at: Date | null; paid_at: Date | null; paid_amount: string | number; payment_ref: string;
  payments: Payment[]; cancel_reason: string; notes: string; history: HistoryEntry[]; reminded_at: Date | null; payment_intent: PaymentIntent | null; created_at: Date; updated_at: Date;
}

/** Lines rounded to two decimals, then subtotal and tax summed in minor units. */
export function computeTotals(raw: Omit<Line, 'amount'>[], taxRatePct: number) {
  const lines: Line[] = raw.map((l) => ({ ...l, amount: round2(l.qty * l.rate) }));
  const subtotalM = lines.reduce((s, l) => s + toMinor(l.amount), 0);
  const taxM = Math.round((subtotalM * taxRatePct) / 100);
  return { lines, subtotal: subtotalM / 100, taxAmount: taxM / 100, total: (subtotalM + taxM) / 100 };
}

const LIQUID = /CRUDE|POL|EDIBLE|LNG|LPG|CHEMICAL/i;
/** Wharfage head for a cargo parcel: containers by TEU, ro-ro by unit, then liquid or dry bulk by commodity. */
export const wharfageCode = (op: { unit: string; cargoType: string }) => (op.unit === 'TEU' ? 'WFC' : op.unit === 'UNITS' ? 'WFR' : LIQUID.test(String(op.cargoType)) ? 'WFL' : 'WFB');

export interface TariffHead { code: string; name: string; unit: string; rate: number; currency: string }
export interface CallService { type?: string; tariffCode?: string; description?: string; qty?: number; unit?: string }
export interface CallCargoOp { cargoType: string; operation?: string; qty: number; unit: string }
export interface BillableCall { vcn: string; vesselName: string; grt?: number | null; loa?: number | null; services?: CallService[]; cargoOps?: CallCargoOp[]; atb?: string | null; atd?: string | null; ata?: string | null }

export const DAY = 24 * 3600_000;
/** Days alongside, at least one — berth hire is charged per GRT per day. */
export const daysAlongside = (call: BillableCall) => (call.atb && call.atd ? Math.max(1, Math.ceil((new Date(call.atd).getTime() - new Date(call.atb).getTime()) / DAY)) : 1);
export const waitingHours = (call: BillableCall) => (call.ata && call.atb ? (new Date(call.atb).getTime() - new Date(call.ata).getTime()) / 3600_000 : 0);
export const tugsFor = (loa: number | null | undefined) => ((loa ?? 0) > 250 ? 3 : 2);

/** The marine services a call consumed when the harbour desk booked none: pilotage in and out, tugs each way, berth hire, and anchorage where she waited. */
export function impliedServices(call: BillableCall): CallService[] {
  const tugs = tugsFor(call.loa); const days = daysAlongside(call); const waited = waitingHours(call);
  const out: CallService[] = [
    { type: 'PILOTAGE', tariffCode: 'PIL', description: 'Pilot in + out', qty: 2, unit: 'movement' },
    { type: 'TUGS', tariffCode: 'TUG', description: `${tugs} tugs x 2 movements`, qty: tugs * 2, unit: 'tug-movement' },
    { type: 'BERTH_HIRE', tariffCode: 'BH', description: `${days} day(s) alongside`, qty: (call.grt ?? 0) * days, unit: 'GRT-day' },
  ];
  if (waited > 24) out.push({ type: 'ANCHORAGE', tariffCode: 'ANC', description: 'Anchorage stay', qty: Math.ceil(waited / 24), unit: 'day' });
  return out;
}

/** GRT-based port dues, then the chargeable services, then wharfage on every cargo parcel. */
export function buildLines(call: BillableCall, tariffs: Record<string, TariffHead>, opts: { implyServices?: boolean } = {}): Omit<Line, 'amount'>[] {
  const out: Omit<Line, 'amount'>[] = [];
  const push = (t: TariffHead | undefined, qty: number, suffix?: string) => { if (!t || !qty) return; out.push({ code: t.code, description: suffix ? `${t.name} — ${suffix}` : t.name, unit: t.unit, qty, rate: t.rate }); };
  if (call.grt) push(tariffs.PD, call.grt);
  const services = call.services?.length ? call.services : opts.implyServices ? impliedServices(call) : [];
  for (const s of services) push(s.tariffCode ? tariffs[s.tariffCode] : undefined, s.qty ?? 1, s.description);
  for (const c of call.cargoOps ?? []) push(tariffs[wharfageCode(c)], c.qty, c.cargoType);
  return out;
}

export function toApi(r: Row) {
  const total = num(r.total); const paid = num(r.paid_amount);
  return {
    id: r.id, number: r.number, portCallId: r.port_call_id, vcn: r.vcn, vesselId: r.vessel_id, vesselName: r.vessel_name, vesselImo: r.vessel_imo,
    billTo: r.bill_to ?? { companyId: null, name: '', address: '', taxId: '', taxIdLabel: '' }, lines: r.lines ?? [],
    subtotal: num(r.subtotal), taxName: r.tax_name, taxRatePct: num(r.tax_rate_pct), taxAmount: num(r.tax_amount), total, currency: r.currency,
    status: r.status as InvoiceStatus, proforma: r.proforma, issuedAt: iso(r.issued_at), dueAt: iso(r.due_at), paidAt: iso(r.paid_at),
    paidAmount: paid, balance: round2(total - paid), paymentRef: r.payment_ref, payments: r.payments ?? [], cancelReason: r.cancel_reason, notes: r.notes,
    history: r.history ?? [], overdue: r.status === 'ISSUED' && !!r.due_at && r.due_at.getTime() < Date.now(), paymentIntent: r.payment_intent ?? null,
    createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  };
}
export type InvoiceApi = ReturnType<typeof toApi>;

/* Every handler that touches one invoice comes through here, so the tenancy filter is here and not in each
 * of them: another party's invoice is not found rather than found and refused. */
export async function findInvoice(c: Queryable, ref: string, scope: TenancyScope): Promise<Row | null> {
  const where = ['(id::text = $1 OR number = $1)']; const args: unknown[] = [ref];
  scopeWhere(scope, where, args, INVOICE_SCOPE);
  const r = await c.query<Row>(`SELECT * FROM invoices WHERE ${where.join(' AND ')}`, args);
  return r.rows[0] ?? null;
}
export async function lockInvoice(c: Queryable, ref: string, scope: TenancyScope): Promise<Row | null> {
  const where = ['(id::text = $1 OR number = $1)']; const args: unknown[] = [ref];
  scopeWhere(scope, where, args, INVOICE_SCOPE);
  const l = await c.query<{ id: string }>(`SELECT id FROM invoices WHERE ${where.join(' AND ')} FOR UPDATE`, args);
  return l.rows[0] ? findInvoice(c, l.rows[0].id, scope) : null;
}
const COLS: Record<string, string> = { number: 'number', portCallId: 'port_call_id', vcn: 'vcn', vesselId: 'vessel_id', vesselName: 'vessel_name', vesselImo: 'vessel_imo', billTo: 'bill_to', lines: 'lines', subtotal: 'subtotal', taxName: 'tax_name', taxRatePct: 'tax_rate_pct', taxAmount: 'tax_amount', total: 'total', currency: 'currency', status: 'status', proforma: 'proforma', issuedAt: 'issued_at', dueAt: 'due_at', paidAt: 'paid_at', paidAmount: 'paid_amount', paymentRef: 'payment_ref', payments: 'payments', cancelReason: 'cancel_reason', notes: 'notes', history: 'history', remindedAt: 'reminded_at', paymentIntent: 'payment_intent' };
export type Patch = Partial<{ number: string; portCallId: string | null; vcn: string; vesselId: string | null; vesselName: string; vesselImo: string; billTo: BillTo; lines: Line[]; subtotal: number; taxName: string; taxRatePct: number; taxAmount: number; total: number; currency: string; status: string; proforma: boolean; issuedAt: Date | null; dueAt: Date | null; paidAt: Date | null; paidAmount: number; paymentRef: string; payments: Payment[]; cancelReason: string; notes: string; history: HistoryEntry[]; remindedAt: Date | null; paymentIntent: PaymentIntent | null }>;
export async function updateInvoice(c: Queryable, id: string, patch: Patch): Promise<Row> {
  const keys = Object.keys(patch).filter((k) => COLS[k] && (patch as Record<string, unknown>)[k] !== undefined);
  if (keys.length) {
    const vals = keys.map((k) => { const v = (patch as Record<string, unknown>)[k]; return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v; });
    // nosemgrep: maritime-sql-template-interpolation — column names come from a server-side map; every value is a parameter
    await c.query(`UPDATE invoices SET ${keys.map((k, i) => `${COLS[k]} = $${i + 2}`).concat('updated_at = now()').join(', ')} WHERE id = $1`, [id, ...vals]);
  }
  return (await findInvoice(c, id, NATIONAL_SCOPE))!;
}
export interface NewInvoice { number: string; portCallId: string | null; vcn: string; vesselId: string | null; vesselName: string; vesselImo: string; billTo: BillTo; lines: Line[]; subtotal: number; taxName: string; taxRatePct: number; taxAmount: number; total: number; currency: string; status?: string; proforma?: boolean; notes?: string; history: HistoryEntry[]; createdAt?: Date }
export async function insertInvoice(c: Queryable, n: NewInvoice): Promise<Row> {
  const r = await c.query<{ id: string }>(`INSERT INTO invoices(number, port_call_id, vcn, vessel_id, vessel_name, vessel_imo, bill_to, lines, subtotal, tax_name, tax_rate_pct, tax_amount, total, currency, status, proforma, notes, history, created_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,COALESCE($19, now())) RETURNING id`,
    [n.number, n.portCallId, n.vcn, n.vesselId, n.vesselName, n.vesselImo, JSON.stringify(n.billTo), JSON.stringify(n.lines), n.subtotal, n.taxName, n.taxRatePct, n.taxAmount, n.total, n.currency, n.status ?? 'DRAFT', n.proforma ?? false, n.notes ?? '', JSON.stringify(n.history), n.createdAt ?? null]);
  return (await findInvoice(c, r.rows[0].id, NATIONAL_SCOPE))!;
}
/** `${prefix}-YYYY-NNNNN`: one atomic series per calendar year. */
export async function nextInvoiceNumber(c: Queryable, env: Env, when: Date): Promise<string> {
  const series = `${env.INVOICE_PREFIX}-${when.getUTCFullYear()}`; return nextNumber(c, series, `${series}-`, 5);
}
export const newId = () => randomUUID();
export const taxOf = (jurisdiction: string) => { const j = getJurisdiction(jurisdiction); return { name: j.tax.name, ratePct: j.tax.ratePct, registrationLabel: j.tax.registrationLabel, currency: j.currency.code }; };

/** Every write publishes the API-shaped snapshot first, then the business event. */
export async function publishState(c: Queryable, env: Env, r: Row, opts: { event?: string; data?: Record<string, unknown>; cause?: EventEnvelope; actor?: Actor } = {}) {
  const entity = toApi(r);
  const mk = <T,>(type: string, data: T) => (opts.cause ? makeEvent({ type, source: env.SERVICE_NAME, data, subject: r.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor }) : eventFromContext(env.SERVICE_NAME, type, data, { subject: r.id, actor: opts.actor }));
  await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'invoice', entity: { ...entity, scope: recordScope(r) } }));
  if (opts.event) await enqueue(c, mk(opts.event, { invoiceId: r.id, number: r.number, portCallId: r.port_call_id, vcn: r.vcn, vesselId: r.vessel_id, vesselName: r.vessel_name, billToName: entity.billTo.name, status: r.status, subtotal: entity.subtotal, taxAmount: entity.taxAmount, total: entity.total, currency: r.currency, invoice: entity, ...(opts.data ?? {}) }));
}
export async function publishDeleted(c: Queryable, env: Env, r: Row) {
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.deleted, { kind: 'invoice', id: r.id }, { subject: r.id }));
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.revenue.invoiceDeleted, { invoiceId: r.id, number: r.number, portCallId: r.port_call_id, vcn: r.vcn }, { subject: r.id }));
}

/* ------------------------------------------------------------------------------------- settlement --- */
export interface SettleInput { amount?: number; ref: string; method: string; by: string; note: string; at?: string | Date | null }
/** A payment, in part or in full, applied to an issued account. The one place money is recorded, whoever brings it —
 *  a clerk at the counter or the gateway's callback. The account settles only when what has been received covers it. */
export async function settle(c: Queryable, env: Env, audit: AuditClient, before: Row, p: SettleInput): Promise<Row> {
  if (before.status !== 'ISSUED') throw conflict(`Only an issued invoice can be paid — this one is ${before.status.toLowerCase()}`);
  const total = num(before.total); const already = num(before.paid_amount);
  const outstanding = round2(total - already);
  const amount = round2(p.amount ?? outstanding);
  if (amount <= 0) throw badRequest('A payment must be greater than zero');
  if (amount > outstanding + 0.005) throw badRequest(`That is more than the ${round2(outstanding)} outstanding on this invoice`);
  const at = p.at && !Number.isNaN(new Date(p.at).getTime()) ? new Date(p.at) : new Date();
  const payment: Payment = { id: newId(), at: at.toISOString(), amount, ref: p.ref, method: p.method, by: p.by, note: p.note };
  const paid = round2(already + amount); const settled = paid >= total - 0.005;
  const history: HistoryEntry[] = [...(before.history ?? []), { from: before.status, to: settled ? 'PAID' : 'ISSUED', at: at.toISOString(), by: payment.by, note: `${settled ? 'Settled' : 'Part payment'} ${amount}${payment.ref ? ` — ${payment.ref}` : ''}` }];
  const row = await updateInvoice(c, before.id, { payments: [...(before.payments ?? []), payment], paidAmount: paid, paymentRef: payment.ref || before.payment_ref, status: settled ? 'PAID' : 'ISSUED', paidAt: settled ? at : null, history });
  await audit.record(c, { action: 'PAY', entity: 'Invoice', entityId: row.id, entityLabel: `${row.number} — ${payment.ref || 'no ref'}`, before: { status: before.status, paidAmount: already }, after: { status: row.status, paidAmount: paid }, note: `${amount} received` });
  await publishState(c, env, row, { event: EVENTS.revenue.paymentReceived, data: { amount, paidAmount: paid, balance: round2(total - paid), settled, paymentRef: payment.ref, method: payment.method } });
  if (settled) await publishState(c, env, row, { event: EVENTS.revenue.invoicePaid, data: { paidAt: iso(row.paid_at), paymentRef: payment.ref } });
  return row;
}

/** What the gateway said about an intent, recorded on the invoice; a settlement pays the balance once, however many times it is heard. */
export async function applySettlement(c: Queryable, env: Env, audit: AuditClient, before: Row, s: { status: string; settledAt?: string | null; method?: string | null; mode?: string; by: string }): Promise<Row> {
  const intent = before.payment_intent; if (!intent?.reference) return before;
  const status = String(s.status || intent.status).toUpperCase();
  const next: PaymentIntent = { ...intent, status, settledAt: s.settledAt ?? intent.settledAt ?? null, method: s.method ?? intent.method ?? null, mode: s.mode ?? intent.mode, updatedAt: new Date().toISOString() };
  let row = await updateInvoice(c, before.id, { paymentIntent: next });
  const alreadySettled = (before.payments ?? []).some((p) => p.ref === intent.reference);
  if (status === 'SETTLED' && before.status === 'ISSUED' && !alreadySettled) {
    row = await settle(c, env, audit, row, { ref: intent.reference, method: 'GATEWAY', by: s.by, note: `Settled by the payment gateway${s.method ? ` (${s.method})` : ''}`, at: s.settledAt ?? null });
  }
  return row;
}
