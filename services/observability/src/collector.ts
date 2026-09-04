import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { KIT_ENV, KIT_LOGGER, KIT_POOL, withTx, type AppLogger } from '@maritime/service-kit';
import type { Env } from './env';
import { monitoredServices, probeBroker, probeDatabase, probeService, type ProbeResult } from './probes';
import { SLA_DEFINITIONS, probeSla } from './slas';

/** Only one collector writes per tick, however many replicas are running. Same advisory-lock idiom
 *  as the scheduler's ticker; the constant differs so the two never contend. */
export const COLLECTOR_LOCK_KEY = 8842_1101;

export interface SweepResult { probed: number; up: number; down: number; skipped: boolean; at: Date }

@Injectable()
export class Collector implements OnModuleInit, OnModuleDestroy {
  lastSweepAt: Date | null = null;
  lastSweep: SweepResult | null = null;
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly pg: Pool;

  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    @Inject(KIT_LOGGER) private readonly log: AppLogger,
  ) {
    // A small, separate pool: reading cluster statistics must not compete for the connections the
    // service needs to record what it found.
    this.pg = new Pool({ connectionString: env.OBSERVABILITY_PG_URL, max: 2 });
  }

  async onModuleInit() {
    await this.registerTargets();
    if (this.env.OBSERVABILITY_TICK_MS > 0) {
      this.timer = setInterval(() => void this.sweep(), this.env.OBSERVABILITY_TICK_MS);
      this.timer.unref?.();
      void this.sweep(); // a board that is blank until the first interval elapses looks broken
    }
  }
  async onModuleDestroy() { if (this.timer) clearInterval(this.timer); this.timer = undefined; await this.pg.end().catch(() => undefined); }

  /** Targets come from the shared registry, so monitoring a new service needs no change here. */
  async registerTargets() {
    const rows: Array<[string, string, string | null, string | null]> = [
      ...monitoredServices().map((s): [string, string, string | null, string | null] => [s.name, 'service', s.kind, `http://127.0.0.1:${s.port}`]),
      ['postgres', 'database', 'infrastructure', null],
      ['nats', 'broker', 'infrastructure', null],
      ...SLA_DEFINITIONS.map((d): [string, string, string | null, string | null] => [d.key, 'sla', d.domain, d.path]),
    ];
    for (const [name, kind, category, url] of rows) {
      await this.pool.query(
        `INSERT INTO targets(name, kind, category, url) VALUES ($1,$2,$3,$4)
         ON CONFLICT (name) DO UPDATE SET kind = EXCLUDED.kind, category = EXCLUDED.category, url = EXCLUDED.url`,
        [name, kind, category, url],
      );
    }
    // A service removed from the registry stops being probed, but its history is kept.
    await this.pool.query('UPDATE targets SET enabled = (name = ANY($1))', [rows.map((r) => r[0])]);
  }

  async sweep(now = new Date()): Promise<SweepResult> {
    if (this.running) return { probed: 0, up: 0, down: 0, skipped: true, at: now };
    this.running = true;
    const client = await this.pool.connect();
    try {
      const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [COLLECTOR_LOCK_KEY]);
      if (!lock.rows[0].ok) return { probed: 0, up: 0, down: 0, skipped: true, at: now };
      try {
        // Everything in parallel: a sweep that probed serially would take as long as the sum of its
        // timeouts, and one dead target would delay every reading behind it.
        const results = await Promise.all([
          ...monitoredServices().map((s) => probeService(s, this.env)),
          probeDatabase(this.pg, this.env),
          probeBroker(this.env),
          ...SLA_DEFINITIONS.map((d) => probeSla(d, this.env)),
        ]);
        await this.record(results, now);
        const up = results.filter((r) => r.up).length;
        const out = { probed: results.length, up, down: results.length - up, skipped: false, at: now };
        this.lastSweepAt = now; this.lastSweep = out;
        return out;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [COLLECTOR_LOCK_KEY]).catch(() => undefined);
      }
    } catch (e) {
      this.log.warn({ err: e }, 'sweep failed');
      return { probed: 0, up: 0, down: 0, skipped: true, at: now };
    } finally { client.release(); this.running = false; }
  }

  /** One transaction: samples, live state, incident transitions and rollups either all land for this
   *  tick or none do, so the board can never show a state the history does not support. */
  private async record(results: ProbeResult[], now: Date) {
    await withTx(this.pool, async (c) => {
      for (const r of results) {
        await c.query(
          'INSERT INTO samples(target, at, up, latency_ms, detail, error) VALUES ($1,$2,$3,$4,$5,$6)',
          [r.target, now, r.up, r.latencyMs, JSON.stringify(r.detail), r.error ?? null],
        );

        const prev = await c.query<{ up: boolean; since: Date; uptime_sec: number | null }>(
          'SELECT up, since, uptime_sec FROM target_state WHERE target = $1 FOR UPDATE', [r.target],
        );
        const before = prev.rows[0];
        const changed = !before || before.up !== r.up;

        await c.query(
          `INSERT INTO target_state(target, up, since, last_seen_at, last_probe_at, latency_ms, uptime_sec, detail, error)
           VALUES ($1,$2,$3,$4,$3,$5,$6,$7,$8)
           ON CONFLICT (target) DO UPDATE SET
             up = EXCLUDED.up,
             since = CASE WHEN target_state.up = EXCLUDED.up THEN target_state.since ELSE EXCLUDED.since END,
             last_seen_at = CASE WHEN EXCLUDED.up THEN EXCLUDED.last_probe_at ELSE target_state.last_seen_at END,
             last_probe_at = EXCLUDED.last_probe_at,
             latency_ms = EXCLUDED.latency_ms, uptime_sec = EXCLUDED.uptime_sec,
             detail = EXCLUDED.detail, error = EXCLUDED.error`,
          [r.target, r.up, now, r.up ? now : null, r.latencyMs, r.uptimeSec ?? null, JSON.stringify(r.detail), r.error ?? null],
        );

        if (changed && !r.up) {
          await c.query('INSERT INTO incidents(target, kind, started_at, detail) VALUES ($1,$2,$3,$4)',
            [r.target, 'outage', now, JSON.stringify({ error: r.error ?? null })]);
        } else if (changed && r.up && before) {
          await c.query(
            `UPDATE incidents SET ended_at = $2, duration_sec = GREATEST(0, extract(epoch FROM $2 - started_at)::int)
             WHERE target = $1 AND ended_at IS NULL`, [r.target, now]);
        }

        // Uptime going backwards on a target that never reported down is a restart between two
        // probes — the kind of flap that is invisible in an up/down chart.
        if (before && !changed && r.up && typeof r.uptimeSec === 'number' && before.uptime_sec !== null && r.uptimeSec < before.uptime_sec) {
          await c.query('INSERT INTO incidents(target, kind, started_at, ended_at, duration_sec, detail) VALUES ($1,$2,$3,$3,0,$4)',
            [r.target, 'restart', now, JSON.stringify({ previousUptimeSec: before.uptime_sec, uptimeSec: r.uptimeSec })]);
        }
      }
      await this.rollup(c, now);
    });
  }

  /** Hour buckets are recomputed from raw samples; day buckets are then rolled up from the hour
   *  buckets rather than from samples again. Recomputing rather than accumulating keeps a bucket
   *  correct across a missed tick or a restart mid-hour, and sourcing the day from hours means the
   *  day total never depends on how long raw samples are kept — deriving both from samples would
   *  silently truncate the day the moment retention dropped below 24 hours.
   *
   *  Day latencies are therefore aggregates of hourly aggregates: the median of hourly medians, and
   *  the worst hourly p95. Exact enough to read a trend, and it costs no raw retention to keep. */
  private async rollup(c: { query: Pool['query'] }, now: Date) {
    await c.query(
      `INSERT INTO rollups(target, granularity, bucket, samples, up_samples, latency_p50, latency_p95, latency_max)
       SELECT target, 'hour', date_trunc('hour', at), count(*)::int, count(*) FILTER (WHERE up)::int,
              percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_ms)::int,
              percentile_disc(0.95) WITHIN GROUP (ORDER BY latency_ms)::int,
              max(latency_ms)::int
         FROM samples WHERE at >= date_trunc('hour', $1::timestamptz)
        GROUP BY target, date_trunc('hour', at)
       ON CONFLICT (target, granularity, bucket) DO UPDATE SET
         samples = EXCLUDED.samples, up_samples = EXCLUDED.up_samples,
         latency_p50 = EXCLUDED.latency_p50, latency_p95 = EXCLUDED.latency_p95, latency_max = EXCLUDED.latency_max`,
      [now],
    );
    await c.query(
      `INSERT INTO rollups(target, granularity, bucket, samples, up_samples, latency_p50, latency_p95, latency_max)
       SELECT target, 'day', date_trunc('day', bucket), sum(samples)::int, sum(up_samples)::int,
              percentile_disc(0.5) WITHIN GROUP (ORDER BY latency_p50)::int,
              max(latency_p95)::int, max(latency_max)::int
         FROM rollups WHERE granularity = 'hour' AND bucket >= date_trunc('day', $1::timestamptz)
        GROUP BY target, date_trunc('day', bucket)
       ON CONFLICT (target, granularity, bucket) DO UPDATE SET
         samples = EXCLUDED.samples, up_samples = EXCLUDED.up_samples,
         latency_p50 = EXCLUDED.latency_p50, latency_p95 = EXCLUDED.latency_p95, latency_max = EXCLUDED.latency_max`,
      [now],
    );
    await c.query('DELETE FROM samples WHERE at < now() - ($1 || \' hours\')::interval', [String(this.env.OBSERVABILITY_RAW_RETENTION_HOURS)]);
  }
}
