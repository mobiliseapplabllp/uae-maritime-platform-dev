import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createApp, loadEnv, runMigrations, signHS256, StaticPrincipalResolver, PRINCIPAL_RESOLVER } from '@maritime/service-kit';
import { join } from 'node:path';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { Collector } from '../src/collector';
import { SLA_DEFINITIONS } from '../src/slas';
import { monitoredServices } from '../src/probes';

const DB = 'maritime_observability_test';
const DB_URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`;
const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let collector: Collector;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const viewer = tok('viewer');
const srv = () => request(server as never);
/* Every fixture is anchored to the current hour. Retention deletes raw samples older than the
 * window on each write, so a fixed date in the past would be swept away as soon as it was written —
 * correct behaviour, useless as a fixture. */
const HOUR_START = (() => { const d = new Date(); d.setMinutes(0, 0, 0); return d; })();
const at = (offsetSec: number) => new Date(HOUR_START.getTime() + offsetSec * 1000);

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  const boot = new Pool({ connectionString: DB_URL });
  await runMigrations(boot, join(__dirname, '..', 'migrations'));
  await boot.end();
  // TICK_MS 0 keeps the collector off its timer: every sweep in these tests is one this test asked for.
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: DB_URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, OBSERVABILITY_TICK_MS: '0', OBSERVABILITY_PROBE_TIMEOUT_MS: '300' } as never);
  const resolver = new StaticPrincipalResolver({
    admin: { id: 'admin', sub: 'admin', name: 'Admin', email: 'admin@maritime.example', perms: ['*'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
    viewer: { id: 'viewer', sub: 'viewer', name: 'Viewer', email: 'viewer@maritime.example', perms: ['dashboard.view'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer();
  pool = new Pool({ connectionString: DB_URL });
  collector = app.get(Collector);
});
afterAll(async () => { await app?.close(); await pool?.end(); });

/** Writes a probe result straight through the collector's recording path, so the state machine is
 *  exercised without depending on which services happen to be running on this machine. */
const record = async (target: string, up: boolean, at: Date, extra: { latencyMs?: number | null; uptimeSec?: number; error?: string } = {}) => {
  const rec = collector as unknown as { record(r: unknown[], now: Date): Promise<void> };
  await rec.record([{ target, up, latencyMs: extra.latencyMs ?? (up ? 10 : null), detail: {}, error: extra.error, uptimeSec: extra.uptimeSec }], at);
};

describe('target registry', () => {
  it('registers every monitored service, the infrastructure and each declared service level', async () => {
    const r = await pool.query<{ kind: string; n: string }>('SELECT kind, count(*)::text AS n FROM targets GROUP BY kind');
    const by = Object.fromEntries(r.rows.map((x) => [x.kind, Number(x.n)]));
    expect(by.service).toBe(monitoredServices().length);
    expect(by.sla).toBe(SLA_DEFINITIONS.length);
    expect(by.database).toBe(1);
    expect(by.broker).toBe(1);
  });
  it('never monitors itself — a monitor reporting its own health proves nothing', async () => {
    expect(monitoredServices().some((s) => s.name === 'observability')).toBe(false);
  });
});

describe('state machine', () => {
  const T = 'ships';
  it('opens an incident when a target goes down and closes it with a real duration on recovery', async () => {
    const t0 = at(0);
    await record(T, true, t0);
    await record(T, false, at(15), { error: 'fetch failed' });
    let open = await pool.query('SELECT * FROM incidents WHERE target = $1 AND ended_at IS NULL', [T]);
    expect(open.rowCount).toBe(1);
    expect(open.rows[0].kind).toBe('outage');

    await record(T, true, at(75));
    open = await pool.query('SELECT * FROM incidents WHERE target = $1 AND ended_at IS NULL', [T]);
    expect(open.rowCount).toBe(0);
    const closed = await pool.query<{ duration_sec: number }>('SELECT duration_sec FROM incidents WHERE target = $1 AND kind = $2', [T, 'outage']);
    expect(closed.rows[0].duration_sec).toBe(60);
  });

  it('does not reopen an incident while the target stays down', async () => {
    const T2 = 'ports';
    await record(T2, true, at(0));
    for (let i = 1; i <= 4; i++) await record(T2, false, at(i * 15), { error: 'down' });
    const n = await pool.query('SELECT * FROM incidents WHERE target = $1', [T2]);
    expect(n.rowCount).toBe(1);
  });

  it('records a restart when uptime goes backwards without a failed probe in between', async () => {
    const T3 = 'mdm';
    await record(T3, true, at(0), { uptimeSec: 900 });
    await record(T3, true, at(15), { uptimeSec: 4 });
    const r = await pool.query<{ detail: Record<string, number> }>("SELECT detail FROM incidents WHERE target = $1 AND kind = 'restart'", [T3]);
    expect(r.rowCount).toBe(1);
    expect(r.rows[0].detail.previousUptimeSec).toBe(900);
    // A restart is a point in time, not an interval, so it is recorded already closed.
    const open = await pool.query("SELECT * FROM incidents WHERE target = $1 AND kind = 'restart' AND ended_at IS NULL", [T3]);
    expect(open.rowCount).toBe(0);
  });

  it('holds `since` steady while the state is unchanged so uptime is measured from the transition', async () => {
    const T4 = 'rules'; const t0 = at(0);
    await record(T4, true, t0);
    await record(T4, true, at(60));
    const r = await pool.query<{ since: Date }>('SELECT since FROM target_state WHERE target = $1', [T4]);
    expect(r.rows[0].since.toISOString()).toBe(t0.toISOString());
  });
});

describe('rollups', () => {
  it('computes availability from the samples in the bucket', async () => {
    const T5 = 'revenue';
    // recording writes samples and recomputes the bucket each time, so the last write settles it
    for (let i = 0; i < 4; i++) await record(T5, i !== 2, at(i * 15));
    const r = await pool.query<{ samples: number; up_samples: number }>(
      "SELECT samples, up_samples FROM rollups WHERE target = $1 AND granularity = 'hour'", [T5]);
    expect(r.rows[0].samples).toBe(4);
    expect(r.rows[0].up_samples).toBe(3);
  });
  it('builds the day bucket from hour buckets, so it survives raw samples being swept', async () => {
    const T6 = 'documents';
    for (let i = 0; i < 3; i++) await record(T6, true, at(i * 15));
    const before = await pool.query<{ samples: number }>("SELECT samples FROM rollups WHERE target = $1 AND granularity = 'day'", [T6]);
    expect(before.rows[0].samples).toBe(3);
    // Deleting every raw sample is what retention eventually does. The day total must not move.
    await pool.query('DELETE FROM samples WHERE target = $1', [T6]);
    const rec = collector as unknown as { rollup(c: unknown, now: Date): Promise<void> };
    await rec.rollup(pool, at(45));
    const after = await pool.query<{ samples: number }>("SELECT samples FROM rollups WHERE target = $1 AND granularity = 'day'", [T6]);
    expect(after.rows[0].samples).toBe(3);
  });
});

describe('api', () => {
  it('refuses callers without platform.view and serves those with it', async () => {
    await srv().get('/platform/status').expect(401);
    await srv().get('/platform/status').set('Authorization', viewer).expect(403);
    const ok = await srv().get('/platform/status').set('Authorization', admin).expect(200);
    expect(ok.body.data.summary).toHaveProperty('services');
    expect(Array.isArray(ok.body.data.targets)).toBe(true);
  });
  it('exposes health publicly, carrying the collector heartbeat', async () => {
    const r = await srv().get('/health').expect(200);
    expect(r.body.data.service).toBe('observability');
    expect(r.body.data).toHaveProperty('lastSweepAt');
  });
  it('rejects a malformed target rather than passing it to the query', async () => {
    await srv().get('/platform/history/not a target!').set('Authorization', admin).expect(400);
  });
  it('reports every declared service level', async () => {
    const r = await srv().get('/platform/slas').set('Authorization', admin).expect(200);
    expect(r.body.data.map((s: { key: string }) => s.key).sort()).toEqual(SLA_DEFINITIONS.map((d) => d.key).sort());
  });
  it('caps the history window instead of letting a caller ask for everything', async () => {
    const r = await srv().get('/platform/incidents?limit=99999').set('Authorization', admin).expect(200);
    expect(r.body.data.length).toBeLessThanOrEqual(500);
  });
});
