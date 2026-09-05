import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { EVENTS, makeEvent, subjectFor } from '@maritime/contracts';
import { AuditClient, PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256 } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedInspection } from '../src/seed';
import { applyEvent } from '../src/consumer';
import { inspectionDashboard, mergeAnswers, monthsBack, scoreChecklist, type ChecklistAnswer, type DashboardInput } from '../src/inspections';
import { classify, routeRecommendation, sweepOverdueFindings } from '../src/smart';

const DB = 'maritime_inspection_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let audit: AuditClient; let env: ReturnType<typeof loadEnv<typeof envSchema>>;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const surveyor = tok('surveyor'); const viewer = tok('viewer'); const nobody = tok('nobody'); const dash = tok('dash');
/* Two desks, one at each port, and an operator who is not the administration at all. */
const khalifa = tok('khalifa'); const fujairah = tok('fujairah'); const agentGss = tok('agent-gss');
const g = (p: string, t = admin) => request(server as never).get(p).set('authorization', t);
const post = (p: string, body?: unknown, t = admin) => request(server as never).post(p).set('authorization', t).send((body ?? {}) as never);
const put = (p: string, body: unknown, t = admin) => request(server as never).put(p).set('authorization', t).send(body as never);
const del = (p: string, t = admin) => request(server as never).delete(p).set('authorization', t);
const outbox = async (type: string) => (await pool.query('SELECT payload FROM outbox WHERE subject = $1 ORDER BY id', [subjectFor(type)])).rows.map((r) => r.payload as { type: string; subject?: string; data: Record<string, any> });
const clearOutbox = () => pool.query('DELETE FROM outbox');
const D = 86_400_000;

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedInspection(URL, 'AE');
  env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, MDM_URL: 'http://127.0.0.1:1' } as never);
  const base = { scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    admin: { ...base, id: 'admin', sub: 'admin', name: 'Admin', perms: ['*'] },
    surveyor: { ...base, id: 'surveyor', sub: 'surveyor', name: 'Marine Surveyor', perms: ['inspections.view', 'inspections.create', 'inspections.edit', 'inspections.close', 'masters.view'] },
    viewer: { ...base, id: 'viewer', sub: 'viewer', name: 'Compliance Analyst', perms: ['inspections.view', 'masters.view'] },
    dash: { ...base, id: 'dash', sub: 'dash', name: 'Command Centre', perms: ['dashboard.view'] },
    nobody: { ...base, id: 'nobody', sub: 'nobody', name: 'Nobody', perms: ['reports.view'] },
    khalifa: { ...base, id: 'khalifa', sub: 'khalifa', name: 'Khalifa Cell', perms: ['inspections.view', 'inspections.manage', 'dashboard.view'], scope: { level: 'PORT', ports: ['AEAUH'] } },
    fujairah: { ...base, id: 'fujairah', sub: 'fujairah', name: 'Fujairah Cell', perms: ['inspections.view', 'dashboard.view'], scope: { level: 'PORT', ports: ['AEFJR'] } },
    'agent-gss': { ...base, id: 'agent-gss', sub: 'agent-gss', name: 'Gulf Star Shipping', kind: 'agent' as const, perms: ['inspections.view'], scope: { level: 'COMPANY', companies: ['GSS'] } },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer(); pool = new Pool({ connectionString: URL }); audit = app.get(AuditClient);
});
afterAll(async () => { await pool?.end(); await app?.close(); });

/** A fictional ship with no survey open against her, so a fresh lifecycle never collides with a seeded one. */
async function freeVessel() {
  const r = await pool.query<{ id: string; name: string; imo: string }>(
    `SELECT v.id, v.name, v.imo FROM vessels v WHERE NOT v.real AND v.status = 'ACTIVE'
       AND NOT EXISTS (SELECT 1 FROM inspections i WHERE i.vessel_id::text = v.id AND i.status <> 'CLOSED') ORDER BY v.name LIMIT 1`);
  return r.rows[0];
}
const activeTemplate = async (type = 'PSC') => (await pool.query<{ id: string; pass_score_pct: number; items: any[] }>(
  'SELECT id, pass_score_pct, items FROM checklist_templates WHERE inspection_type = $1 AND active ORDER BY version DESC LIMIT 1', [type])).rows[0];

describe('inspection — scoring and the dashboard, tested without a request', () => {
  const item = (text: string, answer: string, weight: number, critical = false): ChecklistAnswer => ({ seq: 1, text, category: 'Safety', answer, note: '', weight, critical, answerType: 'YES_NO_NA' });
  it('weights the answered questions only, and leaves N/A out of both sides of the ratio', () => {
    expect(scoreChecklist([item('a', 'YES', 3), item('b', 'NO', 1), item('c', 'NA', 5), item('d', '', 5)], 80)).toMatchObject({ pct: 75, got: 3, max: 4, criticalFail: false, suggested: 'DEFICIENCIES' });
    expect(scoreChecklist([item('a', 'YES', 3), item('b', 'YES', 1)], 80)).toMatchObject({ pct: 100, suggested: 'SATISFACTORY' });
    expect(scoreChecklist([], 80)).toMatchObject({ pct: null, suggested: 'SATISFACTORY' });
  });
  it('fails the survey outright on a NO to a critical question, whatever the percentage says', () => {
    const r = scoreChecklist([item('a', 'YES', 9), item('crit', 'NO', 1, true)], 80);
    expect(r.pct).toBe(90);
    expect(r).toMatchObject({ criticalFail: true, suggested: 'DETAINED' });
  });
  it('answers a sheet without re-weighting it — the weights stay the ones the survey was planned with', () => {
    const held = [item('a', '', 5, true)];
    const merged = mergeAnswers(held, [{ seq: 1, text: 'a', answer: 'NO', weight: 1, critical: false }]);
    expect(merged[0]).toMatchObject({ answer: 'NO', weight: 5, critical: true });
    expect(mergeAnswers(held, [{ seq: 1, text: 'a', answer: 'MAYBE' }])[0].answer).toBe('');
  });
  it('windows outcome KPIs on the close date and the workload mix on the plan date', () => {
    const now = new Date('2026-06-15T00:00:00Z');
    const row = (over: Partial<DashboardInput>): DashboardInput => ({ type: 'PSC', status: 'CLOSED', result: 'SATISFACTORY', detention: false, planned_at: new Date('2026-05-01T00:00:00Z'), closed_at: new Date('2026-05-02T00:00:00Z'), checklist: [item('a', 'YES', 1)], findings_total: 0, findings_open: 0, ...over });
    const d = inspectionDashboard([
      row({}), row({ result: 'DETAINED', detention: true, findings_total: 4, findings_open: 2 }),
      row({ status: 'IN_PROGRESS', result: '', closed_at: null }),
      row({ planned_at: new Date('2021-01-01T00:00:00Z'), closed_at: new Date('2021-01-02T00:00:00Z'), findings_open: 1 }),
    ], now);
    expect(d.kpis).toMatchObject({ open: 1, satisfactionPct: 50, detentionRatePct: 50, avgFindings: 2, openFindings: 3, checklistCompliancePct: 100 });
    expect(d.byType).toEqual([{ type: 'PSC', total: 3, closed: 2, detained: 1 }]);
    expect(d.byMonth).toHaveLength(12);
    expect(d.byMonth.find((m) => m.month.startsWith('May'))).toMatchObject({ SATISFACTORY: 1, DETAINED: 1 });
    expect(monthsBack(now, 12)[11].key).toBe('2026-06');
  });
});

describe('inspection — the survey register', () => {
  it('pages, filters, searches and sorts the register', async () => {
    const first = await g('/inspections?limit=5');
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(5);
    expect(first.body.meta.total).toBeGreaterThan(100);
    const p2 = await g('/inspections?limit=5&page=2');
    expect(p2.body.data[0].id).not.toBe(first.body.data[0].id);
    const psc = await g('/inspections?type=PSC&limit=200');
    expect(psc.body.data.every((r: any) => r.type === 'PSC')).toBe(true);
    expect(psc.body.meta.total).toBeLessThan(first.body.meta.total);
    const detained = await g('/inspections?detention=true&limit=100');
    expect(detained.body.data.length).toBeGreaterThan(0);
    expect(detained.body.data.every((r: any) => r.detention && r.result === 'DETAINED')).toBe(true);
    const open = await g('/inspections?open=true&limit=50');
    expect(open.body.data.every((r: any) => r.status !== 'CLOSED')).toBe(true);
    const sorted = await g('/inspections?sort=number&limit=3');
    expect(sorted.body.data.map((r: any) => r.number)).toEqual([...sorted.body.data.map((r: any) => r.number)].sort());
    const one = first.body.data[0];
    const found = await g(`/inspections?q=${encodeURIComponent(one.number)}`);
    expect(found.body.data.map((r: any) => r.number)).toContain(one.number);
    const byVessel = await g(`/inspections?vessel=${one.vesselId}&limit=50`);
    expect(byVessel.body.data.every((r: any) => r.vesselId === one.vesselId)).toBe(true);
  });
  it('filters on a planned-date range and on the inspector', async () => {
    const all = await g('/inspections?limit=500');
    const sample = all.body.data.find((r: any) => r.inspector);
    const byInspector = await g(`/inspections?inspector=${encodeURIComponent(sample.inspector)}&limit=200`);
    expect(byInspector.body.data.every((r: any) => r.inspector === sample.inspector)).toBe(true);
    const ranged = await g('/inspections?from=2025-01-01&to=2025-12-31&limit=500');
    expect(ranged.body.data.length).toBeGreaterThan(0);
    expect(ranged.body.data.every((r: any) => r.plannedAt >= '2025-01-01' && r.plannedAt <= '2026-01-01')).toBe(true);
  });
  it('returns a survey with its checklist, findings, live score and port call', async () => {
    const r = await pool.query<{ id: string }>(`SELECT id FROM inspections WHERE status = 'CLOSED' AND result = 'DETAINED' LIMIT 1`);
    const res = await g(`/inspections/${r.rows[0].id}`);
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(d.checklist.length).toBeGreaterThan(0);
    expect(d.checklist[0]).toHaveProperty('weight');
    expect(d.findings.length).toBeGreaterThan(0);
    expect(d.detention).toBe(true);
    expect(d.detentionRecord).toMatchObject({ status: 'RELEASED' });
    expect(d.detentionRecord.heldHours).toBeGreaterThan(0);
    expect(d.scorePct).toBeGreaterThanOrEqual(0);
    expect(d.liveScore).toHaveProperty('suggested');
    expect(d.portCall === null || typeof d.portCall.vcn === 'string').toBe(true);
    expect((await g('/inspections/00000000-0000-4000-a000-000000000000')).status).toBe(404);
  });
  it('serves the survey by its number and as a hover card', async () => {
    const one = (await g('/inspections?limit=1')).body.data[0];
    expect((await g(`/inspections/${one.number}`)).body.data.id).toBe(one.id);
    const card = await g(`/inspections/${one.id}/card`);
    expect(card.body.data).toMatchObject({ kind: 'inspection', title: one.number, link: `/inspections/${one.id}` });
    expect(card.body.data.chips.length).toBeGreaterThan(0);
  });
  it('serves the audit dashboard the overview screen renders', async () => {
    const res = await g('/inspections/dashboard');
    expect(res.status).toBe(200);
    const d = res.body.data;
    expect(Object.keys(d.kpis).sort()).toEqual(['avgFindings', 'checklistCompliancePct', 'closedYtd', 'detentionRatePct', 'open', 'openFindings', 'satisfactionPct'].sort());
    expect(d.byMonth).toHaveLength(12);
    expect(d.byMonth[0]).toHaveProperty('SATISFACTORY');
    expect(d.byType.length).toBeGreaterThan(0);
    expect(d.byType[0]).toMatchObject({ type: expect.any(String), total: expect.any(Number), closed: expect.any(Number), detained: expect.any(Number) });
    expect(d.kpis.openFindings).toBeGreaterThan(0);
  });
  it('serves the fleet-wide deficiency register and the detention register', async () => {
    const def = await g('/inspections/deficiencies?limit=10');
    expect(def.status).toBe(200);
    expect(def.body.meta.total).toBeGreaterThan(100);
    expect(def.body.data[0]).toMatchObject({ inspectionNumber: expect.any(String), vesselName: expect.any(String), deficiencyCode: expect.any(String) });
    const open = await g('/inspections/deficiencies?status=OPEN&limit=200');
    expect(open.body.data.every((f: any) => f.status === 'OPEN')).toBe(true);
    const detainable = await g('/inspections/deficiencies?detainable=true&limit=50');
    expect(detainable.body.data.every((f: any) => f.detainable)).toBe(true);
    const held = await g('/inspections/detentions?limit=50');
    expect(held.body.meta.total).toBeGreaterThan(0);
    expect(held.body.data[0]).toMatchObject({ inspectionNumber: expect.any(String), status: expect.any(String) });
  });
});

describe('inspection — the survey lifecycle', () => {
  it('plans, starts, answers, raises a finding and closes with a scored result', async () => {
    const v = await freeVessel(); const tpl = await activeTemplate('PSC');
    await clearOutbox();
    const planned = await post('/inspections', { vesselId: v.id, type: 'PSC', plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor', templateId: tpl.id, remarks: 'Routine boarding' }, surveyor);
    expect(planned.status).toBe(201);
    const doc = planned.body.data;
    expect(doc.number).toMatch(/^INS-\d{4}-\d{3}$/);
    expect(doc.status).toBe('PLANNED');
    expect(doc.checklist).toHaveLength(tpl.items.length);
    expect(doc.checklist.every((c: any) => c.answer === '')).toBe(true);
    expect(doc.templateVersion).toBeGreaterThan(0);
    expect((await outbox(EVENTS.inspection.planned))[0].data).toMatchObject({ number: doc.number, vesselId: v.id });
    expect((await outbox(EVENTS.readModel.upserted))[0].data).toMatchObject({ kind: 'inspection', entity: { number: doc.number } });

    const started = await post(`/inspections/${doc.id}/start`, {}, surveyor);
    expect(started.body.data).toMatchObject({ status: 'IN_PROGRESS' });
    expect(started.body.data.startedAt).toBeTruthy();
    expect((await post(`/inspections/${doc.id}/start`, {}, surveyor)).status).toBe(409);

    const answers = doc.checklist.map((c: any, ix: number) => ({ ...c, answer: ix === 0 ? 'NO' : 'YES' }));
    const saved = await put(`/inspections/${doc.id}`, { checklist: answers }, surveyor);
    expect(saved.status).toBe(200);
    expect(saved.body.data.answered).toBe(answers.length);
    const scored = await outbox(EVENTS.inspection.checklistScored);
    expect(scored[scored.length - 1].data.scorePct).toBeGreaterThan(0);

    const finding = await post(`/inspections/${doc.id}/findings`, { deficiencyCode: '10111', description: 'Charts not corrected to the latest notices', actionCode: '17' }, surveyor);
    expect(finding.status).toBe(201);
    expect(finding.body.data.findings[0]).toMatchObject({ deficiencyCode: '10111', status: 'OPEN', seq: 1 });
    expect(finding.body.data.findings[0].deficiencyLabel).toContain('Nautical charts');
    expect(finding.body.data.findings[0].dueDate).toBeTruthy();
    const raised = await outbox(EVENTS.inspection.deficiency);
    expect(raised[raised.length - 1].data).toMatchObject({ deficiencyCode: '10111', number: doc.number });

    const refused = await post(`/inspections/${doc.id}/close`, { result: 'SATISFACTORY' }, surveyor);
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/open findings/i);

    const findingId = finding.body.data.findings[0].id;
    const rectified = await put(`/inspections/${doc.id}/findings/${findingId}`, { status: 'CLOSED', rectificationNote: 'Charts corrected and verified' }, surveyor);
    expect(rectified.body.data.findings[0]).toMatchObject({ status: 'CLOSED' });
    expect(rectified.body.data.findings[0].closedAt).toBeTruthy();
    expect((await outbox(EVENTS.inspection.deficiencyRectified)).length).toBe(1);

    const closed = await post(`/inspections/${doc.id}/close`, { result: 'DEFICIENCIES', remarks: 'One deficiency rectified before departure' }, surveyor);
    expect(closed.status).toBe(201);
    expect(closed.body.data).toMatchObject({ status: 'CLOSED', result: 'DEFICIENCIES', detention: false });
    expect(closed.body.data.scorePct).toBeGreaterThan(0);
    expect(closed.body.data.closedAt).toBeTruthy();
    expect((await post(`/inspections/${doc.id}/close`, { result: 'SATISFACTORY' }, surveyor)).status).toBe(409);
    expect((await put(`/inspections/${doc.id}`, { remarks: 'later' }, surveyor)).status).toBe(409);

    const closedEvents = await outbox(EVENTS.inspection.closed);
    expect(closedEvents[0].data).toMatchObject({ number: doc.number, result: 'DEFICIENCIES' });
    const signals = await outbox(EVENTS.inspection.riskScored);
    expect(signals[signals.length - 1].data).toMatchObject({ vesselId: v.id, inspections: expect.any(Number), detentions: expect.any(Number) });
    expect(signals[signals.length - 1].data.deficiencies).toBeGreaterThan(0);
  });

  it('moves a planned survey to in progress the moment an answer or a finding is recorded', async () => {
    const v = await freeVessel(); const tpl = await activeTemplate('MLC');
    const planned = (await post('/inspections', { vesselId: v.id, type: 'MLC', plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor', templateId: tpl.id }, surveyor)).body.data;
    const answers = planned.checklist.map((c: any, ix: number) => ({ ...c, answer: ix === 0 ? 'YES' : '' }));
    expect((await put(`/inspections/${planned.id}`, { checklist: answers }, surveyor)).body.data.status).toBe('IN_PROGRESS');
    const other = (await post('/inspections', { vesselId: v.id, type: 'ISM', plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor' }, surveyor)).body.data;
    expect((await post(`/inspections/${other.id}/findings`, { deficiencyCode: '01101', description: 'Certificate expired' }, surveyor)).body.data.status).toBe('IN_PROGRESS');
    await del(`/inspections/${planned.id}`); await del(`/inspections/${other.id}`);
  });

  it('deletes a planned survey and refuses to delete one that has been worked', async () => {
    const v = await freeVessel();
    const doc = (await post('/inspections', { vesselId: v.id, type: 'FSI', plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor' }, surveyor)).body.data;
    await clearOutbox();
    const gone = await del(`/inspections/${doc.id}`);
    expect(gone.body.data).toMatchObject({ deleted: true });
    expect((await outbox(EVENTS.readModel.deleted))[0].data).toMatchObject({ kind: 'inspection', id: doc.id });
    expect((await g(`/inspections/${doc.id}`)).status).toBe(404);
    const worked = (await pool.query<{ id: string }>(`SELECT id FROM inspections WHERE status = 'CLOSED' LIMIT 1`)).rows[0];
    expect((await del(`/inspections/${worked.id}`)).status).toBe(400);
  });

  it('refuses a survey against a ship or a template that is not on the register', async () => {
    expect((await post('/inspections', { vesselId: '00000000-0000-4000-a000-000000000000', type: 'PSC', plannedAt: new Date().toISOString(), inspector: 'X' }, surveyor)).status).toBe(400);
    const v = await freeVessel();
    expect((await post('/inspections', { vesselId: v.id, type: 'PSC', plannedAt: new Date().toISOString(), inspector: 'X', templateId: '00000000-0000-4000-a000-000000000000' }, surveyor)).status).toBe(400);
    expect((await post('/inspections', { vesselId: v.id, type: 'NOPE', plannedAt: new Date().toISOString(), inspector: 'X' }, surveyor)).status).toBe(400);
  });

  it('withdraws a finding from an open survey and refuses to touch a closed one', async () => {
    const v = await freeVessel();
    const doc = (await post('/inspections', { vesselId: v.id, type: 'ISPS', plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor' }, surveyor)).body.data;
    const f = (await post(`/inspections/${doc.id}/findings`, { deficiencyCode: '07105', description: 'Extinguisher out of date' }, surveyor)).body.data.findings[0];
    await clearOutbox();
    expect((await del(`/inspections/${doc.id}/findings/${f.id}`, surveyor)).body.data.findings).toHaveLength(0);
    expect((await outbox(EVENTS.inspection.deficiencyWithdrawn))[0].data).toMatchObject({ deficiencyCode: '07105' });
    expect((await del(`/inspections/${doc.id}/findings/00000000-0000-4000-a000-000000000000`, surveyor)).status).toBe(404);
    await post(`/inspections/${doc.id}/close`, { result: 'SATISFACTORY' }, surveyor);
    expect((await post(`/inspections/${doc.id}/findings`, { deficiencyCode: '07105', description: 'x' }, surveyor)).status).toBe(409);
  });
});

describe('inspection — detention', () => {
  it('orders a detention on close, refuses release while a detainable deficiency is open, then releases the ship', async () => {
    const v = await freeVessel(); const tpl = await activeTemplate('PSC');
    const doc = (await post('/inspections', { vesselId: v.id, type: 'PSC', plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor', templateId: tpl.id }, surveyor)).body.data;
    const f = (await post(`/inspections/${doc.id}/findings`, { deficiencyCode: '04103', description: 'Emergency generator will not start on load', actionCode: '30' }, surveyor)).body.data.findings[0];
    expect(f).toMatchObject({ severity: 'DETAINABLE', detainable: true });
    await clearOutbox();
    const closed = await post(`/inspections/${doc.id}/close`, { result: 'DETAINED', remarks: 'Ship detained pending rectification' }, surveyor);
    expect(closed.body.data).toMatchObject({ detention: true, result: 'DETAINED' });
    expect(closed.body.data.detentionRecord).toMatchObject({ status: 'ORDERED', detainableCodes: ['04103'] });
    const ordered = await outbox(EVENTS.inspection.detention);
    expect(ordered).toHaveLength(0); // closing publishes the close event; the order is on the record and in the audit trail
    expect((await outbox(EVENTS.inspection.closed))[0].data).toMatchObject({ detention: true });

    const blocked = await post(`/inspections/${doc.id}/detention/release`, { note: 'x' }, surveyor);
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toMatch(/still open/i);
    await put(`/inspections/${doc.id}/findings/${f.id}`, { status: 'CLOSED' }, surveyor);
    await clearOutbox();
    const released = await post(`/inspections/${doc.id}/detention/release`, { note: 'Generator repaired and load-tested' }, surveyor);
    expect(released.body.data.detentionRecord).toMatchObject({ status: 'RELEASED', releaseNote: 'Generator repaired and load-tested' });
    expect((await outbox(EVENTS.inspection.detentionReleased))[0].data.releasedBy).toBe('Marine Surveyor');
    expect((await outbox(EVENTS.inspection.riskScored))[0].data.vesselId).toBe(v.id);
    expect((await post(`/inspections/${doc.id}/detention/release`, { note: 'again' }, surveyor)).status).toBe(404);
  });

  it('orders a detention on its own and refuses a second standing order', async () => {
    const v = await freeVessel();
    const doc = (await post('/inspections', { vesselId: v.id, type: 'FSI', plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor' }, surveyor)).body.data;
    await clearOutbox();
    const held = await post(`/inspections/${doc.id}/detention`, { grounds: 'Hull damage found below the waterline', detainableCodes: ['13101'] }, surveyor);
    expect(held.body.data).toMatchObject({ detention: true });
    expect(held.body.data.detentionRecord).toMatchObject({ status: 'ORDERED', grounds: 'Hull damage found below the waterline', orderedBy: 'Marine Surveyor' });
    const ev = await outbox(EVENTS.inspection.detention);
    expect(ev[0].data).toMatchObject({ number: doc.number, grounds: 'Hull damage found below the waterline' });
    expect((await post(`/inspections/${doc.id}/detention`, { grounds: 'again' }, surveyor)).status).toBe(409);
    await post(`/inspections/${doc.id}/detention/release`, { note: 'Repairs surveyed' }, surveyor);
  });
});

describe('inspection — checklist templates', () => {
  it('lists, filters and reads the templates the builder edits', async () => {
    const all = await g('/checklist-templates?limit=100', viewer);
    expect(all.status).toBe(200);
    expect(all.body.meta.total).toBe(8);
    expect(all.body.data[0]).toMatchObject({ name: expect.any(String), items: expect.any(Array), version: expect.any(Number), passScorePct: expect.any(Number) });
    expect(all.body.data[0].items[0]).toMatchObject({ seq: 1, text: expect.any(String), answerType: expect.any(String), weight: expect.any(Number), critical: expect.any(Boolean) });
    const active = await g('/checklist-templates?active=true&limit=100', viewer);
    expect(active.body.data.every((t: any) => t.active)).toBe(true);
    expect(active.body.meta.total).toBeLessThan(8);
    const psc = await g('/checklist-templates?inspectionType=PSC', viewer);
    expect(psc.body.data.every((t: any) => t.inspectionType === 'PSC')).toBe(true);
    const one = await g(`/checklist-templates/${all.body.data[0].id}`, viewer);
    expect(one.body.data).toMatchObject({ totalWeight: expect.any(Number), criticalCount: expect.any(Number), inspectionsUsing: expect.any(Number) });
    expect(one.body.data.sections.length).toBeGreaterThan(0);
    const q = await g('/checklist-templates?q=MLC', viewer);
    expect(q.body.data.length).toBeGreaterThan(0);
  });

  it('creates a template, raises the version only when the questions change, activates and deletes it', async () => {
    await clearOutbox();
    const body = { name: 'Bunker Transfer Watch (test)', inspectionType: 'HSE', description: 'Jetty bunkering watch', passScorePct: 90, active: false,
      items: [{ text: 'Scuppers plugged', category: 'Bunkering', weight: 2, critical: true }, { text: 'Drip trays in place', category: 'Bunkering', weight: 1 }] };
    const made = await post('/checklist-templates', body);
    expect(made.status).toBe(201);
    const t = made.body.data;
    expect(t).toMatchObject({ version: 1, itemCount: 2, totalWeight: 3, criticalCount: 1, active: false });
    expect(t.items.map((i: any) => i.seq)).toEqual([1, 2]);
    expect((await outbox(EVENTS.inspection.templateCreated))[0].data).toMatchObject({ name: body.name });
    expect((await outbox(EVENTS.readModel.upserted)).some((e) => e.data.kind === 'checklistTemplate')).toBe(true);
    expect((await post('/checklist-templates', body)).status).toBe(409);

    const meta = await put(`/checklist-templates/${t.id}`, { description: 'Jetty bunkering watch — revised wording' });
    expect(meta.body.data).toMatchObject({ version: 1, description: 'Jetty bunkering watch — revised wording' });
    const changed = await put(`/checklist-templates/${t.id}`, { items: [...t.items, { text: 'Bunker checklist agreed with barge master', category: 'Bunkering', weight: 2 }] });
    expect(changed.body.data).toMatchObject({ version: 2, itemCount: 3 });

    expect((await post(`/checklist-templates/${t.id}/activate`, { active: true })).body.data.active).toBe(true);
    expect((await post(`/checklist-templates/${t.id}/activate`, { active: true })).status).toBe(409);
    await clearOutbox();
    expect((await del(`/checklist-templates/${t.id}`)).body.data).toMatchObject({ deleted: true });
    expect((await outbox(EVENTS.readModel.deleted))[0].data).toMatchObject({ kind: 'checklistTemplate', id: t.id });
  });

  it('refuses to delete a template a survey was worked from, and refuses to activate an empty one', async () => {
    const used = (await pool.query<{ id: string }>('SELECT DISTINCT template_id AS id FROM inspections WHERE template_id IS NOT NULL LIMIT 1')).rows[0];
    const res = await del(`/checklist-templates/${used.id}`);
    expect(res.status).toBe(409);
    expect(res.body.message).toMatch(/deactivate it instead/i);
    const empty = (await post('/checklist-templates', { name: 'Empty (test)', inspectionType: 'TERMINAL', active: false, items: [] })).body.data;
    expect((await post(`/checklist-templates/${empty.id}/activate`, { active: true })).status).toBe(400);
    await del(`/checklist-templates/${empty.id}`);
  });

  it('scores a survey against the template version it was planned with, not the one live today', async () => {
    const v = await freeVessel();
    const tpl = (await post('/checklist-templates', { name: 'Weighted probe (test)', inspectionType: 'FSI', passScorePct: 80,
      items: [{ text: 'Heavy question', category: 'Probe', weight: 9 }, { text: 'Light question', category: 'Probe', weight: 1 }] })).body.data;
    const doc = (await post('/inspections', { vesselId: v.id, type: 'FSI', plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor', templateId: tpl.id }, surveyor)).body.data;
    // the template is re-weighted after the survey was planned — the survey keeps the weights it copied
    await put(`/checklist-templates/${tpl.id}`, { items: [{ text: 'Heavy question', category: 'Probe', weight: 1 }, { text: 'Light question', category: 'Probe', weight: 9 }] });
    const answers = doc.checklist.map((c: any) => ({ ...c, answer: c.text === 'Heavy question' ? 'YES' : 'NO' }));
    await put(`/inspections/${doc.id}`, { checklist: answers }, surveyor);
    const closed = (await post(`/inspections/${doc.id}/close`, { result: 'DEFICIENCIES' }, surveyor)).body.data;
    expect(closed.scorePct).toBe(90);
    expect(closed.passScorePct).toBe(80);
  });

  it('detains on the checklist when a critical question is failed', async () => {
    const v = await freeVessel();
    const tpl = (await post('/checklist-templates', { name: 'Critical probe (test)', inspectionType: 'ISM',
      items: [{ text: 'Critical question', category: 'Probe', weight: 1, critical: true }, { text: 'Ordinary question', category: 'Probe', weight: 9 }] })).body.data;
    const doc = (await post('/inspections', { vesselId: v.id, type: 'ISM', plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor', templateId: tpl.id }, surveyor)).body.data;
    const answers = doc.checklist.map((c: any) => ({ ...c, answer: c.critical ? 'NO' : 'YES' }));
    await put(`/inspections/${doc.id}`, { checklist: answers }, surveyor);
    const sheet = await g(`/inspections/${doc.id}/checklist`);
    expect(sheet.body.data).toMatchObject({ criticalFail: true, suggested: 'DETAINED', pct: 90 });
    const closed = (await post(`/inspections/${doc.id}/close`, { result: 'DETAINED' }, surveyor)).body.data;
    expect(closed).toMatchObject({ criticalFail: true, detention: true });
    await post(`/inspections/${doc.id}/detention/release`, { note: 'Rectified' }, surveyor);
  });
});

describe('inspection — the consumer', () => {
  it('projects a ship, corrects the open surveys against her and leaves closed ones alone', async () => {
    const v = await freeVessel();
    const openDoc = (await post('/inspections', { vesselId: v.id, type: 'PSC', plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor' }, surveyor)).body.data;
    const closedRow = (await pool.query<{ id: string; vessel_id: string; vessel_name: string }>(`SELECT id, vessel_id, vessel_name FROM inspections WHERE status = 'CLOSED' AND vessel_id::text = $1 LIMIT 1`, [v.id])).rows[0];
    await clearOutbox();
    const client = await pool.connect();
    try {
      const event = makeEvent({ type: EVENTS.readModel.upserted, source: 'ships', data: { kind: 'vessel', entity: { id: v.id, imo: v.imo, name: 'MV Renamed Under Way', type: 'BULK', flag: 'Panama', status: 'ACTIVE', real: false } } });
      await applyEvent(client, { env, audit }, event);
      const snap = await client.query<{ name: string; flag: string }>('SELECT name, flag FROM vessels WHERE id = $1', [v.id]);
      expect(snap.rows[0]).toMatchObject({ name: 'MV Renamed Under Way', flag: 'Panama' });
      const refreshed = await client.query<{ vessel_name: string }>('SELECT vessel_name FROM inspections WHERE id = $1', [openDoc.id]);
      expect(refreshed.rows[0].vessel_name).toBe('MV Renamed Under Way');
      if (closedRow) {
        const untouched = await client.query<{ vessel_name: string }>('SELECT vessel_name FROM inspections WHERE id = $1', [closedRow.id]);
        expect(untouched.rows[0].vessel_name).toBe(closedRow.vessel_name);
      }
    } finally { client.release(); }
    const republished = await outbox(EVENTS.readModel.upserted);
    expect(republished.some((e) => e.data.entity?.id === openDoc.id && e.data.entity?.vesselName === 'MV Renamed Under Way')).toBe(true);
    expect((await outbox(EVENTS.audit.recorded)).some((e) => e.data.action === 'VESSEL_REFRESHED')).toBe(true);
    await del(`/inspections/${openDoc.id}`);
  });

  it('projects a port call and ignores an event it does not own', async () => {
    const client = await pool.connect();
    try {
      const call = makeEvent({ type: EVENTS.readModel.upserted, source: 'ports', data: { kind: 'portCall', entity: { id: 'call-under-test', vcn: 'MAR/2026/9001', vesselId: 'x', status: 'BERTHED', berthCode: 'CT1-1' } } });
      await applyEvent(client, { env, audit }, call);
      expect((await client.query('SELECT vcn FROM port_calls WHERE id = $1', ['call-under-test'])).rows[0].vcn).toBe('MAR/2026/9001');
      const noise = makeEvent({ type: EVENTS.readModel.upserted, source: 'revenue', data: { kind: 'invoice', entity: { id: 'inv-1' } } });
      await expect(applyEvent(client, { env, audit }, noise)).resolves.toBeUndefined();
      const gone = makeEvent({ type: EVENTS.readModel.deleted, source: 'ports', data: { kind: 'portCall', id: 'call-under-test' } });
      await applyEvent(client, { env, audit }, gone);
      expect((await client.query('SELECT 1 FROM port_calls WHERE id = $1', ['call-under-test'])).rowCount).toBe(0);
    } finally { client.release(); }
  });

  it('consumes each event once — a redelivery changes nothing twice', async () => {
    const { withInbox } = await import('@maritime/service-kit');
    const event = makeEvent({ type: EVENTS.readModel.upserted, source: 'ships', data: { kind: 'vessel', entity: { id: 'twice-vessel', imo: '9999991', name: 'MV Idempotent', status: 'ACTIVE' } } });
    expect(await withInbox(pool, event, async (c) => { await applyEvent(c, { env, audit }, event); })).toBe(true);
    expect(await withInbox(pool, event, async (c) => { await applyEvent(c, { env, audit }, event); })).toBe(false);
    expect((await pool.query('SELECT count(*) AS n FROM vessels WHERE id = $1', ['twice-vessel'])).rows[0].n).toBe('1');
  });
});

describe('inspection — authorisation and the audit trail', () => {
  it('refuses an anonymous request and a principal without the permission', async () => {
    expect((await request(server as never).get('/inspections')).status).toBe(401);
    expect((await request(server as never).get('/inspections').set('authorization', 'Bearer not-a-token')).status).toBe(401);
    expect((await g('/inspections', nobody)).status).toBe(403);
    expect((await g('/inspections/dashboard', nobody)).status).toBe(403);
    expect((await g('/checklist-templates', nobody)).status).toBe(403);
    // the command centre reads the landing analytics without holding the module itself, and gets no further
    expect((await g('/inspections/dashboard', dash)).status).toBe(200);
    expect((await g('/inspections', dash)).status).toBe(403);
    const v = await freeVessel();
    expect((await post('/inspections', { vesselId: v.id, type: 'PSC', plannedAt: new Date().toISOString(), inspector: 'X' }, viewer)).status).toBe(403);
    const one = (await g('/inspections?limit=1')).body.data[0];
    expect((await put(`/inspections/${one.id}`, { remarks: 'x' }, viewer)).status).toBe(403);
    expect((await del(`/inspections/${one.id}`, viewer)).status).toBe(403);
    expect((await post(`/inspections/${one.id}/close`, { result: 'SATISFACTORY' }, viewer)).status).toBe(403);
    expect((await post('/checklist-templates', { name: 'x', inspectionType: 'PSC' }, viewer)).status).toBe(403);
    expect((await g('/health')).status).toBe(200);
  });

  it('records an audit entry for every mutation', async () => {
    const v = await freeVessel();
    await clearOutbox();
    const doc = (await post('/inspections', { vesselId: v.id, type: 'MLC', plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor' }, surveyor)).body.data;
    await post(`/inspections/${doc.id}/start`, {}, surveyor);
    const f = (await post(`/inspections/${doc.id}/findings`, { deficiencyCode: '18203', description: 'Rest hour records incomplete' }, surveyor)).body.data.findings[0];
    await put(`/inspections/${doc.id}/findings/${f.id}`, { status: 'CLOSED' }, surveyor);
    await post(`/inspections/${doc.id}/close`, { result: 'DEFICIENCIES' }, surveyor);
    const entries = (await outbox(EVENTS.audit.recorded)).map((e) => e.data.action);
    expect(entries).toEqual(expect.arrayContaining(['CREATE', 'START', 'FINDING_ADD', 'FINDING_UPDATE', 'CLOSE']));
    const created = (await outbox(EVENTS.audit.recorded)).find((e) => e.data.action === 'CREATE');
    expect(created!.data).toMatchObject({ entity: 'Inspection', entityLabel: doc.number, actor: { id: 'surveyor', name: 'Marine Surveyor' } });
    expect(created!.data.after).toMatchObject({ number: doc.number });
  });

  it('carries the correlation id from the request onto every event it publishes', async () => {
    const v = await freeVessel();
    await clearOutbox();
    const res = await request(server as never).post('/inspections').set('authorization', surveyor).set('x-correlation-id', 'corr-inspection-1')
      .send({ vesselId: v.id, type: 'ISPS', plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor' } as never);
    expect(res.status).toBe(201);
    const events = (await pool.query<{ payload: { correlationid: string } }>('SELECT payload FROM outbox ORDER BY id')).rows.map((r) => r.payload);
    expect(events.length).toBeGreaterThan(1);
    expect(events.every((e) => e.correlationid === 'corr-inspection-1')).toBe(true);
    await del(`/inspections/${res.body.data.id}`);
  });

  it('publishes a read-model snapshot carrying every field the reporting projection reads', async () => {
    await clearOutbox();
    const v = await freeVessel();
    const doc = (await post('/inspections', { vesselId: v.id, type: 'PSC', plannedAt: new Date(Date.now() + D).toISOString(), inspector: 'Marine Surveyor' }, surveyor)).body.data;
    const snap = (await outbox(EVENTS.readModel.upserted)).find((e) => e.data.entity?.id === doc.id)!.data.entity;
    for (const field of ['id', 'number', 'vesselId', 'vesselName', 'type', 'inspector', 'status', 'result', 'detention', 'plannedAt', 'startedAt', 'closedAt', 'openFindings', 'totalFindings', 'scorePct', 'findings']) {
      expect(snap).toHaveProperty(field);
    }
    await del(`/inspections/${doc.id}`);
  });
});

/* ========================================================= tenancy in the survey and audit cell === */

describe('inspection — Smart Inspection: subjects beyond ships, the dossier, the prediction, the close-out and the six KPIs', () => {
  const MIN = 60_000;
  const timeline = async (id: string) => (await pool.query<{ kind: string; source: string; meta: any; at: Date }>('SELECT kind, source, meta, at FROM inspection_timeline WHERE inspection_id = $1 ORDER BY at, id', [id])).rows;

  it('classifies a closed survey by what was found, and the rules only say — they never decide', () => {
    const f = (code: string, status = 'OPEN', severity = 'MINOR', actionCode = '17') => ({ id: code, seq: 1, deficiencyCode: code, deficiencyLabel: '', category: '', severity, description: '', actionCode, dueDate: null, status, closedAt: null, rectificationNote: '', detainable: actionCode === '30' || severity === 'DETAINABLE', overdue: false });
    expect(classify([], { criticalFail: false }, 'SATISFACTORY')).toMatchObject({ severity: 'NONE', recommendation: 'NONE' });
    expect(classify([f('11101')], { criticalFail: false }, 'DEFICIENCIES')).toMatchObject({ severity: 'MINOR', recommendation: 'RECTIFY' });
    expect(classify([f('11101', 'OPEN', 'MAJOR'), f('01101', 'OPEN', 'MAJOR')], { criticalFail: false }, 'DEFICIENCIES')).toMatchObject({ severity: 'MAJOR', recommendation: 'RESTRICT' });
    expect(classify([f('11101', 'OPEN', 'MINOR', '30')], { criticalFail: false }, 'DEFICIENCIES')).toMatchObject({ severity: 'CRITICAL', recommendation: 'DETAIN', codes: ['11101'] });
    expect(classify([], { criticalFail: true }, 'DEFICIENCIES')).toMatchObject({ severity: 'CRITICAL', recommendation: 'DETAIN' });
  });

  it('seeds the world with its subjects, its dated timeline and the programme records the KPIs read', async () => {
    const kinds = (await pool.query<{ kind: string; n: string }>('SELECT kind, count(*) AS n FROM subjects GROUP BY kind')).rows;
    expect(Object.fromEntries(kinds.map((k) => [k.kind, Number(k.n)]))).toMatchObject({ COMPANY: expect.any(Number), PORT_FACILITY: expect.any(Number), MET_INSTITUTION: expect.any(Number) });
    const subjects = (await pool.query<{ subject_kind: string; n: string }>('SELECT subject_kind, count(*) AS n FROM inspections GROUP BY subject_kind')).rows;
    const bySubject = Object.fromEntries(subjects.map((k) => [k.subject_kind, Number(k.n)]));
    expect(bySubject.VESSEL).toBeGreaterThan(100); expect(bySubject.PORT_FACILITY).toBeGreaterThan(10); expect(bySubject.COMPANY).toBeGreaterThan(5);
    const tl = (await pool.query<{ kind: string; n: string }>('SELECT kind, count(*) AS n FROM inspection_timeline GROUP BY kind')).rows;
    const byKind = Object.fromEntries(tl.map((k) => [k.kind, Number(k.n)]));
    for (const k of ['PLANNED', 'STARTED', 'CLOSED', 'DOSSIER_PREPARED', 'REPORT_DRAFTED', 'REPORT_ISSUED', 'NOTICE_DRAFTED', 'RESTRICTION_RECOMMENDED', 'RESTRICTION_ROUTED', 'PREDICTION_RECORDED', 'PREDICTION_SCORED']) expect(byKind[k], k).toBeGreaterThan(0);
    // re-seeding adds nothing twice
    const before = Number((await pool.query('SELECT count(*) AS n FROM inspection_timeline')).rows[0].n);
    await seedInspection(URL, 'AE');
    expect(Number((await pool.query('SELECT count(*) AS n FROM inspection_timeline')).rows[0].n)).toBe(before);
  });

  it('measures the six KPIs from the timeline against the module targets, and says "not captured" rather than guessing', async () => {
    const r = await g('/inspections/kpis'); expect(r.status).toBe(200);
    const k = r.body.data;
    expect(k.programme).toMatchObject({ monthsTotal: 18 }); expect(k.programme.monthsElapsed).toBeGreaterThan(0);
    expect(k.kpis.map((x: any) => x.key)).toEqual(['dossierCoverage', 'aiReports', 'noticeSpeed', 'predictionCorrelation', 'reportTurnaround', 'restrictionRouting']);
    for (const x of k.kpis) { expect(['MET', 'ON_TRACK', 'BEHIND', 'NOT_CAPTURED']).toContain(x.status); expect(x.target).toBeGreaterThan(0); expect(typeof x.detail).toBe('string'); }
    // with no programme start in the settings (MDM is unreachable here) the window opens at the first fact on record — the paper era counts against the figures
    const whole = Object.fromEntries(k.kpis.map((x: any) => [x.key, x]));
    expect(whole.dossierCoverage.value).toBeLessThan(60); expect(whole.dossierCoverage.status).toBe('BEHIND');
    expect(k.trend).toHaveLength(12); expect(k.targets).toMatchObject({ programmeMonths: 18, aiReportTargetPct: 70, programmeStart: null });
    expect((await g('/inspections/kpis?programmeStart=not-a-date')).status).toBe(400);
    // from the day the programme went live: dossiers nearly everywhere, most reports machine-first, restrictions routed inside the hour, a measured turnaround reduction
    const live = (await g('/inspections/kpis?programmeStart=2025-06-01')).body.data;
    const by = Object.fromEntries(live.kpis.map((x: any) => [x.key, x]));
    expect(live.programme.start).toBe('2025-06-01T00:00:00.000Z');
    expect(by.dossierCoverage.value).toBeGreaterThan(60); expect(by.aiReports.value).toBeGreaterThan(40);
    // every seeded recommendation was routed inside the hour; the ones the earlier tests raised are never routed, because no bus runs here
    expect(by.restrictionRouting.value).toBeGreaterThanOrEqual(80); expect(by.restrictionRouting.numerator).toBeGreaterThanOrEqual(3);
    expect(by.reportTurnaround.baselineMinutes).toBeGreaterThan(by.reportTurnaround.currentMinutes); expect(by.reportTurnaround.value).toBeGreaterThan(50);
    expect(by.predictionCorrelation.denominator).toBeGreaterThan(20);
    // a port cell sees the programme as it stands at its port, and a role without the permission sees nothing
    const port = await g('/inspections/kpis', khalifa); expect(port.status).toBe(200);
    expect(port.body.data.kpis.find((x: any) => x.key === 'dossierCoverage').denominator).toBeLessThanOrEqual(whole.dossierCoverage.denominator);
    expect((await g('/inspections/kpis', nobody)).status).toBe(403);
  });

  it('plans a survey against a port facility under a regime that applies to it, and refuses a regime that does not', async () => {
    const facility = (await g('/inspections/subjects?kind=PORT_FACILITY&q=')).body.data[0];
    expect(facility).toMatchObject({ kind: 'PORT_FACILITY', id: expect.any(String), name: expect.any(String) });
    expect((await g('/inspections/subjects?kind=SHIPYARD')).status).toBe(400);
    // a ship regime cannot be planned against a terminal, and an unknown regime is refused by the master
    expect((await post('/inspections', { type: 'PSC', subjectKind: 'PORT_FACILITY', subjectId: facility.id, plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor' }, surveyor)).status).toBe(400);
    expect((await post('/inspections', { type: 'NOT_A_REGIME', subjectId: facility.id, plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor' }, surveyor)).status).toBe(400);
    expect((await post('/inspections', { type: 'HSE', plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor' }, surveyor)).status).toBe(400);
    const tpl = await activeTemplate('HSE');
    await clearOutbox();
    const planned = await post('/inspections', { type: 'HSE', subjectId: facility.id, plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor', templateId: tpl.id }, surveyor);
    expect(planned.status).toBe(201);
    const doc = planned.body.data;
    expect(doc).toMatchObject({ subjectKind: 'PORT_FACILITY', subjectId: facility.id, subjectName: facility.name, vesselId: null, type: 'HSE', regime: 'HSE', hasDossier: true });
    // planning made the dossier and recorded a prediction before anyone looked
    const full = (await g(`/inspections/${doc.id}`)).body.data;
    expect(full.dossier).toMatchObject({ subject: { kind: 'PORT_FACILITY', name: facility.name }, source: 'AUTO' });
    expect(full.prediction).toMatchObject({ source: 'RULES', band: expect.any(String), scoredAt: null });
    expect((await outbox(EVENTS.inspection.dossierPrepared)).length).toBe(1);
    expect((await outbox(EVENTS.inspection.predictionRecorded))[0].data).toMatchObject({ inspectionId: doc.id, source: 'RULES' });
    expect((await timeline(doc.id)).map((t) => t.kind)).toEqual(['PLANNED', 'DOSSIER_PREPARED', 'PREDICTION_RECORDED']);
    // the register lists it by subject kind and regime
    const list = await g(`/inspections?subjectKind=PORT_FACILITY&regime=HSE&q=${encodeURIComponent(facility.name)}`);
    expect(list.body.data.some((x: any) => x.id === doc.id)).toBe(true);
    await del(`/inspections/${doc.id}`);
  });

  it('carries the Smart Inspection agent\'s judgement of a ship onto her survey, boards with the dossier, closes with a classification, routes the restriction inside the hour and scores the prediction', async () => {
    const v = await freeVessel(); const tpl = await activeTemplate('PSC');
    const client = await pool.connect();
    try {
      // the agent published its judgement of the ship two days ago
      await applyEvent(client, { env, audit }, makeEvent({ type: EVENTS.ai.decisionRecorded, source: 'ai-agents', subject: 'dec-1', data: { decisionId: 'dec-1', agentId: 'a5_smart_inspection', entityType: 'Vessel', entityId: v.id, decision: { id: 'dec-1', entityType: 'Vessel', entityId: v.id, createdAt: new Date(Date.now() - 2 * D).toISOString(), output: { board: true, riskScore: 71, band: 'HIGH', predictedDeficiencies: [{ code: '11101', priorOccurrences: 2 }, { code: '07105', priorOccurrences: 1 }], dossier: { expiredCertificates: 1 } } } } }));
    } finally { client.release(); }
    await clearOutbox();
    const planned = await post('/inspections', { vesselId: v.id, type: 'PSC', plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor', templateId: tpl.id }, surveyor);
    expect(planned.status).toBe(201);
    const id = planned.body.data.id;
    let full = (await g(`/inspections/${id}`)).body.data;
    expect(full.prediction).toMatchObject({ source: 'A5', decisionId: 'dec-1', band: 'HIGH', predictedCodes: ['11101', '07105'] });
    expect(full.dossier.agentDossier).toMatchObject({ expiredCertificates: 1 });
    expect(full.dossier.subject).toMatchObject({ kind: 'VESSEL', name: v.name });
    // boarding: the timeline says when, after the dossier, and the read model hears of it exactly once
    await post(`/inspections/${id}/start`, {}, surveyor).expect(201);
    expect(await outbox(EVENTS.inspection.started)).toHaveLength(1);
    const tl1 = await timeline(id);
    expect(tl1.map((t) => t.kind)).toEqual(['PLANNED', 'DOSSIER_PREPARED', 'PREDICTION_RECORDED', 'STARTED']);
    expect(tl1[1].at.getTime()).toBeLessThanOrEqual(tl1[3].at.getTime());
    // a detainable deficiency is found
    await post(`/inspections/${id}/findings`, { deficiencyCode: '11101', description: 'Lifeboat falls beyond renewal date', actionCode: '30' }, surveyor).expect(201);
    await post(`/inspections/${id}/findings`, { deficiencyCode: '01101', description: 'Certificate not endorsed', actionCode: '17' }, surveyor).expect(201);
    await clearOutbox();
    const closed = await post(`/inspections/${id}/close`, { result: 'DETAINED' }, surveyor);
    expect(closed.status).toBe(201);
    expect(closed.body.data).toMatchObject({ status: 'CLOSED', severity: 'CRITICAL', recommendation: 'DETAIN' });
    // closing as detained is a restriction the closing officer decided on the spot: recommended, routed and decided in one breath
    expect(closed.body.data.recommendations).toHaveLength(1);
    expect(closed.body.data.recommendations[0]).toMatchObject({ kind: 'DETENTION', status: 'APPROVED', decision: 'APPROVED', routedMinutes: 0, detentionId: expect.any(String) });
    // the prediction scored: a predicted code was raised, the band agreed
    expect(closed.body.data.prediction).toMatchObject({ correlated: true, outcome: { matched: ['11101'], bandAgrees: true } });
    expect((await outbox(EVENTS.inspection.predictionScored))[0].data).toMatchObject({ correlated: true, matched: ['11101'] });
    expect((await outbox(EVENTS.inspection.restrictionRecommended))[0].data).toMatchObject({ kind: 'DETENTION', status: 'APPROVED' });
    expect((await outbox(EVENTS.inspection.closed))[0].data).toMatchObject({ severity: 'CRITICAL', recommendation: 'DETAIN', findingCodes: ['11101', '01101'] });
    const kinds = (await timeline(id)).map((t) => t.kind);
    expect(kinds).toEqual(expect.arrayContaining(['CLOSED', 'RESTRICTION_RECOMMENDED', 'RESTRICTION_ROUTED', 'RESTRICTION_DECIDED', 'PREDICTION_SCORED']));

    // the assistant drafted the report and the notice from the closed record; the desk records them as the machine's first draft
    const client2 = await pool.connect();
    try {
      const at = new Date(Date.now() + 5 * MIN).toISOString();
      await applyEvent(client2, { env, audit }, makeEvent({ type: EVENTS.ai.draftPrepared, source: 'ai-assistant', subject: 'draft-1', data: { draftId: 'draft-1', kind: 'INSPECTION_SUMMARY', subjectType: 'Inspection', subjectId: id, title: 'Inspection summary', preparedBy: 'Assistant', draft: { id: 'draft-1', body: 'INSPECTION SUMMARY — drafted', createdAt: at } } }));
      await applyEvent(client2, { env, audit }, makeEvent({ type: EVENTS.ai.draftPrepared, source: 'ai-assistant', subject: 'draft-2', data: { draftId: 'draft-2', kind: 'DEFICIENCY_NOTICE', subjectType: 'Inspection', subjectId: id, title: 'Notice of detention', preparedBy: 'Assistant', draft: { id: 'draft-2', body: 'NOTICE OF DETENTION — drafted', createdAt: at } } }));
      // redelivered, it changes nothing twice
      await applyEvent(client2, { env, audit }, makeEvent({ type: EVENTS.ai.draftPrepared, source: 'ai-assistant', subject: 'draft-1', data: { draftId: 'draft-1', kind: 'INSPECTION_SUMMARY', subjectType: 'Inspection', subjectId: id, title: 'Inspection summary', preparedBy: 'Assistant', draft: { id: 'draft-1', body: 'again', createdAt: at } } }));
    } finally { client2.release(); }
    full = (await g(`/inspections/${id}`)).body.data;
    expect(full.reports).toHaveLength(1); expect(full.reports[0]).toMatchObject({ source: 'AI', aiDrafted: true, status: 'DRAFT', draftId: 'draft-1', version: 1 });
    expect(full.notices).toHaveLength(1); expect(full.notices[0]).toMatchObject({ source: 'AI', kind: 'DETENTION', status: 'DRAFT', number: expect.stringMatching(/^NOT-\d{4}-\d{4}$/), findingIds: expect.any(Array) });
    // the officer issues the notice and the report; a reader cannot
    expect((await post(`/inspections/${id}/notices/${full.notices[0].id}/issue`, {}, viewer)).status).toBe(403);
    const issuedNotice = await post(`/inspections/${id}/notices/${full.notices[0].id}/issue`, {}, surveyor); expect(issuedNotice.status).toBe(201); expect(issuedNotice.body.data).toMatchObject({ status: 'ISSUED', issuedBy: 'Marine Surveyor' });
    expect((await post(`/inspections/${id}/notices/${full.notices[0].id}/issue`, {}, surveyor)).status).toBe(404);
    const issuedReport = await post(`/inspections/${id}/report/${full.reports[0].id}/issue`, {}, surveyor); expect(issuedReport.status).toBe(201); expect(issuedReport.body.data).toMatchObject({ status: 'ISSUED' });
    expect((await outbox(EVENTS.inspection.reportIssued))[0].data).toMatchObject({ inspectionId: id, source: 'AI', minutesAfterClose: expect.any(Number) });
    // an officer's own report supersedes nothing that was issued, and counts as manual
    const manual = await post(`/inspections/${id}/report`, { body: 'The officer\'s own account.' }, surveyor); expect(manual.status).toBe(201); expect(manual.body.data).toMatchObject({ source: 'MANUAL', version: 2, status: 'DRAFT' });
    const finalKinds = (await timeline(id)).map((t) => t.kind);
    expect(finalKinds.filter((k) => k === 'REPORT_DRAFTED')).toHaveLength(2); expect(finalKinds).toContain('NOTICE_ISSUED'); expect(finalKinds).toContain('REPORT_ISSUED');
    // the survey's timeline is readable on its own
    expect((await g(`/inspections/${id}/timeline`)).body.data.map((t: any) => t.kind)).toEqual(finalKinds);
    // release the ship so the world is left as it was found
    await put(`/inspections/${id}/findings/${full.findings[0].id}`, { status: 'CLOSED', rectificationNote: 'Falls renewed' }, surveyor).expect(200);
    await post(`/inspections/${id}/detention/release`, { note: 'Rectified' }, surveyor).expect(201);
  });

  it('routes a recommendation short of detention to the deciding officer, and measures the time to the decision', async () => {
    const v = await freeVessel(); const tpl = await activeTemplate('PSC');
    const planned = await post('/inspections', { vesselId: v.id, type: 'PSC', plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor', templateId: tpl.id }, surveyor);
    const id = planned.body.data.id;
    await clearOutbox();
    for (const code of ['01101', '04103', '07105', '10111', '13101']) await post(`/inspections/${id}/findings`, { deficiencyCode: code, description: `${code} observed`, actionCode: '17' }, surveyor).expect(201);
    // the first finding boarded her: one STARTED fact on the timeline, one started event for the read model, however many findings followed
    expect((await timeline(id)).filter((t) => t.kind === 'STARTED')).toHaveLength(1);
    expect(await outbox(EVENTS.inspection.started)).toHaveLength(1);
    await clearOutbox();
    const closed = await post(`/inspections/${id}/close`, { result: 'DEFICIENCIES' }, surveyor);
    expect(closed.body.data).toMatchObject({ severity: 'MAJOR', recommendation: 'RESTRICT' });
    const rec = closed.body.data.recommendations[0];
    expect(rec).toMatchObject({ kind: 'RESTRICTION', status: 'PENDING', routedAt: null });
    // the recommendation reaches the deciding officers when it comes back off the bus — the consumer stamps the routing
    const ev = (await outbox(EVENTS.inspection.restrictionRecommended))[0];
    const client = await pool.connect();
    try { await applyEvent(client, { env, audit }, ev as never); } finally { client.release(); }
    const worklist = await g('/inspections/recommendations?status=PENDING');
    const mine = worklist.body.data.find((x: any) => x.id === rec.id);
    expect(mine).toMatchObject({ number: closed.body.data.number, routedMinutes: 0, status: 'PENDING' });
    // a reader may not decide; the closing officer may, and a second decision is refused
    expect((await post(`/inspections/${id}/recommendations/${rec.id}/decide`, { decision: 'REJECTED', note: 'Rectification plan accepted' }, viewer)).status).toBe(403);
    const decided = await post(`/inspections/${id}/recommendations/${rec.id}/decide`, { decision: 'REJECTED', note: 'Rectification plan accepted instead' }, surveyor);
    expect(decided.status).toBe(201); expect(decided.body.data).toMatchObject({ status: 'REJECTED', decidedBy: 'Marine Surveyor', decidedMinutes: expect.any(Number) });
    expect((await post(`/inspections/${id}/recommendations/${rec.id}/decide`, { decision: 'APPROVED' }, surveyor)).status).toBe(409);
    expect((await outbox(EVENTS.inspection.restrictionDecided))[0].data).toMatchObject({ recommendationId: rec.id, decision: 'REJECTED' });
    // an officer may also recommend outside the rules, and approving a detention orders it
    const own = await post(`/inspections/${id}/recommendations`, { kind: 'DETENTION', grounds: 'Repeat offender; deficiencies unrectified', codes: ['01101'] }, surveyor);
    expect(own.status).toBe(201); expect(own.body.data).toMatchObject({ source: 'MANUAL', status: 'PENDING' });
    const approved = await post(`/inspections/${id}/recommendations/${own.body.data.id}/decide`, { decision: 'APPROVED', note: 'Detain' }, surveyor);
    expect(approved.body.data).toMatchObject({ status: 'APPROVED', detentionId: expect.any(String) });
    // decided before the bus routed it: the officer plainly reached it, so the routing is stamped at the decision and the bus is a no-op afterwards
    const facts = (await g(`/inspections/${id}/timeline`)).body.data;
    expect(facts.find((t: any) => t.kind === 'RESTRICTION_ROUTED' && t.meta?.recommendationId === own.body.data.id)).toMatchObject({ source: 'DESK', meta: { via: 'decision' } });
    const late = await pool.connect();
    try { expect(await routeRecommendation(late, own.body.data.id, new Date())).toBe(false); } finally { late.release(); }
    expect(facts.filter((t: any) => t.kind === 'RESTRICTION_ROUTED').length).toBe(2);
    expect((await g(`/inspections/${id}`)).body.data).toMatchObject({ detention: true, detentionRecord: { status: 'ORDERED' } });
    expect((await outbox(EVENTS.inspection.detention)).length).toBe(1);
    // and the manual notice path
    const notice = await post(`/inspections/${id}/notices`, { kind: 'DEFICIENCY', body: 'Rectify within 14 days.', findingIds: [(await g(`/inspections/${id}`)).body.data.findings[0].id] }, surveyor);
    expect(notice.status).toBe(201); expect(notice.body.data).toMatchObject({ source: 'MANUAL', aiDrafted: false, status: 'DRAFT' });
    expect((await post(`/inspections/${id}/notices`, { body: 'x', findingIds: ['00000000-0000-0000-0000-000000000000'] }, surveyor)).status).toBe(400);
    for (const f of (await g(`/inspections/${id}`)).body.data.findings) await put(`/inspections/${id}/findings/${f.id}`, { status: 'CLOSED' }, surveyor).expect(200);
    await post(`/inspections/${id}/detention/release`, { note: 'Rectified' }, surveyor).expect(201);
  });

  it('refreshes the dossier on request, keeps a closed survey read-only, and sweeps overdue findings once a week', async () => {
    const v = await freeVessel();
    const planned = await post('/inspections', { vesselId: v.id, type: 'FSI', plannedAt: new Date().toISOString(), inspector: 'Marine Surveyor' }, surveyor);
    const id = planned.body.data.id;
    const refreshed = await post(`/inspections/${id}/dossier`, {}, surveyor);
    expect(refreshed.status).toBe(201); expect(refreshed.body.data).toMatchObject({ source: 'DESK', dossier: { subject: { name: v.name } } });
    expect((await g(`/inspections/${id}/dossier`)).body.data).toMatchObject({ source: 'DESK', preparedAt: expect.any(String) });
    expect((await timeline(id)).filter((t) => t.kind === 'DOSSIER_PREPARED')).toHaveLength(2);
    // an overdue finding
    await post(`/inspections/${id}/findings`, { deficiencyCode: '01101', description: 'Overdue', actionCode: '17', dueDate: new Date(Date.now() - 3 * D).toISOString() }, surveyor).expect(201);
    await clearOutbox();
    const client = await pool.connect();
    try {
      const swept = await sweepOverdueFindings(client, env, new Date());
      expect(swept.inspections).toBeGreaterThanOrEqual(1);
      const again = await sweepOverdueFindings(client, env, new Date());
      expect(again.inspections).toBe(0); // flagged this week already
    } finally { client.release(); }
    const overdue = await outbox(EVENTS.inspection.deficiencyOverdue);
    expect(overdue.some((e) => e.data.inspectionId === id && e.data.count === 1)).toBe(true);
    // the scheduler's tick reaches the same sweep through the consumer
    const client2 = await pool.connect();
    try { await applyEvent(client2, { env, audit }, makeEvent({ type: EVENTS.scheduler.sweepFindings, source: 'scheduler', data: { jobKey: 'finding-overdue-sweep' } })); } finally { client2.release(); }
    await put(`/inspections/${id}/findings/${(await g(`/inspections/${id}`)).body.data.findings[0].id}`, { status: 'CLOSED' }, surveyor).expect(200);
    await post(`/inspections/${id}/close`, { result: 'SATISFACTORY' }, surveyor).expect(201);
    expect((await post(`/inspections/${id}/dossier`, {}, surveyor)).status).toBe(409);
    expect((await post(`/inspections/${id}/report/00000000-0000-0000-0000-000000000000/issue`, {}, surveyor)).status).toBe(404);
  });

  it('projects a company from its register into the subjects a survey can be planned against, and forgets it when it goes', async () => {
    const client = await pool.connect();
    try {
      await applyEvent(client, { env, audit }, makeEvent({ type: EVENTS.readModel.upserted, source: 'facilities', subject: 'co-x', data: { kind: 'company', entity: { id: 'co-x', code: 'COX', name: 'Coral Offshore Services (test)', status: 'ACTIVE', category: 'SERVICE_PROVIDER' } } }));
      expect((await g('/inspections/subjects?kind=COMPANY&q=Coral%20Offshore')).body.data).toEqual([expect.objectContaining({ id: 'co-x', code: 'COX' })]);
      await applyEvent(client, { env, audit }, makeEvent({ type: EVENTS.readModel.deleted, source: 'facilities', subject: 'co-x', data: { kind: 'company', id: 'co-x' } }));
      expect((await g('/inspections/subjects?kind=COMPANY&q=Coral%20Offshore')).body.data).toEqual([]);
    } finally { client.release(); }
  });
});

describe('inspection — tenancy', () => {
  /** Two calls in two ports, and a survey raised against each, so the rule is tested in both directions. */
  const anyVessel = async () => (await pool.query<{ id: string }>('SELECT id FROM vessels ORDER BY id LIMIT 1')).rows[0].id;
  const setUp = async () => {
    const ANY_VESSEL = await anyVessel();
    await pool.query(`INSERT INTO port_calls(id, vcn, vessel_id, status, berth_code, eta, scope_port) VALUES
      ('ten-auh', 'TEN-VCN-AUH', $1, 'BERTHED', 'CT9', now(), 'AEAUH'),
      ('ten-fjr', 'TEN-VCN-FJR', $1, 'BERTHED', 'FJR-1', now(), 'AEFJR')
      ON CONFLICT (id) DO UPDATE SET scope_port = EXCLUDED.scope_port`, [ANY_VESSEL]);
    const mk = async (n: string, call: string) => (await pool.query<{ id: string }>(
      `INSERT INTO inspections(number, type, status, vessel_id, vessel_name, port_call_id, planned_at)
       VALUES ($1, 'PSC', 'PLANNED', $2, 'Test Ship', $3, now()) RETURNING id`, [n, ANY_VESSEL, call])).rows[0].id;
    return { auh: await mk('TEN-INS-AUH', 'ten-auh'), fjr: await mk('TEN-INS-FJR', 'ten-fjr') };
  };
  const tearDown = async () => {
    await pool.query("DELETE FROM inspections WHERE number LIKE 'TEN-%'");
    await pool.query("DELETE FROM port_calls WHERE id IN ('ten-auh','ten-fjr')");
  };

  it('takes the port from the call the survey was raised against, and follows the call if it moves', async () => {
    const { auh, fjr } = await setUp();
    try {
      const ports = await pool.query<{ id: string; scope_port: string }>(
        'SELECT id, scope_port FROM inspections WHERE id = ANY($1)', [[auh, fjr]]);
      expect(new Map(ports.rows.map((r) => [r.id, r.scope_port]))).toEqual(new Map([[auh, 'AEAUH'], [fjr, 'AEFJR']]));

      // the call register is not this service's to own: when the port changes there, the surveys follow
      await pool.query("UPDATE port_calls SET scope_port = 'AEFJR' WHERE id = 'ten-auh'");
      expect((await pool.query<{ scope_port: string }>('SELECT scope_port FROM inspections WHERE id = $1', [auh])).rows[0].scope_port).toBe('AEFJR');
      await pool.query("UPDATE port_calls SET scope_port = 'AEAUH' WHERE id = 'ten-auh'");

      // a survey arranged away from any call is no port's and is shared
      const loose = await pool.query<{ scope_port: string }>(
        `INSERT INTO inspections(number, type, status, vessel_id, vessel_name, planned_at)
         VALUES ('TEN-INS-FSI', 'FSI', 'PLANNED', $1, 'Test Ship', now()) RETURNING scope_port`, [await anyVessel()]);
      expect(loose.rows[0].scope_port).toBe('');
    } finally { await tearDown(); }
  });

  it('shows a cell its own port\'s surveys and answers "not found" for another port\'s', async () => {
    const { auh, fjr } = await setUp();
    try {
      expect((await g(`/inspections/${auh}`, khalifa)).status).toBe(200);
      expect((await g(`/inspections/${fjr}`, khalifa)).status).toBe(404);
      expect((await g(`/inspections/${fjr}`, fujairah)).status).toBe(200);
      expect((await g(`/inspections/${fjr}`, admin)).status).toBe(200);
      // by survey number as well as by id, because the filter is in the query
      expect((await g('/inspections/TEN-INS-FJR', khalifa)).status).toBe(404);

      expect((await g('/inspections?limit=500&q=TEN-INS', khalifa)).body.data.map((i: { number: string }) => i.number)).toEqual(['TEN-INS-AUH']);
      expect((await g('/inspections?limit=500&q=TEN-INS', fujairah)).body.data.map((i: { number: string }) => i.number)).toEqual(['TEN-INS-FJR']);
      expect((await g('/inspections?limit=500&q=TEN-INS', admin)).body.meta.total).toBe(2);
    } finally { await tearDown(); }
  });

  it('counts only what the reader may see, so a total cannot leak another port\'s workload', async () => {
    const { auh } = await setUp();
    try {
      expect(auh).toBeTruthy();
      const mine = await g('/inspections/dashboard', khalifa);
      const all = await g('/inspections/dashboard', admin);
      expect(mine.status).toBe(200);
      expect(mine.body.data.kpis.open).toBeLessThan(all.body.data.kpis.open);
      // the sub-registers read through the survey they hang off, so they are narrowed with it
      expect((await g('/inspections/deficiencies?limit=1', khalifa)).body.meta.total)
        .toBeLessThanOrEqual((await g('/inspections/deficiencies?limit=1', admin)).body.meta.total);
      expect((await g('/inspections/detentions?limit=1', khalifa)).body.meta.total)
        .toBeLessThanOrEqual((await g('/inspections/detentions?limit=1', admin)).body.meta.total);
    } finally { await tearDown(); }
  });

  it('shows a company nothing: an inspection report is the administration\'s finding, not the operator\'s copy', async () => {
    const { auh } = await setUp();
    try {
      expect((await g('/inspections?limit=500', agentGss)).body.meta.total).toBe(0);
      expect((await g(`/inspections/${auh}`, agentGss)).status).toBe(404);
      expect((await g('/inspections/deficiencies?limit=1', agentGss)).body.meta.total).toBe(0);
    } finally { await tearDown(); }
  });

  it('leaves a national cell reading everything, with no clause added at all', async () => {
    expect((await g('/inspections?limit=1', viewer)).body.meta.total).toBe((await g('/inspections?limit=1', admin)).body.meta.total);
  });
});
