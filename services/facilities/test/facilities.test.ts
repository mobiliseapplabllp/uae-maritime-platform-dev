import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { EVENTS, makeEvent, subjectFor } from '@maritime/contracts';
import { AuditClient, PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256, withInbox, withTx, type Principal } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedFacilities } from '../src/seed';
import { applyEvent } from '../src/consumer';
import { canChangeStatus, cycleStateOn, directoryDashboard, ratingBreakdown, ratingFrom, scoreToRating } from '../src/directory';
import { accreditationDashboard, nextVisitDue, parseDays } from '../src/accreditation';

const DB = 'maritime_facilities_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let audit: AuditClient; let env: ReturnType<typeof loadEnv<typeof envSchema>>;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const clerk = tok('clerk'); const registrar = tok('registrar'); const viewer = tok('viewer'); const nobody = tok('nobody');
/* An operator on the directory rather than an officer reading it: Gulf Star maintains their own entry. */
const agentGss = tok('agent-gss');
const g = (p: string, t = admin) => request(server as never).get(p).set('authorization', t);
const post = (p: string, body?: unknown, t = admin) => request(server as never).post(p).set('authorization', t).send((body ?? {}) as never);
const put = (p: string, body: unknown, t = admin) => request(server as never).put(p).set('authorization', t).send(body as never);
const del = (p: string, t = admin) => request(server as never).delete(p).set('authorization', t);
const outbox = async (type: string) => (await pool.query('SELECT payload FROM outbox WHERE subject = $1 ORDER BY id', [subjectFor(type)])).rows.map((r) => r.payload as { type: string; subject?: string; data: Record<string, any> });
const clearOutbox = () => pool.query('DELETE FROM outbox');
const D = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();
const C = '/facilities/companies'; const F = '/facilities/port-facilities';

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedFacilities(URL, 'AE');
  pool = new Pool({ connectionString: URL });
  env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, MDM_URL: 'http://127.0.0.1:1' } as never);
  const base = { scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const people: Record<string, Principal> = {
    admin: { ...base, id: 'admin', sub: 'admin', name: 'Admin', perms: ['*'] },
    clerk: { ...base, id: 'clerk', sub: 'clerk', name: 'Licensing Clerk', perms: ['facilities.view', 'facilities.manage'] },
    registrar: { ...base, id: 'registrar', sub: 'registrar', name: 'Registrar', perms: ['facilities.view', 'facilities.approve'] },
    viewer: { ...base, id: 'viewer', sub: 'viewer', name: 'Compliance Analyst', perms: ['facilities.view'] },
    nobody: { ...base, id: 'nobody', sub: 'nobody', name: 'Nobody', perms: ['reports.view'] },
    'agent-gss': { ...base, id: 'agent-gss', sub: 'agent-gss', name: 'Gulf Star Shipping', kind: 'agent' as const, perms: ['facilities.view'], scope: { level: 'COMPANY', companies: ['GSS'] } },
  };
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: new StaticPrincipalResolver(people) }) });
  await app.init(); server = app.getHttpServer(); audit = app.get(AuditClient);
});
afterAll(async () => { await pool?.end(); await app?.close(); });

let seq = 0;
async function newCompany(over: Record<string, unknown> = {}, t = clerk) {
  seq += 1;
  const r = await post(C, { code: `TST${seq}`, name: `Test Marine Services ${seq}`, category: 'SERVICE_PROVIDER', types: ['SHIP_CHANDLER'], contactName: 'A Contact', address: 'Free Zone, Test City', city: 'Test City', ...over }, t);
  expect(r.status).toBe(201);
  return r.body.data;
}
async function newFacility(over: Record<string, unknown> = {}, t = clerk) {
  seq += 1;
  const r = await post(F, { name: `Test Jetty ${seq}`, facilityType: 'JETTY', terminal: 'Test Terminal', ...over }, t);
  expect(r.status).toBe(201);
  return r.body.data;
}

describe('facilities — the rules, tested without a database', () => {
  it('earns a rating from the audit history, weighted towards what was found recently', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    expect(ratingFrom([], now)).toBeNull();
    expect(ratingFrom([{ date: '2026-05-01', result: 'SATISFACTORY' }], now)).toBe(5);
    expect(ratingFrom([{ date: '2026-05-01', result: 'NON_CONFORMITY' }], now)).toBe(2);
    const recentBad = ratingFrom([{ date: '2026-05-01', result: 'NON_CONFORMITY' }, { date: '2020-05-01', result: 'SATISFACTORY' }], now);
    const recentGood = ratingFrom([{ date: '2026-05-01', result: 'SATISFACTORY' }, { date: '2020-05-01', result: 'NON_CONFORMITY' }], now);
    expect(recentBad!).toBeLessThan(3.5);
    expect(recentGood!).toBeGreaterThan(3.5);
    expect(ratingFrom(Array.from({ length: 20 }, () => ({ date: '2026-05-01', result: 'OBSERVATIONS' })), now)).toBe(3.5);
  });
  it('moves standing one step at a time and never without a reason', () => {
    expect(canChangeStatus('ACTIVE', 'SUSPENDED', 'Audit non-conformity')).toEqual({ ok: true });
    expect(canChangeStatus('ACTIVE', 'SUSPENDED', '  ')).toMatchObject({ ok: false, error: expect.stringContaining('reason') });
    expect(canChangeStatus('ACTIVE', 'ACTIVE', 'x')).toMatchObject({ ok: false, error: expect.stringContaining('already') });
    expect(canChangeStatus('BLACKLISTED', 'SUSPENDED', 'x')).toMatchObject({ ok: false, error: expect.stringContaining('cannot become') });
    expect(canChangeStatus('SUSPENDED', 'ACTIVE', '')).toEqual({ ok: true });
    expect(canChangeStatus('NOWHERE', 'ACTIVE', 'x').ok).toBe(false);
  });
  it('summarises the directory, the estate and the work coming up', () => {
    const now = new Date('2026-06-15T00:00:00Z');
    const d = directoryDashboard({
      companies: [
        { status: 'ACTIVE', category: 'AGENCY', rating: 4, openObligations: 0 },
        { status: 'ACTIVE', category: 'AGENCY', rating: 5, openObligations: 2 },
        { status: 'SUSPENDED', category: 'SUPPLIER', rating: 2, openObligations: 1 },
        { status: 'BLACKLISTED', category: 'SUPPLIER', rating: 0, openObligations: 0 },
      ],
      facilities: [{ ispsStatus: 'COMPLIANT', status: 'OPERATIONAL', facilityType: 'BERTH' }, { ispsStatus: 'EXPIRED', status: 'OPERATIONAL', facilityType: 'SPM' }],
      instruments: [
        { status: 'ISSUED', expiryDate: iso(now.getTime() + 30 * D), subjectKind: 'COMPANY' },
        { status: 'ISSUED', expiryDate: iso(now.getTime() - 5 * D), subjectKind: 'COMPANY' },
        { status: 'REVOKED', expiryDate: null, subjectKind: 'COMPANY' },
      ],
      audits: [{ date: iso(now.getTime() - 30 * D), result: 'NON_CONFORMITY' }, { date: iso(now.getTime() - 800 * D), result: 'SATISFACTORY' }],
    }, now, 90);
    expect(d.kpis).toMatchObject({ companies: 4, active: 2, suspended: 1, blacklisted: 1, averageRating: 3.7, facilities: 2, ispsCompliant: 1, instrumentsHeld: 2, dueForRenewal: 1, expired: 1, auditsLastYear: 1, nonConformities: 1, openObligations: 3 });
    expect(d.byCategory[0]).toMatchObject({ category: 'AGENCY', total: 2, active: 2 });
    expect(d.byIsps.map((x) => x.ispsStatus).sort()).toEqual(['COMPLIANT', 'EXPIRED']);
    expect(d.auditResults.find((r) => r.result === 'NON_CONFORMITY')).toMatchObject({ total: 1 });
  });
});

describe('facilities — the company directory', () => {
  it('pages, filters, searches and sorts the directory', async () => {
    const first = await g(`${C}?limit=5`);
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(5);
    expect(first.body.meta.total).toBeGreaterThan(10);
    const p2 = await g(`${C}?limit=5&page=2`);
    expect(p2.body.data[0].id).not.toBe(first.body.data[0].id);
    const agencies = await g(`${C}?category=AGENCY&limit=100`);
    expect(agencies.body.data.every((r: any) => r.category === 'AGENCY')).toBe(true);
    const active = await g(`${C}?status=ACTIVE&limit=100`);
    expect(active.body.data.every((r: any) => r.status === 'ACTIVE')).toBe(true);
    const byType = await g(`${C}?type=SHIPPING_AGENCY&limit=100`);
    expect(byType.body.data.length).toBeGreaterThan(0);
    expect(byType.body.data.every((r: any) => r.types.includes('SHIPPING_AGENCY'))).toBe(true);
    const rated = await g(`${C}?rating=4&limit=100`);
    expect(rated.body.data.every((r: any) => r.rating >= 4)).toBe(true);
    const sorted = await g(`${C}?sort=code&limit=5`);
    expect(sorted.body.data.map((r: any) => r.code)).toEqual([...sorted.body.data.map((r: any) => r.code)].sort());
    const one = first.body.data[0];
    expect((await g(`${C}?q=${encodeURIComponent(one.name.slice(0, 6))}`)).body.data.map((r: any) => r.id)).toContain(one.id);
    expect((await g(`${C}?q=${encodeURIComponent(one.taxId)}`)).body.data.map((r: any) => r.id)).toContain(one.id);
  });
  it('returns the full record: contacts, what it holds, how it has audited and what it owes', async () => {
    const held = (await pool.query(`SELECT subject_id FROM instruments WHERE subject_kind = 'COMPANY' AND subject_id IS NOT NULL GROUP BY 1 ORDER BY count(*) DESC LIMIT 1`)).rows[0];
    const r = await g(`${C}/${held.subject_id}`);
    expect(r.status).toBe(200);
    const c = r.body.data;
    expect(c.instrumentsHeld).toBeGreaterThan(0);
    expect(c.instruments[0]).toMatchObject({ subjectKind: expect.any(String), licenseNo: expect.any(String), typeLabel: expect.any(String) });
    expect(c.instruments[0]).toHaveProperty('daysToExpiry');
    expect(c.auditCount).toBeGreaterThan(0);
    expect(c.history.length).toBeGreaterThan(0);
    expect(c.contactName).toBeTruthy();
    expect(typeof c.rating).toBe('number');
    const byCode = await g(`${C}/${c.code}`);
    expect(byCode.body.data.id).toBe(c.id);
    expect((await g(`${C}/not-a-company`)).status).toBe(404);
    const only = await g(`${C}/${c.id}/instruments`);
    expect(only.body.data.length).toBe(c.instrumentsHeld);
  });
  it('creates, edits and retires a company, and never lets standing move by editing', async () => {
    await clearOutbox();
    const created = await newCompany();
    expect(created).toMatchObject({ status: 'ACTIVE', category: 'SERVICE_PROVIDER' });
    expect(created.code).toMatch(/^TST\d+$/);
    const rm = (await outbox(EVENTS.readModel.upserted)).at(-1)!;
    expect(rm.data.kind).toBe('company');
    /* `scope` rides along so reporting can partition its projection the way this register partitions the row,
     * and `nameAr` so the search index has Arabic to analyse — a bilingual register whose read model is
     * English-only can only ever be searched in English. The set is asserted whole on purpose: a read-model
     * payload that grows without anyone noticing is how a field nobody meant to publish gets published. */
    expect(Object.keys(rm.data.entity).sort()).toEqual(['address', 'category', 'code', 'id', 'name', 'nameAr', 'scope', 'status', 'taxId']);
    expect(rm.data.entity.scope).toEqual({ company: created.code });
    expect((await outbox(EVENTS.facilities.companyRegistered)).at(-1)?.data).toMatchObject({ code: created.code, name: created.name });
    expect((await post(C, { code: created.code, name: 'A clashing company', category: 'AGENCY' }, clerk)).status).toBe(409);
    const edited = await put(`${C}/${created.id}`, { name: 'Test Marine Services (renamed)', contactPhone: '+971 4 555 0100', types: ['SHIP_CHANDLER', 'BUNKER_SUPPLIER'] }, clerk);
    expect(edited.body.data).toMatchObject({ name: 'Test Marine Services (renamed)', contactPhone: '+971 4 555 0100' });
    expect(edited.body.data.types).toEqual(['SHIP_CHANDLER', 'BUNKER_SUPPLIER']);
    const forced = await put(`${C}/${created.id}`, { status: 'SUSPENDED' }, clerk);
    expect(forced.status).toBe(409);
    expect(forced.body.message).toMatch(/status endpoint/i);
    const removed = await del(`${C}/${created.id}`, clerk);
    expect(removed.body.data).toMatchObject({ deleted: true, softDelete: false });
    expect((await g(`${C}/${created.id}`)).status).toBe(404);
    expect((await outbox(EVENTS.readModel.deleted)).at(-1)?.data).toMatchObject({ kind: 'company', id: created.id });
  });
  it('retires rather than deletes a company with a history behind it', async () => {
    const c = await newCompany();
    await post(`${C}/${c.id}/audits`, { result: 'SATISFACTORY', auditor: 'A Surveyor', remarks: 'Annual audit' }, clerk);
    const removed = await del(`${C}/${c.id}`, clerk);
    expect(removed.body.data).toMatchObject({ deleted: true, softDelete: true, status: 'INACTIVE' });
    expect((await g(`${C}/${c.id}`)).body.data.status).toBe('INACTIVE');
    expect((await del(`${C}/${c.id}`, clerk)).status).toBe(409);
  });
});

describe('facilities — standing, and the reasons it changed', () => {
  it('suspends, blacklists and restores a company, always on a recorded reason', async () => {
    const c = await newCompany();
    const noReason = await post(`${C}/${c.id}/status`, { status: 'SUSPENDED' }, registrar);
    expect(noReason.status).toBe(400);
    expect(noReason.body.message).toMatch(/reason/i);
    await clearOutbox();
    const suspended = await post(`${C}/${c.id}/status`, { status: 'SUSPENDED', reason: 'Bunker meters found uncalibrated at audit' }, registrar);
    expect(suspended.status).toBe(201);
    expect(suspended.body.data).toMatchObject({ status: 'SUSPENDED', statusReason: 'Bunker meters found uncalibrated at audit', statusChangedBy: 'Registrar' });
    expect((await outbox(EVENTS.facilities.companySuspended)).at(-1)?.data).toMatchObject({ companyId: c.id, from: 'ACTIVE', to: 'SUSPENDED' });
    expect((await outbox(EVENTS.facilities.companyStatusChanged)).at(-1)?.data.reason).toMatch(/uncalibrated/);
    expect((await outbox(EVENTS.readModel.upserted)).at(-1)?.data.entity.status).toBe('SUSPENDED');
    expect((await post(`${C}/${c.id}/status`, { status: 'SUSPENDED', reason: 'Again' }, registrar)).status).toBe(409);
    const blacklisted = await post(`${C}/${c.id}/status`, { status: 'BLACKLISTED', reason: 'Suspension not answered within the period allowed' }, registrar);
    expect(blacklisted.body.data.status).toBe('BLACKLISTED');
    expect((await outbox(EVENTS.facilities.companyBlacklisted)).at(-1)?.data.to).toBe('BLACKLISTED');
    const back = await post(`${C}/${c.id}/status`, { status: 'SUSPENDED', reason: 'Downgrade the blacklisting' }, registrar);
    expect(back.status).toBe(409);
    const restored = await post(`${C}/${c.id}/status`, { status: 'ACTIVE', reason: 'Remediation evidenced and verified' }, registrar);
    expect(restored.body.data.status).toBe('ACTIVE');
    const full = await g(`${C}/${c.id}`);
    expect(full.body.data.history.map((h: any) => h.to)).toEqual(['ACTIVE', 'BLACKLISTED', 'SUSPENDED', 'ACTIVE']);
    expect(full.body.data.history[0].reason).toMatch(/Remediation/);
  });
});

describe('facilities — compliance', () => {
  it('moves the rating when an audit is recorded, and raises an obligation on a non-conformity', async () => {
    const c = await newCompany({ rating: 5 });
    await clearOutbox();
    const good = await post(`${C}/${c.id}/audits`, { date: iso(Date.now() - 20 * D), result: 'SATISFACTORY', auditor: 'A Surveyor', scope: 'Annual', remarks: 'No findings' }, clerk);
    expect(good.status).toBe(201);
    expect(good.body.data.audit.number).toMatch(/^AUD-\d{4}-\d{4}$/);
    expect(good.body.data.rating).toBe(5);
    expect(good.body.data.obligation).toBeNull();
    expect((await outbox(EVENTS.facilities.companyAudited)).at(-1)?.data).toMatchObject({ result: 'SATISFACTORY', rating: 5 });
    const bad = await post(`${C}/${c.id}/audits`, { result: 'NON_CONFORMITY', auditor: 'A Surveyor', remarks: 'Deliveries made with uncalibrated meters' }, clerk);
    expect(bad.body.data.rating).toBeLessThan(good.body.data.rating);
    expect(bad.body.data.previousRating).toBe(5);
    expect(bad.body.data.obligation).toMatchObject({ kind: 'AUDIT_FINDING', status: 'OPEN' });
    expect(bad.body.data.obligation.title).toContain(bad.body.data.audit.number);
    expect((await outbox(EVENTS.facilities.obligationRaised)).at(-1)?.data.subjectId).toBe(c.id);
    const after = await g(`${C}/${c.id}`);
    expect(after.body.data.nonConformities).toBe(1);
    expect(after.body.data.openObligations).toBe(1);
    expect(after.body.data.lastAuditResult).toBe('NON_CONFORMITY');
    const audits = await g(`${C}/${c.id}/audits`);
    expect(audits.body.data.audits).toHaveLength(2);
    expect(audits.body.data.computed).toBe(after.body.data.rating);
  });
  it('clears an obligation once, and refuses one that is not the subject\'s', async () => {
    const c = await newCompany();
    const raised = await post(`${C}/${c.id}/obligations`, { kind: 'DOCUMENT', title: 'Produce the calibration certificates', detail: 'For every meter in service', dueAt: iso(Date.now() + 10 * D) }, clerk);
    expect(raised.status).toBe(201);
    expect(raised.body.data).toMatchObject({ kind: 'DOCUMENT', status: 'OPEN' });
    const list = await g(`${C}/${c.id}/obligations`);
    expect(list.body.data.open).toBe(1);
    await clearOutbox();
    const cleared = await post(`${C}/${c.id}/obligations/${raised.body.data.id}/clear`, { note: 'Certificates produced and filed' }, clerk);
    expect(cleared.body.data).toMatchObject({ status: 'CLEARED', clearanceNote: 'Certificates produced and filed' });
    expect((await outbox(EVENTS.facilities.obligationCleared)).at(-1)?.data.obligationId).toBe(raised.body.data.id);
    expect((await post(`${C}/${c.id}/obligations/${raised.body.data.id}/clear`, {}, clerk)).status).toBe(400);
    const other = await newCompany();
    expect((await post(`${C}/${other.id}/obligations/${raised.body.data.id}/clear`, {}, clerk)).status).toBe(404);
  });
  it('builds the renewal work list from the instrument snapshot, worst first', async () => {
    const r = await g('/facilities/renewals?window=3650');
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBeGreaterThan(0);
    expect(r.body.meta).toMatchObject({ windowDays: 3650 });
    const days = r.body.data.map((x: any) => x.daysToExpiry);
    expect(days).toEqual([...days].sort((a: number, b: number) => a - b));
    expect(r.body.data.every((x: any) => x.licenseNo && x.subjectKind)).toBe(true);
    const overdue = await g('/facilities/renewals?window=3650&overdue=true');
    expect(overdue.body.data.every((x: any) => x.overdue)).toBe(true);
    const narrow = await g('/facilities/renewals?window=1');
    expect(narrow.body.data.length).toBeLessThanOrEqual(r.body.data.length);
  });
  it('serves the cross-subject audit and obligation registers', async () => {
    const audits = await g('/facilities/audits?limit=5');
    expect(audits.body.meta.total).toBeGreaterThan(5);
    expect(audits.body.data).toHaveLength(5);
    const nc = await g('/facilities/audits?result=NON_CONFORMITY&limit=100');
    expect(nc.body.data.every((a: any) => a.result === 'NON_CONFORMITY')).toBe(true);
    const obligations = await g('/facilities/obligations?status=OPEN&limit=100');
    expect(obligations.body.data.every((o: any) => o.status === 'OPEN')).toBe(true);
    expect(obligations.body.meta.total).toBeGreaterThan(0);
    const byKind = await g('/facilities/obligations?kind=AUDIT_FINDING&limit=100');
    expect(byKind.body.data.every((o: any) => o.kind === 'AUDIT_FINDING')).toBe(true);
  });
});

describe('facilities — the port-facility register', () => {
  it('lists the estate with its operators and ISPS standing', async () => {
    const r = await g(`${F}?limit=100`);
    expect(r.status).toBe(200);
    expect(r.body.meta.total).toBeGreaterThan(10);
    expect(r.body.data.every((f: any) => f.code)).toBe(true);
    const compliant = await g(`${F}?ispsStatus=COMPLIANT&limit=100`);
    expect(compliant.body.data.length).toBeGreaterThan(0);
    expect(compliant.body.data.every((f: any) => f.ispsStatus === 'COMPLIANT' && f.socNo)).toBe(true);
    const operated = r.body.data.find((f: any) => f.operatorId);
    const byOperator = await g(`${F}?operator=${operated.operatorId}&limit=100`);
    expect(byOperator.body.data.every((f: any) => f.operatorId === operated.operatorId)).toBe(true);
    const searched = await g(`${F}?q=${encodeURIComponent(operated.terminal.slice(0, 6))}&limit=100`);
    expect(searched.body.data.length).toBeGreaterThan(0);
  });
  it('returns a facility with its capability, capacity, operator and audit history', async () => {
    const withSoc = (await pool.query(`SELECT id FROM port_facilities WHERE isps_status = 'COMPLIANT' LIMIT 1`)).rows[0];
    const r = await g(`${F}/${withSoc.id}`);
    expect(r.status).toBe(200);
    const f = r.body.data;
    expect(f.ispsInForce).toBe(true);
    expect(f.capabilities.length).toBeGreaterThan(0);
    expect(f.capacity).toBeGreaterThan(0);
    expect(f.loaMax).toBeGreaterThan(0);
    expect(f.operatorName).toBeTruthy();
    expect(f.instrumentsHeld).toBeGreaterThan(0);
    expect((await g(`${F}/${f.code}`)).body.data.id).toBe(f.id);
  });
  it('registers a facility against an operator, moves its ISPS standing and audits it', async () => {
    const operator = (await pool.query(`SELECT id, name FROM companies WHERE category = 'TERMINAL_OPERATOR' LIMIT 1`)).rows[0];
    await clearOutbox();
    const f = await newFacility({ operatorId: operator.id, capabilities: ['BREAK_BULK'], loaMax: 180, draftMax: 9.5, capacity: 400000, capacityUnit: 'MT/yr' });
    expect(f).toMatchObject({ operatorId: operator.id, operatorName: operator.name, ispsStatus: 'NOT_APPLICABLE' });
    expect(f.code).toMatch(/^PF-\d{4}$/);
    expect((await outbox(EVENTS.facilities.facilityRegistered)).at(-1)?.data.facilityId).toBe(f.id);
    expect((await post(F, { name: 'Clashing jetty', code: f.code }, clerk)).status).toBe(409);
    expect((await post(F, { name: 'Orphan jetty', operatorId: 'not-a-company' }, clerk)).status).toBe(404);
    const isps = await post(`${F}/${f.id}/isps`, { ispsStatus: 'PROVISIONAL', ispsLevel: 2, socNo: 'SOC-TEST-1', socExpiry: iso(Date.now() + 180 * D), reason: 'Interim statement issued' }, clerk);
    expect(isps.body.data).toMatchObject({ ispsStatus: 'PROVISIONAL', ispsLevel: 2, socNo: 'SOC-TEST-1', ispsInForce: false });
    expect((await outbox(EVENTS.facilities.facilityIspsChanged)).at(-1)?.data).toMatchObject({ from: 'NOT_APPLICABLE', to: 'PROVISIONAL' });
    const compliant = await post(`${F}/${f.id}/isps`, { ispsStatus: 'COMPLIANT', socNo: 'SOC-TEST-2', socExpiry: iso(Date.now() + 900 * D) }, clerk);
    expect(compliant.body.data.ispsInForce).toBe(true);
    const audited = await post(`${F}/${f.id}/audits`, { result: 'OBSERVATIONS', auditor: 'A Surveyor', scope: 'Security plan verification', remarks: 'Two observations raised' }, clerk);
    expect(audited.body.data.audit).toMatchObject({ subjectKind: 'FACILITY', result: 'OBSERVATIONS' });
    expect(audited.body.data.facility.auditCount).toBe(1);
    expect((await outbox(EVENTS.facilities.facilityAudited)).at(-1)?.data.result).toBe('OBSERVATIONS');
    const closed = await del(`${F}/${f.id}`, clerk);
    expect(closed.body.data).toMatchObject({ deleted: true, softDelete: true, status: 'CLOSED' });
    const spare = await newFacility();
    expect((await del(`${F}/${spare.id}`, clerk)).body.data).toMatchObject({ deleted: true, softDelete: false });
  });
  it('shows a company the facilities it operates', async () => {
    const operator = (await pool.query(`SELECT operator_id FROM port_facilities WHERE operator_id IS NOT NULL LIMIT 1`)).rows[0];
    const r = await g(`${C}/${operator.operator_id}`);
    expect(r.body.data.facilities.length).toBeGreaterThan(0);
    expect(r.body.data.facilities[0]).toHaveProperty('ispsStatus');
  });
});

describe('facilities — the dashboard and the vocabularies', () => {
  it('serves the directory dashboard', async () => {
    const r = await g('/facilities/dashboard');
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.kpis.companies).toBeGreaterThan(10);
    expect(d.kpis.active + d.kpis.suspended + d.kpis.blacklisted + d.kpis.inactive).toBe(d.kpis.companies);
    expect(d.kpis.facilities).toBeGreaterThan(10);
    expect(d.kpis.instrumentsHeld).toBeGreaterThan(0);
    expect(d.byCategory.length).toBeGreaterThan(2);
    expect(d.byStatus.map((s: any) => s.status)).toEqual(['ACTIVE', 'SUSPENDED', 'BLACKLISTED', 'INACTIVE']);
    expect(d.byIsps.length).toBeGreaterThan(0);
    expect(d.watchlist.length).toBeGreaterThan(0);
    expect(Array.isArray(d.renewals)).toBe(true);
  });
  it('serves the vocabularies and the standing transitions it enforces', async () => {
    const r = await g('/facilities/meta');
    expect(r.body.data.categories).toContain('TERMINAL_OPERATOR');
    // the vocabularies come from this service's mirror of the Data Studio masters, labelled in both languages
    expect(r.body.data.categoryOptions.find((o: any) => o.code === 'AGENCY')).toMatchObject({ label: 'Shipping agency', labelAr: 'وكالة ملاحية' });
    expect(r.body.data.facilityTypes).toContain('MARINA'); expect(r.body.data.visitTypes.map((o: any) => o.code)).toContain('SPOT_CHECK');
    expect(r.body.data.accreditationCategories).toHaveLength(7); expect(r.body.data.accreditationCategories[0].meta).toMatchObject({ cycleMonths: 12 });
    expect(r.body.data.statusTransitions.BLACKLISTED).toEqual(['ACTIVE', 'INACTIVE']);
    expect(r.body.data.ispsStatuses).toContain('COMPLIANT');
    expect(r.body.data.licensedTypes.some((t: any) => t.type === 'SHIPPING_AGENCY')).toBe(true);
    expect(r.body.data.terminals.length).toBeGreaterThan(0);
    expect(r.body.data.renewalWindowDays).toBe(90);
  });
});

describe('facilities — what it consumes from the rest of the platform', () => {
  const deps = () => ({ env, audit });
  const instrumentEvent = (over: Record<string, unknown>) => makeEvent({
    type: EVENTS.readModel.upserted, source: 'instruments',
    data: { kind: 'instrument', entity: { id: 'inst-consumer-1', number: 'SA-2026-0099', subjectKind: 'COMPANY', entityType: 'SHIPPING_AGENCY', typeLabel: 'Shipping Agency Licence', instrumentClass: 'LICENCE', status: 'ISSUED', issueDate: iso(Date.now() - 10 * D), expiryDate: iso(Date.now() + 300 * D), inForce: true, ...over } },
  });
  it('snapshots an instrument and announces the licence as issued against a company on the register', async () => {
    const company = (await pool.query(`SELECT id, name FROM companies WHERE status = 'ACTIVE' ORDER BY code LIMIT 1`)).rows[0];
    await clearOutbox();
    const event = instrumentEvent({ subjectId: company.id, entityName: company.name });
    await withTx(pool, (c) => applyEvent(c, deps(), event));
    const held = await pool.query('SELECT * FROM instruments WHERE id = $1', ['inst-consumer-1']);
    expect(held.rows[0]).toMatchObject({ number: 'SA-2026-0099', subject_id: company.id, status: 'ISSUED' });
    expect((await outbox(EVENTS.facilities.licenceIssued)).at(-1)?.data).toMatchObject({ licenceNo: 'SA-2026-0099', subjectKind: 'COMPANY', subjectId: company.id });
    expect((await g(`${C}/${company.id}`)).body.data.instruments.some((i: any) => i.licenseNo === 'SA-2026-0099')).toBe(true);
    await clearOutbox();
    const again = instrumentEvent({ subjectId: company.id, entityName: company.name });
    await withTx(pool, (c) => applyEvent(c, deps(), again));
    expect(await outbox(EVENTS.facilities.licenceIssued)).toHaveLength(0);
  });
  it('announces a suspension and raises the obligation it leaves behind', async () => {
    const company = (await pool.query(`SELECT id, name FROM companies WHERE status = 'ACTIVE' ORDER BY code LIMIT 1`)).rows[0];
    await clearOutbox();
    const event = instrumentEvent({ subjectId: company.id, entityName: company.name, status: 'SUSPENDED', inForce: false });
    await withTx(pool, (c) => applyEvent(c, deps(), event));
    expect((await outbox(EVENTS.facilities.licenceSuspended)).at(-1)?.data).toMatchObject({ previousStatus: 'ISSUED', status: 'SUSPENDED' });
    const raised = (await outbox(EVENTS.facilities.obligationRaised)).at(-1)!;
    expect(raised.data).toMatchObject({ subjectId: company.id, kind: 'CONDITION' });
    const open = await g(`${C}/${company.id}/obligations`);
    expect(open.body.data.obligations.some((o: any) => o.sourceRef === 'SA-2026-0099')).toBe(true);
  });
  it('ignores an instrument held by a subject this register does not keep, and drops one that is deleted', async () => {
    await clearOutbox();
    await withTx(pool, (c) => applyEvent(c, deps(), makeEvent({ type: EVENTS.readModel.upserted, source: 'instruments', data: { kind: 'instrument', entity: { id: 'inst-vessel-1', number: 'NL-2026-0001', subjectKind: 'VESSEL', subjectId: 'a-ship', status: 'ISSUED' } } })));
    expect(await outbox(EVENTS.facilities.licenceIssued)).toHaveLength(0);
    expect((await pool.query('SELECT id FROM instruments WHERE id = $1', ['inst-vessel-1'])).rowCount).toBe(1);
    await withTx(pool, (c) => applyEvent(c, deps(), makeEvent({ type: EVENTS.readModel.deleted, source: 'instruments', data: { kind: 'instrument', id: 'inst-vessel-1' } })));
    expect((await pool.query('SELECT id FROM instruments WHERE id = $1', ['inst-vessel-1'])).rowCount).toBe(0);
  });
  it('follows the harbour estate for a berth\'s particulars without touching the regulatory overlay', async () => {
    const before = (await pool.query(`SELECT * FROM port_facilities WHERE isps_status = 'COMPLIANT' LIMIT 1`)).rows[0];
    await clearOutbox();
    const event = makeEvent({ type: EVENTS.readModel.upserted, source: 'ports', data: { kind: 'berth', entity: { id: before.id, code: before.code, name: 'Renamed Berth', terminal: 'Renamed Terminal', berthType: before.berth_type, loaMax: 321, draftMax: 15.5, status: 'MAINTENANCE' } } });
    await withTx(pool, (c) => applyEvent(c, deps(), event));
    const after = (await pool.query('SELECT * FROM port_facilities WHERE id = $1', [before.id])).rows[0];
    expect(after).toMatchObject({ name: 'Renamed Berth', terminal: 'Renamed Terminal', status: 'MAINTENANCE' });
    expect(Number(after.loa_max)).toBe(321);
    expect(after.isps_status).toBe(before.isps_status);
    expect(after.soc_no).toBe(before.soc_no);
    expect(after.operator_id).toBe(before.operator_id);
    expect((await outbox(EVENTS.facilities.facilityUpdated)).at(-1)?.data.source).toBe('ports');
  });
  it('follows master data for a company\'s identity without touching its standing or rating', async () => {
    const before = (await pool.query(`SELECT * FROM companies WHERE status = 'SUSPENDED' LIMIT 1`)).rows[0]
      ?? (await pool.query('SELECT * FROM companies ORDER BY code LIMIT 1')).rows[0];
    await clearOutbox();
    const event = makeEvent({ type: EVENTS.mdm.companyUpserted, source: 'mdm', data: { companyId: before.id, code: before.code, name: 'Renamed From Master Data', status: 'ACTIVE' } });
    await withTx(pool, (c) => applyEvent(c, deps(), event));
    const after = (await pool.query('SELECT * FROM companies WHERE id = $1', [before.id])).rows[0];
    expect(after.name).toBe('Renamed From Master Data');
    expect(after.status).toBe(before.status);
    expect(after.rating).toBe(before.rating);
    expect((await outbox(EVENTS.readModel.upserted)).at(-1)?.data.entity.name).toBe('Renamed From Master Data');
  });
  it('applies a redelivered event exactly once', async () => {
    const company = (await pool.query(`SELECT id, name FROM companies ORDER BY code LIMIT 1`)).rows[0];
    const event = instrumentEvent({ id: 'inst-consumer-2', subjectId: company.id, entityName: company.name });
    expect(await withInbox(pool, event, (c) => applyEvent(c, deps(), event))).toBe(true);
    expect(await withInbox(pool, event, (c) => applyEvent(c, deps(), event))).toBe(false);
    expect((await pool.query('SELECT id FROM instruments WHERE id = $1', ['inst-consumer-2'])).rowCount).toBe(1);
  });
});

describe('facilities — who may do what', () => {
  it('refuses an unauthenticated caller and a caller without the permission', async () => {
    const c = (await pool.query('SELECT id FROM companies ORDER BY code LIMIT 1')).rows[0];
    expect((await request(server as never).get(C)).status).toBe(401);
    expect((await request(server as never).get(C).set('authorization', 'Bearer nonsense')).status).toBe(401);
    expect((await g(C, nobody)).status).toBe(403);
    expect((await post(C, { code: 'NOPE', name: 'Not allowed', category: 'AGENCY' }, viewer)).status).toBe(403);
    expect((await post(`${C}/${c.id}/status`, { status: 'SUSPENDED', reason: 'Not allowed' }, clerk)).status).toBe(403);
    expect((await post(`${C}/${c.id}/audits`, { result: 'SATISFACTORY' }, viewer)).status).toBe(403);
    expect((await del(`${C}/${c.id}`, viewer)).status).toBe(403);
    expect((await g('/facilities/dashboard', nobody)).status).toBe(403);
  });
  it('writes an audit entry for every mutation', async () => {
    await clearOutbox();
    const c = await newCompany();
    await post(`${C}/${c.id}/audits`, { result: 'NON_CONFORMITY', auditor: 'A Surveyor', remarks: 'A finding' }, clerk);
    await post(`${C}/${c.id}/status`, { status: 'SUSPENDED', reason: 'Finding not answered' }, registrar);
    const entries = await outbox(EVENTS.audit.recorded);
    expect(entries.map((e) => e.data.action)).toEqual(expect.arrayContaining(['CREATE', 'AUDIT', 'OBLIGATION_RAISED', 'SUSPEND']));
    expect(entries.every((e) => e.data.entityLabel && e.data.entity)).toBe(true);
  });
  it('validates every vocabulary against the mirror of the master, and follows the master as it changes', async () => {
    const bad = await post(C, { code: 'VOC1', name: 'Vocabulary test', category: 'ORBITAL_AGENCY' }, clerk);
    expect(bad.status).toBe(400); expect(bad.body.message).toMatch(/ORBITAL_AGENCY.*companyCategory/); expect(bad.body.allowed).toContain('AGENCY');
    expect((await post(C, { code: 'VOC2', name: 'Vocabulary test', category: 'AGENCY', types: ['MOON_MINING'] }, clerk)).body.message).toMatch(/MOON_MINING/);
    expect((await post(F, { name: 'Vocabulary jetty', facilityType: 'SPACEPORT' }, clerk)).body.message).toMatch(/SPACEPORT.*facilityType/);
    expect((await post(F, { name: 'Vocabulary jetty', facilityType: 'JETTY', capabilities: ['CONTAINER', 'ANTIMATTER'] }, clerk)).body.message).toMatch(/ANTIMATTER.*facilityCapability/);
    // Data Studio adds the value; the event lands; the same request is accepted — no release, no call to mdm
    const added = makeEvent({ type: EVENTS.mdm.lookupChanged, source: 'mdm', data: { category: 'companyCategory', code: 'ORBITAL_AGENCY', change: 'created', lookup: { category: 'companyCategory', code: 'ORBITAL_AGENCY', label: 'Orbital agency', labelAr: 'وكالة مدارية', meta: {}, active: true } } });
    await withInbox(pool, added, (c) => applyEvent(c, { env, audit }, added));
    const ok = await post(C, { code: 'VOC1', name: 'Vocabulary test', category: 'ORBITAL_AGENCY' }, clerk); expect(ok.status).toBe(201);
    expect((await g('/facilities/meta')).body.data.categoryOptions.find((o: any) => o.code === 'ORBITAL_AGENCY')).toMatchObject({ label: 'Orbital agency', labelAr: 'وكالة مدارية' });
    const removed = makeEvent({ type: EVENTS.mdm.lookupChanged, source: 'mdm', data: { category: 'companyCategory', code: 'ORBITAL_AGENCY', change: 'deleted' } });
    await withInbox(pool, removed, (c) => applyEvent(c, { env, audit }, removed));
    expect((await put(`${C}/${ok.body.data.id}`, { category: 'ORBITAL_AGENCY' }, clerk)).status).toBe(400);
    expect((await post(`${C}/${ok.body.data.id}/obligations`, { kind: 'WISH', title: 'Not a kind' }, clerk)).body.message).toMatch(/WISH.*obligationKind/);
    expect((await post(`${C}/${ok.body.data.id}/obligations`, { kind: 'DOCUMENT', title: 'Produce the trade licence' }, clerk)).status).toBe(201);
  });
});

/* ================================================================ tenancy on the directory === */

describe('facilities — tenancy', () => {
  it('gives every entry an owner, derived from what the row already names', async () => {
    const co = await pool.query<{ n: string; owned: string }>(
      "SELECT count(*)::text AS n, count(*) FILTER (WHERE scope_company <> '')::text AS owned FROM companies");
    expect(Number(co.rows[0].owned)).toBe(Number(co.rows[0].n));
    // a facility's owner is the company that operates it, and it never drifts from the operator on the row
    const drift = await pool.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM port_facilities f JOIN companies c ON c.id = f.operator_id
        WHERE f.scope_company <> c.code`);
    expect(Number(drift.rows[0].n)).toBe(0);
    // and an obligation or an audit belongs to whoever it was raised against
    for (const table of ['obligations', 'audits']) {
      const r = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} t JOIN companies c ON c.id = t.subject_id
          WHERE t.subject_kind = 'COMPANY' AND t.scope_company <> c.code`);
      expect(Number(r.rows[0].n)).toBe(0);
    }
  });

  it('shows an operator their own entry and no one else\'s, on the register and by id', async () => {
    const mine = await g('/facilities/companies?limit=500', agentGss);
    expect(mine.status).toBe(200);
    expect(mine.body.meta.total).toBe(1);
    expect(mine.body.data[0].code).toBe('GSS');
    const all = await g('/facilities/companies?limit=500', admin);
    expect(all.body.meta.total).toBeGreaterThan(1);

    const other = all.body.data.find((c: { code: string }) => c.code !== 'GSS');
    expect((await g(`/facilities/companies/${other.id}`, agentGss)).status).toBe(404);
    expect((await g(`/facilities/companies/${other.code}`, agentGss)).status).toBe(404);
    expect((await g(`/facilities/companies/${other.id}`, admin)).status).toBe(200);
    expect((await g(`/facilities/companies/${mine.body.data[0].id}`, agentGss)).status).toBe(200);
    // the sub-resources hang off the same load, so they are covered by it rather than by their own check
    expect((await g(`/facilities/companies/${other.id}/audits`, agentGss)).status).toBe(404);
    expect((await g(`/facilities/companies/${other.id}/obligations`, agentGss)).status).toBe(404);
    expect((await g(`/facilities/companies/${other.id}/instruments`, agentGss)).status).toBe(404);
  });

  it('shows an operator the facilities they run, not the estate', async () => {
    const mine = await g('/facilities/port-facilities?limit=500', agentGss);
    const all = await g('/facilities/port-facilities?limit=500', admin);
    expect(all.body.meta.total).toBeGreaterThan(mine.body.meta.total);
    expect(mine.body.data.every((f: { operatorName: string }) => f.operatorName.length > 0)).toBe(true);
    const other = all.body.data.find((f: { id: string }) => !mine.body.data.some((m: { id: string }) => m.id === f.id));
    expect(other).toBeTruthy();
    expect((await g(`/facilities/port-facilities/${other.id}`, agentGss)).status).toBe(404);
  });

  it('shows an operator the obligations raised against them and no other company\'s', async () => {
    const mine = await g('/facilities/obligations?limit=500', agentGss);
    const all = await g('/facilities/obligations?limit=500', admin);
    expect(all.body.meta.total).toBeGreaterThan(0);
    expect(mine.body.meta.total).toBeLessThanOrEqual(all.body.meta.total);
    const gssIds = new Set((await pool.query<{ id: string }>("SELECT id FROM obligations WHERE scope_company = 'GSS'")).rows.map((r) => r.id));
    expect(mine.body.data.every((o: { id: string }) => gssIds.has(o.id))).toBe(true);
    const audits = await g('/facilities/audits?limit=500', agentGss);
    const allAudits = await g('/facilities/audits?limit=500', admin);
    expect(allAudits.body.meta.total).toBeGreaterThan(audits.body.meta.total);
  });

  it('leaves an officer reading the whole directory, with no clause added at all', async () => {
    expect((await g('/facilities/companies?limit=1', viewer)).body.meta.total).toBe((await g('/facilities/companies?limit=1', admin)).body.meta.total);
    expect((await g('/facilities/audits?limit=1', viewer)).body.meta.total).toBe((await g('/facilities/audits?limit=1', admin)).body.meta.total);
  });
});

describe('facilities — annual accreditation and inspection visits', () => {
  const deps = () => ({ env, audit });
  const day = (n: number) => iso(Date.now() + n * D);
  const accreditationEvent = (over: Record<string, unknown>) => makeEvent({
    type: EVENTS.readModel.upserted, source: 'instruments',
    data: { kind: 'instrument', entity: { id: 'acc-inst-1', number: 'ACC-CMP-2026-0001', subjectKind: 'COMPANY', entityType: 'COMPASS_CALIBRATION', typeLabel: 'Magnetic Compass Adjuster Approval', instrumentClass: 'ACCREDITATION', status: 'ISSUED', issueDate: day(-10), expiryDate: day(355), inForce: true, ...over } },
  });

  it('reads a cycle against the calendar, spaces the visits, and weighs visits into the rating', () => {
    const now = new Date('2026-06-01T00:00:00Z');
    expect(cycleStateOn({ status: 'CURRENT', ends_on: '2027-05-01' }, now, [90, 30, 7])).toMatchObject({ status: 'CURRENT', inWindow: false });
    expect(cycleStateOn({ status: 'CURRENT', ends_on: '2026-06-20' }, now, [90, 30, 7])).toMatchObject({ status: 'DUE', daysLeft: 19, inWindow: true });
    expect(cycleStateOn({ status: 'CURRENT', ends_on: '2026-05-20' }, now, [90, 30, 7]).status).toBe('EXPIRED');
    expect(cycleStateOn({ status: 'SUSPENDED', ends_on: '2026-05-20' }, now, [90, 30, 7]).status).toBe('SUSPENDED');
    expect(cycleStateOn({ status: 'RENEWED', ends_on: '2026-06-20' }, now, [90, 30, 7]).status).toBe('RENEWED');
    const s = new Date('2026-01-01T00:00:00Z'); const e = new Date('2027-01-01T00:00:00Z');
    expect(nextVisitDue(s, e, 1, 0)?.toISOString().slice(0, 10)).toBe('2026-10-01');
    expect(nextVisitDue(s, e, 2, 1)?.toISOString().slice(0, 7)).toBe('2026-11');
    expect(nextVisitDue(s, e, 1, 1)).toBeNull();
    expect(parseDays('90, 30,7', [1])).toEqual([90, 30, 7]); expect(parseDays('', [60])).toEqual([60]); expect(parseDays([7, 30], [1])).toEqual([30, 7]);
    expect(scoreToRating(100)).toBe(5); expect(scoreToRating(40)).toBe(2); expect(scoreToRating(0)).toBe(1);
    // a scored visit speaks for itself; a spot check informs the rating without dominating it
    expect(ratingFrom([{ date: '2026-05-01', result: 'NON_CONFORMITY', score: 55, source: 'VISIT' }], now)).toBe(2.8);
    const audited = ratingFrom([{ date: '2026-05-01', result: 'SATISFACTORY' }], now);
    const withSpot = ratingFrom([{ date: '2026-05-01', result: 'SATISFACTORY' }, { date: '2026-05-15', result: 'NON_CONFORMITY', score: 40, weight: 0.6, source: 'VISIT' }], now);
    const withAnnual = ratingFrom([{ date: '2026-05-01', result: 'SATISFACTORY' }, { date: '2026-05-15', result: 'NON_CONFORMITY', score: 40, weight: 1, source: 'VISIT' }], now);
    expect(withSpot!).toBeLessThan(audited!); expect(withAnnual!).toBeLessThan(withSpot!);
    const shown = ratingBreakdown([{ date: '2026-05-01', result: 'SATISFACTORY', number: 'AUD-2026-0001' }, { date: '2026-05-15', result: 'OBSERVATIONS', score: 70, weight: 0.8, source: 'VISIT', number: 'VIS-2026-0001' }], now);
    expect(shown.entries.map((x) => x.source)).toEqual(['VISIT', 'AUDIT']); expect(shown.entries[0]).toMatchObject({ value: 3.5, typeWeight: 0.8 }); expect(shown.rating).toBe(shown.rating);
    const dash = accreditationDashboard([
      { category: 'PEST_CONTROL', status: 'CURRENT', endsOn: '2026-06-20', companyId: 'a', rating: 4, visitOverdue: false } as never,
      { category: 'PEST_CONTROL', status: 'DUE', endsOn: '2026-06-10', companyId: 'b', rating: 3, visitOverdue: true } as never,
      { category: 'TOWAGE_CERTIFICATION', status: 'EXPIRED', endsOn: '2026-05-01', companyId: 'c', rating: null, visitOverdue: false } as never,
    ], [{ status: 'SCHEDULED', overdue: true, scheduledOn: '2026-05-20' } as never, { status: 'COMPLETED', result: 'NON_CONFORMITY', visitedOn: '2026-05-20' } as never],
    [{ category: 'PEST_CONTROL', label: 'Pest control', labelAr: null, cycleMonths: 12 } as never, { category: 'TOWAGE_CERTIFICATION', label: 'Towage', labelAr: null, cycleMonths: 12 } as never], now);
    expect(dash.kpis).toMatchObject({ schemes: 2, accredited: 2, companies: 2, due: 1, expired: 1, renewalsNext30: 2, visitsScheduled: 1, visitsOverdue: 2, nonConformities90: 1 });
    expect(dash.bySchemes[0]).toMatchObject({ category: 'PEST_CONTROL', companies: 2, current: 1, due: 1, visitsOverdue: 1, averageRating: 3.5 });
  });

  it('seeds the seven schemes with cycles, visits and a desk dashboard, read from the master', async () => {
    const schemes = await g('/facilities/accreditations/schemes'); expect(schemes.body.data).toHaveLength(7); expect(schemes.body.data[0]).toMatchObject({ cycleMonths: 12, visitsPerCycle: 1, reminderDays: [90, 30, 7] });
    const dash = await g('/facilities/accreditations/dashboard'); expect(dash.body.data.kpis.schemes).toBe(7); expect(dash.body.data.kpis.accredited).toBeGreaterThan(0);
    const list = await g('/facilities/accreditations?limit=100'); expect(list.body.meta.total).toBeGreaterThan(0);
    for (const row of list.body.data) expect(['CURRENT', 'DUE', 'EXPIRED', 'SUSPENDED', 'WITHDRAWN']).toContain(row.status);
    const history = await g('/facilities/accreditations?history=true&limit=200'); expect(history.body.meta.total).toBeGreaterThanOrEqual(list.body.meta.total);
    const visits = await g('/facilities/visits?limit=100'); expect(visits.body.meta.total).toBeGreaterThan(0); expect(visits.body.data.every((v: any) => /^VIS-\d{4}-\d{4}$/.test(v.number))).toBe(true);
    const one = await g(`/facilities/accreditations/${list.body.data[0].id}`); expect(one.body.data.scheme.category).toBe(list.body.data[0].category); expect(one.body.data.history.length).toBeGreaterThan(0);
    expect((await g('/facilities/accreditations/00000000-0000-4000-a000-000000000000')).status).toBe(404);
  });

  it('grants, renews and reads back a cycle by hand, and refuses what the master or the standing does not allow', async () => {
    const co = await newCompany({ category: 'SERVICE_PROVIDER', types: ['PEST_CONTROL'] });
    await clearOutbox();
    expect((await post(`${C}/${co.id}/accreditations`, { category: 'MOON_MINING', startsOn: day(-30) }, registrar)).status).toBe(400);
    expect((await post(`${C}/${co.id}/accreditations`, { category: 'PEST_CONTROL', startsOn: day(-30) }, clerk)).status).toBe(403);
    const granted = await post(`${C}/${co.id}/accreditations`, { category: 'PEST_CONTROL', startsOn: day(-30), instrumentNo: 'ACC-PST-2025-0007' }, registrar);
    expect(granted.status).toBe(201); expect(granted.body.data.change).toBe('opened');
    expect(granted.body.data.cycle).toMatchObject({ category: 'PEST_CONTROL', cycleNo: 1, status: 'CURRENT', visitsRequired: 1, visitsDone: 0, instrumentNo: 'ACC-PST-2025-0007' });
    expect(granted.body.data.cycle.daysLeft).toBeGreaterThan(300); expect(granted.body.data.cycle.nextVisitDue).toBeTruthy();
    expect((await outbox(EVENTS.facilities.accreditationOpened)).at(-1)?.data).toMatchObject({ companyId: co.id, category: 'PEST_CONTROL', cycleNo: 1, change: 'opened' });
    const full = await g(`${C}/${co.id}`); expect(full.body.data.accreditedFor).toEqual(['PEST_CONTROL']); expect(full.body.data.accreditations[0].status).toBe('CURRENT');
    const renewed = await post(`${C}/${co.id}/accreditations`, { category: 'PEST_CONTROL', startsOn: day(300), instrumentNo: 'ACC-PST-2026-0031', reason: 'Renewed on application' }, registrar);
    expect(renewed.body.data.change).toBe('renewed'); expect(renewed.body.data.cycle.cycleNo).toBe(2);
    const position = await g(`${C}/${co.id}/accreditations`);
    expect(position.body.data.position).toHaveLength(1); expect(position.body.data.position[0].cycleNo).toBe(2);
    expect(position.body.data.history.map((x: any) => [x.cycleNo, x.status])).toEqual([[2, 'CURRENT'], [1, 'RENEWED']]);
    expect((await outbox(EVENTS.facilities.accreditationRenewed)).at(-1)?.data).toMatchObject({ cycleNo: 2, previousCycleId: granted.body.data.cycle.id });
    await post(`${C}/${co.id}/status`, { status: 'SUSPENDED', reason: 'Servicing station closed' }, registrar);
    expect((await post(`${C}/${co.id}/accreditations`, { category: 'LSA_SERVICING', startsOn: day(-1) }, registrar)).status).toBe(409);
  });

  it('opens, suspends, reinstates and withdraws a cycle as the instrument register issues, suspends and revokes', async () => {
    const co = await newCompany({ category: 'SERVICE_PROVIDER', types: ['COMPASS_CALIBRATION'] });
    await clearOutbox();
    await withTx(pool, (c) => applyEvent(c, deps(), accreditationEvent({ subjectId: co.id, entityName: co.name })));
    let position = (await g(`${C}/${co.id}/accreditations`)).body.data.position;
    expect(position).toHaveLength(1); expect(position[0]).toMatchObject({ category: 'COMPASS_CALIBRATION', status: 'CURRENT', instrumentNo: 'ACC-CMP-2026-0001', cycleNo: 1 });
    expect((await outbox(EVENTS.facilities.accreditationOpened)).at(-1)?.data).toMatchObject({ companyId: co.id, category: 'COMPASS_CALIBRATION' });
    // the same issue arriving again is the same cycle
    await withTx(pool, (c) => applyEvent(c, deps(), accreditationEvent({ subjectId: co.id, entityName: co.name })));
    expect((await g(`${C}/${co.id}/accreditations`)).body.data.history).toHaveLength(1);
    await withTx(pool, (c) => applyEvent(c, deps(), accreditationEvent({ subjectId: co.id, entityName: co.name, status: 'SUSPENDED' })));
    position = (await g(`${C}/${co.id}/accreditations`)).body.data.position; expect(position[0].status).toBe('SUSPENDED');
    expect((await outbox(EVENTS.facilities.accreditationSuspended)).at(-1)?.data).toMatchObject({ companyId: co.id, reason: 'ACC-CMP-2026-0001 suspended' });
    await withTx(pool, (c) => applyEvent(c, deps(), accreditationEvent({ subjectId: co.id, entityName: co.name, status: 'ISSUED' })));
    position = (await g(`${C}/${co.id}/accreditations`)).body.data.position; expect(position[0].status).toBe('CURRENT'); expect(position[0].statusReason).toMatch(/reinstated/i);
    await withTx(pool, (c) => applyEvent(c, deps(), accreditationEvent({ subjectId: co.id, entityName: co.name, status: 'REVOKED' })));
    position = (await g(`${C}/${co.id}/accreditations`)).body.data.position; expect(position[0].status).toBe('WITHDRAWN');
    expect((await outbox(EVENTS.facilities.accreditationWithdrawn)).at(-1)?.data).toMatchObject({ companyId: co.id });
    // an instrument under no scheme opens nothing
    const other = await newCompany({ category: 'AGENCY', types: ['SHIPPING_AGENCY'] });
    await withTx(pool, (c) => applyEvent(c, deps(), accreditationEvent({ id: 'acc-inst-2', number: 'LIC-2026-0500', subjectId: other.id, entityName: other.name, entityType: 'SHIPPING_AGENCY', instrumentClass: 'LICENCE' })));
    expect((await g(`${C}/${other.id}/accreditations`)).body.data.position).toHaveLength(0);
  });

  it('moves a cycle into its renewal window, reminds once per milestone with an obligation, and expires it on the day', async () => {
    const co = await newCompany({ category: 'SERVICE_PROVIDER', types: ['TOWAGE_CERTIFICATION'] });
    const granted = await post(`${C}/${co.id}/accreditations`, { category: 'TOWAGE_CERTIFICATION', startsOn: day(-350), instrumentNo: 'ACC-TOW-2025-0002' }, registrar);
    expect(granted.body.data.cycle.status).toBe('DUE'); // read against the calendar before any sweep
    await clearOutbox();
    const swept = await post('/facilities/accreditations/sweep', {}, registrar); expect(swept.status).toBe(201);
    expect(swept.body.data.due).toBeGreaterThanOrEqual(1); expect(swept.body.data.reminded).toBeGreaterThanOrEqual(2);
    const cycle = (await g(`/facilities/accreditations/${granted.body.data.cycle.id}`)).body.data;
    expect(cycle.storedStatus).toBe('DUE'); expect(cycle.reminders).toEqual([90, 30]);
    const dueEvents = (await outbox(EVENTS.facilities.accreditationDue)).filter((e) => e.data.companyId === co.id);
    expect(dueEvents.map((e) => e.data.reminderDay)).toEqual([90, 30]);
    const obligations = (await g(`${C}/${co.id}/obligations`)).body.data.obligations.filter((o: any) => o.kind === 'RENEWAL');
    expect(obligations).toHaveLength(1); expect(obligations[0].title).toMatch(/Renew Towage accreditation/);
    // the next sweep owes nothing new
    await clearOutbox();
    expect((await post('/facilities/accreditations/sweep', {}, registrar)).body.data.reminded).toBe(0);
    expect((await outbox(EVENTS.facilities.accreditationDue)).filter((e) => e.data.companyId === co.id)).toHaveLength(0);
    // the day after it ends
    const expired = await post('/facilities/accreditations/sweep', { now: day(20) }, registrar); expect(expired.body.data.expired).toBeGreaterThanOrEqual(1);
    expect((await g(`/facilities/accreditations/${granted.body.data.cycle.id}`)).body.data.storedStatus).toBe('EXPIRED');
    expect((await outbox(EVENTS.facilities.accreditationExpired)).some((e) => e.data.companyId === co.id)).toBe(true);
    expect((await g(`${C}/${co.id}`)).body.data.accreditationsExpired).toBe(1);
    expect((await post('/facilities/accreditations/sweep', {}, clerk)).status).toBe(403);
  });

  it('schedules a visit, records what it found, moves the rating, raises the findings and counts it on the cycle', async () => {
    const co = await newCompany({ category: 'SERVICE_PROVIDER', types: ['PEST_CONTROL'] });
    await post(`${C}/${co.id}/accreditations`, { category: 'PEST_CONTROL', startsOn: day(-60) }, registrar);
    expect((await post(`${C}/${co.id}/visits`, { visitType: 'PICNIC' }, clerk)).body.message).toMatch(/PICNIC.*visitType/);
    expect((await post(`${C}/${co.id}/visits`, { visitType: 'ANNUAL', category: 'MOON_MINING' }, clerk)).status).toBe(400);
    expect((await post(`${C}/${co.id}/visits`, { visitType: 'ANNUAL' }, viewer)).status).toBe(403);
    await clearOutbox();
    const planned = await post(`${C}/${co.id}/visits`, { visitType: 'ANNUAL', category: 'PEST_CONTROL', scheduledOn: day(3), inspector: 'S. Al Marzouqi' }, clerk);
    expect(planned.status).toBe(201); const v = planned.body.data.visit;
    expect(v).toMatchObject({ status: 'SCHEDULED', visitType: 'ANNUAL', category: 'PEST_CONTROL', inspector: 'S. Al Marzouqi' }); expect(v.number).toMatch(/^VIS-\d{4}-\d{4}$/); expect(v.cycleId).toBeTruthy();
    expect((await outbox(EVENTS.facilities.visitScheduled)).at(-1)?.data).toMatchObject({ number: v.number, subjectId: co.id });
    expect((await g(`${C}/${co.id}/visits`)).body.data).toMatchObject({ scheduled: 1, overdue: 0 });
    expect((await post(`/facilities/visits/${v.id}/complete`, { result: 'SATISFACTORY', visitedOn: day(5) }, clerk)).status).toBe(400); // not in the future
    expect((await post(`/facilities/visits/${v.id}/complete`, { result: 'SATISFACTORY', score: 140 }, clerk)).status).toBe(400);
    const done = await post(`/facilities/visits/${v.id}/complete`, { result: 'NON_CONFORMITY', score: 55, remarks: 'Fumigation logs missing for two vessels', findings: [{ code: 'PC-01', title: 'Fumigation log not kept', severity: 'MAJOR', dueDays: 21 }, { code: 'PC-02', title: 'Operator certificates expired', severity: 'CRITICAL' }] }, clerk);
    expect(done.status).toBe(201);
    expect(done.body.data.visit).toMatchObject({ status: 'COMPLETED', result: 'NON_CONFORMITY', score: 55 }); expect(done.body.data.obligations).toHaveLength(2);
    expect(done.body.data.rating).toBe(2.8); expect(done.body.data.cycle).toMatchObject({ visitsDone: 1, visitsOutstanding: 0, lastVisitResult: 'NON_CONFORMITY', nextVisitDue: null, rating: 2.8 });
    expect((await outbox(EVENTS.facilities.visitCompleted)).at(-1)?.data).toMatchObject({ number: v.number, result: 'NON_CONFORMITY', findings: 2, obligations: 2, rating: 2.8 });
    const obligations = (await g(`${C}/${co.id}/obligations`)).body.data.obligations.filter((o: any) => o.kind === 'VISIT_FINDING');
    expect(obligations.map((o: any) => o.title).sort()).toEqual(['PC-01 — Fumigation log not kept', 'PC-02 — Operator certificates expired']);
    expect(Math.round((new Date(obligations.find((o: any) => o.title.startsWith('PC-01')).dueAt).getTime() - Date.now()) / D)).toBe(21);
    const company = (await g(`${C}/${co.id}`)).body.data; expect(company.rating).toBe(2.8); expect(company.lastVisitAt).toBeTruthy(); expect(company.visits).toHaveLength(1);
    const rating = (await g(`${C}/${co.id}/rating`)).body.data; expect(rating.rating).toBe(2.8); expect(rating.entries[0]).toMatchObject({ source: 'VISIT', number: v.number, score: 55, typeWeight: 1 });
    expect((await post(`/facilities/visits/${v.id}/complete`, { result: 'SATISFACTORY' }, clerk)).status).toBe(409);
    // a spot check is recorded on the spot, and weighs less than the annual visit did
    const spot = await post(`${C}/${co.id}/visits`, { visitType: 'SPOT_CHECK', complete: { result: 'SATISFACTORY', score: 95, remarks: 'Unannounced; records in order' } }, clerk);
    expect(spot.status).toBe(201); expect(spot.body.data.visit.status).toBe('COMPLETED'); expect(spot.body.data.rating).toBeGreaterThan(2.8); expect(spot.body.data.rating).toBeLessThan(4);
    // an audit recorded now reads the same history
    const audited = await post(`${C}/${co.id}/audits`, { result: 'SATISFACTORY', remarks: 'Follow-up audit' }, clerk); expect(audited.body.data.rating).toBeGreaterThan(spot.body.data.rating);
    // cancellation needs a reason and only applies to a planned visit
    const later = await post(`${C}/${co.id}/visits`, { visitType: 'FOLLOW_UP', scheduledOn: day(30) }, clerk);
    expect((await post(`/facilities/visits/${later.body.data.visit.id}/cancel`, { reason: '' }, clerk)).status).toBe(400);
    const cancelled = await post(`/facilities/visits/${later.body.data.visit.id}/cancel`, { reason: 'Rescheduled with the operator' }, clerk); expect(cancelled.body.data.status).toBe('CANCELLED');
    expect((await post(`/facilities/visits/${later.body.data.visit.id}/complete`, { result: 'SATISFACTORY' }, clerk)).status).toBe(409);
    expect((await outbox(EVENTS.facilities.visitCancelled)).at(-1)?.data).toMatchObject({ reason: 'Rescheduled with the operator' });
    const listed = await g(`/facilities/visits?subjectId=${co.id}&limit=50`); expect(listed.body.meta.total).toBe(3);
    expect((await g(`/facilities/visits?subjectId=${co.id}&status=COMPLETED&result=NON_CONFORMITY`)).body.meta.total).toBe(1);
    // a port facility is visited the same way
    const f = await newFacility(); const fv = await post(`${F}/${f.id}/visits`, { visitType: 'SPOT_CHECK', complete: { result: 'OBSERVATIONS', score: 70 } }, clerk);
    expect(fv.status).toBe(201); expect(fv.body.data.visit.subjectKind).toBe('FACILITY'); expect((await g(`${F}/${f.id}/rating`)).body.data.rating).toBe(3.5);
  });

  it('shows an operator their own visits and cycles, and nobody else\'s', async () => {
    const gss = (await pool.query("SELECT id, name FROM companies WHERE code = 'GSS'")).rows[0];
    const mine = await post(`${C}/${gss.id}/visits`, { visitType: 'SPOT_CHECK', complete: { result: 'SATISFACTORY', score: 88 } }, clerk); expect(mine.status).toBe(201);
    const other = (await g('/facilities/visits?limit=100')).body.data.find((v: any) => v.subjectId !== gss.id);
    const seen = await g('/facilities/visits?limit=100', agentGss); expect(seen.body.meta.total).toBeGreaterThan(0); expect(seen.body.data.every((v: any) => v.subjectId === gss.id)).toBe(true);
    expect((await g(`/facilities/visits/${mine.body.data.visit.id}`, agentGss)).status).toBe(200);
    expect((await g(`/facilities/visits/${other.id}`, agentGss)).status).toBe(404);
    const cycles = await g('/facilities/accreditations?limit=100', agentGss); expect(cycles.body.data.every((x: any) => x.companyId === gss.id)).toBe(true);
    expect((await g('/facilities/accreditations/dashboard', agentGss)).body.data.kpis.companies).toBeLessThanOrEqual(1);
  });
});
