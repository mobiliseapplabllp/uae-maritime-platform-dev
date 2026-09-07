import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { join } from 'node:path';
import { createServer } from 'node:net';
import { EVENTS } from '@maritime/contracts';
import { createApp, loadEnv, runMigrations, signHS256, StaticPrincipalResolver, PRINCIPAL_RESOLVER } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
// the sandbox is plain Node under tools/, the same file the runner starts
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore — an .mjs without a declaration; its shape is asserted below
import { OUTCOMES, createIcpSandbox } from '../../../tools/counterparts/icp/sandbox.mjs';

/*
 * The live SOAP path, over the network, end to end: the hub speaks to the ICP sandbox as it would to the authority —
 * an envelope out, an envelope back and read into fields, the outcome polled and then pushed to the hub's signed
 * inbound address. Nothing in the hub knows it is a sandbox: the adapter is pointed at an address, live, and the
 * switch to the authority is that address and its credentials.
 */
const DB = 'maritime_integration_hub_icp_test';
const DB_URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`;
const SECRET = 'test-secret-test-secret';
const TOKEN = 'test-service-token-test-service-token';
let app: INestApplication; let pool: Pool; let hubPort = 0; let hubUrl = '';
let sandbox: { listen: (port?: number, host?: string) => Promise<{ port: number }>; close: () => Promise<void>; reviews: Map<string, Record<string, unknown>>; decide: (ref: string) => Promise<unknown> };
let sandboxPort = 0;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin');
const srv = () => request(hubUrl);
const call = (operation: string, payload: Record<string, unknown>) => srv().post('/internal/call/icp').set('x-service-token', TOKEN).send({ operation, payload });
const freePort = () => new Promise<number>((resolve) => { const s = createServer(); s.listen(0, '127.0.0.1', () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
const until = async (test: () => Promise<boolean>, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (await test()) return true; await new Promise((r) => setTimeout(r, 50)); } return false; };

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  const boot = new Pool({ connectionString: DB_URL }); await runMigrations(boot, join(__dirname, '..', 'migrations')); await boot.end();
  hubPort = await freePort(); hubUrl = `http://127.0.0.1:${hubPort}`;
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: DB_URL, PORT: String(hubPort), AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, SERVICE_TOKEN: TOKEN, PUBLIC_API_URL: hubUrl, HUB_RETRY_BASE_MS: '10', HUB_RETRY_MAX_MS: '100' } as never);
  const resolver = new StaticPrincipalResolver({ admin: { id: 'admin', sub: 'admin', name: 'Admin', email: 'admin@maritime.example', perms: ['*'], scope: { level: 'NATIONAL' }, kind: 'user', active: true } });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.listen(hubPort, '127.0.0.1');
  pool = new Pool({ connectionString: DB_URL });
});
afterAll(async () => { await sandbox?.close(); await app?.close(); await pool?.end(); });

describe('the ICP sandbox counterpart, spoken to live', () => {
  it('is handed a signed inbound address and pointed at, live, like any counterpart', async () => {
    const rotated = await srv().post('/integrations/icp/inbound/rotate').set('authorization', admin);
    expect(rotated.status).toBe(201);
    expect(rotated.body.data.url).toBe(`${hubUrl}/integrations/inbound/icp`);
    sandbox = createIcpSandbox({ decisionMs: 250, mix: [0, 100, 0], callback: { url: rotated.body.data.url, secret: rotated.body.data.secret }, log: () => undefined });
    sandboxPort = (await sandbox.listen(0)).port;
    const live = await srv().put('/integrations/icp').set('authorization', admin).send({ mode: 'live', baseUrl: `http://127.0.0.1:${sandboxPort}`, auth: { type: 'none' }, inboundEnabled: true });
    expect(live.status).toBe(200); expect(live.body.data).toMatchObject({ mode: 'live', protocol: 'soap' });
    const test = await srv().post('/integrations/icp/test').set('authorization', admin);
    expect(test.body.data).toMatchObject({ mode: 'live', ok: true, httpStatus: 200 });
  });
  it('submits a review as SOAP and reads the reference back as fields, refuses a submission without a reason, and polls the outcome', async () => {
    const submitted = await call('requestReview', { facilityId: 'AEJEA-T1', reason: 'Annual verification of the facility security plan' });
    expect(submitted.status).toBe(201);
    expect(submitted.body.data).toMatchObject({ status: 'ok', mode: 'live', httpStatus: 202 });
    const answer = submitted.body.data.data as { reference: string; status: string; facilityId: string; expectedBy: string };
    expect(answer.reference).toMatch(/^ICP-REV-\d{4}-[0-9A-F]{6}$/);
    expect(answer).toMatchObject({ status: 'SUBMITTED', facilityId: 'AEJEA-T1' }); expect(answer.expectedBy).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // the sandbox received an envelope, not JSON
    const review = sandbox.reviews.get(answer.reference)!;
    expect(review).toMatchObject({ facilityId: 'AEJEA-T1', reason: 'Annual verification of the facility security plan', status: 'SUBMITTED' });
    // a submission with no reason never leaves the hub; one with a blank reason reaches the authority and comes back as a fault, read into fields
    const missing = await call('requestReview', { facilityId: 'AEJEA-T1', reason: '' });
    expect(missing.status).toBe(400); expect(sandbox.reviews.size).toBe(1);
    const refused = await call('requestReview', { facilityId: 'AEJEA-T1', reason: '   ' });
    expect(refused.body.data).toMatchObject({ status: 'failed', httpStatus: 400, error: 'HTTP 400' });
    expect(sandbox.reviews.size).toBe(1);
    const pending = await call('reviewStatus', { reference: answer.reference });
    expect(pending.body.data.data).toMatchObject({ reference: answer.reference, status: 'SUBMITTED', decidedAt: '', conditions: [] });
    // the authority decides; the mix given to the sandbox makes it clear with conditions attached
    expect(await until(async () => sandbox.reviews.get(answer.reference)?.status !== 'SUBMITTED')).toBe(true);
    const decided = await call('reviewStatus', { reference: answer.reference });
    const d = decided.body.data.data as { status: string; decidedAt: string; conditions: string[] };
    expect(OUTCOMES).toContain(d.status); expect(d.status).toBe('CLEARED');
    expect(d.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/); expect(d.conditions.length).toBeGreaterThan(0);
    expect((await call('reviewStatus', { reference: 'ICP-REV-2026-NOPE00' })).body.data).toMatchObject({ status: 'failed', httpStatus: 404 });
  });
  it('pushes the decision to the signed inbound address, where it lands once and is handed to the platform', async () => {
    const ref = [...sandbox.reviews.keys()][0];
    expect(await until(async () => (await pool.query("SELECT 1 FROM inbound_events WHERE adapter = 'icp' AND event_type = 'icp.review.decided'")).rowCount === 1)).toBe(true);
    const row = (await pool.query<{ payload: Record<string, unknown> }>("SELECT payload FROM inbound_events WHERE adapter = 'icp'")).rows[0];
    expect(row.payload).toMatchObject({ reference: ref, status: 'CLEARED', event: 'icp.review.decided' });
    expect((row.payload.conditions as string[]).length).toBeGreaterThan(0);
    const handed = (await pool.query("SELECT payload FROM outbox WHERE payload->>'type' = $1", [EVENTS.integration.inboundReceived])).rows;
    expect(handed).toHaveLength(1);
    expect((handed[0].payload as { data: Record<string, unknown> }).data).toMatchObject({ adapter: 'icp', eventType: 'icp.review.decided' });
    expect(sandbox.reviews.get(ref)).toMatchObject({ callback: { status: 201, attempt: 1 } });
  });
});
