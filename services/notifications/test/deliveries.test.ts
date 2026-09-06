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
let hubMode: 'ok' | 'dead' | 'down' = 'ok'; let prefs: Record<string, unknown> = { emailEnabled: true, smsEnabled: true, escalationHours: 4 };
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const srv = () => request(server as never);

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' }); await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedNotifications(URL, 'AE');
  fake = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      // the settings service answers the notifications section; every other section is unset, so no relay is configured
      if (req.url?.startsWith('/internal/settings/notifications')) return json(200, { success: true, data: prefs });
      if (req.url?.startsWith('/internal/settings/')) return json(404, { success: false, message: 'unset' });
      // the identity service names who holds a permission: two people for the survey desk, nobody for a permission no role carries
      if (req.url?.startsWith('/internal/principals?perm=inspections.view')) return json(200, { success: true, data: { perm: 'inspections.view', items: [{ id: 'u1', name: 'Noora', email: 'noora@maritime.example', phone: '+971500000001' }, { id: 'u2', name: 'Salem', email: 'salem@maritime.example', phone: '' }] } });
      if (req.url?.startsWith('/internal/principals?perm=')) return json(200, { success: true, data: { perm: 'x', items: [] } });
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
    admin: { id: 'admin', sub: 'admin', name: 'Admin', email: 'admin@x', perms: ['settings.view', 'settings.manage', 'dashboard.view'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
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

describe('escalation — an unread critical notice is sent on after the window Settings → Notifications sets', () => {
  const backdate = (id: string, hours: number) => pool.query('UPDATE notifications SET created_at = now() - ($2::text || \' hours\')::interval WHERE id = $1', [id, String(hours)]);
  it('reaches everyone holding the audience permission, once each, and marks the notice escalated', async () => {
    hubCalls = []; hubMode = 'ok';
    await pool.query('UPDATE notifications SET escalated_at = now() WHERE escalated_at IS NULL'); // the seeded backlog is not this test's
    const notice = await create({ audiencePerm: 'inspections.view', severity: 'error', title: 'Detention: MV Test', body: 'Held at berth 4', link: '/inspections/x' });
    expect(notice.status).toBe(201);
    const fresh = await create({ audiencePerm: 'inspections.view', severity: 'error', title: 'Fresh detention' });
    const warning = await create({ audiencePerm: 'inspections.view', severity: 'warning', title: 'Only a warning' });
    await backdate(notice.body.data.id, 5); await backdate(warning.body.data.id, 5);
    const r = await srv().post('/notifications/escalate').set('authorization', tok('admin'));
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ hours: 4, escalated: 1, recipients: 2 });
    expect(r.body.data.items[0]).toMatchObject({ id: notice.body.data.id, audience: 'inspections.view', recipients: 2 });
    const emails = hubCalls.filter((c) => c.operation === 'sendEmail');
    expect(emails.map((c) => c.payload.to).sort()).toEqual(['noora@maritime.example', 'salem@maritime.example']);
    expect(emails[0].payload.subject).toBe('Escalated: Detention: MV Test');
    expect(emails.map((c) => c.idempotencyKey).sort()).toEqual([`notification:${notice.body.data.id}:email:esc:u1`, `notification:${notice.body.data.id}:email:esc:u2`]);
    expect(hubCalls.filter((c) => c.operation === 'sendSms').map((c) => c.payload.to)).toEqual(['+971500000001']);
    const rows = await pool.query<{ escalated_at: Date | null }>('SELECT escalated_at FROM notifications WHERE id = ANY($1) ORDER BY created_at', [[notice.body.data.id, fresh.body.data.id, warning.body.data.id]]);
    expect(rows.rows.map((x) => x.escalated_at !== null)).toEqual([true, false, false]);
    expect((await pool.query('SELECT count(*)::int AS n FROM outbox WHERE payload->>\'type\' = \'notifications.escalated\'')).rows[0].n).toBeGreaterThanOrEqual(1);
    // a second run finds nothing left to escalate
    hubCalls = [];
    expect((await srv().post('/notifications/escalate').set('authorization', tok('admin'))).body.data.escalated).toBe(0);
    expect(hubCalls).toEqual([]);
    const summary = await srv().get('/notifications/deliveries').set('authorization', tok('admin'));
    expect(summary.body.data.escalation.hours).toBe(4); expect(summary.body.data.escalation.escalated24h).toBeGreaterThanOrEqual(1);
    expect(summary.body.data.channels).toMatchObject({ email: true, sms: true, relay: 'messaging adapter' });
  });
  it('leaves a notice its addressee has read, escalates one they have not to them alone, and does nothing at zero hours', async () => {
    hubCalls = [];
    const read = await create({ userId: 'u1', severity: 'error', title: 'Read already' });
    const unread = await create({ userId: 'u2', severity: 'error', title: 'Still unread' });
    await backdate(read.body.data.id, 6); await backdate(unread.body.data.id, 6);
    await pool.query('INSERT INTO notification_reads(notification_id, user_id) VALUES ($1, $2)', [read.body.data.id, 'u1']);
    hubCalls = [];
    const r = await srv().post('/notifications/escalate').set('authorization', tok('admin'));
    expect(r.body.data).toMatchObject({ escalated: 1, recipients: 1 });
    expect(r.body.data.items[0]).toMatchObject({ id: unread.body.data.id, audience: 'user' });
    expect(hubCalls.map((c) => [c.operation, c.payload.to])).toEqual([['sendEmail', 'salem@maritime.example']]);
    prefs = { ...prefs, escalationHours: 0 };
    const later = await create({ userId: 'u2', severity: 'error', title: 'Never escalated' });
    await backdate(later.body.data.id, 9);
    hubCalls = [];
    // the service caches a section for half a minute; zero hours is what the next read after the change sees
    const { KIT_SETTINGS } = await import('@maritime/service-kit');
    (app.get(KIT_SETTINGS) as { invalidate: (k?: string) => void }).invalidate('notifications');
    expect((await srv().post('/notifications/escalate').set('authorization', tok('admin'))).body.data).toMatchObject({ hours: 0, escalated: 0 });
    expect(hubCalls).toEqual([]);
    prefs = { ...prefs, escalationHours: 4 };
    (app.get(KIT_SETTINGS) as { invalidate: (k?: string) => void }).invalidate('notifications');
    expect((await srv().post('/notifications/escalate').set('authorization', tok('ops'))).status).toBe(403);
  });
});
