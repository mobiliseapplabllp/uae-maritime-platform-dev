import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createServer, type Server } from 'node:http';
import { EVENTS } from '@maritime/contracts';
import { PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256 } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedSeafarers } from '../src/seed';

/* The labour ministry's employment check through the MOHRE adapter, recorded on the seafarer. */
const DB = 'maritime_seafarers_mohre_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let fake: Server; let port = 0; let dead = false; let last: Record<string, unknown> = {};
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const srv = () => request(server as never);
beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' }); await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedSeafarers(URL, 'AE');
  fake = createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
    const b = JSON.parse(raw); last = b; res.writeHead(200, { 'content-type': 'application/json' });
    const base = { callId: '1', adapter: 'mohre', operation: b.operation, mode: 'stub', httpStatus: 200, attempts: 1, durationMs: 2 };
    res.end(JSON.stringify({ success: true, data: dead ? { ...base, status: 'dead', httpStatus: 504, attempts: 3, data: null, error: 'HTTP 504' } : { ...base, status: 'ok', data: { emiratesId: b.payload.emiratesId, employed: true, establishment: 'Gulf Star Shipping LLC', establishmentLicence: 'MOHRE-778120', occupation: 'Able Seafarer Deck', validTo: '2027-03-31' } } }));
  }); });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => { port = (fake.address() as { port: number }).port; r(); }));
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, INTEGRATION_HUB_URL: `http://127.0.0.1:${port}` } as never);
  const base = { scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    desk: { ...base, id: 'desk', sub: 'desk', name: 'Crewing Desk', perms: ['seafarers.view', 'seafarers.edit'] },
    viewer: { ...base, id: 'viewer', sub: 'viewer', name: 'Viewer', perms: ['seafarers.view'] },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) }); await app.init(); server = app.getHttpServer();
  pool = new Pool({ connectionString: URL });
});
afterAll(async () => { await app?.close(); await pool?.end(); await new Promise((r) => fake.close(r)); });

describe('employment verification', () => {
  it('asks the ministry with the seafarer\'s identity, records the answer on the record, and audits it', async () => {
    const s = (await srv().get('/seafarers?limit=1').set('authorization', tok('desk'))).body.data[0];
    expect((await srv().post(`/seafarers/${s.id}/verify-employment`).set('authorization', tok('viewer'))).status).toBe(403);
    const r = await srv().post(`/seafarers/${s.id}/verify-employment`).set('authorization', tok('desk'));
    expect(r.status).toBe(201);
    expect(r.body.data.employmentCheck).toMatchObject({ employed: true, establishment: 'Gulf Star Shipping LLC', establishmentLicence: 'MOHRE-778120', occupation: 'Able Seafarer Deck', validTo: '2027-03-31', mode: 'stub', checkedBy: 'Crewing Desk' });
    expect(last).toMatchObject({ operation: 'verifyEmployment', payload: { emiratesId: s.nationalId || s.seafarerId || s.cdcNo } });
    expect((await srv().get(`/seafarers/${s.id}`).set('authorization', tok('viewer'))).body.data.employmentCheck.employed).toBe(true);
    const audits = (await pool.query("SELECT payload FROM outbox WHERE payload->>'type' = $1 AND payload->'data'->>'action' = 'VERIFY_EMPLOYMENT'", [EVENTS.audit.recorded])).rows;
    expect(audits).toHaveLength(1);
    dead = true;
    const down = await srv().post(`/seafarers/${s.id}/verify-employment`).set('authorization', tok('desk'));
    expect(down.status).toBe(502); expect(down.body.message).toMatch(/labour ministry: HTTP 504/); dead = false;
  });
});
