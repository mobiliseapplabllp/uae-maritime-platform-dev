import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, makeEvent, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, KIT_BUS, KIT_ENV, KIT_POOL, enqueue, withInbox, type EventBus, type Queryable, type Subscription } from '@maritime/service-kit';
import type { Env } from './env';
import { iso, num, publishState, toApi, updateInvoice, type Row } from './invoicing';
import { issueInvoice, raiseForCall } from './invoices.controller';
import { projectSnapshot } from './subjects';

/* Billing follows the ship. A call that berths raises its pro-forma; a call that sails is priced on its closed statement of
 * facts and the account is issued; a call withdrawn takes its draft with it. All of it idempotent per call — the one-live-
 * invoice-per-call rule is what makes a redelivered event harmless. */
export interface Deps { env: Env; audit: AuditClient }
const SYSTEM = { id: 'ports', name: 'Billing automation', kind: 'system' as const };

const liveInvoice = async (c: Queryable, portCallId: string): Promise<Row | null> =>
  (await c.query<Row>("SELECT * FROM invoices WHERE port_call_id = $1 AND status <> 'CANCELLED' LIMIT 1", [portCallId])).rows[0] ?? null;

/** A vessel alongside gets her pro-forma so the agent can see the account building. */
export async function onBerthed(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<boolean> {
  if (!deps.env.PROFORMA_ON_BERTHING) return false;
  const d = (event.data ?? {}) as Record<string, any>;
  const ref = d.portCallId ?? d.vcn; if (!ref) return false;
  const existing = await liveInvoice(c, String(ref));
  if (existing && !existing.proforma) return false;
  const row = await raiseForCall(c, deps.env, String(ref), { by: SYSTEM.name, proforma: true, requireSailed: false });
  await deps.audit.record(c, { action: 'CREATE', entity: 'Invoice', entityId: row.id, entityLabel: `${row.number} (${row.vcn})`, after: toApi(row), note: 'Pro-forma raised at berthing', actor: SYSTEM });
  await publishState(c, deps.env, row, { event: EVENTS.revenue.invoiceDrafted, cause: event, actor: SYSTEM, data: { proforma: true } });
  return true;
}

/** A call that sailed is priced on what she actually consumed, and the account leaves the desk the same day. */
export async function onSailed(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<boolean> {
  const d = (event.data ?? {}) as Record<string, any>;
  const ref = d.portCallId ?? d.vcn; if (!ref) return false;
  const existing = await liveInvoice(c, String(ref));
  if (existing && existing.status !== 'DRAFT') return false; // already issued or settled — nothing to do
  const priced = await raiseForCall(c, deps.env, String(ref), { by: SYSTEM.name, requireSailed: false, notes: '' });
  const row = await issueInvoice(c, deps.env, priced, SYSTEM.name);
  await deps.audit.record(c, { action: existing ? 'ISSUE' : 'CREATE', entity: 'Invoice', entityId: row.id, entityLabel: `${row.number} (${row.vcn})`, before: existing ? { status: existing.status } : undefined, after: toApi(row), note: `Raised and issued on sailing of ${row.vcn}`, actor: SYSTEM });
  await publishState(c, deps.env, row, { event: EVENTS.revenue.invoiceIssued, cause: event, actor: SYSTEM, data: { dueAt: iso(row.due_at), automatic: true } });
  return true;
}

/** A withdrawn call cannot be billed: its draft is cancelled with the reason the harbour desk gave. */
export async function onCallCancelled(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<boolean> {
  const d = (event.data ?? {}) as Record<string, any>;
  const ref = d.portCallId ?? d.vcn; if (!ref) return false;
  const existing = await liveInvoice(c, String(ref));
  if (!existing || existing.status !== 'DRAFT') return false;
  const reason = `Call ${existing.vcn} withdrawn${d.note ? ` — ${d.note}` : ''}`;
  const row = await updateInvoice(c, existing.id, { status: 'CANCELLED', cancelReason: reason, history: [...(existing.history ?? []), { from: 'DRAFT', to: 'CANCELLED', at: new Date().toISOString(), by: SYSTEM.name, note: reason }] });
  await deps.audit.record(c, { action: 'CANCEL', entity: 'Invoice', entityId: row.id, entityLabel: row.number, before: { status: 'DRAFT' }, after: { status: 'CANCELLED' }, note: reason, actor: SYSTEM });
  await publishState(c, deps.env, row, { event: EVENTS.revenue.invoiceCancelled, cause: event, actor: SYSTEM, data: { reason } });
  return true;
}

/** The overdue sweep: every issued account past its due date is announced once, then not again inside the reminder window. */
export async function remindOverdue(c: Queryable, env: Env, cause: EventEnvelope): Promise<number> {
  const rows = await c.query<Row>("SELECT * FROM invoices WHERE status = 'ISSUED' AND due_at IS NOT NULL AND due_at < now() AND (reminded_at IS NULL OR reminded_at < now() - ($1 || ' days')::interval) ORDER BY due_at LIMIT 500", [String(env.OVERDUE_REMINDER_DAYS)]);
  const now = Date.now();
  for (const r of rows.rows) {
    const outstanding = Math.round((num(r.total) - num(r.paid_amount)) * 100) / 100;
    await enqueue(c, makeEvent({ type: EVENTS.revenue.invoiceOverdue, source: env.SERVICE_NAME, subject: r.id, correlationId: cause.correlationid, causationId: cause.id,
      data: { invoiceId: r.id, number: r.number, portCallId: r.port_call_id, vcn: r.vcn, vesselId: r.vessel_id, vesselName: r.vessel_name, billToName: r.bill_to?.name ?? '', total: num(r.total), paidAmount: num(r.paid_amount), outstanding, currency: r.currency, dueAt: iso(r.due_at), daysOverdue: Math.floor((now - r.due_at!.getTime()) / 86400000) } }));
    await c.query('UPDATE invoices SET reminded_at = now() WHERE id = $1', [r.id]);
  }
  return rows.rowCount ?? 0;
}

export async function applyEvent(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<void> {
  if (event.type === EVENTS.ports.sailed) { await onSailed(c, deps, event); return; }
  if (event.type === EVENTS.ports.berthed) { await onBerthed(c, deps, event); return; }
  if (event.type === EVENTS.ports.cancelled) { await onCallCancelled(c, deps, event); return; }
  if (event.type === EVENTS.scheduler.digestInvoices) { await remindOverdue(c, deps.env, event); return; }
  await projectSnapshot(c, event);
}

export const SUBJECTS = [
  subjectFor(EVENTS.readModel.upserted), subjectFor(EVENTS.readModel.deleted), subjectFor(EVENTS.mdm.companyUpserted),
  subjectFor(EVENTS.ports.sailed), subjectFor(EVENTS.ports.berthed), subjectFor(EVENTS.ports.cancelled), subjectFor(EVENTS.scheduler.digestInvoices),
];

@Injectable()
export class RevenueConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('revenue-consumer', SUBJECTS, (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) { await withInbox(this.pool, event, (c) => applyEvent(c, { env: this.env, audit: this.audit }, event)); }
}
