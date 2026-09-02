import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createApp, loadEnv, signHS256, StaticPrincipalResolver, PRINCIPAL_RESOLVER } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedMdm } from '../src/seed';

const DB = 'maritime_mdm_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const viewer = tok('viewer');

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedMdm(URL, 'AE');
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET } as never);
  const resolver = new StaticPrincipalResolver({
    admin: { id: 'admin', sub: 'admin', name: 'Admin', email: 'admin@maritime.example', perms: ['*'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
    viewer: { id: 'viewer', sub: 'viewer', name: 'Viewer', email: 'viewer@maritime.example', perms: ['masters.view', 'settings.view', 'facilities.view', 'vessels.view'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer();
});
afterAll(async () => { await app?.close(); });
const g = (p: string, t = admin) => request(server as never).get(p).set('authorization', t);

describe('mdm', () => {
  it('seeds nineteen lookup categories with counts and lists by category', async () => {
    const cats = await g('/lookups/categories'); expect(cats.body.data).toHaveLength(19); expect(cats.body.data.find((c: { key: string }) => c.key === 'vesselType').count).toBeGreaterThan(5);
    const list = await g('/lookups?category=cargoType&limit=100'); expect(list.body.meta.total).toBeGreaterThan(8); expect(list.body.data[0].category).toBe('cargoType');
  });
  it('creates, updates and soft-deletes lookups with audit, and blocks viewers from writing', async () => {
    const created = await request(server as never).post('/lookups').set('authorization', admin).send({ category: 'vesselType', code: 'lng', label: 'LNG Carrier', labelAr: 'ناقلة غاز' });
    expect(created.status).toBe(201); expect(created.body.data.code).toBe('LNG');
    const dup = await request(server as never).post('/lookups').set('authorization', admin).send({ category: 'vesselType', code: 'LNG', label: 'x' }); expect(dup.status).toBe(409);
    const upd = await request(server as never).put(`/lookups/${created.body.data.id}`).set('authorization', admin).send({ label: 'LNG Carrier (updated)' }); expect(upd.body.data.label).toBe('LNG Carrier (updated)');
    const del = await request(server as never).delete(`/lookups/${created.body.data.id}`).set('authorization', admin); expect(del.body.data.softDelete).toBe(true);
    expect((await g(`/lookups/${created.body.data.id}`)).body.data.active).toBe(false);
    expect((await request(server as never).post('/lookups').set('authorization', viewer).send({ category: 'vesselType', code: 'X', label: 'x' })).status).toBe(403);
  });
  it('masks secrets in settings, keeps them on masked round-trips and merges module settings over defaults', async () => {
    await request(server as never).put('/settings/smtp').set('authorization', admin).send({ password: 'super-secret' });
    const all = await g('/settings'); expect(all.body.data.values.smtp.password).toBe('••••••••');
    await request(server as never).put('/settings/smtp').set('authorization', admin).send({ host: 'mail.example', password: '••••••••' });
    const pool = new Pool({ connectionString: URL }); const raw = await pool.query("SELECT value->>'password' AS p FROM settings WHERE key = 'smtp'"); await pool.end();
    expect(raw.rows[0].p).toBe('super-secret');
    const mod = await g('/module-settings/finance'); expect(mod.body.data.values.paymentTermsDays).toBe(30);
    const put = await request(server as never).put('/module-settings/finance').set('authorization', admin).send({ paymentTermsDays: 45 }); expect(put.body.data.values.paymentTermsDays).toBe(45);
    expect((await request(server as never).put('/module-settings/finance').set('authorization', admin).send({ nope: 1 })).status).toBe(400);
    const reset = await request(server as never).post('/module-settings/finance/reset').set('authorization', admin); expect(reset.body.data.values.paymentTermsDays).toBe(30);
    const internal = await request(server as never).get('/internal/settings/module:finance').set('x-service-token', 'development-service-token'); expect(internal.body.data.paymentTermsDays).toBe(30);
    expect((await request(server as never).get('/internal/settings/org')).status).toBe(401);
  });
  it('serves the public jurisdiction profile with unconfirmed figures flagged', async () => {
    const j = await request(server as never).get('/jurisdiction'); expect(j.status).toBe(200); expect(j.body.data.code).toBe('AE'); expect(j.body.data.tax.name).toBe('VAT'); expect(j.body.data.unconfirmed.length).toBeGreaterThan(0);
  });
  it('manages companies and golden vessels with IMO validation', async () => {
    const cos = await g('/companies?limit=5&q=gulf'); expect(cos.body.meta.total).toBeGreaterThan(0);
    const bad = await request(server as never).post('/golden/vessels').set('authorization', admin).send({ imo: '9700001', name: 'Bad IMO' }); expect(bad.status).toBe(400);
    const vs = await g('/golden/vessels?limit=100'); expect(vs.body.meta.total).toBe(31);
    const one = vs.body.data[0];
    const upd = await request(server as never).put(`/golden/vessels/${one.id}`).set('authorization', admin).send({ manager: 'New Managers LLC' }); expect(upd.body.data.manager).toBe('New Managers LLC');
    expect((await request(server as never).put(`/golden/vessels/${one.id}`).set('authorization', viewer).send({ manager: 'x' })).status).toBe(403);
  });
});
