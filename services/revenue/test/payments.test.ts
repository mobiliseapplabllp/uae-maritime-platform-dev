import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createServer, type Server } from 'node:http';
import { EVENTS, makeEvent, subjectFor } from '@maritime/contracts';
import { KIT_BUS, MemoryBus, PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256 } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedRevenue } from '../src/seed';

/* Online payment through the gateway adapter: an intent is opened for the balance, settlement is heard by asking or by
 * the gateway's callback, and the account is paid once whichever way it is heard. The hub is a small fake here. */
const DB = 'maritime_revenue_payments_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let bus: MemoryBus; let fake: Server; let port = 0;
let calls: { operation: string; payload: Record<string, unknown>; idempotencyKey?: string }[] = []; let dead = false; let settled = false;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const fin = tok('fin'); const viewer = tok('viewer');
const srv = () => request(server as never);

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' }); await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedRevenue(URL, 'AE');
  fake = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      const json = (status: number, body: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
      const b = JSON.parse(raw); calls.push({ operation: b.operation, payload: b.payload, idempotencyKey: b.idempotencyKey });
      const base = { callId: String(calls.length), adapter: 'payment', operation: b.operation, mode: 'stub', httpStatus: 200, attempts: 1, durationMs: 2 };
      if (dead) return json(200, { success: true, data: { ...base, status: 'dead', httpStatus: 503, attempts: 3, data: null, error: 'HTTP 503' } });
      if (b.operation === 'createIntent') return json(200, { success: true, data: { ...base, status: 'ok', httpStatus: 201, data: { reference: `PAY-${b.payload.invoiceNo}`, invoiceNo: b.payload.invoiceNo, amountMinor: b.payload.amountMinor, currency: b.payload.currency, status: 'PENDING', redirectUrl: `https://pay.example/checkout/PAY-${b.payload.invoiceNo}` } } });
      if (b.operation === 'settlement') return json(200, { success: true, data: { ...base, status: 'ok', data: { reference: b.payload.reference, status: settled ? 'SETTLED' : 'PENDING', settledAt: settled ? '2026-09-05T09:00:00Z' : null, method: 'CARD' } } });
      json(404, { success: false, message: 'unknown operation' });
    });
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => { port = (fake.address() as { port: number }).port; r(); }));
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, INTEGRATION_HUB_URL: `http://127.0.0.1:${port}` } as never);
  const base = { scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    fin: { ...base, id: 'fin', sub: 'fin', name: 'Finance Officer', perms: ['invoices.view', 'invoices.pay'] },
    viewer: { ...base, id: 'viewer', sub: 'viewer', name: 'Viewer', perms: ['invoices.view'] },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) }); await app.init(); server = app.getHttpServer(); bus = app.get(KIT_BUS);
  pool = new Pool({ connectionString: URL });
});
afterAll(async () => { await app?.close(); await pool?.end(); await new Promise((r) => fake.close(r)); });
const issued = async () => {
  const r = await pool.query<{ id: string; number: string; total: string }>("SELECT id, number, total FROM invoices WHERE status = 'ISSUED' AND payment_intent IS NULL ORDER BY number LIMIT 1");
  if (r.rows[0]) { await pool.query("UPDATE invoices SET paid_amount = 0, paid_at = NULL, payments = '[]'::jsonb WHERE id = $1", [r.rows[0].id]); return r.rows[0]; }
  const d = await pool.query<{ id: string; number: string; total: string }>("UPDATE invoices SET status = 'ISSUED', issued_at = now(), due_at = now() + interval '30 days', paid_amount = 0, paid_at = NULL, payments = '[]'::jsonb WHERE id = (SELECT id FROM invoices WHERE status <> 'PAID' AND payment_intent IS NULL LIMIT 1) RETURNING id, number, total");
  return d.rows[0];
};

describe('online payment', () => {
  it('opens an intent for the balance, once per balance, and settles the account when the gateway says the payer paid', async () => {
    const inv = await issued(); calls = [];
    expect((await srv().post(`/invoices/${inv.id}/payment-intent`).set('authorization', viewer)).status).toBe(403);
    const opened = await srv().post(`/invoices/${inv.id}/payment-intent`).set('authorization', fin);
    expect(opened.status).toBe(201);
    const intent = opened.body.data.paymentIntent;
    expect(intent).toMatchObject({ reference: `PAY-${inv.number}`, status: 'PENDING', amountMinor: Math.round(Number(inv.total) * 100), currency: 'AED', mode: 'stub' });
    expect(intent.redirectUrl).toMatch(/checkout/);
    expect(calls[0]).toMatchObject({ operation: 'createIntent', payload: { invoiceNo: inv.number, amountMinor: intent.amountMinor, currency: 'AED' }, idempotencyKey: `intent:${inv.number}:${intent.amountMinor}` });
    // asked again for the same balance, the same key goes to the gateway
    await srv().post(`/invoices/${inv.id}/payment-intent`).set('authorization', fin);
    expect(calls[1].idempotencyKey).toBe(calls[0].idempotencyKey);
    settled = false;
    const pending = await srv().post(`/invoices/${inv.id}/payment-intent/refresh`).set('authorization', fin);
    expect(pending.body.data.status).toBe('ISSUED'); expect(pending.body.data.paymentIntent.status).toBe('PENDING');
    settled = true;
    const paid = await srv().post(`/invoices/${inv.id}/payment-intent/refresh`).set('authorization', fin);
    expect(paid.body.data.status).toBe('PAID'); expect(paid.body.data.paymentIntent).toMatchObject({ status: 'SETTLED', method: 'CARD' });
    expect(paid.body.data.payments).toHaveLength(1); expect(paid.body.data.payments[0]).toMatchObject({ ref: `PAY-${inv.number}`, method: 'GATEWAY', amount: Number(inv.total) });
    const events = (await pool.query("SELECT payload FROM outbox WHERE payload->>'type' = $1 ORDER BY id", [EVENTS.revenue.invoicePaid])).rows;
    expect(events.length).toBeGreaterThanOrEqual(1);
    // heard again, the account is not paid twice
    const again = await srv().post(`/invoices/${inv.id}/payment-intent/refresh`).set('authorization', fin);
    expect(again.body.data.payments).toHaveLength(1);
    expect((await srv().post(`/invoices/${inv.id}/payment-intent`).set('authorization', fin)).status).toBe(409);
  });
  it('settles from the gateway\'s callback delivered through the hub, exactly once', async () => {
    const inv = await issued(); settled = false;
    const opened = await srv().post(`/invoices/${inv.id}/payment-intent`).set('authorization', fin); expect(opened.status).toBe(201);
    const deliver = () => bus.publish(subjectFor(EVENTS.integration.inboundReceived), makeEvent({ type: EVENTS.integration.inboundReceived, source: 'integration-hub', data: { adapter: 'payment', adapterName: 'Payment gateway', deliveryId: `d-${inv.number}`, eventType: 'settlement', payload: { reference: `PAY-${inv.number}`, status: 'SETTLED', settledAt: '2026-09-05T09:30:00Z', method: 'CARD' } } }));
    await deliver(); await bus.drain();
    const after = await srv().get(`/invoices/${inv.id}`).set('authorization', fin);
    expect(after.body.data.status).toBe('PAID'); expect(after.body.data.payments).toHaveLength(1); expect(after.body.data.payments[0].by).toBe('Payment gateway');
    await deliver(); await bus.drain();
    expect((await srv().get(`/invoices/${inv.id}`).set('authorization', fin)).body.data.payments).toHaveLength(1);
    // a callback for a reference nobody holds is ignored, not an error
    await bus.publish(subjectFor(EVENTS.integration.inboundReceived), makeEvent({ type: EVENTS.integration.inboundReceived, source: 'integration-hub', data: { adapter: 'payment', deliveryId: 'd-x', eventType: 'settlement', payload: { reference: 'PAY-NOBODY', status: 'SETTLED' } } })); await bus.drain();
  });
  it('reports a gateway that will not answer as a gateway problem, and leaves the account as it was', async () => {
    const inv = await issued(); dead = true;
    const r = await srv().post(`/invoices/${inv.id}/payment-intent`).set('authorization', fin);
    expect(r.status).toBe(502); expect(r.body.message).toMatch(/payment gateway: HTTP 503/);
    dead = false;
    expect((await srv().get(`/invoices/${inv.id}`).set('authorization', fin)).body.data.paymentIntent).toBeNull();
  });
});
