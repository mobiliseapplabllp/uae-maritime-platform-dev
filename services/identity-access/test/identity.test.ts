import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { EVENTS, makeEvent } from '@maritime/contracts';
import { AuditClient, KIT_ENV, createApp, loadEnv, totpCode, withInbox } from '@maritime/service-kit';
import { envSchema, type Env } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedIdentity } from '../src/seed';
import { PolicyService } from '../src/policy';
import { UsersRepo } from '../src/users/users.repo';
import { applyEvent } from '../src/consumer';

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
    expect(roles.body.data).toHaveLength(18);
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


/* ------------------------------------------------------------------------------------- access controls --- */
describe('identity-access — access controls', () => {
  const srv = () => request(server as never);
  const get = (path: string, t: string) => srv().get(path).set('authorization', `Bearer ${t}`);
  const post = (path: string, body: unknown, t?: string) => { const r = srv().post(path).send(body as object); return t ? r.set('authorization', `Bearer ${t}`) : r; };
  const put = (path: string, body: unknown, t: string) => srv().put(path).send(body as object).set('authorization', `Bearer ${t}`);
  const del = (path: string, t: string) => srv().delete(path).set('authorization', `Bearer ${t}`);
  const UUID = /^[0-9a-f-]{36}$/;
  let policy: PolicyService; let pool: Pool;
  const deps = () => ({ env: app.get<Env>(KIT_ENV), audit: app.get(AuditClient), users: app.get(UsersRepo), policy });
  beforeAll(() => { policy = app.get(PolicyService); pool = new Pool({ connectionString: URL }); });
  afterAll(async () => { policy.setOverride(null); await pool.end(); });

  it('seeds the second administrator and the port and facility accounts, and tells a session its policy', async () => {
    const ia = await login('idadmin@maritime.example');
    expect(ia.status).toBe(201); expect(ia.body.data.user.role.name).toBe('Identity Administrator'); expect(ia.body.data.user.perms).toEqual(expect.arrayContaining(['users.manage', 'roles.manage']));
    expect(ia.body.data.mfa).toEqual({ required: true, enrolled: false, dueAt: null });
    expect(ia.body.data.policy).toMatchObject({ idleTimeoutMinutes: 30, accessTokenMinutes: 15, mfaRequiredFrom: null });
    expect(ia.body.data.sessionId).toMatch(UUID);
    const po = await login('portofficer@maritime.example'); expect(po.body.data.user.scope).toEqual({ level: 'PORT', ports: ['AEFJR'] });
    const ts = await login('terminal@maritime.example'); expect(ts.body.data.user.scope).toEqual({ level: 'FACILITY', facilities: ['CT3-1'], ports: ['AEAUH'] });
    const roles = (await get('/roles', tokens.admin)).body.data;
    expect(roles.find((r: { code: string }) => r.code === 'AG').mfaRequired).toBe(false);
    expect(roles.find((r: { code: string }) => r.code === 'HM').mfaRequired).toBe(true);
  });

  it('enrols an authenticator from the security page, then asks for its code at sign-in — each code once, a recovery code once', async () => {
    const s = await login('harbour@maritime.example'); const t = s.body.data.token;
    expect((await get('/auth/mfa', t)).body.data).toMatchObject({ enrolled: false, required: true, enforcedFrom: null });
    const setup = await post('/auth/mfa/setup', {}, t);
    expect(setup.status).toBe(201); expect(setup.body.data.otpauthUri).toContain('otpauth://totp/'); expect(setup.body.data.secret).toMatch(/^[A-Z2-7]{32}$/);
    const secret = setup.body.data.secret as string;
    // a code from ten minutes ago is outside the window and activates nothing
    expect((await post('/auth/mfa/activate', { code: totpCode(secret, Date.now() - 10 * 60_000) }, t)).status).toBe(401);
    const act = await post('/auth/mfa/activate', { code: totpCode(secret) }, t);
    expect(act.status).toBe(201); expect(act.body.data.recoveryCodes).toHaveLength(8);
    expect((await get('/auth/mfa', t)).body.data).toMatchObject({ enrolled: true, recoveryCodesLeft: 8 });
    // sign-in now stops after the password
    const step1 = await login('harbour@maritime.example');
    expect(step1.status).toBe(201); expect(step1.body.data).toMatchObject({ mfaRequired: true, method: 'totp' }); expect(step1.body.data.token).toBeUndefined();
    // the half-finished sign-in is not a session
    expect((await get('/auth/me', step1.body.data.mfaToken)).status).toBe(401);
    expect((await get('/users', step1.body.data.mfaToken)).status).toBe(401);
    // the activation consumed this half-minute's code, so the sign-in uses the next one — the window allows a step of drift
    const code = totpCode(secret, Date.now() + 30_000);
    const done = await post('/auth/mfa/verify', { mfaToken: step1.body.data.mfaToken, code });
    expect(done.status).toBe(201); expect(done.body.data.token).toBeTruthy(); expect(done.body.data.mfa).toMatchObject({ enrolled: true, required: true }); expect(done.body.data.usedRecoveryCode).toBe(false);
    expect((await get('/auth/me', done.body.data.token)).status).toBe(200);
    // the same code again is a replay
    const again = await login('harbour@maritime.example');
    expect((await post('/auth/mfa/verify', { mfaToken: again.body.data.mfaToken, code })).status).toBe(401);
    // a recovery code signs in, once
    const rc = act.body.data.recoveryCodes[0];
    const viaRecovery = await post('/auth/mfa/verify', { mfaToken: (await login('harbour@maritime.example')).body.data.mfaToken, code: rc });
    expect(viaRecovery.status).toBe(201); expect(viaRecovery.body.data.usedRecoveryCode).toBe(true);
    expect((await post('/auth/mfa/verify', { mfaToken: (await login('harbour@maritime.example')).body.data.mfaToken, code: rc })).status).toBe(401);
    expect((await get('/auth/mfa', done.body.data.token)).body.data.recoveryCodesLeft).toBe(7);
    // a role that requires the factor cannot switch it off; the password is asked for again on the way
    expect((await post('/auth/mfa/disable', { password: 'Demo@2026' }, done.body.data.token)).status).toBe(409);
    expect((await post('/auth/mfa/recovery-codes', { password: 'wrong' }, done.body.data.token)).status).toBe(401);
    expect((await post('/auth/mfa/recovery-codes', { password: 'Demo@2026' }, done.body.data.token)).body.data.recoveryCodes).toHaveLength(8);
    // an administrator resets a lost device: the factor is gone and every session with it
    const me = done.body.data.user.id;
    expect((await post(`/users/${me}/mfa/reset`, {}, done.body.data.token)).status).toBe(403);
    expect((await post(`/users/${me}/mfa/reset`, {}, tokens.admin)).status).toBe(201);
    expect((await get('/auth/me', done.body.data.token)).status).toBe(401);
    expect((await login('harbour@maritime.example')).body.data.token).toBeTruthy();
  });

  it('refuses an unenrolled account in a required role once the deadline has passed, lets it in by enrolling, and spares the roles that do not require one', async () => {
    policy.setOverride({ mfaRequiredFrom: '2020-01-01', mfaGraceDays: 0 });
    try {
      const r = await login('finance@maritime.example');
      expect(r.status).toBe(201); expect(r.body.data).toMatchObject({ mfaEnrolmentRequired: true }); expect(r.body.data.token).toBeUndefined();
      const setup = await post('/auth/mfa/setup', { mfaToken: r.body.data.mfaToken }); expect(setup.status).toBe(201);
      // the enrolment token cannot verify, only enrol
      expect((await post('/auth/mfa/verify', { mfaToken: r.body.data.mfaToken, code: totpCode(setup.body.data.secret) })).status).toBe(401);
      const act = await post('/auth/mfa/activate', { mfaToken: r.body.data.mfaToken, code: totpCode(setup.body.data.secret) });
      expect(act.status).toBe(201); expect(act.body.data.token).toBeTruthy(); expect(act.body.data.recoveryCodes).toHaveLength(8);
      // an external tenant's role is exempt
      const ma = await login('crewing@maritime.example'); expect(ma.body.data.token).toBeTruthy(); expect(ma.body.data.mfa.required).toBe(false);
    } finally { policy.setOverride(null); }
    // with a grace window the sign-in proceeds and says when it will stop doing so
    policy.setOverride({ mfaRequiredFrom: '2020-01-01', mfaGraceDays: 30 });
    try {
      const r = await login('nmc@maritime.example');
      expect(r.body.data.token).toBeTruthy(); expect(r.body.data.mfa.enrolled).toBe(false);
      expect(new Date(r.body.data.mfa.dueAt).getTime()).toBeGreaterThan(Date.now() + 29 * 86_400_000);
    } finally { policy.setOverride(null); }
  });

  it('measures a session by its family: lists it, ends it, and does not let it outlive the idle window', async () => {
    const s = await login('surveyor@maritime.example'); const t = s.body.data.token; const sid = s.body.data.sessionId;
    const s2 = await login('surveyor@maritime.example');
    const list = await get('/auth/sessions', t);
    expect(list.body.data.map((x: { id: string }) => x.id)).toEqual(expect.arrayContaining([sid, s2.body.data.sessionId]));
    expect(list.body.data[0].device).toBeTruthy();
    expect((await del(`/auth/sessions/${s2.body.data.sessionId}`, t)).body.data.revoked).toBe(1);
    expect((await srv().post('/auth/refresh').send({ refreshToken: s2.body.data.refreshToken })).status).toBe(401);
    // a refresh keeps the family and stamps its use
    const ref = await srv().post('/auth/refresh').send({ refreshToken: s.body.data.refreshToken }); expect(ref.status).toBe(201); expect(ref.body.data.sessionId).toBe(sid);
    policy.setOverride({ idleTimeoutMinutes: 5 });
    try {
      await pool.query(`UPDATE refresh_tokens SET last_used_at = now() - interval '10 minutes' WHERE family = $1`, [sid]);
      const idle = await srv().post('/auth/refresh').send({ refreshToken: ref.body.data.refreshToken });
      expect(idle.status).toBe(401); expect(idle.body.message).toContain('inactivity');
    } finally { policy.setOverride(null); }
    // an administrator sees and ends another account's sessions
    const s3 = await login('surveyor@maritime.example');
    const adminList = await get(`/users/${s3.body.data.user.id}/sessions`, tokens.admin); expect(adminList.status).toBe(200); expect(adminList.body.data.length).toBeGreaterThan(0);
    expect((await del(`/users/${s3.body.data.user.id}/sessions`, tokens.admin)).body.data.revoked).toBeGreaterThan(0);
    expect((await srv().post('/auth/refresh').send({ refreshToken: s3.body.data.refreshToken })).status).toBe(401);
    // the policy is read with its floors and ceilings
    policy.setOverride({ accessTokenMinutes: 1, idleTimeoutMinutes: 999_999 });
    try { const p = (await login('surveyor@maritime.example')).body.data.policy; expect(p).toMatchObject({ accessTokenMinutes: 5, idleTimeoutMinutes: 1440 }); } finally { policy.setOverride(null); }
  });

  it('holds a privileged grant for a second administrator, who is never the one who asked', async () => {
    const roles = (await get('/roles', tokens.admin)).body.data;
    const ia = roles.find((r: { code: string }) => r.code === 'IA'); const pp = roles.find((r: { name: string }) => r.name === 'Port Pilot');
    const pilots = (await get('/users?role=Port%20Pilot&active=true&limit=50', tokens.admin)).body.data;
    const pilot = pilots[1]; const pilot2 = pilots[2];
    const ask = await put(`/users/${pilot.id}`, { roleId: ia.id, reason: 'Backup administrator' }, tokens.admin);
    expect(ask.status).toBe(200); expect(ask.body.data.pendingChange).toMatchObject({ kind: 'USER_ROLE' }); expect(ask.body.data.role.name).toBe('Port Pilot');
    const reqId = ask.body.data.pendingChange.id;
    expect((await get('/users/changes?status=PENDING', tokens.admin)).body.data.map((c: { id: string }) => c.id)).toContain(reqId);
    expect((await post(`/users/changes/${reqId}/approve`, {}, tokens.admin)).status).toBe(403);
    const iaT = (await login('idadmin@maritime.example')).body.data.token;
    const ok = await post(`/users/changes/${reqId}/approve`, { note: 'Agreed' }, iaT);
    expect(ok.status).toBe(201); expect(ok.body.data).toMatchObject({ status: 'APPROVED', decidedBy: 'Noora Al Ketbi' });
    expect((await get(`/users/${pilot.id}`, tokens.admin)).body.data.role.name).toBe('Identity Administrator');
    expect((await get('/users/changes?status=PENDING', tokens.admin)).body.data.find((c: { id: string }) => c.id === reqId)).toBeUndefined();
    // editing what a privileged role may do is held the same way
    const edit = await put(`/roles/${ia.id}`, { permissions: [...ia.permissions, 'inspections.view'] }, tokens.admin);
    expect(edit.status).toBe(200); expect(edit.body.data.pendingChange).toMatchObject({ kind: 'ROLE_MATRIX' });
    expect((await post(`/users/changes/${edit.body.data.pendingChange.id}/reject`, { note: 'Not needed' }, iaT)).body.data.status).toBe('REJECTED');
    expect((await get('/roles', tokens.admin)).body.data.find((r: { code: string }) => r.code === 'IA').permissions).not.toContain('inspections.view');
    // an ordinary role applies at once
    const now = await put(`/roles/${pp.id}`, { description: 'Pilotage' }, tokens.admin); expect(now.body.data.pendingChange).toBeNull(); expect(now.body.data.description).toBe('Pilotage');
    // a privileged account is created switched off, and switched on by the second administrator
    const created = await post('/users', { name: 'Test Admin', email: 'test.admin@maritime.example', password: 'Khalifa-Quay-91', roleId: ia.id }, tokens.admin);
    expect(created.status).toBe(201); expect(created.body.data.active).toBe(false); expect(created.body.data.pendingChange.kind).toBe('USER_CREATE');
    expect((await login('test.admin@maritime.example', 'Khalifa-Quay-91')).status).toBe(403);
    expect((await post(`/users/changes/${created.body.data.pendingChange.id}/approve`, {}, iaT)).status).toBe(201);
    expect((await login('test.admin@maritime.example', 'Khalifa-Quay-91')).status).toBe(201);
    // the requester may withdraw their own request, and a second request for the same account waits for the first
    const ask2 = await put(`/users/${pilot2.id}`, { roleId: ia.id }, tokens.admin); expect(ask2.body.data.pendingChange.kind).toBe('USER_ROLE');
    expect((await put(`/users/${pilot2.id}`, { roleId: ia.id }, tokens.admin)).status).toBe(409);
    expect((await post(`/users/changes/${ask2.body.data.pendingChange.id}/cancel`, {}, tokens.admin)).body.data.status).toBe('CANCELLED');
    expect((await get(`/users/${pilot2.id}`, tokens.admin)).body.data.role.name).toBe('Port Pilot');
  });

  it('protects an administrator from themselves and the platform from losing its last one, and cleans a scope', async () => {
    const me = (await get('/auth/me', tokens.admin)).body.data;
    const roles = (await get('/roles', tokens.admin)).body.data; const pp = roles.find((r: { name: string }) => r.name === 'Port Pilot');
    expect((await put(`/users/${me.id}`, { roleId: pp.id }, tokens.admin)).status).toBe(403);
    expect((await put(`/users/${me.id}`, { scope: { level: 'PORT', ports: ['AEFJR'] } }, tokens.admin)).status).toBe(403);
    const iaT = (await login('idadmin@maritime.example')).body.data.token;
    expect((await put(`/users/${me.id}`, { active: false }, iaT)).status).toBe(409);
    expect((await put(`/users/${me.id}`, { roleId: pp.id }, iaT)).status).toBe(409);
    expect((await del(`/users/${me.id}`, iaT)).status).toBe(409);
    const pilot = (await get('/users?role=Port%20Pilot&active=true&limit=50', tokens.admin)).body.data[0];
    const r = await put(`/users/${pilot.id}`, { scope: { level: 'FACILITY', facilities: ['CT3-1', 'CT3-1', ' '], ports: ['AEAUH'], companies: ['IGNORED'] } }, tokens.admin);
    expect(r.status).toBe(200); expect(r.body.data.scope).toEqual({ level: 'FACILITY', facilities: ['CT3-1'], ports: ['AEAUH'] });
    expect((await put(`/users/${pilot.id}`, { scope: { level: 'ORBIT' } }, tokens.admin)).status).toBe(400);
    expect((await get('/users?level=FACILITY', tokens.admin)).body.data.map((u: { id: string }) => u.id)).toContain(pilot.id);
    expect((await put(`/users/${pilot.id}`, { scope: { level: 'NATIONAL' } }, tokens.admin)).body.data.scope).toEqual({ level: 'NATIONAL' });
  });

  it('opens an access review over every active account, has it attested by a second person, and closes it', async () => {
    const iaT = (await login('idadmin@maritime.example')).body.data.token;
    const opened = await post('/access-reviews', {}, tokens.admin);
    expect(opened.status).toBe(201); expect(opened.body.data.created).toBe(true); expect(opened.body.data.total).toBeGreaterThan(100); expect(opened.body.data.status).toBe('OPEN');
    expect((await post('/access-reviews', {}, tokens.admin)).body.data.created).toBe(false);
    const id = opened.body.data.id;
    const detail = await get(`/access-reviews/${id}?decision=PENDING`, iaT);
    expect(detail.body.data.items).toHaveLength(opened.body.data.total);
    const item = (email: string) => detail.body.data.items.find((i: { userEmail: string }) => i.userEmail === email);
    expect(item('admin@maritime.example')).toMatchObject({ privileged: true, dormant: false });
    // nobody attests their own account
    expect((await post(`/access-reviews/${id}/items/${item('idadmin@maritime.example').id}`, { decision: 'CONFIRMED' }, iaT)).status).toBe(403);
    expect((await post(`/access-reviews/${id}/items/${item('idadmin@maritime.example').id}`, { decision: 'CONFIRMED' }, tokens.admin)).status).toBe(201);
    // revoking switches the account off there and then
    const rev = await post(`/access-reviews/${id}/items/${item('test.pilot@maritime.example').id}`, { decision: 'REVOKED', note: 'Left the service' }, iaT);
    expect(rev.status).toBe(201); expect(rev.body.data.decision).toBe('REVOKED');
    expect((await get(`/users/${item('test.pilot@maritime.example').userId}`, tokens.admin)).body.data).toMatchObject({ active: false, deactivatedReason: 'ACCESS_REVIEW' });
    expect((await post(`/access-reviews/${id}/items/${item('admin@maritime.example').id}`, { decision: 'REVOKED' }, iaT)).status).toBe(409);
    expect((await post(`/access-reviews/${id}/close`, {}, tokens.admin)).status).toBe(409);
    for (const it of detail.body.data.items) {
      if (['idadmin@maritime.example', 'test.pilot@maritime.example'].includes(it.userEmail)) continue;
      const t = it.userEmail === 'idadmin@maritime.example' ? tokens.admin : iaT;
      expect((await post(`/access-reviews/${id}/items/${it.id}`, { decision: 'CONFIRMED' }, t)).status).toBe(201);
    }
    const closed = await post(`/access-reviews/${id}/close`, { note: 'Quarterly review' }, tokens.admin);
    expect(closed.status).toBe(201); expect(closed.body.data).toMatchObject({ status: 'CLOSED', revoked: 1, pending: 0 });
    expect((await get('/access-reviews', iaT)).body.data[0]).toMatchObject({ id, status: 'CLOSED' });
  });

  it('flags, then deactivates, dormant accounts on the scheduler\'s sweep — never the last administrator — and opens the review from the schedule once', async () => {
    await pool.query(`UPDATE users SET last_login_at = now() - interval '400 days' WHERE email IN ('ops2@maritime.example', 'nmc@maritime.example', 'admin@maritime.example')`);
    const ops2 = (await get('/users?q=ops2', tokens.admin)).body.data[0];
    const sweep = async () => { const c = await pool.connect(); try { await applyEvent(c, deps(), makeEvent({ type: EVENTS.scheduler.sweepDormant, source: 'scheduler', subject: 'dormant-account-sweep', data: { jobKey: 'dormant-account-sweep' } })); } finally { c.release(); } };
    policy.setOverride({ dormantAction: 'FLAG', dormantAfterDays: 90 });
    try { await sweep(); } finally { policy.setOverride(null); }
    expect((await get(`/users/${ops2.id}`, tokens.admin)).body.data).toMatchObject({ active: true }); expect((await get(`/users/${ops2.id}`, tokens.admin)).body.data.dormantSince).toBeTruthy();
    expect((await get('/users?dormant=true', tokens.admin)).body.data.map((u: { email: string }) => u.email)).toEqual(expect.arrayContaining(['ops2@maritime.example', 'nmc@maritime.example']));
    policy.setOverride({ dormantAction: 'DEACTIVATE', dormantAfterDays: 90 });
    try { await sweep(); } finally { policy.setOverride(null); }
    expect((await get(`/users/${ops2.id}`, tokens.admin)).body.data).toMatchObject({ active: false, deactivatedReason: 'DORMANT' });
    expect((await get('/auth/me', tokens.admin)).status).toBe(200);
    expect((await login('admin@maritime.example')).status).toBe(201);
    // an administrator can run the sweep by hand, and bring an ordinary account back without a second approver
    expect((await post('/access-reviews/dormant-sweep', {}, tokens.admin)).status).toBe(201);
    const back = await put(`/users/${ops2.id}`, { active: true }, tokens.admin); expect(back.body.data).toMatchObject({ active: true, deactivatedReason: '' }); expect(back.body.data.dormantSince).toBeNull();
    await pool.query(`UPDATE users SET last_login_at = now(), active = true, deactivated_reason = '', dormant_since = NULL WHERE email IN ('ops2@maritime.example', 'nmc@maritime.example', 'admin@maritime.example')`);
    // the schedule opens the quarterly cycle through the inbox: the same event twice opens one cycle
    const ev = makeEvent({ type: EVENTS.scheduler.openAccessReview, source: 'scheduler', subject: 'access-review-open', data: { jobKey: 'access-review-open' } });
    expect(await withInbox(pool, ev, (c) => applyEvent(c, deps(), ev))).toBe(true);
    expect(await withInbox(pool, ev, (c) => applyEvent(c, deps(), ev))).toBe(false);
    const cycles = (await get('/access-reviews', tokens.admin)).body.data;
    expect(cycles.filter((c: { status: string }) => c.status !== 'CLOSED')).toHaveLength(1);
    expect(cycles[0].openedBy).toBe('Access review schedule');
  });
});
