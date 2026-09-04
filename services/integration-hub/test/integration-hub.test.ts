import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createApp, loadEnv, runMigrations, signHS256, StaticPrincipalResolver, PRINCIPAL_RESOLVER } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { ADAPTERS, TOTAL_OPERATIONS, adapterByKey } from '../src/adapters/registry';
import { fixturePath, materialise } from '../src/stubs';

const DB = 'maritime_integration_hub_test';
const DB_URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`;
const SECRET = 'test-secret-test-secret';
const TOKEN = 'test-service-token-test-service-token';
let app: INestApplication; let server: unknown; let pool: Pool;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const viewer = tok('viewer');
const srv = () => request(server as never);
/** A service-to-service POST: the token goes on the request, not on the agent. */
const svcPost = (path: string) => srv().post(path).set('x-service-token', TOKEN);

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  const boot = new Pool({ connectionString: DB_URL });
  await runMigrations(boot, join(__dirname, '..', 'migrations'));
  await boot.end();
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: DB_URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, SERVICE_TOKEN: TOKEN, HUB_RETRY_BASE_MS: '10', HUB_RETRY_MAX_MS: '100' } as never);
  const resolver = new StaticPrincipalResolver({
    admin: { id: 'admin', sub: 'admin', name: 'Admin', email: 'admin@maritime.example', perms: ['*'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
    viewer: { id: 'viewer', sub: 'viewer', name: 'Viewer', email: 'viewer@maritime.example', perms: ['dashboard.view'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer();
  pool = new Pool({ connectionString: DB_URL });
});
afterAll(async () => { await app?.close(); await pool?.end(); });

describe('the adapter registry', () => {
  it('covers every external system RFP §5.4 names, each with a counterpart and a traceable reference', () => {
    expect(ADAPTERS.map((a) => a.key).sort()).toEqual(
      ['ais-lrit','classification','gisis','icp','messaging','mohre','payment','uae-pass']);
    for (const a of ADAPTERS) {
      expect(a.counterpart.length, a.key).toBeGreaterThan(3);
      expect(a.reference, a.key).toMatch(/RFP|TAD/);
      expect(a.operations.length, a.key).toBeGreaterThan(0);
    }
  });
  it('records a fixture for every declared operation — the fixture is the contract', () => {
    for (const a of ADAPTERS) {
      for (const op of a.operations) {
        const p = fixturePath(a.key, op.key);
        expect(existsSync(p), `${a.key}.${op.key}`).toBe(true);
        const fx = JSON.parse(readFileSync(p, 'utf8'));
        expect(typeof fx.status, `${a.key}.${op.key}`).toBe('number');
        expect(fx.body, `${a.key}.${op.key}`).toBeDefined();
      }
    }
  });
  it('registers every adapter in the database on boot, in stub mode', async () => {
    const r = await pool.query<{ n: string; stubs: string }>(
      "SELECT count(*)::text AS n, count(*) FILTER (WHERE mode='stub')::text AS stubs FROM adapters");
    expect(Number(r.rows[0].n)).toBe(ADAPTERS.length);
    // Nothing points at a live counterpart until someone deliberately switches it.
    expect(Number(r.rows[0].stubs)).toBe(ADAPTERS.length);
  });
  it('marks state-changing operations idempotent and read operations not', () => {
    expect(adapterByKey('payment')!.operations.find((o) => o.key === 'createIntent')!.idempotent).toBe(true);
    expect(adapterByKey('payment')!.operations.find((o) => o.key === 'settlement')!.idempotent).toBe(false);
  });
});

describe('fixture materialisation', () => {
  it('substitutes request values so a stub answers about what was actually asked', () => {
    const out = materialise({ subject: 'uaepass:{id}', nested: [{ echo: '{id}' }] }, { id: '784-1' });
    expect(out).toEqual({ subject: 'uaepass:784-1', nested: [{ echo: '784-1' }] });
  });
  it('leaves a placeholder alone when the request has no such field, rather than writing undefined', () => {
    expect(materialise({ a: '{missing}' }, {})).toEqual({ a: '{missing}' });
  });
});

describe('calling through the hub', () => {
  it('answers from the recorded contract and logs the call', async () => {
    const r = await svcPost('/internal/call/uae-pass')
      .send({ operation: 'verifyIdentity', payload: { emiratesId: '784-1988-1234567-1' } }).expect(201);
    expect(r.body.data.status).toBe('ok');
    expect(r.body.data.mode).toBe('stub');
    expect((r.body.data.data as { subject: string }).subject).toBe('uaepass:784-1988-1234567-1');
    const logged = await pool.query("SELECT * FROM calls WHERE adapter='uae-pass' AND status='ok'");
    expect(logged.rowCount).toBeGreaterThan(0);
  });

  it('refuses a missing required field before the call leaves the platform, and names it', async () => {
    const r = await svcPost('/internal/call/uae-pass').send({ operation: 'verifyIdentity', payload: {} }).expect(400);
    expect(r.body.message).toContain('emiratesId');
  });

  it('replays an idempotent call instead of asking the counterpart twice', async () => {
    const body = { operation: 'createIntent', idempotencyKey: 'INV-TEST-1', payload: { invoiceNo: 'INV-TEST-1', amountMinor: 1000, currency: 'AED' } };
    const first = await svcPost('/internal/call/payment').send(body).expect(201);
    const second = await svcPost('/internal/call/payment').send(body).expect(201);
    expect(first.body.data.replayed).toBeFalsy();
    expect(second.body.data.replayed).toBe(true);
    // the same call row, not a second one
    expect(second.body.data.callId).toBe(first.body.data.callId);
    const n = await pool.query("SELECT count(*)::text AS n FROM calls WHERE adapter='payment' AND idempotency_key='INV-TEST-1'");
    expect(Number(n.rows[0].n)).toBe(1);
  });

  it('does not replay a read operation, which is not idempotent by declaration', async () => {
    const body = { operation: 'settlement', idempotencyKey: 'K1', payload: { reference: 'PAY-1' } };
    await svcPost('/internal/call/payment').send(body).expect(201);
    const second = await svcPost('/internal/call/payment').send(body).expect(201);
    expect(second.body.data.replayed).toBeFalsy();
  });

  it('rejects an unknown adapter or operation rather than guessing', async () => {
    await svcPost('/internal/call/nope').send({ operation: 'x' }).expect(404);
    await svcPost('/internal/call/uae-pass').send({ operation: 'nope' }).expect(404);
  });

  it('is service-to-service only — a user token cannot reach a counterpart', async () => {
    await srv().post('/internal/call/uae-pass').send({ operation: 'verifyIdentity', payload: { emiratesId: '1' } }).expect(401);
    await srv().post('/internal/call/uae-pass').set('Authorization', admin)
      .send({ operation: 'verifyIdentity', payload: { emiratesId: '1' } }).expect(401);
  });

  it('retries a failing counterpart, then dead-letters rather than losing the call', async () => {
    await pool.query("UPDATE adapters SET mode='live', base_url='http://127.0.0.1:59998', timeout_ms=200, max_attempts=3 WHERE key='messaging'");
    const r = await svcPost('/internal/call/messaging').send({ operation: 'sendSms', payload: { to: '+971500000000', body: 'x' } }).expect(201);
    expect(r.body.data.status).toBe('dead');
    expect(r.body.data.attempts).toBe(3);
    const dl = await pool.query("SELECT * FROM dead_letters WHERE adapter='messaging'");
    expect(dl.rowCount).toBe(1);
    await pool.query("UPDATE adapters SET mode='stub', timeout_ms=8000 WHERE key='messaging'");
  });
});

describe('operating the hub', () => {
  it('lists the registry to a platform viewer and refuses everyone else', async () => {
    await srv().get('/integrations').expect(401);
    await srv().get('/integrations').set('Authorization', viewer).expect(403);
    const r = await srv().get('/integrations').set('Authorization', admin).expect(200);
    expect(r.body.data).toHaveLength(ADAPTERS.length);
    expect(r.body.data[0]).toHaveProperty('last24h');
  });

  it('certifies an adapter against every recorded operation', async () => {
    const r = await srv().post('/integrations/gisis/certify').set('Authorization', admin).expect(201);
    expect(r.body.data.operations).toBe(adapterByKey('gisis')!.operations.length);
    expect(r.body.data.passed).toBe(r.body.data.operations);
    const stored = await pool.query("SELECT * FROM certifications WHERE adapter='gisis'");
    expect(stored.rowCount).toBe(1);
  });

  it('switches an adapter to live only for a caller who may manage settings', async () => {
    await srv().post('/integrations/icp/mode').set('Authorization', viewer).send({ mode: 'live' }).expect(403);
    await srv().post('/integrations/icp/mode').set('Authorization', admin)
      .send({ mode: 'live', baseUrl: 'https://icp.example/ws' }).expect(201);
    const r = await pool.query<{ mode: string }>("SELECT mode FROM adapters WHERE key='icp'");
    expect(r.rows[0].mode).toBe('live');
    await srv().post('/integrations/icp/mode').set('Authorization', admin).send({ mode: 'stub' }).expect(201);
  });

  it('replays a dead letter once and refuses a second replay', async () => {
    const dl = await pool.query<{ id: string }>("SELECT id::text FROM dead_letters ORDER BY id DESC LIMIT 1");
    const id = dl.rows[0].id;
    await srv().post(`/integrations/dead-letters/${id}/replay`).set('Authorization', admin).expect(201);
    await srv().post(`/integrations/dead-letters/${id}/replay`).set('Authorization', admin).expect(400);
  });

  it('reports the operation count on health, so a missing adapter is visible without a query', async () => {
    const r = await srv().get('/health').expect(200);
    expect(r.body.data.adapters).toBe(ADAPTERS.length);
    expect(r.body.data.operations).toBe(TOTAL_OPERATIONS);
  });
});
