import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256 } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedMaritimeCentre } from '../src/seed';
import { seedGeofences } from '../src/geofences';
import { appendHistory, categoryOfCode, categoryOfRegisterType, flagOfMmsi, pruneTargets, upsertTargets, type TargetInput } from '../src/targets';

/* The map's targets: every ship the feed reported, the register's own among them, in a window or as clusters; one
 * ship's card and track; the ports and areas layer; the fleet a person follows. */
const DB = 'maritime_maritime_centre_targets_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const duty = tok('duty'); const viewer = tok('viewer');
const g = (p: string, t = duty) => request(server as never).get(p).set('authorization', t);
const post = (p: string, body?: unknown, t = duty) => request(server as never).post(p).set('authorization', t).send((body ?? {}) as never);
const del = (p: string, t = duty) => request(server as never).delete(p).set('authorization', t);
const target = (mmsi: string, lat: number, lon: number, over: Partial<TargetInput> = {}): TargetInput => ({ mmsi, name: `Target ${mmsi}`, lat, lon, sog: 9, cog: 90, navStatus: 'UNDER_WAY', shipType: 70, source: 'aisstream', at: new Date(), ...over });

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedMaritimeCentre(URL, 'AE');
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, MDM_URL: 'http://127.0.0.1:1' } as never);
  const base = { scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    duty: { ...base, id: 'duty', sub: 'duty', name: 'NMC Duty Officer', perms: ['nmc.view', 'nmc.manage'] },
    viewer: { ...base, id: 'viewer', sub: 'viewer', name: 'Watchkeeper', perms: ['nmc.view'] },
    nobody: { ...base, id: 'nobody', sub: 'nobody', name: 'Nobody', perms: ['reports.view'] },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer(); pool = new Pool({ connectionString: URL });
  await seedGeofences(pool);
});
afterAll(async () => { await pool?.end(); await app?.close(); });

describe('targets — the classes and the flag, without a database', () => {
  it('classes AIS ship-type codes and the register\'s own types the way the legend colours them, and reads a flag off an MMSI', () => {
    expect(categoryOfCode(70)).toEqual({ category: 'cargo', label: 'Cargo' }); expect(categoryOfCode(84)).toEqual({ category: 'tanker', label: 'Tanker, hazardous category D' });
    expect(categoryOfCode(60).category).toBe('passenger'); expect(categoryOfCode(40).category).toBe('highspeed'); expect(categoryOfCode(52)).toEqual({ category: 'tug', label: 'Tug' });
    expect(categoryOfCode(30).category).toBe('fishing'); expect(categoryOfCode(36).category).toBe('pleasure'); expect(categoryOfCode(null).category).toBe('other'); expect(categoryOfCode(99).category).toBe('other');
    expect(categoryOfRegisterType('BULK')).toBe('cargo'); expect(categoryOfRegisterType('TANKER')).toBe('tanker'); expect(categoryOfRegisterType('TUG')).toBe('tug'); expect(categoryOfRegisterType('')).toBe('other');
    expect(flagOfMmsi('470032162')).toBe('AE'); expect(flagOfMmsi('419001234')).toBe('IN'); expect(flagOfMmsi('999000000')).toBeNull(); expect(flagOfMmsi('')).toBeNull();
  });
});

describe('targets — the store', () => {
  it('upserts a batch, keeps a fact a later report leaves blank, thins the track, and prunes what has gone quiet', async () => {
    const t0 = new Date('2026-09-06T06:00:00Z');
    expect(await upsertTargets(pool, [target('470100001', 25.10, 55.10, { at: t0, destination: 'AEJEA', draught: 8.2, length: 180 }), target('470100002', 25.20, 55.20, { at: t0, shipType: 80 })])).toBe(2);
    expect(await upsertTargets(pool, [target('470100001', 25.11, 55.11, { at: new Date(t0.getTime() + 60_000), destination: '', draught: null, length: null, shipType: null })])).toBe(1);
    const row = (await pool.query('SELECT * FROM ais_targets WHERE mmsi = $1', ['470100001'])).rows[0];
    expect(row).toMatchObject({ destination: 'AEJEA', length: 180, category: 'cargo', type_label: 'Cargo', ship_type: 70 }); expect(Number(row.draught)).toBe(8.2); expect(Number(row.lat)).toBe(25.11);
    const points = [target('470100001', 25.10, 55.10, { at: t0 }), target('470100001', 25.105, 55.105, { at: new Date(t0.getTime() + 60_000) }), target('470100001', 25.13, 55.13, { at: new Date(t0.getTime() + 6 * 60_000) })];
    expect(await appendHistory(pool, points, 5)).toBe(2); // the one-minute point is inside the gap
    expect(await upsertTargets(pool, [target('470100003', 25.30, 55.30, { at: new Date(Date.now() - 30 * 3_600_000) })])).toBe(1);
    const pruned = await pruneTargets(pool, { historyHours: 48, silentHours: 24 });
    expect(pruned.targets).toBe(1);
    expect((await pool.query('SELECT 1 FROM ais_targets WHERE mmsi = $1', ['470100003'])).rowCount).toBe(0);
  });
});

describe('targets — the map\'s API', () => {
  it('lists the ships in a window with the register\'s own marked, filters by class, and clusters when there are too many', async () => {
    // the register's own fleet has seeded fixes around the home port; the strangers go into the Gulf of Oman
    await upsertTargets(pool, Array.from({ length: 30 }, (_, i) => target(`4702000${String(i).padStart(2, '0')}`, 25.0 + i * 0.01, 56.5 + i * 0.01, { shipType: i % 3 === 0 ? 80 : 70 })));
    const r = await g('/tracking/targets?minLat=24.9&maxLat=25.4&minLon=56.4&maxLon=56.9&zoom=8', viewer);
    expect(r.status).toBe(200);
    expect(r.body.data.total).toBe(30); expect(r.body.data.clustered).toBe(false); expect(r.body.data.targets).toHaveLength(30);
    expect(r.body.data.targets[0]).toMatchObject({ registered: false, category: expect.stringMatching(/cargo|tanker/), flag: 'AE', source: 'aisstream' });
    expect(r.body.data.legend.map((l: { key: string }) => l.key)).toContain('tanker');
    expect(r.body.data.totals.all).toBeGreaterThanOrEqual(30); expect(r.body.data.totals.registered).toBeGreaterThan(0);
    const tankers = await g('/tracking/targets?minLat=24.9&maxLat=25.4&minLon=56.4&maxLon=56.9&categories=tanker', viewer);
    expect(tankers.body.data.total).toBe(10); expect(tankers.body.data.targets.every((t: { category: string }) => t.category === 'tanker')).toBe(true);
    const clustered = await g('/tracking/targets?minLat=24.9&maxLat=25.4&minLon=56.4&maxLon=56.9&zoom=5&limit=50', viewer);
    expect(clustered.body.data.clustered).toBe(false); // fifty is the floor, thirty fit
    const home = await g('/tracking/targets?minLat=24.5&maxLat=25.2&minLon=54.2&maxLon=55.0', viewer);
    expect(home.body.data.targets.some((t: { registered: boolean }) => t.registered)).toBe(true);
    expect((await g('/tracking/targets?minLat=30&maxLat=20', viewer)).status).toBe(400);
    expect((await g('/tracking/targets', tok('nobody'))).status).toBe(403);
  });
  it('clusters a crowded window into cells with counts by class, the register\'s own ships still drawn', async () => {
    await upsertTargets(pool, Array.from({ length: 120 }, (_, i) => target(`4703${String(i).padStart(5, '0')}`, 24.0 + (i % 12) * 0.05, 57.0 + Math.floor(i / 12) * 0.05, { shipType: 70 })));
    const r = await g('/tracking/targets?minLat=23.9&maxLat=24.7&minLon=56.9&maxLon=57.6&zoom=6&limit=50', viewer);
    expect(r.body.data.clustered).toBe(true); expect(r.body.data.total).toBe(120);
    expect(r.body.data.clusters.length).toBeGreaterThan(0); expect(r.body.data.clusters.length).toBeLessThan(120);
    expect(r.body.data.clusters.reduce((n: number, c: { count: number }) => n + c.count, 0)).toBe(120);
    expect(r.body.data.clusters[0].categories).toMatchObject({ cargo: expect.any(Number) });
  });
  it('shows one ship as her card needs her, with her track and the register\'s facts when she is ours', async () => {
    const one = await g('/tracking/targets/470100001', viewer);
    expect(one.status).toBe(200);
    expect(one.body.data).toMatchObject({ mmsi: '470100001', name: 'Target 470100001', registered: false, destination: 'AEJEA', destinationPort: 'Jebel Ali', flag: 'AE', following: false, category: 'cargo' });
    const track = await g('/tracking/targets/470100001/track?hours=24', viewer);
    expect(track.body.data.track.length).toBe(2); expect(track.body.data.summary.fixes).toBe(2);
    const own = (await pool.query<{ vessel_id: string; mmsi: string }>('SELECT vessel_id, mmsi FROM positions ORDER BY vessel_id LIMIT 1')).rows[0];
    const ours = await g(`/tracking/targets/vessel:${own.vessel_id}`, viewer);
    expect(ours.body.data).toMatchObject({ registered: true, vesselId: own.vessel_id }); expect(ours.body.data.name).toBeTruthy();
    expect((await g(`/tracking/targets/${own.vessel_id}`, viewer)).body.data.vesselId).toBe(own.vessel_id);
    expect((await g('/tracking/targets/000000000', viewer)).status).toBe(404);
    // the search box: a name fragment, an MMSI prefix; the register's own ships first
    const byName = await g('/tracking/targets/search?q=target%20470100', viewer);
    expect(byName.body.data.length).toBeGreaterThanOrEqual(2); expect(byName.body.data[0].name).toMatch(/Target 470100/);
    expect((await g('/tracking/targets/search?q=4701000', viewer)).body.data.map((t: { mmsi: string }) => t.mmsi)).toContain('470100001');
    const ownName = ours.body.data.name.slice(0, 6);
    const own2 = await g(`/tracking/targets/search?q=${encodeURIComponent(ownName)}`, viewer);
    expect(own2.body.data[0].registered).toBe(true);
    expect((await g('/tracking/targets/search?q=', viewer)).body.data).toEqual([]);
  });
  it('the layers carry the ports of the region, the published areas, the chart and any live restriction', async () => {
    const r = await g('/tracking/layers', viewer);
    expect(r.status).toBe(200);
    expect(r.body.data.ports.length).toBeGreaterThan(30); expect(r.body.data.ports.find((p: { code: string }) => p.code === 'AEJEA')).toMatchObject({ name: 'Jebel Ali', country: 'AE' });
    expect(r.body.data.areas.length).toBeGreaterThan(5); expect(r.body.data.areas[0]).toMatchObject({ code: expect.any(String), geojson: expect.objectContaining({ type: 'Polygon' }) });
    expect(r.body.data.home).toMatchObject({ code: 'AEAUH' }); expect(r.body.data.zones.some((z: { kind: string }) => z.kind === 'CHANNEL')).toBe(true);
  });
  it('a person follows a ship, sees her in the fleet with her position, and lets her go', async () => {
    expect((await post('/tracking/watch', { key: '470100001' }, viewer)).body.data).toMatchObject({ following: true, mmsi: '470100001' });
    expect((await post('/tracking/watch', { key: 'nobody-here' }, viewer)).status).toBe(404);
    const own = (await pool.query<{ vessel_id: string }>('SELECT vessel_id FROM positions ORDER BY vessel_id LIMIT 1')).rows[0];
    expect((await post('/tracking/watch', { key: `vessel:${own.vessel_id}` }, viewer)).status).toBe(201);
    const fleet = await g('/tracking/watch', viewer);
    expect(fleet.body.data).toHaveLength(2);
    expect(fleet.body.data.find((f: { mmsi: string }) => f.mmsi === '470100001').target).toMatchObject({ lat: 25.11, category: 'cargo' });
    expect(fleet.body.data.find((f: { vesselId: string | null }) => f.vesselId === own.vessel_id).target.registered).toBe(true);
    expect((await g('/tracking/targets/470100001', viewer)).body.data.following).toBe(true);
    expect((await g('/tracking/watch', duty)).body.data).toEqual([]); // another person's fleet is theirs
    expect((await del('/tracking/watch/470100001', viewer)).body.data).toMatchObject({ following: false, removed: 1 });
    expect((await g('/tracking/watch', viewer)).body.data).toHaveLength(1);
  });
});
