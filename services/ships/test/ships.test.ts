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
import { qualifies, registrationChecks, shareLedger, requiredEvidence, blocking } from '../src/registry';
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
    expect(requiredEvidence({ kind: 'PERMANENT' }, 'AE').map((e) => e.key)).not.toContain('DELETION_CERTIFICATE');
    expect(requiredEvidence({ kind: 'PERMANENT', previousFlag: 'Panama' }, 'AE').map((e) => e.key)).toContain('DELETION_CERTIFICATE');
    expect(requiredEvidence({ kind: 'AMENDMENT', amendment: { types: ['NAME'] } }, 'AE').map((e) => e.key)).toContain('NAME_APPROVAL');
    expect(requiredEvidence({ kind: 'DELETION', encumbrances: [{ dischargedOn: null }] }, 'AE').map((e) => e.key)).toContain('MORTGAGE_DISCHARGE');
  });
  it('blocks a first registration for a ship already on the register, and a closure carrying a live charge', () => {
    const first = registrationChecks({ kind: 'PERMANENT', portOfRegistry: 'AUH', owners: OWNERS(), tonnage: { gross: 100, net: 50 }, evidence: EVIDENCE_PERMANENT, carvingNote: { compliedOn: '2026-01-01' } }, { name: 'X', status: 'ACTIVE', grt: 100 }, { onRegister: true }, 'AE');
    expect(blocking(first).map((c) => c.check)).toContain('Ship is not already on the register');
    const closure = registrationChecks({ kind: 'DELETION', portOfRegistry: 'AUH', deletion: { reason: 'SOLD_FOREIGN', newFlag: 'Panama' }, encumbrances: [{ kind: 'MORTGAGE', holder: 'Bank', dischargedOn: null }], evidence: [] }, null, { onRegister: true, outstandingDues: 0 }, 'AE');
    expect(blocking(closure).map((c) => c.check)).toEqual(expect.arrayContaining(['No subsisting mortgage or charge', 'Mandatory evidence on file']));
  });
  it('lets a permanent registration bridge from a provisional one', () => {
    const checks = registrationChecks({ kind: 'PERMANENT', portOfRegistry: 'AUH', owners: OWNERS(), tonnage: { gross: 100, net: 50 }, evidence: EVIDENCE_PERMANENT, carvingNote: { compliedOn: '2026-01-01', surveyor: 'S' } }, { name: 'X', status: 'ACTIVE', grt: 100 }, { onRegister: false, bridging: true }, 'AE');
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
    expect(r.kinds.map((k: any) => k.kind)).toEqual(['PERMANENT', 'PROVISIONAL', 'AMENDMENT', 'DELETION']);
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
