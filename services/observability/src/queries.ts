import type { Pool } from 'pg';

export interface StateRow {
  target: string; kind: string; category: string | null; url: string | null;
  up: boolean; since: Date; last_seen_at: Date | null; last_probe_at: Date;
  latency_ms: number | null; uptime_sec: number | null; detail: Record<string, unknown>; error: string | null;
}

export const stateToApi = (r: StateRow) => ({
  target: r.target, kind: r.kind, category: r.category, url: r.url,
  up: r.up, since: r.since.toISOString(),
  /** How long the current state has held. The number an operator actually asks for. */
  forSec: Math.max(0, Math.round((Date.now() - r.since.getTime()) / 1000)),
  lastSeenAt: r.last_seen_at?.toISOString() ?? null,
  lastProbeAt: r.last_probe_at.toISOString(),
  latencyMs: r.latency_ms, uptimeSec: r.uptime_sec,
  detail: r.detail, error: r.error,
});

export const liveState = async (pool: Pool) => {
  const r = await pool.query<StateRow>(
    `SELECT t.name AS target, t.kind, t.category, t.url,
            s.up, s.since, s.last_seen_at, s.last_probe_at, s.latency_ms, s.uptime_sec, s.detail, s.error
       FROM targets t LEFT JOIN target_state s ON s.target = t.name
      WHERE t.enabled AND s.target IS NOT NULL
      ORDER BY CASE t.kind WHEN 'service' THEN 0 WHEN 'database' THEN 1 WHEN 'broker' THEN 2 ELSE 3 END, t.name`,
  );
  return r.rows.map(stateToApi);
};

/** Availability over a window, from rollups so it survives the raw retention cut. */
export const availability = async (pool: Pool, hours: number) => {
  const r = await pool.query<{ target: string; samples: string; up_samples: string; p50: number | null; p95: number | null; worst: number | null }>(
    `SELECT target, sum(samples)::text AS samples, sum(up_samples)::text AS up_samples,
            round(avg(latency_p50))::int AS p50, max(latency_p95) AS p95, max(latency_max) AS worst
       FROM rollups WHERE granularity = 'hour' AND bucket >= date_trunc('hour', now()) - ($1 || ' hours')::interval
      GROUP BY target ORDER BY target`, [String(hours)],
  );
  return r.rows.map((x) => {
    const samples = Number(x.samples); const up = Number(x.up_samples);
    return { target: x.target, samples, upSamples: up, availability: samples ? Math.round((up / samples) * 10000) / 100 : null, latencyP50: x.p50, latencyP95: x.p95, latencyMax: x.worst };
  });
};

export const history = async (pool: Pool, target: string, granularity: 'hour' | 'day', limit: number) => {
  const r = await pool.query<{ bucket: Date; samples: number; up_samples: number; latency_p50: number | null; latency_p95: number | null; latency_max: number | null }>(
    `SELECT bucket, samples, up_samples, latency_p50, latency_p95, latency_max
       FROM rollups WHERE target = $1 AND granularity = $2 ORDER BY bucket DESC LIMIT $3`, [target, granularity, limit],
  );
  return r.rows.reverse().map((x) => ({
    bucket: x.bucket.toISOString(), samples: x.samples, upSamples: x.up_samples,
    availability: x.samples ? Math.round((x.up_samples / x.samples) * 10000) / 100 : null,
    latencyP50: x.latency_p50, latencyP95: x.latency_p95, latencyMax: x.latency_max,
  }));
};

export const incidents = async (pool: Pool, limit: number, openOnly: boolean) => {
  const r = await pool.query<{ id: string; target: string; kind: string; started_at: Date; ended_at: Date | null; duration_sec: number | null; detail: Record<string, unknown> }>(
    `SELECT id::text, target, kind, started_at, ended_at, duration_sec, detail FROM incidents
      ${openOnly ? 'WHERE ended_at IS NULL' : ''} ORDER BY started_at DESC LIMIT $1`, [limit],
  );
  return r.rows.map((x) => ({
    id: x.id, target: x.target, kind: x.kind,
    startedAt: x.started_at.toISOString(), endedAt: x.ended_at?.toISOString() ?? null,
    // An open outage has no stored duration; report how long it has been running so far.
    durationSec: x.duration_sec ?? Math.max(0, Math.round((Date.now() - x.started_at.getTime()) / 1000)),
    open: x.ended_at === null, detail: x.detail,
  }));
};
