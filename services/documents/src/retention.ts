import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { KIT_BUS, KIT_LOGGER, KIT_POOL, withInbox, type AppLogger, type EventBus, type Subscription } from '@maritime/service-kit';
import { DocumentsService } from './documents.service';

/** Runs the retention purge when the scheduler's nightly `scheduler.sweep.retention` event arrives; exactly once per event through the inbox. */
@Injectable()
export class RetentionConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_LOGGER) private readonly log: AppLogger, private readonly docs: DocumentsService) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('documents-retention', [subjectFor(EVENTS.scheduler.sweepRetention)], (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) {
    const done = await withInbox(this.pool, event, async (c) => {
      const r = await this.docs.purgeExpired(c);
      this.log.info({ eventId: event.id, purged: r.purged }, 'retention sweep completed');
    });
    if (!done) this.log.debug({ eventId: event.id }, 'retention sweep event already processed');
  }
}
