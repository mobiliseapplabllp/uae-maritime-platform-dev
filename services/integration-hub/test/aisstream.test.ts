import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { WebSocketServer, type WebSocket as ServerSocket } from 'ws';
import { join } from 'node:path';
import { PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, runMigrations, signHS256 } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { HubClient } from '../src/client';
import { AisStreamCollector, boxesOf, navStatusOf, parseMessage, positionsAnswer, probeStream, subscription } from '../src/adapters/aisstream';
import { endpointProblem } from '../src/endpoint';

/* The AIS stream, against a small counterpart of our own: it expects the subscription the real one expects, answers a
 * good key with reports and a bad one with an error, and drops the line when told to — which is how reconnection is
 * proved without the internet. */
const DB = 'maritime_integration_hub_stream_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret'; const TOKEN = 'svc-token';
let app: INestApplication; let server: unknown; let pool: Pool; let wss: WebSocketServer; let port = 0; let hub: HubClient;
let sockets: ServerSocket[] = []; let subscriptions: Record<string, unknown>[] = [];
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (f: () => boolean, ms = 4000) => { const t0 = Date.now(); while (!f()) { if (Date.now() - t0 > ms) throw new Error('timed out'); await wait(25); } };

const position = (mmsi: number, lat: number, lon: number, over: Record<string, unknown> = {}) => JSON.stringify({
  MessageType: 'PositionReport', MetaData: { MMSI: mmsi, ShipName: 'GULF TRADER', latitude: lat, longitude: lon, time_utc: '2026-09-06 06:10:15.123456789 +0000 UTC' },
  Message: { PositionReport: { Cog: 118.4, Sog: 11.8, TrueHeading: 120, NavigationalStatus: 0, Latitude: lat, Longitude: lon, UserID: mmsi, ...over } },
});
const statics = (mmsi: number) => JSON.stringify({
  MessageType: 'ShipStaticData', MetaData: { MMSI: mmsi, ShipName: 'GULF TRADER', time_utc: '2026-09-06 06:10:20 +0000 UTC' },
  Message: { ShipStaticData: { Name: 'GULF TRADER@@', CallSign: 'A6E123', ImoNumber: 9725354, Type: 70, Destination: 'AEJEA', MaximumStaticDraught: 9.4, Dimension: { A: 120, B: 60, C: 12, D: 18 }, Eta: { Month: 9, Day: 7, Hour: 4, Minute: 30 }, UserID: mmsi } },
});

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' }); await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  pool = new Pool({ connectionString: URL });
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  wss.on('connection', (ws) => {
    sockets.push(ws);
    ws.on('message', (raw) => {
      const sub = JSON.parse(String(raw)) as Record<string, unknown>; subscriptions.push(sub);
      if (sub.APIKey !== 'good-key') { ws.send(JSON.stringify({ error: 'Api Key Is Not Valid' })); ws.close(1008, 'invalid key'); return; }
      ws.send(position(470032162, 25.2012, 55.2087)); ws.send(statics(470032162)); ws.send(position(470025977, 24.9812, 55.0104, { Sog: 0.1, NavigationalStatus: 5 }));
    });
  });
  await new Promise<void>((r) => wss.on('listening', () => { port = (wss.address() as { port: number }).port; r(); }));
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, SERVICE_TOKEN: TOKEN, HUB_RETRY_BASE_MS: '10', HUB_RETRY_MAX_MS: '100', HUB_FORCE_STUB: 'false', NODE_ENV: 'test' } as never);
  const resolver = new StaticPrincipalResolver({ admin: { id: 'admin', sub: 'admin', name: 'Admin', email: 'admin@x', perms: ['*'], scope: { level: 'NATIONAL' }, kind: 'user', active: true } });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer(); hub = app.get(HubClient);
});
afterAll(async () => { await app?.close(); await pool?.end(); await new Promise((r) => wss.close(r)); });

describe('the AIS stream — the protocol, without a socket', () => {
  it('reads the counterpart\'s messages into one target per ship and answers the positions contract from them', () => {
    const c = new AisStreamCollector({ url: 'ws://127.0.0.1:1', apiKey: 'k', boundingBoxes: boxesOf(null) });
    c.ingest(position(470032162, 25.2012, 55.2087)); c.ingest(statics(470032162)); c.ingest(position(470025977, 24.9812, 55.0104, { Sog: 0.1, NavigationalStatus: 5 }));
    c.ingest('not json'); c.ingest(JSON.stringify({ MessageType: 'Unknown', MetaData: { MMSI: 1 }, Message: {} })); c.ingest(position(1, 99, 200));
    const all = c.snapshot();
    expect(all).toHaveLength(2);
    const t = all.find((x) => x.mmsi === '470032162')!;
    expect(t).toMatchObject({ name: 'GULF TRADER', imo: '9725354', callSign: 'A6E123', shipType: 70, destination: 'AEJEA', draught: 9.4, length: 180, width: 30, eta: '09-07 04:30', sog: 11.8, cog: 118, heading: 120, navStatus: 'UNDER_WAY', at: '2026-09-06T06:10:15.123Z' });
    expect(all.find((x) => x.mmsi === '470025977')).toMatchObject({ navStatus: 'MOORED', navStatusCode: 5, sog: 0.1 });
    expect(c.snapshot(new Date('2026-09-06T06:20:00Z'))).toEqual([]);
    const answer = positionsAnswer(all, '2026-09-06T05:00:00Z');
    expect(answer).toMatchObject({ source: 'aisstream', count: 2 });
    expect(answer.positions[0]).toMatchObject({ imo: '9725354', mmsi: '470032162', lat: 25.2012, lon: 55.2087, sog: 11.8, cog: 118, navStatus: 'UNDER_WAY', destination: 'AEJEA', at: '2026-09-06T06:10:15.123Z' });
    expect(c.status()).toMatchObject({ messages: 5, positions: 2, statics: 1, targets: 2, running: false, connected: false });
    expect(navStatusOf(1)).toBe('AT_ANCHOR'); expect(navStatusOf(null)).toBe('UNDEFINED'); expect(navStatusOf(42)).toBe('UNDEFINED');
    expect(parseMessage('{}')).toEqual({ type: '', meta: {}, body: {} });
  });
  it('subscribes with the key, the boxes and the message types the counterpart expects, and defaults the boxes to the region', () => {
    expect(JSON.parse(subscription({ url: 'wss://x', apiKey: 'k', boundingBoxes: [[[24, 50], [27, 58]]] }))).toEqual({ APIKey: 'k', BoundingBoxes: [[[24, 50], [27, 58]]], FilterMessageTypes: ['PositionReport', 'ShipStaticData'] });
    expect(JSON.parse(subscription({ url: 'wss://x', apiKey: 'k', boundingBoxes: [[[24, 50], [27, 58]]], classB: true })).FilterMessageTypes).toContain('StandardClassBPositionReport');
    expect(boxesOf(undefined)).toEqual([[[5, 42], [32, 80]]]);
    expect(boxesOf({ boundingBoxes: [[[24, 50], [27, 58]], [[91, 0], [92, 1]], 'junk'] })).toEqual([[[24, 50], [27, 58]]]);
    expect(boxesOf({ boundingBoxes: [[[27, 50], [24, 58]]] })).toEqual([[[5, 42], [32, 80]]]);
  });
  it('a stream over TLS is an acceptable counterpart; a plain one is not outside a local stub', () => {
    expect(endpointProblem('wss://stream.aisstream.io/v0/stream')).toBeNull();
    expect(endpointProblem('ws://stream.aisstream.io/v0/stream')).toMatch(/https/);
    expect(endpointProblem(`ws://127.0.0.1:${port}`, { allowLocal: true })).toBeNull();
    expect(endpointProblem(`ws://127.0.0.1:${port}`)).toMatch(/https/);
  });
});

describe('the AIS stream — against a counterpart', () => {
  it('connects, subscribes with the key, fills its buffer, and reconnects when the line drops', async () => {
    sockets = []; subscriptions = [];
    const c = new AisStreamCollector({ url: `ws://127.0.0.1:${port}`, apiKey: 'good-key', boundingBoxes: [[[24, 50], [27, 58]]] });
    c.start();
    await until(() => c.status().targets === 2);
    expect(subscriptions[0]).toMatchObject({ APIKey: 'good-key', BoundingBoxes: [[[24, 50], [27, 58]]] });
    expect(c.status()).toMatchObject({ running: true, connected: true, targets: 2, reconnects: 0 });
    // the counterpart drops the line: the collector comes back on its own, with the buffer intact
    sockets[0].terminate();
    await until(() => sockets.length === 2 && c.status().connected, 6000);
    expect(c.status().reconnects).toBeGreaterThanOrEqual(1);
    expect(c.snapshot()).toHaveLength(2);
    // new boxes: a fresh subscription
    c.configure({ url: `ws://127.0.0.1:${port}`, apiKey: 'good-key', boundingBoxes: [[[20, 50], [30, 60]]] });
    await until(() => subscriptions.length === 3, 6000);
    expect(subscriptions[2]).toMatchObject({ BoundingBoxes: [[[20, 50], [30, 60]]] });
    c.stop();
    expect(c.status()).toMatchObject({ running: false, connected: false });
  });
  it('a probe tells a good key from a bad one', async () => {
    expect(await probeStream({ url: `ws://127.0.0.1:${port}`, apiKey: 'good-key', boundingBoxes: boxesOf(null) }, 3000)).toMatchObject({ ok: true });
    const bad = await probeStream({ url: `ws://127.0.0.1:${port}`, apiKey: 'bad-key', boundingBoxes: boxesOf(null) }, 3000);
    expect(bad.ok).toBe(false); expect(bad.detail).toMatch(/Not Valid|invalid key|closed/);
    expect((await probeStream({ url: 'ws://127.0.0.1:1', apiKey: 'k', boundingBoxes: boxesOf(null) }, 1500)).ok).toBe(false);
  });
  it('switched live with a key, the adapter answers the positions contract from the hub\'s buffer and reports its stream', async () => {
    const put = await request(server as never).put('/integrations/ais-lrit').set('authorization', admin)
      .send({ mode: 'live', baseUrl: `ws://127.0.0.1:${port}`, auth: { type: 'apiKey' }, secrets: { apiKey: 'good-key' }, schedule: { boundingBoxes: [[[24, 50], [27, 58]]] } });
    expect(put.status).toBe(200);
    expect(put.body.data).toMatchObject({ mode: 'live', baseUrl: `ws://127.0.0.1:${port}`, secrets: { apiKey: true }, schedule: { boundingBoxes: [[[24, 50], [27, 58]]] } });
    await until(() => (hub.streamStatus()?.targets ?? 0) === 2, 6000);
    const call = await request(server as never).post('/internal/call/ais-lrit').set('x-service-token', TOKEN).send({ operation: 'positions', payload: { since: '2026-09-06T05:00:00Z' } });
    expect(call.status).toBe(201);
    expect(call.body.data).toMatchObject({ status: 'ok', mode: 'live' });
    expect(call.body.data.data).toMatchObject({ source: 'aisstream', count: 2 });
    expect(call.body.data.data.positions.map((p: { mmsi: string }) => p.mmsi).sort()).toEqual(['470025977', '470032162']);
    const detail = await request(server as never).get('/integrations/ais-lrit').set('authorization', admin);
    expect(detail.body.data.stream).toMatchObject({ running: true, connected: true, targets: 2, boxes: 1 });
    const test = await request(server as never).post('/integrations/ais-lrit/test').set('authorization', admin);
    expect(test.body.data).toMatchObject({ ok: true, mode: 'live' }); expect(test.body.data.detail).toMatch(/2 ships in the buffer/);
    // the track operation is not a stream's to answer
    const track = await request(server as never).post('/internal/call/ais-lrit').set('x-service-token', TOKEN).send({ operation: 'vesselTrack', payload: { imo: '9725354', from: 'a', to: 'b' } });
    expect(track.body.data.status).not.toBe('ok');
    // back to stub: the collector stops and the recorded contract answers again
    expect((await request(server as never).put('/integrations/ais-lrit').set('authorization', admin).send({ mode: 'stub' })).status).toBe(200);
    await until(() => hub.streamStatus() === null, 4000);
    const stub = await request(server as never).post('/internal/call/ais-lrit').set('x-service-token', TOKEN).send({ operation: 'positions', payload: { since: '2026-09-06T05:00:00Z' } });
    expect(stub.body.data).toMatchObject({ status: 'ok', mode: 'stub' }); expect(stub.body.data.data.count).toBe(3);
  });
  it('live with a wrong key, the feed is told plainly rather than handed an empty sea', async () => {
    await request(server as never).put('/integrations/ais-lrit').set('authorization', admin).send({ mode: 'live', baseUrl: `ws://127.0.0.1:${port}`, auth: { type: 'apiKey' }, secrets: { apiKey: 'bad-key' } });
    await until(() => !!hub.streamStatus() && !!hub.streamStatus()!.lastError, 6000);
    const call = await request(server as never).post('/internal/call/ais-lrit').set('x-service-token', TOKEN).send({ operation: 'positions', payload: { since: '2026-09-06T05:00:00Z' } });
    expect(call.body.data.status).not.toBe('ok'); expect(String(call.body.data.error)).toMatch(/502/);
    const test = await request(server as never).post('/integrations/ais-lrit/test').set('authorization', admin);
    expect(test.body.data.ok).toBe(false);
    await request(server as never).put('/integrations/ais-lrit').set('authorization', admin).send({ mode: 'stub' });
    await until(() => hub.streamStatus() === null, 4000);
  });
});
