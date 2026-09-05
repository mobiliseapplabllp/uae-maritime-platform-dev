import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createServer, type Server } from 'node:http';
import { EVENTS, makeEvent, subjectFor } from '@maritime/contracts';
import { KIT_BUS, MemoryBus, PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256 } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedFacilities } from '../src/seed';

/* A port facility's security review with the federal authority through the ICP adapter: submitted, polled, and settled
 * by the authority's own callback through the hub. */
const DB = 'maritime_facilities_icp_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let bus: MemoryBus; let fake: Server; let port = 0; let cleared = false; let calls: Record<string, unknown>[] = [];
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const srv = () => request(server as never); const F = '/facilities/port-facilities';
beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' }); await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedFacilities(URL, 'AE');
  fake = createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
    const b = JSON.parse(raw); calls.push(b); res.writeHead(200, { 'content-type': 'application/json' });
    const base = { callId: String(calls.length), adapter: 'icp', operation: b.operation, mode: 'stub', httpStatus: 200, attempts: 1, durationMs: 2, status: 'ok' };
    const data = b.operation === 'requestReview'
      ? { reference: `ICP-REV-${b.payload.facilityId}`, facilityId: b.payload.facilityId, status: 'SUBMITTED', reason: b.payload.reason, expectedBy: '2026-09-18' }
      : { reference: b.payload.reference, status: cleared ? 'CLEARED' : 'IN_REVIEW', decidedAt: cleared ? '2026-09-11T09:20:00Z' : null, conditions: [] };
    res.end(JSON.stringify({ success: true, data: { ...base, data } }));
  }); });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => { port = (fake.address() as { port: number }).port; r(); }));
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, MDM_URL: 'http://127.0.0.1:1', INTEGRATION_HUB_URL: `http://127.0.0.1:${port}` } as never);
  const base = { scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    pfso: { ...base, id: 'pfso', sub: 'pfso', name: 'Port Security Desk', perms: ['facilities.view', 'facilities.manage'] },
    viewer: { ...base, id: 'viewer', sub: 'viewer', name: 'Viewer', perms: ['facilities.view'] },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) }); await app.init(); server = app.getHttpServer(); bus = app.get(KIT_BUS);
  pool = new Pool({ connectionString: URL });
});
afterAll(async () => { await app?.close(); await pool?.end(); await new Promise((r) => fake.close(r)); });

describe('the federal security review', () => {
  it('is submitted with a reason, polled for its outcome, and cannot be submitted twice while it runs', async () => {
    const f = (await srv().get(`${F}?limit=1`).set('authorization', tok('pfso'))).body.data[0];
    expect((await srv().post(`${F}/${f.id}/icp-review`).set('authorization', tok('viewer')).send({ reason: 'Annual' })).status).toBe(403);
    expect((await srv().post(`${F}/${f.id}/icp-review`).set('authorization', tok('pfso')).send({ reason: 'x' })).status).toBe(400);
    const r = await srv().post(`${F}/${f.id}/icp-review`).set('authorization', tok('pfso')).send({ reason: 'Annual statement of compliance renewal' });
    expect(r.status).toBe(201);
    expect(r.body.data.icpReview).toMatchObject({ reference: `ICP-REV-${f.code}`, status: 'SUBMITTED', reason: 'Annual statement of compliance renewal', requestedBy: 'Port Security Desk', expectedBy: '2026-09-18', mode: 'stub' });
    expect(calls[0]).toMatchObject({ operation: 'requestReview', payload: { facilityId: f.code }, idempotencyKey: expect.stringMatching(new RegExp(`^icp:${f.code}:\\d{4}-\\d{2}-\\d{2}$`)) });
    expect((await srv().post(`${F}/${f.id}/icp-review`).set('authorization', tok('pfso')).send({ reason: 'Again' })).status).toBe(409);
    cleared = false;
    const polled = await srv().post(`${F}/${f.id}/icp-review/refresh`).set('authorization', tok('pfso'));
    expect(polled.body.data.icpReview.status).toBe('IN_REVIEW');
    cleared = true;
    const done = await srv().post(`${F}/${f.id}/icp-review/refresh`).set('authorization', tok('pfso'));
    expect(done.body.data.icpReview).toMatchObject({ status: 'CLEARED', decidedAt: '2026-09-11T09:20:00Z' });
    // cleared, the facility can be submitted again
    expect((await srv().post(`${F}/${f.id}/icp-review`).set('authorization', tok('pfso')).send({ reason: 'Next year' })).status).toBe(201);
  });
  it('takes the authority\'s callback through the hub as the outcome', async () => {
    const list = (await srv().get(`${F}?limit=5`).set('authorization', tok('pfso'))).body.data; const f = list[1];
    await srv().post(`${F}/${f.id}/icp-review`).set('authorization', tok('pfso')).send({ reason: 'Change of operator' });
    await bus.publish(subjectFor(EVENTS.integration.inboundReceived), makeEvent({ type: EVENTS.integration.inboundReceived, source: 'integration-hub', data: { adapter: 'icp', deliveryId: 'icp-1', eventType: 'review', payload: { reference: `ICP-REV-${f.code}`, status: 'REJECTED', decidedAt: '2026-09-12T08:00:00Z', conditions: ['Perimeter fencing incomplete'] } } })); await bus.drain();
    const after = await srv().get(`${F}/${f.id}`).set('authorization', tok('viewer'));
    expect(after.body.data.icpReview).toMatchObject({ status: 'REJECTED', decidedAt: '2026-09-12T08:00:00Z', conditions: ['Perimeter fencing incomplete'] });
  });
});
