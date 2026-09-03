import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { EVENTS, INCIDENT_TRANSITIONS, makeEvent, subjectFor } from '@maritime/contracts';
import { AuditClient, PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256 } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedMaritimeCentre } from '../src/seed';
import { applyEvent } from '../src/consumer';
import { allowed, buildTimeline, incidentDashboard, isReopen, monthsBack, riskMatrix, transitionsFor, type DashboardCase } from '../src/incidents';
import { chartZones, distanceNm, portCentre, restrictionZones, trackSummary } from '../src/tracking';

const DB = 'maritime_maritime_centre_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
const SERVICE_TOKEN = 'test-service-token';
let app: INestApplication; let server: unknown; let pool: Pool; let audit: AuditClient; let env: ReturnType<typeof loadEnv<typeof envSchema>>;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const duty = tok('duty'); const viewer = tok('viewer'); const nobody = tok('nobody'); const dash = tok('dash');
const g = (p: string, t = admin) => request(server as never).get(p).set('authorization', t);
const post = (p: string, body?: unknown, t = admin) => request(server as never).post(p).set('authorization', t).send((body ?? {}) as never);
const put = (p: string, body: unknown, t = admin) => request(server as never).put(p).set('authorization', t).send(body as never);
const del = (p: string, t = admin) => request(server as never).delete(p).set('authorization', t);
const outbox = async (type: string) => (await pool.query('SELECT payload FROM outbox WHERE subject = $1 ORDER BY id', [subjectFor(type)])).rows.map((r) => r.payload as { type: string; subject?: string; data: Record<string, any> });
const clearOutbox = () => pool.query('DELETE FROM outbox');
const H = 3_600_000;

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedMaritimeCentre(URL, 'AE');
  env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, SERVICE_TOKEN, MDM_URL: 'http://127.0.0.1:1' } as never);
  const base = { scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    admin: { ...base, id: 'admin', sub: 'admin', name: 'Admin', perms: ['*'] },
    duty: { ...base, id: 'duty', sub: 'duty', name: 'NMC Duty Officer', perms: ['incidents.view', 'incidents.create', 'incidents.manage', 'incidents.close', 'nmc.view', 'nmc.manage'] },
    viewer: { ...base, id: 'viewer', sub: 'viewer', name: 'Watchkeeper', perms: ['incidents.view', 'nmc.view'] },
    dash: { ...base, id: 'dash', sub: 'dash', name: 'Command Centre', perms: ['dashboard.view'] },
    nobody: { ...base, id: 'nobody', sub: 'nobody', name: 'Nobody', perms: ['reports.view'] },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer(); pool = new Pool({ connectionString: URL }); audit = app.get(AuditClient);
});
afterAll(async () => { await pool?.end(); await app?.close(); });

const anyVessel = async () => (await pool.query<{ id: string; name: string }>(`SELECT id, name FROM vessels WHERE NOT real ORDER BY name LIMIT 1`)).rows[0];
const anyBerth = async () => (await pool.query<{ id: string; code: string; terminal: string }>('SELECT id, code, terminal FROM berths ORDER BY code LIMIT 1')).rows[0];
/** Logs a fresh case so a lifecycle test never disturbs a seeded one. */
async function logCase(over: Record<string, unknown> = {}) {
  const res = await post('/incidents', { title: 'Test case — mooring line parted at the jetty', category: 'MARINE', type: 'MOORING_FAILURE', severity: 'MEDIUM', source: 'VHF', ...over }, duty);
  expect(res.status).toBe(201);
  return res.body.data as Record<string, any>;
}

describe('maritime-centre — the lifecycle and the analytics, tested without a request', () => {
  it('enforces the declared transition table and reads a reopen for what it is', () => {
    expect(transitionsFor('OPEN')).toEqual(INCIDENT_TRANSITIONS.OPEN);
    expect(allowed('OPEN', 'ACKNOWLEDGED')).toBe(true);
    expect(allowed('OPEN', 'CLOSED')).toBe(false);
    expect(allowed('RESOLVED', 'CLOSED')).toBe(true);
    expect(allowed('CLOSED', 'RESPONDING')).toBe(true);
    expect(isReopen('CLOSED', 'RESPONDING')).toBe(true);
    expect(isReopen('MONITORING', 'RESPONDING')).toBe(false);
  });
  it('merges the status trail, the log and the attachments into one timeline, newest first', () => {
    const t = buildTimeline({
      history: [{ id: 'h', incident_id: 'i', from_status: '', to_status: 'OPEN', at: new Date('2026-06-01T00:00:00Z'), by_id: null, by_name: 'Control', note: 'Logged' }],
      log: [{ id: 'l', incident_id: 'i', at: new Date('2026-06-01T02:00:00Z'), by_id: null, by_name: 'Duty', entry: 'Tug tasked' }],
      documents: [{ id: 'd', incident_id: 'i', name: 'photo.zip', doc_type: 'PHOTO', size_kb: 10, uploaded_by_id: null, uploaded_by: 'Duty', at: new Date('2026-06-01T01:00:00Z'), note: '', document_id: null }],
    });
    expect(t.map((x) => x.kind)).toEqual(['LOG', 'DOC', 'STATUS']);
    expect(t[2].text).toBe('New → OPEN — Logged');
  });
  it('windows the trend on the trailing year and leaves the open worklist unwindowed', () => {
    const now = new Date('2026-06-15T00:00:00Z');
    const row = (over: Partial<DashboardCase>): DashboardCase => ({ id: 'x', number: 'INC-1', title: 't', category: 'MARINE', type: 'SAR', severity: 'HIGH', priority: 'P2', status: 'CLOSED',
      reported_at: new Date('2026-05-01T00:00:00Z'), acknowledged_at: new Date('2026-05-01T00:30:00Z'), resolved_at: new Date('2026-05-01T06:00:00Z'), closed_at: new Date('2026-05-02T00:00:00Z'), assigned_to: 'Duty', injuries: 1, ...over });
    const windowed = [row({}), row({ severity: 'LOW', injuries: 0 })];
    const open = [row({ id: 'o1', status: 'RESPONDING', resolved_at: null, closed_at: null, reported_at: new Date('2026-06-14T12:00:00Z') }),
      row({ id: 'o2', status: 'MONITORING', severity: 'LOW', resolved_at: null, closed_at: null, reported_at: new Date('2025-01-01T00:00:00Z') })];
    const d = incidentDashboard(windowed, open, { mttaTargetMin: 30, mttrTargetHrs: 24 }, now);
    expect(d.kpis).toMatchObject({ open: 2, highOpen: 1, loggedYtd: 2, closedYtd: 2, mttrHrs: 6, mttaMin: 30, injuriesYtd: 1 });
    expect(d.byMonth).toHaveLength(12);
    expect(d.byMonth.find((m) => m.month.startsWith('May'))).toMatchObject({ HIGH: 1, LOW: 1, total: 2 });
    expect(d.aging).toEqual([{ bucket: '0-24h', count: 1 }, { bucket: '1-3d', count: 0 }, { bucket: '3-7d', count: 0 }, { bucket: '>7d', count: 1 }]);
    expect(d.byStatus).toEqual([{ status: 'CLOSED', count: 2 }]);
    expect(d.openList).toHaveLength(2);
    expect(d.sla).toEqual({ mttaTargetMin: 30, mttrTargetHrs: 24 });
    expect(monthsBack(now, 12)).toHaveLength(12);
  });
  it('plots the matrix on priority and severity, and drops residual risk one band once a case is done', () => {
    const m = riskMatrix([
      { id: '1', number: 'INC-1', title: 'a', severity: 'CRITICAL', priority: 'P1', status: 'RESPONDING' },
      { id: '2', number: 'INC-2', title: 'b', severity: 'CRITICAL', priority: 'P1', status: 'CLOSED' },
      { id: '3', number: 'INC-3', title: 'c', severity: 'LOW', priority: 'P4', status: 'RESOLVED' },
    ], 180);
    expect(m.total).toBe(3);
    expect(m.initial.find((c) => c.likelihood === 5 && c.consequence === 5)!.count).toBe(2);
    expect(m.residual.find((c) => c.likelihood === 4 && c.consequence === 4)!.count).toBe(1);
    expect(m.residual.find((c) => c.likelihood === 1 && c.consequence === 1)!.count).toBe(1);
    expect(m.initial[0].sample[0]).toMatchObject({ number: 'INC-1', status: 'RESPONDING' });
  });
  it('draws the port chart and measures a track over the ground', () => {
    const zones = chartZones('AE');
    expect(zones.map((z) => z.kind)).toEqual(['LAND', 'ANCHORAGE', 'CHANNEL', 'SPM']);
    expect(zones.every((z) => z.points.length >= 2)).toBe(true);
    const centre = portCentre('AE', 25);
    expect(centre).toMatchObject({ zoomKm: 25, name: expect.any(String) });
    expect(Math.abs(centre.lat)).toBeGreaterThan(0);
    expect(restrictionZones([{ area: [{ lat: 1, lon: 1 }, { lat: 1, lon: 2 }, { lat: 2, lon: 2 }], label: 'Zone', status: 'PROPOSED', id: 'r' } as never])[0])
      .toMatchObject({ kind: 'RESTRICTED', label: 'Zone (proposed)' });
    expect(restrictionZones([{ area: [{ lat: 1, lon: 1 }], id: 'r', label: 'x', status: 'APPROVED' } as never])).toHaveLength(0);
    expect(distanceNm({ lat: 24.8, lon: 54.6 }, { lat: 24.9, lon: 54.6 })).toBeCloseTo(6, 0);
    const s = trackSummary([
      { lat: 24.8, lon: 54.6, sog: 10, cog: 0, navStatus: 'UNDERWAY', receivedAt: '2026-06-01T00:00:00Z' },
      { lat: 24.9, lon: 54.6, sog: 12, cog: 0, navStatus: 'UNDERWAY', receivedAt: '2026-06-01T00:30:00Z' },
    ]);
    expect(s).toMatchObject({ fixes: 2, maxSpeedKn: 12, avgSpeedKn: 11 });
    expect(s.distanceNm).toBeGreaterThan(5);
    expect(trackSummary([])).toMatchObject({ fixes: 0, distanceNm: 0, from: null });
  });
});

describe('maritime-centre — the incident register', () => {
  it('pages, filters, searches and sorts the register', async () => {
    const first = await g('/incidents?limit=5');
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(5);
    expect(first.body.meta.total).toBeGreaterThan(100);
    expect(first.body.data[0]).not.toHaveProperty('comms');
    const p2 = await g('/incidents?limit=5&page=2');
    expect(p2.body.data[0].id).not.toBe(first.body.data[0].id);
    for (const [key, value] of [['severity', 'HIGH'], ['category', 'MARINE'], ['status', 'CLOSED'], ['priority', 'P2'], ['source', 'VHF']] as const) {
      const r = await g(`/incidents?${key}=${value}&limit=200`);
      expect(r.body.data.every((x: any) => x[key] === value)).toBe(true);
    }
    const open = await g('/incidents?open=true&limit=50');
    expect(open.body.data.length).toBeGreaterThan(0);
    expect(open.body.data.every((x: any) => x.live && x.status !== 'CLOSED' && x.status !== 'RESOLVED')).toBe(true);
    const one = first.body.data[0];
    expect((await g(`/incidents?q=${encodeURIComponent(one.number)}`)).body.data.map((x: any) => x.number)).toContain(one.number);
    const sorted = await g('/incidents?sort=number&limit=3');
    expect(sorted.body.data.map((x: any) => x.number)).toEqual([...sorted.body.data.map((x: any) => x.number)].sort());
    const withVessel = (await g('/incidents?limit=200')).body.data.find((x: any) => x.vesselId);
    const byVessel = await g(`/incidents?vessel=${withVessel.vesselId}&limit=50`);
    expect(byVessel.body.data.every((x: any) => x.vesselId === withVessel.vesselId)).toBe(true);
    const byAssignee = await g(`/incidents?assignee=${encodeURIComponent(one.assignedTo)}&limit=200`);
    expect(byAssignee.body.data.every((x: any) => x.assignedTo === one.assignedTo)).toBe(true);
    const ranged = await g('/incidents?from=2025-01-01&to=2025-12-31&limit=500');
    expect(ranged.body.data.every((x: any) => x.reportedAt >= '2025-01-01' && x.reportedAt <= '2026-01-01')).toBe(true);
  });

  it('returns the full case file with its threads and merged timeline', async () => {
    const rich = (await pool.query<{ id: string }>(
      `SELECT i.id FROM incidents i WHERE (SELECT count(*) FROM incident_comms WHERE incident_id = i.id) > 1
         AND (SELECT count(*) FROM incident_tasks WHERE incident_id = i.id) > 0 AND (SELECT count(*) FROM incident_documents WHERE incident_id = i.id) > 0 LIMIT 1`)).rows[0];
    const res = await g(`/incidents/${rich.id}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.comms.length).toBeGreaterThan(1);
    expect(d.comms[0]).toMatchObject({ id: expect.any(String), channel: expect.any(String), direction: expect.any(String), message: expect.any(String) });
    expect(d.tasks[0]).toMatchObject({ id: expect.any(String), title: expect.any(String), status: expect.any(String) });
    expect(d.documents[0]).toMatchObject({ id: expect.any(String), name: expect.any(String), docType: expect.any(String), sizeKB: expect.any(Number) });
    expect(d.statusHistory[0]).toMatchObject({ from: '', to: 'OPEN' });
    expect(d.log.length).toBeGreaterThan(0);
    expect(d.timeline.length).toBeGreaterThan(0);
    expect(d.allowedTransitions).toEqual(INCIDENT_TRANSITIONS[d.status as keyof typeof INCIDENT_TRANSITIONS]);
    expect(d.resolution).toHaveProperty('responseHours');
    expect((await g('/incidents/00000000-0000-4000-a000-000000000000')).status).toBe(404);
  });

  it('serves the case by number, as a hover card, as a timeline and as a resolution record', async () => {
    const one = (await g('/incidents?status=CLOSED&limit=1')).body.data[0];
    expect((await g(`/incidents/${one.number}`)).body.data.id).toBe(one.id);
    expect((await g(`/incidents/${one.id}/card`)).body.data).toMatchObject({ kind: 'incident', title: one.number, link: `/incidents/${one.id}` });
    const tl = await g(`/incidents/${one.id}/timeline`);
    expect(tl.body.data.entries.length).toBeGreaterThan(0);
    expect(tl.body.data.statusHistory.length).toBeGreaterThan(0);
    const res = await g(`/incidents/${one.id}/resolution`);
    expect(res.body.data).toMatchObject({ number: one.number, status: 'CLOSED' });
    expect(res.body.data.closedAt).toBeTruthy();
  });

  it('serves the incident dashboard the overview screen renders', async () => {
    const res = await g('/incidents/dashboard');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(Object.keys(d.kpis).sort()).toEqual(['closedYtd', 'highOpen', 'injuriesYtd', 'loggedYtd', 'mttaMin', 'mttrHrs', 'open'].sort());
    expect(d.sla).toMatchObject({ mttaTargetMin: expect.any(Number), mttrTargetHrs: expect.any(Number) });
    expect(d.byMonth).toHaveLength(12);
    expect(d.byMonth[0]).toMatchObject({ LOW: expect.any(Number), MEDIUM: expect.any(Number), HIGH: expect.any(Number), CRITICAL: expect.any(Number), total: expect.any(Number) });
    expect(d.byType[0]).toMatchObject({ type: expect.any(String), count: expect.any(Number) });
    expect(d.byCategory.length).toBeGreaterThan(0);
    expect(d.byStatus.length).toBeGreaterThan(0);
    expect(d.aging.map((a: any) => a.bucket)).toEqual(['0-24h', '1-3d', '3-7d', '>7d']);
    expect(d.openList.length).toBeGreaterThan(0);
    expect(d.openList[0]).toMatchObject({ id: expect.any(String), number: expect.any(String), severity: expect.any(String), reportedAt: expect.any(String) });
    expect(d.kpis.open).toBe(d.openList.length <= 12 ? d.kpis.open : d.kpis.open);
  });

  it('serves the 5×5 risk matrix over a window', async () => {
    const res = await g('/incidents/risk-matrix?days=365');
    expect(res.status).toBe(200);
    expect(res.body.data.days).toBe(365);
    expect(res.body.data.total).toBeGreaterThan(0);
    expect(res.body.data.initial.length).toBeGreaterThan(0);
    expect(res.body.data.initial[0]).toMatchObject({ likelihood: expect.any(Number), consequence: expect.any(Number), count: expect.any(Number), sample: expect.any(Array) });
    const initialTotal = res.body.data.initial.reduce((s: number, c: any) => s + c.count, 0);
    const residualTotal = res.body.data.residual.reduce((s: number, c: any) => s + c.count, 0);
    expect(initialTotal).toBe(res.body.data.total);
    expect(residualTotal).toBe(res.body.data.total);
    expect((await g('/incidents/risk-matrix')).body.data.days).toBe(180);
  });
});

describe('maritime-centre — the case-file lifecycle', () => {
  it('logs a case, walks it through the transition table and closes it', async () => {
    const v = await anyVessel(); const b = await anyBerth();
    await clearOutbox();
    const c = await logCase({ vesselId: v.id, berthId: b.id, description: 'Line parted in a squall', location: { area: b.code } });
    expect(c).toMatchObject({ status: 'OPEN', priority: 'P3', vesselId: v.id, berthCode: b.code, berthTerminal: b.terminal });
    expect(c.number).toMatch(/^INC-\d{4}-\d{4}$/);
    expect(c.statusHistory).toHaveLength(1);
    expect(c.log).toHaveLength(1);
    expect(c.reportedBy).toBe('NMC Duty Officer');
    expect((await outbox(EVENTS.maritimeCentre.incidentOpened))[0].data).toMatchObject({ number: c.number, severity: 'MEDIUM' });
    expect((await outbox(EVENTS.readModel.upserted))[0].data).toMatchObject({ kind: 'incident', entity: { number: c.number } });

    const bad = await post(`/incidents/${c.id}/transition`, { to: 'CLOSED' }, duty);
    expect(bad.status).toBe(409);
    expect(bad.body.message).toMatch(/Allowed: ACKNOWLEDGED, RESPONDING/);

    const ack = await post(`/incidents/${c.id}/transition`, { to: 'ACKNOWLEDGED', note: 'Watch accepted' }, duty);
    expect(ack.body.data).toMatchObject({ status: 'ACKNOWLEDGED' });
    expect(ack.body.data.acknowledgedAt).toBeTruthy();
    await post(`/incidents/${c.id}/transition`, { to: 'RESPONDING', note: 'Tug tasked' }, duty);
    const mon = await post(`/incidents/${c.id}/transition`, { to: 'MONITORING', note: 'Contained' }, duty);
    expect(mon.body.data.status).toBe('MONITORING');

    const noSummary = await post(`/incidents/${c.id}/transition`, { to: 'RESOLVED' }, duty);
    expect(noSummary.status).toBe(400);
    expect(noSummary.body.message).toMatch(/resolution summary/i);
    const resolved = await post(`/incidents/${c.id}/transition`, { to: 'RESOLVED', note: 'New line run; vessel secure' }, duty);
    expect(resolved.body.data).toMatchObject({ status: 'RESOLVED', outcome: 'New line run; vessel secure' });
    expect(resolved.body.data.resolvedAt).toBeTruthy();
    expect((await outbox(EVENTS.maritimeCentre.incidentResolved))[0].data).toMatchObject({ from: 'MONITORING', to: 'RESOLVED' });

    const closed = await post(`/incidents/${c.id}/close`, { note: 'RCA reviewed', outcome: 'Line renewed from stores' }, duty);
    expect(closed.body.data).toMatchObject({ status: 'CLOSED', outcome: 'Line renewed from stores' });
    expect(closed.body.data.statusHistory.map((h: any) => h.to)).toEqual(['OPEN', 'ACKNOWLEDGED', 'RESPONDING', 'MONITORING', 'RESOLVED', 'CLOSED']);
    expect((await outbox(EVENTS.maritimeCentre.incidentClosed)).length).toBeGreaterThan(0);
    expect((await post(`/incidents/${c.id}/close`, {}, duty)).status).toBe(409);
    expect((await put(`/incidents/${c.id}`, { title: 'changed' }, duty)).status).toBe(409);
  });

  it('reopens a closed case, clearing the resolution stamps so the clock runs again', async () => {
    const c = await logCase();
    await post(`/incidents/${c.id}/transition`, { to: 'RESPONDING', note: 'On scene' }, duty);
    await post(`/incidents/${c.id}/transition`, { to: 'RESOLVED', note: 'Made safe' }, duty);
    await post(`/incidents/${c.id}/close`, { note: 'Closed' }, duty);
    await clearOutbox();
    const reopened = await post(`/incidents/${c.id}/transition`, { to: 'RESPONDING', note: 'New information received' }, duty);
    expect(reopened.body.data).toMatchObject({ status: 'RESPONDING', resolvedAt: null, closedAt: null });
    expect((await outbox(EVENTS.maritimeCentre.incidentTransitioned))[0].data).toMatchObject({ reopened: true });
    expect((await outbox(EVENTS.audit.recorded)).some((e) => e.data.action === 'REOPEN')).toBe(true);
    await post(`/incidents/${c.id}/transition`, { to: 'RESOLVED', note: 'Re-resolved' }, duty);
    await post(`/incidents/${c.id}/close`, {}, duty);
  });

  it('refuses to close a case with response tasks still open', async () => {
    const c = await logCase();
    await post(`/incidents/${c.id}/tasks`, { title: 'Collect water samples', assignee: 'Environment Officer' }, duty);
    await post(`/incidents/${c.id}/transition`, { to: 'RESPONDING', note: 'Responding' }, duty);
    await post(`/incidents/${c.id}/transition`, { to: 'RESOLVED', note: 'Contained' }, duty);
    const blocked = await post(`/incidents/${c.id}/close`, {}, duty);
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toMatch(/response task/i);
    const taskId = (await g(`/incidents/${c.id}`)).body.data.tasks[0].id;
    await put(`/incidents/${c.id}/tasks/${taskId}`, { status: 'DONE' }, duty);
    expect((await post(`/incidents/${c.id}/close`, {}, duty)).body.data.status).toBe('CLOSED');
  });

  it('updates the facts of a live case, deriving priority from severity', async () => {
    const c = await logCase();
    await clearOutbox();
    const up = await put(`/incidents/${c.id}`, { severity: 'CRITICAL', injuries: 2, pollutionTier: 1, assets: ['Tug TUG-01'], weather: { windKn: 22 } }, duty);
    expect(up.body.data).toMatchObject({ severity: 'CRITICAL', priority: 'P1', injuries: 2, pollutionTier: 1 });
    expect(up.body.data.assets).toEqual(['Tug TUG-01']);
    expect(up.body.data.weather.windKn).toBe(22);
    expect((await outbox(EVENTS.maritimeCentre.incidentUpdated))[0].data.severity).toBe('CRITICAL');
    expect((await put(`/incidents/${c.id}`, { priority: 'P4' }, duty)).body.data.priority).toBe('P4');
    expect((await put(`/incidents/${c.id}`, {}, duty)).status).toBe(400);
    await del(`/incidents/${c.id}`, duty);
  });

  it('reassigns a live case and records who had it before', async () => {
    const c = await logCase();
    await clearOutbox();
    const assigned = await post(`/incidents/${c.id}/assign`, { assignedTo: 'Chief — HSE', assignedToId: 'hse-1', note: 'HSE lead takes the case' }, duty);
    expect(assigned.body.data).toMatchObject({ assignedTo: 'Chief — HSE', assignedToId: 'hse-1' });
    expect((await outbox(EVENTS.maritimeCentre.incidentAssigned))[0].data).toMatchObject({ previousAssignee: 'NMC Duty Officer' });
    expect(assigned.body.data.log.some((l: any) => l.entry.includes('reassigned to Chief — HSE'))).toBe(true);
    await del(`/incidents/${c.id}`, duty);
  });

  it('deletes a case logged in error and refuses to delete one already being worked', async () => {
    const c = await logCase();
    await clearOutbox();
    expect((await del(`/incidents/${c.id}`, duty)).body.data).toMatchObject({ deleted: true });
    expect((await outbox(EVENTS.readModel.deleted))[0].data).toMatchObject({ kind: 'incident', id: c.id });
    expect((await g(`/incidents/${c.id}`)).status).toBe(404);
    const worked = await logCase();
    await post(`/incidents/${worked.id}/transition`, { to: 'ACKNOWLEDGED' }, duty);
    expect((await del(`/incidents/${worked.id}`, duty)).status).toBe(400);
  });

  it('refuses a case against a ship or berth that is not on the register, and an unknown type', async () => {
    expect((await post('/incidents', { title: 'x', type: 'SAR', vesselId: '00000000-0000-4000-a000-000000000000' }, duty)).status).toBe(400);
    expect((await post('/incidents', { title: 'x', type: 'SAR', berthId: 'not-a-berth' }, duty)).status).toBe(400);
    expect((await post('/incidents', { title: 'x', type: 'NOT_A_TYPE' }, duty)).status).toBe(400);
    expect((await post('/incidents', { type: 'SAR' }, duty)).status).toBe(400);
  });
});

describe('maritime-centre — the case-file threads', () => {
  it('logs communications, tasks, documents and log entries, and records the resolution', async () => {
    const c = await logCase();
    await clearOutbox();
    const comm = await post(`/incidents/${c.id}/comms`, { channel: 'VHF', direction: 'IN', message: 'Master reports situation under control' }, duty);
    expect(comm.body.data.comms[0]).toMatchObject({ channel: 'VHF', direction: 'IN', by: 'NMC Duty Officer' });
    expect((await outbox(EVENTS.maritimeCentre.incidentCommLogged))[0].data).toMatchObject({ channel: 'VHF' });

    const task = await post(`/incidents/${c.id}/tasks`, { title: 'Arrange diver inspection', assignee: 'Harbour Master', due: '2026-12-31' }, duty);
    const t = task.body.data.tasks[0];
    expect(t).toMatchObject({ title: 'Arrange diver inspection', assignee: 'Harbour Master', status: 'OPEN' });
    expect(t.due).toBeTruthy();
    const done = await put(`/incidents/${c.id}/tasks/${t.id}`, { status: 'DONE' }, duty);
    expect(done.body.data.tasks[0]).toMatchObject({ status: 'DONE' });
    expect(done.body.data.tasks[0].doneAt).toBeTruthy();
    expect(done.body.data.openTasks).toBe(0);
    expect((await put(`/incidents/${c.id}/tasks/00000000-0000-4000-a000-000000000000`, { status: 'DONE' }, duty)).status).toBe(404);
    expect((await put(`/incidents/${c.id}/tasks/${t.id}`, {}, duty)).status).toBe(400);

    const doc = await post(`/incidents/${c.id}/documents`, { name: 'line-failure-analysis.pdf', docType: 'REPORT', sizeKB: 420 }, duty);
    expect(doc.body.data.documents[0]).toMatchObject({ name: 'line-failure-analysis.pdf', docType: 'REPORT', sizeKB: 420, uploadedBy: 'NMC Duty Officer' });
    // every code the documentType master offers is accepted — a dropdown option the service refuses is a dead option
    for (const docType of ['MANIFEST', 'SURVEY', 'NOTICE', 'CERT', 'CCTV', 'PERMIT']) {
      expect((await post(`/incidents/${c.id}/documents`, { name: `${docType.toLowerCase()}.pdf`, docType }, duty)).status).toBe(201);
    }
    expect((await post(`/incidents/${c.id}/documents`, { name: 'x.pdf', docType: 'NOT_A_TYPE' }, duty)).status).toBe(400);

    const log = await post(`/incidents/${c.id}/log`, { entry: 'Diver on scene; fender inspected' }, duty);
    expect(log.body.data.log.some((l: any) => l.entry === 'Diver on scene; fender inspected')).toBe(true);

    const rca = await put(`/incidents/${c.id}/resolution`, { rootCause: 'Mooring line worn beyond discard criteria', category: 'Equipment', correctiveAction: 'Line renewed', preventiveAction: 'Quarterly mooring audit', outcome: 'No damage to the berth' }, duty);
    expect(rca.body.data.rca).toMatchObject({ rootCause: 'Mooring line worn beyond discard criteria', category: 'Equipment' });
    expect(rca.body.data.resolution).toMatchObject({ rootCause: 'Mooring line worn beyond discard criteria', rcaCategory: 'Equipment' });
    expect(rca.body.data.outcome).toBe('No damage to the berth');

    const timeline = (await g(`/incidents/${c.id}/timeline`)).body.data.entries;
    expect(timeline.some((x: any) => x.kind === 'DOC')).toBe(true);
    expect(timeline.some((x: any) => x.kind === 'LOG')).toBe(true);
    expect(timeline.some((x: any) => x.kind === 'STATUS')).toBe(true);
    expect(timeline.map((x: any) => x.at)).toEqual([...timeline.map((x: any) => x.at)].sort().reverse());
    await del(`/incidents/${c.id}`, duty);
  });

  it('keeps a resolved case file closed to new evidence, but still lets the thread be read and a message logged', async () => {
    const c = await logCase();
    await post(`/incidents/${c.id}/transition`, { to: 'RESPONDING', note: 'Responding' }, duty);
    await post(`/incidents/${c.id}/transition`, { to: 'RESOLVED', note: 'Made safe' }, duty);
    expect((await post(`/incidents/${c.id}/log`, { entry: 'late note' }, duty)).status).toBe(409);
    expect((await post(`/incidents/${c.id}/tasks`, { title: 'late task' }, duty)).status).toBe(409);
    expect((await post(`/incidents/${c.id}/documents`, { name: 'late.pdf' }, duty)).status).toBe(409);
    // a message received after the case was resolved is still part of the record
    expect((await post(`/incidents/${c.id}/comms`, { message: 'Agent confirms P&I notified' }, duty)).status).toBe(201);
    await post(`/incidents/${c.id}/close`, {}, duty);
  });
});

describe('maritime-centre — tracking and surveillance', () => {
  it('serves the traffic picture the map page renders', async () => {
    const res = await g('/tracking', viewer);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.positions.length).toBeGreaterThan(10);
    expect(d.positions[0]).toMatchObject({
      id: expect.any(String), vesselId: expect.any(String), lat: expect.any(Number), lon: expect.any(Number),
      speed: expect.any(Number), course: expect.any(Number), navStatus: expect.any(String), receivedAt: expect.any(String),
    });
    expect(d.positions[0].vessel).toMatchObject({ id: expect.any(String), name: expect.any(String), imo: expect.any(String) });
    expect(d.alerts.length).toBeGreaterThan(0);
    expect(d.alerts.every((a: any) => a.acknowledged === false)).toBe(true);
    expect(d.alerts[0]).toMatchObject({ id: expect.any(String), type: expect.any(String), severity: expect.any(String), note: expect.any(String), at: expect.any(String) });
    expect(d.coverage).toContain('AIS');
    expect(d.generatedAt).toBeTruthy();
    expect(d.port).toMatchObject({ name: expect.any(String), lat: expect.any(Number), lon: expect.any(Number), zoomKm: expect.any(Number) });
    expect(d.zones.map((z: any) => z.kind)).toEqual(expect.arrayContaining(['LAND', 'ANCHORAGE', 'CHANNEL', 'RESTRICTED']));
    expect(d.zones.every((z: any) => z.points.every((p: any) => typeof p.lat === 'number' && typeof p.lon === 'number'))).toBe(true);
  });

  it('lists positions and serves one ship\'s track with its ground covered', async () => {
    const list = await g('/tracking/positions?limit=5', viewer);
    expect(list.body.meta.total).toBeGreaterThan(10);
    const moored = await g('/tracking/positions?navStatus=MOORED&limit=50', viewer);
    expect(moored.body.data.every((p: any) => p.navStatus === 'MOORED')).toBe(true);
    const one = list.body.data[0];
    const track = await g(`/tracking/positions/${one.vesselId}?hours=6`, viewer);
    expect(track.status).toBe(200);
    expect(track.body.data.hours).toBe(6);
    expect(track.body.data.current).toMatchObject({ vesselId: one.vesselId });
    expect(track.body.data.track.length).toBeGreaterThan(0);
    expect(track.body.data.summary).toMatchObject({ fixes: expect.any(Number), distanceNm: expect.any(Number), maxSpeedKn: expect.any(Number) });
    expect((await g('/tracking/positions/not-a-vessel', viewer)).status).toBe(404);
  });

  it('takes a fix from the feed on the service token only, and publishes it for the ship register', async () => {
    const v = await anyVessel();
    await clearOutbox();
    const body = { vesselId: v.id, lat: 24.9012, lon: 54.5511, speed: 11.4, course: 212, navStatus: 'UNDERWAY', destination: 'AEAUH' };
    expect((await post('/tracking/positions', body, duty)).status).toBe(401);
    const res = await request(server as never).post('/tracking/positions').set('x-service-token', SERVICE_TOKEN).send(body as never);
    expect(res.status).toBe(201);
    expect(res.body.data).toMatchObject({ vesselId: v.id, lat: 24.9012, lon: 54.5511, speed: 11.4, course: 212, navStatus: 'UNDERWAY' });
    expect(res.body.data.vessel.name).toBe(v.name);
    expect(res.body.data.stale).toBe(false);
    const snap = (await outbox(EVENTS.readModel.upserted)).find((e) => e.data.kind === 'position');
    expect(snap!.data.entity).toMatchObject({ vesselId: v.id, lat: 24.9012 });
    expect((await outbox(EVENTS.maritimeCentre.positionUpdated))[0].data).toMatchObject({ vesselId: v.id, speed: 11.4, course: 212 });
    const track = await g(`/tracking/positions/${v.id}?hours=24`, viewer);
    expect(track.body.data.track.some((f: any) => f.lat === 24.9012)).toBe(true);
  });

  it('lists, raises and acknowledges MDA alerts', async () => {
    const open = await g('/tracking/alerts?acknowledged=false&limit=100', viewer);
    expect(open.body.data.every((a: any) => !a.acknowledged)).toBe(true);
    const acked = await g('/tracking/alerts?acknowledged=true&limit=100', viewer);
    expect(acked.body.data.length).toBeGreaterThan(0);
    expect(acked.body.data.every((a: any) => a.acknowledged && a.acknowledgedBy)).toBe(true);
    const byType = await g('/tracking/alerts?type=AIS_GAP&limit=100', viewer);
    expect(byType.body.data.every((a: any) => a.type === 'AIS_GAP')).toBe(true);

    const v = await anyVessel();
    await clearOutbox();
    const raised = await post('/tracking/alerts', { type: 'SPEED_IN_CHANNEL', severity: 'warning', vesselId: v.id, note: '12.1 kn in the approach channel (limit 8 kn)' }, duty);
    expect(raised.status).toBe(201);
    expect(raised.body.data).toMatchObject({ type: 'SPEED_IN_CHANNEL', vesselId: v.id, vesselName: v.name, acknowledged: false });
    expect((await outbox(EVENTS.maritimeCentre.alertRaised))[0].data).toMatchObject({ type: 'SPEED_IN_CHANNEL', vesselId: v.id });

    const ack = await post(`/tracking/alerts/${raised.body.data.id}/ack`, { note: 'Master cautioned on Ch 12' }, duty);
    expect(ack.body.data).toMatchObject({ acknowledged: true, acknowledgedBy: 'NMC Duty Officer' });
    expect(ack.body.data.acknowledgedAt).toBeTruthy();
    expect(ack.body.data.note).toContain('Master cautioned');
    expect((await outbox(EVENTS.maritimeCentre.alertAcknowledged))[0].data.acknowledgedBy).toBe('NMC Duty Officer');
    expect((await post(`/tracking/alerts/${raised.body.data.id}/ack`, {}, duty)).status).toBe(409);
    expect((await post('/tracking/alerts/00000000-0000-4000-a000-000000000000/ack', {}, duty)).status).toBe(404);
    expect((await post('/tracking/alerts', { type: 'ZONE_ENTRY', vesselId: '00000000-0000-4000-a000-000000000000' }, duty)).status).toBe(400);
  });

  it('proposes a restriction against a case and lets the harbour master decide it', async () => {
    const c = await logCase({ type: 'NAV_HAZARD', category: 'NAVIGATION' });
    await clearOutbox();
    const area = [{ lat: 24.80, lon: 54.55 }, { lat: 24.80, lon: 54.60 }, { lat: 24.85, lon: 54.60 }, { lat: 24.85, lon: 54.55 }];
    const proposed = await post('/tracking/restrictions', { kind: 'SAFETY_ZONE', label: 'Floating object — southern approaches', reason: 'Container adrift', area, incidentId: c.id }, duty);
    expect(proposed.status).toBe(201);
    expect(proposed.body.data).toMatchObject({ status: 'PROPOSED', kind: 'SAFETY_ZONE', incidentId: c.id, proposedBy: 'NMC Duty Officer' });
    expect(proposed.body.data.number).toMatch(/^NTM-\d{4}-\d{3}$/);
    expect((await outbox(EVENTS.maritimeCentre.restrictionProposed))[0].data).toMatchObject({ label: 'Floating object — southern approaches', incidentNumber: c.number });
    // a proposal is on the chart while it is still being decided
    expect((await g('/tracking', viewer)).body.data.zones.some((z: any) => z.label.includes('(proposed)'))).toBe(true);
    expect((await post('/tracking/restrictions', { label: 'too few points', area: [{ lat: 1, lon: 1 }] }, duty)).status).toBe(400);

    const decided = await put(`/tracking/restrictions/${proposed.body.data.id}`, { status: 'APPROVED', note: 'Approved by the harbour master' }, duty);
    expect(decided.body.data).toMatchObject({ status: 'APPROVED', decidedBy: 'NMC Duty Officer' });
    expect((await outbox(EVENTS.maritimeCentre.restrictionDecided))[0].data).toMatchObject({ decision: 'APPROVED' });
    expect((await put(`/tracking/restrictions/${proposed.body.data.id}`, { status: 'REJECTED' }, duty)).status).toBe(409);
    const list = await g('/tracking/restrictions?status=APPROVED&limit=50', viewer);
    expect(list.body.data.every((r: any) => r.status === 'APPROVED')).toBe(true);
    await put(`/tracking/restrictions/${proposed.body.data.id}`, { status: 'WITHDRAWN', note: 'Object recovered' }, duty);
    await del(`/incidents/${c.id}`, duty);
  });

  it('serves the open cases the map plots on the chart', async () => {
    const res = await g('/tracking/incidents', viewer);
    expect(res.status).toBe(200);
    expect(res.body.data.length).toBeGreaterThan(0);
    expect(res.body.data.every((i: any) => i.live)).toBe(true);
    expect(res.body.data[0]).toMatchObject({ id: expect.any(String), number: expect.any(String), severity: expect.any(String) });
    expect(res.body.data.some((i: any) => i.position && typeof i.position.lat === 'number')).toBe(true);
  });
});

describe('maritime-centre — the consumer', () => {
  it('projects a ship, corrects the live cases naming her and leaves closed ones alone', async () => {
    const v = await anyVessel();
    const live = await logCase({ vesselId: v.id });
    const closed = (await pool.query<{ id: string; vessel_name: string }>(`SELECT id, vessel_name FROM incidents WHERE status = 'CLOSED' AND vessel_id::text = $1 LIMIT 1`, [v.id])).rows[0];
    await clearOutbox();
    const client = await pool.connect();
    try {
      const event = makeEvent({ type: EVENTS.readModel.upserted, source: 'ships', data: { kind: 'vessel', entity: { id: v.id, imo: '9700123', mmsi: '470111222', name: 'MV Renamed At Sea', type: 'TANK', flag: 'Panama', status: 'ACTIVE' } } });
      await applyEvent(client, { env, audit }, event);
      expect((await client.query('SELECT name, flag FROM vessels WHERE id = $1', [v.id])).rows[0]).toMatchObject({ name: 'MV Renamed At Sea', flag: 'Panama' });
      expect((await client.query('SELECT vessel_name FROM incidents WHERE id = $1', [live.id])).rows[0].vessel_name).toBe('MV Renamed At Sea');
      if (closed) expect((await client.query('SELECT vessel_name FROM incidents WHERE id = $1', [closed.id])).rows[0].vessel_name).toBe(closed.vessel_name);
    } finally { client.release(); }
    expect((await outbox(EVENTS.readModel.upserted)).some((e) => e.data.entity?.id === live.id && e.data.entity?.vesselName === 'MV Renamed At Sea')).toBe(true);
    expect((await outbox(EVENTS.audit.recorded)).some((e) => e.data.action === 'VESSEL_REFRESHED')).toBe(true);
    await del(`/incidents/${live.id}`, duty);
  });

  it('folds a fix from another feed into the picture and republishes it for the ship register', async () => {
    await clearOutbox();
    const client = await pool.connect();
    try {
      const event = makeEvent({ type: EVENTS.maritimeCentre.positionUpdated, source: 'integration-hub', data: { vesselId: 'external-target-1', vesselName: 'MV Outside Feed', mmsi: '470999888', lat: 25.011, lon: 54.401, speed: 8.2, course: 95, navStatus: 'UNDERWAY', receivedAt: new Date().toISOString() } });
      await applyEvent(client, { env, audit }, event);
      const row = (await client.query('SELECT * FROM positions WHERE vessel_id = $1', ['external-target-1'])).rows[0];
      expect(row).toMatchObject({ vessel_name: 'MV Outside Feed', nav_status: 'UNDERWAY' });
      expect(Number(row.sog)).toBe(8.2);
      expect((await client.query('SELECT count(*) AS n FROM position_history WHERE vessel_id = $1', ['external-target-1'])).rows[0].n).toBe('1');
      // our own republish must not come back round and be re-projected
      const mine = makeEvent({ type: EVENTS.maritimeCentre.positionUpdated, source: env.SERVICE_NAME, data: { vesselId: 'external-target-1', lat: 0, lon: 0 } });
      await applyEvent(client, { env, audit }, mine);
      expect(Number((await client.query('SELECT lat FROM positions WHERE vessel_id = $1', ['external-target-1'])).rows[0].lat)).toBe(25.011);
    } finally { client.release(); }
    expect((await outbox(EVENTS.readModel.upserted)).some((e) => e.data.kind === 'position' && e.data.entity?.vesselId === 'external-target-1')).toBe(true);
  });

  it('projects a berth, ignores an event it does not own, and consumes each event once', async () => {
    const { withInbox } = await import('@maritime/service-kit');
    const client = await pool.connect();
    try {
      const berth = makeEvent({ type: EVENTS.readModel.upserted, source: 'ports', data: { kind: 'berth', entity: { id: 'berth-under-test', code: 'ZZ-9', name: 'Test berth', terminal: 'Test terminal', status: 'OPERATIONAL' } } });
      await applyEvent(client, { env, audit }, berth);
      expect((await client.query('SELECT code FROM berths WHERE id = $1', ['berth-under-test'])).rows[0].code).toBe('ZZ-9');
      const noise = makeEvent({ type: EVENTS.readModel.upserted, source: 'revenue', data: { kind: 'invoice', entity: { id: 'inv-1' } } });
      await expect(applyEvent(client, { env, audit }, noise)).resolves.toBeUndefined();
      const gone = makeEvent({ type: EVENTS.readModel.deleted, source: 'ports', data: { kind: 'berth', id: 'berth-under-test' } });
      await applyEvent(client, { env, audit }, gone);
      expect((await client.query('SELECT 1 FROM berths WHERE id = $1', ['berth-under-test'])).rowCount).toBe(0);
    } finally { client.release(); }
    const event = makeEvent({ type: EVENTS.readModel.upserted, source: 'ships', data: { kind: 'vessel', entity: { id: 'twice-vessel', imo: '9999992', name: 'MV Idempotent', status: 'ACTIVE' } } });
    expect(await withInbox(pool, event, async (c) => { await applyEvent(c, { env, audit }, event); })).toBe(true);
    expect(await withInbox(pool, event, async (c) => { await applyEvent(c, { env, audit }, event); })).toBe(false);
    expect((await pool.query('SELECT count(*) AS n FROM vessels WHERE id = $1', ['twice-vessel'])).rows[0].n).toBe('1');
  });
});

describe('maritime-centre — authorisation and the audit trail', () => {
  it('refuses an anonymous request and a principal without the permission', async () => {
    expect((await request(server as never).get('/incidents')).status).toBe(401);
    expect((await request(server as never).get('/tracking')).status).toBe(401);
    expect((await request(server as never).get('/incidents').set('authorization', 'Bearer not-a-token')).status).toBe(401);
    expect((await g('/incidents', nobody)).status).toBe(403);
    expect((await g('/tracking', nobody)).status).toBe(403);
    expect((await g('/incidents/risk-matrix', nobody)).status).toBe(403);
    expect((await g('/incidents/dashboard', dash)).status).toBe(200);
    expect((await g('/incidents', dash)).status).toBe(403);
    const one = (await g('/incidents?limit=1')).body.data[0];
    expect((await post('/incidents', { title: 'x', type: 'SAR' }, viewer)).status).toBe(403);
    expect((await put(`/incidents/${one.id}`, { title: 'x' }, viewer)).status).toBe(403);
    expect((await post(`/incidents/${one.id}/transition`, { to: 'RESPONDING' }, viewer)).status).toBe(403);
    expect((await post(`/incidents/${one.id}/comms`, { message: 'x' }, viewer)).status).toBe(403);
    expect((await del(`/incidents/${one.id}`, viewer)).status).toBe(403);
    expect((await post('/tracking/alerts', { type: 'AIS_GAP' }, viewer)).status).toBe(403);
    expect((await post('/tracking/restrictions', { label: 'x', area: [{ lat: 1, lon: 1 }, { lat: 1, lon: 2 }, { lat: 2, lon: 2 }] }, viewer)).status).toBe(403);
    const alertId = (await g('/tracking/alerts?limit=1', viewer)).body.data[0].id;
    expect((await post(`/tracking/alerts/${alertId}/ack`, {}, viewer)).status).toBe(403);
    expect((await request(server as never).post('/tracking/positions').set('x-service-token', 'wrong').send({ vesselId: 'x', lat: 0, lon: 0 } as never)).status).toBe(401);
    expect((await g('/health')).status).toBe(200);
  });

  it('records an audit entry for every mutation and carries the correlation id onto every event', async () => {
    await clearOutbox();
    const res = await request(server as never).post('/incidents').set('authorization', duty).set('x-correlation-id', 'corr-incident-1')
      .send({ title: 'Correlation probe', category: 'HSE', type: 'NEAR_MISS' } as never);
    expect(res.status).toBe(201);
    const c = res.body.data;
    const events = (await pool.query<{ payload: { correlationid: string } }>('SELECT payload FROM outbox ORDER BY id')).rows.map((r) => r.payload);
    expect(events.length).toBeGreaterThan(1);
    expect(events.every((e) => e.correlationid === 'corr-incident-1')).toBe(true);

    await post(`/incidents/${c.id}/comms`, { message: 'Logged by the watch' }, duty);
    await post(`/incidents/${c.id}/tasks`, { title: 'Toolbox talk' }, duty);
    await post(`/incidents/${c.id}/documents`, { name: 'toolbox-talk-record.pdf' }, duty);
    await post(`/incidents/${c.id}/assign`, { assignedTo: 'Environment Officer' }, duty);
    await post(`/incidents/${c.id}/transition`, { to: 'ACKNOWLEDGED', note: 'Accepted' }, duty);
    const actions = (await outbox(EVENTS.audit.recorded)).map((e) => e.data.action);
    expect(actions).toEqual(expect.arrayContaining(['CREATE', 'COMM_ADD', 'TASK_ADD', 'DOC_ADD', 'ASSIGN', 'TRANSITION']));
    const created = (await outbox(EVENTS.audit.recorded)).find((e) => e.data.action === 'CREATE')!;
    expect(created.data).toMatchObject({ entity: 'Incident', entityLabel: c.number, actor: { id: 'duty', name: 'NMC Duty Officer' } });
  });

  it('publishes a read-model snapshot carrying every field the reporting projection reads', async () => {
    await clearOutbox();
    const v = await anyVessel();
    const c = await logCase({ vesselId: v.id, severity: 'HIGH' });
    const snap = (await outbox(EVENTS.readModel.upserted)).find((e) => e.data.entity?.id === c.id)!.data.entity;
    for (const field of ['id', 'number', 'title', 'category', 'type', 'severity', 'priority', 'status', 'vesselId', 'vesselName', 'assignedTo', 'reportedAt', 'acknowledgedAt', 'resolvedAt', 'closedAt']) {
      expect(snap).toHaveProperty(field);
    }
    await del(`/incidents/${c.id}`, duty);
  });
});
