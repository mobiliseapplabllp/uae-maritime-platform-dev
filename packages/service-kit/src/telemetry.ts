import { Controller, Get, Inject } from '@nestjs/common';
import type { Pool } from 'pg';
import { ServiceOnly } from './auth/guard';

/** What every service reports about itself. Uniform across all of them: the tables read here are
 *  the ones KIT_SQL creates, so no service needs a line of its own code to take part. */
export interface Telemetry {
  service: string;
  version: string;
  uptimeSec: number;
  time: string;
  node: string;
  memory: { rssMb: number; heapUsedMb: number; heapTotalMb: number };
  db: { reachable: boolean; latencyMs: number | null; poolTotal: number; poolIdle: number; poolWaiting: number; error?: string };
  /** The transactional outbox. A backlog here means events are written but not reaching the bus,
   *  which is the shape data drift between services takes before anyone notices it. */
  outbox: { unpublished: number; oldestUnpublishedSec: number | null; publishedLastHour: number };
  inbox: { processed: number; lastProcessedAt: string | null };
  migrations: { applied: number; last: string | null; lastAppliedAt: string | null };
}

const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

@Controller()
export class TelemetryController {
  private readonly started = Date.now();
  constructor(
    @Inject('KIT_SERVICE_NAME') private readonly name: string,
    @Inject('KIT_POOL') private readonly pool: Pool,
  ) {}

  @ServiceOnly() @Get('internal/telemetry')
  async telemetry(): Promise<Telemetry> {
    const mem = process.memoryUsage();
    const base = {
      service: this.name,
      version: process.env.SERVICE_VERSION || '0.0.0',
      uptimeSec: Math.round((Date.now() - this.started) / 1000),
      time: new Date().toISOString(),
      node: process.version,
      memory: { rssMb: mb(mem.rss), heapUsedMb: mb(mem.heapUsed), heapTotalMb: mb(mem.heapTotal) },
    };
    // A pool with no free connection is itself a finding, so report the counters even when the query fails.
    const counts = { poolTotal: this.pool.totalCount, poolIdle: this.pool.idleCount, poolWaiting: this.pool.waitingCount };

    const t0 = Date.now();
    try {
      // One round trip for everything: separate queries would each pay the connection wait we are trying to measure.
      const r = await this.pool.query<{
        unpublished: string; oldest_sec: string | null; published_hour: string;
        processed: string; last_processed: Date | null;
        migrations: string; last_migration: string | null; last_migration_at: Date | null;
      }>(`
        SELECT
          (SELECT count(*) FROM outbox WHERE published_at IS NULL)                                   AS unpublished,
          (SELECT extract(epoch FROM now() - min(created_at)) FROM outbox WHERE published_at IS NULL) AS oldest_sec,
          (SELECT count(*) FROM outbox WHERE published_at > now() - interval '1 hour')                AS published_hour,
          (SELECT count(*) FROM processed_events)                                                    AS processed,
          (SELECT max(processed_at) FROM processed_events)                                           AS last_processed,
          (SELECT count(*) FROM _migrations)                                                         AS migrations,
          (SELECT name FROM _migrations ORDER BY applied_at DESC, name DESC LIMIT 1)                 AS last_migration,
          (SELECT max(applied_at) FROM _migrations)                                                  AS last_migration_at
      `);
      const row = r.rows[0];
      return {
        ...base,
        db: { reachable: true, latencyMs: Date.now() - t0, ...counts },
        outbox: {
          unpublished: Number(row.unpublished),
          oldestUnpublishedSec: row.oldest_sec === null ? null : Math.round(Number(row.oldest_sec)),
          publishedLastHour: Number(row.published_hour),
        },
        inbox: { processed: Number(row.processed), lastProcessedAt: row.last_processed?.toISOString() ?? null },
        migrations: { applied: Number(row.migrations), last: row.last_migration, lastAppliedAt: row.last_migration_at?.toISOString() ?? null },
      };
    } catch (e) {
      // Report the failure as data rather than a 500: "this service cannot reach its database" is
      // exactly what the monitor exists to show, and a 500 would look identical to the service being down.
      return {
        ...base,
        db: { reachable: false, latencyMs: null, ...counts, error: (e as Error).message },
        outbox: { unpublished: -1, oldestUnpublishedSec: null, publishedLastHour: -1 },
        inbox: { processed: -1, lastProcessedAt: null },
        migrations: { applied: -1, last: null, lastAppliedAt: null },
      };
    }
  }
}
