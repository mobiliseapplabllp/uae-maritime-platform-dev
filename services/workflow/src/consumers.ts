import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, STREAM_PREFIX, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { KIT_BUS, KIT_ENV, KIT_POOL, LOOKUP_SUBJECTS, applyLookupEvent, enqueue, eventFromContext, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';
import type { Env } from './env';
import { requestToApi, type RequestRow } from './repo';

/** The scheduler's SLA sweep: every open request past its due date is marked breached once and announced. */
export async function sweepSla(c: PoolClient, source: string): Promise<{ breached: number; numbers: string[] }> {
  const rows = await c.query<RequestRow>("SELECT * FROM service_requests WHERE closed_at IS NULL AND status <> 'DRAFT' AND sla_due_at IS NOT NULL AND sla_due_at < now() AND sla_breached = false FOR UPDATE SKIP LOCKED");
  const numbers: string[] = [];
  for (const row of rows.rows) {
    const entry = { from: row.current_state, to: row.current_state, action: 'sla_breached', at: new Date().toISOString(), by: { id: 'scheduler', name: 'SLA sweep' }, note: `Due ${row.sla_due_at!.toISOString().slice(0, 10)} passed while ${row.status.toLowerCase().replace('_', ' ')}` };
    const r = await c.query<RequestRow>('UPDATE service_requests SET sla_breached = true, sla_breached_at = now(), timeline = $2, updated_at = now() WHERE id = $1 RETURNING *', [row.id, JSON.stringify([...row.timeline, entry])]);
    const subject = `ServiceRequest:${row.number}`;
    await enqueue(c, eventFromContext(source, EVENTS.workflow.requestSlaBreached, { requestId: row.id, requestNo: row.number, definitionKey: row.definition_key, definitionName: row.definition_name, status: row.status, state: row.current_state, slaDueAt: row.sla_due_at, assignee: row.assignee, applicant: row.applicant }, { subject }));
    await enqueue(c, eventFromContext(source, EVENTS.readModel.upserted, { kind: 'serviceRequest', entity: requestToApi(r.rows[0]) }, { subject }));
    numbers.push(row.number);
  }
  return { breached: numbers.length, numbers };
}

/** An instrument issued for a request links back onto it (the instruments service answers workflow.request.issued with instruments.instrument.issued { requestId, ... }). */
export async function linkInstrument(c: PoolClient, source: string, d: Record<string, unknown>): Promise<boolean> {
  const requestId = String(d.requestId ?? ''); if (!requestId) return false;
  const r = await c.query<RequestRow>('SELECT * FROM service_requests WHERE id = $1 FOR UPDATE', [requestId]); const row = r.rows[0]; if (!row) return false;
  const instrument = { ...(row.issued_instrument ?? {}), id: d.instrumentId ?? d.id ?? null, number: d.number ?? d.licenseNo ?? null, type: d.entityType ?? d.instrumentType ?? (row.issued_instrument as { type?: string } | null)?.type ?? null, status: 'ISSUED', issuedAt: d.issueDate ?? d.issuedAt ?? new Date().toISOString(), expiryDate: d.expiryDate ?? null };
  const entry = { from: row.current_state, to: row.current_state, action: 'instrument_linked', at: new Date().toISOString(), by: { id: 'instruments', name: 'Instruments service' }, note: `${String(instrument.number ?? 'Instrument')} issued` };
  const u = await c.query<RequestRow>('UPDATE service_requests SET issued_instrument = $2, timeline = $3, updated_at = now() WHERE id = $1 RETURNING *', [row.id, JSON.stringify(instrument), JSON.stringify([...row.timeline, entry])]);
  const subject = `ServiceRequest:${row.number}`;
  await enqueue(c, eventFromContext(source, EVENTS.workflow.requestInstrumentLinked, { requestId: row.id, requestNo: row.number, instrument }, { subject }));
  await enqueue(c, eventFromContext(source, EVENTS.readModel.upserted, { kind: 'serviceRequest', entity: requestToApi(u.rows[0]) }, { subject }));
  return true;
}

/** Published rule sets are mirrored so the inline evaluator always has the live version. */
export async function cacheRuleSet(c: PoolClient, d: Record<string, unknown>): Promise<boolean> {
  if (typeof d.key !== 'string' || d.definition == null) return false;
  await c.query('INSERT INTO rule_set_cache(key, kind, version, definition, parameters, updated_at) VALUES ($1, $2, $3, $4, $5, now()) ON CONFLICT (key) DO UPDATE SET kind = EXCLUDED.kind, version = EXCLUDED.version, definition = EXCLUDED.definition, parameters = EXCLUDED.parameters, updated_at = now()',
    [d.key, String(d.kind ?? 'FEE'), Number(d.version ?? 1), JSON.stringify(d.definition), JSON.stringify(d.parameters ?? {})]);
  return true;
}

@Injectable()
export class WorkflowConsumers implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('workflow-consumers', [subjectFor(EVENTS.scheduler.sweepSla), subjectFor(EVENTS.instruments.issued), subjectFor(EVENTS.rules.published), `${STREAM_PREFIX}.${EVENTS.scheduler.slaBreached}`, ...LOOKUP_SUBJECTS], (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) {
    const d = (event.data ?? {}) as Record<string, unknown>;
    await withInbox(this.pool, event, async (c) => {
      if (event.type === EVENTS.scheduler.sweepSla) await sweepSla(c, this.env.SERVICE_NAME);
      else if (event.type === EVENTS.instruments.issued) await linkInstrument(c, this.env.SERVICE_NAME, d);
      else if (event.type === EVENTS.rules.published) await cacheRuleSet(c, d);
      else if (event.type === EVENTS.mdm.lookupChanged) await applyLookupEvent(c, event); // the masters a select validates against
    });
  }
}
