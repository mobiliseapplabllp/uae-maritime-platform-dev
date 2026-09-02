import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createApp, loadEnv, signHS256, StaticPrincipalResolver, PRINCIPAL_RESOLVER, KIT_BUS, MemoryBus } from '@maritime/service-kit';
import { makeEvent, EVENTS, subjectFor } from '@maritime/contracts';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedNotifications } from '../src/seed';

const DB = 'maritime_notifications_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let bus: MemoryBus;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' }); await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedNotifications(URL, 'AE');
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET } as never);
  const resolver = new StaticPrincipalResolver({
    ops: { id: 'ops', sub: 'ops', name: 'Ops', email: 'ops@x', perms: ['portcalls.view', 'dashboard.view'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
    fin: { id: 'fin', sub: 'fin', name: 'Fin', email: 'fin@x', perms: ['invoices.view', 'dashboard.view', 'roles.view'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) }); await app.init(); server = app.getHttpServer(); bus = app.get(KIT_BUS);
});
afterAll(async () => { await app?.close(); });

describe('notifications', () => {
  it('fans out by permission audience and tracks read state per user', async () => {
    const ops = await request(server as never).get('/notifications').set('authorization', tok('ops'));
    expect(ops.body.data.items.length).toBeGreaterThan(10); expect(ops.body.data.unread).toBe(ops.body.data.items.length);
    const fin = await request(server as never).get('/notifications').set('authorization', tok('fin'));
    expect(fin.body.data.items.every((n: { audiencePerm: string }) => n.audiencePerm !== 'portcalls.view')).toBe(true);
    const first = ops.body.data.items[0].id;
    await request(server as never).post(`/notifications/${first}/read`).set('authorization', tok('ops'));
    const again = await request(server as never).get('/notifications').set('authorization', tok('ops'));
    expect(again.body.data.items.find((n: { id: string }) => n.id === first).read).toBe(true); expect(again.body.data.unread).toBe(ops.body.data.unread - 1);
    const all = await request(server as never).post('/notifications/read-all').set('authorization', tok('ops')); expect(all.body.data.marked).toBeGreaterThan(0);
    expect((await request(server as never).get('/notifications').set('authorization', tok('ops'))).body.data.unread).toBe(0);
  });
  it('creates notifications from domain events and through the internal endpoint', async () => {
    await bus.publish(subjectFor(EVENTS.identity.roleChanged), makeEvent({ type: EVENTS.identity.roleChanged, source: 'identity-access', data: { roleId: 'r1', name: 'Port Pilot' } })); await bus.drain();
    const fin = await request(server as never).get('/notifications').set('authorization', tok('fin'));
    expect(fin.body.data.items.some((n: { title: string }) => n.title === 'Role updated: Port Pilot')).toBe(true);
    const created = await request(server as never).post('/notifications/internal').set('x-service-token', 'development-service-token').send({ title: 'Direct', userId: 'fin', severity: 'warning' });
    expect(created.status).toBe(201);
    expect((await request(server as never).get('/notifications').set('authorization', tok('ops'))).body.data.items.some((n: { title: string }) => n.title === 'Direct')).toBe(false);
    expect((await request(server as never).get('/notifications').set('authorization', tok('fin'))).body.data.items.some((n: { title: string }) => n.title === 'Direct')).toBe(true);
    expect((await request(server as never).post('/notifications/internal').send({ title: 'x' })).status).toBe(401);
  });
});
