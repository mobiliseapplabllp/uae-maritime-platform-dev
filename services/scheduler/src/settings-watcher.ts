import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { EVENTS, subjectFor } from '@maritime/contracts';
import { KIT_BUS, KIT_ENV, KIT_LOGGER, KIT_POOL, KIT_SETTINGS, SettingsClient, withTx, type AppLogger, type EventBus, type Subscription } from '@maritime/service-kit';
import type { Env } from './env';
import { applyDigestHour } from './jobs';

/** Keeps the digest jobs on the hour Settings → Notifications names: applied at start, and again whenever that section changes. */
@Injectable()
export class SettingsWatcher implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, @Inject(KIT_SETTINGS) private readonly settings: SettingsClient, @Inject(KIT_LOGGER) private readonly log: AppLogger) {}
  async onModuleInit() {
    await this.apply().catch((e) => this.log.warn({ err: (e as Error).message }, 'digest hour not applied at start'));
    this.sub = await this.bus.watch([subjectFor(EVENTS.mdm.settingsChanged)], async (event) => {
      const key = (event.data as { key?: string } | undefined)?.key;
      if (key === 'notifications') { this.settings.invalidate('notifications'); await this.apply().catch((e) => this.log.warn({ err: (e as Error).message }, 'digest hour not applied')); }
    });
  }
  async onModuleDestroy() { await this.sub?.stop(); }
  /** Reads the hour and moves the digests to it; says which jobs moved. */
  async apply(): Promise<string[]> {
    const v = await this.settings.get<{ digestHour?: unknown }>('notifications', {});
    if (v.digestHour === undefined || v.digestHour === null || v.digestHour === '') return [];
    const hour = Number(v.digestHour); if (!Number.isFinite(hour)) return [];
    const changed = await withTx(this.pool, (c) => applyDigestHour(c, hour, this.env.SCHEDULER_TIMEZONE ?? 'Asia/Dubai'));
    if (changed.length) this.log.info({ hour, changed }, 'digest jobs moved to the configured hour');
    return changed;
  }
}
