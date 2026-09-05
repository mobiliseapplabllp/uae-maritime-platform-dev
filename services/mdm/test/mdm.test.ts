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
    // An external member of the port community: holds facilities.view over the directory, and is one of the
    // companies in it.
    agent: { id: 'agent', sub: 'agent', name: 'Agent', email: 'agent@maritime.example', perms: ['facilities.view'], scope: { level: 'COMPANY', companies: ['GSS'] }, kind: 'user', active: true },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer();
});
afterAll(async () => { await app?.close(); });
const g = (p: string, t = admin) => request(server as never).get(p).set('authorization', t);

describe('mdm', () => {
  it('seeds every declared master with counts and lists by category', async () => {
    const cats = await g('/lookups/categories'); expect(cats.body.data).toHaveLength(49); expect(cats.body.data.every((c: { count: number }) => c.count > 0)).toBe(true); expect(cats.body.data.find((c: { key: string }) => c.key === 'vesselType').count).toBeGreaterThan(5);
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
    // every mirror applies the change from the event alone: the entry rides on it, with the category's live count
    const px = new Pool({ connectionString: URL }); const events = (await px.query("SELECT payload FROM outbox WHERE payload->>'type' = 'mdm.lookup.changed' ORDER BY id")).rows.map((r) => r.payload as { data: Record<string, any> }); await px.end();
    const made = events.find((e) => e.data.change === 'created' && e.data.code === 'LNG'); expect(made?.data.lookup).toMatchObject({ category: 'vesselType', code: 'LNG', label: 'LNG Carrier', labelAr: 'ناقلة غاز', active: true }); expect(made?.data.count).toBeGreaterThan(5);
    const gone = events.find((e) => e.data.change === 'deactivated' && e.data.code === 'LNG'); expect(gone?.data.lookup.active).toBe(false);
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

describe('the company directory and the company file', () => {
  const as = (who: string) => tok(who);

  it('answers a company by its code and by its id', async () => {
    // `id` is a uuid and `code` is text, so `WHERE id = $1 OR code = $1` could not be typed and this route
    // answered 500 to everyone, for either kind of reference. It was never exercised until now.
    const byCode = await request(server as never).get('/companies/GSS').set('authorization', as('admin')).expect(200);
    expect(byCode.body.data.code).toBe('GSS');
    const byId = await request(server as never).get(`/companies/${byCode.body.data.id}`).set('authorization', as('admin')).expect(200);
    expect(byId.body.data.code).toBe('GSS');
    expect(byCode.body.data.id).toBe(byId.body.data.id);
    await request(server as never).get('/companies/NOPE').set('authorization', as('admin')).expect(404);
  });

  it('publishes the directory to the community and keeps the file to the administration', async () => {
    const mine = (await request(server as never).get('/companies/GSS').set('authorization', as('agent')).expect(200)).body.data;
    const theirs = (await request(server as never).get('/companies/WCM').set('authorization', as('agent')).expect(200)).body.data;
    const official = (await request(server as never).get('/companies/WCM').set('authorization', as('admin')).expect(200)).body.data;

    // a company reads its own record whole
    expect(mine.taxId).toBeTruthy();
    expect(mine.rating).toBeTypeOf('number');
    // and everyone else's as a directory entry: enough to do business with them, nothing more
    expect(theirs.name).toBe(official.name);
    expect(theirs.contactEmail).toBe(official.contactEmail);
    expect(theirs.status).toBe(official.status);
    for (const withheld of ['taxId', 'registrationNo', 'rating', 'real', 'recordStatus']) {
      expect(theirs, `${withheld} reached a competitor`).not.toHaveProperty(withheld);
      expect(official).toHaveProperty(withheld);
    }
  });

  it('withholds the file from every row of the list, not only the one that is fetched', async () => {
    const rows = (await request(server as never).get('/companies?limit=100').set('authorization', as('agent')).expect(200)).body.data;
    expect(rows.length).toBeGreaterThan(3);
    const carrying = rows.filter((c: { taxId?: string }) => 'taxId' in c).map((c: { code: string }) => c.code);
    expect(carrying, 'the list handed over more than the reader owns').toEqual(['GSS']);
  });
});
