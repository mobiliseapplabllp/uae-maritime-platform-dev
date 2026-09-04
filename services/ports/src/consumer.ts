import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { NATIONAL_SCOPE, EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, KIT_BUS, KIT_ENV, KIT_POOL, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';
import type { Env } from './env';
import { findCall, publishState, updateCall } from './calls';
import { projectSnapshot } from './subjects';

/* What the harbour desk learns from the rest of the platform. The ship register, the company directory, the rate card and
 * the invoices raised on calls are projected into local snapshots; a detention ordered by an inspection is flagged on the
 * call it was raised against. Consumption is idempotent through the inbox, so a redelivered event changes nothing twice. */
export interface Deps { env: Env; audit: AuditClient }

/** A detention order closes the quay for that ship: the call is flagged so the board and the sailing check can see it. */
export async function applyDetention(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<boolean> {
  const d = (event.data ?? {}) as Record<string, any>;
  const ref = d.portCallId ?? d.vcn ?? null;
  const detained = d.released ? false : d.detention !== false;
  if (!ref) return false;
  // the inspection service is not a tenant: a detention applies to the call wherever it sits
  const row = await findCall(c, String(ref), NATIONAL_SCOPE); if (!row) return false;
  if (row.detention === detained) return false;
  const next = await updateCall(c, row.id, { detention: detained });
  await deps.audit.record(c, { action: detained ? 'DETAIN' : 'RELEASE', entity: 'PortCall', entityId: next.id, entityLabel: next.vcn, before: { detention: row.detention }, after: { detention: detained }, note: String(d.reason ?? d.note ?? ''), actor: { id: 'inspection', name: 'Inspection', kind: 'system' } });
  await publishState(c, deps.env, next, { event: EVENTS.ports.updated, cause: event, data: { change: detained ? 'DETAINED' : 'DETENTION_LIFTED' } });
  return true;
}

export async function applyEvent(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<void> {
  if (event.type === EVENTS.inspection.detention) { await applyDetention(c, deps, event); return; }
  await projectSnapshot(c, event);
}

export const SUBJECTS = [
  subjectFor(EVENTS.readModel.upserted), subjectFor(EVENTS.readModel.deleted),
  subjectFor(EVENTS.mdm.vesselUpserted), subjectFor(EVENTS.mdm.companyUpserted),
  subjectFor(EVENTS.inspection.detention),
];

@Injectable()
export class PortsConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('ports-consumer', SUBJECTS, (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) { await withInbox(this.pool, event, (c) => applyEvent(c, { env: this.env, audit: this.audit }, event)); }
}
