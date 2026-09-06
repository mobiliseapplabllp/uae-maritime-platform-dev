import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createServer, type Server } from 'node:http';
import { EVENTS, subjectFor } from '@maritime/contracts';
import { KIT_SETTINGS, PRINCIPAL_RESOLVER, SettingsClient, StaticPrincipalResolver, createApp, loadEnv, signHS256 } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedMaritimeCentre } from '../src/seed';
import { seedGeofences } from '../src/geofences';
import { chartZones, recordFix } from '../src/tracking';
import { DEFAULT_THRESHOLDS, inApproachChannel, sweepAisGaps, thresholdsOf, type Thresholds } from '../src/surveillance';

/* The derived signals, judged against Harbour Operations' thresholds: speed in the channel, a crossing of a published
 * area, a ship off her anchor, and a feed gone quiet. A small settings service stands in for MDM so the thresholds
 * can be changed between fixes. */
const DB = 'maritime_maritime_centre_surveillance_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
const SERVICE_TOKEN = 'test-service-token';
let app: INestApplication; let server: unknown; let pool: Pool; let env: ReturnType<typeof loadEnv<typeof envSchema>>; let fake: Server; let port = 0;
let ops: Record<string, unknown> = { channelSpeedLimitKn: 8, aisGapAlertMin: 30, anchorDriftNm: 0.2, zoneEntryWatch: true };
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const duty = tok('duty');
const g = (p: string, t = duty) => request(server as never).get(p).set('authorization', t);
const post = (p: string, body?: unknown, t = duty) => request(server as never).post(p).set('authorization', t).send((body ?? {}) as never);
const ingest = (body: Record<string, unknown>) => request(server as never).post('/tracking/positions').set('x-service-token', SERVICE_TOKEN).send(body as never);
const alertsFor = async (vesselId: string, type?: string) => (await pool.query<{ type: string; severity: string; note: string; acknowledged: boolean }>(
  `SELECT type, severity, note, acknowledged FROM mda_alerts WHERE vessel_id = $1 AND ($2::text IS NULL OR type = $2) ORDER BY at, id`, [vesselId, type ?? null])).rows;
const outbox = async (type: string) => (await pool.query('SELECT payload FROM outbox WHERE subject = $1 ORDER BY id', [subjectFor(type)])).rows.map((r) => r.payload as { data: Record<string, any> });
let ships: { id: string; name: string; mmsi: string }[] = [];
let settings: SettingsClient;

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedMaritimeCentre(URL, 'AE');
  fake = createServer((req, res) => {
    const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.url === '/internal/settings/module%3Aops' || req.url === '/internal/settings/module:ops') return json(200, { success: true, data: ops });
    json(404, { success: false, message: 'no such setting' });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => { port = (fake.address() as { port: number }).port; r(); }));
  env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, SERVICE_TOKEN, MDM_URL: `http://127.0.0.1:${port}` } as never);
  const base = { scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    duty: { ...base, id: 'duty', sub: 'duty', name: 'NMC Duty Officer', perms: ['nmc.view', 'nmc.manage', 'incidents.view'] },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer(); pool = new Pool({ connectionString: URL });
  await seedGeofences(pool);
  // fresh, quiet targets: three fictional ships whose seeded fixes and alerts are cleared so every signal here is one this test raised
  ships = (await pool.query<{ id: string; name: string; mmsi: string }>(`SELECT id, name, mmsi FROM vessels WHERE NOT real AND mmsi <> '' ORDER BY name LIMIT 3`)).rows;
  for (const s of ships) { await pool.query('DELETE FROM positions WHERE vessel_id = $1', [s.id]); await pool.query('DELETE FROM position_history WHERE vessel_id = $1', [s.id]); await pool.query('DELETE FROM mda_alerts WHERE vessel_id = $1', [s.id]); }
  settings = new SettingsClient(`http://127.0.0.1:${port}`, SERVICE_TOKEN, 0);
});
afterAll(async () => { await pool?.end(); await app?.close(); await new Promise((r) => fake.close(r)); });

const thresholds = (over: Partial<Thresholds> = {}): Thresholds => ({ ...DEFAULT_THRESHOLDS, ...over });
/** The service caches a setting for half a minute; a changed value is what the mdm.settings.changed watch would otherwise announce. */
const setOps = (v: Record<string, unknown>) => { ops = v; (app.get(KIT_SETTINGS) as SettingsClient).invalidate('module:ops'); };
/** A point inside the chart's approach channel — its centroid. */
function channelPoint() {
  const channel = chartZones('AE').find((z) => z.kind === 'CHANNEL')!;
  const lat = channel.points.reduce((s, p) => s + p.lat, 0) / channel.points.length; const lon = channel.points.reduce((s, p) => s + p.lon, 0) / channel.points.length;
  return { lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 };
}

describe('surveillance — the thresholds come from Harbour Operations', () => {
  it('reads the module settings and falls back to the seeded defaults when the settings service is silent', async () => {
    expect(await thresholdsOf(settings)).toEqual({ channelSpeedLimitKn: 8, aisGapAlertMin: 30, anchorDriftNm: 0.2, zoneEntryWatch: true });
    ops = { channelSpeedLimitKn: 6, aisGapAlertMin: 15, anchorDriftNm: 0.1, zoneEntryWatch: 'false' };
    expect(await thresholdsOf(settings)).toEqual({ channelSpeedLimitKn: 6, aisGapAlertMin: 15, anchorDriftNm: 0.1, zoneEntryWatch: false });
    ops = { channelSpeedLimitKn: 'nonsense', aisGapAlertMin: -5 };
    expect(await thresholdsOf(settings)).toMatchObject({ channelSpeedLimitKn: 8, aisGapAlertMin: 30, zoneEntryWatch: true });
    expect(await thresholdsOf(new SettingsClient('http://127.0.0.1:1', SERVICE_TOKEN, 0))).toEqual(DEFAULT_THRESHOLDS);
    expect(await thresholdsOf(undefined)).toEqual(DEFAULT_THRESHOLDS);
    ops = { channelSpeedLimitKn: 8, aisGapAlertMin: 30, anchorDriftNm: 0.2, zoneEntryWatch: true };
  });
  it('the picture tells the watch which thresholds the alerts are judged against', async () => {
    const r = await g('/tracking');
    expect(r.status).toBe(200);
    expect(r.body.data.thresholds).toEqual({ channelSpeedLimitKn: 8, aisGapAlertMin: 30, anchorDriftNm: 0.2, zoneEntryWatch: true });
  });
});

describe('surveillance — speed in the approach channel', () => {
  it('raises once for a ship over the limit in the channel, not again while the alert stands, and not for a ship inside the limit', async () => {
    const s = ships[0]; const p = channelPoint();
    expect(inApproachChannel('AE', p.lat, p.lon)).toBe(true);
    const under = await ingest({ vesselId: s.id, lat: p.lat, lon: p.lon, sog: 7.5, cog: 90, navStatus: 'UNDERWAY', receivedAt: new Date(Date.now() - 6 * 60_000).toISOString() });
    expect(under.status).toBe(201);
    expect(await alertsFor(s.id, 'SPEED_IN_CHANNEL')).toEqual([]);
    await ingest({ vesselId: s.id, lat: p.lat, lon: p.lon, sog: 10.2, cog: 90, navStatus: 'UNDERWAY', receivedAt: new Date(Date.now() - 4 * 60_000).toISOString() });
    const first = await alertsFor(s.id, 'SPEED_IN_CHANNEL');
    expect(first).toEqual([{ type: 'SPEED_IN_CHANNEL', severity: 'warning', note: '10.2 kn in the approach channel — limit 8 kn', acknowledged: false }]);
    await ingest({ vesselId: s.id, lat: p.lat, lon: p.lon, sog: 11, cog: 90, navStatus: 'UNDERWAY', receivedAt: new Date(Date.now() - 2 * 60_000).toISOString() });
    expect(await alertsFor(s.id, 'SPEED_IN_CHANNEL')).toHaveLength(1);
    const raised = (await outbox(EVENTS.maritimeCentre.alertRaised)).filter((e) => e.data.vesselId === s.id && e.data.type === 'SPEED_IN_CHANNEL');
    expect(raised).toHaveLength(1); expect(raised[0].data.derived).toBe(true);
  });
  it('a tighter limit from the settings bites on the next fix', async () => {
    const s = ships[0]; const p = channelPoint();
    await pool.query(`UPDATE mda_alerts SET acknowledged = true, acknowledged_by = 'Watch', acknowledged_at = now() WHERE vessel_id = $1`, [s.id]);
    setOps({ ...ops, channelSpeedLimitKn: 5 });
    await ingest({ vesselId: s.id, lat: p.lat, lon: p.lon, sog: 6, cog: 90, navStatus: 'UNDERWAY', receivedAt: new Date().toISOString() });
    const alerts = await alertsFor(s.id, 'SPEED_IN_CHANNEL');
    expect(alerts[alerts.length - 1]).toMatchObject({ note: '6.0 kn in the approach channel — limit 5 kn', acknowledged: false });
    setOps({ ...ops, channelSpeedLimitKn: 8 });
  });
});

describe('surveillance — crossings of the published sea areas', () => {
  it('records the entry and raises where the area asks to be told; switched off, it records nothing', async () => {
    const s = ships[1];
    // outside the Jebel Ali anchorage, then inside it — the area asks to be told about entries
    await recordFix(pool, env, { vesselId: s.id, lat: 24.85, lon: 54.95, sog: 4, cog: 0, navStatus: 'UNDERWAY', receivedAt: new Date(Date.now() - 20 * 60_000).toISOString() }, { thresholds: thresholds() });
    await recordFix(pool, env, { vesselId: s.id, lat: 24.95, lon: 54.95, sog: 4, cog: 0, navStatus: 'UNDERWAY', receivedAt: new Date(Date.now() - 10 * 60_000).toISOString() }, { thresholds: thresholds() });
    const events = (await pool.query<{ kind: string; code: string }>('SELECT e.kind, f.code FROM geofence_events e JOIN geofences f ON f.id = e.geofence_id WHERE e.vessel_id = $1 ORDER BY e.at', [s.id])).rows;
    expect(events).toEqual([{ kind: 'ENTRY', code: 'AEJEA-ANCH' }]);
    expect(await alertsFor(s.id, 'ZONE_ENTRY')).toEqual([{ type: 'ZONE_ENTRY', severity: 'info', note: 'Entered Jebel Ali anchorage', acknowledged: false }]);
    // still inside: no second entry
    await recordFix(pool, env, { vesselId: s.id, lat: 24.96, lon: 54.96, sog: 3, cog: 0, navStatus: 'UNDERWAY', receivedAt: new Date(Date.now() - 8 * 60_000).toISOString() }, { thresholds: thresholds() });
    expect((await pool.query('SELECT count(*)::int AS n FROM geofence_events WHERE vessel_id = $1', [s.id])).rows[0].n).toBe(1);
    // out again with the watch switched off: nothing recorded, nothing raised
    await recordFix(pool, env, { vesselId: s.id, lat: 24.85, lon: 54.95, sog: 4, cog: 180, navStatus: 'UNDERWAY', receivedAt: new Date(Date.now() - 6 * 60_000).toISOString() }, { thresholds: thresholds({ zoneEntryWatch: false }) });
    expect((await pool.query('SELECT count(*)::int AS n FROM geofence_events WHERE vessel_id = $1', [s.id])).rows[0].n).toBe(1);
    expect(await alertsFor(s.id, 'ZONE_ENTRY')).toHaveLength(1);
  });
});

describe('surveillance — a ship off her anchor', () => {
  it('measures drift from where she anchored and raises past the threshold', async () => {
    const s = ships[2];
    const t0 = Date.now() - 30 * 60_000;
    await recordFix(pool, env, { vesselId: s.id, lat: 25.3000, lon: 55.0000, sog: 0, cog: 0, navStatus: 'AT_ANCHOR', receivedAt: new Date(t0).toISOString() }, { thresholds: thresholds() });
    // a tenth of a mile: inside the threshold
    await recordFix(pool, env, { vesselId: s.id, lat: 25.3015, lon: 55.0000, sog: 0.1, cog: 0, navStatus: 'AT_ANCHOR', receivedAt: new Date(t0 + 10 * 60_000).toISOString() }, { thresholds: thresholds() });
    expect(await alertsFor(s.id, 'ANCHOR_DRIFT')).toEqual([]);
    // half a mile: over it
    await recordFix(pool, env, { vesselId: s.id, lat: 25.3083, lon: 55.0000, sog: 0.3, cog: 0, navStatus: 'AT_ANCHOR', receivedAt: new Date(t0 + 20 * 60_000).toISOString() }, { thresholds: thresholds() });
    const drift = await alertsFor(s.id, 'ANCHOR_DRIFT');
    expect(drift).toHaveLength(1);
    expect(drift[0].note).toMatch(/^0\.5\d nm off the anchor position — threshold 0\.2 nm$/);
    // under way again, then anchored afresh: the new anchor position is the reference, so no drift
    await recordFix(pool, env, { vesselId: s.id, lat: 25.3200, lon: 55.0000, sog: 6, cog: 0, navStatus: 'UNDERWAY', receivedAt: new Date(t0 + 25 * 60_000).toISOString() }, { thresholds: thresholds() });
    await recordFix(pool, env, { vesselId: s.id, lat: 25.3300, lon: 55.0000, sog: 0, cog: 0, navStatus: 'AT_ANCHOR', receivedAt: new Date(t0 + 27 * 60_000).toISOString() }, { thresholds: thresholds() });
    await recordFix(pool, env, { vesselId: s.id, lat: 25.3305, lon: 55.0000, sog: 0, cog: 0, navStatus: 'AT_ANCHOR', receivedAt: new Date(t0 + 29 * 60_000).toISOString() }, { thresholds: thresholds() });
    expect(await alertsFor(s.id, 'ANCHOR_DRIFT')).toHaveLength(1);
  });
});

describe('surveillance — the AIS gap sweep', () => {
  it('raises once for a target that has gone quiet past the threshold, never for a moored one, and honours a shorter threshold', async () => {
    const now = new Date();
    const quiet = ships[1]; const moored = ships[2];
    await pool.query(`UPDATE positions SET received_at = $2, nav_status = 'UNDERWAY' WHERE vessel_id = $1`, [quiet.id, new Date(now.getTime() - 40 * 60_000)]);
    await pool.query(`UPDATE positions SET received_at = $2, nav_status = 'MOORED' WHERE vessel_id = $1`, [moored.id, new Date(now.getTime() - 3 * 3_600_000)]);
    await pool.query('DELETE FROM mda_alerts WHERE vessel_id = ANY($1)', [[quiet.id, moored.id]]);
    const first = await sweepAisGaps(pool, env, thresholds({ aisGapAlertMin: 30 }), now);
    expect(first.raised).toBeGreaterThanOrEqual(1); expect(first.vessels).toContain(quiet.name); expect(first.vessels).not.toContain(moored.name);
    expect(await alertsFor(quiet.id, 'AIS_GAP')).toEqual([{ type: 'AIS_GAP', severity: 'warning', note: 'No AIS fix for 40 min — threshold 30 min', acknowledged: false }]);
    expect(await alertsFor(moored.id, 'AIS_GAP')).toEqual([]);
    const again = await sweepAisGaps(pool, env, thresholds({ aisGapAlertMin: 30 }), now);
    expect(again.vessels).not.toContain(quiet.name);
    // a fix 20 minutes old is a gap at a 15-minute threshold and not at 30
    await pool.query('DELETE FROM mda_alerts WHERE vessel_id = $1', [quiet.id]);
    await pool.query('UPDATE positions SET received_at = $2 WHERE vessel_id = $1', [quiet.id, new Date(now.getTime() - 20 * 60_000)]);
    expect((await sweepAisGaps(pool, env, thresholds({ aisGapAlertMin: 30 }), now)).vessels).not.toContain(quiet.name);
    expect((await sweepAisGaps(pool, env, thresholds({ aisGapAlertMin: 15 }), now)).vessels).toContain(quiet.name);
    expect((await alertsFor(quiet.id, 'AIS_GAP'))[0].note).toBe('No AIS fix for 20 min — threshold 15 min');
  });
  it('the watch can run the sweep now, on the configured threshold', async () => {
    setOps({ ...ops, aisGapAlertMin: 10 });
    const r = await post('/tracking/alerts/sweep');
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ gapMinutes: 10 });
    expect(typeof r.body.data.raised).toBe('number');
    expect((await post('/tracking/alerts/sweep', {}, tok('nobody'))).status).toBe(401);
  });
});
