import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createServer, type Server } from 'node:http';
import { PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256 } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedShips } from '../src/seed';

/* The classification society's standing for a ship, through the classification adapter, recorded on the ship. */
const DB = 'maritime_ships_class_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let fake: Server; let port = 0; let dead = false; const ops: string[] = [];
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const srv = () => request(server as never);
beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' }); await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedShips(URL, 'AE');
  fake = createServer((req, res) => { let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
    const b = JSON.parse(raw); ops.push(b.operation); res.writeHead(200, { 'content-type': 'application/json' });
    const base = { callId: '1', adapter: 'classification', operation: b.operation, mode: 'stub', httpStatus: 200, attempts: 1, durationMs: 2 };
    if (dead) return res.end(JSON.stringify({ success: true, data: { ...base, status: 'dead', httpStatus: 500, attempts: 3, data: null, error: 'HTTP 500' } }));
    const data = b.operation === 'vesselStatus'
      ? { imo: b.payload.imo, society: 'Emirates Classification Society', class: '✠100A1', status: 'IN_CLASS', surveysDue: [{ kind: 'ANNUAL_HULL', dueBy: '2027-02-14' }], conditions: [] }
      : { imo: b.payload.imo, certificates: [{ kind: 'CARGO_SHIP_SAFETY_CONSTRUCTION', no: 'CSSC-114220', issued: '2024-02-14', expires: '2029-02-13', status: 'VALID' }, { kind: 'LOAD_LINE', no: 'ILL-114221', issued: '2024-02-14', expires: '2029-02-13', status: 'VALID' }] };
    res.end(JSON.stringify({ success: true, data: { ...base, status: 'ok', data } }));
  }); });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => { port = (fake.address() as { port: number }).port; r(); }));
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, INTEGRATION_HUB_URL: `http://127.0.0.1:${port}` } as never);
  const base = { scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    registrar: { ...base, id: 'registrar', sub: 'registrar', name: 'Registrar', perms: ['vessels.view', 'vessels.edit', 'certificates.view'] },
    viewer: { ...base, id: 'viewer', sub: 'viewer', name: 'Viewer', perms: ['vessels.view'] },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) }); await app.init(); server = app.getHttpServer();
  pool = new Pool({ connectionString: URL });
});
afterAll(async () => { await app?.close(); await pool?.end(); await new Promise((r) => fake.close(r)); });

describe('class status', () => {
  it('asks the society for standing and certificates, and keeps the answer on the ship', async () => {
    const v = (await srv().get('/vessels?limit=1').set('authorization', tok('registrar'))).body.data[0];
    expect((await srv().post(`/vessels/${v.id}/class-status`).set('authorization', tok('viewer'))).status).toBe(403);
    const r = await srv().post(`/vessels/${v.id}/class-status`).set('authorization', tok('registrar'));
    expect(r.status).toBe(201);
    expect(r.body.data.classStatus).toMatchObject({ society: 'Emirates Classification Society', class: '✠100A1', status: 'IN_CLASS', mode: 'stub', checkedBy: 'Registrar' });
    expect(r.body.data.classStatus.surveysDue).toHaveLength(1); expect(r.body.data.classStatus.certificates).toHaveLength(2);
    expect(ops).toEqual(['vesselStatus', 'certificates']);
    expect((await srv().get(`/vessels/${v.id}`).set('authorization', tok('viewer'))).body.data.classStatus.status).toBe('IN_CLASS');
    dead = true;
    const down = await srv().post(`/vessels/${v.id}/class-status`).set('authorization', tok('registrar'));
    expect(down.status).toBe(502); expect(down.body.message).toMatch(/classification society: HTTP 500/); dead = false;
  });
});
