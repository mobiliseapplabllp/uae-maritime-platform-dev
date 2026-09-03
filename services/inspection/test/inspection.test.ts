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

const DB = 'maritime_inspection_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let audit: AuditClient; let env: ReturnType<typeof loadEnv<typeof envSchema>>;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const surveyor = tok('surveyor'); const viewer = tok('viewer'); const nobody = tok('nobody'); const dash = tok('dash');
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
