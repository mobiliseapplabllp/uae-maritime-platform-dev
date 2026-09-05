import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { join } from 'node:path';
import { createServer, type Server } from 'node:http';
import { EVENTS } from '@maritime/contracts';
import { createApp, loadEnv, runMigrations, signHS256, StaticPrincipalResolver, PRINCIPAL_RESOLVER } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { inboundProblem, signInbound } from '../src/inbound';

/*
 * Adapters as configuration: an operator points a declared adapter at its counterpart with credentials that never
 * come back out, adds a counterpart nobody declared, tests the connection, and hands a counterpart a signed inbound
 * address. The counterpart in these tests is a small HTTP server on this machine that records what it was asked.
 */
const DB = 'maritime_integration_hub_dyn_test';
const DB_URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`;
const SECRET = 'test-secret-test-secret';
const TOKEN = 'test-service-token-test-service-token';
let app: INestApplication; let server: unknown; let pool: Pool;
let counterpart: Server; let port = 0; let seen: { path: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
let answer: (path: string) => { status: number; body: unknown } = () => ({ status: 200, body: { ok: true } });
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const viewer = tok('viewer'); const reader = tok('reader');
const srv = () => request(server as never);
const outbox = async (type: string) => (await pool.query("SELECT payload FROM outbox WHERE payload->>'type' = $1 ORDER BY id", [type])).rows.map((r) => r.payload as { data: Record<string, any> });

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  const boot = new Pool({ connectionString: DB_URL }); await runMigrations(boot, join(__dirname, '..', 'migrations')); await boot.end();
  counterpart = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      seen.push({ path: req.url ?? '', headers: req.headers, body: raw });
      const out = answer(req.url ?? ''); res.writeHead(out.status, { 'content-type': 'application/json' }); res.end(JSON.stringify(out.body));
    });
  });
  await new Promise<void>((r) => counterpart.listen(0, '127.0.0.1', () => { port = (counterpart.address() as { port: number }).port; r(); }));
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: DB_URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, SERVICE_TOKEN: TOKEN, HUB_RETRY_BASE_MS: '10', HUB_RETRY_MAX_MS: '100', HUB_FORCE_STUB: 'false', PUBLIC_API_URL: 'https://maritime.example/api' } as never);
  const resolver = new StaticPrincipalResolver({
    admin: { id: 'admin', sub: 'admin', name: 'Admin', email: 'admin@maritime.example', perms: ['*'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
    viewer: { id: 'viewer', sub: 'viewer', name: 'Viewer', email: 'viewer@maritime.example', perms: ['settings.view'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
    reader: { id: 'reader', sub: 'reader', name: 'Reader', email: 'reader@maritime.example', perms: ['dashboard.view'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer();
  pool = new Pool({ connectionString: DB_URL });
});
afterAll(async () => { await app?.close(); await pool?.end(); await new Promise((r) => counterpart.close(r)); });
const base = () => `http://127.0.0.1:${port}`;

describe('configuring a declared adapter', () => {
  it('reports credentials as present, never as values, and audits the change masked', async () => {
    const r = await srv().put('/integrations/mohre').set('authorization', admin)
      .send({ auth: { type: 'apiKey', header: 'x-mohre-key' }, secrets: { apiKey: 'k-12345' }, headers: { 'x-tenant': 'maritime' }, timeoutMs: 4000, maxAttempts: 2, description: 'Employment checks' });
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ key: 'mohre', kind: 'system', auth: { type: 'apiKey', header: 'x-mohre-key' }, secrets: { apiKey: true }, headers: { 'x-tenant': 'maritime' }, timeoutMs: 4000, maxAttempts: 2, updatedBy: 'Admin <admin@maritime.example>' });
    expect(JSON.stringify(r.body)).not.toContain('k-12345');
    const stored = await pool.query<{ secrets: Record<string, string> }>("SELECT secrets FROM adapters WHERE key = 'mohre'");
    expect(stored.rows[0].secrets.apiKey).toMatch(/^v1:/); expect(stored.rows[0].secrets.apiKey).not.toContain('k-12345');
    const audits = await outbox(EVENTS.audit.recorded);
    expect(JSON.stringify(audits)).not.toContain('k-12345');
    const changed = await outbox(EVENTS.integration.adapterChanged); expect(changed.at(-1)?.data).toMatchObject({ key: 'mohre', change: 'configured' });
    // a later change that does not mention the credential keeps it
    const keep = await srv().put('/integrations/mohre').set('authorization', admin).send({ description: 'Employment and sponsor checks' });
    expect(keep.body.data.secrets).toEqual({ apiKey: true });
    // and a blank clears it
    const clear = await srv().put('/integrations/mohre').set('authorization', admin).send({ secrets: { apiKey: '' } });
    expect(clear.body.data.secrets).toEqual({ apiKey: false });
  });
  it('refuses a credential that does not belong to the authentication, a reserved header, and a live switch without an address', async () => {
    // the stub address the adapter shipped with is its own: saving without changing it is not a request to point somewhere internal
    const same = await srv().put('/integrations/mohre').set('authorization', admin).send({ baseUrl: 'https://stub.local/mohre', description: 'unchanged address' });
    expect(same.status).toBe(200);
    expect((await srv().put('/integrations/mohre').set('authorization', admin).send({ baseUrl: 'https://stub.local/other' })).status).toBe(400);
    expect((await srv().put('/integrations/mohre').set('authorization', admin).send({ secrets: { token: 'x' } })).body.message).toMatch(/token does not belong to apiKey/);
    expect((await srv().put('/integrations/mohre').set('authorization', admin).send({ headers: { authorization: 'Bearer x' } })).status).toBe(400);
    expect((await srv().put('/integrations/mohre').set('authorization', admin).send({ mode: 'live' })).body.message).toMatch(/cannot be used live|needs its counterpart/);
    expect((await srv().put('/integrations/mohre').set('authorization', admin).send({ operations: [] })).body.message).toMatch(/operations are code/);
    expect((await srv().put('/integrations/mohre').set('authorization', viewer).send({ description: 'x' })).status).toBe(403);
    expect((await srv().get('/integrations').set('authorization', viewer)).status).toBe(200);
    expect((await srv().get('/integrations').set('authorization', reader)).status).toBe(403);
    expect((await srv().delete('/integrations/mohre').set('authorization', admin)).status).toBe(403);
  });
  it('speaks to the live counterpart with the credentials and headers it was configured with', async () => {
    seen = []; answer = () => ({ status: 200, body: { emiratesId: '784-1', employed: true, establishment: 'Test Co' } });
    const live = await srv().put('/integrations/mohre').set('authorization', admin).send({ mode: 'live', baseUrl: base(), auth: { type: 'apiKey', header: 'x-mohre-key' }, secrets: { apiKey: 'k-12345' } });
    expect(live.status).toBe(200); expect(live.body.data.mode).toBe('live');
    const out = await srv().post('/internal/call/mohre').set('x-service-token', TOKEN).send({ operation: 'verifyEmployment', payload: { emiratesId: '784-1' } });
    expect(out.body.data).toMatchObject({ status: 'ok', mode: 'live', httpStatus: 200, data: { employed: true } });
    expect(seen).toHaveLength(1); expect(seen[0].path).toBe('/v1/employment/784-1');
    expect(seen[0].headers['x-mohre-key']).toBe('k-12345'); expect(seen[0].headers['x-tenant']).toBe('maritime');
    // basic and bearer authentication travel in the authorization header
    await srv().put('/integrations/mohre').set('authorization', admin).send({ auth: { type: 'basic' }, secrets: { username: 'u', password: 'p' } });
    await srv().post('/internal/call/mohre').set('x-service-token', TOKEN).send({ operation: 'verifyEmployment', payload: { emiratesId: '784-2' } });
    expect(seen[1].headers.authorization).toBe(`Basic ${Buffer.from('u:p').toString('base64')}`);
    await srv().put('/integrations/mohre').set('authorization', admin).send({ auth: { type: 'bearer' }, secrets: { token: 't-1' } });
    await srv().post('/internal/call/mohre').set('x-service-token', TOKEN).send({ operation: 'verifyEmployment', payload: { emiratesId: '784-3' } });
    expect(seen[2].headers.authorization).toBe('Bearer t-1');
  });
  it('tests the connection: the recorded contract in stub mode, the counterpart\'s health address in live mode', async () => {
    seen = []; answer = (p) => (p === '/health' ? { status: 200, body: { up: true } } : { status: 404, body: {} });
    await srv().put('/integrations/mohre').set('authorization', admin).send({ healthPath: '/health' });
    const live = await srv().post('/integrations/mohre/test').set('authorization', admin);
    expect(live.body.data).toMatchObject({ mode: 'live', ok: true, httpStatus: 200 }); expect(live.body.data.target).toBe(`${base()}/health`);
    expect(seen[0].headers.authorization).toBe('Bearer t-1');
    answer = () => ({ status: 503, body: {} });
    const down = await srv().post('/integrations/mohre/test').set('authorization', admin);
    expect(down.body.data).toMatchObject({ ok: false, httpStatus: 503 }); expect(down.body.data.detail).toMatch(/HTTP 503/);
    const calls = await srv().get('/integrations/calls?adapter=mohre&status=failed').set('authorization', admin);
    expect(calls.body.data.some((c: { operation: string }) => c.operation === 'test-connection')).toBe(true);
    await srv().put('/integrations/mohre').set('authorization', admin).send({ mode: 'stub' });
    const stub = await srv().post('/integrations/mohre/test').set('authorization', admin);
    expect(stub.body.data).toMatchObject({ mode: 'stub', ok: true }); expect(stub.body.data.detail).toMatch(/2 of 2 operations recorded/);
    expect((await srv().post('/integrations/mohre/test').set('authorization', viewer)).status).toBe(403);
  });
  it('runs a call from the console on the same path a service takes, and it shows in the history', async () => {
    const r = await srv().post('/integrations/classification/invoke').set('authorization', admin).send({ operation: 'vesselStatus', payload: { imo: '9000001' } });
    expect(r.body.data).toMatchObject({ status: 'ok', mode: 'stub', data: { imo: '9000001', status: 'IN_CLASS' } });
    const detail = await srv().get('/integrations/classification').set('authorization', viewer);
    expect(detail.body.data.recentCalls[0]).toMatchObject({ operation: 'vesselStatus', correlationId: 'console:admin' });
    expect(detail.body.data.inboundUrl).toBe('https://maritime.example/api/integrations/inbound/classification');
    expect((await srv().post('/integrations/classification/invoke').set('authorization', admin).send({ operation: 'nope' })).status).toBe(404);
  });
});

describe('an adapter nobody declared', () => {
  const custom = {
    key: 'port-community', name: 'Port community system', counterpart: 'Port community platform', protocol: 'rest', baseUrl: 'https://pcs.example', auth: { type: 'bearer' }, secrets: { token: 'pcs-token' },
    operations: [
      { key: 'manifest', summary: 'Cargo manifest for a call', method: 'GET', path: '/v2/calls/{vcn}/manifest', required: ['vcn'], idempotent: false, sample: { status: 200, body: { vcn: '{vcn}', lines: 3 } } },
      { key: 'notify', summary: 'Tell the community a berth changed', method: 'POST', path: '/v2/events', required: ['vcn', 'berth'], idempotent: true },
    ],
  };
  it('is created with its operations, answers from its samples in stub mode, and is certified against them', async () => {
    expect((await srv().post('/integrations').set('authorization', viewer).send(custom)).status).toBe(403);
    expect((await srv().post('/integrations').set('authorization', admin).send({ ...custom, key: 'Bad Key' })).status).toBe(400);
    expect((await srv().post('/integrations').set('authorization', admin).send({ ...custom, key: 'mohre' })).status).toBe(409);
    expect((await srv().post('/integrations').set('authorization', admin).send({ ...custom, baseUrl: 'https://169.254.169.254/latest' })).body.message).toMatch(/reserved range/);
    expect((await srv().post('/integrations').set('authorization', admin).send({ ...custom, operations: [custom.operations[0], custom.operations[0]] })).body.message).toMatch(/unique/);
    const made = await srv().post('/integrations').set('authorization', admin).send(custom);
    expect(made.status).toBe(201);
    expect(made.body.data).toMatchObject({ key: 'port-community', kind: 'custom', mode: 'stub', secrets: { token: true }, operations: [{ key: 'manifest', recorded: true }, { key: 'notify', recorded: false }] });
    expect(JSON.stringify(made.body)).not.toContain('pcs-token');
    const list = await srv().get('/integrations').set('authorization', admin);
    expect(list.body.data.map((a: { key: string }) => a.key)).toContain('port-community');
    const call = await srv().post('/internal/call/port-community').set('x-service-token', TOKEN).send({ operation: 'manifest', payload: { vcn: 'VCN-77' } });
    expect(call.body.data).toMatchObject({ status: 'ok', mode: 'stub', data: { vcn: 'VCN-77', lines: 3 } });
    const unrecorded = await srv().post('/internal/call/port-community').set('x-service-token', TOKEN).send({ operation: 'notify', payload: { vcn: 'VCN-77', berth: 'B4' }, idempotencyKey: 'n1' });
    expect(unrecorded.body.data.status).toBe('dead'); expect(unrecorded.body.data.error).toMatch(/no recorded answer/);
    expect((await outbox(EVENTS.integration.callDead)).at(-1)?.data).toMatchObject({ adapter: 'port-community', operation: 'notify' });
    const cert = await srv().post('/integrations/port-community/certify').set('authorization', admin);
    expect(cert.body.data).toMatchObject({ operations: 2, passed: 1 });
    expect((await srv().post('/integrations/port-community/test').set('authorization', admin)).body.data).toMatchObject({ ok: false });
  });
  it('speaks to its live counterpart the same way a declared adapter does, and can be edited and removed', async () => {
    seen = []; answer = () => ({ status: 202, body: { accepted: true } });
    const edit = await srv().put('/integrations/port-community').set('authorization', admin).send({ mode: 'live', baseUrl: base(), operations: [...custom.operations, { key: 'ping', summary: 'Ping', method: 'GET', path: '/ping', required: [], idempotent: false }] });
    expect(edit.status).toBe(200); expect(edit.body.data.operations).toHaveLength(3);
    const out = await srv().post('/internal/call/port-community').set('x-service-token', TOKEN).send({ operation: 'notify', payload: { vcn: 'VCN-77', berth: 'B4' }, idempotencyKey: 'n2' });
    expect(out.body.data).toMatchObject({ status: 'ok', mode: 'live', httpStatus: 202 });
    expect(seen[0].path).toBe('/v2/events'); expect(seen[0].headers.authorization).toBe('Bearer pcs-token'); expect(JSON.parse(seen[0].body)).toEqual({ vcn: 'VCN-77', berth: 'B4' });
    const again = await srv().post('/internal/call/port-community').set('x-service-token', TOKEN).send({ operation: 'notify', payload: { vcn: 'VCN-77', berth: 'B4' }, idempotencyKey: 'n2' });
    expect(again.body.data.replayed).toBe(true); expect(seen).toHaveLength(1);
    expect((await srv().delete('/integrations/port-community').set('authorization', viewer)).status).toBe(403);
    expect((await srv().delete('/integrations/port-community').set('authorization', admin)).body.data).toEqual({ key: 'port-community', removed: true });
    expect((await srv().get('/integrations/port-community').set('authorization', admin)).status).toBe(404);
    expect((await outbox(EVENTS.integration.adapterChanged)).at(-1)?.data).toMatchObject({ key: 'port-community', change: 'removed' });
  });
});

describe('what a counterpart pushes to us', () => {
  const body = { type: 'settlement', reference: 'PAY-1', status: 'SETTLED' };
  const raw = JSON.stringify(body);
  const deliver = (secret: string, opts: { ts?: number; delivery?: string; sig?: string; key?: string } = {}) => {
    const ts = opts.ts ?? Math.floor(Date.now() / 1000);
    return srv().post(`/integrations/inbound/${opts.key ?? 'payment'}`).set('content-type', 'application/json')
      .set('x-hub-timestamp', String(ts)).set('x-hub-delivery', opts.delivery ?? 'd-1').set('x-hub-signature', opts.sig ?? signInbound(secret, ts, raw)).send(raw);
  };
  it('has no inbound address until a key is issued, and the key is shown once', async () => {
    expect((await deliver('whatever')).status).toBe(404);
    expect((await srv().post('/integrations/payment/inbound/rotate').set('authorization', viewer)).status).toBe(403);
    const r = await srv().post('/integrations/payment/inbound/rotate').set('authorization', admin);
    expect(r.body.data.secret).toMatch(/^[A-Za-z0-9_-]{40,}$/); expect(r.body.data.url).toBe('https://maritime.example/api/integrations/inbound/payment');
    const detail = await srv().get('/integrations/payment').set('authorization', admin);
    expect(detail.body.data.inbound).toEqual({ enabled: true, secretSet: true }); expect(JSON.stringify(detail.body)).not.toContain(r.body.data.secret);
    (globalThis as { __inboundSecret?: string }).__inboundSecret = r.body.data.secret;
  });
  it('accepts a signed, current delivery once, publishes it, and refuses the forged, the stale and the unsigned', async () => {
    const secret = (globalThis as { __inboundSecret?: string }).__inboundSecret!;
    const ok = await deliver(secret);
    expect(ok.status).toBe(201); expect(ok.body.data).toMatchObject({ accepted: true, duplicate: false, deliveryId: 'd-1' });
    const events = await outbox(EVENTS.integration.inboundReceived);
    expect(events.at(-1)?.data).toMatchObject({ adapter: 'payment', deliveryId: 'd-1', eventType: 'settlement', payload: body });
    const dup = await deliver(secret); expect(dup.body.data).toMatchObject({ accepted: true, duplicate: true });
    expect(await outbox(EVENTS.integration.inboundReceived)).toHaveLength(events.length);
    expect((await deliver('wrong-key', { delivery: 'd-2' })).status).toBe(401);
    expect((await deliver(secret, { delivery: 'd-3', ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    expect((await deliver(secret, { delivery: 'd-4', sig: 'nope' })).body.message).toMatch(/x-hub-signature/);
    const unsigned = await srv().post('/integrations/inbound/payment').set('content-type', 'application/json').send(raw); expect(unsigned.status).toBe(401);
    expect((await srv().get('/integrations/payment/inbound').set('authorization', admin)).body.data).toHaveLength(1);
    // a rotated key retires the old one at once
    const again = await srv().post('/integrations/payment/inbound/rotate').set('authorization', admin);
    expect((await deliver(secret, { delivery: 'd-5' })).status).toBe(401);
    expect((await deliver(again.body.data.secret, { delivery: 'd-5' })).status).toBe(201);
  });
  it('names each refusal, and binds the timestamp into the signature so a capture cannot be replayed with a fresh clock', () => {
    const rawBuf = Buffer.from(raw); const ts = Math.floor(Date.now() / 1000);
    expect(inboundProblem(undefined, {}, 's')).toMatch(/needs a body/);
    expect(inboundProblem(rawBuf, { timestamp: 'x' }, 's')).toMatch(/timestamp is required/);
    expect(inboundProblem(rawBuf, { timestamp: String(ts - 900) }, 's')).toMatch(/outside the accepted window/);
    expect(inboundProblem(rawBuf, { timestamp: String(ts) }, 's')).toMatch(/delivery is required/);
    expect(inboundProblem(rawBuf, { timestamp: String(ts), delivery: 'd', signature: signInbound('s', ts - 1, rawBuf) }, 's')).toMatch(/does not match/);
    expect(inboundProblem(rawBuf, { timestamp: String(ts), delivery: 'd', signature: signInbound('s', ts, rawBuf) }, 's')).toBeNull();
  });
});
