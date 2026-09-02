import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createApp, loadEnv, signHS256, StaticPrincipalResolver, PRINCIPAL_RESOLVER, KIT_BUS, MemoryBus } from '@maritime/service-kit';
import { makeEvent, EVENTS, subjectFor } from '@maritime/contracts';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { verifyChain } from '../src/ledger';

const DB = 'maritime_audit_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let bus: MemoryBus;
const admin = `Bearer ${signHS256({ sub: 'admin', typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const payload = (i: number) => ({ action: i % 2 ? 'UPDATE' : 'CREATE', entity: 'Thing', entityId: String(i), entityLabel: `thing ${i}`, before: null, after: { i }, note: null, actor: { id: 'u1', name: 'User One', kind: 'user' }, ip: null, at: new Date().toISOString(), service: 'test' });

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' }); await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET } as never);
  const resolver = new StaticPrincipalResolver({ admin: { id: 'admin', sub: 'admin', name: 'Admin', email: 'a@x', perms: ['audit.view'], scope: { level: 'NATIONAL' }, kind: 'user', active: true } });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }), migrationsDir: `${__dirname}/../migrations` });
  await app.init(); server = app.getHttpServer(); bus = app.get(KIT_BUS);
});
afterAll(async () => { await app?.close(); });

describe('audit ledger', () => {
  it('appends events exactly once and chains hashes', async () => {
    const events = Array.from({ length: 5 }, (_, i) => makeEvent({ type: EVENTS.audit.recorded, source: 'test', data: payload(i) }));
    for (const e of events) await bus.publish(subjectFor(e.type), e);
    await bus.publish(subjectFor(events[0].type), events[0]); // duplicate delivery
    await bus.drain();
    const list = await request(server as never).get('/audit?limit=10').set('authorization', admin);
    expect(list.body.meta.total).toBe(5); expect(list.body.data[0].hash).toMatch(/^[0-9a-f]{64}$/);
    const v = await request(server as never).get('/audit/verify').set('authorization', admin); expect(v.body.data).toEqual({ ok: true, checked: 5, brokenAt: null });
  });
  it('refuses updates and deletes at the database and detects tampering', async () => {
    const pool = new Pool({ connectionString: URL });
    await expect(pool.query("UPDATE audit_entries SET note = 'x' WHERE seq = 1")).rejects.toThrow('append-only');
    await expect(pool.query('DELETE FROM audit_entries WHERE seq = 1')).rejects.toThrow('append-only');
    await pool.query('ALTER TABLE audit_entries DISABLE TRIGGER audit_entries_no_update'); await pool.query("UPDATE audit_entries SET entity_label = 'tampered' WHERE seq = 3"); await pool.query('ALTER TABLE audit_entries ENABLE TRIGGER audit_entries_no_update');
    const v = await verifyChain(pool); expect(v.ok).toBe(false); expect(v.brokenAt).toBe(3);
    await pool.end();
  });
  it('filters and requires the audit permission', async () => {
    const r = await request(server as never).get('/audit?action=CREATE').set('authorization', admin); expect(r.body.meta.total).toBe(3);
    expect((await request(server as never).get('/audit')).status).toBe(401);
  });
});
