import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, getJurisdiction, type PageQuery } from '@maritime/contracts';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, badRequest, conflict, escapeLike, notFound, paged, parsePage, withTx, zod, type Principal, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { INVOICE_STATUSES, PAYMENT_METHODS, buildLines, computeTotals, findInvoice, insertInvoice, iso, lockInvoice, newId, nextInvoiceNumber, num, publishDeleted, publishState, round2, toApi, updateInvoice, type HistoryEntry, type Line, type Payment, type Row } from './invoicing';
import { activeTariffs, billToFor, billableCall, findCallSnapshot } from './subjects';

/* Invoices raised on vessel calls. One live account per call — a cancelled one can be re-raised, an open one cannot be
 * duplicated. Draft is editable, issued is not; payments may arrive in parts and the account settles when they cover it. */
const text = (max: number) => z.string().trim().max(max);
const lineSchema = z.object({ code: text(30).default(''), description: text(300).min(1), unit: text(60).default(''), qty: z.coerce.number().min(0).max(1e9), rate: z.coerce.number().min(0).max(1e9) });
const generateSchema = z.object({ portCallId: text(80).min(1), notes: text(2000).optional(), issue: z.coerce.boolean().optional() });
const updateSchema = z.object({ lines: z.array(lineSchema).optional(), notes: text(2000).optional(), billTo: z.object({ companyId: text(80).optional().nullable(), name: text(200).optional(), address: text(400).optional(), taxId: text(40).optional(), taxIdLabel: text(40).optional() }).optional(), dueAt: z.string().optional() });
const paySchema = z.object({ amount: z.coerce.number().positive().max(1e12).optional(), paymentRef: text(80).optional(), method: z.enum(PAYMENT_METHODS).optional(), at: z.string().optional(), note: text(500).optional() });
const cancelSchema = z.object({ reason: text(500).optional() });
const SORT: Record<string, string> = { createdAt: 'created_at', number: 'number', total: 'total', status: 'status', issuedAt: 'issued_at', dueAt: 'due_at', paidAt: 'paid_at', vesselName: 'vessel_name', vcn: 'vcn' };
type ListQuery = PageQuery & { status?: string; vessel?: string; vesselId?: string; portCall?: string; portCallId?: string; vcn?: string; from?: string; to?: string; overdue?: string; proforma?: string };

@Controller('invoices')
export class InvoicesController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  @RequirePerm('invoices.view') @Get()
  async list(@Query() query: ListQuery) {
    const p = parsePage(query, { defaultSort: '-createdAt', sortable: Object.keys(SORT), maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    const eq = (col: string, v: string | undefined) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
    eq('status', query.status); eq('vessel_id', query.vessel || query.vesselId); eq('port_call_id', query.portCall || query.portCallId); eq('vcn', query.vcn);
    if (query.proforma === 'true' || query.proforma === 'false') { args.push(query.proforma === 'true'); where.push(`proforma = $${args.length}`); }
    if (query.overdue === 'true') where.push("status = 'ISSUED' AND due_at IS NOT NULL AND due_at < now()");
    if (query.from) { args.push(new Date(query.from)); where.push(`COALESCE(issued_at, created_at) >= $${args.length}`); }
    if (query.to) { args.push(new Date(query.to)); where.push(`COALESCE(issued_at, created_at) <= $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(number ILIKE $${args.length} OR vcn ILIKE $${args.length} OR vessel_name ILIKE $${args.length} OR bill_to->>'name' ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM invoices ${w}`, args);
    const rows = await this.pool.query<Row>(`SELECT * FROM invoices ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, number LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(toApi), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  /** What the finance desk is owed, and how the book splits by status. */
  @RequirePerm('invoices.view') @Get('summary')
  async summary() {
    const j = getJurisdiction(this.env.JURISDICTION);
    const rows = await this.pool.query<{ status: string; n: string; total: string; paid: string }>('SELECT status, count(*) AS n, COALESCE(sum(total),0) AS total, COALESCE(sum(paid_amount),0) AS paid FROM invoices GROUP BY status');
    const overdue = await this.pool.query<{ n: string; total: string }>("SELECT count(*) AS n, COALESCE(sum(total - paid_amount),0) AS total FROM invoices WHERE status = 'ISSUED' AND due_at IS NOT NULL AND due_at < now()");
    const byStatus = Object.fromEntries(rows.rows.map((r) => [r.status, { count: Number(r.n), total: round2(Number(r.total)), paid: round2(Number(r.paid)) }]));
    const billed = rows.rows.filter((r) => r.status !== 'CANCELLED').reduce((s, r) => s + Number(r.total), 0);
    const collected = rows.rows.filter((r) => r.status !== 'CANCELLED').reduce((s, r) => s + Number(r.paid), 0);
    return { currency: j.currency.code, taxName: j.tax.name, byStatus, billed: round2(billed), collected: round2(collected), outstanding: round2(billed - collected), collectionPct: billed ? Math.round((collected / billed) * 1000) / 10 : 0, overdue: { count: Number(overdue.rows[0].n), amount: round2(Number(overdue.rows[0].total)) } };
  }

  @RequirePerm('invoices.view') @Get('meta')
  meta() { const j = getJurisdiction(this.env.JURISDICTION); return { statuses: INVOICE_STATUSES, paymentMethods: PAYMENT_METHODS, currency: j.currency, tax: j.tax, paymentTermsDays: this.env.PAYMENT_TERMS_DAYS }; }

  /** The pro-forma estimate for a call that has not sailed: the same maths the final account will use, nothing written. */
  @RequirePerm('invoices.view') @Get('proforma')
  async proforma(@Query('portCallId') portCallId?: string) {
    if (!portCallId) throw badRequest('portCallId is required');
    const snap = await findCallSnapshot(this.pool, portCallId); if (!snap) throw notFound('Port call not found');
    const call = await billableCall(this.pool, snap);
    const tariffs = await activeTariffs(this.pool);
    const j = getJurisdiction(this.env.JURISDICTION);
    const raw = buildLines(call, tariffs, { implyServices: true });
    if (!raw.length) throw badRequest('Nothing to estimate on this call yet — the vessel needs a GRT, services or cargo');
    const totals = computeTotals(raw, j.tax.ratePct);
    const existing = await this.pool.query<{ id: string; number: string; status: string; total: string }>("SELECT id, number, status, total FROM invoices WHERE port_call_id = $1 AND status <> 'CANCELLED' LIMIT 1", [snap.id]);
    return {
      call: { id: snap.id, vcn: snap.vcn, status: snap.status, vesselId: snap.vessel_id, vesselName: call.vesselName, agentName: snap.agent_name, eta: iso(snap.eta), etb: iso(snap.etb), etd: iso(snap.etd), atb: iso(snap.atb), atd: iso(snap.atd) },
      ...totals, taxName: j.tax.name, taxRatePct: j.tax.ratePct, currency: j.currency.code,
      basis: { grt: call.grt ?? 0, loa: call.loa ?? 0, daysAlongside: call.atb && call.atd ? Math.max(1, Math.ceil((new Date(call.atd).getTime() - new Date(call.atb).getTime()) / 86400000)) : 1, servicesBooked: (snap.services ?? []).length, cargoParcels: (snap.cargo_ops ?? []).length },
      invoice: existing.rows[0] ? { id: existing.rows[0].id, number: existing.rows[0].number, status: existing.rows[0].status, total: Number(existing.rows[0].total) } : null,
    };
  }

  @RequirePerm('invoices.view') @Get(':id')
  async get(@Param('id') id: string) {
    const row = await findInvoice(this.pool, id); if (!row) throw notFound('Invoice not found');
    return this.detail(this.pool, row);
  }

  /** The account with the ship's particulars and the call it closed, as the invoice page draws them. */
  private async detail(c: Queryable, row: Row) {
    const inv = toApi(row);
    const vessel = row.vessel_id ? (await c.query<{ id: string; name: string; imo: string; flag: string; grt: number | null }>('SELECT id, name, imo, flag, grt FROM vessels WHERE id = $1', [row.vessel_id])).rows[0] : undefined;
    const call = row.port_call_id ? (await c.query<{ id: string; vcn: string; eta: Date | null; atd: Date | null; agent_name: string; berth_code: string | null; status: string }>('SELECT id, vcn, eta, atd, agent_name, berth_code, status FROM port_calls WHERE id = $1', [row.port_call_id])).rows[0] : undefined;
    return { ...inv, vessel: vessel ?? null, portCall: call ? { id: call.id, vcn: call.vcn, eta: iso(call.eta), atd: iso(call.atd), agentName: call.agent_name, berthCode: call.berth_code, status: call.status } : null };
  }

  /** Raise the account for a call. Idempotent by the one-live-invoice-per-call rule; a cancelled account may be re-raised. */
  @RequirePerm('invoices.create') @Post('generate')
  async generate(@Body(zod(generateSchema)) b: z.infer<typeof generateSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const row = await raiseForCall(c, this.env, b.portCallId, { by: user?.name ?? 'system', notes: b.notes, requireSailed: false });
      await this.audit.record(c, { action: 'CREATE', entity: 'Invoice', entityId: row.id, entityLabel: `${row.number} (${row.vcn})`, after: toApi(row) });
      await publishState(c, this.env, row, { event: EVENTS.revenue.invoiceDrafted });
      return this.detail(c, row);
    });
  }

  @RequirePerm('invoices.create') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(updateSchema)) b: z.infer<typeof updateSchema>) {
    return withTx(this.pool, async (c) => {
      const before = await lockInvoice(c, id); if (!before) throw notFound('Invoice not found');
      if (before.status !== 'DRAFT') throw badRequest('Only draft invoices can be edited');
      const patch: Parameters<typeof updateInvoice>[2] = {};
      if (b.lines) {
        const clean = b.lines.filter((l) => l.description && l.qty > 0 && l.rate >= 0);
        if (!clean.length) throw badRequest('An invoice needs at least one line');
        const totals = computeTotals(clean, num(before.tax_rate_pct));
        patch.lines = totals.lines; patch.subtotal = totals.subtotal; patch.taxAmount = totals.taxAmount; patch.total = totals.total;
      }
      if (b.notes !== undefined) patch.notes = b.notes;
      if (b.billTo) patch.billTo = { ...before.bill_to, ...b.billTo, companyId: b.billTo.companyId ?? before.bill_to?.companyId ?? null } as Row['bill_to'];
      if (b.dueAt) patch.dueAt = new Date(b.dueAt);
      const row = await updateInvoice(c, before.id, patch);
      await this.audit.record(c, { action: 'UPDATE', entity: 'Invoice', entityId: row.id, entityLabel: row.number, before: toApi(before), after: toApi(row) });
      await publishState(c, this.env, row, { event: EVENTS.revenue.invoiceUpdated });
      return this.detail(c, row);
    });
  }

  @RequirePerm('invoices.issue') @Post(':id/issue')
  async issue(@Param('id') id: string, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await lockInvoice(c, id); if (!before) throw notFound('Invoice not found');
      const row = await issueInvoice(c, this.env, before, user?.name ?? 'system');
      await this.audit.record(c, { action: 'ISSUE', entity: 'Invoice', entityId: row.id, entityLabel: row.number, before: { status: before.status }, after: { status: row.status, issuedAt: iso(row.issued_at), dueAt: iso(row.due_at) } });
      await publishState(c, this.env, row, { event: EVENTS.revenue.invoiceIssued, data: { dueAt: iso(row.due_at) } });
      return this.detail(c, row);
    });
  }

  /** A payment, in part or in full. The account settles only when what has been received covers it. */
  @RequirePerm('invoices.pay') @Post(':id/pay')
  async pay(@Param('id') id: string, @Body(zod(paySchema)) b: z.infer<typeof paySchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await lockInvoice(c, id); if (!before) throw notFound('Invoice not found');
      if (before.status !== 'ISSUED') throw conflict(`Only an issued invoice can be paid — this one is ${before.status.toLowerCase()}`);
      const total = num(before.total); const already = num(before.paid_amount);
      const outstanding = round2(total - already);
      const amount = round2(b.amount ?? outstanding);
      if (amount <= 0) throw badRequest('A payment must be greater than zero');
      if (amount > outstanding + 0.005) throw badRequest(`That is more than the ${round2(outstanding)} outstanding on this invoice`);
      const at = b.at && !Number.isNaN(new Date(b.at).getTime()) ? new Date(b.at) : new Date();
      const payment: Payment = { id: newId(), at: at.toISOString(), amount, ref: b.paymentRef ?? '', method: b.method ?? 'TRANSFER', by: user?.name ?? 'system', note: b.note ?? '' };
      const paid = round2(already + amount); const settled = paid >= total - 0.005;
      const history: HistoryEntry[] = [...(before.history ?? []), { from: before.status, to: settled ? 'PAID' : 'ISSUED', at: at.toISOString(), by: payment.by, note: `${settled ? 'Settled' : 'Part payment'} ${amount}${payment.ref ? ` — ${payment.ref}` : ''}` }];
      const row = await updateInvoice(c, before.id, { payments: [...(before.payments ?? []), payment], paidAmount: paid, paymentRef: payment.ref || before.payment_ref, status: settled ? 'PAID' : 'ISSUED', paidAt: settled ? at : null, history });
      await this.audit.record(c, { action: 'PAY', entity: 'Invoice', entityId: row.id, entityLabel: `${row.number} — ${payment.ref || 'no ref'}`, before: { status: before.status, paidAmount: already }, after: { status: row.status, paidAmount: paid }, note: `${amount} received` });
      await publishState(c, this.env, row, { event: EVENTS.revenue.paymentReceived, data: { amount, paidAmount: paid, balance: round2(total - paid), settled, paymentRef: payment.ref, method: payment.method } });
      if (settled) await publishState(c, this.env, row, { event: EVENTS.revenue.invoicePaid, data: { paidAt: iso(row.paid_at), paymentRef: payment.ref } });
      return this.detail(c, row);
    });
  }

  @RequirePerm('invoices.issue') @Post(':id/cancel')
  async cancel(@Param('id') id: string, @Body(zod(cancelSchema)) b: z.infer<typeof cancelSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await lockInvoice(c, id); if (!before) throw notFound('Invoice not found');
      if (before.status === 'PAID') throw conflict('A paid invoice cannot be cancelled — raise a credit against it');
      if (before.status === 'CANCELLED') throw conflict('This invoice is already cancelled');
      const reason = b.reason?.trim() || 'Cancelled by the finance desk';
      const now = new Date();
      const row = await updateInvoice(c, before.id, { status: 'CANCELLED', cancelReason: reason, history: [...(before.history ?? []), { from: before.status, to: 'CANCELLED', at: now.toISOString(), by: user?.name ?? 'system', note: reason }] });
      await this.audit.record(c, { action: 'CANCEL', entity: 'Invoice', entityId: row.id, entityLabel: row.number, before: { status: before.status }, after: { status: 'CANCELLED' }, note: reason });
      await publishState(c, this.env, row, { event: EVENTS.revenue.invoiceCancelled, data: { reason } });
      return this.detail(c, row);
    });
  }

  @RequirePerm('invoices.delete') @Delete(':id')
  async remove(@Param('id') id: string) {
    return withTx(this.pool, async (c) => {
      const row = await lockInvoice(c, id); if (!row) throw notFound('Invoice not found');
      if (row.status !== 'DRAFT') throw badRequest('Only draft invoices can be deleted — the rest are financial record');
      await c.query('DELETE FROM invoices WHERE id = $1', [row.id]);
      await this.audit.record(c, { action: 'DELETE', entity: 'Invoice', entityId: row.id, entityLabel: row.number, before: toApi(row) });
      await publishDeleted(c, this.env, row);
      return { deleted: true };
    });
  }
}

export interface RaiseOptions { by: string; notes?: string; requireSailed?: boolean; proforma?: boolean; now?: Date }
/** Raises the draft account for a call from the rate card. Shared by the API and the event consumer, so both price identically. */
export async function raiseForCall(c: Queryable, env: Env, ref: string, o: RaiseOptions): Promise<Row> {
  const snap = await findCallSnapshot(c, ref); if (!snap) throw notFound('Port call not found');
  const existing = await c.query<Row>("SELECT * FROM invoices WHERE port_call_id = $1 AND status <> 'CANCELLED' LIMIT 1", [snap.id]);
  if (existing.rows[0] && !existing.rows[0].proforma) throw conflict(`Invoice ${existing.rows[0].number} already exists for call ${snap.vcn}`);
  if (o.requireSailed && !snap.atd) throw badRequest(`Call ${snap.vcn} has not sailed — raise a pro-forma estimate instead`);
  const call = await billableCall(c, snap);
  const tariffs = await activeTariffs(c);
  const j = getJurisdiction(env.JURISDICTION);
  const raw = buildLines(call, tariffs, { implyServices: true });
  if (!raw.length) throw badRequest('Nothing to bill on this call yet — add services or cargo operations first');
  const totals = computeTotals(raw, j.tax.ratePct);
  const billTo = await billToFor(c, snap.agent_code, snap.agent_name, j.tax.registrationLabel);
  const now = o.now ?? new Date();
  // a pro-forma draft raised at berthing is finalised in place when the call sails
  if (existing.rows[0]) {
    return updateInvoice(c, existing.rows[0].id, {
      lines: totals.lines as Line[], subtotal: totals.subtotal, taxAmount: totals.taxAmount, total: totals.total, billTo, proforma: !!o.proforma,
      notes: o.notes ?? (o.proforma ? 'Pro-forma — issued on sailing' : ''),
      history: [...(existing.rows[0].history ?? []), { from: 'DRAFT', to: 'DRAFT', at: now.toISOString(), by: o.by, note: o.proforma ? 'Pro-forma re-priced' : 'Priced on the final statement of facts' }],
    });
  }
  return insertInvoice(c, {
    number: await nextInvoiceNumber(c, env, now), portCallId: snap.id, vcn: snap.vcn, vesselId: snap.vessel_id, vesselName: call.vesselName, vesselImo: call.vesselImo,
    billTo, lines: totals.lines as Line[], subtotal: totals.subtotal, taxName: j.tax.name, taxRatePct: j.tax.ratePct, taxAmount: totals.taxAmount, total: totals.total, currency: j.currency.code,
    status: 'DRAFT', proforma: !!o.proforma, notes: o.notes ?? (o.proforma ? 'Pro-forma — issued on sailing' : ''),
    history: [{ from: '', to: 'DRAFT', at: now.toISOString(), by: o.by, note: o.proforma ? `Pro-forma raised at berthing for ${snap.vcn}` : `Raised on call ${snap.vcn}` }], createdAt: now,
  });
}

/** Issue: the account leaves the desk, the payment clock starts. */
export async function issueInvoice(c: Queryable, env: Env, before: Row, by: string, now = new Date()): Promise<Row> {
  if (before.status !== 'DRAFT') throw conflict(`A ${before.status.toLowerCase()} invoice cannot be issued`);
  if (!(before.lines ?? []).length) throw badRequest('An invoice needs at least one line before it can be issued');
  const due = new Date(now.getTime() + env.PAYMENT_TERMS_DAYS * 86400000);
  return updateInvoice(c, before.id, { status: 'ISSUED', proforma: false, issuedAt: now, dueAt: due, history: [...(before.history ?? []), { from: 'DRAFT', to: 'ISSUED', at: now.toISOString(), by, note: `Issued, payable by ${due.toISOString().slice(0, 10)}` }] });
}
