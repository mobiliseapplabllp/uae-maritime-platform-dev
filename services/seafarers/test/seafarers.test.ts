import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { EVENTS, makeEvent, subjectFor } from '@maritime/contracts';
import { AuditClient, PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256 } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedSeafarers } from '../src/seed';
import { applyEvent } from '../src/consumer';
import { crewDashboard, documentGate, seaDays, daysLeft, isMedical } from '../src/crew';

const DB = 'maritime_seafarers_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let audit: AuditClient; let env: ReturnType<typeof loadEnv<typeof envSchema>>;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const desk = tok('desk'); const clerk = tok('clerk'); const nobody = tok('nobody');
/* An operator, not an officer: they read what is theirs and nothing else. */
const agentgss = tok('agent-gss');
const mca = tok('manning-mca'); const anc = tok('manning-anc'); const ami = tok('inst-ami');
const g = (p: string, t = admin) => request(server as never).get(p).set('authorization', t);
const post = (p: string, body?: unknown, t = admin) => request(server as never).post(p).set('authorization', t).send((body ?? {}) as never);
const put = (p: string, body: unknown, t = admin) => request(server as never).put(p).set('authorization', t).send(body as never);
const del = (p: string, t = admin) => request(server as never).delete(p).set('authorization', t);
const outbox = async (type: string) => (await pool.query('SELECT payload FROM outbox WHERE subject = $1 ORDER BY id', [subjectFor(type)])).rows.map((r) => r.payload as { type: string; data: Record<string, any> });
const clearOutbox = () => pool.query('DELETE FROM outbox');
const D = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedSeafarers(URL, 'AE');
  env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET } as never);
  const base = { scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    admin: { ...base, id: 'admin', sub: 'admin', name: 'Admin', perms: ['*'] },
    desk: { ...base, id: 'desk', sub: 'desk', name: 'Crewing Desk', perms: ['seafarers.view', 'seafarers.create', 'seafarers.edit', 'seafarers.delete'] },
    clerk: { ...base, id: 'clerk', sub: 'clerk', name: 'Records Clerk', perms: ['seafarers.view'] },
    nobody: { ...base, id: 'nobody', sub: 'nobody', name: 'Nobody', perms: ['dashboard.view'] },
    'agent-gss': { ...base, id: 'agent-gss', sub: 'agent-gss', name: 'Gulf Star Shipping', kind: 'agent' as const, perms: ['seafarers.view', 'dashboard.view'], scope: { level: 'COMPANY', companies: ['GSS'] } },
    /* The two licensed manning agencies with placements on this register, and one with none. */
    'manning-mca': { ...base, id: 'manning-mca', sub: 'manning-mca', name: 'Maritime Crewing Associates', kind: 'agent' as const, perms: ['seafarers.view', 'seafarers.create', 'seafarers.edit', 'dashboard.view'], scope: { level: 'COMPANY', companies: ['MCA'] } },
    'manning-anc': { ...base, id: 'manning-anc', sub: 'manning-anc', name: 'Anchor Crew Management', kind: 'agent' as const, perms: ['seafarers.view', 'dashboard.view'], scope: { level: 'COMPANY', companies: ['ANC'] } },
    /* A training provider reads its own row on the MET register. */
    'inst-ami': { ...base, id: 'inst-ami', sub: 'inst-ami', name: 'Arabian Maritime Institute', kind: 'agent' as const, perms: ['seafarers.view'], scope: { level: 'COMPANY', companies: ['AMI'] } },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer(); pool = new Pool({ connectionString: URL }); audit = app.get(AuditClient);
});
afterAll(async () => { await pool?.end(); await app?.close(); });

/** A seafarer ashore whose papers are all current — the one a clean sign-on can be tested on. */
async function ashoreWithGoodPapers() {
  const r = await pool.query<{ id: string }>(
    `SELECT s.id FROM seafarers s WHERE s.current_vessel_id IS NULL AND s.status <> 'SUSPENDED'
       AND EXISTS (SELECT 1 FROM seafarer_certificates c WHERE c.seafarer_id = s.id AND c.cert_type ILIKE '%medical fitness%' AND c.expiry_date > now() + interval '120 days')
       AND EXISTS (SELECT 1 FROM seafarer_certificates c WHERE c.seafarer_id = s.id AND c.cert_type ILIKE '%competency%' AND c.expiry_date > now() + interval '120 days')
       ORDER BY s.name LIMIT 1`);
  return r.rows[0]?.id;
}
async function activeVessel() {
  const r = await pool.query<{ id: string; name: string }>(`SELECT id, name FROM vessels WHERE status = 'ACTIVE' AND NOT real ORDER BY name LIMIT 1`);
  return r.rows[0];
}

describe('seafarers — pure helpers', () => {
  it('counts whole sea days and never goes negative', () => {
    expect(seaDays(iso(0), iso(10 * D))).toBe(10);
    expect(seaDays(iso(10 * D), iso(0))).toBe(0);
    expect(daysLeft(iso(5 * D), new Date(0))).toBe(5);
    expect(isMedical('Medical Fitness (ILO/MLC)')).toBe(true);
    // medical first aid is a training ticket, not a fitness certificate — it must not stand in for one
    expect(isMedical('Medical First Aid')).toBe(false);
  });
  it('gates a sign-on on the documents the tour would be sailed under', () => {
    const cfg = { COC_VERIFY_ON_SIGN_ON: true, SIGN_ON_MARGIN_DAYS: 30 } as never;
    // one clock for the documents and the gate, so a millisecond tick cannot turn "3 days ago" into four
    const now = new Date();
    const cert = (certType: string, days: number) => ({ certType, certCode: '', expiryDate: iso(now.getTime() + days * D) } as never);
    expect(documentGate([cert('Medical Fitness (ILO/MLC)', 200), cert('Certificate of Competency', 400), cert('STCW Basic Safety Training', 300)], cfg, now).failures).toHaveLength(0);
    expect(documentGate([cert('Certificate of Competency', 400)], cfg, now).failures).toEqual(['Medical fitness (ILO/MLC): not on file']);
    expect(documentGate([cert('Medical Fitness (ILO/MLC)', -3), cert('Certificate of Competency', 400)], cfg, now).failures[0]).toContain('expired 3 days ago');
    expect(documentGate([cert('Medical Fitness (ILO/MLC)', 10), cert('Certificate of Competency', 400)], cfg, now).failures[0]).toContain('tour would outlast it');
    // basic safety training advises but does not by itself block
    expect(documentGate([cert('Medical Fitness (ILO/MLC)', 200), cert('Certificate of Competency', 400)], cfg, now).failures).toHaveLength(0);
    expect(documentGate([cert('Medical Fitness (ILO/MLC)', 200)], { ...cfg, COC_VERIFY_ON_SIGN_ON: false } as never, now).failures).toHaveLength(0);
  });
  it('bands the crew dashboard funnel on the days left on each document', () => {
    const cfg = { MEDICAL_EXPIRING_DAYS: 45 } as never;
    const d = crewDashboard([
      { id: '1', name: 'A', rank: 'Master', status: 'ACTIVE', currentVesselName: 'Ship', days: 400, certExpiries: [{ certType: 'Medical Fitness (ILO/MLC)', expiryDate: iso(Date.now() - D) }, { certType: 'X', expiryDate: iso(Date.now() + 200 * D) }] },
      { id: '2', name: 'B', rank: 'Cook', status: 'SIGNED_OFF', currentVesselName: null, days: 100, certExpiries: [{ certType: 'Y', expiryDate: iso(Date.now() + 20 * D) }, { certType: 'Z', expiryDate: iso(Date.now() + 60 * D) }] },
    ], cfg);
    expect(d.kpis).toMatchObject({ roll: 2, onboard: 1, ashore: 1, medicalIssues: 1, avgSeaDays: 250, medicalWindow: 45 });
    expect(d.funnel).toEqual({ expired: 1, d30: 1, d90: 1, valid: 1 });
    expect(d.alertList[0]).toMatchObject({ id: '1', alerts: 1 });
  });
});

describe('seafarers — the register', () => {
  it('lists, filters, searches, sorts and pages with the computed summaries', async () => {
    const all = await g('/seafarers?limit=200').expect(200);
    expect(all.body.meta.total).toBe(150);
    const row = all.body.data[0];
    expect(row).toMatchObject({ certAlerts: expect.any(Number), totalSeaDays: expect.any(Number), seafarerIdLabel: 'SID' });
    expect(row.certificates.length).toBeGreaterThan(0);
    const masters = await g('/seafarers?rank=Master&limit=100').expect(200);
    expect(masters.body.data.every((s: any) => s.rank === 'Master')).toBe(true);
    const suspended = await g('/seafarers?status=SUSPENDED&limit=100').expect(200);
    expect(suspended.body.data.every((s: any) => s.status === 'SUSPENDED')).toBe(true);
    const indian = await g(`/seafarers?nationality=${encodeURIComponent('India')}&limit=200`).expect(200);
    expect(indian.body.data.every((s: any) => s.nationality === 'India')).toBe(true);
    const onboard = await g('/seafarers?onboard=true&limit=200').expect(200);
    expect(onboard.body.data.every((s: any) => s.currentVesselId)).toBe(true);
    const byVessel = await g(`/seafarers?currentVesselId=${onboard.body.data[0].currentVesselId}&limit=100`).expect(200);
    expect(byVessel.body.data.every((s: any) => s.currentVesselId === onboard.body.data[0].currentVesselId)).toBe(true);
    const alerts = await g('/seafarers?certAlerts=true&limit=200').expect(200);
    expect(alerts.body.data.every((s: any) => s.certAlerts > 0)).toBe(true);
    const search = await g(`/seafarers?q=${encodeURIComponent(row.cdcNo)}`).expect(200);
    expect(search.body.data[0].cdcNo).toBe(row.cdcNo);
    const page = await g('/seafarers?limit=10&page=2&sort=-name').expect(200);
    expect(page.body.data).toHaveLength(10);
    expect(page.body.data[0].name >= page.body.data[9].name).toBe(true);
  });

  it('returns the full record with documents, service history and totals', async () => {
    const id = (await g('/seafarers?onboard=true&limit=1')).body.data[0].id;
    const s = (await g(`/seafarers/${id}`).expect(200)).body.data;
    for (const k of ['certificates', 'seaService', 'certAlerts', 'totalSeaDays', 'seaServiceDays', 'serviceRecords', 'currentVesselName', 'signedOnAt']) expect(s).toHaveProperty(k);
    expect(s.certificates.every((c: any) => ['VALID', 'EXPIRING', 'EXPIRED'].includes(c.status))).toBe(true);
    expect(s.seaService.every((x: any) => x.days >= 0)).toBe(true);
    expect(s.totalSeaDays).toBe(s.seaService.reduce((t: number, x: any) => t + x.days, 0));
    expect(s.serviceRecords).toBe(s.seaService.length);
    expect(s.certAlerts).toBe(s.certificates.filter((c: any) => c.status !== 'VALID').length);
    const card = (await g(`/seafarers/${id}/card`).expect(200)).body.data;
    expect(card).toMatchObject({ kind: 'seafarer', link: `/seafarers/${id}` });
  });

  it('serves the crew dashboard', async () => {
    const d = (await g('/seafarers/dashboard').expect(200)).body.data;
    expect(d.kpis.roll).toBe(150);
    expect(d.kpis.onboard + d.kpis.ashore).toBe(150);
    expect(d.kpis.medicalWindow).toBe(45);
    expect(d.byRank.length).toBeGreaterThan(5);
    expect(d.funnel.expired + d.funnel.d30 + d.funnel.d90 + d.funnel.valid).toBeGreaterThan(100);
    expect(d.alertList.length).toBeLessThanOrEqual(10);
  });

  it('creates, updates and deletes a record, and refuses a duplicate CDC and a bad rank', async () => {
    await clearOutbox();
    const created = await post('/seafarers', { name: 'Test Mariner', cdcNo: 'AUH-TEST-1', rank: 'Second Officer', nationality: 'United Arab Emirates', dob: '1990-04-12' }, desk).expect(201);
    const id = created.body.data.id;
    expect(created.body.data).toMatchObject({ status: 'ACTIVE', certAlerts: 0, totalSeaDays: 0, nationalIdLabel: 'Emirates ID' });
    expect((await outbox(EVENTS.seafarers.created)).length).toBe(1);
    expect((await outbox(EVENTS.readModel.upserted)).some((e) => e.data.kind === 'seafarer' && e.data.entity.id === id)).toBe(true);
    await post('/seafarers', { name: 'Dupe', cdcNo: 'AUH-TEST-1', rank: 'Cook' }, desk).expect(409);
    await post('/seafarers', { name: 'Bad rank', cdcNo: 'AUH-TEST-2', rank: 'Admiral' }, desk).expect(400);
    const updated = await put(`/seafarers/${id}`, { rank: 'Chief Officer', phone: '+971 50 000 0000' }, desk).expect(200);
    expect(updated.body.data.rank).toBe('Chief Officer');
    await del(`/seafarers/${id}`, desk).expect(200);
    expect((await outbox(EVENTS.readModel.deleted)).some((e) => e.data.kind === 'seafarer' && e.data.id === id)).toBe(true);
    await g(`/seafarers/${id}`).expect(404);
  });

  it('reads a cleared date field as no value rather than as a blank date', async () => {
    const created = await post('/seafarers', { name: 'Blank Dates', cdcNo: 'AUH-BLANK-1', rank: 'Oiler', dob: '' }, desk).expect(201);
    expect(created.body.data.dob).toBeNull();
    const id = created.body.data.id;
    const dated = await put(`/seafarers/${id}`, { dob: '1988-02-09' }, desk).expect(200);
    expect(dated.body.data.dob).toBe('1988-02-09');
    expect((await put(`/seafarers/${id}`, { dob: '' }, desk).expect(200)).body.data.dob).toBeNull();
    const cert = await post(`/seafarers/${id}/certificates`, { certType: 'Tanker Familiarisation', issueDate: '', expiryDate: iso(Date.now() + 400 * D) }, desk).expect(201);
    expect(cert.body.data.certificates[0]).toMatchObject({ issueDate: null, status: 'VALID' });
    await del(`/seafarers/${id}`, desk).expect(200);
  });

  it('refuses without a session and without the permission', async () => {
    await request(server as never).get('/seafarers').expect(401);
    await request(server as never).get('/seafarers').set('authorization', 'Bearer nonsense').expect(401);
    await g('/seafarers', nobody).expect(403);
    await post('/seafarers', { name: 'X', cdcNo: 'AUH-X', rank: 'Cook' }, clerk).expect(403);
    const id = (await g('/seafarers?limit=1')).body.data[0].id;
    await del(`/seafarers/${id}`, clerk).expect(403);
    await post(`/seafarers/${id}/sign-off`, {}, clerk).expect(403);
  });
});

describe('seafarers — documents', () => {
  let id: string;
  beforeAll(async () => { id = (await g('/seafarers?limit=1&sort=name')).body.data[0].id; });

  it('adds, edits and deletes a document and derives its expiry state', async () => {
    await clearOutbox();
    const added = await post(`/seafarers/${id}/certificates`, { certType: 'Ship Security Officer', number: 'SSO-1', issuer: 'Maritime Sector', expiryDate: iso(Date.now() + 10 * D) }, desk).expect(201);
    const cert = added.body.data.certificates.find((c: any) => c.certType === 'Ship Security Officer');
    expect(cert).toMatchObject({ status: 'EXPIRING', readOnly: false });
    expect((await outbox(EVENTS.seafarers.certificateIssued)).length).toBe(1);
    const edited = await put(`/seafarers/${id}/certificates/${cert.id}`, { expiryDate: iso(Date.now() - 4 * D), grade: 'Class 2' }, desk).expect(200);
    const seen = edited.body.data.certificates.find((c: any) => c.id === cert.id);
    expect(seen).toMatchObject({ status: 'EXPIRED', grade: 'Class 2' });
    expect((await outbox(EVENTS.seafarers.certificateUpdated)).length).toBe(1);
    await del(`/seafarers/${id}/certificates/${cert.id}`, desk).expect(200);
    expect((await outbox(EVENTS.seafarers.certificateDeleted)).length).toBe(1);
    await put(`/seafarers/${id}/certificates/${cert.id}`, { number: 'x' }, desk).expect(404);
  });

  it('records this administration\'s endorsement of a certificate and refuses one that outlasts it', async () => {
    await clearOutbox();
    const record = (await g(`/seafarers/${id}`)).body.data;
    const coc = record.certificates.find((c: any) => /competency/i.test(c.certType)) ?? record.certificates[0];
    await post(`/seafarers/${id}/certificates/${coc.id}/endorse`, { number: 'END-1', expiryDate: iso(new Date(coc.expiryDate).getTime() + 30 * D) }, desk).expect(400);
    const out = await post(`/seafarers/${id}/certificates/${coc.id}/endorse`, { number: 'END-1', expiryDate: coc.expiryDate, remarks: 'Recognised under STCW I/10' }, desk).expect(201);
    const endorsed = out.body.data.certificates.find((c: any) => c.id === coc.id);
    expect(endorsed.endorsement).toMatchObject({ number: 'END-1', by: 'Crewing Desk' });
    expect(endorsed.endorsement.issuer).toContain('Maritime Sector');
    const events = await outbox(EVENTS.seafarers.endorsed);
    expect(events).toHaveLength(1);
    expect(events[0].data.certificateId).toBe(coc.id);
    expect((await outbox(EVENTS.audit.recorded)).some((e) => e.data.action === 'ENDORSE')).toBe(true);
  });

  it('keeps an instrument-issued document read-only on the record', async () => {
    const client = await pool.connect();
    try {
      await applyEvent(client, { env, audit }, makeEvent({
        type: EVENTS.readModel.upserted, source: 'instruments',
        data: { kind: 'instrument', entity: { id: 'inst-coc-1', number: 'COC-2026-0001', subjectKind: 'SEAFARER', subjectId: id, entityName: 'A Seafarer', entityType: 'CERTIFICATE_OF_COMPETENCY', typeLabel: 'Certificate of Competency (register)', status: 'ISSUED', issueDate: iso(Date.now() - 200 * D), expiryDate: iso(Date.now() + 900 * D), inForce: true, signed: true } },
      }));
    } finally { client.release(); }
    const record = (await g(`/seafarers/${id}`)).body.data;
    const mirrored = record.certificates.find((c: any) => c.instrumentId === 'inst-coc-1');
    expect(mirrored).toMatchObject({ readOnly: true, onRegister: true, signed: true, inForce: true, number: 'COC-2026-0001', status: 'VALID' });
    await put(`/seafarers/${id}/certificates/${mirrored.id}`, { number: 'TAMPERED' }, desk).expect(409);
    await del(`/seafarers/${id}/certificates/${mirrored.id}`, desk).expect(409);
    await post(`/seafarers/${id}/certificates`, { certType: mirrored.certType, expiryDate: iso(Date.now() + D) }, desk).expect(409);
  });
});

describe('seafarers — the service book', () => {
  let id: string;
  beforeAll(async () => { id = (await g('/seafarers?onboard=false&limit=1&sort=name')).body.data[0].id; });

  it('adds a tour, refuses one that signs off before it signs on, and adds its days to the total', async () => {
    await clearOutbox();
    const before = (await g(`/seafarers/${id}`)).body.data.totalSeaDays;
    const vessel = await activeVessel();
    const added = await post(`/seafarers/${id}/service`, { vesselId: vessel.id, vesselName: 'ignored — the register names the ship', rank: 'Able Seaman', from: iso(Date.now() - 200 * D), to: iso(Date.now() - 100 * D) }, desk).expect(201);
    const svc = added.body.data.seaService.find((x: any) => x.vesselId === vessel.id && x.days === 100);
    expect(svc).toMatchObject({ vesselName: vessel.name, verified: false, days: 100 });
    expect(added.body.data.totalSeaDays).toBe(before + 100);
    expect((await outbox(EVENTS.seafarers.seaServiceAdded)).length).toBe(1);
    await post(`/seafarers/${id}/service`, { vesselName: 'Backwards', rank: 'Cook', from: iso(Date.now()), to: iso(Date.now() - D) }, desk).expect(400);
  });

  it('verifies a tour, publishes it and un-verifies it again', async () => {
    const record = (await g(`/seafarers/${id}`)).body.data;
    const svc = record.seaService.find((x: any) => !x.verified);
    await clearOutbox();
    const verified = (await post(`/seafarers/${id}/service/${svc.id}/verify`, { remarks: 'Checked against the crew list and movement record' }, desk).expect(201)).body.data;
    const seen = verified.seaService.find((x: any) => x.id === svc.id);
    expect(seen).toMatchObject({ verified: true, verifiedBy: 'Crewing Desk' });
    expect(seen.verifiedAt).toBeTruthy();
    const events = await outbox(EVENTS.seafarers.seaServiceVerified);
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ serviceId: svc.id, days: svc.days, verifiedBy: 'Crewing Desk' });
    const back = (await put(`/seafarers/${id}/service/${svc.id}`, { verified: false }, desk).expect(200)).body.data;
    expect(back.seaService.find((x: any) => x.id === svc.id).verified).toBe(false);
    await put(`/seafarers/${id}/service/does-not-exist`, { verified: true }, desk).expect(404);
  });

  it('deletes a tour and takes its days back off the total', async () => {
    const record = (await g(`/seafarers/${id}`)).body.data;
    const svc = record.seaService[0];
    await clearOutbox();
    const after = (await del(`/seafarers/${id}/service/${svc.id}`, desk).expect(200)).body.data;
    expect(after.totalSeaDays).toBe(record.totalSeaDays - svc.days);
    expect(after.seaService.some((x: any) => x.id === svc.id)).toBe(false);
    expect((await outbox(EVENTS.seafarers.seaServiceDeleted)).length).toBe(1);
  });
});

describe('seafarers — sign-on and sign-off', () => {
  it('refuses a sign-on the documents do not support, and takes an override with a reason', async () => {
    const vessel = await activeVessel();
    const lapsed = (await pool.query<{ id: string }>(
      `SELECT s.id FROM seafarers s WHERE s.current_vessel_id IS NULL AND s.status <> 'SUSPENDED'
         AND EXISTS (SELECT 1 FROM seafarer_certificates c WHERE c.seafarer_id = s.id AND c.cert_type ILIKE '%medical fitness%' AND c.expiry_date < now() + interval '30 days') LIMIT 1`)).rows[0];
    const id = lapsed?.id ?? (await ashoreWithGoodPapers())!;
    if (lapsed) {
      const refused = await post(`/seafarers/${id}/sign-on`, { vesselId: vessel.id }, desk).expect(422);
      expect(refused.body.success).toBe(false);
      expect(refused.body.data.failures.length).toBeGreaterThan(0);
      expect(refused.body.data.failures[0]).toMatch(/Medical|Competency/);
      await post(`/seafarers/${id}/sign-on`, { vesselId: vessel.id, override: true }, desk).expect(400);
      await clearOutbox();
      const forced = await post(`/seafarers/${id}/sign-on`, { vesselId: vessel.id, override: true, overrideReason: 'Medical renewal booked at the next port; master informed' }, desk).expect(201);
      expect(forced.body.data).toMatchObject({ signedOn: true, overridden: true });
      const audits = await outbox(EVENTS.audit.recorded);
      expect(audits.some((e) => e.data.action === 'SIGN_ON' && String(e.data.note).includes('OVERRIDE'))).toBe(true);
      await post(`/seafarers/${id}/sign-off`, {}, desk).expect(201);
    }
  });

  it('signs a seafarer on to a ship and keeps the register consistent', async () => {
    const id = await ashoreWithGoodPapers();
    expect(id).toBeTruthy();
    const vessel = await activeVessel();
    await clearOutbox();
    const out = (await post(`/seafarers/${id}/sign-on`, { vesselId: vessel.id, rank: 'Second Officer' }, desk).expect(201)).body.data;
    expect(out).toMatchObject({ signedOn: true, overridden: false, failures: [] });
    expect(out.seafarer).toMatchObject({ currentVesselId: vessel.id, currentVesselName: vessel.name, status: 'ACTIVE', rank: 'Second Officer' });
    expect(out.seafarer.signedOnAt).toBeTruthy();
    const events = await outbox(EVENTS.seafarers.signedOn);
    expect(events).toHaveLength(1);
    expect(events[0].data).toMatchObject({ vesselId: vessel.id, vesselName: vessel.name });
    expect((await outbox(EVENTS.readModel.upserted)).some((e) => e.data.kind === 'seafarer' && e.data.entity.currentVesselId === vessel.id)).toBe(true);
    await post(`/seafarers/${id}/sign-on`, { vesselId: vessel.id }, desk).expect(400);
    await post(`/seafarers/${id}/sign-on`, { vesselId: 'not-a-ship' }, desk).expect(400);
  });

  it('signs the same seafarer off, writing the tour as verified sea service', async () => {
    const onboard = (await g('/seafarers?onboard=true&limit=200')).body.data.find((s: any) => s.signedOnAt);
    const before = (await g(`/seafarers/${onboard.id}`)).body.data;
    await clearOutbox();
    const out = (await post(`/seafarers/${onboard.id}/sign-off`, { remarks: 'Tour complete at Khor Fakkan' }, desk).expect(201)).body.data;
    expect(out.signedOff).toBe(true);
    expect(out.seaServiceDays).toBeGreaterThanOrEqual(1);
    expect(out.seafarer).toMatchObject({ currentVesselId: null, currentVesselName: null, signedOnAt: null, status: 'SIGNED_OFF' });
    // the tour was already an open record from the day the seafarer went aboard, so signing off closes it rather than writing a second one over the same days
    expect(out.seafarer.serviceRecords).toBe(before.serviceRecords);
    const written = out.seafarer.seaService.find((x: any) => x.vesselId === before.currentVesselId && x.from === before.signedOnAt);
    expect(written).toMatchObject({ verified: true, verifiedBy: 'Crewing Desk', remarks: 'Tour complete at Khor Fakkan' });
    expect(written.days).toBe(out.seaServiceDays);
    expect((await outbox(EVENTS.seafarers.signedOff)).length).toBe(1);
    expect((await outbox(EVENTS.seafarers.seaServiceVerified)).length).toBe(1);
    await post(`/seafarers/${onboard.id}/sign-off`, {}, desk).expect(400);
  });

  it('refuses to sign a suspended seafarer on, or to delete one still at sea', async () => {
    const vessel = await activeVessel();
    const suspended = (await g('/seafarers?status=SUSPENDED&limit=1')).body.data[0];
    if (suspended && !suspended.currentVesselId) await post(`/seafarers/${suspended.id}/sign-on`, { vesselId: vessel.id, override: true, overrideReason: 'x' }, desk).expect(409);
    const atSea = (await g('/seafarers?onboard=true&limit=1')).body.data[0];
    await del(`/seafarers/${atSea.id}`, desk).expect(409);
  });
});

describe('seafarers — the consumer', () => {
  const deps = () => ({ env, audit });
  it('projects the fleet and renames a ship across the records that name her', async () => {
    const vessel = await activeVessel();
    const onboard = (await g(`/seafarers?currentVesselId=${vessel.id}&limit=1`)).body.data[0];
    const client = await pool.connect();
    try {
      await applyEvent(client, deps(), makeEvent({ type: EVENTS.readModel.upserted, source: 'ships', data: { kind: 'vessel', entity: { id: vessel.id, imo: '9700123', name: `${vessel.name} II`, type: 'BULK', flag: 'United Arab Emirates', status: 'ACTIVE' } } }));
    } finally { client.release(); }
    const named = (await pool.query<{ name: string }>('SELECT name FROM vessels WHERE id = $1', [vessel.id])).rows[0];
    expect(named.name).toBe(`${vessel.name} II`);
    if (onboard) {
      const after = (await g(`/seafarers/${onboard.id}`)).body.data;
      expect(after.currentVesselName).toBe(`${vessel.name} II`);
      expect(after.seaService.filter((x: any) => x.vesselId === vessel.id).every((x: any) => x.vesselName === `${vessel.name} II`)).toBe(true);
    }
    // put the register back so later assertions read the seeded name
    const back = await pool.connect();
    try {
      await applyEvent(back, deps(), makeEvent({ type: EVENTS.readModel.upserted, source: 'ships', data: { kind: 'vessel', entity: { id: vessel.id, imo: '9700123', name: vessel.name, type: 'BULK', flag: 'United Arab Emirates', status: 'ACTIVE' } } }));
    } finally { back.release(); }
  });

  it('ignores an instrument raised against something other than a seafarer, and its own snapshots', async () => {
    const before = (await pool.query('SELECT count(*) AS n FROM seafarer_certificates')).rows[0].n;
    const client = await pool.connect();
    try {
      await applyEvent(client, deps(), makeEvent({ type: EVENTS.readModel.upserted, source: 'instruments', data: { kind: 'instrument', entity: { id: 'inst-vessel-1', subjectKind: 'VESSEL', subjectId: 'x', typeLabel: 'IOPP Certificate', expiryDate: iso(Date.now() + D) } } }));
      await applyEvent(client, deps(), makeEvent({ type: EVENTS.readModel.upserted, source: env.SERVICE_NAME, data: { kind: 'instrument', entity: { id: 'inst-echo-1', subjectKind: 'SEAFARER', subjectId: 'x', typeLabel: 'Echo', expiryDate: iso(Date.now() + D) } } }));
    } finally { client.release(); }
    expect((await pool.query('SELECT count(*) AS n FROM seafarer_certificates')).rows[0].n).toBe(before);
  });
});

/* ================================================== tenancy on the crew register === */

describe('seafarers — tenancy', () => {
  it('closes the register to a company entirely, by list, by id and by count', async () => {
    const all = await g('/seafarers?limit=1', admin);
    expect(all.body.meta.total).toBeGreaterThan(0);
    const closed = await g('/seafarers?limit=500', agentgss);
    expect(closed.status).toBe(200);
    expect(closed.body.meta.total).toBe(0);
    expect(closed.body.data).toHaveLength(0);

    const one = (await g('/seafarers?limit=1', admin)).body.data[0];
    expect((await g(`/seafarers/${one.id}`, agentgss)).status).toBe(404);
    expect((await g(`/seafarers/${one.id}/card`, agentgss)).status).toBe(404);
    expect((await g(`/seafarers/${one.id}`, admin)).status).toBe(200);
    /* The register holds a person's medical fitness, their discharge record and their certificate history.
     * A dashboard that counted them would leak how many there are and what state they are in. */
    const dash = await g('/seafarers/dashboard', agentgss);
    expect(dash.status).toBe(200);
    expect(dash.body.data.kpis.roll).toBe(0);
    expect((await g('/seafarers/dashboard', admin)).body.data.kpis.roll).toBeGreaterThan(0);
  });

  it('leaves a national desk reading the whole register, with no clause added at all', async () => {
    expect((await g('/seafarers?limit=1', desk)).body.meta.total).toBe((await g('/seafarers?limit=1', admin)).body.meta.total);
  });

  /*
   * The register used to name no employer at all, so it could only be national and a manning agency could
   * not be shown its own crew. It names the recruitment and placement service now, and partitions on it.
   */
  it('shows a manning agency the seafarers it placed, and only those', async () => {
    const national = (await g('/seafarers?limit=500', admin)).body;
    const mine = (await g('/seafarers?limit=500', mca)).body;
    const theirs = (await g('/seafarers?limit=500', anc)).body;

    expect(mine.meta.total).toBeGreaterThan(0);
    expect(theirs.meta.total).toBeGreaterThan(0);
    expect(mine.meta.total).toBeLessThan(national.meta.total);
    // the two agencies do not overlap, and neither is the whole register
    for (const s of mine.data) expect(s.manningAgentCode, `${s.name} is not an MCA placement`).toBe('MCA');
    for (const s of theirs.data) expect(s.manningAgentCode).toBe('ANC');
    expect(mine.meta.total + theirs.meta.total).toBeLessThan(national.meta.total);
  });

  it('answers "not found" for a seafarer another agency placed, and for one engaged direct', async () => {
    const all = (await g('/seafarers?limit=500', admin)).body.data as { id: string; manningAgentCode: string }[];
    const other = all.find((s) => s.manningAgentCode === 'ANC')!;
    const direct = all.find((s) => !s.manningAgentCode);
    expect((await g(`/seafarers/${other.id}`, mca)).status).toBe(404);
    expect((await g(`/seafarers/${other.id}/card`, mca)).status).toBe(404);
    if (direct) {
      // no agent means the administration's own record, not one shared with every agency for want of an owner
      expect((await g(`/seafarers/${direct.id}`, mca)).status).toBe(404);
      expect((await g(`/seafarers/${direct.id}`, admin)).status).toBe(200);
    }
  });

  it('counts only its own placements in the crew dashboard', async () => {
    const mine = (await g('/seafarers/dashboard', mca)).body.data.kpis;
    const national = (await g('/seafarers/dashboard', admin)).body.data.kpis;
    const listed = (await g('/seafarers?limit=500', mca)).body.meta.total;
    expect(mine.roll).toBe(listed);
    expect(mine.roll).toBeLessThan(national.roll);
    expect(mine.onboard + mine.ashore).toBe(mine.roll);
  });

  it('places a new seafarer with the agency that created them, whatever the request asked for', async () => {
    const created = await post('/seafarers', {
      name: 'Probe Placement', cdcNo: `AUH-PROBE-${Date.now()}`, rank: 'Able Seaman', nationality: 'India',
      manningAgentCode: 'ANC', manningAgentName: 'Anchor Crew Management',
    }, mca);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    // the agent on the record is the author's own; an agency cannot place a seafarer under another licence
    expect(created.body.data.manningAgentCode).toBe('MCA');
    expect((await g(`/seafarers/${created.body.data.id}`, mca)).status).toBe(200);
    expect((await g(`/seafarers/${created.body.data.id}`, anc)).status).toBe(404);
    await del(`/seafarers/${created.body.data.id}`, admin);
  });

  it('still closes the register to a company that places nobody', async () => {
    expect((await g('/seafarers?limit=500', agentgss)).body.meta.total).toBe(0);
  });
});

/* ------------------------------------------------------------------ phase 3: vocabularies --- */

describe('seafarers — vocabularies from the masters', () => {
  it('serves ranks and document types from the mirror, accepts a code or a label, and refuses what the master does not know', async () => {
    const ref = (await g('/seafarers/reference').expect(200)).body.data;
    expect(ref.ranks.find((r: any) => r.code === 'MASTER')).toMatchObject({ label: 'Master', labelAr: 'الربان', officer: true, cocGrade: 'MASTER', department: 'DECK' });
    expect(ref.certTypes.find((r: any) => r.code === 'MEDICAL')).toMatchObject({ kind: 'MEDICAL', mandatory: true, validityMonths: 24 });
    expect(ref.mandatory).toEqual(expect.arrayContaining(['COC', 'MEDICAL', 'BST', 'CDC']));
    const byCode = (await post('/seafarers', { name: 'Vocabulary Test', cdcNo: 'CDC-VOCAB-1', rank: 'CHIEF_OFFICER' }, desk).expect(201)).body.data;
    expect(byCode).toMatchObject({ rank: 'Chief Officer', rankCode: 'CHIEF_OFFICER' });
    const byLabel = (await put(`/seafarers/${byCode.id}`, { rank: 'second officer' }, desk).expect(200)).body.data;
    expect(byLabel).toMatchObject({ rank: 'Second Officer', rankCode: 'SECOND_OFFICER' });
    expect((await g('/seafarers?rank=SECOND_OFFICER&limit=200')).body.data.some((s: any) => s.id === byCode.id)).toBe(true);
    expect((await g('/seafarers?rank=Second%20Officer&limit=200')).body.data.some((s: any) => s.id === byCode.id)).toBe(true);
    const refused = await post('/seafarers', { name: 'No Such Rank', cdcNo: 'CDC-VOCAB-2', rank: 'Admiral' }, desk).expect(400);
    expect(refused.body.error?.message ?? refused.body.message).toContain('seafarerRank');
    const cert = (await post(`/seafarers/${byCode.id}/certificates`, { certType: 'MEDICAL', expiryDate: iso(Date.now() + 400 * D) }, desk).expect(201)).body.data;
    expect(cert.certificates.find((c: any) => c.certCode === 'MEDICAL')).toMatchObject({ certType: 'Medical Fitness (ILO/MLC)', kind: 'MEDICAL' });
    await post(`/seafarers/${byCode.id}/certificates`, { certType: 'Diving Ticket', expiryDate: iso(Date.now() + 400 * D) }, desk).expect(400);
    await post(`/seafarers/${byCode.id}/service`, { vesselName: 'MV Test', rank: 'Cabin Boy', from: iso(Date.now() - 100 * D), to: iso(Date.now() - 10 * D) }, desk).expect(400);
    const tour = (await post(`/seafarers/${byCode.id}/service`, { vesselName: 'MV Test', rank: 'AB', from: iso(Date.now() - 100 * D), to: iso(Date.now() - 10 * D) }, desk).expect(201)).body.data;
    expect(tour.seaService[0]).toMatchObject({ rank: 'Able Seaman', rankCode: 'AB' });
    await del(`/seafarers/${byCode.id}`, desk).expect(200);
  });

  it('re-derives the codes on rows written under labels when the rank master changes', async () => {
    const one = (await pool.query<{ id: string }>(`SELECT id FROM seafarers WHERE rank = 'Master' LIMIT 1`)).rows[0];
    await pool.query(`UPDATE seafarers SET rank_code = '' WHERE id = $1`, [one.id]);
    const client = await pool.connect();
    try {
      await applyEvent(client, { env, audit }, makeEvent({ type: EVENTS.mdm.lookupChanged, source: 'mdm', data: { category: 'seafarerRank', code: 'MASTER', change: 'updated', count: 18, lookup: { category: 'seafarerRank', code: 'MASTER', label: 'Master', labelAr: 'الربان', meta: { department: 'DECK', officer: true, cocGrade: 'MASTER', order: 1 }, active: true } } }));
    } finally { client.release(); }
    expect((await pool.query<{ rank_code: string }>('SELECT rank_code FROM seafarers WHERE id = $1', [one.id])).rows[0].rank_code).toBe('MASTER');
    // the sign-on gate reads the master: an entry marked mandatory is demanded by its label
    const rules = (await g('/seafarers/reference')).body.data.certTypes;
    const gate = documentGate([{ certType: 'Medical Fitness (ILO/MLC)', certCode: 'MEDICAL', expiryDate: iso(Date.now() + 200 * D) }], { COC_VERIFY_ON_SIGN_ON: true, SIGN_ON_MARGIN_DAYS: 30 } as never, new Date(), rules);
    expect(gate.failures).toEqual(expect.arrayContaining(['Certificate of Competency: not on file', 'STCW Basic Safety Training: not on file', 'Certificate of Discharge (CDC): not on file']));
    expect(gate.failures.some((f) => f.startsWith('Medical'))).toBe(false);
  });
});

/* ---------------------------------------------------------------- phase 3: the MET register --- */

describe('seafarers — the MET register', () => {
  let amiId: string; let amiCompanyId: string;
  it('seeds the providers, their programmes and the sector dashboard from the masters', async () => {
    const list = (await g('/seafarers/met/institutions?limit=50').expect(200)).body;
    expect(list.meta.total).toBe(2);
    const academy = list.data.find((i: any) => i.code === 'AMI'); amiId = academy.id; amiCompanyId = academy.companyId;
    // the world's academy belongs to a suspended company, so its accreditation instrument is suspended and the register says so
    expect(academy).toMatchObject({ institutionType: 'ACADEMY', status: 'SUSPENDED', accredited: false, programmeCount: 12, approvedProgrammes: 9, pendingProgrammes: 1, suspendedProgrammes: 1 });
    expect(academy.accreditation.status).toBe('SUSPENDED'); expect(academy.accreditation.reason).toContain('suspended');
    expect(academy.accreditation.instrumentNo).toMatch(/^MET-/); expect(academy.accreditation.cycleNo).toBeGreaterThan(0);
    expect(academy.simulators.length).toBeGreaterThan(2);
    const centre = list.data.find((i: any) => i.code === 'KRM');
    expect(centre).toMatchObject({ institutionType: 'TRAINING_CENTRE', accredited: false, programmeCount: 4 });
    expect(centre.accreditation.status).toBe('NONE');
    const dash = (await g('/seafarers/met/dashboard').expect(200)).body.data;
    expect(dash.kpis).toMatchObject({ institutions: 2, accredited: 0, suspended: 1, unaccredited: 1, programmes: 16, approved: 12, pending: 2, suspendedProgrammes: 1, programmesInMaster: 12 });
    expect(dash.kpis.seatsPerYear).toBeGreaterThan(100);
    expect(dash.byProgramme[0].providers).toBeGreaterThan(0);
    expect(dash.attention.map((a: any) => a.code).sort()).toEqual(['AMI', 'KRM']);
    const catalogue = (await g('/seafarers/met/programmes').expect(200)).body.data;
    expect(catalogue).toHaveLength(12);
    expect(catalogue.find((p: any) => p.programme === 'BST')).toMatchObject({ title: 'Basic Safety Training', regulation: 'VI/1', approved: 2 });
    const ref = (await g('/seafarers/met/reference').expect(200)).body.data;
    expect(ref.institutionTypes.map((t: any) => t.code)).toContain('SIMULATOR_CENTRE');
    expect(ref.schemes).toEqual(['MET_INSTITUTION']);
    expect((await g('/seafarers/met/institutions?programme=DECK_OOW')).body.meta.total).toBe(1);
    expect((await g('/seafarers/met/institutions?accreditationStatus=NONE')).body.meta.total).toBe(1);
  });

  it('registers a provider, approves programmes from the master and refuses what the masters do not know', async () => {
    await clearOutbox();
    await post('/seafarers/met/institutions', { companyId: 'co-test-met', code: 'TMT', name: 'Test Maritime Training', institutionType: 'CIRCUS' }, desk).expect(400);
    const created = (await post('/seafarers/met/institutions', { companyId: 'co-test-met', code: 'tmt', name: 'Test Maritime Training', institutionType: 'TRAINING_CENTRE', city: 'Fujairah', instructors: 4, simulators: ['GMDSS'] }, desk).expect(201)).body.data;
    expect(created).toMatchObject({ code: 'TMT', institutionType: 'TRAINING_CENTRE', status: 'ACTIVE', accredited: false, programmeCount: 0 });
    expect(created.accreditation.status).toBe('NONE');
    await post('/seafarers/met/institutions', { companyId: 'co-test-met', code: 'TMT', name: 'Again', institutionType: 'TRAINING_CENTRE' }, desk).expect(409);
    await post('/seafarers/met/institutions', { companyId: 'x', code: 'NOP', name: 'No permission', institutionType: 'TRAINING_CENTRE' }, clerk).expect(403);
    expect((await outbox(EVENTS.seafarers.metInstitutionRegistered)).length).toBe(1);
    await post(`/seafarers/met/institutions/${created.id}/programmes`, { programme: 'UNDERWATER_BASKET_WEAVING', approvalNo: 'PA-X' }, desk).expect(400);
    await post(`/seafarers/met/institutions/${created.id}/programmes`, { programme: 'BST', status: 'APPROVED' }, desk).expect(400); // an approval carries its number
    const approved = (await post(`/seafarers/met/institutions/${created.id}/programmes`, { programme: 'bst', seatsPerIntake: 16, intakesPerYear: 8, approvalNo: 'PA-2026-9001' }, desk).expect(201)).body.data;
    expect(approved.programme).toMatchObject({ programme: 'BST', title: 'Basic Safety Training', regulation: 'VI/1', status: 'APPROVED', seatsPerYear: 128 });
    expect(approved.programme.expiresOn).toBeTruthy();
    expect(approved.institution).toMatchObject({ approvedProgrammes: 1, seatsPerYear: 128 });
    await post(`/seafarers/met/institutions/${created.id}/programmes`, { programme: 'BST', approvalNo: 'PA-2026-9002' }, desk).expect(409);
    const pending = (await post(`/seafarers/met/institutions/${created.id}/programmes`, { programme: 'ECDIS', seatsPerIntake: 8, intakesPerYear: 6 }, desk).expect(201)).body.data.programme;
    expect(pending.status).toBe('PENDING');
    expect((await outbox(EVENTS.seafarers.programmeApproved)).length).toBe(1);
    const suspended = (await put(`/seafarers/met/institutions/${created.id}/programmes/${approved.programme.id}`, { status: 'SUSPENDED', statusReason: 'Instructor left; no replacement notified' }, desk).expect(200)).body.data;
    expect(suspended).toMatchObject({ status: 'SUSPENDED', statusReason: 'Instructor left; no replacement notified' });
    const withdrawn = (await post(`/seafarers/met/institutions/${created.id}/programmes/${pending.id}/withdraw`, { reason: 'Withdrawn at the institution\'s request' }, desk).expect(201)).body.data;
    expect(withdrawn.status).toBe('WITHDRAWN');
    expect((await outbox(EVENTS.seafarers.programmeWithdrawn)).length).toBe(1);
    const closed = (await post(`/seafarers/met/institutions/${created.id}/status`, { status: 'SUSPENDED', reason: 'Quality standards system evaluation overdue' }, desk).expect(201)).body.data;
    expect(closed).toMatchObject({ status: 'SUSPENDED', statusReason: 'Quality standards system evaluation overdue' });
    await post(`/seafarers/met/institutions/${created.id}/programmes`, { programme: 'AFF', approvalNo: 'PA-2026-9003' }, desk).expect(409);
    expect((await g(`/seafarers/met/institutions/${created.id}`)).body.data.programmes).toHaveLength(2);
    expect((await g('/seafarers/met/institutions/TMT')).body.data.id).toBe(created.id);
  });

  it('mirrors the accreditation cycle from the facilities service and the instruments from the register', async () => {
    const client = await pool.connect();
    const fire = (type: string, data: Record<string, unknown>) => applyEvent(client, { env, audit }, makeEvent({ type, source: 'facilities', data }));
    try {
      await clearOutbox();
      await fire(EVENTS.facilities.accreditationDue, { companyId: amiCompanyId, category: 'MET_INSTITUTION', cycleNo: 3, daysLeft: 30, endsOn: iso(Date.now() + 30 * D), instrumentNo: 'MET-2026-0007' });
      let inst = (await g(`/seafarers/met/institutions/${amiId}`)).body.data;
      expect(inst.accreditation).toMatchObject({ status: 'DUE', cycleNo: 3, instrumentNo: 'MET-2026-0007' });
      expect(inst.accredited).toBe(true);
      const changed = await outbox(EVENTS.seafarers.metAccreditationChanged);
      expect(changed).toHaveLength(1); expect(changed[0].data).toMatchObject({ status: 'DUE', cycleNo: 3 });
      // a cycle under an industry scheme is not this register's business
      await fire(EVENTS.facilities.accreditationExpired, { companyId: amiCompanyId, category: 'PEST_CONTROL', cycleNo: 1 });
      expect((await g(`/seafarers/met/institutions/${amiId}`)).body.data.accreditation.status).toBe('DUE');
      await fire(EVENTS.facilities.accreditationExpired, { companyId: amiCompanyId, category: 'MET_INSTITUTION', cycleNo: 3, reason: 'Cycle ended without renewal' });
      inst = (await g(`/seafarers/met/institutions/${amiId}`)).body.data;
      expect(inst.accreditation).toMatchObject({ status: 'EXPIRED', reason: 'Cycle ended without renewal' }); expect(inst.accredited).toBe(false);
      await fire(EVENTS.facilities.accreditationRenewed, { companyId: amiCompanyId, category: 'MET_INSTITUTION', cycleNo: 4, change: 'renewed', startsOn: iso(Date.now()), endsOn: iso(Date.now() + 365 * D), instrumentId: 'inst-met-4', instrumentNo: 'MET-2026-0008' });
      inst = (await g(`/seafarers/met/institutions/${amiId}`)).body.data;
      expect(inst.accreditation).toMatchObject({ status: 'CURRENT', cycleNo: 4, instrumentNo: 'MET-2026-0008' });
      // a programme approval issued on the instrument register lands on the programme it names
      await applyEvent(client, { env, audit }, makeEvent({ type: EVENTS.readModel.upserted, source: 'instruments', data: { kind: 'instrument', entity: { id: 'inst-mpa-brm', number: 'MPA-2026-0099', subjectKind: 'MET_INSTITUTION', subjectId: amiCompanyId, entityName: 'Arabian Maritime Institute', entityType: 'MET_PROGRAMME_APPROVAL', status: 'ISSUED', issueDate: iso(Date.now()), expiryDate: iso(Date.now() + 5 * 365 * D), particulars: { programme: 'BRM' } } } }));
      inst = (await g(`/seafarers/met/institutions/${amiId}`)).body.data;
      expect(inst.programmes.find((p: any) => p.programme === 'BRM')).toMatchObject({ status: 'APPROVED', approvalNo: 'MPA-2026-0099', instrumentId: 'inst-mpa-brm' });
      // master data renames the company; the register follows
      await applyEvent(client, { env, audit }, makeEvent({ type: EVENTS.mdm.companyUpserted, source: 'mdm', data: { companyId: amiCompanyId, code: 'AMI', name: 'Arabian Maritime Institute (Abu Dhabi)' } }));
      expect((await g(`/seafarers/met/institutions/${amiId}`)).body.data.name).toBe('Arabian Maritime Institute (Abu Dhabi)');
    } finally { client.release(); }
  });

  it('shows a provider its own row and nobody else\'s', async () => {
    const mine = (await g('/seafarers/met/institutions', ami).expect(200)).body;
    expect(mine.meta.total).toBe(1); expect(mine.data[0].code).toBe('AMI');
    await g('/seafarers/met/institutions/KRM', ami).expect(404);
    await g('/seafarers/met/institutions/AMI', ami).expect(200);
    expect((await g('/seafarers/met/dashboard', ami)).body.data.kpis.institutions).toBe(1);
    await g('/seafarers/met/institutions', nobody).expect(403);
  });
});

/* ------------------------------------------------- phase 3: safe manning and the FAL-5 crew list --- */

describe('seafarers — safe manning and crew lists', () => {
  /** A national-flag ship of the fictional fleet with a recent call, and the register seafarer with clean papers who will be listed aboard her. */
  let vesselId: string; let vcn: string; let agentCode: string; let seafarer: any;
  beforeAll(async () => {
    const call = (await pool.query<{ vessel_id: string; vcn: string; agent_code: string }>(`SELECT pc.vessel_id, pc.vcn, pc.agent_code FROM port_calls pc JOIN vessels v ON v.id = pc.vessel_id WHERE v.flag = 'AE' AND NOT v.real AND v.status = 'ACTIVE' AND pc.status <> 'CANCELLED' ORDER BY pc.eta DESC LIMIT 1`)).rows[0];
    vesselId = call.vessel_id; vcn = call.vcn; agentCode = call.agent_code;
    seafarer = (await g(`/seafarers/${await ashoreWithGoodPapers()}`)).body.data;
  });

  it('seeds a scale for every active ship, read against who the register has aboard', async () => {
    const scales = (await g('/seafarers/manning?limit=100').expect(200)).body;
    expect(scales.meta.total).toBeGreaterThanOrEqual(20);
    for (const s of scales.body?.data ?? scales.data) { expect(s.rows.length).toBeGreaterThan(5); expect(s.compliance).toBeTruthy(); expect(s.tradingAreaLabel).not.toBe(''); }
    expect(scales.data.filter((s: any) => s.documented).length).toBeGreaterThan(0);
    const one = (await g(`/seafarers/manning/${vesselId}`).expect(200)).body.data;
    expect(one.rows.find((r: any) => r.rankCode === 'MASTER')).toMatchObject({ rank: 'Master', count: 1, cocGrade: 'MASTER', cocGradeLabel: 'Master' });
    expect(one.compliance.required).toBe(one.total);
    expect(Array.isArray(one.onBoard)).toBe(true);
    await g('/seafarers/manning', agentgss).expect(404);
  });

  it('records a scale from the masters and refuses a rank, a grade or an area the masters do not know', async () => {
    await put(`/seafarers/manning/${vesselId}`, { tradingArea: 'MOON', rows: [{ rank: 'MASTER', count: 1 }] }, desk).expect(400);
    await put(`/seafarers/manning/${vesselId}`, { tradingArea: 'GULF', rows: [{ rank: 'Admiral', count: 1 }] }, desk).expect(400);
    await put(`/seafarers/manning/${vesselId}`, { tradingArea: 'GULF', rows: [{ rank: 'MASTER', count: 1, cocGrade: 'GENIUS' }] }, desk).expect(400);
    await put(`/seafarers/manning/${vesselId}`, { tradingArea: 'GULF', rows: [{ rank: 'AB', count: 1 }, { rank: 'Able Seaman', count: 2 }] }, desk).expect(400);
    await clearOutbox();
    const saved = (await put(`/seafarers/manning/${vesselId}`, { tradingArea: 'GULF', msmdNo: 'MSMD-TEST-1', rows: [{ rank: 'MASTER', count: 1 }, { rank: 'Chief Officer', count: 1 }, { rank: 'CHIEF_ENGINEER', count: 1 }, { rank: 'AB', count: 2 }, { rank: 'COOK', count: 1 }] }, desk).expect(200)).body.data;
    expect(saved).toMatchObject({ tradingArea: 'GULF', msmdNo: 'MSMD-TEST-1', total: 6, officers: 3, recorded: true, documented: true });
    expect(saved.rows[0]).toMatchObject({ rankCode: 'MASTER', cocGrade: 'MASTER' });
    expect(saved.rows[3]).toMatchObject({ rankCode: 'AB', rank: 'Able Seaman', count: 2, cocGrade: '' });
    expect((await outbox(EVENTS.seafarers.manningScaleRecorded)).length).toBe(1);
    await put('/seafarers/manning/no-such-ship', { tradingArea: 'GULF', rows: [{ rank: 'MASTER', count: 1 }] }, desk).expect(404);
  });

  it('receives a FAL-5 list, matches it to the register and the ledger, and reads it against the scale', async () => {
    await clearOutbox();
    const rows = [
      { familyName: seafarer.name.split(' ').slice(1).join(' ') || seafarer.name, givenNames: seafarer.name.split(' ')[0], rank: seafarer.rank, nationality: seafarer.nationality, idType: 'Passport', idNumber: 'X-IGNORED', cdcNo: seafarer.cdcNo },
      { familyName: 'Santos', givenNames: 'Ramon', rank: 'Chief Officer', nationality: 'Philippines', idType: 'Passport', idNumber: 'PH7000001', idExpiry: iso(Date.now() + 900 * D), dob: '1984-03-02' },
      { familyName: 'Al Marzouqi', givenNames: 'Saeed', rank: 'OS', nationality: 'United Arab Emirates', idType: 'Emirates ID', idNumber: '784-1999-9999999-9 (sample)' },
      { familyName: 'Hidayat', givenNames: 'Wawan', rank: 'Oiler', nationality: 'Indonesia', idType: 'Passport', idNumber: 'ID7000002', idExpiry: iso(Date.now() - 20 * D) },
      { familyName: 'Nobody', givenNames: 'Rank', rank: 'Cabin Boy', nationality: 'India', idType: 'Passport', idNumber: 'IN7000003' },
    ];
    await post('/seafarers/crew-lists', { vcn, source: 'PIGEON', rows }, desk).expect(400);
    await post('/seafarers/crew-lists', { vcn: 'MAR-1999-0001', source: 'MSW', rows }, desk).expect(400);
    await post('/seafarers/crew-lists', { source: 'MSW', rows }, desk).expect(400);
    const list = (await post('/seafarers/crew-lists', { vcn, source: 'MSW', declaredCrew: 6, rows }, desk).expect(201)).body.data;
    expect(list).toMatchObject({ vcn, vesselId, status: 'CHECKED', source: 'MSW', rowCount: 5, matched: 1, foreignCount: 3, declaredCrew: 6, ok: false, agentCode });
    expect(list.number).toMatch(/^CL-\d{4}-\d{4}$/);
    const line = (name: string) => list.rows.find((r: any) => r.familyName === name);
    expect(list.rows[0]).toMatchObject({ match: 'REGISTER', seafarerId: seafarer.id, cdcNo: seafarer.cdcNo });
    expect(line('Santos')).toMatchObject({ match: 'FOREIGN', rankCode: 'CHIEF_OFFICER', rank: 'Chief Officer' });
    expect(line('Santos').foreignId).toBeTruthy();
    expect(line('Al Marzouqi')).toMatchObject({ match: 'UNREGISTERED_NATIONAL', issues: ['National of the flag not on the seafarer register'] });
    expect(line('Hidayat').issues[0]).toContain('expired');
    expect(line('Nobody')).toMatchObject({ rankCode: '' });
    expect(line('Nobody').issues[0]).toContain('seafarerRank');
    const ck = list.checks;
    expect(ck.nationalFlag).toBe(true); expect(ck.scaleRecorded).toBe(true); expect(ck.msmdNo).toBe('MSMD-TEST-1');
    expect(ck.manning).toMatchObject({ required: 6, ok: false }); expect(ck.manning.shortfalls).toBeGreaterThan(0);
    expect(ck.manning.rows.find((r: any) => r.rankCode === 'CHIEF_OFFICER')).toMatchObject({ required: 1, listed: 1, shortfall: 0 });
    expect(ck.endorsements).toHaveLength(1); expect(ck.endorsements[0].issue).toContain('STCW I/10');
    expect(ck.unregisteredNationals).toHaveLength(1); expect(ck.identity).toHaveLength(1); expect(ck.unknownRanks).toHaveLength(1);
    expect(ck.declaration).toEqual({ declared: 6, listed: 5, matches: false });
    expect(ck.summary.length).toBeGreaterThanOrEqual(5);
    expect((await outbox(EVENTS.seafarers.crewListReceived)).length).toBe(1);
    expect((await outbox(EVENTS.seafarers.crewListChecked)).length).toBe(1);
    expect((await outbox(EVENTS.seafarers.foreignRecorded)).length).toBe(3);
    // the desk cannot wave a short list through without saying so
    await post(`/seafarers/crew-lists/${list.id}/clear`, {}, desk).expect(409);
    await post(`/seafarers/crew-lists/${list.id}/query`, {}, desk).expect(400);
    await clearOutbox();
    const cleared = (await post(`/seafarers/crew-lists/${list.id}/clear`, { note: 'Master to present the missing ratings at the next call; agent informed' }, desk).expect(201)).body.data;
    expect(cleared).toMatchObject({ status: 'CLEARED', decidedBy: 'Crewing Desk' });
    expect((await outbox(EVENTS.seafarers.crewListCleared))[0].data).toMatchObject({ overridden: true });
    expect((await outbox(EVENTS.audit.recorded)).some((e) => e.data.action === 'CREW_LIST_CLEARED' && String(e.data.note).startsWith('OVERRIDE'))).toBe(true);
    // the same foreign officer on the next list is the same ledger entry, seen twice
    const again = (await post('/seafarers/crew-lists', { vcn, movement: 'DEPARTURE', source: 'AGENT_PORTAL', rows: [rows[1]] }, desk).expect(201)).body.data;
    expect(again.rows[0].foreignId).toBe(line('Santos').foreignId);
    const entry = (await g(`/seafarers/foreign/${again.rows[0].foreignId}`).expect(200)).body.data;
    expect(entry).toMatchObject({ name: 'Ramon Santos', nationality: 'Philippines', appearances: 2, lastRankCode: 'CHIEF_OFFICER', status: 'LEDGER' });
    expect(entry.appearanceList).toHaveLength(2);
    const queried = (await post(`/seafarers/crew-lists/${again.id}/query`, { note: 'List names one person; general declaration awaited' }, desk).expect(201)).body.data;
    expect(queried.status).toBe('QUERIED');
    expect((await outbox(EVENTS.seafarers.crewListQueried)).length).toBe(1);
    const rechecked = (await post(`/seafarers/crew-lists/${again.id}/check`, {}, desk).expect(201)).body.data;
    expect(rechecked.status).toBe('QUERIED');
    expect((await g(`/seafarers/crew-lists/${list.number}`)).body.data.id).toBe(list.id);
    expect((await g('/seafarers/crew-lists?ok=false&limit=5')).body.data.every((l: any) => l.ok === false)).toBe(true);
    await post(`/seafarers/crew-lists/${list.id}/clear`, { note: 'x' }, clerk).expect(403);
  });

  it('keeps the foreign ledger: the endorsement lifts the finding, and a reconciliation re-points the lines', async () => {
    const ledger = (await g('/seafarers/foreign?limit=200').expect(200)).body;
    expect(ledger.meta.total).toBeGreaterThan(20);
    expect(ledger.data.some((f: any) => f.appearances > 1)).toBe(true);
    expect(ledger.data.every((f: any) => f.idNumber && f.nationality)).toBe(true);
    const officers = (await g('/seafarers/foreign?officer=true&limit=200')).body.data;
    expect(officers.length).toBeGreaterThan(0);
    const santos = ledger.data.find((f: any) => f.idNumber === 'PH7000001');
    await post(`/seafarers/foreign/${santos.id}/endorsement`, { number: 'FSE-2026-0100', expiryDate: iso(Date.now() - D) }, desk).expect(400);
    const endorsed = (await post(`/seafarers/foreign/${santos.id}/endorsement`, { number: 'FSE-2026-0100', expiryDate: iso(Date.now() + 700 * D) }, desk).expect(201)).body.data;
    expect(endorsed.endorsement).toMatchObject({ number: 'FSE-2026-0100', valid: true });
    expect(endorsed.endorsement.issuer).toContain('Maritime Sector');
    // re-reading the list finds the endorsement and drops the finding
    const listId = (await g(`/seafarers/foreign/${santos.id}`)).body.data.appearanceList[0].crewListId;
    const rechecked = (await post(`/seafarers/crew-lists/${listId}/check`, {}, desk).expect(201)).body.data;
    expect(rechecked.checks.endorsements).toHaveLength(0);
    // a ledger entry that turns out to be a person the register already knows
    const hidayat = ledger.data.find((f: any) => f.idNumber === 'ID7000002');
    const target = (await g('/seafarers?onboard=false&limit=1&sort=name')).body.data[0];
    await clearOutbox();
    const reconciled = (await post(`/seafarers/foreign/${hidayat.id}/reconcile`, { seafarerId: target.id, note: 'Same person; register entry under the seafarer identity number' }, desk).expect(201)).body.data;
    expect(reconciled).toMatchObject({ status: 'RECONCILED', reconciledSeafarerId: target.id, relinked: 1 });
    expect((await outbox(EVENTS.seafarers.foreignReconciled)).length).toBe(1);
    expect((await pool.query(`SELECT match, seafarer_id FROM crew_list_rows WHERE foreign_id = $1`, [hidayat.id])).rows[0]).toMatchObject({ match: 'REGISTER', seafarer_id: target.id });
    await post(`/seafarers/foreign/${hidayat.id}/reconcile`, { seafarerId: 'no-such' }, desk).expect(404);
    await g('/seafarers/foreign', agentgss).expect(200).then((r) => expect(r.body.meta.total).toBe(0));
    await g(`/seafarers/foreign/${santos.id}`, agentgss).expect(404);
  });

  it('lets an agent lodge a list for its own call and read only its own lists', async () => {
    const own = (await pool.query<{ vcn: string }>(`SELECT pc.vcn FROM port_calls pc JOIN vessels v ON v.id = pc.vessel_id WHERE pc.agent_code = 'GSS' AND NOT v.real AND v.status = 'ACTIVE' ORDER BY pc.eta DESC LIMIT 1`)).rows[0];
    const other = (await pool.query<{ vcn: string }>(`SELECT pc.vcn FROM port_calls pc JOIN vessels v ON v.id = pc.vessel_id WHERE pc.agent_code <> 'GSS' AND pc.agent_code <> '' AND NOT v.real AND v.status = 'ACTIVE' ORDER BY pc.eta DESC LIMIT 1`)).rows[0];
    const rows = [{ familyName: 'Reyes', givenNames: 'Jose', rank: 'AB', nationality: 'Philippines', idNumber: 'PH7000010', idExpiry: iso(Date.now() + 500 * D) }];
    await post('/seafarers/crew-lists', { vcn: other.vcn, source: 'AGENT_PORTAL', rows }, agentgss).expect(403);
    const mine = (await post('/seafarers/crew-lists', { vcn: own.vcn, source: 'AGENT_PORTAL', rows }, agentgss).expect(201)).body.data;
    expect(mine.agentCode).toBe('GSS');
    const seen = (await g('/seafarers/crew-lists?limit=200', agentgss).expect(200)).body;
    expect(seen.meta.total).toBeGreaterThan(0); expect(seen.data.every((l: any) => l.agentCode === 'GSS')).toBe(true);
    const notMine = (await g('/seafarers/crew-lists?limit=200')).body.data.find((l: any) => l.agentCode !== 'GSS');
    await g(`/seafarers/crew-lists/${notMine.id}`, agentgss).expect(404);
    await g(`/seafarers/crew-lists/${mine.id}`, agentgss).expect(200);
    // the agent sees the finding but does not decide the list
    await post(`/seafarers/crew-lists/${mine.id}/clear`, { note: 'x' }, agentgss).expect(403);
    const dash = (await g('/seafarers/crew-lists/dashboard', agentgss).expect(200)).body.data;
    expect(dash.kpis.ledger).toBe(0);
  });

  it('projects a port call and a minimum safe manning document from their registers', async () => {
    const client = await pool.connect();
    try {
      await applyEvent(client, { env, audit }, makeEvent({ type: EVENTS.readModel.upserted, source: 'ports', data: { kind: 'portCall', entity: { id: 'pc-test-1', vcn: 'MAR-2099-0001', vesselId, vesselName: 'Ignored — the snapshot names the ship', agentCode: 'GSS', agentName: 'Gulf Star Shipping Agency LLC', status: 'BERTHED', eta: iso(Date.now()), crew: { count: 19, master: 'A. Master' }, scope: { port: 'MAR', company: 'GSS' } } } }));
      await applyEvent(client, { env, audit }, makeEvent({ type: EVENTS.readModel.upserted, source: 'instruments', data: { kind: 'instrument', entity: { id: 'inst-msmd-1', number: 'MSMD-2026-0042', subjectKind: 'VESSEL', subjectId: vesselId, entityName: 'Ship', entityType: 'MINIMUM_SAFE_MANNING_DOCUMENT', status: 'ISSUED', issueDate: iso(Date.now() - 10 * D), expiryDate: null } } }));
    } finally { client.release(); }
    const list = (await post('/seafarers/crew-lists', { vcn: 'MAR-2099-0001', source: 'FAL_EDI', rows: [{ familyName: 'Garcia', givenNames: 'Marlon', rank: 'Cook', nationality: 'Philippines', idNumber: 'PH7000020' }] }, desk).expect(201)).body.data;
    expect(list).toMatchObject({ portCallId: 'pc-test-1', declaredCrew: 19, agentCode: 'GSS', agentName: 'Gulf Star Shipping Agency LLC' });
    expect(list.checks.declaration).toEqual({ declared: 19, listed: 1, matches: false });
    expect(list.checks.msmdNo).toBe('MSMD-2026-0042');
    const scale = (await g(`/seafarers/manning/${vesselId}`)).body.data;
    expect(scale).toMatchObject({ msmdNo: 'MSMD-2026-0042', instrumentId: 'inst-msmd-1', documented: true, total: 6 });
    const dash = (await g('/seafarers/crew-lists/dashboard').expect(200)).body.data;
    expect(dash.kpis.lists).toBeGreaterThan(20); expect(dash.kpis.ledger).toBeGreaterThan(20); expect(dash.bySource.length).toBeGreaterThan(1);
    expect(dash.kpis.cleared + dash.kpis.queried + dash.kpis.checked + dash.kpis.received).toBe(dash.kpis.lists);
    const ref = (await g('/seafarers/crew-lists/reference').expect(200)).body.data;
    expect(ref.sources.map((s: any) => s.code)).toContain('MSW'); expect(ref.tradingAreas.length).toBe(5); expect(ref.strictClearance).toBe(true);
  });
});
