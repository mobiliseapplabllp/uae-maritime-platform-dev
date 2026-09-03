import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { EVENTS, makeEvent, subjectFor } from '@maritime/contracts';
import { AuditClient, PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256, withInbox } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedAiAgents } from '../src/seed';
import { applyEvent } from '../src/consumer';
import { adjudicate, raisesAutonomy, type AgentPolicy } from '../src/autonomy';
import { bias, drift, performance, serviceLevels, confidenceDistribution, type MetricAgent, type MetricDecision } from '../src/metrics';
import { effectOf } from '../src/runtime';

const DB = 'maritime_ai_agents_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let audit: AuditClient; let env: ReturnType<typeof loadEnv<typeof envSchema>>;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const governor = tok('governor'); const reviewer = tok('reviewer'); const viewer = tok('viewer'); const nobody = tok('nobody');
const g = (p: string, t = admin) => request(server as never).get(p).set('authorization', t);
const post = (p: string, body?: unknown, t = admin) => request(server as never).post(p).set('authorization', t).send((body ?? {}) as never);
const put = (p: string, body: unknown, t = admin) => request(server as never).put(p).set('authorization', t).send(body as never);
const outbox = async (type: string) => (await pool.query('SELECT payload FROM outbox WHERE subject = $1 ORDER BY id', [subjectFor(type)])).rows.map((r) => r.payload as { type: string; subject?: string; data: Record<string, any> });
const clearOutbox = () => pool.query('DELETE FROM outbox');
const D = 86_400_000;

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedAiAgents(URL, 'AE');
  env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, MDM_URL: 'http://127.0.0.1:1' } as never);
  const base = { scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    admin: { ...base, id: 'admin', sub: 'admin', name: 'Admin', perms: ['*'] },
    governor: { ...base, id: 'governor', sub: 'governor', name: 'AI Governance Officer', perms: ['agents.view', 'agents.configure', 'agents.review'] },
    reviewer: { ...base, id: 'reviewer', sub: 'reviewer', name: 'Duty Reviewer', perms: ['agents.view', 'agents.review'] },
    viewer: { ...base, id: 'viewer', sub: 'viewer', name: 'Compliance Analyst', perms: ['agents.view'] },
    nobody: { ...base, id: 'nobody', sub: 'nobody', name: 'Nobody', perms: ['reports.view'] },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer(); pool = new Pool({ connectionString: URL }); audit = app.get(AuditClient);
});
afterAll(async () => { await pool?.end(); await app?.close(); });

const policy = (over: Partial<AgentPolicy> = {}): AgentPolicy => ({
  agentId: 'a2_vessel_compliance', name: 'Vessel Compliance Agent', autonomyLevel: 'AUTONOMOUS', confidenceThreshold: 0.8,
  requiresConfirmation: false, maxActionsPerHour: 100, enabled: true, suspended: false, ...over,
});

/* ============================================================ the ladder, without a database === */

describe('ai-agents — the autonomy ladder', () => {
  it('lets an autonomous agent act on a reversible conclusion it is confident about', () => {
    expect(adjudicate(policy(), { effect: 'REVERSIBLE', confidence: 0.91 })).toMatchObject({ disposition: 'AUTO_APPLIED', reviewStatus: 'AUTO', applied: true, escalationCode: '' });
  });
  it('never lets a supervised agent apply anything, however sure it is', () => {
    const r = adjudicate(policy({ autonomyLevel: 'SUPERVISED', confidenceThreshold: 0.1 }), { effect: 'REVERSIBLE', confidence: 1 });
    expect(r).toMatchObject({ disposition: 'AWAITING_REVIEW', applied: false, escalationCode: 'OUTSIDE_AUTONOMY' });
    expect(r.escalationReason).toMatch(/supervised/i);
  });
  it('holds an assisted agent that is configured to be confirmed, and lets one that is not act', () => {
    expect(adjudicate(policy({ autonomyLevel: 'ASSISTED', requiresConfirmation: true }), { effect: 'REVERSIBLE', confidence: 0.99 }))
      .toMatchObject({ disposition: 'AWAITING_REVIEW', applied: false, escalationCode: 'CONFIRMATION_REQUIRED' });
    expect(adjudicate(policy({ autonomyLevel: 'ASSISTED', requiresConfirmation: false }), { effect: 'REVERSIBLE', confidence: 0.99 }))
      .toMatchObject({ disposition: 'AUTO_APPLIED', applied: true });
  });
  it('escalates below the agent\'s own threshold and names the numbers', () => {
    const r = adjudicate(policy({ confidenceThreshold: 0.9 }), { effect: 'ADVISORY', confidence: 0.72 });
    expect(r).toMatchObject({ disposition: 'ESCALATED', applied: false, escalationCode: 'BELOW_THRESHOLD' });
    expect(r.escalationReason).toContain('72%');
    expect(r.escalationReason).toContain('90%');
  });
  it('escalates below the platform floor even when the agent\'s own threshold would allow it', () => {
    expect(adjudicate(policy({ confidenceThreshold: 0.1 }), { effect: 'ADVISORY', confidence: 0.2 }, 0.5))
      .toMatchObject({ disposition: 'ESCALATED', escalationCode: 'BELOW_FLOOR', applied: false });
  });
  it('never applies an irreversible effect at any rung, at any confidence', () => {
    for (const autonomyLevel of ['SUPERVISED', 'ASSISTED', 'AUTONOMOUS'] as const) {
      const r = adjudicate(policy({ autonomyLevel, confidenceThreshold: 0, requiresConfirmation: false }), { effect: 'IRREVERSIBLE', confidence: 1 });
      expect(r.applied).toBe(false);
      expect(r).toMatchObject({ disposition: 'ESCALATED', escalationCode: 'IRREVERSIBLE_EFFECT' });
    }
  });
  it('escalates everything a suspended or disabled agent concludes', () => {
    expect(adjudicate(policy({ suspended: true, suspendedReason: 'accuracy review' }), { effect: 'ADVISORY', confidence: 1 }))
      .toMatchObject({ disposition: 'ESCALATED', escalationCode: 'AGENT_SUSPENDED', applied: false });
    expect(adjudicate(policy({ enabled: false }), { effect: 'ADVISORY', confidence: 1 }))
      .toMatchObject({ disposition: 'ESCALATED', escalationCode: 'AGENT_DISABLED', applied: false });
  });
  it('stops an autonomous agent at its hourly ceiling', () => {
    expect(adjudicate(policy({ maxActionsPerHour: 3 }), { effect: 'REVERSIBLE', confidence: 1, actionsLastHour: 2 })).toMatchObject({ applied: true });
    expect(adjudicate(policy({ maxActionsPerHour: 3 }), { effect: 'REVERSIBLE', confidence: 1, actionsLastHour: 3 }))
      .toMatchObject({ disposition: 'ESCALATED', escalationCode: 'RATE_LIMIT', applied: false });
  });
  it('knows which way a level change moves', () => {
    expect(raisesAutonomy('SUPERVISED', 'AUTONOMOUS')).toBe(true);
    expect(raisesAutonomy('AUTONOMOUS', 'ASSISTED')).toBe(false);
    expect(raisesAutonomy('ASSISTED', 'ASSISTED')).toBe(false);
  });
  it('classifies what acting on a conclusion would actually do', () => {
    const j = (output: Record<string, unknown>) => ({ action: '', subjectType: '', subjectId: '', subjectLabel: '', inputs: {}, output, explanation: '', factors: [], confidence: 1 });
    expect(effectOf('a3_service_processing', j({ eligible: true }))).toBe('IRREVERSIBLE');
    expect(effectOf('a3_service_processing', j({ eligible: false }))).toBe('ADVISORY');
    expect(effectOf('a5_smart_inspection', j({ board: true }))).toBe('REVERSIBLE');
    expect(effectOf('a7_maritime_intelligence', j({ level: 'ELEVATED' }))).toBe('REVERSIBLE');
    expect(effectOf('a7_maritime_intelligence', j({ level: 'NORMAL' }))).toBe('ADVISORY');
  });
});

/* ================================================================== the register of agents === */

describe('ai-agents — the agent register', () => {
  it('lists the roster with its latitude, counts and agreement rate', async () => {
    const r = await g('/agents');
    expect(r.status).toBe(200);
    expect(r.body.data.length).toBe(16);
    expect(r.body.meta).toMatchObject({ total: 16, mandated: 7 });
    const a2 = r.body.data.find((a: any) => a.agentId === 'a2_vessel_compliance');
    expect(a2).toMatchObject({ mandated: true, autonomyLevel: 'ASSISTED', enabled: true, suspended: false });
    expect(a2.description.length).toBeGreaterThan(40);
    expect(a2.descriptionAr.length).toBeGreaterThan(20);
    expect(a2.trigger.subjects.length).toBeGreaterThan(0);
    expect(a2.stats.decisions).toBeGreaterThan(0);
  });
  it('names the seven mandated agents and the rung each one starts on', async () => {
    const r = await g('/agents?mandated=true');
    expect(r.body.data.map((a: any) => a.agentId).sort()).toEqual([
      'a1_document_intelligence', 'a2_vessel_compliance', 'a3_service_processing', 'a4_customer_guidance',
      'a5_smart_inspection', 'a6_regulatory_intelligence', 'a7_maritime_intelligence',
    ]);
    const levels = Object.fromEntries(r.body.data.map((a: any) => [a.agentId, a.autonomyLevel]));
    expect(levels).toMatchObject({
      a1_document_intelligence: 'ASSISTED', a2_vessel_compliance: 'ASSISTED', a3_service_processing: 'SUPERVISED',
      a4_customer_guidance: 'AUTONOMOUS', a5_smart_inspection: 'ASSISTED', a6_regulatory_intelligence: 'ASSISTED',
      a7_maritime_intelligence: 'AUTONOMOUS',
    });
  });
  it('filters the roster by rung and searches it by name', async () => {
    const supervised = await g('/agents?level=SUPERVISED');
    expect(supervised.body.data.every((a: any) => a.autonomyLevel === 'SUPERVISED')).toBe(true);
    const found = await g('/agents?q=inspection');
    expect(found.body.data.some((a: any) => a.agentId === 'a5_smart_inspection')).toBe(true);
  });
  it('returns one agent with its governance history and its last decisions', async () => {
    const r = await g('/agents/a5_smart_inspection');
    expect(r.status).toBe(200);
    expect(r.body.data.agentId).toBe('a5_smart_inspection');
    expect(r.body.data.changes.length).toBeGreaterThan(0);
    expect(r.body.data.changes[0]).toHaveProperty('reason');
    expect(r.body.data.recentDecisions.length).toBeGreaterThan(0);
    expect(r.body.data.runnable).toBe(true);
    expect((await g('/agents/does-not-exist')).status).toBe(404);
  });
});

/* ================================================================ configuring the latitude === */

describe('ai-agents — changing what an agent may do', () => {
  it('refuses to raise autonomy without a written reason, and records it when one is given', async () => {
    await clearOutbox();
    const refused = await put('/agents/a3_service_processing', { autonomyLevel: 'ASSISTED' }, governor);
    expect(refused.status).toBe(400);
    expect(refused.body.message).toMatch(/written reason/i);

    const ok = await put('/agents/a3_service_processing', { autonomyLevel: 'ASSISTED', reason: 'Agreement sustained above target for two quarters' }, governor);
    expect(ok.status).toBe(200);
    expect(ok.body.data.autonomyLevel).toBe('ASSISTED');
    const change = ok.body.data.changes.find((c: any) => c.field === 'autonomyLevel' && c.to === 'ASSISTED');
    expect(change).toMatchObject({ from: 'SUPERVISED', by: 'AI Governance Officer', reason: 'Agreement sustained above target for two quarters' });

    const configured = await outbox(EVENTS.ai.agentConfigured);
    expect(configured.at(-1)!.data).toMatchObject({ agentId: 'a3_service_processing', autonomyLevel: 'ASSISTED' });
    expect((await outbox(EVENTS.audit.recorded)).some((e) => e.data.action === 'AGENT_CONFIGURED')).toBe(true);
    expect((await outbox(EVENTS.readModel.upserted)).some((e) => e.data.kind === 'agent' && e.data.entity.agentId === 'a3_service_processing')).toBe(true);

    // narrowing it again never needs an argument
    const narrowed = await put('/agents/a3_service_processing', { autonomyLevel: 'SUPERVISED' }, governor);
    expect(narrowed.status).toBe(200);
    expect(narrowed.body.data.autonomyLevel).toBe('SUPERVISED');
  });
  it('refuses a threshold below the platform floor, and refuses a no-op', async () => {
    const low = await put('/agents/a6_regulatory_intelligence', { confidenceThreshold: 0.1 }, governor);
    expect(low.status).toBe(400);
    expect(low.body.message).toMatch(/floor/i);
    const nothing = await put('/agents/a6_regulatory_intelligence', {}, governor);
    expect(nothing.status).toBe(400);
    expect(nothing.body.message).toMatch(/nothing to change/i);
  });
  it('treats dropping the confirmation requirement as a widening that must be justified', async () => {
    const refused = await put('/agents/a6_regulatory_intelligence', { requiresConfirmation: false }, governor);
    expect(refused.status).toBe(400);
    const ok = await put('/agents/a6_regulatory_intelligence', { requiresConfirmation: false, reason: 'Advisory output only; no statutory consequence' }, governor);
    expect(ok.status).toBe(200);
    expect(ok.body.data.requiresConfirmation).toBe(false);
    await put('/agents/a6_regulatory_intelligence', { requiresConfirmation: true }, governor);
  });
  it('suspends an agent with a reason, refuses without one, and refuses to suspend it twice', async () => {
    await clearOutbox();
    expect((await post('/agents/sentinel/suspend', { suspended: true, reason: '' }, governor)).status).toBe(400);
    const s = await post('/agents/sentinel/suspend', { suspended: true, reason: 'Waiting-time baseline under review' }, governor);
    expect(s.status).toBe(201);
    expect(s.body.data).toMatchObject({ suspended: true, suspendedReason: 'Waiting-time baseline under review', suspendedBy: 'AI Governance Officer' });
    expect((await post('/agents/sentinel/suspend', { suspended: true, reason: 'again' }, governor)).status).toBe(409);
    expect((await outbox(EVENTS.ai.agentSuspended)).at(-1)!.data).toMatchObject({ agentId: 'sentinel', suspended: true });
    expect((await outbox(EVENTS.audit.recorded)).some((e) => e.data.action === 'AGENT_SUSPENDED')).toBe(true);
    const back = await post('/agents/sentinel/suspend', { suspended: false, reason: '' }, governor);
    expect(back.body.data).toMatchObject({ suspended: false, suspendedReason: '' });
  });
});

/* ============================================================ running agents over records === */

describe('ai-agents — running an agent, and what the ladder lets it do', () => {
  it('records every conclusion a supervised agent reaches and applies none of them', async () => {
    const r = await post('/agents/a3_service_processing/run', { limit: 4 }, reviewer);
    expect(r.status).toBe(201);
    expect(r.body.data.recorded).toBeGreaterThan(0);
    expect(r.body.data.applied).toBe(0);
    expect(r.body.data.decisions.every((d: any) => !d.applied)).toBe(true);
    // supervision holds it; a conclusion below the platform floor never even reaches the rung it is held at
    expect(r.body.data.decisions.every((d: any) => ['OUTSIDE_AUTONOMY', 'BELOW_FLOOR'].includes(d.escalationCode))).toBe(true);
    expect(r.body.data.decisions.some((d: any) => d.disposition === 'AWAITING_REVIEW' && d.escalationCode === 'OUTSIDE_AUTONOMY')).toBe(true);
    expect(r.body.data.decisions[0].factors.length).toBeGreaterThan(0);
  });
  it('lets an autonomous agent apply its own advisory conclusions', async () => {
    const r = await post('/agents/a4_customer_guidance/run', { limit: 3 }, reviewer);
    expect(r.body.data.decisions.some((d: any) => d.disposition === 'AUTO_APPLIED' && d.applied)).toBe(true);
  });
  it('refuses to apply an irreversible conclusion even from an agent raised to full autonomy', async () => {
    // an application that passes every gate, lodged twice by the same applicant so no gate can fail
    const payload = (id: string) => ({
      id, requestNo: `REQ-TEST-${id.slice(-3)}`, serviceId: 'svc-not-in-catalogue', serviceCode: 'TST-01', serviceName: 'Test service',
      applicant: { name: 'Zafarana Marine Services (sample)' }, subjectKind: 'VESSEL', subjectId: 'vessel-under-test', subjectLabel: 'MV Test',
      // lodged long ago so it never displaces the live batch another agent's run would pick up
      status: 'SUBMITTED', currentStage: 'assessment', documents: [], fee: { amount: 0, paid: true }, submittedAt: '2024-02-01T00:00:00.000Z', createdAt: '2024-02-01T00:00:00.000Z',
    });
    const c = await pool.connect();
    try {
      const { upsertServiceRequest } = await import('../src/subjects');
      await upsertServiceRequest(c, payload('req-zero-touch-001'));
      await upsertServiceRequest(c, payload('req-zero-touch-002'));
    } finally { c.release(); }

    await put('/agents/a3_service_processing', { autonomyLevel: 'AUTONOMOUS', requiresConfirmation: false, reason: 'Deliberate test of the irreversible guard' }, governor);
    const r = await post('/agents/a3_service_processing/run', { subjectId: 'req-zero-touch-001' }, reviewer);
    expect(r.body.data.recorded).toBe(1);
    const d = r.body.data.decisions[0];
    expect(d.output.eligible).toBe(true);
    expect(d.confidence).toBe(1);
    expect(d.effect).toBe('IRREVERSIBLE');
    expect(d).toMatchObject({ disposition: 'ESCALATED', escalationCode: 'IRREVERSIBLE_EFFECT', applied: false });
    await put('/agents/a3_service_processing', { autonomyLevel: 'SUPERVISED', requiresConfirmation: true }, governor);
  });
  it('escalates everything a suspended agent concludes, and applies again once it is reinstated', async () => {
    await post('/agents/a4_customer_guidance/suspend', { suspended: true, reason: 'Wording under review' }, governor);
    const held = await post('/agents/a4_customer_guidance/run', { limit: 2 }, reviewer);
    expect(held.body.data.applied).toBe(0);
    expect(held.body.data.decisions.every((d: any) => d.escalationCode === 'AGENT_SUSPENDED')).toBe(true);
    await post('/agents/a4_customer_guidance/suspend', { suspended: false, reason: '' }, governor);
    const back = await post('/agents/a4_customer_guidance/run', { limit: 2 }, reviewer);
    expect(back.body.data.applied).toBeGreaterThan(0);
  });
  it('stops an agent at its hourly ceiling once it has used it up', async () => {
    await pool.query(`DELETE FROM agent_actions WHERE agent_id = 'a4_customer_guidance'`);
    await put('/agents/a4_customer_guidance', { maxActionsPerHour: 1 }, governor);
    const r = await post('/agents/a4_customer_guidance/run', { limit: 3 }, reviewer);
    expect(r.body.data.applied).toBe(1);
    expect(r.body.data.decisions.filter((d: any) => d.escalationCode === 'RATE_LIMIT').length).toBeGreaterThan(0);
    await put('/agents/a4_customer_guidance', { maxActionsPerHour: 100 }, governor);
  });
  it('refuses to run an agent that has no runner here', async () => {
    const r = await post('/agents/collector/run', {}, reviewer);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/own schedule/i);
    expect((await post('/agents/not-an-agent/run', {}, reviewer)).status).toBe(404);
  });
  it('publishes the decision, the read model and the escalation, and writes an audit entry', async () => {
    await clearOutbox();
    const r = await post('/agents/a3_service_processing/run', { limit: 1 }, reviewer);
    const id = r.body.data.decisions[0].id;
    const recorded = await outbox(EVENTS.ai.decisionRecorded);
    expect(recorded.some((e) => e.data.decisionId === id)).toBe(true);
    const rm = (await outbox(EVENTS.readModel.upserted)).filter((e) => e.data.kind === 'agentDecision');
    const entity = rm.find((e) => e.data.entity.id === id)!.data.entity;
    expect(Object.keys(entity)).toEqual(expect.arrayContaining(['id', 'agentId', 'disposition', 'confidence', 'reviewStatus', 'at', 'entityType', 'entityId']));
    expect((await outbox(EVENTS.ai.decisionEscalated)).some((e) => e.data.decisionId === id)).toBe(true);
    expect((await outbox(EVENTS.audit.recorded)).some((e) => e.data.entity === 'AiDecision')).toBe(true);
    expect((await outbox(EVENTS.ai.agentRan)).at(-1)!.data).toMatchObject({ agentId: 'a3_service_processing', recorded: r.body.data.recorded, onDemand: true });
    expect((await outbox(EVENTS.audit.recorded)).some((e) => e.data.action === 'AGENT_RUN')).toBe(true);
  });
});

/* ========================================================== the register and the queue === */

describe('ai-agents — the decision register', () => {
  it('pages, filters and searches the register', async () => {
    const first = await g('/agents/decisions?limit=5');
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(5);
    expect(first.body.meta.total).toBeGreaterThan(300);
    const p2 = await g('/agents/decisions?limit=5&page=2');
    expect(p2.body.data[0].id).not.toBe(first.body.data[0].id);
    const mine = await g('/agents/decisions?agentId=a5_smart_inspection&limit=200');
    expect(mine.body.data.every((d: any) => d.agentId === 'a5_smart_inspection')).toBe(true);
    const escalated = await g('/agents/decisions?disposition=ESCALATED&limit=200');
    expect(escalated.body.data.every((d: any) => d.disposition === 'ESCALATED')).toBe(true);
    const reviewed = await g('/agents/decisions?reviewStatus=REVIEWED&limit=200');
    expect(reviewed.body.data.every((d: any) => d.reviewStatus === 'REVIEWED')).toBe(true);
    const vessels = await g('/agents/decisions?entityType=Vessel&limit=200');
    expect(vessels.body.data.every((d: any) => d.entityType === 'Vessel' && d.subjectType === 'Vessel')).toBe(true);
    const confident = await g('/agents/decisions?minConfidence=0.95&limit=200');
    expect(confident.body.data.every((d: any) => d.confidence >= 0.95)).toBe(true);
    const sorted = await g('/agents/decisions?sort=confidence&limit=5');
    const cs = sorted.body.data.map((d: any) => d.confidence);
    expect(cs).toEqual([...cs].sort((a: number, b: number) => a - b));
  });
  it('shows the agents\' own conclusions by default and the reviewers\' verdicts on request', async () => {
    const own = await g('/agents/decisions?limit=1');
    const all = await g('/agents/decisions?limit=1&includeSuperseding=true');
    expect(all.body.meta.total).toBeGreaterThanOrEqual(own.body.meta.total);
  });
  it('returns one decision with the weighted factors that drove it', async () => {
    const list = await g('/agents/decisions?agentId=a2_vessel_compliance&limit=1');
    const one = await g(`/agents/decisions/${list.body.data[0].id}`);
    expect(one.status).toBe(200);
    expect(one.body.data.factors.length).toBeGreaterThan(3);
    expect(one.body.data.factors[0]).toHaveProperty('weight');
    expect(one.body.data.factors[0]).toHaveProperty('contribution');
    expect(one.body.data.factorTotal).toBeGreaterThan(0);
    expect(one.body.data.explanation.length).toBeGreaterThan(10);
    expect((await g('/agents/decisions/00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });
  it('is the escalation queue: only what is waiting, oldest first, grouped by why', async () => {
    const q = await g('/agents/decisions/escalations?limit=200');
    expect(q.status).toBe(200);
    expect(q.body.data.length).toBeGreaterThan(0);
    expect(q.body.data.every((d: any) => ['ESCALATED', 'AWAITING_REVIEW'].includes(d.disposition) && d.reviewStatus === 'PENDING')).toBe(true);
    const times = q.body.data.map((d: any) => d.at);
    expect(times).toEqual([...times].sort());
    expect(q.body.meta.byCode.length).toBeGreaterThan(0);
    expect(q.body.meta.byAgent.length).toBeGreaterThan(0);
    const filtered = await g('/agents/decisions/escalations?escalationCode=BELOW_THRESHOLD&limit=50');
    expect(filtered.body.data.every((d: any) => d.escalationCode === 'BELOW_THRESHOLD')).toBe(true);
  });
  it('lists the dispositions the console filters by', async () => {
    const r = await g('/agents/decisions/meta');
    expect(r.body.data.dispositions).toContain('AUTO_APPLIED');
    expect(r.body.data.pending).toEqual(['AWAITING_REVIEW', 'ESCALATED']);
  });
});

describe('ai-agents — review and override', () => {
  const pending = async () => (await g('/agents/decisions/escalations?limit=1')).body.data[0];

  it('accepts a decision without rewriting it, and records the verdict as a superseding row', async () => {
    await clearOutbox();
    const target = await pending();
    const r = await post(`/agents/decisions/${target.id}/review`, { accept: true }, reviewer);
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ disposition: 'APPROVED_BY_HUMAN', reviewStatus: 'REVIEWED', supersedesId: target.id, reviewedBy: 'Duty Reviewer' });

    const original = await g(`/agents/decisions/${target.id}`);
    expect(original.body.data.disposition).toBe(target.disposition);   // the agent's own words are untouched
    expect(original.body.data.reviewStatus).toBe('REVIEWED');
    expect(original.body.data.superseded).toBe(true);
    expect(original.body.data.review.id).toBe(r.body.data.id);
    expect(original.body.data.openForReview).toBe(false);

    expect((await outbox(EVENTS.ai.decisionReviewed)).some((e) => e.data.supersedesId === target.id)).toBe(true);
    expect((await outbox(EVENTS.audit.recorded)).some((e) => e.data.action === 'AI_DECISION_ACCEPTED')).toBe(true);
    const rm = (await outbox(EVENTS.readModel.upserted)).filter((e) => e.data.kind === 'agentDecision');
    expect(rm.some((e) => e.data.entity.id === target.id && e.data.entity.reviewStatus === 'REVIEWED')).toBe(true);
  });
  it('refuses to overturn a decision without a reason, and records the reason when given', async () => {
    const target = await pending();
    expect((await post(`/agents/decisions/${target.id}/review`, { accept: false, reason: '' }, reviewer)).status).toBe(400);
    const r = await post(`/agents/decisions/${target.id}/review`, { accept: false, reason: 'Local works already accounted for the variance' }, reviewer);
    expect(r.body.data).toMatchObject({ disposition: 'OVERRIDDEN', reviewStatus: 'OVERRIDDEN', overrideReason: 'Local works already accounted for the variance' });
    expect((await outbox(EVENTS.ai.decisionOverridden)).some((e) => e.data.supersedesId === target.id)).toBe(true);
    const agent = await g(`/agents/${target.agentId}`);
    expect(agent.body.data.stats.overridden).toBeGreaterThan(0);
  });
  it('refuses a second review, and refuses to review a verdict row', async () => {
    const target = await pending();
    const first = await post(`/agents/decisions/${target.id}/review`, { accept: true }, reviewer);
    expect(first.status).toBe(201);
    expect((await post(`/agents/decisions/${target.id}/review`, { accept: true }, reviewer)).status).toBe(409);
    const verdict = await post(`/agents/decisions/${first.body.data.id}/review`, { accept: true }, reviewer);
    expect(verdict.status).toBe(409);
    expect(verdict.body.message).toMatch(/review outcome/i);
  });
});

/* ================================================================= drift, bias and SLAs === */

describe('ai-agents — drift and bias, tested without a request', () => {
  const at = (daysAgo: number) => new Date(Date.now() - daysAgo * D).toISOString();
  const dec = (over: Partial<MetricDecision>): MetricDecision => ({
    agentId: 'a', disposition: 'AUTO_APPLIED', reviewStatus: 'AUTO', confidence: 0.9, at: at(1), cohort: {}, output: {}, ...over,
  });
  const agents: MetricAgent[] = [{ agentId: 'a', name: 'Agent A', autonomyLevel: 'ASSISTED', enabled: true, suspended: false }];

  it('calls an agent drifting when reviewers stop agreeing with it, not when it is merely busy', () => {
    const early = Array.from({ length: 10 }, () => dec({ at: at(25), reviewStatus: 'REVIEWED', disposition: 'APPROVED_BY_HUMAN' }));
    const late = Array.from({ length: 8 }, (_, i) => dec({ at: at(2), reviewStatus: i < 6 ? 'OVERRIDDEN' : 'REVIEWED', disposition: i < 6 ? 'OVERRIDDEN' : 'APPROVED_BY_HUMAN' }));
    const r = drift([...early, ...late], agents, new Date(), { windowDays: 28, bucketDays: 7 });
    expect(r.perAgent[0].baselineAgreement).toBe(100);
    expect(r.perAgent[0].latestAgreement).toBe(25);
    expect(r.perAgent[0].drifting).toBe(true);
    expect(r.drifting).toEqual(['a']);
    const steady = drift(early.concat(Array.from({ length: 8 }, () => dec({ at: at(2), reviewStatus: 'REVIEWED', disposition: 'APPROVED_BY_HUMAN' }))), agents, new Date(), { windowDays: 28, bucketDays: 7 });
    expect(steady.perAgent[0].drifting).toBe(false);
  });
  it('bins confidence so a reviewer can see where an agent is sure and where it is not', () => {
    const bands = confidenceDistribution([dec({ confidence: 0.05 }), dec({ confidence: 0.55 }), dec({ confidence: 1 })]);
    expect(bands).toHaveLength(10);
    expect(bands[0]).toMatchObject({ decisions: 1, share: 33.3 });
    expect(bands[9].decisions).toBe(1);
  });
  it('flags a cohort whose outcomes depart from the population, and stays silent on a small one', () => {
    const population = [
      ...Array.from({ length: 20 }, () => dec({ cohort: { flag: 'AE' }, disposition: 'AUTO_APPLIED' })),
      ...Array.from({ length: 20 }, () => dec({ cohort: { flag: 'PA' }, disposition: 'ESCALATED', reviewStatus: 'PENDING' })),
      ...Array.from({ length: 2 }, () => dec({ cohort: { flag: 'LR' }, disposition: 'ESCALATED', reviewStatus: 'PENDING' })),
    ];
    const r = bias(population, ['flag'], { minCohort: 5, flagDeltaPct: 20 });
    const flag = r.dimensions[0];
    expect(flag.dimension).toBe('flag');
    const pa = flag.cohorts.find((c) => c.value === 'PA')!;
    const ae = flag.cohorts.find((c) => c.value === 'AE')!;
    const lr = flag.cohorts.find((c) => c.value === 'LR')!;
    expect(pa).toMatchObject({ escalationRate: 100, flagged: true, sufficient: true });
    expect(ae).toMatchObject({ escalationRate: 0, flagged: true });
    expect(lr).toMatchObject({ decisions: 2, sufficient: false, flagged: false });
    expect(r.flagged).toBe(2);
  });
  it('measures the false-positive rate on high-risk calls a human actually looked at', () => {
    const decisions = [
      dec({ output: { band: 'HIGH' }, reviewStatus: 'OVERRIDDEN', disposition: 'OVERRIDDEN' }),
      dec({ output: { board: true }, reviewStatus: 'REVIEWED', disposition: 'APPROVED_BY_HUMAN' }),
      dec({ output: { board: true }, reviewStatus: 'REVIEWED', disposition: 'APPROVED_BY_HUMAN' }),
      dec({ output: { board: true }, reviewStatus: 'REVIEWED', disposition: 'APPROVED_BY_HUMAN' }),
      dec({ output: { band: 'LOW' }, reviewStatus: 'OVERRIDDEN', disposition: 'OVERRIDDEN' }),
      dec({ output: { band: 'HIGH' }, reviewStatus: 'PENDING', disposition: 'ESCALATED' }),
    ];
    const r = serviceLevels(decisions, new Date(), { windowDays: 30, agreementTarget: 85, falsePositiveCeiling: 15 });
    expect(r.highRiskCalls).toBe(5);
    expect(r.highRiskReviewed).toBe(4);       // the pending one is excluded, not assumed correct
    const fp = r.metrics.find((m) => m.key === 'falsePositiveHighRisk')!;
    expect(fp.value).toBe(25);
    expect(fp.meets).toBe(false);
    const agreement = r.metrics.find((m) => m.key === 'agreement')!;
    expect(agreement.value).toBe(60);
  });
  it('summarises the console header from the agents and their decisions', () => {
    const r = performance(agents, [dec({}), dec({ disposition: 'ESCALATED', reviewStatus: 'PENDING' })], new Date(), 30);
    expect(r).toMatchObject({ agents: 1, active: 1, suspended: 0, decisions: 2, decisions30d: 2, autoAppliedPct: 50, pendingReview: 1 });
    expect(r.byLevel).toEqual([{ level: 'SUPERVISED', count: 0 }, { level: 'ASSISTED', count: 1 }, { level: 'AUTONOMOUS', count: 0 }]);
    expect(r.perAgent[0]).toMatchObject({ agentId: 'a', decisions: 2, escalated: 1 });
  });
});

describe('ai-agents — the monitoring endpoints', () => {
  it('reports the console dashboard', async () => {
    const r = await g('/agents/dashboard');
    expect(r.status).toBe(200);
    expect(r.body.data.agents).toBe(16);
    expect(r.body.data.decisions).toBeGreaterThan(300);
    expect(r.body.data.byLevel.reduce((s: number, b: any) => s + b.count, 0)).toBe(16);
    expect(r.body.data.perAgent).toHaveLength(16);
    expect(r.body.data.avgConfidence).toBeGreaterThan(0);
  });
  it('reports rolling accuracy and confidence per agent', async () => {
    const r = await g('/agents/monitoring/drift?windowDays=120&bucketDays=30');
    expect(r.status).toBe(200);
    expect(r.body.data.perAgent).toHaveLength(16);
    const a2 = r.body.data.perAgent.find((a: any) => a.agentId === 'a2_vessel_compliance');
    expect(a2.buckets).toHaveLength(4);
    expect(a2.confidence).toHaveLength(10);
    expect(a2.avgConfidence).toBeGreaterThan(0);
    const one = await g('/agents/monitoring/drift?agentId=a5_smart_inspection');
    expect(one.body.data.perAgent).toHaveLength(1);
  });
  it('audits outcomes across the dimensions the records carry', async () => {
    const r = await g('/agents/monitoring/bias');
    expect(r.status).toBe(200);
    const flag = r.body.data.dimensions.find((d: any) => d.dimension === 'flag');
    expect(flag.decisions).toBeGreaterThan(0);
    expect(flag.cohorts.length).toBeGreaterThan(1);
    expect(flag.cohorts[0]).toHaveProperty('escalationDelta');
    expect(flag.cohorts.every((c: any) => c.sufficient || !c.flagged)).toBe(true);
    expect(r.body.data.dimensions.map((d: any) => d.dimension)).toContain('vesselType');
    const narrow = await g('/agents/monitoring/bias?dimensions=flag');
    expect(narrow.body.data.dimensions).toHaveLength(1);
  });
  it('reports the service levels including the high-risk false-positive rate', async () => {
    const r = await g('/agents/monitoring/metrics?windowDays=400');
    expect(r.status).toBe(200);
    const keys = r.body.data.metrics.map((m: any) => m.key);
    expect(keys).toEqual(expect.arrayContaining(['agreement', 'falsePositiveHighRisk', 'escalation', 'autoApplied', 'reviewCoverage', 'avgConfidence']));
    const fp = r.body.data.metrics.find((m: any) => m.key === 'falsePositiveHighRisk');
    expect(fp.target).toBe(15);
    expect(r.body.data.highRiskCalls).toBeGreaterThan(0);
    // the queue has been partly worked, so the rate is a number against its ceiling rather than an unknown
    expect(r.body.data.highRiskReviewed).toBeGreaterThan(0);
    expect(typeof fp.value).toBe('number');
    expect(typeof fp.meets).toBe('boolean');
    const coverage = r.body.data.metrics.find((m: any) => m.key === 'reviewCoverage');
    expect(coverage.value).toBeGreaterThan(0);
  });
  it('starts from a queue a reviewer has partly worked, with the verdicts kept as their own rows', async () => {
    const verdicts = await g('/agents/decisions?includeSuperseding=true&reviewStatus=OVERRIDDEN&limit=200');
    expect(verdicts.body.data.length).toBeGreaterThan(0);
    const overturned = verdicts.body.data.find((d: any) => d.supersedesId);
    expect(overturned.overrideReason.length).toBeGreaterThan(10);
    expect(overturned.reviewedBy.length).toBeGreaterThan(0);
    const original = await g(`/agents/decisions/${overturned.supersedesId}`);
    expect(original.body.data.superseded).toBe(true);
    expect(original.body.data.reviewStatus).toBe('OVERRIDDEN');
    expect(original.body.data.openForReview).toBe(false);
  });
});

/* ============================================================================ consuming === */

describe('ai-agents — what the platform tells it', () => {
  it('projects the records the agents reason over, and ignores a kind it does not own', async () => {
    const c = await pool.connect();
    try {
      const vessel = makeEvent({ type: EVENTS.readModel.upserted, source: 'ships', data: { kind: 'vessel', entity: { id: 'vessel-projected', imo: '9111111', name: 'MV Projected', type: 'BULK', flag: 'AE', built: 2011, status: 'ACTIVE', real: false } } });
      await applyEvent(c, { env, audit }, vessel);
      expect((await c.query('SELECT name, flag FROM vessels WHERE id = $1', ['vessel-projected'])).rows[0]).toMatchObject({ name: 'MV Projected', flag: 'AE' });
      const invoice = makeEvent({ type: EVENTS.readModel.upserted, source: 'revenue', data: { kind: 'invoice', entity: { id: 'inv-projected', number: 'INV-1', total: 4500, status: 'ISSUED' } } });
      await applyEvent(c, { env, audit }, invoice);
      expect((await c.query('SELECT number FROM invoices WHERE id = $1', ['inv-projected'])).rows[0].number).toBe('INV-1');
      const unknown = makeEvent({ type: EVENTS.readModel.upserted, source: 'somewhere', data: { kind: 'berth', entity: { id: 'b1' } } });
      await expect(applyEvent(c, { env, audit }, unknown)).resolves.toBeUndefined();
      const gone = makeEvent({ type: EVENTS.readModel.deleted, source: 'revenue', data: { kind: 'invoice', id: 'inv-projected' } });
      await applyEvent(c, { env, audit }, gone);
      expect((await c.query('SELECT 1 FROM invoices WHERE id = $1', ['inv-projected'])).rowCount).toBe(0);
    } finally { c.release(); }
  });
  it('wakes the agent a domain event belongs to and records what it decided', async () => {
    const before = Number((await pool.query(`SELECT count(*)::int AS n FROM decisions WHERE agent_id = 'a5_smart_inspection'`)).rows[0].n);
    const vessel = (await pool.query<{ id: string }>(`SELECT id FROM vessels WHERE NOT real AND status = 'ACTIVE' ORDER BY name LIMIT 1`)).rows[0];
    const c = await pool.connect();
    try {
      const closed = makeEvent({ type: EVENTS.inspection.closed, source: 'inspection', data: { inspectionId: 'i1', vesselId: vessel.id, result: 'DEFICIENCIES' } });
      await applyEvent(c, { env, audit }, closed);
    } finally { c.release(); }
    const after = await pool.query<{ n: string }>(`SELECT count(*)::int AS n FROM decisions WHERE agent_id = 'a5_smart_inspection'`);
    expect(Number(after.rows[0].n)).toBe(before + 1);
    const latest = (await pool.query(`SELECT entity_id, agent_id FROM decisions WHERE agent_id = 'a5_smart_inspection' ORDER BY created_at DESC LIMIT 1`)).rows[0];
    expect(latest.entity_id).toBe(vessel.id);
  });
  it('never lets its own decisions wake an agent again', async () => {
    const before = Number((await pool.query('SELECT count(*)::int AS n FROM decisions')).rows[0].n);
    const c = await pool.connect();
    try {
      const own = makeEvent({ type: EVENTS.ai.decisionRecorded, source: env.SERVICE_NAME, data: { decisionId: 'x', agentId: 'a5_smart_inspection' } });
      await applyEvent(c, { env, audit }, own);
    } finally { c.release(); }
    expect(Number((await pool.query('SELECT count(*)::int AS n FROM decisions')).rows[0].n)).toBe(before);
  });
  it('consumes each event once', async () => {
    const event = makeEvent({ type: EVENTS.readModel.upserted, source: 'ships', data: { kind: 'vessel', entity: { id: 'vessel-once', imo: '9222222', name: 'MV Once', status: 'ACTIVE' } } });
    expect(await withInbox(pool, event, async (c) => { await applyEvent(c, { env, audit }, event); })).toBe(true);
    expect(await withInbox(pool, event, async (c) => { await applyEvent(c, { env, audit }, event); })).toBe(false);
  });
});

/* =========================================================================== permissions === */

describe('ai-agents — permissions', () => {
  it('refuses an unauthenticated request', async () => {
    expect((await request(server as never).get('/agents')).status).toBe(401);
    expect((await request(server as never).get('/agents/decisions')).status).toBe(401);
    expect((await request(server as never).post('/agents/a5_smart_inspection/run').send({})).status).toBe(401);
  });
  it('refuses a principal without the permission the route needs', async () => {
    expect((await g('/agents', nobody)).status).toBe(403);
    expect((await g('/agents/decisions', nobody)).status).toBe(403);
    expect((await g('/agents/monitoring/bias', nobody)).status).toBe(403);
    expect((await put('/agents/a5_smart_inspection', { enabled: false }, viewer)).status).toBe(403);
    expect((await post('/agents/a5_smart_inspection/suspend', { suspended: true, reason: 'x' }, reviewer)).status).toBe(403);
    expect((await post('/agents/a5_smart_inspection/run', {}, viewer)).status).toBe(403);
    const target = (await g('/agents/decisions/escalations?limit=1')).body.data[0];
    expect((await post(`/agents/decisions/${target.id}/review`, { accept: true }, viewer)).status).toBe(403);
  });
  it('lets a viewer read the register but never change it', async () => {
    expect((await g('/agents', viewer)).status).toBe(200);
    expect((await g('/agents/decisions?limit=1', viewer)).status).toBe(200);
    expect((await g('/agents/monitoring/metrics', viewer)).status).toBe(200);
  });
  it('answers health without a session', async () => {
    const r = await request(server as never).get('/health');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'ok', service: 'ai-agents' });
  });
});
