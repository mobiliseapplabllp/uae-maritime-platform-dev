import { Pool } from 'pg';
import { PLATFORM_SERVICES, urlOf, type PlatformService } from '@maritime/contracts';
import type { Env } from './env';

/** Every probe answers the same shape whatever it looked at, so the collector, the storage and the
 *  UI stay uniform. `detail` carries the kind-specific payload. */
export interface ProbeResult {
  target: string;
  up: boolean;
  latencyMs: number | null;
  detail: Record<string, unknown>;
  error?: string;
  /** Reported process uptime, where the target knows it. A drop means it restarted. */
  uptimeSec?: number;
}

const timed = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t0 = Date.now();
  const out = await fn();
  return [out, Date.now() - t0];
};

const fetchJson = async (url: string, timeoutMs: number, headers: Record<string, string> = {}): Promise<unknown> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'maritime-observability', ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
};

const unwrap = (body: unknown): Record<string, unknown> => {
  // Services answer through the shared envelope ({ success, data }); the gateway's own health does too.
  const b = body as { data?: unknown };
  const inner = b && typeof b === 'object' && 'data' in b ? b.data : body;
  return (inner && typeof inner === 'object' ? inner : {}) as Record<string, unknown>;
};

/** A service: liveness from /health, then everything it knows about itself from /internal/telemetry.
 *  Telemetry failing is not the service being down — it is one endpoint failing on a live service, so
 *  the two are recorded separately. */
export async function probeService(s: PlatformService, env: Env): Promise<ProbeResult> {
  const base = urlOf(s, process.env);
  const timeout = env.OBSERVABILITY_PROBE_TIMEOUT_MS;
  try {
    const [health, latencyMs] = await timed(() => fetchJson(`${base}/health`, timeout));
    const h = unwrap(health);
    const detail: Record<string, unknown> = { kind: s.kind, port: s.port, url: base, health: h };
    let uptimeSec = typeof h.uptimeSec === 'number' ? h.uptimeSec : undefined;
    try {
      const tel = unwrap(await fetchJson(`${base}/internal/telemetry`, timeout, { 'x-service-token': env.SERVICE_TOKEN }));
      detail.telemetry = tel;
      if (typeof tel.uptimeSec === 'number') uptimeSec = tel.uptimeSec;
    } catch (e) {
      detail.telemetryError = (e as Error).message;
    }
    return { target: s.name, up: true, latencyMs, detail, uptimeSec };
  } catch (e) {
    return { target: s.name, up: false, latencyMs: null, detail: { kind: s.kind, port: s.port, url: base }, error: (e as Error).message };
  }
}

/** The cluster: reachability, per-database size and the connection counts that precede a pool
 *  exhaustion. Sizes come from pg_database, which is cluster-wide, so one connection sees them all.
 *  Test databases are excluded: `maritime_*_test` are throwaway artefacts of a test run, and
 *  counting them made "platform data" nearly double what the platform actually holds. */
export async function probeDatabase(pool: Pool, env: Env): Promise<ProbeResult> {
  void env;
  try {
    const [res, latencyMs] = await timed(() => pool.query<{ datname: string; size_mb: string; connections: string }>(`
      SELECT d.datname,
             round(pg_database_size(d.datname) / 1048576.0, 1)::text AS size_mb,
             (SELECT count(*) FROM pg_stat_activity a WHERE a.datname = d.datname)::text AS connections
        FROM pg_database d
       WHERE d.datname LIKE 'maritime\\_%' AND d.datname NOT LIKE '%\\_test'
       ORDER BY d.datname
    `));
    const databases = res.rows.map((r) => ({ name: r.datname, sizeMb: Number(r.size_mb), connections: Number(r.connections) }));
    const extra = await pool.query<{ total: string; max_conn: string; longest_sec: string | null }>(`
      SELECT (SELECT count(*) FROM pg_stat_activity)::text                                            AS total,
             current_setting('max_connections')                                                       AS max_conn,
             (SELECT extract(epoch FROM max(now() - query_start))::int FROM pg_stat_activity
               WHERE state = 'active' AND query NOT LIKE '%pg_stat_activity%')::text                  AS longest_sec
    `);
    const e0 = extra.rows[0];
    return {
      target: 'postgres',
      up: true,
      latencyMs,
      detail: {
        databases,
        databaseCount: databases.length,
        totalSizeMb: Math.round(databases.reduce((a, d) => a + d.sizeMb, 0) * 10) / 10,
        connections: Number(e0.total),
        maxConnections: Number(e0.max_conn),
        longestQuerySec: e0.longest_sec === null ? 0 : Number(e0.longest_sec),
      },
    };
  } catch (e) {
    return { target: 'postgres', up: false, latencyMs: null, detail: {}, error: (e as Error).message };
  }
}

/** NATS through its monitoring port: /healthz for liveness, /varz for the process, /jsz for
 *  JetStream. Consumer `num_pending` is the lag that tells you a service has stopped keeping up
 *  with events long before anyone notices data drifting between services. */
export async function probeBroker(env: Env): Promise<ProbeResult> {
  const base = env.OBSERVABILITY_NATS_MONITOR_URL.replace(/\/+$/, '');
  const timeout = env.OBSERVABILITY_PROBE_TIMEOUT_MS;
  try {
    const [, latencyMs] = await timed(() => fetchJson(`${base}/healthz`, timeout));
    const detail: Record<string, unknown> = { url: base };
    let uptimeSec: number | undefined;
    try {
      const varz = (await fetchJson(`${base}/varz`, timeout)) as Record<string, unknown>;
      detail.server = {
        version: varz.version, connections: varz.connections, totalConnections: varz.total_connections,
        inMsgs: varz.in_msgs, outMsgs: varz.out_msgs, slowConsumers: varz.slow_consumers, memMb: Math.round(Number(varz.mem ?? 0) / 1048576 * 10) / 10,
      };
      if (typeof varz.uptime === 'string') detail.uptime = varz.uptime;
    } catch (e) { detail.varzError = (e as Error).message; }
    try {
      const jsz = (await fetchJson(`${base}/jsz?streams=1&consumers=1`, timeout)) as Record<string, unknown>;
      const accounts = (jsz.account_details ?? []) as Array<{ stream_detail?: Array<Record<string, unknown>> }>;
      const streams = accounts.flatMap((a) => a.stream_detail ?? []).map((s) => {
        const state = (s.state ?? {}) as Record<string, unknown>;
        const consumers = ((s.consumer_detail ?? []) as Array<Record<string, unknown>>).map((c) => ({
          name: c.name, pending: Number(c.num_pending ?? 0), ackPending: Number(c.num_ack_pending ?? 0), redelivered: Number(c.num_redelivered ?? 0),
        }));
        return {
          name: s.name, messages: Number(state.messages ?? 0), bytes: Number(state.bytes ?? 0),
          consumers, maxPending: consumers.reduce((a, c) => Math.max(a, c.pending), 0),
        };
      });
      detail.jetstream = {
        streams, streamCount: streams.length,
        consumerCount: streams.reduce((a, s) => a + s.consumers.length, 0),
        totalPending: streams.reduce((a, s) => a + s.consumers.reduce((b, c) => b + c.pending, 0), 0),
        memoryMb: Math.round(Number(jsz.memory ?? 0) / 1048576 * 10) / 10,
        storeMb: Math.round(Number(jsz.storage ?? 0) / 1048576 * 10) / 10,
      };
    } catch (e) { detail.jetstreamError = (e as Error).message; }
    return { target: 'nats', up: true, latencyMs, detail, uptimeSec };
  } catch (e) {
    return { target: 'nats', up: false, latencyMs: null, detail: { url: base }, error: (e as Error).message };
  }
}

export const monitoredServices = (): PlatformService[] => PLATFORM_SERVICES.filter((s) => s.name !== 'observability');
