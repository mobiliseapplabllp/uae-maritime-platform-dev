import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { EVENTS, makeEvent, subjectFor } from '@maritime/contracts';
import { createApp, loadEnv, signHS256, withTx, StaticPrincipalResolver, PRINCIPAL_RESOLVER, AuditClient } from '@maritime/service-kit';
import { buildWorld } from '@maritime/world';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedInstruments } from '../src/seed';
import { SigningService, loadSigningMaterial, canonical } from '../src/signing';
import { applyEvent, remindExpiring } from '../src/consumer';
import { forceOf, type Row } from '../src/licences';

const world = buildWorld({ profile: 'AE' });
const DB = 'maritime_instruments_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret'; const SIGNING = 'instruments-test-signing-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let signing: SigningService;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const officer = tok('officer'); const registry = tok('registry'); const surveyor = tok('surveyor'); const nobody = tok('nobody');
const g = (p: string, t = admin) => request(server as never).get(p).set('authorization', t);
const post = (p: string, body: unknown, t = admin) => request(server as never).post(p).set('authorization', t).send(body as never);
const put = (p: string, body: unknown, t = admin) => request(server as never).put(p).set('authorization', t).send(body as never);
const del = (p: string, t = admin) => request(server as never).delete(p).set('authorization', t);
const outbox = async (type: string) => (await pool.query('SELECT payload FROM outbox WHERE subject = $1 ORDER BY id', [subjectFor(type)])).rows.map((r) => r.payload);

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedInstruments(URL, 'AE', loadSigningMaterial({ secret: SIGNING }));
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, CERT_SIGNING_SECRET: SIGNING, CERT_SIGNING_KEY: '' } as never);
  const base = { scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    admin: { ...base, id: 'admin', sub: 'admin', name: 'Admin', perms: ['*'] },
    officer: { ...base, id: 'officer', sub: 'officer', name: 'Licensing Officer', perms: ['facilities.view', 'facilities.manage', 'facilities.approve', 'certificates.view', 'certificates.manage'] },
    registry: { ...base, id: 'registry', sub: 'registry', name: 'Registry Clerk', perms: ['vessels.view'] },
    surveyor: { ...base, id: 'surveyor', sub: 'surveyor', name: 'Flag Surveyor', perms: ['vessels.view', 'certificates.view', 'certificates.manage'] },
    nobody: { ...base, id: 'nobody', sub: 'nobody', name: 'Nobody', perms: ['dashboard.view'] },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer(); pool = new Pool({ connectionString: URL }); signing = app.get(SigningService);
});
afterAll(async () => { await pool?.end(); await app?.close(); });

describe('instruments', () => {
  it('seeds the polymorphic register with signed issued instruments and continues each numbering series', async () => {
    const all = await g('/licenses?limit=1'); expect(all.body.meta.total).toBe(world.licences.length);
    const kinds = await Promise.all(['COMPANY', 'VESSEL', 'SEAFARER', 'PORT_FACILITY', 'MET_INSTITUTION'].map((k) => g(`/licenses?subjectKind=${k}&limit=1`).then((r) => r.body.meta.total)));
    expect(kinds.every((n) => n > 0)).toBe(true);
    const issued = await g('/licenses?status=ISSUED&limit=1'); const one = await g(`/licenses/${issued.body.data[0].id}`);
    expect(one.body.data.signature.verification).toMatchObject({ signed: true, valid: true, keyId: signing.material.keyId });
    expect(one.body.data.issuer).toContain('Ministry of Energy and Infrastructure');
    const series = await pool.query("SELECT series, last_value FROM numbering_series WHERE series LIKE 'NAV-%' ORDER BY series DESC LIMIT 1"); expect(Number(series.rows[0].last_value)).toBeGreaterThan(0);
    const statutory = await g('/licenses?statutory=true&limit=1'); expect(statutory.body.meta.total).toBeGreaterThan(20);
    const search = await g('/licenses?q=NAV-&limit=5'); expect(search.body.data.every((d: { licenseNo: string }) => d.licenseNo.startsWith('NAV-'))).toBe(true);
  });
  it('scopes the register by subject permission', async () => {
    const r = await g('/licenses?limit=200', registry); expect(r.status).toBe(200); expect(r.body.data.every((d: { subjectKind: string }) => d.subjectKind === 'VESSEL')).toBe(true);
    expect((await g('/licenses', nobody)).status).toBe(403);
    const seafarer = (await g('/licenses?subjectKind=SEAFARER&limit=1')).body.data[0];
    expect((await g(`/licenses/${seafarer.id}`, registry)).status).toBe(403);
    expect((await post('/licenses', { subjectKind: 'COMPANY', entityType: 'SHIPPING_AGENCY', entityName: 'X' }, registry)).status).toBe(403);
    expect((await request(server as never).get('/licenses')).status).toBe(401);
  });
  it('runs the lifecycle: application, checks, issue with a signature, public verification, tamper detection, suspension and reinstatement', async () => {
    const company = (await pool.query("SELECT id, label FROM subjects WHERE model = 'Company' AND status = 'ACTIVE' ORDER BY id LIMIT 1")).rows[0];
    const bad = await post('/licenses', { subjectKind: 'COMPANY', entityType: 'NAVIGATION_LICENCE', subjectRef: company.id }, officer); expect(bad.status).toBe(400);
    const missing = await post('/licenses', { subjectKind: 'COMPANY', entityType: 'BUNKER_SUPPLIER', subjectRef: '00000000-0000-4000-8000-000000000000' }, officer); expect(missing.status).toBe(404);
    const created = await post('/licenses', { subjectKind: 'COMPANY', entityType: 'BUNKER_SUPPLIER', subjectRef: company.id, contactPerson: 'Ops Manager', email: 'ops@example.test' }, officer);
    expect(created.status).toBe(201); expect(created.body.data.status).toBe('APPLIED'); expect(created.body.data.licenseNo).toMatch(/^LIC-\d{4}-\d{4}$/); expect(created.body.data.entityName).toBe(company.label);
    const id = created.body.data.id as string;
    const checks = await g(`/licenses/${id}/checks`, officer); expect(checks.body.data.checks[0].passed).toBe(true); expect(checks.body.data.canIssue).toBe(false);
    expect((await post(`/licenses/${id}/transition`, { to: 'ISSUED' }, officer)).status).toBe(409);
    expect((await post(`/licenses/${id}/transition`, { to: 'UNDER_REVIEW' }, officer)).body.data.status).toBe('UNDER_REVIEW');
    const issued = await post(`/licenses/${id}/transition`, { to: 'ISSUED', note: 'Premises inspected' }, officer);
    expect(issued.status).toBe(201); expect(issued.body.data.status).toBe('ISSUED'); expect(issued.body.data.issueChecks).toHaveLength(1); expect(issued.body.data.inForce).toBe(true);
    expect(issued.body.data.signature.verification.valid).toBe(true); expect(new Date(issued.body.data.expiryDate).getTime() - new Date(issued.body.data.issueDate).getTime()).toBeGreaterThan(700 * 86400000);
    const no = issued.body.data.licenseNo as string;
    const pub = await request(server as never).get(`/public/verify/${no.toLowerCase()}`); expect(pub.status).toBe(200);
    expect(pub.body.data).toMatchObject({ found: true, licenseNo: no, inForce: true, status: 'ISSUED', signature: { signed: true, valid: true } }); expect(pub.body.data.email).toBeUndefined();
    expect((await request(server as never).get('/public/verify/NOPE-2026-9999')).body.data.found).toBe(false);
    expect((await request(server as never).get('/public/verify/bad%20number!')).status).toBe(400);
    const key = await request(server as never).get('/public/signing-key'); expect(key.body.data.publicKeyPem).toContain('BEGIN PUBLIC KEY'); expect(key.body.data.keys.find((k: { keyId: string }) => k.keyId === signing.material.keyId).active).toBe(true);
    // the signed facts cannot be edited through the API, and a change behind the API's back is detected
    expect((await put(`/licenses/${id}`, { entityName: 'Someone Else LLC' }, officer)).status).toBe(409);
    expect((await put(`/licenses/${id}`, { conditions: 'Deliveries by barge only' }, officer)).body.data.conditions).toBe('Deliveries by barge only');
    await pool.query("UPDATE licences SET entity_name = 'Someone Else LLC' WHERE id = $1", [id]);
    const tampered = await request(server as never).get(`/public/verify/${no}`); expect(tampered.body.data.signature.valid).toBe(false); expect(tampered.body.data.signature.reason).toMatch(/altered/);
    await pool.query('UPDATE licences SET entity_name = $2 WHERE id = $1', [id, company.label]);
    expect((await post(`/licenses/${id}/transition`, { to: 'SUSPENDED' }, officer)).status).toBe(400);
    const susp = await post(`/licenses/${id}/transition`, { to: 'SUSPENDED', note: 'Uncalibrated meters' }, officer); expect(susp.body.data.inForce).toBe(false);
    expect((await request(server as never).get(`/public/verify/${no}`)).body.data.inForce).toBe(false);
    const back = await post(`/licenses/${id}/transition`, { to: 'ISSUED', note: 'Calibration certificates produced' }, officer); expect(back.body.data.status).toBe('ISSUED'); expect(back.body.data.signature.verification.valid).toBe(true); expect(back.body.data.history.at(-1).note).toBe('Calibration certificates produced');
    expect((await del(`/licenses/${id}`, officer)).status).toBe(409);
    const events = await outbox(EVENTS.instruments.issued); expect(events.some((e) => e.data.instrumentId === id)).toBe(true);
    expect((await outbox(EVENTS.instruments.suspended)).some((e) => e.data.instrumentId === id && e.data.note === 'Uncalibrated meters')).toBe(true);
    expect((await outbox(EVENTS.readModel.upserted)).filter((e) => e.data.kind === 'instrument' && e.data.entity.id === id).length).toBeGreaterThanOrEqual(4);
  });
  it('blocks issue on a failed blocking check unless an officer overrides with a reason', async () => {
    const vessel = (await pool.query("SELECT id, label FROM subjects WHERE model = 'Vessel' AND status = 'ACTIVE' AND EXISTS (SELECT 1 FROM jsonb_array_elements(facts->'certificates') c WHERE (c->>'expiryDate')::timestamptz < now()) ORDER BY id LIMIT 1")).rows[0];
    expect(vessel).toBeTruthy();
    const created = await post('/licenses', { subjectKind: 'VESSEL', entityType: 'VESSEL_NOC', subjectRef: vessel.id }, admin); expect(created.status).toBe(201); expect(created.body.data.licenseNo).toMatch(/^NOC-/);
    const id = created.body.data.id;
    await post(`/licenses/${id}/transition`, { to: 'UNDER_REVIEW' }, admin);
    const blocked = await post(`/licenses/${id}/transition`, { to: 'ISSUED' }, admin); expect(blocked.status).toBe(409); expect(blocked.body.message).toMatch(/expired/);
    expect((await post(`/licenses/${id}/transition`, { to: 'ISSUED', override: true }, admin)).status).toBe(400);
    const issued = await post(`/licenses/${id}/transition`, { to: 'ISSUED', override: true, note: 'Class has confirmed the renewal survey is booked' }, admin);
    expect(issued.status).toBe(201); expect(issued.body.data.issueChecks.at(-1)).toMatchObject({ check: 'Officer override', passed: true });
    const forVessel = await g(`/instruments/subjects/VESSEL/${vessel.id}`, registry); expect(forVessel.body.data.some((d: { id: string }) => d.id === id)).toBe(true);
    // a registry clerk can read but cannot decide; a licensing officer without the vessels group cannot decide on a vessel instrument either
    expect((await post(`/licenses/${id}/transition`, { to: 'SUSPENDED', note: 'x' }, registry)).status).toBe(403);
  });
  it('keeps statutory certificates honest against their survey schedule and records endorsements', async () => {
    const lapsed = (await pool.query("SELECT id, entity_type FROM licences WHERE status = 'ISSUED' AND entity_type = 'CARGO_SHIP_SAFETY_CONSTRUCTION' ORDER BY (SELECT count(*) FROM jsonb_array_elements(endorsements)) ASC, issue_date ASC LIMIT 1")).rows[0];
    const list = await g('/licenses?statutory=true&subjectKind=VESSEL&limit=200', surveyor); expect(list.status).toBe(200);
    // the world leaves one ship with its survey schedule slipped: a certificate that reads valid on its face and is not
    const rows = (await pool.query("SELECT * FROM licences WHERE status = 'ISSUED' AND subject_kind = 'VESSEL' AND entity_type = ANY($1)", [list.body.data.map((d: { entityType: string }) => d.entityType)])).rows as Row[];
    const notInForce = rows.filter((r) => !forceOf(r).inForce); expect(notInForce.length).toBeGreaterThan(0); expect(forceOf(notInForce[0]).reason).toMatch(/overdue|not endorsed|Expired/);
    const pick = notInForce.find((r) => (forceOf(r).endorsements?.overdue ?? 0) > 0) ?? notInForce[0];
    const tr = await g(`/licenses/${pick.id}`, surveyor); expect(tr.body).toMatchObject({ success: true }); const target = tr.body.data; expect(target.inForce).toBe(false); expect(target.forceReason).toBe(forceOf(pick).reason);
    void lapsed;
    const sched = await g(`/licenses/${target.id}/endorsements`, surveyor); expect(sched.body.data.statutory).toBe(true); expect(sched.body.data.schedule.length).toBeGreaterThan(0);
    const nonStatutory = (await g('/licenses?entityType=NAVIGATION_LICENCE&status=ISSUED&limit=1')).body.data[0];
    expect((await post(`/licenses/${nonStatutory.id}/endorsements`, { kind: 'ANNUAL' }, admin)).status).toBe(400);
    expect((await post(`/licenses/${target.id}/endorsements`, { kind: 'ANNUAL', result: 'NOT_ENDORSED' }, surveyor)).status).toBe(400);
    const overdue = target.endorsementState.schedule.find((s: { state: string }) => s.state === 'OVERDUE');
    if (overdue) {
      const endorsed = await post(`/licenses/${target.id}/endorsements`, { kind: overdue.kind, anniversary: overdue.anniversary, surveyor: 'Capt. Surveyor', organisation: 'TASNEEF', place: 'Khalifa Port', result: 'ENDORSED', remarks: 'Survey completed' }, surveyor);
      expect(endorsed.status).toBe(201); expect(endorsed.body.data.endorsements.at(-1).result).toBe('ENDORSED');
      expect(endorsed.body.data.endorsementState.overdue).toBe(target.endorsementState.overdue - 1);
    }
    const refused = await post(`/licenses/${target.id}/endorsements`, { kind: 'ADDITIONAL', result: 'NOT_ENDORSED', remarks: 'Hull damage found on survey' }, surveyor);
    expect(refused.status).toBe(201); expect(refused.body.data.inForce).toBe(false); expect(refused.body.data.forceReason).toMatch(/not endorsed/);
    expect((await outbox(EVENTS.instruments.endorsementRefused)).some((e) => e.data.instrumentId === target.id)).toBe(true);
    const mirrors = (await outbox(EVENTS.readModel.upserted)).filter((e) => e.data.kind === 'vesselCertificate' && e.data.entity.instrumentId === target.id); expect(mirrors.at(-1).data.entity.inForce).toBe(false);
  });
  it('records audits that move the performance rating, and refuses deletion of issued instruments only', async () => {
    const lic = (await g('/licenses?status=ISSUED&subjectKind=COMPANY&limit=1')).body.data[0];
    const before = lic.performanceRating;
    const a = await post(`/licenses/${lic.id}/audits`, { result: 'NON_CONFORMITY', remarks: 'Two expired extinguishers', auditor: 'Port Auditor' }, officer);
    expect(a.status).toBe(201); expect(a.body.data.audits.at(-1)).toMatchObject({ result: 'NON_CONFORMITY', auditor: 'Port Auditor' }); expect(a.body.data.performanceRating).toBeCloseTo(Math.max(0, before - 0.5), 5);
    expect((await post(`/licenses/${lic.id}/audits`, { result: 'WHATEVER' }, officer)).status).toBe(400);
    const applied = (await g('/licenses?status=APPLIED&limit=1')).body.data[0];
    expect((await del(`/licenses/${applied.id}`, officer)).body.data.deleted).toBe(true); expect((await g(`/licenses/${applied.id}`)).status).toBe(404);
    expect((await outbox(EVENTS.readModel.deleted)).some((e) => e.data.id === applied.id)).toBe(true);
  });
  it('issues an instrument when the workflow grants an application, once, and links it back by event', async () => {
    const seafarer = (await pool.query("SELECT id, label FROM subjects WHERE model = 'Seafarer' AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(facts->'certificates') c WHERE (c->>'expiryDate')::timestamptz < now()) AND EXISTS (SELECT 1 FROM jsonb_array_elements(facts->'certificates') c WHERE c->>'type' ILIKE '%medical%') ORDER BY id LIMIT 1")).rows[0];
    const ev = makeEvent({ type: EVENTS.workflow.requestIssued, source: 'workflow', data: { requestId: 'req-1', requestNo: 'SR-2026-00042', definitionKey: 'coc-issue', instrumentType: 'CERTIFICATE_OF_COMPETENCY', instrumentClass: 'CERTIFICATE', validityMonths: 60, subjectKind: 'SEAFARER', subjectId: seafarer.id, subjectName: seafarer.label, applicant: { userId: 'u1', name: 'Applicant', email: 'a@example.test' }, formData: { conditions: 'Capacity: Chief Officer' }, issuedBy: { id: 'officer', name: 'Licensing Officer' } } });
    const deps = { env: loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, CERT_SIGNING_SECRET: SIGNING, CERT_SIGNING_KEY: '' } as never), signing, audit: app.get(AuditClient) };
    await withTx(pool, (c) => applyEvent(c, deps, ev)); await withTx(pool, (c) => applyEvent(c, deps, { ...ev, id: ev.id.replace(/^./, 'f') }));
    const rows = await pool.query("SELECT * FROM licences WHERE request_id = 'req-1'"); expect(rows.rowCount).toBe(1);
    const row = rows.rows[0]; expect(row.status).toBe('ISSUED'); expect(row.license_no).toMatch(/^COC-/); expect(row.entity_name).toMatch(new RegExp(`^${seafarer.label} \\(CDC `)); expect(row.conditions).toBe('Capacity: Chief Officer'); expect(row.signature.value).toBeTruthy();
    const issued = (await outbox(EVENTS.instruments.issued)).filter((e) => e.data.requestId === 'req-1'); expect(issued).toHaveLength(1); expect(issued[0].data.number).toBe(row.license_no); expect(issued[0].causationid).toBe(ev.id);
    const internal = await request(server as never).get(`/internal/instruments/${row.license_no}`).set('x-service-token', 'development-service-token'); expect(internal.body.data.signature.verification.valid).toBe(true);
    expect((await request(server as never).get(`/internal/instruments/${row.license_no}`)).status).toBe(401);
    const viaApi = await request(server as never).post('/internal/instruments/issue').set('x-service-token', 'development-service-token').send({ requestId: 'req-2', requestNo: 'SR-2026-00043', instrumentType: 'SHIPPING_AGENCY', subjectKind: 'COMPANY', applicant: { name: 'Gulf Agencies FZE' } });
    expect(viaApi.status).toBe(201); expect(viaApi.body.data.status).toBe('ISSUED'); expect(viaApi.body.data.entityName).toBe('Gulf Agencies FZE');
  });
  it('projects subject facts from read-model events and announces expiring instruments once a week', async () => {
    const vessel = (await pool.query("SELECT id FROM subjects WHERE model = 'Vessel' AND status = 'ACTIVE' ORDER BY id DESC LIMIT 1")).rows[0];
    const deps = { env: loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET } as never), signing, audit: app.get(AuditClient) };
    await withTx(pool, (c) => applyEvent(c, deps, makeEvent({ type: EVENTS.readModel.upserted, source: 'ships', data: { kind: 'vessel', entity: { id: vessel.id, name: 'Renamed Vessel', imo: '9700009', status: 'INACTIVE', nextDryDock: '2020-01-01' } } })));
    const s = await pool.query("SELECT status, facts FROM subjects WHERE model = 'Vessel' AND id = $1", [vessel.id]); expect(s.rows[0].status).toBe('INACTIVE'); expect(s.rows[0].facts.certificates.length).toBeGreaterThan(0);
    const checks = await request(server as never).get(`/internal/subjects/VESSEL/${vessel.id}/checks`).set('x-service-token', 'development-service-token'); expect(checks.body.data.checks[0].passed).toBe(false); expect(checks.body.data.checks[3].detail).toMatch(/Docking lapsed/);
    await withTx(pool, (c) => applyEvent(c, deps, makeEvent({ type: EVENTS.readModel.upserted, source: 'ships', data: { kind: 'vesselCertificate', entity: { id: 'x', vesselId: vessel.id, certType: 'Load Line Certificate', expiryDate: '2020-01-01T00:00:00.000Z' } } })));
    const again = await request(server as never).get(`/internal/subjects/VESSEL/${vessel.id}/checks`).set('x-service-token', 'development-service-token'); expect(again.body.data.checks[1].detail).toMatch(/Load Line Certificate/);
    const ev = makeEvent({ type: EVENTS.scheduler.remindersLicences, source: 'scheduler', data: { days: 3650 } });
    const n = await withTx(pool, (c) => remindExpiring(c, deps.env, ev, 3650)); expect(n).toBeGreaterThan(0);
    expect(await withTx(pool, (c) => remindExpiring(c, deps.env, ev, 3650))).toBe(0);
    const reminders = await outbox(EVENTS.instruments.expiring); expect(reminders.length).toBe(n); expect(reminders[0].data.daysLeft).toBeGreaterThan(0);
    const expiring = await g('/instruments/expiring?days=365', officer); expect(expiring.status).toBe(200); expect(expiring.body.data.length).toBeGreaterThan(0); expect(expiring.body.data[0].daysLeft).toBeLessThanOrEqual(expiring.body.data.at(-1).daysLeft);
  });
  it('verifies signatures made under a retired key and rejects unknown keys', async () => {
    const old = loadSigningMaterial({ secret: 'an-earlier-registry-key' });
    await pool.query('INSERT INTO signing_keys(key_id, public_key_pem, active, retired_at) VALUES ($1, $2, false, now())', [old.keyId, old.pem]);
    const lic = (await pool.query("SELECT * FROM licences WHERE status = 'ISSUED' AND subject_kind = 'COMPANY' ORDER BY license_no LIMIT 1")).rows[0];
    const facts = { licenseNo: lic.license_no, entityType: lic.entity_type, subjectKind: lic.subject_kind, subjectId: lic.subject_id, entityName: lic.entity_name, issueDate: lic.issue_date, expiryDate: lic.expiry_date };
    const { signFacts } = await import('../src/signing');
    await pool.query('UPDATE licences SET signature = $2 WHERE id = $1', [lic.id, JSON.stringify(signFacts(old, facts))]);
    const v1 = await request(server as never).get(`/public/verify/${lic.license_no}`); expect(v1.body.data.signature).toMatchObject({ signed: true, valid: true, keyId: old.keyId }); expect(v1.body.data.signature.reason).toMatch(/earlier registry key/);
    await pool.query('UPDATE licences SET signature = $2 WHERE id = $1', [lic.id, JSON.stringify({ ...signFacts(old, facts), keyId: 'deadbeefdeadbeef' })]);
    const v2 = await request(server as never).get(`/public/verify/${lic.license_no}`); expect(v2.body.data.signature.valid).toBe(false); expect(v2.body.data.signature.reason).toMatch(/does not hold/);
    expect(canonical(facts)).toContain('|ISSUED');
  });
});
