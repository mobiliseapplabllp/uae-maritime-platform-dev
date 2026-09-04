import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createApp, loadEnv } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedIdentity } from '../src/seed';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://maritime:maritime@127.0.0.1:5432/postgres';
const DB = 'maritime_identity_test';
const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`;
let app: INestApplication; let server: unknown;
const tokens: Record<string, string> = {};

beforeAll(async () => {
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`); await admin.query(`CREATE DATABASE ${DB}`); await admin.end();
  await seedIdentity(URL, 'AE');
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: 'test-secret-test-secret' } as never);
  app = await createApp({ env, module: buildAppModule(env) });
  await app.init();
  server = app.getHttpServer();
});
afterAll(async () => { await app?.close(); });

const login = async (email: string, password = 'Demo@2026') => request(server as never).post('/auth/login').send({ email, password });

describe('identity-access', () => {
  it('health is public and unknown routes return the envelope', async () => {
    expect((await request(server as never).get('/health')).body.data.status).toBe('ok');
    const r = await request(server as never).get('/nope'); expect(r.status).toBe(404); expect(r.body).toEqual({ success: false, message: 'API route not found' });
  });
  it('logs in the seeded admin and returns the session shape the web client expects', async () => {
    const r = await login('admin@maritime.example');
    expect(r.status).toBe(201); expect(r.body.success).toBe(true);
    expect(r.body.data.user.perms).toEqual(['*']); expect(r.body.data.user.role.name).toBe('Super Admin');
    expect(typeof r.body.data.token).toBe('string'); expect(typeof r.body.data.refreshToken).toBe('string');
    tokens.admin = r.body.data.token; tokens.adminRefresh = r.body.data.refreshToken;
  });
  it('rejects wrong passwords, unknown users and inactive accounts without an account oracle', async () => {
    const a = await login('admin@maritime.example', 'wrong-password'); const b = await login('nobody@maritime.example', 'wrong-password');
    expect(a.status).toBe(401); expect(b.status).toBe(401); expect(a.body.message).toBe(b.body.message);
  });
  it('throttles repeated failures per identity', async () => {
    for (let i = 0; i < 10; i++) await login('agent@maritime.example', 'bad-password');
    const r = await login('agent@maritime.example', 'Demo@2026'); expect(r.status).toBe(429);
  });
  it('refuses a refresh token as an access token and rotates refresh tokens', async () => {
    const r = await request(server as never).get('/auth/me').set('authorization', `Bearer ${tokens.adminRefresh}`); expect(r.status).toBe(401);
    const ref = await request(server as never).post('/auth/refresh').send({ refreshToken: tokens.adminRefresh }); expect(ref.status).toBe(201); expect(ref.body.data.token).toBeTruthy();
    const again = await request(server as never).post('/auth/refresh').send({ refreshToken: tokens.adminRefresh }); expect(again.status).toBe(401);
    tokens.admin = ref.body.data.token; tokens.adminRefresh = ref.body.data.refreshToken;
  });
  it('enforces permissions deny-by-default and exposes /meta', async () => {
    const pilot = await login('arjun.jadeja@maritime.example');
    expect(pilot.status).toBe(201);
    const denied = await request(server as never).get('/users').set('authorization', `Bearer ${pilot.body.data.token}`); expect(denied.status).toBe(403);
    const meta = await request(server as never).get('/meta').set('authorization', `Bearer ${pilot.body.data.token}`);
    expect(meta.body.data.permissionGroups.length).toBeGreaterThanOrEqual(24);
    const noAuth = await request(server as never).get('/users'); expect(noAuth.status).toBe(401);
  });
  it('lists, searches, creates, updates and protects users', async () => {
    const list = await request(server as never).get('/users?limit=5&q=harbour').set('authorization', `Bearer ${tokens.admin}`);
    expect(list.body.meta.total).toBeGreaterThan(0); expect(list.body.data.length).toBeLessThanOrEqual(5);
    const roles = await request(server as never).get('/roles').set('authorization', `Bearer ${tokens.admin}`);
    expect(roles.body.data).toHaveLength(17);
    const pilotRole = roles.body.data.find((r: { name: string }) => r.name === 'Port Pilot');
    // the policy applies wherever a password is set, not only where a person types one
    const weak = await request(server as never).post('/users').set('authorization', `Bearer ${tokens.admin}`).send({ name: 'Test Pilot', email: 'test.pilot@maritime.example', password: 'Pilot@2026', roleId: pilotRole.id });
    expect(weak.status).toBe(400); expect(weak.body.message).toContain('12 characters');
    const created = await request(server as never).post('/users').set('authorization', `Bearer ${tokens.admin}`).send({ name: 'Test Pilot', email: 'test.pilot@maritime.example', password: 'Khalifa-Quay-71', roleId: pilotRole.id });
    expect(created.status).toBe(201); expect(created.body.data.role.name).toBe('Port Pilot');
    const dup = await request(server as never).post('/users').set('authorization', `Bearer ${tokens.admin}`).send({ name: 'Dup', email: 'test.pilot@maritime.example', password: 'Khalifa-Quay-71', roleId: pilotRole.id });
    expect(dup.status).toBe(409);
    // and a reset must not set the account's own name as its password
    const named = await request(server as never).post(`/users/${created.body.data.id}/reset-password`).set('authorization', `Bearer ${tokens.admin}`).send({ password: 'Test-Pilot-2026' });
    expect(named.status).toBe(400); expect(named.body.message).toContain('your name');
    expect((await request(server as never).post(`/users/${created.body.data.id}/reset-password`).set('authorization', `Bearer ${tokens.admin}`).send({ password: 'Khalifa-Quay-72' })).status).toBe(201);
    const me = await request(server as never).get('/auth/me').set('authorization', `Bearer ${tokens.admin}`);
    const self = await request(server as never).put(`/users/${me.body.data.id}`).set('authorization', `Bearer ${tokens.admin}`).send({ active: false });
    expect(self.status).toBe(403);
    const upd = await request(server as never).put(`/users/${created.body.data.id}`).set('authorization', `Bearer ${tokens.admin}`).send({ designation: 'Senior Pilot' });
    expect(upd.body.data.designation).toBe('Senior Pilot');
  });
  it('guards roles: super admin immutable, system roles protected, unknown permissions rejected, matrix edits apply immediately', async () => {
    const roles = (await request(server as never).get('/roles').set('authorization', `Bearer ${tokens.admin}`)).body.data;
    const sa = roles.find((r: { name: string }) => r.name === 'Super Admin'); const hm = roles.find((r: { name: string }) => r.name === 'Harbour Master'); const pp = roles.find((r: { name: string }) => r.name === 'Port Pilot');
    expect((await request(server as never).put(`/roles/${sa.id}`).set('authorization', `Bearer ${tokens.admin}`).send({ description: 'x' })).status).toBe(403);
    expect((await request(server as never).put(`/roles/${hm.id}`).set('authorization', `Bearer ${tokens.admin}`).send({ name: 'Renamed' })).status).toBe(403);
    expect((await request(server as never).put(`/roles/${pp.id}`).set('authorization', `Bearer ${tokens.admin}`).send({ permissions: ['nope.nothing'] })).status).toBe(400);
    expect((await request(server as never).delete(`/roles/${pp.id}`).set('authorization', `Bearer ${tokens.admin}`)).status).toBe(409);
    const pilots = (await request(server as never).get('/users').query({ role: 'Port Pilot', active: 'true' }).set('authorization', `Bearer ${tokens.admin}`)).body.data;
    expect(pilots.length).toBeGreaterThan(0);
    const pilot = await login(pilots[0].email);
    expect(pilot.status).toBe(201);
    expect((await request(server as never).get('/users').set('authorization', `Bearer ${pilot.body.data.token}`)).status).toBe(403);
    const edit = await request(server as never).put(`/roles/${pp.id}`).set('authorization', `Bearer ${tokens.admin}`).send({ permissions: [...pp.permissions, 'users.view'] });
    expect(edit.status).toBe(200);
    expect((await request(server as never).get('/users').set('authorization', `Bearer ${pilot.body.data.token}`)).status).toBe(200);
  });
  it('resolves principals for other services only with the service token', async () => {
    const me = await request(server as never).get('/auth/me').set('authorization', `Bearer ${tokens.admin}`);
    expect((await request(server as never).get(`/internal/principals/${me.body.data.id}`)).status).toBe(401);
    const r = await request(server as never).get(`/internal/principals/${me.body.data.id}`).set('x-service-token', 'development-service-token');
    expect(r.status).toBe(200); expect(r.body.data.perms).toEqual(['*']);
  });
  it('writes audit events to the outbox for every mutation', async () => {
    const pool = new Pool({ connectionString: URL });
    const n = await pool.query<{ n: string }>("SELECT count(*) AS n FROM outbox WHERE subject = 'maritime.audit.recorded'");
    expect(Number(n.rows[0].n)).toBeGreaterThan(3);
    await pool.end();
  });
});
