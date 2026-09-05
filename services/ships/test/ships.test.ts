import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { DEFAULT_RISK_WEIGHTS, EVENTS, makeEvent, subjectFor } from '@maritime/contracts';
import { AuditClient, PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256 } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedShips } from '../src/seed';
import { applyEvent } from '../src/consumer';
import { buildWorld } from '@maritime/world';
import { qualifies, registrationChecks, shareLedger, requiredEvidence, blocking, ruleOf, type KindRule } from '../src/registry';
import { digestOf } from '../src/transactions';
import { scoreVessel, bandOf } from '../src/risk';
import { ageBandOf, surveyEvents, voyagesOf } from '../src/vessels';

const DB = 'maritime_ships_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let audit: AuditClient; let env: ReturnType<typeof loadEnv<typeof envSchema>>;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const registrar = tok('registrar'); const officer = tok('officer'); const clerk = tok('clerk'); const nobody = tok('nobody');
/* An operator, not an officer: they read what is theirs and nothing else. */
const agentgss = tok('agent-gss');
const g = (p: string, t = admin) => request(server as never).get(p).set('authorization', t);
const post = (p: string, body?: unknown, t = admin) => request(server as never).post(p).set('authorization', t).send((body ?? {}) as never);
const put = (p: string, body: unknown, t = admin) => request(server as never).put(p).set('authorization', t).send(body as never);
const del = (p: string, t = admin) => request(server as never).delete(p).set('authorization', t);
const outbox = async (type: string) => (await pool.query('SELECT payload FROM outbox WHERE subject = $1 ORDER BY id', [subjectFor(type)])).rows.map((r) => r.payload as { type: string; data: Record<string, any> });
const clearOutbox = () => pool.query('DELETE FROM outbox');
const D = 86_400_000;
/* The variants as the master declares them — the same rows the runtime mirrors. */
const RULES = new Map<string, KindRule>(buildWorld({ profile: 'AE' }).lookups.filter((l) => l.category === 'registrationKind').map((l) => [l.code, ruleOf({ code: l.code, label: l.label, labelAr: l.labelAr ?? null, meta: l.meta, active: true })]));
const rule = (k: string) => RULES.get(k)!;

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedShips(URL, 'AE');
  env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET } as never);
  const base = { scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    admin: { ...base, id: 'admin', sub: 'admin', name: 'Admin', perms: ['*'] },
    registrar: { ...base, id: 'registrar', sub: 'registrar', name: 'Registrar of Ships', perms: ['registry.view', 'registry.apply', 'registry.assess', 'registry.grant', 'vessels.view'] },
    officer: { ...base, id: 'officer', sub: 'officer', name: 'Fleet Officer', perms: ['vessels.view', 'vessels.create', 'vessels.edit', 'vessels.delete', 'certificates.view', 'certificates.manage', 'risk.view'] },
    clerk: { ...base, id: 'clerk', sub: 'clerk', name: 'Records Clerk', perms: ['vessels.view', 'registry.view'] },
    nobody: { ...base, id: 'nobody', sub: 'nobody', name: 'Nobody', perms: ['dashboard.view'] },
    'agent-gss': { ...base, id: 'agent-gss', sub: 'agent-gss', name: 'Gulf Star Shipping', kind: 'agent' as const, perms: ['vessels.view', 'registry.view', 'risk.view'], scope: { level: 'COMPANY', companies: ['GSS'] } },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer(); pool = new Pool({ connectionString: URL }); audit = app.get(AuditClient);
});
afterAll(async () => { await pool?.end(); await app?.close(); });

/** A fictional ship that has never been on this register and carries no open file. */
async function unregisteredVessel() {
  const r = await pool.query<{ id: string; name: string; imo: string; grt: number }>(
    `SELECT v.id, v.name, v.imo, v.grt FROM vessels v WHERE v.registry_state = 'UNREGISTERED' AND NOT v.real AND v.status = 'ACTIVE'
       AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.vessel_id = v.id) ORDER BY v.name LIMIT 1`);
  return r.rows[0];
}
const OWNERS = (n = 24) => [{ name: 'Falaj Holdings LLC', address: 'Port Zone, Abu Dhabi', nationality: 'United Arab Emirates', shares: n, kind: 'BODY_CORPORATE' as const, registrationNo: 'CN-1234567 (sample)' }];
const EVIDENCE_PERMANENT = [
  { key: 'DECLARATION_OF_OWNERSHIP', label: 'Declaration of ownership', reference: 'DOO/1' },
  { key: 'TITLE_DOCUMENT', label: "Builder's certificate", reference: 'BC/1' },
  { key: 'TONNAGE_CERTIFICATE', label: 'Tonnage measurement certificate', reference: 'TM/1' },
  { key: 'SURVEY_CERTIFICATE', label: 'Certificate of survey', reference: 'SUR/1' },
];

describe('ships — the statutory rules, tested without a request', () => {
  it('tests a body corporate on its registration and an individual on nationality', () => {
    const j = { name: 'United Arab Emirates', code: 'AE', identity: { companyIdLabel: 'Trade licence' } } as never;
    expect(qualifies({ kind: 'BODY_CORPORATE', name: 'X LLC', registrationNo: 'CN-1' }, j).ok).toBe(true);
    expect(qualifies({ kind: 'BODY_CORPORATE', name: 'X LLC' }, j).ok).toBe(false);
    expect(qualifies({ kind: 'INDIVIDUAL', name: 'A', nationality: 'United Arab Emirates' }, j).ok).toBe(true);
    expect(qualifies({ kind: 'INDIVIDUAL', name: 'A', nationality: 'Panama' }, j).why).toContain('Panama');
  });
  it('balances the share ledger against the jurisdiction denominator', () => {
    expect(shareLedger([{ shares: 24 }], 'AE')).toMatchObject({ denominator: 24, held: 24, balanced: true, withinLimit: true });
    expect(shareLedger([{ shares: 20 }], 'AE').balanced).toBe(false);
    expect(shareLedger([], 'AE').withinLimit).toBe(false);
  });
  it('resolves the conditional evidence a journey actually needs', () => {
    expect(requiredEvidence({ kind: 'PERMANENT' }, rule('PERMANENT'), 'AE').map((e) => e.key)).not.toContain('DELETION_CERTIFICATE');
    expect(requiredEvidence({ kind: 'PERMANENT', previousFlag: 'Panama' }, rule('PERMANENT'), 'AE').map((e) => e.key)).toContain('DELETION_CERTIFICATE');
    expect(requiredEvidence({ kind: 'AMENDMENT', amendment: { types: ['NAME'] } }, rule('AMENDMENT'), 'AE').map((e) => e.key)).toContain('NAME_APPROVAL');
    expect(requiredEvidence({ kind: 'DELETION', encumbrances: [{ dischargedOn: null }] }, rule('DELETION'), 'AE').map((e) => e.key)).toContain('MORTGAGE_DISCHARGE');
    // a charge registered on the entry itself, not on the file, still calls for the mortgagee's consent
    expect(requiredEvidence({ kind: 'BAREBOAT_OUT' }, rule('BAREBOAT_OUT'), 'AE', null, 1).map((e) => e.key)).toContain('MORTGAGEE_CONSENT');
    expect(requiredEvidence({ kind: 'BAREBOAT_OUT' }, rule('BAREBOAT_OUT'), 'AE', null, 0).map((e) => e.key)).not.toContain('MORTGAGEE_CONSENT');
    expect(requiredEvidence({ kind: 'RE_REGISTRATION' }, rule('RE_REGISTRATION'), 'AE', { registry_state: 'BAREBOAT_OUT' }).map((e) => e.key)).toContain('BAREBOAT_TERMINATION');
  });
  it('blocks a first registration for a ship already on the register, and a closure carrying a live charge', () => {
    const first = registrationChecks({ kind: 'PERMANENT', portOfRegistry: 'AUH', owners: OWNERS(), tonnage: { gross: 100, net: 50 }, evidence: EVIDENCE_PERMANENT, carvingNote: { compliedOn: '2026-01-01' } }, { name: 'X', status: 'ACTIVE', grt: 100 }, { onRegister: true }, 'AE', rule('PERMANENT'));
    expect(blocking(first).map((c) => c.check)).toContain('Ship is not already on the register');
    const closure = registrationChecks({ kind: 'DELETION', portOfRegistry: 'AUH', deletion: { reason: 'SOLD_FOREIGN', newFlag: 'Panama' }, encumbrances: [{ kind: 'MORTGAGE', holder: 'Bank', dischargedOn: null }], evidence: [] }, null, { onRegister: true, outstandingDues: 0 }, 'AE', rule('DELETION'));
    expect(blocking(closure).map((c) => c.check)).toEqual(expect.arrayContaining(['No subsisting mortgage or charge', 'Mandatory evidence on file']));
  });
  it('lets a permanent registration bridge from a provisional one', () => {
    const checks = registrationChecks({ kind: 'PERMANENT', portOfRegistry: 'AUH', owners: OWNERS(), tonnage: { gross: 100, net: 50 }, evidence: EVIDENCE_PERMANENT, carvingNote: { compliedOn: '2026-01-01', surveyor: 'S' } }, { name: 'X', status: 'ACTIVE', grt: 100 }, { onRegister: false, bridging: true }, 'AE', rule('PERMANENT'));
    expect(blocking(checks)).toHaveLength(0);
    expect(checks.map((c) => c.check)).toContain('Supersedes a provisional certificate');
  });
});

describe('ships — the risk model', () => {
  const weights = DEFAULT_RISK_WEIGHTS as Record<string, number>;
  const ship = (over: Record<string, unknown> = {}) => ({ id: 'v1', name: 'X', imo: '9700001', type: 'BULK', flag: 'AE', built: 2020, agent_code: 'GSS', ...over } as never);
  it('scores a young clean ship low and an old ship with expired papers and a detention high', () => {
    const clean = scoreVessel(ship(), [{ status: 'VALID' } as never], [], new Map(), weights, new Date('2026-06-01'));
    const bad = scoreVessel(ship({ built: 1998 }), [{ status: 'EXPIRED' } as never], [{ vessel_id: 'v1', result: 'DETAINED', detention: true, open_findings: 6, closed_at: new Date('2026-01-01') }], new Map(), weights, new Date('2026-06-01'));
    expect(clean.score).toBeLessThan(bad.score);
    expect(bad.band).toBe('HIGH');
    expect(bad.factors[0].points).toBeGreaterThan(0);
    expect(bad.factors.every((f) => f.evidence.length > 0)).toBe(true);
  });
  it('bands on the published thresholds and orders factors by weight carried', () => {
    expect([bandOf(0), bandOf(34), bandOf(35), bandOf(59), bandOf(60)]).toEqual(['LOW', 'LOW', 'MEDIUM', 'MEDIUM', 'HIGH']);
    const r = scoreVessel(ship({ built: 1990 }), [{ status: 'EXPIRED' } as never], [], new Map(), weights);
    expect(r.factors.map((f) => f.points)).toEqual([...r.factors.map((f) => f.points)].sort((a, b) => b - a));
  });
});

describe('ships — pure helpers', () => {
  it('bands ages the way the fleet dashboard draws them', () => {
    expect([ageBandOf(3), ageBandOf(8), ageBandOf(13), ageBandOf(19), ageBandOf(30)]).toEqual(['0-5', '6-10', '11-15', '16-20', '>20']);
  });
  it('rolls an old docking anchor forward so a ship shows the cycle she is in', () => {
    const events = surveyEvents({ built: 2009, last_dry_dock: null }, Date.UTC(2026, 5, 1));
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => new Date(e.due).getUTCFullYear() >= 2025)).toBe(true);
  });
  it('derives the voyage ledger and the trade lanes from sailed calls', () => {
    const { voyages, lanes } = voyagesOf([
      { id: 'c1', vcn: 'V1', prev_port: 'SGSIN', next_port: 'AEJEA', ata: new Date(0), atd: new Date(2 * D), berth_code: 'B1', terminal: 'T1', cargo_ops: [{ operation: 'LOAD', qty: 100, unit: 'TEU', cargoType: 'CONTAINERS' }] },
      { id: 'c2', vcn: 'V2', prev_port: 'SGSIN', next_port: 'NLRTM', ata: null, atd: null, berth_code: null, terminal: null, cargo_ops: [] },
    ] as never);
    expect(voyages[0].portDays).toBe(2);
    expect(voyages[0].cargo).toContain('Loaded');
    expect(lanes[0]).toEqual({ port: 'SGSIN', calls: 2 });
  });
});

describe('ships — the register', () => {
  it('lists, filters, searches, sorts and pages', async () => {
    const all = await g('/vessels?limit=200').expect(200);
    expect(all.body.meta.total).toBeGreaterThan(20);
    expect(all.body.data[0]).toHaveProperty('certificates');
    const bulk = await g('/vessels?type=BULK&limit=100').expect(200);
    expect(bulk.body.data.every((v: any) => v.type === 'BULK')).toBe(true);
    const search = await g(`/vessels?q=${encodeURIComponent(all.body.data[0].name.slice(0, 6))}`).expect(200);
    expect(search.body.data.length).toBeGreaterThan(0);
    const page = await g('/vessels?limit=5&page=2&sort=-grt').expect(200);
    expect(page.body.data).toHaveLength(5);
    expect(page.body.data[0].grt).toBeGreaterThanOrEqual(page.body.data[4].grt);
    const registered = await g('/vessels?registryState=REGISTERED&limit=100').expect(200);
    expect(registered.body.data.every((v: any) => v.registry.state === 'REGISTERED')).toBe(true);
    // the risk band is scored, not stored: the page must be a page of the filtered set, so the totals add up
    const low = await g('/vessels?riskBand=LOW&limit=200').expect(200);
    const high = await g('/vessels?riskBand=HIGH&limit=200').expect(200);
    const medium = await g('/vessels?riskBand=MEDIUM&limit=200').expect(200);
    expect(low.body.data.every((v: any) => v.riskBand === 'LOW')).toBe(true);
    expect(low.body.meta.total).toBe(low.body.data.length);
    const active = (await g('/vessels?status=ACTIVE&limit=200')).body.meta.total;
    expect(low.body.meta.total + medium.body.meta.total + high.body.meta.total).toBe(active);
    const firstPage = await g('/vessels?riskBand=LOW&limit=2&page=1&sort=name').expect(200);
    expect(firstPage.body.meta.total).toBe(low.body.meta.total);
    expect(firstPage.body.data).toHaveLength(2);
  });

  it('returns the full record the eight-tab screen needs', async () => {
    const list = await g('/vessels?registryState=REGISTERED&limit=1').expect(200);
    const id = list.body.data[0].id;
    const r = await g(`/vessels/${id}`).expect(200);
    const v = r.body.data;
    for (const k of ['certificates', 'recentCalls', 'recentInspections', 'recentIncidents', 'crewOnBoard', 'lastPosition', 'registry', 'engine']) expect(v).toHaveProperty(k);
    expect(v.registry.state).toBe('REGISTERED');
    expect(v.registry.officialNumber).toMatch(/^\d+$/);
    expect(v.certificates.every((c: any) => ['VALID', 'EXPIRING', 'EXPIRED'].includes(c.status))).toBe(true);
    const voyages = await g(`/vessels/${id}/voyages`).expect(200);
    expect(voyages.body.data).toHaveProperty('lanes');
    const movements = await g(`/vessels/${id}/movements`).expect(200);
    expect(movements.body.data).toHaveProperty('events');
    const card = await g(`/vessels/${id}/card`).expect(200);
    expect(card.body.data.kind).toBe('vessel');
    expect(card.body.data.link).toBe(`/vessels/${id}`);
  });

  it('serves the fleet dashboard and the survey planner', async () => {
    const d = (await g('/vessels/fleet-dashboard').expect(200)).body.data;
    expect(d.kpis.fleet).toBeGreaterThan(0);
    expect(d.certs.valid + d.certs.expiring + d.certs.expired).toBeGreaterThan(0);
    expect(d.ageBands.map((b: any) => b.band)).toEqual(['0-5', '6-10', '11-15', '16-20', '>20']);
    expect(d.certAlertVessels.length).toBeLessThanOrEqual(8);
    const p = (await g('/vessels/survey-planner').expect(200)).body.data;
    expect(p.horizonMonths).toBe(24);
    expect(p.lanes.length).toBeGreaterThan(0);
    expect(p.lanes[0].events.every((e: any) => ['OVERDUE', 'WINDOW_OPEN', 'PLANNED'].includes(e.status))).toBe(true);
  });

  it('serves the fleet certificate register with force state and its filters', async () => {
    const all = (await g('/vessels/certificates/all?limit=200').expect(200)).body;
    expect(all.meta.total).toBeGreaterThan(100);
    expect(all.data[0]).toMatchObject({ vesselId: expect.any(String), certType: expect.any(String) });
    const expired = (await g('/vessels/certificates/all?status=EXPIRED&limit=200').expect(200)).body;
    expect(expired.data.every((r: any) => r.status === 'EXPIRED')).toBe(true);
    // a certificate of registry is on the register through the ship's own entry rather than the instrument register
    const cor = all.data.find((r: any) => r.certType === 'Certificate of Registry' && r.onRegister);
    expect(cor?.inForce).toBe(true);
  });

  it('creates, updates and deletes a ship, and refuses a bad IMO, a duplicate and a ship with history', async () => {
    await clearOutbox();
    const created = await post('/vessels', { name: 'Test Barque', imo: '9812345', type: 'GEN', flag: 'United Arab Emirates', grt: 4200, loa: 96, agent: 'GSS' }, officer).expect(201);
    const id = created.body.data.id;
    expect(created.body.data.registry.state).toBe('UNREGISTERED');
    expect((await outbox(EVENTS.ships.vesselCreated)).length).toBe(1);
    expect((await outbox(EVENTS.readModel.upserted)).some((e) => e.data.kind === 'vessel' && e.data.entity.id === id)).toBe(true);
    await post('/vessels', { name: 'Bad', imo: '123', type: 'GEN', grt: 1 }, officer).expect(400);
    await post('/vessels', { name: 'Dupe', imo: '9812345', type: 'GEN', grt: 1 }, officer).expect(409);
    const updated = await put(`/vessels/${id}`, { grt: 4500, classSociety: 'DNV' }, officer).expect(200);
    expect(updated.body.data.grt).toBe(4500);
    const withHistory = await pool.query<{ id: string }>('SELECT vessel_id AS id FROM port_calls LIMIT 1');
    await del(`/vessels/${withHistory.rows[0].id}`, officer).expect(400);
    await del(`/vessels/${id}`, officer).expect(200);
    expect((await outbox(EVENTS.readModel.deleted)).some((e) => e.data.kind === 'vessel' && e.data.id === id)).toBe(true);
    await g(`/vessels/${id}`).expect(404);
  });

  it('reads a cleared form field as no value rather than as zero or a blank date', async () => {
    const created = await post('/vessels', { name: 'Blank Fields', imo: '9812399', type: 'GEN', grt: '', built: '', dwt: '', loa: '', lastDryDock: '', nextDryDock: '' }, officer).expect(201);
    expect(created.body.data).toMatchObject({ grt: 0, built: null, dwt: null, loa: null, lastDryDock: null, nextDryDock: null });
    const id = created.body.data.id;
    const dated = await put(`/vessels/${id}`, { built: 2019, lastDryDock: '2024-03-01' }, officer).expect(200);
    expect(dated.body.data.built).toBe(2019);
    expect(dated.body.data.lastDryDock).toContain('2024-03-01');
    const cleared = await put(`/vessels/${id}`, { built: '', lastDryDock: '' }, officer).expect(200);
    expect(cleared.body.data).toMatchObject({ built: null, lastDryDock: null });
    const cert = await post(`/vessels/${id}/certificates`, { certType: 'Load Line Certificate', issueDate: '', expiryDate: new Date(Date.now() + 400 * D).toISOString() }, officer).expect(201);
    expect(cert.body.data.certificates[0]).toMatchObject({ issueDate: null, status: 'VALID' });
    await del(`/vessels/${id}`, officer).expect(200);
  });

  it('refuses without a session and without the permission', async () => {
    await request(server as never).get('/vessels').expect(401);
    await request(server as never).get('/vessels').set('authorization', 'Bearer nonsense').expect(401);
    await g('/vessels', nobody).expect(403);
    await post('/vessels', { name: 'X', imo: '9812346', type: 'GEN', grt: 1 }, clerk).expect(403);
    await g('/risk/scores', clerk).expect(403);
    await put('/risk/weights', { age: 10 }, officer).expect(403);
  });
});

describe('ships — certificates on the ship', () => {
  let vesselId: string;
  beforeAll(async () => { vesselId = (await g('/vessels?limit=1&registryState=REGISTERED')).body.data[0].id; });

  it('adds, edits and deletes a certificate and derives its expiry state', async () => {
    await clearOutbox();
    const soon = new Date(Date.now() + 10 * D).toISOString();
    const added = await post(`/vessels/${vesselId}/certificates`, { certType: 'Bunker Delivery Note Audit', number: 'BDN-1', issuer: 'Class', expiryDate: soon }, officer).expect(201);
    const cert = added.body.data.certificates.find((c: any) => c.certType === 'Bunker Delivery Note Audit');
    expect(cert.status).toBe('EXPIRING');
    expect(cert.readOnly).toBe(false);
    expect((await outbox(EVENTS.ships.certIssued)).length).toBe(1);
    const past = new Date(Date.now() - 5 * D).toISOString();
    const edited = await put(`/vessels/${vesselId}/certificates/${cert.id}`, { expiryDate: past }, officer).expect(200);
    expect(edited.body.data.certificates.find((c: any) => c.id === cert.id).status).toBe('EXPIRED');
    await del(`/vessels/${vesselId}/certificates/${cert.id}`, officer).expect(200);
    expect((await outbox(EVENTS.ships.certDeleted)).length).toBe(1);
    await put(`/vessels/${vesselId}/certificates/${cert.id}`, { number: 'x' }, officer).expect(404);
  });

  it('keeps an instrument-issued certificate read-only on the ship', async () => {
    const inst = await pool.query<{ id: string; cert_type: string; vessel_id: string }>('SELECT id, cert_type, vessel_id FROM vessel_certificates WHERE instrument_id IS NOT NULL LIMIT 1');
    const row = inst.rows[0];
    expect(row).toBeTruthy();
    await put(`/vessels/${row.vessel_id}/certificates/${row.id}`, { number: 'TAMPERED' }, officer).expect(409);
    await del(`/vessels/${row.vessel_id}/certificates/${row.id}`, officer).expect(409);
    await post(`/vessels/${row.vessel_id}/certificates`, { certType: row.cert_type, expiryDate: new Date().toISOString() }, officer).expect(409);
    const back = await g(`/vessels/${row.vessel_id}`).expect(200);
    expect(back.body.data.certificates.find((c: any) => c.id === row.id)).toMatchObject({ readOnly: true, onRegister: true });
  });
});

describe('ships — the registration lifecycle', () => {
  let vessel: { id: string; name: string; imo: string; grt: number };
  let file: any;

  beforeAll(async () => { vessel = await unregisteredVessel(); });

  it('serves the jurisdiction registry reference', async () => {
    const r = (await g('/registrations/reference', clerk).expect(200)).body.data;
    expect(r.defaultPort).toBe('AUH');
    expect(r.shareRules.denominator).toBe(24);
    // the variants and their SLAs, fees and evidence are the registrationKind master's, in its order
    expect(r.kinds.map((k: any) => k.kind)).toEqual(['PROVISIONAL', 'PERMANENT', 'BAREBOAT_IN', 'BAREBOAT_OUT', 'UNDER_CONSTRUCTION', 'TEMPORARY_PASS', 'AMENDMENT', 'RE_REGISTRATION', 'DELETION']);
    expect(r.kinds.find((k: any) => k.kind === 'BAREBOAT_IN')).toMatchObject({ family: 'FIRST', slaDays: 21, fee: 3000, registryState: 'BAREBOAT_IN', series: 'BCR' });
    expect(r.registryStates).toContain('BAREBOAT_OUT');
    expect(r.kinds[0].evidence.length).toBeGreaterThan(0);
    expect(r.portsOfRegistry.find((p: any) => p.default)).toMatchObject({ code: 'AUH' });
  });

  it('lists the register with its filters and marks a file past its SLA', async () => {
    const list = (await g('/registrations?limit=100', clerk).expect(200)).body;
    expect(list.meta.total).toBeGreaterThan(10);
    expect(list.data[0]).toHaveProperty('slaBreached');
    const granted = (await g('/registrations?status=GRANTED&limit=100', clerk).expect(200)).body;
    expect(granted.data.every((r: any) => r.status === 'GRANTED')).toBe(true);
    const deletions = (await g('/registrations?kind=DELETION', clerk).expect(200)).body;
    expect(deletions.data.every((r: any) => r.kind === 'DELETION')).toBe(true);
    const q = (await g(`/registrations?q=${encodeURIComponent(list.data[0].applicationNo)}`, clerk).expect(200)).body;
    expect(q.data[0].applicationNo).toBe(list.data[0].applicationNo);
  });

  it('lodges a permanent registration and refuses a second open file for the same journey', async () => {
    await clearOutbox();
    const r = await post('/registrations', {
      kind: 'PERMANENT', vesselId: vessel.id, owners: OWNERS(), evidence: EVIDENCE_PERMANENT,
      tonnage: { gross: vessel.grt, net: Math.round(vessel.grt * 0.52), measuredBy: 'DNV', certificateNo: `TM/${vessel.imo}` },
    }, registrar).expect(201);
    file = r.body.data;
    expect(file.status).toBe('SUBMITTED');
    expect(file.applicationNo).toMatch(/^REG-\d{4}-\d{5}$/);
    expect(file.fee).toMatchObject({ amount: 5000, currency: 'AED', paid: false });
    expect(file.dueAt).toBeTruthy();
    expect((await outbox(EVENTS.ships.registrationLodged)).length).toBe(1);
    expect((await outbox(EVENTS.readModel.upserted)).some((e) => e.data.kind === 'registration')).toBe(true);
    await post('/registrations', { kind: 'PERMANENT', vesselId: vessel.id, owners: OWNERS() }, registrar).expect(409);
    await post('/registrations', { kind: 'AMENDMENT', vesselId: vessel.id, amendment: { types: ['NAME'] } }, registrar).expect(409);
  });

  it('refuses a move the transition table does not allow, and a refusal without a reason', async () => {
    await post(`/registrations/${file.id}/transition`, { to: 'APPROVED' }, registrar).expect(409);
    await post(`/registrations/${file.id}/transition`, { to: 'REJECTED' }, registrar).expect(400);
    await post(`/registrations/${file.id}/transition`, { to: 'GRANTED' }, registrar).expect(400);
  });

  it('allocates the official number with the carving note, not with the certificate', async () => {
    await post(`/registrations/${file.id}/transition`, { to: 'UNDER_SCRUTINY' }, registrar).expect(201);
    const before = (await g(`/registrations/${file.id}`, registrar)).body.data;
    expect(before.officialNumber).toBe('');
    expect(before.assignedTo).toBe('Registrar of Ships');
    const carved = (await post(`/registrations/${file.id}/transition`, { to: 'CARVING_NOTE_ISSUED' }, registrar).expect(201)).body.data;
    expect(carved.officialNumber).toMatch(/^\d+$/);
    expect(Number(carved.officialNumber)).toBeGreaterThanOrEqual(700001);
    expect(carved.carvingNote.number).toMatch(/^AUH\/CMN\/\d{4}\/\d+$/);
    expect(carved.certificateNo).toBe('');
    file = carved;
  });

  it('will not close the survey before the surveyor has reported', async () => {
    await post(`/registrations/${file.id}/transition`, { to: 'SURVEY_COMPLETE' }, registrar).expect(409);
    const done = (await post(`/registrations/${file.id}/carving-compliance`, { surveyor: 'K. Rahman, Ship Surveyor' }, registrar).expect(201)).body.data;
    expect(done.carvingNote.compliedOn).toBeTruthy();
    await post(`/registrations/${file.id}/transition`, { to: 'SURVEY_COMPLETE' }, registrar).expect(201);
  });

  it('runs the statutory checks live and refuses approval while a mandatory document is missing', async () => {
    // drop a mandatory document to prove the gate is live rather than recorded
    const kept = file.evidence ?? (await g(`/registrations/${file.id}`, registrar)).body.data.evidence;
    await pool.query(`UPDATE registrations SET evidence = $2 WHERE id = $1`, [file.id, JSON.stringify(kept.filter((e: any) => e.key !== 'SURVEY_CERTIFICATE'))]);
    const checks = (await g(`/registrations/${file.id}/checks`, registrar).expect(200)).body.data;
    expect(checks.blocked.map((c: any) => c.check)).toContain('Mandatory evidence on file');
    await post(`/registrations/${file.id}/transition`, { to: 'APPROVED' }, registrar).expect(409);
    await post(`/registrations/${file.id}/transition`, { to: 'APPROVED', override: true }, registrar).expect(400);
    await pool.query(`UPDATE registrations SET evidence = $2 WHERE id = $1`, [file.id, JSON.stringify(kept)]);
    const clean = (await g(`/registrations/${file.id}/checks`, registrar).expect(200)).body.data;
    expect(clean.blocked).toHaveLength(0);
  });

  it('verifies a lodged document and records who checked it', async () => {
    const doc = (await g(`/registrations/${file.id}`, registrar)).body.data.evidence[0];
    expect(doc.verified).toBe(false);
    const after = (await put(`/registrations/${file.id}/evidence/${doc.id}`, { verified: true }, registrar).expect(200)).body.data;
    const seen = after.evidence.find((e: any) => e.id === doc.id);
    expect(seen).toMatchObject({ verified: true, verifiedBy: 'Registrar of Ships' });
    await put(`/registrations/${file.id}/evidence/does-not-exist`, { verified: true }, registrar).expect(404);
  });

  it('grants the certificate, writes the register and publishes the registration', async () => {
    await post(`/registrations/${file.id}/transition`, { to: 'APPROVED' }, registrar).expect(201);
    await post(`/registrations/${file.id}/grant`, {}, clerk).expect(403);
    await clearOutbox();
    const out = (await post(`/registrations/${file.id}/grant`, {}, registrar).expect(201)).body.data;
    expect(out.registration.status).toBe('GRANTED');
    expect(out.registration.certificateNo).toMatch(/^AUH\/CR\/\d{4}\/\d+$/);
    expect(out.vessel.registry).toMatchObject({ state: 'REGISTERED', officialNumber: out.registration.officialNumber, portOfRegistry: 'AUH' });
    const registered = await outbox(EVENTS.ships.vesselRegistered);
    expect(registered).toHaveLength(1);
    expect(registered[0].data.certificateNo).toBe(out.registration.certificateNo);
    expect((await outbox(EVENTS.ships.registrationGranted)).length).toBe(1);
    const snapshots = await outbox(EVENTS.readModel.upserted);
    expect(snapshots.some((e) => e.data.kind === 'vessel' && e.data.entity.registry.state === 'REGISTERED')).toBe(true);
    expect(snapshots.some((e) => e.data.kind === 'registration' && e.data.entity.status === 'GRANTED')).toBe(true);
    const audits = await outbox(EVENTS.audit.recorded);
    expect(audits.some((e) => e.data.action === 'GRANT' && e.data.entity === 'VesselRegistration')).toBe(true);
    await post(`/registrations/${file.id}/grant`, {}, registrar).expect(409);
  });

  it('assembles the transcript from the granted applications', async () => {
    const t = (await g(`/vessels/${vessel.id}/transcript`, registrar).expect(200)).body.data;
    expect(t.registry.state).toBe('REGISTERED');
    expect(t.registrar).toBe('Registrar of Ships');
    expect(t.portOfRegistry).toMatchObject({ code: 'AUH', name: 'Abu Dhabi' });
    expect(t.shareLedger.balanced).toBe(true);
    expect(t.entries.some((e: any) => e.kind === 'PERMANENT')).toBe(true);
    const rows = (await g(`/vessels/${vessel.id}/registrations`, registrar).expect(200)).body.data;
    expect(rows).toHaveLength(1);
  });

  it('amends the entry, reissues the certificate and carries the alteration onto the ship', async () => {
    const lodged = (await post('/registrations', {
      kind: 'AMENDMENT', vesselId: vessel.id, amendment: { types: ['NAME'], after: { name: `${vessel.name} II` }, approvalReference: 'MSA/NAME/2026/0441' },
      evidence: [{ key: 'AMENDMENT_APPLICATION', reference: 'AMD/1' }, { key: 'SUPPORTING_EVIDENCE', reference: 'BR/1' }, { key: 'NAME_APPROVAL', reference: 'MSA/NAME/2026/0441' }],
    }, registrar).expect(201)).body.data;
    await post(`/registrations/${lodged.id}/transition`, { to: 'UNDER_SCRUTINY' }, registrar).expect(201);
    await post(`/registrations/${lodged.id}/transition`, { to: 'CARVING_NOTE_ISSUED' }, registrar).expect(409);   // only a first registration is carved
    await post(`/registrations/${lodged.id}/transition`, { to: 'APPROVED' }, registrar).expect(201);
    const out = (await post(`/registrations/${lodged.id}/grant`, {}, registrar).expect(201)).body.data;
    expect(out.vessel.name).toBe(`${vessel.name} II`);
    expect(out.registration.amendment.before.name).toBe(vessel.name);
    const v = (await g(`/vessels/${vessel.id}`)).body.data;
    expect(v.name).toBe(`${vessel.name} II`);
    expect(v.registry.certificateNo).toBe(out.registration.certificateNo);
  });

  it('closes the register only once the charges are discharged, and takes the ship off it', async () => {
    const lodged = (await post('/registrations', {
      kind: 'DELETION', vesselId: vessel.id, deletion: { reason: 'SOLD_FOREIGN', newFlag: 'Panama' },
      evidence: [{ key: 'CLOSURE_APPLICATION', reference: 'CLS/1' }, { key: 'DUES_CLEARANCE', reference: 'DUE/1' }, { key: 'TITLE_DOCUMENT', reference: 'BOS/1' }],
      encumbrances: [{ kind: 'MORTGAGE', holder: 'Gulf Coast Maritime Finance PJSC (sample)', amount: 12_000_000, reference: 'MTG/AUH/2024/9' }],
    }, registrar).expect(201)).body.data;
    await post(`/registrations/${lodged.id}/transition`, { to: 'UNDER_SCRUTINY' }, registrar).expect(201);
    // nothing leaves the register owing money either, so the file is given an unpaid invoice to answer for
    await pool.query(`INSERT INTO invoices(id, number, vessel_id, status, total, currency) VALUES ('test-inv-1','MAR/INV/2026/9999',$1,'ISSUED',48250,'AED') ON CONFLICT (id) DO UPDATE SET status = 'ISSUED'`, [vessel.id]);
    const blocked = (await g(`/registrations/${lodged.id}/checks`, registrar).expect(200)).body.data;
    expect(blocked.blocked.map((c: any) => c.check)).toEqual(expect.arrayContaining(['No subsisting mortgage or charge', 'Mandatory evidence on file', 'Port dues and charges settled']));
    expect(blocked.blocked.find((c: any) => c.check === 'Port dues and charges settled').detail).toContain('AED');
    await post(`/registrations/${lodged.id}/transition`, { to: 'APPROVED' }, registrar).expect(409);
    const charge = lodged.encumbrances[0];
    const discharged = (await put(`/registrations/${lodged.id}/encumbrances/${charge.id}`, {}, registrar).expect(200)).body.data;
    expect(discharged.encumbrances[0].dischargedOn).toBeTruthy();
    await put(`/registrations/${lodged.id}/encumbrances/${charge.id}`, {}, registrar).expect(409);
    await post(`/registrations/${lodged.id}/evidence`, { key: 'MORTGAGE_DISCHARGE', reference: 'DIS/1' }, registrar).expect(201);
    const stillOwing = (await g(`/registrations/${lodged.id}/checks`, registrar).expect(200)).body.data;
    expect(stillOwing.blocked.map((c: any) => c.check)).toEqual(['Port dues and charges settled']);
    await pool.query(`UPDATE invoices SET status = 'PAID' WHERE vessel_id = $1 AND status = 'ISSUED'`, [vessel.id]);
    await post(`/registrations/${lodged.id}/transition`, { to: 'APPROVED' }, registrar).expect(201);
    await clearOutbox();
    const out = (await post(`/registrations/${lodged.id}/grant`, {}, registrar).expect(201)).body.data;
    expect(out.registration.deletion.certificateNo).toMatch(/^AUH\/DEL\/\d{4}\/\d+$/);
    expect(out.vessel.registry).toMatchObject({ state: 'CLOSED', closureReason: 'SOLD_FOREIGN' });
    expect((await outbox(EVENTS.ships.registryClosed)).length).toBe(1);
    const v = (await g(`/vessels/${vessel.id}`)).body.data;
    expect(v.status).toBe('INACTIVE');
    expect(v.flag).toBe('Panama');
  });

  it('refuses an amendment or a closure for a ship that is not on the register', async () => {
    const off = await unregisteredVessel();
    await post('/registrations', { kind: 'DELETION', vesselId: off.id, deletion: { reason: 'BROKEN_UP' } }, registrar).expect(409);
    await post('/registrations', { kind: 'AMENDMENT', vesselId: off.id, amendment: { types: ['MANAGER'] } }, registrar).expect(409);
    await post('/registrations', { kind: 'PERMANENT', vesselId: 'not-a-ship' }, registrar).expect(404);
  });

  it('serves the registry dashboard', async () => {
    const d = (await g('/registrations/dashboard', registrar).expect(200)).body.data;
    expect(d.total).toBeGreaterThan(10);
    expect(d.registered).toBeGreaterThan(0);
    expect(d.byPort.some((p: any) => p.code === 'AUH' && p.name === 'Abu Dhabi')).toBe(true);
    expect(d.slaCompliance).toBeGreaterThanOrEqual(0);
  });
});

describe('ships — risk endpoints', () => {
  it('scores the active fleet with its factor decomposition and the weights in force', async () => {
    const r = await g('/risk/scores', officer).expect(200);
    expect(r.body.meta.weights).toMatchObject(DEFAULT_RISK_WEIGHTS);
    expect(r.body.meta.computedAt).toBeTruthy();
    const rows = r.body.data;
    expect(rows.length).toBeGreaterThan(10);
    expect(rows[0].score).toBeGreaterThanOrEqual(rows[rows.length - 1].score);
    expect(rows[0].factors.map((f: any) => f.key).sort()).toEqual(Object.keys(DEFAULT_RISK_WEIGHTS).sort());
  });
  it('orders the boarding-target list by risk over the calls in port or inbound', async () => {
    const rows = (await g('/risk/targeting', officer).expect(200)).body.data;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r: any) => ['ANNOUNCED', 'CONFIRMED', 'AT_ANCHORAGE', 'BERTHED'].includes(r.status))).toBe(true);
    expect(rows[0].risk.score).toBeGreaterThanOrEqual(rows[rows.length - 1].risk.score);
    expect(rows[0]).toHaveProperty('vcn');
  });
  it('records a weights change and moves the scores with it', async () => {
    await clearOutbox();
    const before = (await g('/risk/scores', officer)).body.data.find((r: any) => r.score > 0);
    const after = (await put('/risk/weights', { age: 50 }, admin).expect(200)).body.data;
    expect(after.age).toBe(50);
    const now = (await g('/risk/scores', officer)).body.data.find((r: any) => r.vesselId === before.vesselId);
    expect(now.factors.find((f: any) => f.key === 'age').max).toBe(50);
    expect((await outbox(EVENTS.ships.riskWeightsChanged)).length).toBe(1);
    expect((await outbox(EVENTS.audit.recorded)).some((e) => e.data.entityId === 'riskWeights')).toBe(true);
    await put('/risk/weights', { age: 500 }, admin).expect(400);
    await put('/risk/weights', {}, admin).expect(400);
    await put('/risk/weights', { age: DEFAULT_RISK_WEIGHTS.age }, admin).expect(200);
  });
});

describe('ships — the consumer', () => {
  const deps = () => ({ env, audit });
  const event = (type: string, data: unknown) => makeEvent({ type, source: 'test', data });

  it('projects a port call, an inspection and a crew member onto the local snapshots', async () => {
    const v = (await g('/vessels?limit=1')).body.data[0];
    const client = await pool.connect();
    try {
      await applyEvent(client, deps(), event(EVENTS.readModel.upserted, { kind: 'portCall', entity: { id: 'test-call-1', vcn: 'MAR-2026-99999', vesselId: v.id, status: 'BERTHED', eta: new Date().toISOString(), berthCode: 'CT1-1', terminal: 'Container Terminal', statusHistory: [{ from: '', to: 'ANNOUNCED', at: new Date().toISOString(), note: 'Announced' }] } }));
      await applyEvent(client, deps(), event(EVENTS.readModel.upserted, { kind: 'inspection', entity: { id: 'test-insp-1', number: 'INS-2026-9999', vesselId: v.id, type: 'PSC', status: 'CLOSED', result: 'DEFICIENCIES', detention: false, findings: [{ status: 'OPEN' }, { status: 'CLOSED' }], plannedAt: new Date().toISOString(), closedAt: new Date().toISOString() } }));
      await applyEvent(client, deps(), event(EVENTS.readModel.upserted, { kind: 'seafarer', entity: { id: 'test-crew-1', name: 'A. Mariner', rank: 'Master', cdcNo: 'AUH-1', nationality: 'India', currentVesselId: v.id, certAlerts: 2 } }));
    } finally { client.release(); }
    const record = (await g(`/vessels/${v.id}`)).body.data;
    expect(record.recentCalls.some((c: any) => c.vcn === 'MAR-2026-99999')).toBe(true);
    expect(record.recentInspections.some((i: any) => i.number === 'INS-2026-9999' && i.openFindings === 1)).toBe(true);
    expect(record.crewOnBoard.some((s: any) => s.name === 'A. Mariner' && s.certAlerts === 2)).toBe(true);
  });

  it('merges a statutory certificate from the instrument register, keeps it read-only and republishes the ship', async () => {
    const v = (await g('/vessels?limit=1')).body.data[0];
    await clearOutbox();
    const client = await pool.connect();
    try {
      await applyEvent(client, deps(), event(EVENTS.readModel.upserted, {
        kind: 'vesselCertificate',
        entity: { id: '11111111-1111-4111-a111-111111111111', vesselId: v.id, vesselName: v.name, certType: 'Polar Ship Certificate', number: 'PSC-2026-1', issuer: 'Flag administration', issueDate: new Date().toISOString(), expiryDate: new Date(Date.now() + 400 * D).toISOString(), instrumentId: 'inst-1', onRegister: true, inForce: true, forceReason: 'In force', signed: true },
      }));
    } finally { client.release(); }
    const record = (await g(`/vessels/${v.id}`)).body.data;
    const merged = record.certificates.find((c: any) => c.certType === 'Polar Ship Certificate');
    expect(merged).toMatchObject({ readOnly: true, onRegister: true, signed: true, inForce: true, status: 'VALID' });
    await put(`/vessels/${v.id}/certificates/${merged.id}`, { number: 'X' }, officer).expect(409);
    expect((await outbox(EVENTS.readModel.upserted)).some((e) => e.data.kind === 'vessel' && e.data.entity.id === v.id)).toBe(true);
    expect((await outbox(EVENTS.audit.recorded)).some((e) => e.data.action === 'CERT_MIRRORED')).toBe(true);
  });

  it('ignores its own certificate snapshots coming back through the bus', async () => {
    const v = (await g('/vessels?limit=1')).body.data[0];
    const before = (await pool.query('SELECT count(*) AS n FROM vessel_certificates WHERE vessel_id = $1', [v.id])).rows[0].n;
    const client = await pool.connect();
    try {
      await applyEvent(client, deps(), makeEvent({ type: EVENTS.readModel.upserted, source: env.SERVICE_NAME, data: { kind: 'vesselCertificate', entity: { id: '22222222-2222-4222-a222-222222222222', vesselId: v.id, certType: 'Echoed', expiryDate: new Date().toISOString(), instrumentId: 'inst-2' } } }));
    } finally { client.release(); }
    const after = (await pool.query('SELECT count(*) AS n FROM vessel_certificates WHERE vessel_id = $1', [v.id])).rows[0].n;
    expect(after).toBe(before);
  });
});

/* ==================================================== tenancy on the ship register === */

describe('ships — tenancy', () => {
  it('takes the fleet from the ship\'s appointed agent, and everything hanging off her follows', async () => {
    const owned = await pool.query<{ n: string; owned: string }>(
      "SELECT count(*)::text AS n, count(*) FILTER (WHERE scope_company <> '')::text AS owned FROM vessels WHERE agent_code <> ''");
    expect(Number(owned.rows[0].owned)).toBe(Number(owned.rows[0].n));
    for (const table of ['registrations', 'vessel_certificates']) {
      const drift = await pool.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM ${table} t JOIN vessels v ON v.id = t.vessel_id WHERE t.scope_company <> v.scope_company`);
      expect(Number(drift.rows[0].n)).toBe(0);
    }
    // reassigning a ship moves her papers with her, in the database rather than in each path that does it
    const v = (await pool.query<{ id: string; agent_code: string }>("SELECT id, agent_code FROM vessels WHERE agent_code <> '' LIMIT 1")).rows[0];
    try {
      await pool.query("UPDATE vessels SET agent_code = 'ZZZ' WHERE id = $1", [v.id]);
      const moved = await pool.query<{ n: string }>(
        "SELECT count(*)::text AS n FROM vessel_certificates WHERE vessel_id = $1 AND scope_company <> 'ZZZ'", [v.id]);
      expect(Number(moved.rows[0].n)).toBe(0);
    } finally { await pool.query('UPDATE vessels SET agent_code = $2 WHERE id = $1', [v.id, v.agent_code]); }
  });

  it('shows an agent the ships they act for, and answers "not found" for the rest', async () => {
    const mine = await g('/vessels?limit=500', agentgss);
    expect(mine.status).toBe(200);
    expect(mine.body.meta.total).toBeGreaterThan(0);
    expect(mine.body.data.every((v: { agentCode: string }) => v.agentCode === 'GSS')).toBe(true);
    const all = await g('/vessels?limit=500', admin);
    expect(all.body.meta.total).toBeGreaterThan(mine.body.meta.total);

    const other = all.body.data.find((v: { agentCode: string }) => v.agentCode && v.agentCode !== 'GSS');
    expect((await g(`/vessels/${other.id}`, agentgss)).status).toBe(404);
    expect((await g(`/vessels/${other.imo}`, agentgss)).status).toBe(404);
    expect((await g(`/vessels/${other.id}`, admin)).status).toBe(200);
    expect((await g(`/vessels/${mine.body.data[0].id}`, agentgss)).status).toBe(200);
  });

  it('gives an agent a dashboard of their own fleet, not the register\'s', async () => {
    const mine = await g('/vessels/fleet-dashboard', agentgss);
    const all = await g('/vessels/fleet-dashboard', admin);
    expect(mine.status).toBe(200);
    const size = (d: { kpis: { fleet: number; inactive: number } }) => d.kpis.fleet + d.kpis.inactive;
    expect(size(mine.body.data)).toBeLessThan(size(all.body.data));
    expect(size(mine.body.data)).toBe((await g('/vessels?limit=1', agentgss)).body.meta.total);
  });

  it('closes the risk register to an operator: it is how the administration ranks who it distrusts', async () => {
    expect((await g('/risk/scores', admin)).body.meta.total).toBeGreaterThan(0);
    expect((await g('/risk/scores', agentgss)).body.data).toHaveLength(0);
    expect((await g('/risk/targeting', agentgss)).body.data).toHaveLength(0);
    expect((await g('/risk/weights', agentgss)).status).toBe(404);
    expect((await g('/risk/weights', admin)).status).toBe(200);
  });

  it('leaves a national officer reading the whole register, with no clause added at all', async () => {
    expect((await g('/vessels?limit=1', officer)).body.meta.total).toBe((await g('/vessels?limit=1', admin)).body.meta.total);
  });
});

describe('ships — registration variants, the ledger and the master record', () => {
  const day = (n: number) => new Date(Date.now() + n * D).toISOString();
  const move = (id: string, to: string, extra: Record<string, unknown> = {}) => post(`/registrations/${id}/transition`, { to, ...extra }, registrar);
  const approveAndGrant = async (id: string) => {
    expect((await move(id, 'UNDER_SCRUTINY')).status).toBe(201);
    const approved = await move(id, 'APPROVED'); expect(approved.status, JSON.stringify(approved.body)).toBe(201);
    const granted = await post(`/registrations/${id}/grant`, {}, registrar); expect(granted.status, JSON.stringify(granted.body)).toBe(201);
    return granted.body.data;
  };
  const ev = (...keys: string[]) => keys.map((key) => ({ key, label: key, reference: `${key}/1` }));
  async function registeredVessel(offset = 0) {
    const r = await pool.query<{ id: string; name: string; official_number: string; manager: string }>(
      `SELECT v.id, v.name, v.official_number, v.manager FROM vessels v WHERE v.registry_state = 'REGISTERED' AND NOT v.real AND v.status = 'ACTIVE'
         AND NOT EXISTS (SELECT 1 FROM registrations r WHERE r.vessel_id = v.id AND NOT (r.status = ANY($1)))
         AND NOT EXISTS (SELECT 1 FROM registry_encumbrances e WHERE e.vessel_id = v.id AND e.discharged_on IS NULL)
       ORDER BY v.name OFFSET $2 LIMIT 1`, [['GRANTED', 'REJECTED', 'WITHDRAWN'], offset]);
    // nothing leaves the register owing money: the ship's dues are settled so the variant under test is what decides
    if (r.rows[0]) await pool.query("UPDATE invoices SET status = 'PAID' WHERE vessel_id = $1 AND status = 'ISSUED'", [r.rows[0].id]);
    return r.rows[0];
  }

  it('offers the variants and transaction types the masters declare, and refuses codes they do not', async () => {
    const kinds = (await g('/registry/kinds', clerk).expect(200)).body.data; expect(kinds).toHaveLength(9); expect(kinds.map((k: any) => k.family)).toEqual(expect.arrayContaining(['FIRST', 'ALTER', 'OUT', 'CLOSE', 'DOCUMENT']));
    const types = (await g('/registry/transaction-types', clerk).expect(200)).body.data;
    expect(types.find((t: any) => t.code === 'MORTGAGE_REGISTRATION').direct).toBe(true); expect(types.find((t: any) => t.code === 'REGISTRATION').direct).toBe(false);
    const v = await unregisteredVessel();
    expect((await post('/registrations', { kind: 'MOON_LAUNCH', vesselId: v.id }, registrar)).body.message).toMatch(/MOON_LAUNCH.*registrationKind/);
    const reg = await registeredVessel();
    expect((await post('/registrations', { kind: 'AMENDMENT', vesselId: reg.id, amendment: { types: ['PAINT_COLOUR'] } }, registrar)).body.message).toMatch(/PAINT_COLOUR.*amendmentType/);
    expect((await post('/registrations', { kind: 'DELETION', vesselId: reg.id, deletion: { reason: 'BORED' } }, registrar)).body.message).toMatch(/BORED.*deletionReason/);
  });

  it('seeds the ledger from the grants the world records, one transaction per grant and one per charge', async () => {
    const ledger = (await g('/registry/transactions?limit=200', clerk).expect(200)).body;
    expect(ledger.meta.total).toBeGreaterThan(5);
    expect(ledger.data.every((t: any) => /^RTX-\d{4}-\d{5}$/.test(t.number))).toBe(true);
    expect(ledger.data.map((t: any) => t.type)).toEqual(expect.arrayContaining(['REGISTRATION', 'CHANGE_OF_NAME', 'TRANSFER_OF_OWNERSHIP']));
    const mortgaged = (await pool.query("SELECT vessel_id FROM registry_encumbrances WHERE discharged_on IS NULL LIMIT 1")).rows[0];
    expect(mortgaged).toBeTruthy();
    const record = (await g(`/vessels/${mortgaged.vessel_id}/registry`, clerk).expect(200)).body.data;
    expect(record.encumbrances.length).toBeGreaterThan(0); expect(record.transactions.some((t: any) => t.type === 'MORTGAGE_REGISTRATION')).toBe(true);
  });

  it('registers a bareboat charter in, held by its charterer for the charter, and issues a temporary pass against it', async () => {
    const v = await unregisteredVessel();
    const particulars = { charterer: 'Falaj Bareboat Charterers LLC (sample)', chartererKind: 'BODY_CORPORATE', chartererRegistrationNo: 'CN-2244001 (sample)', registry: 'Registry of Panama', charterEnds: day(400) };
    const applied = await post('/registrations', { kind: 'BAREBOAT_IN', vesselId: v.id, portOfRegistry: 'AUH', particulars, evidence: ev('BAREBOAT_CHARTER_PARTY', 'UNDERLYING_REGISTRY_CONSENT', 'UNDERLYING_REGISTRY_CERTIFICATE', 'INSURANCE_CERTIFICATE') }, registrar);
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const id = applied.body.data.id;
    expect(applied.body.data).toMatchObject({ kind: 'BAREBOAT_IN', particulars: { registry: 'Registry of Panama' }, fee: { amount: 3000 } });
    const detail = (await g(`/registrations/${id}`, clerk)).body.data;
    expect(detail.rule).toMatchObject({ family: 'FIRST', registryState: 'BAREBOAT_IN', carving: false }); expect(detail.requiredEvidence.map((e: any) => e.key)).not.toContain('MORTGAGEE_CONSENT');
    const checks = (await g(`/registrations/${id}/checks`, clerk)).body.data;
    expect(checks.checks.map((c: any) => c.check)).toEqual(expect.arrayContaining(['Bareboat charterer qualifies to hold a ship of United Arab Emirates', 'Underlying registry named', 'Charter party ends after today']));
    expect(checks.blocked).toHaveLength(0);
    expect((await move(id, 'CARVING_NOTE_ISSUED')).status).toBe(409); // not a carved variant
    await clearOutbox();
    const granted = await approveAndGrant(id);
    expect(granted.vessel.registry).toMatchObject({ state: 'BAREBOAT_IN' }); expect(granted.registration.certificateNo).toMatch(/\/BCR\//);
    expect(Math.round((new Date(granted.registration.certificateExpiresOn).getTime() - new Date(particulars.charterEnds).getTime()) / D)).toBe(0);
    expect(granted.transactions).toHaveLength(1);
    expect((await outbox(EVENTS.ships.registryTransaction)).at(-1)?.data).toMatchObject({ type: 'BAREBOAT_IN', vesselId: v.id });
    const record = (await g(`/vessels/${v.id}/registry`, clerk).expect(200)).body.data;
    expect(record).toMatchObject({ onRegister: true, currentEntry: { kind: 'BAREBOAT_IN' } }); expect(record.currentEntry.particulars.charterer).toBe(particulars.charterer); expect(record.transactions[0].type).toBe('BAREBOAT_IN');
    // a temporary pass is a document against the entry: the standing does not move, the pass is on the ledger
    const tooLong = await post('/registrations', { kind: 'TEMPORARY_PASS', vesselId: v.id, particulars: { voyageFrom: 'Abu Dhabi', voyageTo: 'Fujairah', validTo: day(90) }, evidence: ev('PASS_APPLICATION', 'INSURANCE_CERTIFICATE', 'SEAWORTHINESS_CERTIFICATE') }, registrar);
    expect(tooLong.status).toBe(201);
    expect((await g(`/registrations/${tooLong.body.data.id}/checks`, clerk)).body.data.blocked.map((c: any) => c.check)).toContain('Pass validity within the permitted term');
    expect((await move(tooLong.body.data.id, 'WITHDRAWN')).status).toBe(201);
    const pass = await post('/registrations', { kind: 'TEMPORARY_PASS', vesselId: v.id, particulars: { voyageFrom: 'Abu Dhabi', voyageTo: 'Fujairah', purpose: 'Delivery voyage', validTo: day(10) }, evidence: ev('PASS_APPLICATION', 'INSURANCE_CERTIFICATE', 'SEAWORTHINESS_CERTIFICATE') }, registrar);
    expect(pass.status).toBe(201);
    const issued = await approveAndGrant(pass.body.data.id);
    expect(issued.vessel.registry.state).toBe('BAREBOAT_IN'); expect(issued.registration.certificateNo).toMatch(/\/TP\//);
    expect((await g(`/vessels/${v.id}/registry`, clerk)).body.data.transactions.map((t: any) => t.type)).toEqual(['TEMPORARY_PASS', 'BAREBOAT_IN']);
  });

  it('charters a registered ship out under a caveat only once the caveat is withdrawn, and re-registers her on the same official number', async () => {
    const v = await registeredVessel(0);
    expect(v).toBeTruthy();
    // a caveat lodged directly on the entry stops title moving
    const caveat = await post(`/vessels/${v.id}/registry/transactions`, { type: 'CAVEAT', particulars: { lodgedBy: 'Coastal Cooperative Bank (sample)', ground: 'Disputed sale' }, notes: 'Caveat lodged on notice' }, registrar);
    expect(caveat.status, JSON.stringify(caveat.body)).toBe(201); expect(caveat.body.data.transaction.type).toBe('CAVEAT');
    expect((await post(`/vessels/${v.id}/registry/transactions`, { type: 'CAVEAT', particulars: {} }, registrar)).status).toBe(400);
    const out = await post('/registrations', { kind: 'BAREBOAT_OUT', vesselId: v.id, particulars: { charterer: 'Northern Bareboat Ltd (sample)', registry: 'Bareboat Registry of Malta', charterEnds: day(300) }, evidence: ev('BAREBOAT_CHARTER_PARTY', 'BAREBOAT_REGISTRY_CONFIRMATION') }, registrar);
    expect(out.status, JSON.stringify(out.body)).toBe(201);
    const outId = out.body.data.id;
    expect((await move(outId, 'UNDER_SCRUTINY')).status).toBe(201);
    const blocked = await move(outId, 'APPROVED'); expect(blocked.status).toBe(409); expect(blocked.body.message).toMatch(/caveat/i);
    const lifted = await post(`/vessels/${v.id}/registry/transactions`, { type: 'CAVEAT_WITHDRAWAL', particulars: { caveatId: caveat.body.data.transaction.id } }, registrar); expect(lifted.status).toBe(201);
    expect((await g(`/vessels/${v.id}/registry`, clerk)).body.data).toMatchObject({ titleBlocked: false, caveats: [] });
    expect((await move(outId, 'APPROVED')).status).toBe(201);
    const chartered = await post(`/registrations/${outId}/grant`, {}, registrar); expect(chartered.status, JSON.stringify(chartered.body)).toBe(201);
    expect(chartered.vessel ?? chartered.body.data.vessel).toBeTruthy();
    const after = (await g(`/vessels/${v.id}/registry`, clerk)).body.data;
    expect(after.registry.state).toBe('BAREBOAT_OUT'); expect(after.onRegister).toBe(false); expect(after.registry.officialNumber).toBe(v.official_number);
    expect(after.transactions[0]).toMatchObject({ type: 'BAREBOAT_OUT', particulars: { registry: 'Bareboat Registry of Malta' } });
    // while chartered out she takes no amendment, and a fresh first registration is refused; re-registration is the way back
    expect((await post('/registrations', { kind: 'AMENDMENT', vesselId: v.id, amendment: { types: ['MANAGER'] } }, registrar)).status).toBe(409);
    expect((await post('/registrations', { kind: 'PERMANENT', vesselId: v.id }, registrar)).status).toBe(409);
    const back = await post('/registrations', { kind: 'RE_REGISTRATION', vesselId: v.id, portOfRegistry: 'AUH', owners: OWNERS(), tonnage: { gross: 100, net: 50, certificateNo: 'TM/1' }, evidence: ev('DECLARATION_OF_OWNERSHIP', 'SURVEY_CERTIFICATE', 'INSURANCE_CERTIFICATE', 'BAREBOAT_TERMINATION') }, registrar);
    expect(back.status, JSON.stringify(back.body)).toBe(201);
    const checks = (await g(`/registrations/${back.body.data.id}/checks`, clerk)).body.data;
    expect(checks.checks.find((c: any) => c.check === 'Entry is returning to the register')).toMatchObject({ passed: true });
    const returned = await approveAndGrant(back.body.data.id);
    expect(returned.vessel.registry).toMatchObject({ state: 'REGISTERED', officialNumber: v.official_number }); expect(returned.registration.certificateNo).toMatch(/\/CR\//);
    expect((await g(`/vessels/${v.id}/registry`, clerk)).body.data.transactions.map((t: any) => t.type).slice(0, 2)).toEqual(['RE_REGISTRATION', 'BAREBOAT_OUT']);
  });

  it('keeps the encumbrance register and the ledger in step, and refuses what the master does not record directly', async () => {
    const v = await registeredVessel(1);
    expect(v).toBeTruthy();
    expect((await post(`/vessels/${v.id}/registry/transactions`, { type: 'REGISTRATION', particulars: {} }, registrar)).status).toBe(409);
    expect((await post(`/vessels/${v.id}/registry/transactions`, { type: 'LOTTERY', particulars: {} }, registrar)).body.message).toMatch(/LOTTERY.*registryTransactionType/);
    expect((await post(`/vessels/${v.id}/registry/transactions`, { type: 'CAVEAT', particulars: { lodgedBy: 'x' } }, clerk)).status).toBe(403);
    await clearOutbox();
    const mortgage = await post(`/vessels/${v.id}/registry/transactions`, { type: 'MORTGAGE_REGISTRATION', particulars: { holder: 'Gulf Coast Maritime Finance PJSC (sample)', amount: 12000000, reference: 'MTG/AUH/2026/044' } }, registrar);
    expect(mortgage.status, JSON.stringify(mortgage.body)).toBe(201); expect(mortgage.body.data.encumbranceId).toBeTruthy();
    let record = (await g(`/vessels/${v.id}/registry`, clerk)).body.data;
    expect(record.encumbrances).toHaveLength(1); expect(record.encumbrances[0]).toMatchObject({ holder: 'Gulf Coast Maritime Finance PJSC (sample)', amount: 12000000, live: true });
    // a closure now carries the charge as a blocking check, read from the entry rather than the file
    const closing = await post('/registrations', { kind: 'DELETION', vesselId: v.id, deletion: { reason: 'BROKEN_UP' }, evidence: ev('CLOSURE_APPLICATION', 'DUES_CLEARANCE') }, registrar);
    expect(closing.status, JSON.stringify(closing.body)).toBe(201);
    expect((await g(`/registrations/${closing.body.data.id}/checks`, clerk)).body.data.blocked.map((c: any) => c.check)).toContain('No subsisting mortgage or charge');
    expect((await g(`/registrations/${closing.body.data.id}`, clerk)).body.data.requiredEvidence.map((e: any) => e.key)).toContain('MORTGAGE_DISCHARGE');
    expect((await move(closing.body.data.id, 'WITHDRAWN')).status).toBe(201);
    expect((await post(`/vessels/${v.id}/registry/transactions`, { type: 'MORTGAGE_DISCHARGE', particulars: {} }, registrar)).status).toBe(400);
    const discharge = await post(`/vessels/${v.id}/registry/transactions`, { type: 'MORTGAGE_DISCHARGE', particulars: { encumbranceId: mortgage.body.data.encumbranceId, reference: 'REL/2026/09' } }, registrar);
    expect(discharge.status).toBe(201);
    expect((await post(`/vessels/${v.id}/registry/transactions`, { type: 'MORTGAGE_DISCHARGE', particulars: { encumbranceId: mortgage.body.data.encumbranceId } }, registrar)).status).toBe(409);
    record = (await g(`/vessels/${v.id}/registry`, clerk)).body.data;
    expect(record.encumbrances).toHaveLength(0); expect(record.dischargedEncumbrances).toHaveLength(1);
    expect(record.transactions.map((t: any) => t.type).slice(0, 2)).toEqual(['MORTGAGE_DISCHARGE', 'MORTGAGE_REGISTRATION']);
    const manager = await post(`/vessels/${v.id}/registry/transactions`, { type: 'CHANGE_OF_MANAGER', particulars: { manager: 'Harbour Ship Management LLC (sample)' } }, registrar); expect(manager.status).toBe(201);
    expect((await g(`/vessels/${v.id}`, clerk)).body.data.manager).toBe('Harbour Ship Management LLC (sample)');
    expect((await outbox(EVENTS.ships.registryTransaction)).map((e) => e.data.type)).toEqual(['MORTGAGE_REGISTRATION', 'MORTGAGE_DISCHARGE', 'CHANGE_OF_MANAGER']);
  });

  it('issues an attested transcript that verifies until the register moves, and shows an operator their own ledger only', async () => {
    const v = await registeredVessel(2);
    expect(v).toBeTruthy();
    const issued = await post(`/vessels/${v.id}/registry/transcripts`, { purpose: 'Produced to a mortgagee' }, registrar);
    expect(issued.status, JSON.stringify(issued.body)).toBe(201);
    const a = issued.body.data.attestation;
    expect(a.number).toMatch(/^TOR-\d{4}-\d{5}$/); expect(a.digest).toMatch(/^[0-9a-f]{64}$/); expect(a.purpose).toBe('Produced to a mortgagee');
    expect(issued.body.data.owners.length).toBeGreaterThan(0); expect(issued.body.data.transactions.every((t: any) => t.type !== 'TRANSCRIPT')).toBe(true);
    expect((await g(`/vessels/${v.id}/registry/transcripts/${a.number}`, clerk).expect(200)).body.data).toMatchObject({ matches: true, transactionsSince: 0 });
    expect((await g(`/vessels/${v.id}/registry/transcripts/TOR-1999-00001`, clerk)).status).toBe(404);
    expect((await outbox(EVENTS.ships.transcriptIssued)).at(-1)?.data).toMatchObject({ transcriptNo: a.number, digest: a.digest });
    // the digest is of the content and the number, so a copy cannot be re-numbered
    expect(digestOf({ number: 'TOR-0000-00000', content: {} })).not.toBe(digestOf({ number: 'TOR-0000-00001', content: {} }));
    await post(`/vessels/${v.id}/registry/transactions`, { type: 'CAVEAT', particulars: { lodgedBy: 'A claimant (sample)', ground: 'Unpaid repairs' } }, registrar);
    expect((await g(`/vessels/${v.id}/registry/transcripts/${a.number}`, clerk)).body.data).toMatchObject({ matches: false, transactionsSince: 1 });
    expect((await g(`/vessels/${v.id}/registry`, clerk)).body.data.transcripts[0]).toMatchObject({ transcriptNo: a.number });
    // tenancy: the ledger an agent reads is their ships' and nobody else's
    const mine = new Set(((await g('/vessels?limit=200', agentgss)).body.data as any[]).map((x) => x.id));
    const ledger = (await g('/registry/transactions?limit=200', agentgss).expect(200)).body.data;
    expect(ledger.every((t: any) => mine.has(t.vesselId))).toBe(true);
    expect(((await g('/registry/transactions?limit=200', clerk)).body.data as any[]).some((t) => !mine.has(t.vesselId))).toBe(true);
  });
});
