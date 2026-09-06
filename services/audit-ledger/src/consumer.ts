import { Inject, Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import type { Pool } from 'pg';
import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, KIT_BUS, KIT_ENV, KIT_POOL, KIT_LOGGER, KIT_SETTINGS, SettingsClient, withInbox, type EventBus, type Subscription, type AppLogger } from '@maritime/service-kit';
import type { Env } from './env';
import { appendEntry, purgeBeyond, type AuditPayload } from './ledger';

/** Consumes audit.recorded events from every service and appends them to the chain exactly once. */
@Injectable()
export class AuditConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_LOGGER) private readonly log: AppLogger, @Inject(KIT_ENV) private readonly env: Env, @Inject(KIT_SETTINGS) private readonly settings: SettingsClient, private readonly audit: AuditClient) {}
  async onModuleInit() {
    this.sub = await this.bus.subscribe('audit-ledger', [subjectFor(EVENTS.audit.recorded), subjectFor(EVENTS.scheduler.sweepAuditRetention)], (event) => (event.type === EVENTS.scheduler.sweepAuditRetention ? this.retain(event) : this.handle(event as EventEnvelope<AuditPayload>)));
  }
  /** The retention sweep: Users & security → settings says how long the ledger keeps its rows; older rows leave under the anchor and the purge is itself on the record. */
  async retain(event: EventEnvelope) {
    const s = await this.settings.moduleGet('admin', { auditRetentionDays: 0 });
    const days = Number(s.auditRetentionDays) || 0;
    await withInbox(this.pool, event, async (c) => {
      if (days <= 0) { this.log.info('audit retention: no retention period set, nothing purged'); return; }
      const cutoff = new Date(Date.now() - days * 86_400_000);
      const { purged, anchor } = await purgeBeyond(c, cutoff);
      if (purged) await this.audit.record(c, { action: 'RETENTION_PURGE', entity: 'AuditLedger', entityId: 'ledger', entityLabel: `${purged} entries older than ${days} days`, after: { purged, retentionDays: days, cutoff: cutoff.toISOString(), anchorSeq: anchor?.seq ?? null, anchorHash: anchor?.hash ?? null }, actor: { id: 'scheduler', name: 'scheduler', kind: 'system' } });
      this.log.info({ purged, days, anchor: anchor?.seq ?? null }, 'audit retention sweep');
    });
  }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope<AuditPayload>) {
    const done = await withInbox(this.pool, event, async (c) => { await appendEntry(c, event); });
    if (!done) this.log.debug({ eventId: event.id }, 'audit event already processed');
  }
}
