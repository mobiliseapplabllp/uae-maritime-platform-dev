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
const mca = tok('manning-mca'); const anc = tok('manning-anc');
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
    const cert = (certType: string, days: number) => ({ certType, expiryDate: iso(Date.now() + days * D) } as never);
    expect(documentGate([cert('Medical Fitness (ILO/MLC)', 200), cert('Certificate of Competency', 400), cert('STCW Basic Safety Training', 300)], cfg).failures).toHaveLength(0);
    expect(documentGate([cert('Certificate of Competency', 400)], cfg).failures).toEqual(['Medical fitness (ILO/MLC): not on file']);
    expect(documentGate([cert('Medical Fitness (ILO/MLC)', -3), cert('Certificate of Competency', 400)], cfg).failures[0]).toContain('expired 3 days ago');
    expect(documentGate([cert('Medical Fitness (ILO/MLC)', 10), cert('Certificate of Competency', 400)], cfg).failures[0]).toContain('tour would outlast it');
    // basic safety training advises but does not by itself block
    expect(documentGate([cert('Medical Fitness (ILO/MLC)', 200), cert('Certificate of Competency', 400)], cfg).failures).toHaveLength(0);
    expect(documentGate([cert('Medical Fitness (ILO/MLC)', 200)], { ...cfg, COC_VERIFY_ON_SIGN_ON: false } as never).failures).toHaveLength(0);
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
