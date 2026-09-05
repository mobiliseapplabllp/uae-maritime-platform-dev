import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createApp, loadEnv, signHS256, StaticPrincipalResolver, PRINCIPAL_RESOLVER, KIT_BUS, MemoryBus, withTx, withInbox, applyLookupEvent, ApiError } from '@maritime/service-kit';
import { EVENTS, makeEvent, subjectFor } from '@maritime/contracts';
import { buildWorld } from '@maritime/world';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedWorkflow } from '../src/seed';
import { WorkflowEngine, type EngineActor, type RequestState } from '../src/engine';
import { InlineRulesClient, MapRuleSetSource, type CachedRuleSet } from '../src/rules/client';
import { normaliseDefinition } from '../src/rules/engine';
import { defaultWorkflow } from '../src/defaults';
import { parseContent, validateContent, diffContent } from '../src/schema';
import { cacheRuleSet, linkInstrument, sweepSla } from '../src/consumers';
import { validateFormData } from '../src/requests.controller';

const NOW = new Date('2026-09-02T09:00:00Z'); const D = 86_400_000;
const SETS: Record<string, CachedRuleSet> = {
  'fee.test': { key: 'fee.test', kind: 'FEE', version: 3, definition: normaliseDefinition('FEE', [{ code: 'APP', description: 'Application fee', amount: 100 }, { code: 'ISS', description: 'Issue fee', qty: { var: 'form.units' }, rate: 50 }, { code: 'EXP', description: 'Expedite', amount: 30, taxable: false, when: { var: 'form.expedited' } }]), parameters: { currency: 'AED' } },
  'eligibility.test': { key: 'eligibility.test', kind: 'ELIGIBILITY', version: 1, definition: normaliseDefinition('ELIGIBILITY', [{ code: 'MIN_UNITS', message: 'At least two units are required', when: { '<': [{ var: 'form.units' }, 2] } }, { code: 'OLD', message: 'Old subject', severity: 'WARN', when: { '>': [{ var: 'subject.age' }, 25] } }]), parameters: {} },
  'sla.test': { key: 'sla.test', kind: 'SLA', version: 1, definition: normaliseDefinition('SLA', { if: [{ var: 'request.expedited' }, 2, { var: 'definition.slaDays' }] }), parameters: {} },
};
const applicant: EngineActor = { id: 'agent-1', name: 'Agent One', perms: ['services.view', 'services.apply'] };
const assessor: EngineActor = { id: 'assessor-1', name: 'Assessor', perms: ['services.view', 'services.assess'] };
const approver: EngineActor = { id: 'approver-1', name: 'Approver', perms: ['services.view', 'services.assess', 'services.approve'] };
const nobody: EngineActor = { id: 'nobody', name: 'Nobody', perms: ['dashboard.view'] };
const content = () => parseContent({
  form: { fields: [{ key: 'units', label: 'Units', type: 'number', required: true }, { key: 'expedited', label: 'Expedited', type: 'boolean' }] },
  documents: [{ code: 'doc1', label: 'Certificate', required: true }, { code: 'doc2', label: 'Optional cover', required: false }, { code: 'doc3', label: 'Only when expedited', required: true, whenExpr: { var: 'form.expedited' } }],
  fees: { ruleSetKey: 'fee.test' }, sla: { days: 10, ruleSetKey: 'sla.test' },
  workflow: defaultWorkflow({ issuesInstrument: 'NAVIGATION_LICENCE', eligibilityRuleSetKey: 'eligibility.test', stageDays: { screening: 2, technical: 5, approval: 3 } }), outputs: { instrumentType: 'NAVIGATION_LICENCE', validityMonths: 24 },
});
const fresh = (form: Record<string, unknown> = { units: 3 }): RequestState => ({
  id: '11111111-1111-4111-a111-111111111111', number: 'SR-2026-90001', definitionId: 'd1', definitionKey: 'test.permit', definitionName: 'Test permit', definitionNameAr: 'تصريح اختبار', definitionVersion: 1, environment: 'PROD', category: 'Licensing', domain: 1,
  subjectKind: 'VESSEL', subjectId: 'v1', subjectName: 'Test Vessel', subject: { age: 30 }, applicant: { userId: 'agent-1', name: 'Agent One', email: 'agent@x', phone: '', organisation: 'Gulf Star' }, status: 'DRAFT', currentState: 'DRAFT', formData: form,
  documents: [{ code: 'doc1', documentId: null, name: 'doc1.pdf', uploadedAt: NOW.toISOString(), verified: false, verifiedBy: null, verifiedAt: null, notes: '' }], fees: null, payment: null, assignee: null, checks: [], slaDueAt: null, slaBreached: false, slaBreachedAt: null, submittedAt: null, decidedAt: null, closedAt: null, issuedInstrument: null, timeline: [], createdBy: 'agent-1', createdAt: NOW.toISOString(), updatedAt: NOW.toISOString(),
});
const engine = new WorkflowEngine(new InlineRulesClient(new MapRuleSetSource(SETS)), { source: 'workflow-test', jurisdiction: 'AE', now: () => NOW });
const fail = async (p: Promise<unknown>) => { try { await p; } catch (e) { return e as ApiError; } throw new Error('expected a failure'); };

describe('workflow engine', () => {
  it('walks the default lifecycle: fees and SLA at submit, auto-assignment, verified checklist and eligibility at approval, instrument at issue', async () => {
    const c = content();
    const s1 = await engine.transition(fresh(), c, 'submit', applicant, 'please expedite');
    expect(s1.request).toMatchObject({ status: 'SUBMITTED', currentState: 'SUBMITTED', submittedAt: NOW.toISOString(), slaDueAt: new Date(NOW.getTime() + 10 * D).toISOString(), assignee: null });
    expect(s1.request.fees).toMatchObject({ subtotal: 250, taxRatePct: 5, taxAmount: 12.5, total: 262.5, currency: 'AED', ruleSetKey: 'fee.test', ruleSetVersion: 3 }); expect(s1.request.fees!.lines.map((l) => l.code)).toEqual(['APP', 'ISS']);
    expect(s1.request.payment).toMatchObject({ status: 'DUE', amount: 262.5 }); expect(s1.effects).toEqual(['computeFee', 'notify']);
    const types = s1.events.map((e) => e.type);
    expect(types).toEqual([EVENTS.workflow.requestNotify, EVENTS.workflow.requestTransitioned, EVENTS.workflow.requestSubmitted, EVENTS.readModel.upserted]);
    expect(s1.events[0].data).toMatchObject({ audience: 'staff', audiencePerm: 'services.assess', template: 'request.submitted', requestNo: 'SR-2026-90001', body: 'please expedite' });
    expect((s1.events[3].data as { kind: string; entity: RequestState }).entity.status).toBe('SUBMITTED');
    expect(s1.request.timeline).toHaveLength(1); expect(s1.request.timeline[0]).toMatchObject({ from: 'DRAFT', to: 'SUBMITTED', action: 'submit', by: { id: 'agent-1' }, note: 'please expedite' });
    const s2 = await engine.transition(s1.request, c, 'start_assessment', assessor);
    expect(s2.request).toMatchObject({ status: 'UNDER_ASSESSMENT', assignee: { userId: 'assessor-1', name: 'Assessor' } });
    expect(s2.events.find((e) => e.type === EVENTS.workflow.requestNotify)!.data).toMatchObject({ audience: 'applicant', userId: 'agent-1' });
    const blocked = await fail(engine.transition(s2.request, c, 'approve', approver));
    expect(blocked.getStatus()).toBe(422); expect(blocked.message).toMatch(/not yet verified: Certificate/); expect(blocked.extra).toMatchObject({ unverified: ['Certificate'], missing: [] });
    const verified = { ...s2.request, documents: s2.request.documents.map((d) => ({ ...d, verified: true, verifiedBy: 'Assessor', verifiedAt: NOW.toISOString() })) };
    expect((await fail(engine.transition(verified, c, 'approve', assessor))).getStatus()).toBe(403);
    const s3 = await engine.transition(verified, c, 'approve', approver, 'all good');
    expect(s3.request).toMatchObject({ status: 'APPROVED', currentState: 'APPROVED', decidedAt: NOW.toISOString(), closedAt: null });
    expect(s3.request.checks).toEqual([expect.objectContaining({ check: 'MIN_UNITS', passed: true, blocking: true }), expect.objectContaining({ check: 'OLD', passed: false, blocking: false })]);
    expect(s3.effects).toEqual(['requireDocuments', 'callService', 'notify']); expect(s3.entry.checks).toHaveLength(2);
    expect(s3.events.find((e) => e.type === EVENTS.workflow.requestDecided)!.data).toMatchObject({ outcome: 'APPROVED', requestNo: 'SR-2026-90001' });
    const s4 = await engine.transition(s3.request, c, 'issue', approver);
    expect(s4.request).toMatchObject({ status: 'ISSUED', currentState: 'ISSUED', closedAt: NOW.toISOString(), issuedInstrument: { type: 'NAVIGATION_LICENCE', class: 'LICENCE', status: 'REQUESTED', validityMonths: 24 } });
    const issued = s4.events.find((e) => e.type === EVENTS.workflow.requestIssued)!;
    expect(issued.data).toMatchObject({ requestId: '11111111-1111-4111-a111-111111111111', requestNo: 'SR-2026-90001', instrumentType: 'NAVIGATION_LICENCE', instrumentClass: 'LICENCE', subjectKind: 'VESSEL', subjectId: 'v1', subjectName: 'Test Vessel', applicant: { name: 'Agent One' }, formData: { units: 3 } });
    expect(issued.subject).toBe('ServiceRequest:SR-2026-90001');
    expect((await fail(engine.transition(s4.request, c, 'approve', approver))).getStatus()).toBe(409);
    expect(engine.availableActions(c, s4.request, approver)).toEqual([]);
    expect(engine.availableActions(c, s1.request, applicant).map((a) => a.action)).toEqual(['withdraw']);
    expect(engine.availableActions(c, s1.request, assessor).map((a) => a.action)).toEqual(['start_assessment', 'withdraw']);
  });
  it('enforces guards, roles, required notes, illegal actions and eligibility', async () => {
    const c = content();
    c.workflow.transitions.find((t) => t.action === 'submit')!.guard = { '>=': [{ var: 'form.units' }, 1] };
    const g = await fail(engine.transition(fresh({ units: 0 }), c, 'submit', applicant)); expect(g.getStatus()).toBe(422); expect(g.message).toMatch(/Guard of action "submit"/);
    expect((await fail(engine.transition(fresh(), c, 'submit', nobody))).getStatus()).toBe(403);
    const illegal = await fail(engine.transition(fresh(), c, 'approve', approver)); expect(illegal.getStatus()).toBe(409); expect(illegal.message).toMatch(/available: submit, withdraw/);
    const s1 = await engine.transition(fresh({ units: 1 }), c, 'submit', applicant); const s2 = await engine.transition(s1.request, c, 'start_assessment', assessor);
    expect((await fail(engine.transition(s2.request, c, 'reject', assessor))).getStatus()).toBe(403);
    const noNote = await fail(engine.transition(s2.request, c, 'reject', approver)); expect(noNote.getStatus()).toBe(400); expect(noNote.message).toMatch(/note is required/);
    const rejected = await engine.transition(s2.request, c, 'reject', approver, 'insufficient evidence');
    expect(rejected.request).toMatchObject({ status: 'REJECTED', currentState: 'REJECTED', decidedAt: NOW.toISOString(), closedAt: NOW.toISOString() });
    expect(rejected.events.find((e) => e.type === EVENTS.workflow.requestDecided)!.data).toMatchObject({ outcome: 'REJECTED', note: 'insufficient evidence' });
    const verified = { ...s2.request, documents: s2.request.documents.map((d) => ({ ...d, verified: true })) };
    const inel = await fail(engine.transition(verified, c, 'approve', approver)); expect(inel.getStatus()).toBe(422); expect(inel.message).toMatch(/Eligibility not met: At least two units/); expect(inel.extra!.checks).toEqual(expect.arrayContaining([expect.objectContaining({ check: 'MIN_UNITS', passed: false })]));
    c.workflow.transitions.find((t) => t.action === 'submit')!.roles = ['*'];
    expect((await engine.transition(fresh(), c, 'submit', nobody)).request.status).toBe('SUBMITTED');
  });
  it('runs setField, information round-trips, checklist modes, inline fee lines and SLA clocks', async () => {
    const c = content();
    const s1 = await engine.transition(fresh({ units: 2, expedited: true }), c, 'submit', applicant);
    expect(s1.request.slaDueAt).toBe(new Date(NOW.getTime() + 2 * D).toISOString()); expect(s1.request.fees).toMatchObject({ subtotal: 230, taxAmount: 10, total: 240 });
    const s2 = await engine.transition(s1.request, c, 'start_assessment', assessor);
    const s3 = await engine.transition(s2.request, c, 'request_info', assessor, 'Certificate illegible');
    expect(s3.request.status).toBe('INFO_REQUESTED'); expect(engine.availableActions(c, s3.request, applicant).map((a) => a.action)).toEqual(['provide_info', 'withdraw']);
    const s4 = await engine.transition(s3.request, c, 'provide_info', applicant, 'resent', { formData: { note: 'clean scan attached' } });
    expect(s4.request).toMatchObject({ status: 'UNDER_ASSESSMENT', formData: { units: 2, expedited: true, note: 'clean scan attached', infoProvidedAt: NOW.toISOString() }, assignee: { userId: 'assessor-1' } });
    expect(s4.events.find((e) => e.type === EVENTS.workflow.requestNotify)!.data).toMatchObject({ audience: 'assignee', userId: 'assessor-1' });
    const missing = await fail(engine.transition({ ...s4.request, documents: s4.request.documents.map((d) => ({ ...d, verified: true })) }, c, 'approve', approver));
    expect(missing.message).toMatch(/Missing documents: Only when expedited/);
    c.workflow.transitions.find((t) => t.action === 'approve')!.effects[0].params = { mode: 'attached' };
    const attachedOnly = await engine.transition({ ...s4.request, documents: [...s4.request.documents, { code: 'doc3', documentId: 'x', name: 'doc3.pdf', uploadedAt: NOW.toISOString(), verified: false, verifiedBy: null, verifiedAt: null, notes: '' }] }, c, 'approve', approver);
    expect(attachedOnly.request.status).toBe('APPROVED');
    const inline = parseContent({ fees: { lines: [{ code: 'FLAT', description: 'Flat fee', amount: 80 }, { code: 'ZERO', description: 'Nothing', amount: 0 }], currency: 'AED' }, sla: { days: 4 }, workflow: defaultWorkflow({}) });
    const flat = await engine.transition(fresh(), inline, 'submit', applicant);
    expect(flat.request.fees).toMatchObject({ subtotal: 80, taxAmount: 4, total: 84, ruleSetKey: null }); expect(flat.request.fees!.lines).toHaveLength(1); expect(flat.request.slaDueAt).toBe(new Date(NOW.getTime() + 4 * D).toISOString());
    const noInstrument = parseContent({ sla: { days: 4 }, workflow: defaultWorkflow({}) });
    const a = await engine.transition(fresh(), noInstrument, 'submit', applicant); const b = await engine.transition(a.request, noInstrument, 'start_assessment', assessor);
    const approved = await engine.transition({ ...b.request, documents: [] }, noInstrument, 'approve', approver);
    expect(approved.request).toMatchObject({ status: 'APPROVED', closedAt: NOW.toISOString() }); expect(approved.request.payment).toMatchObject({ status: 'NOT_REQUIRED' });
    expect((await fail(engine.transition(approved.request, noInstrument, 'issue', approver))).getStatus()).toBe(409);
  });
  it('validates definitions and diffs versions', () => {
    const ok = content(); expect(validateContent(ok).filter((p) => p.severity === 'ERROR')).toEqual([]);
    const bad = parseContent({ form: { fields: [{ key: 'a', label: 'A', type: 'select' }, { key: 'a', label: 'A again' }] }, documents: [{ code: 'x', label: 'X' }, { code: 'x', label: 'X2' }], sla: { days: 0 },
      workflow: { states: [{ key: 'DRAFT', label: 'Draft', kind: 'START' }, { key: 'LOST', label: 'Lost', kind: 'TASK' }, { key: 'DEAD', label: 'Dead end', kind: 'TASK' }, { key: 'LOOP', label: 'Loop', kind: 'TASK' }, { key: 'END', label: 'End', kind: 'END' }],
        transitions: [{ from: 'DRAFT', to: 'END', action: 'finish', label: 'Finish', guard: { nope: [1] }, effects: [{ type: 'setField', params: {} }, { type: 'callService', params: { service: 'mail' } }] }, { from: 'DRAFT', to: 'END', action: 'finish', label: 'Again' }, { from: 'DRAFT', to: 'DEAD', action: 'die', label: 'Die' }, { from: 'DRAFT', to: 'LOOP', action: 'loop', label: 'Loop' }, { from: 'LOOP', to: 'LOOP', action: 'again', label: 'Again' }, { from: 'END', to: 'DRAFT', action: 'back', label: 'Back' }] } });
    const msgs = validateContent(bad).filter((p) => p.severity === 'ERROR').map((p) => p.message);
    for (const m of ['duplicate field key "a"', 'field "a" needs options', 'duplicate document code "x"', 'positive number of days', 'END state "END" needs an outcome', 'unknown operator "nope"', 'setField needs params.field', 'unknown service "mail"', 'callService needs params.ruleSetKey', 'duplicate action "finish"', 'END state "END" cannot have outgoing', 'state "LOST" is unreachable', 'state "DEAD" is a dead end', 'no END state is reachable from "LOOP"']) expect(msgs.join('\n')).toContain(m);
    const v1 = content(); const v2 = content(); v2.sla.days = 3; v2.form.fields.push({ ...v2.form.fields[0], key: 'remarks', label: 'Remarks' }); v2.workflow.transitions = v2.workflow.transitions.filter((t) => t.action !== 'withdraw');
    const changes = diffContent(v1, v2);
    expect(changes).toEqual(expect.arrayContaining([{ path: '$.sla.days', kind: 'changed', before: 10, after: 3 }, expect.objectContaining({ path: '$.form.fields[remarks]', kind: 'added' }), expect.objectContaining({ path: '$.workflow.transitions[DRAFT:withdraw]', kind: 'removed' })]));
    expect(diffContent(v1, content())).toEqual([]);
  });
});

const DB = 'maritime_workflow_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
const world = buildWorld({ profile: 'AE' });
const agentUser = world.users.find((u) => u.roleName === 'Shipping Agent')!; const vessel = world.vessels.find((v) => !v.real)!;
let app: INestApplication; let server: unknown; let seeded: Awaited<ReturnType<typeof seedWorkflow>>; let pool: Pool; let bus: MemoryBus;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const registrar = tok('registrar'); const assessorTok = tok('assessor'); const agent = tok('agent'); const other = tok('other'); const viewer = tok('viewer');
/* Two people at one company, and one at another: what the register must tell apart. */
const gssOne = tok('gss-one'); const gssTwo = tok('gss-two'); const oapOne = tok('oap-one');
const api = () => request(server as never);
const get = (p: string, t = admin) => api().get(p).set('authorization', t);
const post = (p: string, body: unknown, t = admin) => api().post(p).set('authorization', t).send(body as object);
const put = (p: string, body: unknown, t = admin) => api().put(p).set('authorization', t).send(body as object);

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  seeded = await seedWorkflow(URL, 'AE');
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, RULES_MODE: 'inline', RUNTIME_ENVIRONMENT: 'PROD', JURISDICTION: 'AE' } as never);
  const principal = (id: string, perms: string[], name = id) => ({ id, sub: id, name, email: `${id}@maritime.example`, perms, scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true });
  const resolver = new StaticPrincipalResolver({
    admin: principal('admin', ['*'], 'Admin'), registrar: principal('registrar', ['services.view', 'services.assess', 'services.approve', 'services.manage'], 'Registrar of Ships'),
    assessor: principal('assessor', ['services.view', 'services.assess'], 'Marine Surveyor'), agent: { ...principal(agentUser.id, ['services.view', 'services.apply'], agentUser.name), sub: 'agent' },
    other: principal('other', ['services.view', 'services.apply'], 'Other Applicant'), viewer: principal('viewer', ['services.view'], 'Viewer'),
    'gss-one': { ...principal('gss-one', ['services.view', 'services.apply'], 'Gulf Star — desk one'), kind: 'agent' as const, scope: { level: 'COMPANY', companies: ['GSS'] } },
    'gss-two': { ...principal('gss-two', ['services.view', 'services.apply'], 'Gulf Star — desk two'), kind: 'agent' as const, scope: { level: 'COMPANY', companies: ['GSS'] } },
    'oap-one': { ...principal('oap-one', ['services.view', 'services.apply'], 'Oceanic Agencies'), kind: 'agent' as const, scope: { level: 'COMPANY', companies: ['OAP'] } },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer(); bus = app.get(KIT_BUS); pool = new Pool({ connectionString: URL });
});
afterAll(async () => { await pool?.end(); await app?.close(); });

describe('workflow API', () => {
  it('seeds the catalogue with published PROD versions, studio drafts, the request register and the rule-set mirror', async () => {
    expect(seeded).toMatchObject({ definitions: 78, versions: 78 * 3 + 3, drafts: 3, requests: world.serviceRequests.length, ruleSets: 78, profile: 'AE' });
    expect((await seedWorkflow(URL, 'AE')).requests).toBe(0);
    const cat = await get('/services/catalogue', viewer); expect(cat.status).toBe(200); expect(cat.body.data.total).toBe(78); expect(cat.body.data.environment).toBe('PROD');
    expect(cat.body.data.categories[0].category).toBe('Registration'); expect(cat.body.data.categories.map((c: { category: string }) => c.category)).toContain('Seafarers');
    const reg = cat.body.data.categories[0].services.find((s: { key: string }) => s.key === 'reg.provisional');
    expect(reg).toMatchObject({ code: 'REG-PROVISIONAL', version: 1, subjectKind: 'VESSEL', fee: { amount: 1500, currency: 'AED', ruleSetKey: 'fee.reg.provisional', taxRatePct: 5 }, slaDays: 7 }); expect(reg.requiredDocuments).toBeGreaterThan(0); expect(reg.label).toBe(reg.name);
    const ar = await get('/services/catalogue', viewer).set('accept-language', 'ar-AE');
    const regAr = ar.body.data.categories[0].services.find((s: { key: string }) => s.key === 'reg.provisional'); expect(regAr.label).toBe(regAr.nameAr); expect(ar.body.data.categories[0].label).toBe('التسجيل');
    const defs = await get('/services/definitions?limit=5&sort=key&q=seafarer'); expect(defs.body.meta.total).toBeGreaterThan(5); expect(defs.body.data[0].versions.length).toBeGreaterThanOrEqual(3);
    const coc = await get('/services/definitions/SEAFARER-COC'); expect(coc.body.data).toMatchObject({ key: 'seafarer.coc', status: 'PUBLISHED', currentVersion: 1, runtimeEnvironment: 'PROD' });
    expect(coc.body.data.environments.DEV.map((v: { version: number; status: string }) => [v.version, v.status])).toEqual([[1, 'PUBLISHED'], [2, 'IN_REVIEW']]); expect(coc.body.data.live.workflow.transitions.some((t: { action: string; effects: { type: string; params: { ruleSetKey?: string } }[] }) => t.action === 'approve' && t.effects.some((e) => e.params.ruleSetKey === 'eligibility.coc'))).toBe(true);
    expect((await get('/services/catalogue', tok('nobody'))).status).toBe(401);
  });
  it('serves the dashboard and the eight stat cards', async () => {
    const d = await get('/services/dashboard', viewer); expect(d.status).toBe(200);
    expect(d.body.data.total).toBe(world.serviceRequests.length); expect(d.body.data.open).toBeGreaterThan(10); expect(d.body.data.issued).toBeGreaterThan(50); expect(d.body.data.slaCompliance).toBeLessThanOrEqual(100); expect(d.body.data.topServices.length).toBe(8); expect(d.body.data.byCategory[0].count).toBeGreaterThan(0);
    for (const p of ['/stats/services', '/services/stats']) {
      const s = await get(p, viewer); expect(s.status).toBe(200); expect(s.body.data).toHaveLength(8);
      for (const c of s.body.data) { expect(Object.keys(c).sort()).toEqual(['label', 'sub', 'tone', 'value']); expect(['default', 'success', 'warning', 'error', 'info']).toContain(c.tone); }
      expect(s.body.data.map((c: { label: string }) => c.label)).toEqual(['Open applications', 'Awaiting screening', 'Under assessment', 'SLA breached', 'Decided (30 d)', 'Approval rate', 'Avg decision', 'Catalogue']);
      expect(s.body.data[7].value).toBe(78);
    }
  });
  it('lists requests with applicant scoping, filters and search', async () => {
    const all = await get('/services/requests?limit=5'); expect(all.body.meta.total).toBe(world.serviceRequests.length); expect(all.body.data[0].timeline).toBeUndefined(); expect(all.body.data[0].number).toMatch(/^SR-\d{4}-\d{5}$/);
    const mine = world.serviceRequests.filter((r) => r.applicant.userId === agentUser.id).length; expect(mine).toBeGreaterThan(10);
    const ag = await get('/services/requests?limit=100', agent); expect(ag.body.meta.total).toBe(mine); expect(ag.body.data.every((r: { applicant: { userId: string } }) => r.applicant.userId === agentUser.id)).toBe(true);
    expect((await get('/services/requests', other)).body.meta.total).toBe(0);
    const issued = await get('/services/requests?status=issued&limit=3'); expect(issued.body.data.every((r: { status: string }) => r.status === 'ISSUED')).toBe(true); expect(issued.body.meta.total).toBeGreaterThan(50);
    const open = await get('/services/requests?open=true&limit=100'); expect(open.body.data.every((r: { status: string }) => ['SUBMITTED', 'UNDER_ASSESSMENT', 'INFO_REQUESTED'].includes(r.status))).toBe(true);
    const breached = await get('/services/requests?breached=true'); expect(breached.body.meta.total).toBeGreaterThan(0); expect(breached.body.data.every((r: { slaBreached: boolean }) => r.slaBreached)).toBe(true);
    const byDef = await get('/services/requests?definition=seafarer.coc&limit=1'); expect(byDef.body.data[0].definitionKey).toBe('seafarer.coc');
    const q = await get(`/services/requests?q=${all.body.data[0].number}`); expect(q.body.meta.total).toBe(1);
    const one = await get(`/services/requests/${all.body.data[0].id}`, registrar); expect(one.body.data.definition.states.length).toBeGreaterThan(5); expect(one.body.data.timeline.length).toBeGreaterThan(0);
    const foreign = ag.body.data[0].id; expect((await get(`/services/requests/${foreign}`, other)).status).toBe(404); expect((await get(`/services/requests/${foreign}`, agent)).status).toBe(200);
  });
  it('reads a select\'s options from the runtime\'s own mirror of the master, and follows the master as it changes', async () => {
    // the catalogue entry resolves the master into options, in both languages, and says which master they came from
    const entry = await get('/services/catalogue/vessel.nav.lic'); expect(entry.status).toBe(200);
    const area = entry.body.data.form.fields.find((f: { key: string }) => f.key === 'voyageArea');
    expect(area.optionsFrom).toBe('voyageArea'); expect(area.options.map((o: { value: string }) => o.value)).toContain('COASTAL'); expect(area.options.find((o: { value: string }) => o.value === 'COASTAL').labelAr).toBe('ساحلي');
    expect((await get('/services/catalogue/nope.nothing')).status).toBe(404);
    // validation is against the mirror: a code the master does not hold is refused, one it gains is accepted as soon as the event lands
    const body = { definitionKey: 'vessel.nav.lic', subjectId: vessel.id, subjectName: vessel.name, subject: { imo: vessel.imo, grt: vessel.grt }, formData: { voyageArea: 'ORBITAL', startDate: '2026-10-01T00:00:00Z' }, documents: [{ code: 'doc1', name: 'registry.pdf' }, { code: 'doc2', name: 'insurance.pdf' }] };
    expect((await post('/services/requests', body, agent)).body.message).toMatch(/ORBITAL.*not one of the options/);
    await withInbox(pool, makeEvent({ type: EVENTS.mdm.lookupChanged, source: 'mdm', data: { category: 'voyageArea', code: 'ORBITAL', change: 'created', count: 5, lookup: { category: 'voyageArea', code: 'ORBITAL', label: 'Orbital', labelAr: 'مداري', meta: {}, active: true } } }), (c) => applyLookupEvent(c, { type: EVENTS.mdm.lookupChanged, data: { category: 'voyageArea', code: 'ORBITAL', change: 'created', lookup: { category: 'voyageArea', code: 'ORBITAL', label: 'Orbital', active: true } } } as never).then(() => undefined));
    expect((await post('/services/requests', body, agent)).status).toBe(201);
    await withInbox(pool, makeEvent({ type: EVENTS.mdm.lookupChanged, source: 'mdm', data: { category: 'voyageArea', code: 'ORBITAL', change: 'deactivated' } }), (c) => applyLookupEvent(c, { type: EVENTS.mdm.lookupChanged, data: { category: 'voyageArea', code: 'ORBITAL', change: 'deactivated', lookup: { category: 'voyageArea', code: 'ORBITAL', label: 'Orbital', active: false } } } as never).then(() => undefined));
    expect((await post('/services/requests', body, agent)).status).toBe(400);
    // a definition may still carry inline options, and a master-backed select with no entries refuses rather than accepts anything
    const inline = parseContent({ form: { fields: [{ key: 'k', label: 'Kind', type: 'select', options: ['A', 'B'] }, { key: 'm', label: 'Master', type: 'select', lookup: 'emptyMaster' }] }, workflow: defaultWorkflow({ issuesInstrument: null, eligibilityRuleSetKey: null, stageDays: {} }) });
    expect(validateContent(inline).filter((x) => x.severity === 'ERROR')).toEqual([]);
    const resolver = async (category: string) => (category === 'emptyMaster' ? [] : null);
    expect(await validateFormData(inline, { k: 'A', m: 'X' }, async () => true, resolver)).toEqual(['Master: the emptyMaster master has no active entries to validate against']);
    expect(await validateFormData(inline, { k: 'C' }, async () => true, resolver)).toEqual(['Kind: "C" is not one of the options']);
    expect(validateContent(parseContent({ form: { fields: [{ key: 'k', label: 'Kind', type: 'select' }] }, workflow: defaultWorkflow({ issuesInstrument: null, eligibilityRuleSetKey: null, stageDays: {} }) })).map((x) => x.message)).toContain('field "k" needs options or a lookup');
  });
  it('lodges, assesses, approves and issues an application end to end with audit, events and notes', async () => {
    const body = { definitionKey: 'vessel.nav.lic', subjectId: vessel.id, subjectName: `${vessel.name} (IMO ${vessel.imo})`, subject: { imo: vessel.imo, grt: vessel.grt }, formData: { voyageArea: 'COASTAL', startDate: '2026-10-01T00:00:00Z' }, documents: [{ code: 'doc1', name: 'registry.pdf' }, { code: 'doc2' }, { code: 'doc3' }] };
    expect((await post('/services/requests', body, viewer)).status).toBe(403);
    expect((await post('/services/requests', { ...body, formData: { startDate: 'not a date' } }, agent)).status).toBe(400);
    expect((await post('/services/requests', { ...body, formData: { ...body.formData, voyageArea: 'Mars' } }, agent)).body.message).toMatch(/not one of the options/);
    expect((await post('/services/requests', { ...body, subjectId: null }, agent)).status).toBe(400);
    expect((await post('/services/requests', { ...body, definitionKey: 'nope.nothing' }, agent)).status).toBe(404);
    expect((await post('/services/requests', { ...body, documents: [{ code: 'zzz' }] }, agent)).status).toBe(400);
    const created = await post('/services/requests', body, agent); expect(created.status).toBe(201);
    const r = created.body.data; const seededMax = Math.max(...world.serviceRequests.map((x) => Number(x.requestNo.split('-')[2])));
    expect(r.number).toMatch(/^SR-\d{4}-\d{5}$/); expect(Number(r.number.split('-')[2])).toBeGreaterThan(seededMax);
    expect(r).toMatchObject({ status: 'SUBMITTED', currentState: 'SUBMITTED', definitionKey: 'vessel.nav.lic', definitionVersion: 1, subjectKind: 'VESSEL', subjectId: vessel.id, applicant: { userId: agentUser.id, name: agentUser.name }, payment: { status: 'DUE', amount: 2625 } });
    expect(r.fees).toMatchObject({ subtotal: 2500, taxRatePct: 5, taxAmount: 125, total: 2625, currency: 'AED', ruleSetKey: 'fee.vessel.nav.lic' }); expect(r.fees.lines.map((l: { code: string }) => l.code)).toEqual(['APP', 'ISS']);
    expect(r.slaDueAt).toBeTruthy(); expect(r.timeline.map((t: { action: string }) => t.action)).toEqual(['create', 'submit']); expect(r.availableActions.map((a: { action: string }) => a.action)).toEqual(['withdraw']);
    const draft = await post('/services/requests', { ...body, draft: true }, agent); expect(draft.body.data).toMatchObject({ status: 'DRAFT', currentState: 'DRAFT', fees: null });
    expect((await get(`/services/requests/${r.id}`, other)).status).toBe(404);
    const asAdmin = await get(`/services/requests/${r.id}`); expect(asAdmin.body.data.availableActions.map((a: { action: string }) => a.action)).toEqual(['start_assessment', 'withdraw']);
    expect((await post(`/services/requests/${r.id}/transition`, { action: 'start_assessment' }, agent)).status).toBe(403);
    expect((await post(`/services/requests/${r.id}/transition`, { action: 'approve' }, registrar)).status).toBe(409);
    const started = await post(`/services/requests/${r.id}/transition`, { action: 'start_assessment' }, assessorTok); expect(started.status).toBe(201);
    expect(started.body.data).toMatchObject({ status: 'UNDER_ASSESSMENT', assignee: { userId: 'assessor', name: 'Marine Surveyor' } });
    expect((await post(`/services/requests/${r.id}/transition`, { action: 'approve' }, assessorTok)).status).toBe(403);
    const unverified = await post(`/services/requests/${r.id}/transition`, { action: 'approve' }, registrar); expect(unverified.status).toBe(422); expect(unverified.body.message).toMatch(/not yet verified/);
    expect((await put(`/services/requests/${r.id}/documents/doc1`, { verified: true }, agent)).status).toBe(403);
    for (const code of ['doc1', 'doc2', 'doc3']) { const v = await put(`/services/requests/${r.id}/documents/${code}`, { verified: true, notes: 'checked' }, assessorTok); expect(v.status).toBe(200); expect(v.body.data.document).toMatchObject({ code, verified: true, verifiedBy: 'Marine Surveyor' }); }
    expect((await put(`/services/requests/${r.id}/documents/nope`, { verified: true }, assessorTok)).status).toBe(404);
    const approved = await post(`/services/requests/${r.id}/transition`, { action: 'approve', note: 'Assessment satisfactory' }, registrar);
    expect(approved.status).toBe(201); expect(approved.body.data).toMatchObject({ status: 'APPROVED', currentState: 'APPROVED' }); expect(approved.body.data.decidedAt).toBeTruthy(); expect(approved.body.data.availableActions.map((a: { action: string }) => a.action)).toEqual(['issue']);
    expect((await post(`/services/requests/${r.id}/issue`, {}, assessorTok)).status).toBe(403);
    const issued = await post(`/services/requests/${r.id}/issue`, { note: 'Licence issued' }, registrar); expect(issued.status).toBe(201);
    expect(issued.body.data).toMatchObject({ status: 'ISSUED', currentState: 'ISSUED', instrument: { type: 'NAVIGATION_LICENCE', class: 'LICENCE', status: 'REQUESTED' } }); expect(issued.body.data.closedAt).toBeTruthy();
    expect((await post(`/services/requests/${r.id}/documents`, { code: 'doc1' }, agent)).status).toBe(409);
    const events = await pool.query<{ subject: string; payload: { type: string; data: Record<string, unknown> } }>("SELECT subject, payload FROM outbox WHERE payload->>'subject' = $1 ORDER BY id", [`ServiceRequest:${r.number}`]);
    const types = events.rows.map((e) => e.payload.type);
    expect(types.filter((t) => t === EVENTS.workflow.requestTransitioned)).toHaveLength(4); expect(types).toContain(EVENTS.workflow.requestCreated); expect(types).toContain(EVENTS.workflow.requestSubmitted); expect(types).toContain(EVENTS.workflow.requestDecided); expect(types).toContain(EVENTS.workflow.requestIssued); expect(types).toContain(EVENTS.workflow.requestDocument); expect(types.filter((t) => t === EVENTS.readModel.upserted).length).toBeGreaterThanOrEqual(8);
    const rm = events.rows.filter((e) => e.payload.type === EVENTS.readModel.upserted).pop()!.payload.data as { kind: string; entity: { status: string } }; expect(rm.kind).toBe('serviceRequest'); expect(rm.entity.status).toBe('ISSUED');
    const audits = await pool.query<{ n: string }>("SELECT count(*) AS n FROM outbox WHERE subject = 'maritime.audit.recorded' AND payload->'data'->>'entityLabel' LIKE $1", [`${r.number}%`]); expect(Number(audits.rows[0].n)).toBeGreaterThanOrEqual(8);
    const applicantNote = await post(`/services/requests/${r.id}/notes`, { body: 'Thank you', internal: true }, agent); expect(applicantNote.body.data.internal).toBe(false);
    await post(`/services/requests/${r.id}/notes`, { body: 'Checked against the register' }, assessorTok);
    expect((await get(`/services/requests/${r.id}/timeline`, agent)).body.data.notes).toHaveLength(1); expect((await get(`/services/requests/${r.id}/notes`, registrar)).body.data).toHaveLength(2);
    await withTx(pool, (c) => linkInstrument(c, 'workflow', { requestId: r.id, instrumentId: 'lic-1', number: 'NAV-2026-0042', entityType: 'NAVIGATION_LICENCE', issueDate: '2026-09-02T10:00:00Z' }));
    expect((await get(`/services/requests/${r.id}`, agent)).body.data.issuedInstrument).toMatchObject({ number: 'NAV-2026-0042', status: 'ISSUED', type: 'NAVIGATION_LICENCE' });
    const paid = await post(`/services/requests/${r.id}/payment`, { reference: 'RCPT/2026/9' }, registrar); expect(paid.body.data.payment).toMatchObject({ status: 'PAID', amount: 2625, reference: 'RCPT/2026/9' });
    const assigned = await post(`/services/requests/${draft.body.data.id}/assign`, { userId: 'me' }, assessorTok); expect(assigned.body.data.assignee).toEqual({ userId: 'assessor', name: 'Marine Surveyor' });
    const info = await post(`/services/requests/${draft.body.data.id}/transition`, { action: 'submit' }, agent); expect(info.body.data.status).toBe('SUBMITTED');
  });
  it('takes a definition from draft to production one environment at a time and simulates it', async () => {
    const def = { key: 'test.permit', name: 'Test permit', nameAr: 'تصريح اختبار', category: 'Licensing', subjectKind: 'VESSEL', domain: 1, issuesInstrument: 'VESSEL_NOC', content: { form: { fields: [{ key: 'purpose', label: 'Purpose', type: 'select', options: ['Shifting', 'Dry dock'], required: true }] }, documents: [{ code: 'plan', label: 'Movement plan' }], fees: { lines: [{ code: 'APP', description: 'Application fee', amount: 200 }] }, sla: { days: 5 } } };
    expect((await post('/services/definitions', def, viewer)).status).toBe(403);
    expect((await post('/services/definitions', { ...def, key: 'Bad Key' })).status).toBe(400);
    const created = await post('/services/definitions', def, registrar); expect(created.status).toBe(201);
    expect(created.body.data).toMatchObject({ key: 'test.permit', code: 'TEST-PERMIT', status: 'DRAFT', currentVersion: null, categoryAr: 'الترخيص', ownerModule: 'ships' }); expect(created.body.data.versions[0]).toMatchObject({ version: 1, environment: 'DEV', status: 'DRAFT' });
    expect(created.body.data.versions[0].workflow.states.map((s: { key: string }) => s.key)).toContain('ISSUED'); expect(created.body.data.versions[0].outputs.instrumentType).toBe('VESSEL_NOC');
    expect((await post('/services/definitions', def, registrar)).status).toBe(409);
    const id = created.body.data.id; const V = `/services/definitions/${id}/versions/1`;
    const broken = await put(V, { workflow: { states: [{ key: 'DRAFT', label: 'Draft', kind: 'START' }, { key: 'LOST', label: 'Lost', kind: 'TASK' }, { key: 'DONE', label: 'Done', kind: 'END', outcome: 'APPROVED' }], transitions: [{ from: 'DRAFT', to: 'DONE', action: 'submit', label: 'Submit' }] } }, registrar);
    expect(broken.status).toBe(200); expect(broken.body.data.validation.errors.map((e: { message: string }) => e.message).join(' ')).toMatch(/unreachable/);
    const validation = await post(`${V}/validate`, {}, viewer); expect(validation.body.data.ok).toBe(false); expect(validation.body.data.problems[0].message).toMatch(/unreachable/);
    expect((await post(`${V}/submit-review`, {}, registrar)).status).toBe(400);
    const fixed = await put(V, { workflow: created.body.data.versions[0].workflow, changeNote: 'restored' }, registrar); expect(fixed.body.data.validation.errors).toEqual([]);
    expect((await post(`${V}/publish`, {}, registrar)).status).toBe(409);
    expect((await post(`${V}/submit-review`, {}, registrar)).body.data.status).toBe('IN_REVIEW');
    expect((await put(V, { sla: { days: 4 } }, registrar)).status).toBe(409);
    expect((await post(`${V}/promote`, { to: 'UAT' }, registrar)).status).toBe(409);
    expect((await post(`${V}/approve`, {}, registrar)).body.data).toMatchObject({ status: 'APPROVED', approvedBy: 'registrar' });
    expect((await post(`${V}/promote`, { to: 'UAT' }, registrar)).status).toBe(409);
    const devPub = await post(`${V}/publish`, {}, registrar); expect(devPub.body.data).toMatchObject({ status: 'PUBLISHED', environment: 'DEV', definition: { status: 'DRAFT', currentVersion: null } });
    expect((await post('/services/requests', { definitionKey: 'test.permit', subjectId: 'v', formData: { purpose: 'Shifting' } }, agent)).status).toBe(404);
    expect((await post(`${V}/promote`, { to: 'DEV' }, registrar)).status).toBe(400);
    expect([404, 409]).toContain((await post(`${V}/promote`, { to: 'PROD' }, registrar)).status);
    const uat = await post(`${V}/promote`, { to: 'UAT' }, registrar); expect(uat.status).toBe(201); expect(uat.body.data).toMatchObject({ environment: 'UAT', status: 'APPROVED', promotedFrom: 'v1:DEV' });
    expect((await post(`${V}/publish`, { environment: 'UAT' }, registrar)).body.data.status).toBe('PUBLISHED');
    expect((await post(`${V}/promote`, { to: 'UAT' }, registrar)).status).toBe(409);
    expect((await post(`${V}/promote`, { to: 'PROD' }, registrar)).body.data).toMatchObject({ environment: 'PROD', status: 'APPROVED' });
    const prod = await post(`${V}/publish`, { environment: 'PROD', note: 'go live' }, registrar); expect(prod.body.data.definition).toMatchObject({ status: 'PUBLISHED', currentVersion: 1 });
    expect((await get('/services/catalogue', viewer)).body.data.total).toBe(79);
    const lodged = await post('/services/requests', { definitionKey: 'test.permit', subjectId: 'v-1', subjectName: 'Any vessel', formData: { purpose: 'Shifting' }, documents: [{ code: 'plan' }] }, agent);
    expect(lodged.status).toBe(201); expect(lodged.body.data.fees).toMatchObject({ subtotal: 200, total: 210, ruleSetKey: null });
    const v2 = await post(`/services/definitions/${id}/versions`, { changeNote: 'shorter SLA' }, registrar); expect(v2.body.data).toMatchObject({ version: 2, environment: 'DEV', status: 'DRAFT', promotedFrom: 'v1:PROD' });
    expect((await post(`/services/definitions/${id}/versions`, {}, registrar)).status).toBe(409);
    await put(`/services/definitions/${id}/versions/2`, { sla: { days: 3 }, form: { fields: [...created.body.data.versions[0].form.fields, { key: 'remarks', label: 'Remarks', type: 'text' }] } }, registrar);
    const diff = await get(`/services/definitions/${id}/versions/1/diff/2?environment=PROD&environment2=DEV`, viewer);
    expect(diff.body.data.changes).toEqual(expect.arrayContaining([{ path: '$.sla.days', kind: 'changed', before: 5, after: 3 }, expect.objectContaining({ path: '$.form.fields[remarks]', kind: 'added' })])); expect(diff.body.data.summary).toMatchObject({ sla: 1, form: 1, workflow: 0 });
    const full = await get(`/services/definitions/test.permit`, viewer); expect(full.body.data.environments).toMatchObject({ DEV: [expect.objectContaining({ version: 1, status: 'PUBLISHED' }), expect.objectContaining({ version: 2, status: 'DRAFT' })], UAT: [expect.objectContaining({ version: 1 })], PROD: [expect.objectContaining({ version: 1, status: 'PUBLISHED' })] });
    const sim = await post(`${V}/simulate`, { environment: 'PROD', formData: { purpose: 'Shifting' }, documents: [{ code: 'plan', verified: true }], actions: ['submit', 'start_assessment', 'approve', 'issue'], actor: { perms: ['*'] }, now: '2026-09-02T00:00:00Z' }, viewer);
    expect(sim.status).toBe(201); expect(sim.body.data.ok).toBe(true); expect(sim.body.data.steps.map((s: { to: string }) => s.to)).toEqual(['SUBMITTED', 'UNDER_ASSESSMENT', 'APPROVED', 'ISSUED']); expect(sim.body.data.steps[0].fees.total).toBe(210); expect(sim.body.data.steps[0].slaDueAt).toBe('2026-09-07T00:00:00.000Z'); expect(sim.body.data.request.status).toBe('ISSUED');
    const simFail = await post(`${V}/simulate`, { environment: 'PROD', formData: { purpose: 'Shifting' }, documents: [{ code: 'plan', verified: false }], actions: ['submit', 'start_assessment', 'approve'] }, viewer);
    expect(simFail.body.data.ok).toBe(false); expect(simFail.body.data.steps).toHaveLength(3); expect(simFail.body.data.steps[2].error.status).toBe(422);
    expect((await get(`/services/requests?definition=test.permit`)).body.meta.total).toBe(1);
    const retired = await post(`${V}/retire`, { environment: 'PROD', note: 'superseded' }, registrar); expect(retired.body.data.definition).toMatchObject({ status: 'RETIRED', currentVersion: null });
    expect((await get('/services/catalogue', viewer)).body.data.total).toBe(78);
  });
  it('marks SLA breaches on the scheduler sweep and mirrors published rule sets', async () => {
    const before = await pool.query<{ n: string }>("SELECT count(*) AS n FROM service_requests WHERE sla_breached = false AND closed_at IS NULL AND status <> 'DRAFT' AND sla_due_at < now()");
    const awaited = Number(before.rows[0].n); expect(awaited).toBeGreaterThan(0);
    await bus.publish(subjectFor(EVENTS.scheduler.sweepSla), makeEvent({ type: EVENTS.scheduler.sweepSla, source: 'scheduler', data: { at: new Date().toISOString() } })); await bus.drain();
    const after = await pool.query<{ n: string }>("SELECT count(*) AS n FROM service_requests WHERE sla_breached = true AND sla_breached_at IS NOT NULL"); expect(Number(after.rows[0].n)).toBeGreaterThanOrEqual(awaited);
    expect(Number((await pool.query<{ n: string }>("SELECT count(*) AS n FROM outbox WHERE subject = $1", [subjectFor(EVENTS.workflow.requestSlaBreached)])).rows[0].n)).toBeGreaterThanOrEqual(awaited);
    expect((await withTx(pool, (c) => sweepSla(c, 'workflow'))).breached).toBe(0);
    const breached = await get('/services/requests?breached=true&limit=1'); expect(breached.body.data[0].slaBreached).toBe(true); expect(breached.body.data[0].slaBreachedAt).toBeTruthy();
    await bus.publish(subjectFor(EVENTS.rules.published), makeEvent({ type: EVENTS.rules.published, source: 'rules', data: { key: 'fee.vessel.nav.lic', kind: 'FEE', version: 2, definition: { lines: [{ code: 'APP', description: 'Application fee', amount: 3000, taxable: true }] }, parameters: { currency: 'AED' } } })); await bus.drain();
    const cached = await pool.query<{ version: number; definition: { lines: { amount: number }[] } }>("SELECT version, definition FROM rule_set_cache WHERE key = 'fee.vessel.nav.lic'"); expect(cached.rows[0].version).toBe(2); expect(cached.rows[0].definition.lines[0].amount).toBe(3000);
    expect(await withTx(pool, (c) => cacheRuleSet(c, { key: 'x' }))).toBe(false);
    const again = await post('/services/requests', { definitionKey: 'vessel.nav.lic', subjectId: vessel.id, subjectName: vessel.name, formData: { voyageArea: 'COASTAL', startDate: '2026-10-01T00:00:00Z' } }, agent);
    expect(again.body.data.fees).toMatchObject({ subtotal: 3000, total: 3150, ruleSetVersion: 2 });
  });
});

/* ================================================ tenancy on the request register === */

describe('workflow — tenancy', () => {
  it('carries the applicant\'s company as a code, not only as a name', async () => {
    /* A name identifies a company to a reader; only a code identifies it to the platform. The register used
     * to hold the name alone, which is why it could not be partitioned. */
    const r = await pool.query<{ owned: string; named: string }>(
      `SELECT count(*) FILTER (WHERE scope_company <> '')::text AS owned,
              count(*) FILTER (WHERE COALESCE(applicant->>'organisation', '') <> '')::text AS named FROM service_requests`);
    expect(Number(r.rows[0].named)).toBeGreaterThan(0);
    expect(Number(r.rows[0].owned)).toBeGreaterThan(0);
    const drift = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM service_requests WHERE scope_company <> COALESCE(applicant->>'organisationCode', '')");
    expect(Number(drift.rows[0].n)).toBe(0);
  });

  it('shows a company its own applications, whichever of its people lodged them', async () => {
    const mine = await get('/services/requests?limit=500', gssOne);
    expect(mine.status).toBe(200);
    expect(mine.body.meta.total).toBeGreaterThan(0);
    /* The point of the change: a second desk at the same agency sees the same register. Neither of them
     * lodged these applications personally — the seeded applicant is a third user — and under the old rule
     * that meant both saw nothing. */
    const colleague = await get('/services/requests?limit=500', gssTwo);
    expect(colleague.body.meta.total).toBe(mine.body.meta.total);
    expect(colleague.body.data.map((r: { id: string }) => r.id).sort())
      .toEqual(mine.body.data.map((r: { id: string }) => r.id).sort());
    // and `mine=true` still narrows either of them to what they lodged themselves
    expect((await get('/services/requests?limit=500&mine=true', gssTwo)).body.meta.total).toBe(0);

    const theirs = await get('/services/requests?limit=500', oapOne);
    const mineIds = new Set(mine.body.data.map((r: { id: string }) => r.id));
    expect(theirs.body.data.some((r: { id: string }) => mineIds.has(r.id))).toBe(false);

    const all = await get('/services/requests?limit=500', admin);
    expect(all.body.meta.total).toBeGreaterThan(mine.body.meta.total);
  });

  it('answers "not found" for another company\'s application, by id and by number', async () => {
    const other = (await pool.query<{ id: string; number: string }>(
      "SELECT id, number FROM service_requests WHERE scope_company = 'OAP' LIMIT 1")).rows[0];
    expect(other).toBeTruthy();
    expect((await get(`/services/requests/${other.id}`, gssOne)).status).toBe(404);
    expect((await get(`/services/requests/${other.number}`, gssOne)).status).toBe(404);
    expect((await get(`/services/requests/${other.id}`, admin)).status).toBe(200);
  });

  it('stamps a new application with the author\'s own company, not with what the body claims', async () => {
    const r = await post('/services/requests', {
      definitionKey: 'vessel.nav.lic', subjectId: vessel.id, subjectName: `${vessel.name} (IMO ${vessel.imo})`,
      subject: { imo: vessel.imo, grt: vessel.grt }, draft: true,
      formData: { voyageArea: 'COASTAL', startDate: '2026-10-01T00:00:00Z' },
      documents: [{ code: 'doc1', name: 'registry.pdf' }, { code: 'doc2' }, { code: 'doc3' }],
      applicant: { name: 'Impersonator', organisation: 'Oceanic Agencies FZE', organisationCode: 'OAP' },
    }, gssOne);
    expect(r.status).toBe(201);
    const row = (await pool.query<{ scope_company: string }>('SELECT scope_company FROM service_requests WHERE id = $1', [r.body.data.id])).rows[0];
    // the body named another company; the author's own scope decides
    expect(row.scope_company).toBe('GSS');
    expect((await get(`/services/requests/${r.body.data.id}`, oapOne)).status).toBe(404);
    await pool.query('DELETE FROM service_requests WHERE id = $1', [r.body.data.id]);
  });

  it('leaves a national assessor reading everything, with no clause added at all', async () => {
    expect((await get('/services/requests?limit=1', registrar)).body.meta.total)
      .toBe((await get('/services/requests?limit=1', admin)).body.meta.total);
  });
});
