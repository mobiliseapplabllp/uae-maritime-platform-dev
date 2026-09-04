import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createApp, loadEnv, signHS256, StaticPrincipalResolver, PRINCIPAL_RESOLVER, KIT_BUS, KIT_RELAY, MemoryBus, OutboxRelay } from '@maritime/service-kit';
import { EVENTS } from '@maritime/contracts';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedScheduler } from '../src/seed';
import { Ticker } from '../src/ticker';
import { SCHEDULER_LOCK_KEY, SEED_JOBS } from '../src/jobs';

const DB = 'maritime_scheduler_test'; const DB_URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let bus: MemoryBus; let relay: OutboxRelay; let ticker: Ticker; let pool: Pool;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const viewer = tok('viewer'); const ops = tok('ops');
const srv = () => request(server as never);
const DAY = 86_400_000;

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedScheduler(DB_URL);
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: DB_URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, SCHEDULER_TICK_MS: '0' } as never);
  const resolver = new StaticPrincipalResolver({
    admin: { id: 'admin', sub: 'admin', name: 'Admin', email: 'admin@maritime.example', perms: ['*'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
    viewer: { id: 'viewer', sub: 'viewer', name: 'Viewer', email: 'viewer@maritime.example', perms: ['settings.view'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
    ops: { id: 'ops', sub: 'ops', name: 'Ops', email: 'ops@maritime.example', perms: ['portcalls.view'], scope: { level: 'PORT' }, kind: 'user', active: true },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer(); bus = app.get(KIT_BUS); relay = app.get(KIT_RELAY); ticker = app.get(Ticker); pool = new Pool({ connectionString: DB_URL });
});
afterAll(async () => { await app?.close(); await pool?.end(); });
/** Drains the outbox (the relay publishes at most 100 rows per tick and also ticks on its own timer) and returns everything published so far. */
const published = async () => {
  for (let i = 0; i < 100; i++) {
    const n = await relay.tick();
    const pending = await pool.query<{ n: string }>('SELECT count(*) AS n FROM outbox WHERE published_at IS NULL');
    if (Number(pending.rows[0].n) === 0) break;
    if (n === 0) await new Promise((r) => setTimeout(r, 25));
  }
  return bus.published;
};

describe('scheduler', () => {
  it('seeds the eight standing jobs with future next runs and lists them to settings viewers only', async () => {
    const list = await srv().get('/jobs?limit=50').set('authorization', viewer);
    expect(list.status).toBe(200); expect(list.body.meta.total).toBe(8);
    expect(list.body.data.map((j: { key: string }) => j.key).sort()).toEqual(SEED_JOBS.map((j) => j.key).sort());
    for (const j of list.body.data) { expect(new Date(j.nextRunAt).getTime()).toBeGreaterThan(Date.now()); expect(j.timezone).toBe('Asia/Dubai'); expect(j.enabled).toBe(true); expect(j.runs).toBe(0); }
    const retention = list.body.data.find((j: { key: string }) => j.key === 'document-retention');
    expect(retention).toMatchObject({ cron: '30 2 * * *', eventType: EVENTS.scheduler.sweepRetention, nameAr: expect.any(String) });
    expect(new Date(retention.nextRunAt).getUTCHours()).toBe(22); expect(new Date(retention.nextRunAt).getUTCMinutes()).toBe(30);
    expect((await srv().get('/jobs').set('authorization', ops)).status).toBe(403);
    expect((await srv().get('/jobs')).status).toBe(401);
    expect((await srv().get('/jobs/nope').set('authorization', viewer)).status).toBe(404);
    // seeding again keeps the schedule in place
    const before = (await srv().get('/jobs/audit-verify').set('authorization', viewer)).body.data.nextRunAt;
    await seedScheduler(DB_URL);
    expect((await srv().get('/jobs/audit-verify').set('authorization', viewer)).body.data.nextRunAt).toBe(before);
  });

  it('fires due jobs once through the outbox under the advisory lock, then advances the schedule', async () => {
    await pool.query("UPDATE jobs SET next_run_at = now() - interval '3 days' WHERE key = 'certificate-expiry-digest'");
    const holder = await pool.connect();
    await holder.query('SELECT pg_advisory_lock($1)', [SCHEDULER_LOCK_KEY]);
    expect(await ticker.tick()).toMatchObject({ fired: 0, skipped: true });
    await holder.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY]); holder.release();
    const first = await ticker.tick();
    expect(first).toMatchObject({ fired: 1, failed: 0, skipped: false });
    expect(ticker.lastTickAt).toEqual(first.at);
    const second = await ticker.tick();
    expect(second.fired).toBe(0);
    const job = (await srv().get('/jobs/certificate-expiry-digest').set('authorization', viewer)).body.data;
    expect(job).toMatchObject({ runs: 1, lastStatus: 'FIRED', lastError: null });
    expect(new Date(job.nextRunAt).getTime()).toBeGreaterThan(Date.now()); expect(new Date(job.nextRunAt).getUTCHours()).toBe(3);
    const events = await published();
    const fired = events.filter((e) => e.event.type === EVENTS.scheduler.digestCertificates);
    expect(fired).toHaveLength(1);
    expect(fired[0].event).toMatchObject({ source: 'scheduler', subject: 'certificate-expiry-digest', actor: { id: 'scheduler', kind: 'system' } });
    expect(fired[0].event.data).toMatchObject({ jobKey: 'certificate-expiry-digest', trigger: 'SCHEDULE', windowDays: 30 });
    expect(new Date((fired[0].event.data as { scheduledFor: string }).scheduledFor).getTime()).toBeLessThan(Date.now() - 2 * DAY);
    const runs = await srv().get('/jobs/certificate-expiry-digest/runs').set('authorization', viewer);
    expect(runs.body.meta.total).toBe(1); expect(runs.body.data[0]).toMatchObject({ trigger: 'SCHEDULE', status: 'FIRED', eventId: fired[0].event.id, eventType: EVENTS.scheduler.digestCertificates });
    const health = await srv().get('/health');
    expect(health.status).toBe(200); expect(health.body.data.service).toBe('scheduler'); expect(new Date(health.body.data.lastTickAt).getTime()).toBe(second.at.getTime()); expect(health.body.data.tickMs).toBe(0);
  });

  it('updates schedules with validation, runs jobs on demand without moving the schedule, and creates jobs by key', async () => {
    const before = (await srv().get('/jobs/sla-breach-sweep').set('authorization', viewer)).body.data;
    expect((await srv().put('/jobs/sla-breach-sweep').set('authorization', viewer).send({ cron: '*/10 * * * *' })).status).toBe(403);
    expect((await srv().put('/jobs/sla-breach-sweep').set('authorization', admin).send({ cron: 'every ten minutes' })).status).toBe(400);
    expect((await srv().put('/jobs/sla-breach-sweep').set('authorization', admin).send({ cron: '*/10 * * * *', timezone: 'Mars/Olympus' })).status).toBe(400);
    expect((await srv().put('/jobs/sla-breach-sweep').set('authorization', admin).send({ eventType: 'not an event' })).status).toBe(400);
    const changed = await srv().put('/jobs/sla-breach-sweep').set('authorization', admin).send({ cron: '*/10 * * * *', payload: { graceMinutes: 5 } });
    expect(changed.status).toBe(200); expect(changed.body.data).toMatchObject({ cron: '*/10 * * * *', payload: { graceMinutes: 5 }, eventType: EVENTS.scheduler.sweepSla });
    // The job was seeded on a fifteen-minute cadence and is being moved to a ten-minute one. Asserting
    // that the two next-run times differ looks like it proves the reschedule took, and does not: for the
    // ten minutes before every hour both schedules next fire at the top of it, so that assertion failed
    // once an hour on the wall clock. What the new cadence does guarantee is that the next run lands on a
    // ten-minute boundary and is never more than ten minutes away, which the old one could not satisfy.
    const next = new Date(changed.body.data.nextRunAt);
    expect(next.getUTCMinutes() % 10).toBe(0);
    expect(next.getTime() - Date.now()).toBeGreaterThan(0);
    expect(next.getTime() - Date.now()).toBeLessThanOrEqual(10 * 60_000);
    expect(before.cron).toBe('*/15 * * * *');
    const renamed = await srv().put('/jobs/sla-breach-sweep').set('authorization', admin).send({ name: 'SLA breach sweep (10 min)' });
    expect(renamed.body.data.nextRunAt).toBe(changed.body.data.nextRunAt);
    const run = await srv().post('/jobs/sla-breach-sweep/run').set('authorization', admin);
    expect(run.status).toBe(201); expect(run.body.data.run).toMatchObject({ trigger: 'MANUAL', status: 'FIRED', triggeredBy: { id: 'admin' } }); expect(run.body.data.nextRunAt).toBe(changed.body.data.nextRunAt);
    expect((await srv().post('/jobs/sla-breach-sweep/run').set('authorization', viewer)).status).toBe(403);
    const events = await published();
    expect(events.some((e) => e.event.type === EVENTS.scheduler.sweepSla && e.event.id === run.body.data.eventId && e.event.actor?.id === 'admin' && (e.event.data as { trigger: string }).trigger === 'MANUAL')).toBe(true);
    expect((await srv().get('/jobs/sla-breach-sweep/runs').set('authorization', viewer)).body.data[0].trigger).toBe('MANUAL');
    expect((await srv().put('/jobs/nightly-parity').set('authorization', admin).send({ name: 'Nightly parity' })).status).toBe(400);
    const created = await srv().put('/jobs/nightly-parity').set('authorization', admin).send({ name: 'Nightly parity', cron: '15 1 * * *', eventType: 'scheduler.sweep.parity', enabled: false, timezone: 'UTC' });
    expect(created.status).toBe(200); expect(created.body.data).toMatchObject({ key: 'nightly-parity', enabled: false, timezone: 'UTC' }); expect(new Date(created.body.data.nextRunAt).getUTCHours()).toBe(1);
    await pool.query("UPDATE jobs SET next_run_at = now() - interval '1 hour' WHERE key = 'nightly-parity'");
    expect((await ticker.tick()).fired).toBe(0);
    expect((await srv().get('/jobs?limit=50').set('authorization', viewer)).body.meta.total).toBe(9);
    expect((await srv().get('/jobs?enabled=false').set('authorization', viewer)).body.data.map((j: { key: string }) => j.key)).toEqual(['nightly-parity']);
  });

  it('lets services register their own jobs through the internal endpoint', async () => {
    const body = { key: 'ais-heartbeat', name: 'AIS feed heartbeat', cron: '*/2 * * * *', eventType: 'scheduler.sweep.ais-heartbeat', owner: 'maritime-centre', payload: { staleMinutes: 10 } };
    expect((await srv().post('/internal/jobs').send(body)).status).toBe(401);
    expect((await srv().post('/internal/jobs').set('authorization', admin).send(body)).status).toBe(401);
    const created = await srv().post('/internal/jobs').set('x-service-token', 'development-service-token').send(body);
    expect(created.status).toBe(201); expect(created.body.data).toMatchObject({ key: 'ais-heartbeat', owner: 'maritime-centre', timezone: 'Asia/Dubai', enabled: true, payload: { staleMinutes: 10 } });
    const again = await srv().post('/internal/jobs').set('x-service-token', 'development-service-token').send({ ...body, name: 'AIS feed heartbeat (renamed)' });
    expect(again.body.data.name).toBe('AIS feed heartbeat (renamed)'); expect(again.body.data.nextRunAt).toBe(created.body.data.nextRunAt);
    expect((await srv().post('/internal/jobs').set('x-service-token', 'development-service-token').send({ ...body, cron: 'nope' })).status).toBe(400);
    expect((await srv().get('/jobs/ais-heartbeat').set('authorization', viewer)).status).toBe(200);
  });

  it('records a failed firing with a retry, and disables a job whose schedule cannot be evaluated', async () => {
    await pool.query("UPDATE jobs SET next_run_at = now() - interval '1 minute', cron = '0 0 30 2 *' WHERE key = 'audit-verify'");
    expect(await ticker.tick()).toMatchObject({ fired: 0, failed: 1, skipped: false });
    const job = (await srv().get('/jobs/audit-verify').set('authorization', viewer)).body.data;
    expect(job.lastStatus).toBe('FAILED'); expect(job.lastError).toMatch(/never matches/); expect(job.enabled).toBe(true);
    expect(new Date(job.nextRunAt).getTime()).toBeGreaterThan(Date.now() + 4 * 60_000);
    const runs = (await srv().get('/jobs/audit-verify/runs').set('authorization', viewer)).body.data;
    expect(runs[0]).toMatchObject({ status: 'FAILED', trigger: 'SCHEDULE', eventId: null }); expect(runs[0].error).toMatch(/never matches/);
    expect((await published()).some((e) => e.event.type === EVENTS.scheduler.verifyAudit)).toBe(false);
    await pool.query("UPDATE jobs SET next_run_at = now() - interval '1 minute', cron = 'garbage' WHERE key = 'audit-verify'");
    expect((await ticker.tick()).failed).toBe(1);
    const disabled = (await srv().get('/jobs/audit-verify').set('authorization', viewer)).body.data;
    expect(disabled.enabled).toBe(false); expect(disabled.nextRunAt).toBeNull();
    const restored = await srv().put('/jobs/audit-verify').set('authorization', admin).send({ cron: '0 3 * * *', enabled: true });
    expect(restored.status).toBe(200); expect(restored.body.data).toMatchObject({ enabled: true, cron: '0 3 * * *' }); expect(new Date(restored.body.data.nextRunAt).getTime()).toBeGreaterThan(Date.now());
  });
});
