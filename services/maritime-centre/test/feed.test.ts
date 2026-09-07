import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createServer, type Server } from 'node:http';
import { EVENTS, makeEvent, subjectFor } from '@maritime/contracts';
import { KIT_BUS, MemoryBus, PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256, withTx, IntegrationClient } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedMaritimeCentre } from '../src/seed';
import { LRIT_SOURCE, advance, pollAis, pollFeed } from '../src/feed';
import { DEFAULT_THRESHOLDS, sweepAisGaps } from '../src/surveillance';

/* The AIS/LRIT feed read through the hub: a fake hub answers with three fixes — two ships on the register, one not. */
const DB = 'maritime_maritime_centre_feed_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let env: ReturnType<typeof loadEnv<typeof envSchema>>; let bus: MemoryBus;
let fake: Server; let port = 0; let mode: 'stub' | 'live' = 'stub'; let down = false; let ships: { id: string; imo: string; mmsi: string; name: string }[] = [];
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const lritReports = () => [
  { imo: ships[0].imo, mmsi: ships[0].mmsi, lat: 22.415, lon: 60.221, sog: 13.4, cog: 312, heading: 310, navStatus: 'UNDER_WAY', destination: 'AEFJR', at: '2026-09-05T06:00:00Z' },
  { imo: ships[1].imo, mmsi: ships[1].mmsi, lat: 25.796, lon: 56.904, sog: 0, cog: 0, heading: 95, navStatus: 'AT_ANCHOR', destination: 'AEKLF', at: '2026-09-05T06:00:00Z' },
];
const positions = () => [
  { imo: ships[0].imo, mmsi: ships[0].mmsi, lat: 25.2, lon: 55.2, sog: 12, cog: 90, heading: 92, navStatus: 'UNDER_WAY', at: '2026-09-04T05:58:12Z' },
  { imo: ships[1].imo, mmsi: ships[1].mmsi, lat: 24.98, lon: 55.01, sog: 0.1, cog: 0, heading: 270, navStatus: 'MOORED', at: '2026-09-04T05:58:40Z' },
  { imo: '9999999', mmsi: '000000000', lat: 25.0, lon: 56.0, sog: 5, cog: 180, navStatus: 'UNDER_WAY' },
];

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' }); await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedMaritimeCentre(URL, 'AE');
  pool = new Pool({ connectionString: URL });
  ships = (await pool.query<{ id: string; imo: string; mmsi: string; name: string }>("SELECT id, imo, mmsi, name FROM vessels WHERE real = false AND imo <> '' AND mmsi <> '' ORDER BY name LIMIT 2")).rows;
  fake = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (down) return json(503, { success: false, message: 'hub down' });
      const b = JSON.parse(raw);
      // the LRIT data centre answers reports for the register's own ships, far out and six-hourly; AIS answers the near picture
      const adapter = String(req.url ?? '').split('?')[0].split('/').pop();
      const data = adapter === 'lrit' ? { since: b.payload.since, source: 'LRIT', dataCentre: 'Test data centre', reports: lritReports() } : { since: b.payload.since, positions: positions() };
      json(200, { success: true, data: { callId: '1', adapter, operation: b.operation, status: 'ok', mode, httpStatus: 200, attempts: 1, durationMs: 2, data } });
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => { port = (fake.address() as { port: number }).port; r(); }));
  env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, MDM_URL: 'http://127.0.0.1:1', INTEGRATION_HUB_URL: `http://127.0.0.1:${port}` } as never);
  const base = { scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    duty: { ...base, id: 'duty', sub: 'duty', name: 'NMC Duty Officer', perms: ['nmc.view', 'nmc.manage'] },
    viewer: { ...base, id: 'viewer', sub: 'viewer', name: 'Watchkeeper', perms: ['nmc.view'] },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) }); await app.init(); server = app.getHttpServer(); bus = app.get(KIT_BUS);
});
afterAll(async () => { await app?.close(); await pool?.end(); await new Promise((r) => fake.close(r)); });
const hub = () => new IntegrationClient(`http://127.0.0.1:${port}`, 'svc', 2000);
const poll = (now: Date) => withTx(pool, (c) => pollAis(c, { env, hub: hub() }, { now }));
const fixOf = async (id: string) => (await pool.query<{ lat: string; lon: string; sog: string; nav_status: string; source: string; received_at: Date }>('SELECT lat, lon, sog, nav_status, source, received_at FROM positions WHERE vessel_id = $1', [id])).rows[0];

describe('the AIS/LRIT feed', () => {
  it('records a fix for every ship it knows, counts the ones it does not, and keeps its own ledger', async () => {
    expect(ships).toHaveLength(2);
    const t0 = new Date('2026-09-05T10:00:00Z');
    const out = await poll(t0);
    expect(out).toMatchObject({ status: 'ok', mode: 'stub', received: 3, matched: 2, targets: 3 }); expect(out.skipped).toEqual([]);
    // a ship not on the register is still a target on the picture — traffic, not a case file
    const stranger = (await pool.query<{ vessel_id: string | null; name: string; category: string; source: string }>("SELECT vessel_id, name, category, source FROM ais_targets WHERE mmsi = '000000000'")).rows[0];
    expect(stranger).toMatchObject({ vessel_id: null, category: 'other', source: 'AIS (stub contract)' });
    expect((await pool.query<{ n: string }>('SELECT count(*)::int AS n FROM ais_targets WHERE vessel_id IS NOT NULL')).rows[0].n).toBe(2);
    const a = await fixOf(ships[0].id); const b = await fixOf(ships[1].id);
    expect(a).toMatchObject({ nav_status: 'UNDERWAY', source: 'AIS (stub contract)' }); expect(Number(a.lat)).toBe(25.2); expect(Number(a.lon)).toBe(55.2); expect(a.received_at.toISOString()).toBe(t0.toISOString());
    expect(b).toMatchObject({ nav_status: 'MOORED' });
    const feed = await request(server as never).get('/tracking/feed').set('authorization', tok('viewer'));
    expect(feed.body.data).toMatchObject({ source: 'ais-lrit', lastStatus: 'ok', lastMode: 'stub', received: 3, matched: 2, polls: 1, pollMinutes: 2 });
  });
  it('moves a ship under way along her course between two readings of a stub that never moves, and leaves the moored one alone', async () => {
    const t1 = new Date('2026-09-05T10:10:00Z');
    await poll(t1);
    const a = await fixOf(ships[0].id); const b = await fixOf(ships[1].id);
    const expected = advance(25.2, 55.2, 12, 90, 10);
    expect(Number(a.lat)).toBeCloseTo(expected.lat, 4); expect(Number(a.lon)).toBeCloseTo(expected.lon, 4); expect(Number(a.lon)).toBeGreaterThan(55.2);
    expect(Number(b.lat)).toBe(24.98); expect(Number(b.lon)).toBe(55.01);
    // the seeded world may already carry a track for her, depending on the day the picture is built for — only the feed's own fixes are counted
    expect((await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM position_history WHERE vessel_id = $1 AND received_at = ANY($2::timestamptz[])', [ships[0].id, [new Date('2026-09-05T10:00:00Z'), t1]])).rows[0].n).toBe('2');
  });
  it('stamps a live fix with the time the counterpart gave, and records a hub outage without losing the watermark', async () => {
    mode = 'live';
    const out = await poll(new Date('2026-09-05T10:20:00Z'));
    expect(out.mode).toBe('live');
    const a = await fixOf(ships[0].id); expect(a.source).toBe('AIS/LRIT feed'); expect(a.received_at.toISOString()).toBe('2026-09-04T05:58:12.000Z'); expect(Number(a.lat)).toBe(25.2);
    mode = 'stub'; down = true;
    const gone = await poll(new Date('2026-09-05T10:30:00Z'));
    expect(gone.status).toBe('unavailable'); expect(gone.error).toMatch(/hub down|503|unreachable/);
    const feed = (await request(server as never).get('/tracking/feed').set('authorization', tok('viewer'))).body.data;
    expect(feed.lastStatus).toBe('unavailable'); expect(feed.lastSince).toBe('2026-09-05T10:20:00.000Z'); expect(feed.polls).toBe(4);
    down = false;
  });
  it('is read now on request by a duty officer, and on the scheduler\'s event by the consumer', async () => {
    expect((await request(server as never).post('/tracking/feed/poll').set('authorization', tok('viewer'))).status).toBe(403);
    const now = await request(server as never).post('/tracking/feed/poll').set('authorization', tok('duty'));
    expect(now.status).toBe(201); expect(now.body.data).toMatchObject({ status: 'ok', matched: 2 });
    await bus.publish(subjectFor(EVENTS.scheduler.pollAisPositions), makeEvent({ type: EVENTS.scheduler.pollAisPositions, source: 'scheduler', data: {} })); await bus.drain();
    const feed = (await request(server as never).get('/tracking/feed').set('authorization', tok('viewer'))).body.data;
    expect(feed.polls).toBe(6);
  });
});

describe('the LRIT data centre', () => {
  it('records the long-range reports as fixes that name their source, keeps a ledger beside the AIS one, and is read on its own event', async () => {
    const t = new Date('2026-09-05T11:00:00Z');
    const out = await withTx(pool, (c) => pollFeed(c, LRIT_SOURCE, { env, hub: hub() }, { now: t }));
    expect(out).toMatchObject({ source: 'lrit', status: 'ok', mode: 'stub', received: 2, matched: 2, targets: 2 });
    const a = await fixOf(ships[0].id);
    expect(a).toMatchObject({ source: 'LRIT (stub contract)', nav_status: 'UNDERWAY' }); expect(Number(a.lat)).toBe(22.415); expect(Number(a.lon)).toBe(60.221);
    expect((await pool.query<{ source: string }>('SELECT source FROM ais_targets WHERE mmsi = $1', [ships[1].mmsi])).rows[0].source).toBe('LRIT (stub contract)');
    const feed = (await request(server as never).get('/tracking/feed').set('authorization', tok('viewer'))).body.data;
    expect(feed.source).toBe('ais-lrit'); expect(feed.sources.map((s: { source: string }) => s.source)).toEqual(['ais-lrit', 'lrit']);
    expect(feed.sources[1]).toMatchObject({ label: 'LRIT data centre', lastStatus: 'ok', lastMode: 'stub', received: 2, matched: 2, polls: 1, pollMinutes: 30 });
    expect((await request(server as never).post('/tracking/feed/poll?source=lrit').set('authorization', tok('viewer'))).status).toBe(403);
    expect((await request(server as never).post('/tracking/feed/poll?source=radar').set('authorization', tok('duty'))).status).toBe(400);
    const now = await request(server as never).post('/tracking/feed/poll?source=lrit').set('authorization', tok('duty'));
    expect(now.status).toBe(201); expect(now.body.data).toMatchObject({ source: 'lrit', status: 'ok', matched: 2 });
    await bus.publish(subjectFor(EVENTS.scheduler.pollLritPositions), makeEvent({ type: EVENTS.scheduler.pollLritPositions, source: 'scheduler', data: {} })); await bus.drain();
    const after = (await request(server as never).get('/tracking/feed').set('authorization', tok('viewer'))).body.data;
    expect(after.sources[1].polls).toBe(3);
    // the live counterpart's own name reaches the picture
    mode = 'live';
    await withTx(pool, (c) => pollFeed(c, LRIT_SOURCE, { env, hub: hub() }, { now: new Date('2026-09-05T11:30:00Z') }));
    expect((await fixOf(ships[0].id)).source).toBe('LRIT data centre');
    expect((await pool.query<{ source: string }>('SELECT source FROM ais_targets WHERE mmsi = $1', [ships[0].mmsi])).rows[0].source).toBe('LRIT · Test data centre');
    mode = 'stub';
  });
  it('does not raise an AIS gap for a ship whose last word came by LRIT: beyond AIS range is not silence', async () => {
    const t = new Date('2026-09-05T12:00:00Z');
    await withTx(pool, (c) => pollFeed(c, LRIT_SOURCE, { env, hub: hub() }, { now: t }));
    expect((await fixOf(ships[0].id)).source).toBe('LRIT (stub contract)');
    const swept = await withTx(pool, (c) => sweepAisGaps(c, env, DEFAULT_THRESHOLDS, new Date('2026-09-05T14:00:00Z')));
    expect(swept.vessels).not.toContain(ships[0].name);
  });
});
