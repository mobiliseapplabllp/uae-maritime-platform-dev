import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, KIT_BUS, KIT_ENV, KIT_POOL, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';
import type { Env } from './env';
import { projectSnapshot, republishSeafarer } from './subjects';

/* What the crew desk learns from the rest of the platform: the fleet it signs crew on to, and the
 * certificates of competency and proficiency the instrument register issued against a seafarer.
 * Consumption is idempotent through the inbox, so a redelivered event changes nothing twice. */

export interface Deps { env: Env; audit: AuditClient }

export async function applyEvent(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<void> {
  const seafarerId = await projectSnapshot(c, deps.env, event);
  if (!seafarerId) return;
  const e = ((event.data ?? {}) as Record<string, any>).entity ?? {};
  await deps.audit.record(c, {
    action: 'INSTRUMENT_MIRRORED', entity: 'Seafarer', entityId: seafarerId, entityLabel: `${e.entityName ?? ''} — ${e.typeLabel ?? e.entityType ?? ''}`,
    after: { number: e.number ?? e.licenseNo, status: e.status, expiryDate: e.expiryDate, instrumentId: e.id },
    note: 'Instrument mirrored from the instrument register', actor: { id: 'instruments', name: 'Instruments', kind: 'system' },
  });
  await republishSeafarer(c, deps.env, seafarerId, event);
}

export const SUBJECTS = [subjectFor(EVENTS.readModel.upserted), subjectFor(EVENTS.readModel.deleted), subjectFor(EVENTS.mdm.vesselUpserted)];

@Injectable()
export class SeafarersConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('seafarers-consumer', SUBJECTS, (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) { await withInbox(this.pool, event, (c) => applyEvent(c, { env: this.env, audit: this.audit }, event)); }
}
