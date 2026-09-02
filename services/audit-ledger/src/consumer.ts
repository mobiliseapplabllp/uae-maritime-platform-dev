import { Inject, Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { Pool } from 'pg';
import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { KIT_BUS, KIT_POOL, KIT_LOGGER, withInbox, type EventBus, type Subscription, type AppLogger } from '@maritime/service-kit';
import { appendEntry, type AuditPayload } from './ledger';

/** Consumes audit.recorded events from every service and appends them to the chain exactly once. */
@Injectable()
export class AuditConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_LOGGER) private readonly log: AppLogger) {}
  async onModuleInit() {
    this.sub = await this.bus.subscribe('audit-ledger', [subjectFor(EVENTS.audit.recorded)], (event) => this.handle(event as EventEnvelope<AuditPayload>));
  }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope<AuditPayload>) {
    const done = await withInbox(this.pool, event, async (c) => { await appendEntry(c, event); });
    if (!done) this.log.debug({ eventId: event.id }, 'audit event already processed');
  }
}
