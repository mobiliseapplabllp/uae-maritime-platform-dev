import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { EVENTS, subjectFor } from '@maritime/contracts';
import { PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256 } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedAiAgents } from '../src/seed';
import { actionsFor } from '../src/actions';
import { insightsFor } from '../src/insights';

/* The agents' hands: an applied conclusion is carried to the record through the tool gateway as the agent; an
 * accepted one as the reviewer, with their token. A fake gateway stands in and records what it was asked. */

const DB = 'maritime_ai_agents_gw_test'; const DB_URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let fake: Server; let fakeUrl = '';
const tok = (sub: string) => signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' });
const admin = tok('admin'); const reviewer = tok('reviewer'); const officer = tok('officer');
const g = (p: string, t = admin) => request(server as never).get(p).set('authorization', `Bearer ${t}`);
const post = (p: string, body?: unknown, t = admin) => request(server as never).post(p).set('authorization', `Bearer ${t}`).send((body ?? {}) as never);
const outbox = async (type: string) => (await pool.query('SELECT payload FROM outbox WHERE subject = $1 ORDER BY id', [subjectFor(type)])).rows.map((r) => r.payload as { data: Record<string, unknown> });

let seen: { url: string; headers: Record<string, string | string[] | undefined>; body: any }[] = [];
let refuse: Record<string, { code: string; reason: string }> = {};
const FINANCE = { currency: 'AED', targets: { dsoDays: 40, ceiPct: 90 }, kpis: { overdueAmount: 125000, overdueCount: 2, remindersDue: 1, dsoDays: 52.3, ceiPct: 93, drafts: { count: 0, total: 0 } }, overdueList: [{ id: 'inv-1', number: 'MAR/INV/2026/0101', billTo: 'Gulf Star Shipping Agency LLC', balance: 80000, daysOverdue: 12, remindedAt: null }, { id: 'inv-2', number: 'MAR/INV/2026/0088', billTo: 'Trident Marine Agencies', balance: 45000, daysOverdue: 30, remindedAt: '2026-09-01T00:00:00.000Z' }] };
const handle = (req: IncomingMessage, res: ServerResponse) => {
  let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined; const url = req.url ?? ''; seen.push({ url, headers: req.headers, body });
    const json = (status: number, payload: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    const run = url.match(/^\/ai-gateway\/tools\/([^/]+)\/run$/);
    if (!run) return json(404, { success: false, message: 'not here' });
    const tool = decodeURIComponent(run[1]);
    if (req.headers['x-service-token'] !== 'development-service-token') return json(401, { success: false, message: 'Service token required' });
    const tier = /\.(add_note|request_info|send_reminder|verify_document|assign|transition_call)$/.test(tool) ? 'ACT' : 'READ';
    const r = refuse[tool];
    if (r) return json(201, { success: true, data: { callId: `c-${seen.length}`, outcome: 'REFUSED', tool, tier, module: tool.split('.')[0], latencyMs: 1, code: r.code, reason: r.reason } });
    const data = tool === 'finance.dashboard' ? FINANCE : tool === 'finance.send_reminder' ? { id: body.args.id, remindedAt: '2026-09-06T10:00:00.000Z' } : { ok: true };
    return json(201, { success: true, data: { callId: `c-${seen.length}`, outcome: 'OK', tool, tier, module: tool.split('.')[0], latencyMs: 4, status: tier === 'ACT' ? 201 : 200, data, principal: { id: req.headers['x-user-token'] ? 'person' : 'agent', name: 'x', kind: req.headers['x-user-token'] ? 'user' : 'agent' } } });
  });
};

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedAiAgents(DB_URL, 'AE');
  fake = createServer(handle);
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => { fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`; r(); }));
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: DB_URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, MDM_URL: 'http://127.0.0.1:1', AI_TOOL_GATEWAY_URL: fakeUrl, ACTIONS_MODE: 'gateway' } as never);
  const base = { scope: { level: 'NATIONAL' as const }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    admin: { ...base, id: 'admin', sub: 'admin', name: 'Admin', perms: ['*'] },
    reviewer: { ...base, id: 'reviewer', sub: 'reviewer', name: 'Duty Reviewer', perms: ['agents.view', 'agents.review'] },
    officer: { ...base, id: 'officer', sub: 'officer', name: 'Finance Officer', perms: ['dashboard.view', 'invoices.view', 'invoices.issue'] },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer(); pool = new Pool({ connectionString: DB_URL });
});
afterAll(async () => { await app?.close(); await pool?.end(); await new Promise((r) => fake.close(r)); });

describe('ai-agents — what a conclusion does, as tool calls', () => {
  it('maps the application agents onto reversible actions and nothing else', () => {
    const base = { subjectType: 'ServiceRequest', subjectId: 'req-1', subjectLabel: 'SR-1', explanation: '', agentName: 'Agent' };
    expect(actionsFor('a4_customer_guidance', { ...base, output: { message: 'Your application is at the assessment stage.' } })).toEqual([{ tool: 'services.add_note', args: { id: 'req-1', body: 'To the applicant — Your application is at the assessment stage.' }, label: 'Tell the applicant where the application stands' }]);
    expect(actionsFor('a1_document_intelligence', { ...base, output: { complete: false, missing: ['Crew list', 'P&I cover note'] } })[0]).toMatchObject({ tool: 'services.request_info', args: { id: 'req-1' } });
    expect(actionsFor('a1_document_intelligence', { ...base, output: { complete: true, missing: [], failedChecks: [] } })[0]).toMatchObject({ tool: 'services.add_note' });
    expect(actionsFor('a3_service_processing', { ...base, output: { eligible: true, gates: [{ gate: 'Fee settled', passed: true, detail: 'paid' }] } })[0]).toMatchObject({ tool: 'services.add_note' });
    expect(actionsFor('a3_service_processing', { ...base, output: { eligible: false, gates: [{ gate: 'Mandatory documents on file', passed: false, detail: 'missing Crew list' }] } })[0]).toMatchObject({ tool: 'services.request_info' });
    expect(actionsFor('a2_vessel_compliance', { ...base, subjectType: 'Vessel', output: { notInForce: ['x'] } })).toEqual([]);
    expect(actionsFor('a5_smart_inspection', { ...base, subjectType: 'Vessel', output: { board: true } })).toEqual([]);
    expect(actionsFor('a4_customer_guidance', { ...base, subjectType: 'Vessel', output: { message: 'x' } })).toEqual([]);
  });
  it('carries an autonomous agent\'s applied conclusion to the record as the agent, through the gateway', async () => {
    seen = [];
    const r = await post('/agents/a4_customer_guidance/run', { limit: 3 });
    expect(r.status).toBe(201); expect(r.body.data.applied).toBeGreaterThanOrEqual(1);
    const applied = r.body.data.decisions.find((d: { applied: boolean }) => d.applied);
    expect(applied.execution).toHaveLength(1);
    expect(applied.execution[0]).toMatchObject({ tool: 'services.add_note', outcome: 'OK', as: 'agent', status: 201 });
    const call = seen.find((s) => s.url === '/ai-gateway/tools/services.add_note/run')!;
    expect(call.headers['x-user-token']).toBeUndefined();
    expect(call.body).toMatchObject({ caller: 'agent:a4_customer_guidance', decisionId: applied.id, cause: 'run', args: { id: applied.subjectId } });
    expect(String(call.body.args.body)).toContain('To the applicant');
    const detail = await g(`/agents/decisions/${applied.id}`);
    expect(detail.body.data.execution[0].outcome).toBe('OK'); expect(detail.body.data.executedAt).toBeTruthy();
    const audits = await outbox(EVENTS.audit.recorded);
    expect(audits.some((a) => a.data.action === 'AI_DECISION_EXECUTED')).toBe(true);
  });
  it('keeps a refusal at the gateway on the decision, and records the conclusion all the same', async () => {
    refuse = { 'services.add_note': { code: 'HOURLY_QUOTA', reason: 'agent:a4_customer_guidance has made 600 calls this hour against a quota of 600' } };
    const r = await post('/agents/a4_customer_guidance/run', { limit: 2 });
    const applied = r.body.data.decisions.find((d: { applied: boolean }) => d.applied);
    expect(applied.execution[0]).toMatchObject({ outcome: 'REFUSED', code: 'HOURLY_QUOTA' });
    refuse = {};
    const audits = await outbox(EVENTS.audit.recorded);
    expect(audits.some((a) => a.data.action === 'AI_DECISION_EXECUTION_INCOMPLETE')).toBe(true);
  });
  it('carries an accepted conclusion to the record as the person who accepted it, with their token', async () => {
    seen = [];
    const run = await post('/agents/a1_document_intelligence/run', { limit: 4 });
    expect(run.status).toBe(201);
    const open = run.body.data.decisions.find((d: { disposition: string }) => d.disposition === 'AWAITING_REVIEW' || d.disposition === 'ESCALATED');
    expect(open).toBeTruthy(); expect(open.execution).toEqual([]);
    expect(seen.filter((s) => s.url.includes('/tools/'))).toHaveLength(0);
    const accepted = await post(`/agents/decisions/${open.id}/review`, { accept: true, reason: 'Checked the file' }, reviewer);
    expect(accepted.status).toBe(201); expect(accepted.body.data.disposition).toBe('APPROVED_BY_HUMAN');
    expect(accepted.body.data.execution).toHaveLength(1); expect(accepted.body.data.execution[0]).toMatchObject({ outcome: 'OK', as: 'person' });
    const call = seen.find((s) => s.url.includes('/tools/'))!;
    expect(call.headers['x-user-token']).toBe(reviewer);
    expect(call.body).toMatchObject({ caller: 'svc:ai-agents', decisionId: accepted.body.data.id, cause: 'review' });
    const original = await g(`/agents/decisions/${open.id}`);
    expect(original.body.data.execution).toEqual([]);
  });
  it('does nothing to the record when a conclusion is overturned', async () => {
    seen = [];
    const run = await post('/agents/a1_document_intelligence/run', { limit: 6 });
    const open = run.body.data.decisions.filter((d: { disposition: string }) => d.disposition === 'AWAITING_REVIEW' || d.disposition === 'ESCALATED').at(-1);
    const r = await post(`/agents/decisions/${open.id}/review`, { accept: false, reason: 'The file says otherwise' }, reviewer);
    expect(r.body.data.disposition).toBe('OVERRIDDEN'); expect(r.body.data.execution).toEqual([]);
    expect(seen.filter((s) => s.url.includes('/tools/'))).toHaveLength(0);
  });
});

describe('ai-agents — insights', () => {
  it('reads a module\'s dashboard as the person looking and says what to look at next', async () => {
    seen = [];
    const r = await g('/agents/insights/finance', officer);
    expect(r.status).toBe(200);
    expect(seen[0]).toMatchObject({ url: '/ai-gateway/tools/finance.dashboard/run', body: { caller: 'agent:insights', cause: 'insights:finance' } }); expect(seen[0].headers['x-user-token']).toBe(officer);
    const ids = r.body.data.insights.map((i: { id: string }) => i.id);
    expect(ids).toEqual(expect.arrayContaining(['finance.overdue', 'finance.remind-inv-1', 'finance.dso']));
    expect(ids).not.toContain('finance.remind-inv-2'); expect(ids).not.toContain('finance.cei');
    expect(r.body.data.insights[0].severity).toBe('critical'); expect(r.body.data.counts.critical).toBe(1);
    const remind = r.body.data.insights.find((i: { id: string }) => i.id === 'finance.remind-inv-1');
    expect(remind).toMatchObject({ severity: 'warning', action: { tool: 'finance.send_reminder', args: { id: 'inv-1' }, tier: 'ACT' }, link: '/invoices/inv-1' });
    expect(remind.titleAr).toContain('تذكير');
  });
  it('turns a gateway refusal into an empty answer that says why', async () => {
    refuse = { 'ops.dashboard': { code: 'PERMISSION', reason: 'Finance Officer does not hold portcalls.view' } };
    const r = await g('/agents/insights/ops', officer);
    expect(r.status).toBe(200); expect(r.body.data.insights).toEqual([]); expect(r.body.data.refused).toMatchObject({ code: 'PERMISSION' });
    refuse = {};
    expect((await g('/agents/insights/nonsense', officer)).status).toBe(404);
    expect((await g('/agents/insights', officer)).body.data.modules.map((m: { module: string }) => m.module)).toContain('admin');
  });
  it('carries an insight\'s action through the gateway as the person who clicked it, and audits it', async () => {
    seen = [];
    const r = await post('/agents/insights/act', { module: 'finance', insightId: 'finance.remind-inv-1', tool: 'finance.send_reminder', args: { id: 'inv-1' } }, officer);
    expect(r.status).toBe(201); expect(r.body.data).toMatchObject({ outcome: 'OK', tool: 'finance.send_reminder' });
    expect(seen[0].headers['x-user-token']).toBe(officer); expect(seen[0].body).toMatchObject({ caller: 'svc:ai-agents', cause: 'insight:finance.remind-inv-1', args: { id: 'inv-1' } });
    const audits = await outbox(EVENTS.audit.recorded);
    expect(audits.some((a) => a.data.action === 'AI_INSIGHT_ACTED' && (a.data.after as { tool: string }).tool === 'finance.send_reminder')).toBe(true);
    expect((await request(server as never).post('/agents/insights/act').send({ module: 'finance', tool: 'x' })).status).toBe(401);
  });
  it('computes the rules without a request', () => {
    const ops = insightsFor('ops', { kpis: { berthOccupancyPct: 91, expected72h: 6, waitingOverAlertPct: 8, atAnchorage: 5, avgWaitingHrs: 11.4, waitingWithinTargetPct: 13, etaReliabilityPct: 100, berthsUnderMaintenance: 1, berthDowntimeHrs30d: 120 }, targets: { waitingHrs: 4, congestionPct: 85, anchorageAlertHrs: 24, etaSlackHrs: 4 } });
    expect(ops.map((i) => i.id)).toEqual(['ops.congested', 'ops.anchorage-overstay', 'ops.waiting', 'ops.maintenance']);
    expect(ops[0].action).toMatchObject({ tool: 'ops.berth_plan', tier: 'READ' });
    const admin = insightsFor('admin', { kpis: { privileged: 3, privilegedWithoutMfa: 3, dormant: 6, dormantDays: 90, changesPending: 0, failedLogins24h: 92, lockedAccounts: 0, mfaCoveragePct: 73, mfaOverdue: 0 } });
    expect(admin.map((i) => i.severity)).toEqual(['critical', 'warning', 'warning', 'info']);
    expect(insightsFor('platform', { summary: { services: 24, servicesUp: 24, openIncidents: 0 } })).toEqual([]);
    expect(insightsFor('unknown', {})).toEqual([]);
  });
});
