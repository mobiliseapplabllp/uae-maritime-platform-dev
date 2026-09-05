import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createServer, type Server } from 'node:http';
import { createApp, loadEnv, signHS256, StaticPrincipalResolver, PRINCIPAL_RESOLVER } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedNotifications } from '../src/seed';

/* A notification for one person also reaches their inbox and phone through the messaging adapter. The identity
 * service, the settings service and the integration hub are one small fake here, answering by path. */
const DB = 'maritime_notifications_deliveries_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret'; const TOKEN = 'svc-token';
let app: INestApplication; let server: unknown; let pool: Pool; let fake: Server; let port = 0;
let hubCalls: { operation: string; payload: Record<string, unknown>; idempotencyKey?: string }[] = [];
let hubMode: 'ok' | 'dead' | 'down' = 'ok'; let prefs = { emailEnabled: true, smsEnabled: true };
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const srv = () => request(server as never);

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' }); await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedNotifications(URL, 'AE');
  fake = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      if (req.url?.startsWith('/internal/settings/')) return json(200, { success: true, data: prefs });
      if (req.url === '/internal/principals/u1') return json(200, { success: true, data: { id: 'u1', email: 'noora@maritime.example', phone: '+971500000001' } });
      if (req.url === '/internal/principals/u2') return json(200, { success: true, data: { id: 'u2', email: 'salem@maritime.example' } });
      if (req.url?.startsWith('/internal/principals/')) return json(404, { success: false, message: 'Unknown principal' });
      if (req.url === '/internal/call/messaging') {
        const b = JSON.parse(raw); hubCalls.push({ operation: b.operation, payload: b.payload, idempotencyKey: b.idempotencyKey });
        if (hubMode === 'down') return json(503, { success: false, message: 'hub down' });
        if (hubMode === 'dead') return json(200, { success: true, data: { callId: '9', adapter: 'messaging', operation: b.operation, status: 'dead', mode: 'live', httpStatus: 502, attempts: 3, durationMs: 40, data: null, error: 'HTTP 502' } });
        return json(200, { success: true, data: { callId: '7', adapter: 'messaging', operation: b.operation, status: 'ok', mode: 'stub', httpStatus: 202, attempts: 1, durationMs: 3, data: { messageId: b.operation === 'sendSms' ? 'SMS-1' : 'EML-1', to: b.payload.to } } });
      }
      json(404, {});
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => { port = (fake.address() as { port: number }).port; r(); }));
  const base = `http://127.0.0.1:${port}`;
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, SERVICE_TOKEN: TOKEN, IDENTITY_URL: base, MDM_URL: base, INTEGRATION_HUB_URL: base } as never);
  const resolver = new StaticPrincipalResolver({
    ops: { id: 'ops', sub: 'ops', name: 'Ops', email: 'ops@x', perms: ['dashboard.view'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
    admin: { id: 'admin', sub: 'admin', name: 'Admin', email: 'admin@x', perms: ['settings.view', 'dashboard.view'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) }); await app.init(); server = app.getHttpServer();
  pool = new Pool({ connectionString: URL });
});
afterAll(async () => { await app?.close(); await pool?.end(); await new Promise((r) => fake.close(r)); });
const create = (body: Record<string, unknown>) => srv().post('/notifications/internal').set('x-service-token', TOKEN).send({ title: 'Approval needed', body: 'A grant waits for you', severity: 'warning', link: '/admin/users?pending=true', source: 'identity-access', ...body });

describe('deliveries', () => {
  it('sends a person\'s notification by email and SMS through the messaging adapter, once each, and records both', async () => {
    hubCalls = [];
    const r = await create({ userId: 'u1' });
    expect(r.status).toBe(201);
    expect(r.body.data.deliveries.map((d: { channel: string; status: string; recipient: string; messageId: string }) => [d.channel, d.status, d.recipient, d.messageId])).toEqual([['email', 'sent', 'noora@maritime.example', 'EML-1'], ['sms', 'sent', '+971500000001', 'SMS-1']]);
    expect(hubCalls.map((c) => c.operation)).toEqual(['sendEmail', 'sendSms']);
    expect(hubCalls[0].payload).toMatchObject({ to: 'noora@maritime.example', subject: 'Approval needed', body: 'A grant waits for you' });
    expect(hubCalls[0].idempotencyKey).toBe(`notification:${r.body.data.id}:email`);
  });
  it('records why a message did not go: no phone, a hub that is down, a counterpart that refused', async () => {
    hubCalls = [];
    const noPhone = await create({ userId: 'u2' });
    expect(noPhone.body.data.deliveries).toMatchObject([{ channel: 'email', status: 'sent' }, { channel: 'sms', status: 'skipped', error: 'no phone number on the account' }]);
    hubMode = 'down';
    const down = await create({ userId: 'u1' });
    expect(down.body.data.deliveries.every((d: { status: string }) => d.status === 'skipped')).toBe(true); expect(down.body.data.deliveries[0].error).toMatch(/hub answered 503|hub down/);
    hubMode = 'dead';
    const refused = await create({ userId: 'u1' });
    expect(refused.body.data.deliveries[0]).toMatchObject({ status: 'failed', error: 'HTTP 502', callId: '9', mode: 'live' });
    hubMode = 'ok';
    const unknown = await create({ userId: 'ghost' });
    expect(unknown.body.data.deliveries).toMatchObject([{ channel: 'email', status: 'skipped', error: 'no email address on the account' }, { channel: 'sms', status: 'skipped' }]);
  });
  it('sends nothing for a broadcast, nothing when the settings say not to, and lists what left the platform', async () => {
    hubCalls = [];
    const broadcast = await create({ audiencePerm: 'dashboard.view' });
    expect(broadcast.body.data.deliveries).toEqual([]); expect(hubCalls).toHaveLength(0);
    const list = await srv().get('/notifications/deliveries').set('authorization', tok('admin'));
    expect(list.status).toBe(200); expect(list.body.data.items.length).toBeGreaterThanOrEqual(8);
    expect(list.body.data.last24h.email.sent).toBeGreaterThanOrEqual(2); expect(list.body.data.last24h.sms.skipped).toBeGreaterThanOrEqual(3);
    expect((await srv().get('/notifications/deliveries?status=failed').set('authorization', tok('admin'))).body.data.items.every((d: { status: string }) => d.status === 'failed')).toBe(true);
    expect((await srv().get('/notifications/deliveries').set('authorization', tok('ops'))).status).toBe(403);
  });
});
