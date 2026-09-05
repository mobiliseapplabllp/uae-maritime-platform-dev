import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, KIT_BUS, KIT_ENV, KIT_POOL, LOOKUP_SUBJECTS, applyLookupEvent, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';
import type { Env } from './env';
import { projectSnapshot, republishVessel } from './subjects';

/* What the ship register learns from the rest of the platform.
 *
 * Calls, inspections, incidents, crew and AIS fixes are projected into local snapshots so the ship record
 * renders from one database. The statutory certificates this administration issued arrive from the
 * instrument register and are merged onto the ship's own certificate list — the one case where an inbound
 * event changes a record this service owns, so it is audited and republished like any other write.
 * Consumption is idempotent through the inbox: a redelivered event changes nothing twice. */

export interface Deps { env: Env; audit: AuditClient }

export async function applyEvent(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<void> {
  if (await applyLookupEvent(c, event)) return; // the registration variants, transaction types, amendment types and closure grounds
  const vesselId = await projectSnapshot(c, deps.env, event);
  if (!vesselId) return;
  const e = (event.data ?? {}) as Record<string, any>;
  const cert = e.entity ?? {};
  await deps.audit.record(c, {
    action: 'CERT_MIRRORED', entity: 'Vessel', entityId: vesselId, entityLabel: `${cert.vesselName ?? ''} — ${cert.certType ?? ''}`,
    after: { number: cert.number, expiryDate: cert.expiryDate, instrumentId: cert.instrumentId, inForce: cert.inForce },
    note: 'Statutory certificate mirrored from the instrument register', actor: { id: 'instruments', name: 'Instruments', kind: 'system' },
  });
  await republishVessel(c, deps.env, vesselId, event);
}

export const SUBJECTS = [
  subjectFor(EVENTS.readModel.upserted), subjectFor(EVENTS.readModel.deleted),
  subjectFor(EVENTS.mdm.companyUpserted), subjectFor(EVENTS.maritimeCentre.positionUpdated),
  ...LOOKUP_SUBJECTS,
];

@Injectable()
export class ShipsConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('ships-consumer', SUBJECTS, (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) { await withInbox(this.pool, event, (c) => applyEvent(c, { env: this.env, audit: this.audit }, event)); }
}
