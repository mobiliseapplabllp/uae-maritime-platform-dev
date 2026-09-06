import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { KIT_SETTINGS, PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256, type Principal } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedAiAssistant } from '../src/seed';

/* Gateway mode: the assistant reads nothing itself. Every tool is a call to the tool gateway as the person asking,
 * and every hosted completion goes through it too. A fake gateway stands in here and records what it was asked. */

const DB = 'maritime_ai_assistant_gw_test'; const DB_URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let fake: Server; let fakeUrl = '';
const tok = (sub: string) => signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' });
const officer = tok('officer');
const assessor = tok('assessor');
const designer = tok('designer');
const chat = (message: string, t = officer) => request(server as never).post('/ai/chat').set('authorization', `Bearer ${t}`).send({ message });
const g = (p: string, t = officer) => request(server as never).get(p).set('authorization', `Bearer ${t}`);

let seen: { url: string; headers: Record<string, string | string[] | undefined>; body: any }[] = [];
let aiSettings: Record<string, unknown> = { enabled: true, provider: 'local', model: 'assistant-default', groundedOnly: true };
let completeMode: 'local' | 'ok' | 'refused' | 'json' = 'local';
let disabled = new Set<string>();
const VESSEL = { id: 'v1', name: 'Al Ain Oasis', imo: '9720500', flag: 'AE', type: 'GEN', built: 2023, status: 'ACTIVE', riskBand: 'LOW', riskScore: 12 };
const APPLICATION = { id: 'app1', number: 'SR-2026-00031', definitionKey: 'company.pest-control', definitionName: 'Vessel Pest Control and Deratting Approval — application', definitionNameAr: 'اعتماد مكافحة الآفات وإبادة القوارض على السفن — طلب', subjectKind: 'COMPANY', subjectName: 'West Coast Maritime Services', applicant: { name: 'Priya Khan', organisation: 'West Coast Maritime Services' }, status: 'APPROVED', currentState: 'APPROVED', submittedAt: '2026-06-18T07:45:42.320Z', decidedAt: '2026-06-26T07:45:42.320Z', issuedInstrument: null, documents: [{ code: 'doc1', verified: true }, { code: 'doc2', verified: false }], fees: { total: 12600, currency: 'AED' }, payment: { status: 'PAID', paidAt: '2026-06-18T07:45:42.320Z' }, timeline: [{ to: 'APPROVED', from: 'UNDER_ASSESSMENT', note: 'Assessment satisfactory' }] };
const DEFINITION = { id: 'def1', key: 'fac.pest-control', code: 'FAC-PEST-CONTROL', name: 'Vessel Pest Control and Deratting Approval — application', nameAr: 'اعتماد مكافحة الآفات وإبادة القوارض على السفن — طلب', category: 'Licensing', domain: 7, subjectKind: 'COMPANY', issuesInstrument: 'PEST_CONTROL', description: 'Pest control and deratting approval for companies serving ships in port.',
  live: { version: 1, environment: 'PROD', status: 'PUBLISHED', form: { fields: [{ key: 'premises', label: 'Premises address', labelAr: 'عنوان المقر', type: 'text', required: true, options: [], section: 'Application', help: '', multiline: false }], sections: [] }, documents: [{ code: 'doc1', label: 'Trade licence', labelAr: null, required: true, docType: 'PDF', acceptedFormats: 'PDF, JPG, PNG' }], fees: { lines: [{ code: 'APP', description: 'Application fee', descriptionAr: 'رسم الطلب', amount: 3600, taxable: true }], currency: 'AED' }, sla: { days: 15 }, outputs: { instrumentType: 'PEST_CONTROL', instrumentClass: 'ACCREDITATION', validityMonths: 12, notifications: [], templates: [] } } };
const CATALOGUE = { total: 1, autoApprovable: 0, environment: 'PROD', currency: 'AED', categories: [{ category: 'Licensing', services: [{ id: 'def1', key: 'fac.pest-control', name: DEFINITION.name, description: DEFINITION.description, subjectKind: 'COMPANY' }] }] };
const CALL = { id: 'pc1', vcn: 'MAR-2026-0270', status: 'BERTHED', berthCode: 'CB-2', vesselName: 'Al Ain Oasis', vesselImo: '9720500', eta: '2026-09-09T22:45:45.000Z', agentName: 'Trident Marine Agencies' };
const TOOL_ROWS = [
  { name: 'ships.search', module: 'ships', label: 'Vessels', tier: 'READ', permission: 'vessels.view' },
  { name: 'ops.port_calls', module: 'ops', label: 'Port calls', tier: 'READ', permission: 'portcalls.view' },
  { name: 'ops.dashboard', module: 'ops', label: 'Harbour dashboard', tier: 'READ', permission: 'portcalls.view' },
  { name: 'incidents.list', module: 'incidents', label: 'Incidents', tier: 'READ', permission: 'incidents.view' },
];
const handle = (req: IncomingMessage, res: ServerResponse) => {
  let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
    const body = raw ? JSON.parse(raw) : undefined; const url = req.url ?? ''; seen.push({ url, headers: req.headers, body });
    const json = (status: number, payload: unknown) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(payload)); };
    if (url === '/internal/settings/ai') return json(200, { success: true, data: aiSettings });
    if (url.startsWith('/ai-gateway/tools/catalogue')) return json(200, { success: true, data: { caller: 'assistant', tools: TOOL_ROWS.map((t) => ({ ...t, labelAr: '', description: '', exposure: 'BOTH', input: {}, triggers: [], enabled: !disabled.has(t.name), allowed: true })) } });
    const run = url.match(/^\/ai-gateway\/tools\/([^/]+)\/run$/);
    if (run) {
      const tool = decodeURIComponent(run[1]);
      if (req.headers['x-service-token'] !== 'development-service-token') return json(401, { success: false, message: 'Service token required' });
      const ok = (data: unknown) => json(201, { success: true, data: { callId: 'c1', outcome: 'OK', tool, tier: 'READ', module: tool.split('.')[0], latencyMs: 3, status: 200, data } });
      if (disabled.has(tool)) return json(201, { success: true, data: { callId: 'c2', outcome: 'REFUSED', tool, tier: 'READ', module: tool.split('.')[0], latencyMs: 1, code: 'TOOL_DISABLED', reason: `${tool} is disabled at the gateway` } });
      if (tool === 'ships.search') return ok({ items: [VESSEL], meta: { total: 1, page: 1, limit: 20 } });
      if (tool === 'ops.port_calls') return ok({ items: [CALL], meta: { total: 1, page: 1, limit: 20 } });
      if (tool === 'ops.dashboard') return ok({ kpis: { inPort: 9, atAnchorage: 5, expected72h: 7, berthOccupancyPct: 39, avgWaitingHrs: 3.2, avgTurnaroundHrs: 47.9 }, arrivals: [{ id: 'pc2', vcn: 'MAR-2026-0271', vesselName: 'Liwa Horizon', eta: '2026-09-07T04:00:00.000Z' }] });
      if (tool === 'incidents.list') return ok({ items: [], meta: { total: 0, page: 1, limit: 20 } });
      if (tool === 'services.application') return ok(APPLICATION);
      if (tool === 'services.catalogue') return ok(CATALOGUE);
      if (tool === 'services.definition') return body.args?.id === 'no.such' ? json(201, { success: true, data: { callId: 'c5', outcome: 'FAILED', tool, tier: 'READ', module: 'services', latencyMs: 2, status: 404, reason: 'Service definition no.such not found' } }) : ok(DEFINITION);
      return json(201, { success: true, data: { callId: 'c3', outcome: 'FAILED', tool, tier: 'READ', module: '', latencyMs: 1, reason: 'no such fake' } });
    }
    if (url === '/ai-gateway/complete') {
      if (completeMode === 'json') return json(201, { success: true, data: { outcome: 'OK', provider: 'uae', profile: 'resident-a', residency: 'AE', latencyMs: 40, text: 'Here is the wording: {"nameAr": "اعتماد مورّد السفن — طلب", "descriptionAr": "اعتماد شركة لتوريد المؤن للسفن الراسية في الميناء."}', redactions: 0, redactionKinds: {}, injection: { score: 0, flags: [] }, fingerprint: 'f'.repeat(64), tokensIn: 300, tokensOut: 20 } });
      if (completeMode === 'ok') return json(201, { success: true, data: { outcome: 'OK', provider: 'uae', profile: 'resident-a', residency: 'AE', latencyMs: 40, text: 'Al Ain Oasis is alongside at CB-2 on call MAR-2026-0270 [1].', redactions: 0, redactionKinds: {}, injection: { score: 0, flags: [] }, fingerprint: 'f'.repeat(64), tokensIn: 300, tokensOut: 20 } });
      if (completeMode === 'refused') return json(201, { success: true, data: { outcome: 'REFUSED', provider: 'uae', profile: 'resident-a', residency: 'AE', latencyMs: 2, code: 'INJECTION', reason: 'Refused before any model saw it: adversarial score 0.9 (ignore-instructions, exfiltration)', redactions: 0, redactionKinds: {}, injection: { score: 0.9, flags: ['ignore-instructions', 'exfiltration'] } } });
      return json(201, { success: true, data: { outcome: 'LOCAL', provider: 'local', profile: 'assistant-default', residency: 'AE', latencyMs: 1, code: 'NO_PROVIDER', reason: 'No hosted provider is configured in Settings → AI', redactions: 0, redactionKinds: {}, injection: { score: 0, flags: [] } } });
    }
    json(404, { success: false, message: 'not here' });
  });
};

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedAiAssistant(DB_URL, 'AE');
  fake = createServer(handle);
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', () => { fakeUrl = `http://127.0.0.1:${(fake.address() as { port: number }).port}`; r(); }));
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: DB_URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, MDM_URL: fakeUrl, TOOL_MODE: 'gateway', AI_TOOL_GATEWAY_URL: fakeUrl, AI_TOOL_GATEWAY_TIMEOUT_MS: '2000' } as never);
  const base = { scope: { level: 'NATIONAL' as const }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const people: Record<string, Principal> = {
    officer: { ...base, id: 'officer', sub: 'officer', name: 'Duty Officer', perms: ['ai.use', 'vessels.view', 'portcalls.view', 'invoices.view'] },
    assessor: { ...base, id: 'assessor', sub: 'assessor', name: 'Desk Assessor', perms: ['ai.use', 'services.view', 'services.assess'] },
    designer: { ...base, id: 'designer', sub: 'designer', name: 'Studio Designer', perms: ['ai.use', 'services.view', 'services.manage'] },
  };
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: new StaticPrincipalResolver(people) }) });
  await app.init(); server = app.getHttpServer(); pool = new Pool({ connectionString: DB_URL });
});
afterAll(async () => { await app?.close(); await pool?.end(); await new Promise((r) => fake.close(r)); });
const setAi = (v: Record<string, unknown>) => { aiSettings = { ...aiSettings, ...v }; (app.get(KIT_SETTINGS) as { invalidate: (k?: string) => void }).invalidate('ai'); };

describe('ai-assistant — gateway mode', () => {
  it('reads the register through the gateway as the person asking, and cites the record', async () => {
    seen = [];
    const r = await chat('What is the status of vessel Al Ain Oasis?');
    expect(r.status).toBe(201);
    expect(r.body.data.reply).toContain('**Al Ain Oasis** (IMO 9720500, AE, GEN, built 2023)');
    expect(r.body.data.reply).toContain('berthed at CB-2 on call MAR-2026-0270');
    expect(r.body.data.tools.map((t: { tool: string }) => t.tool)).toContain('vessel.lookup');
    expect(r.body.data.sources).toEqual(expect.arrayContaining([{ label: 'Al Ain Oasis', link: '/vessels/v1' }]));
    const calls = seen.filter((s) => s.url.includes('/tools/'));
    expect(calls.map((c) => c.url)).toEqual(expect.arrayContaining(['/ai-gateway/tools/ships.search/run', '/ai-gateway/tools/ops.port_calls/run']));
    for (const c of calls) { expect(c.headers['x-user-token']).toBe(officer); expect(c.body.caller).toBe('assistant'); expect(c.body.cause).toBe('assistant'); }
    expect(calls[0].body.args).toEqual({ q: 'al ain oasis', limit: 3 });
    expect(r.body.data.engine).toBe('assistant-default (grounded)');
  });
  it('refuses what the person may not read before the gateway is ever asked', async () => {
    seen = [];
    const r = await chat('Which incidents are open right now?');
    expect(r.body.data.refusals).toEqual([expect.objectContaining({ tool: 'incident.open', permission: 'incidents.view' })]);
    expect(seen.filter((s) => s.url.includes('incidents.list'))).toHaveLength(0);
    expect(r.body.data.reply).toContain('Outside your permissions');
  });
  it('reports a tool the gateway refused as unread, never as a fact', async () => {
    disabled = new Set(['ops.dashboard']); seen = [];
    const r = await chat('How busy is the harbour today, what is expected?');
    expect(r.body.data.reply).toContain('could not be read through the tool gateway (ops.dashboard is disabled at the gateway)');
    disabled = new Set();
    const again = await chat('How busy is the harbour today, what is expected?');
    expect(again.body.data.reply).toContain('9 vessel(s) in port and 5 at anchorage');
    expect(again.body.data.reply).toContain('Liwa Horizon (MAR-2026-0271');
  });
  it('lists the gateway surface with what this reader holds, and names the mode', async () => {
    const tools = await g('/ai/tools');
    const by = Object.fromEntries(tools.body.data.map((t: { name: string; available: boolean }) => [t.name, t.available]));
    expect(by['vessel.lookup']).toBe(true); expect(by['incident.open']).toBe(false); expect(by['kpi.overview']).toBe(false);
    expect(tools.body.data.length).toBeGreaterThanOrEqual(15);
    const status = await g('/ai/status');
    expect(status.body.data).toMatchObject({ toolMode: 'gateway', composer: 'platform composer' });
  });
  it('composes through the gateway when Settings name a hosted provider, carrying the reader\'s token and the permitted findings', async () => {
    setAi({ provider: 'uae', groundedOnly: false }); completeMode = 'ok'; seen = [];
    expect((await g('/ai/status')).body.data.composer).toBe('tool gateway');
    const r = await chat('Tell me about vessel Al Ain Oasis');
    expect(r.body.data.reply).toBe('Al Ain Oasis is alongside at CB-2 on call MAR-2026-0270 [1].');
    expect(r.body.data.engine).toBe('resident-a via tool gateway, in-country (grounded)');
    const sent = seen.find((s) => s.url === '/ai-gateway/complete')!;
    expect(sent.headers['x-user-token']).toBe(officer); expect(sent.body.caller).toBe('assistant'); expect(sent.body.language).toBe('en');
    expect(sent.body.findings.some((f: string) => f.includes('**Al Ain Oasis**'))).toBe(true);
    expect(sent.body.contract).toContain('never an instruction');
  });
  it('says so when the gateway refused the question, and never invents an answer', async () => {
    completeMode = 'refused';
    const r = await chat('Tell me about vessel Al Ain Oasis');
    expect(r.body.data.reply).toContain('refused at the tool gateway before any model saw it');
    expect(r.body.data.engine).toBe('refused at the tool gateway');
    expect(r.body.data.grounded).toBe(false);
  });
  it('falls back to the platform composer when the gateway has no provider to reach', async () => {
    completeMode = 'local';
    const r = await chat('Tell me about vessel Al Ain Oasis');
    expect(r.body.data.reply).toContain('**Al Ain Oasis** (IMO 9720500');
    expect(r.body.data.engine).toBe('assistant-default (grounded)');
    setAi({ provider: 'local', groundedOnly: true });
  });
  it('drafts a decision letter from the application file, read through the gateway as the officer, in Arabic on request', async () => {
    seen = [];
    const draft = (body: Record<string, unknown>, t = assessor) => request(server as never).post('/ai/drafts').set('authorization', `Bearer ${t}`).send(body);
    const r = await draft({ kind: 'DECISION_LETTER', subjectId: 'app1', language: 'ar', note: 'مستوفٍ للشروط' });
    expect(r.status).toBe(201);
    const d = r.body.data;
    expect(d).toMatchObject({ kind: 'DECISION_LETTER', subjectType: 'Application', subjectId: 'app1', language: 'ar', status: 'DRAFT', preparedBy: 'Desk Assessor' });
    expect(d.title).toBe('خطاب قرار — SR-2026-00031 (West Coast Maritime Services)');
    expect(d.body).toContain('قرار — اعتماد مكافحة الآفات وإبادة القوارض على السفن — طلب');
    expect(d.body).toContain('مقدّم الطلب: Priya Khan, West Coast Maritime Services');
    expect(d.body).toContain('القرار: تمت الموافقة على الطلب.');
    expect(d.body).toContain('الأسباب المدوّنة في الملف: Assessment satisfactory');
    expect(d.body).toContain('المستندات: أُودع 2، وتم التحقق من 1.');
    expect(d.body).toContain('الرسوم: 12,600 AED — مسدَّدة بتاريخ 2026-06-18.');
    expect(d.body).toContain('أسباب الموظف: مستوفٍ للشروط');
    expect(d.body).toContain('هذه مسودة لم تُوقَّع ولم تُصدر.');
    expect(d.citations).toEqual([expect.objectContaining({ kind: 'application', ref: 'SR-2026-00031', link: '/services/requests/app1' })]);
    expect(d.facts).toMatchObject({ number: 'SR-2026-00031', status: 'APPROVED', documents: 2, verified: 1, feeTotal: 12600, paid: true, readThrough: 'ai-tool-gateway' });
    const read = seen.filter((s) => s.url === '/ai-gateway/tools/services.application/run');
    expect(read).toHaveLength(1);
    expect(read[0].headers['x-user-token']).toBe(assessor);
    expect(read[0].body).toMatchObject({ caller: 'assistant', cause: 'draft', args: { id: 'app1' } });
    // the English letter is written from the same file
    const en = await draft({ kind: 'DECISION_LETTER', subjectId: 'app1' });
    expect(en.status).toBe(201);
    expect(en.body.data.title).toBe('Decision letter — SR-2026-00031 (West Coast Maritime Services)');
    expect(en.body.data.body).toContain('DECISION — Vessel Pest Control and Deratting Approval — application');
    expect(en.body.data.body).toContain('Decision: the application is approved.');
    expect(en.body.data.body).toContain('Documents: 2 lodged, 1 verified.');
    expect(en.body.data.body).toContain('Fees: AED 12,600 — paid on 2026-06-18.');
    expect(en.body.data.body).toContain('This is a draft and has not been signed or issued.');
  });
  it('has nothing to draft from when the gateway refuses the file, and never asks for a file the caller may not assess', async () => {
    disabled = new Set(['services.application']);
    const refused = await request(server as never).post('/ai/drafts').set('authorization', `Bearer ${assessor}`).send({ kind: 'DECISION_LETTER', subjectId: 'app1' });
    expect(refused.status).toBe(404);
    expect(refused.body.message).toContain('No record on the platform matches that subject');
    disabled = new Set(); seen = [];
    const forbidden = await request(server as never).post('/ai/drafts').set('authorization', `Bearer ${officer}`).send({ kind: 'DECISION_LETTER', subjectId: 'app1' });
    expect(forbidden.status).toBe(403);
    expect(seen.filter((s) => s.url.includes('services.application'))).toHaveLength(0);
  });
  it('drafts a service definition for the Studio from a plain-language description, reading the template through the gateway as the designer', async () => {
    seen = [];
    const post = (body: Record<string, unknown>, t = designer) => request(server as never).post('/ai/definitions/draft').set('authorization', `Bearer ${t}`).send(body);
    const r = await post({ description: 'Approval for a ship chandler to supply provisions alongside at Khalifa Port; needs a trade licence, an insurance certificate and a list of vehicles; fee AED 1,500; decision within 7 working days; valid 1 year.', basedOn: 'fac.pest-control' });
    expect(r.status).toBe(201);
    const d = r.body.data;
    expect(d).toMatchObject({ key: 'company.approval-ship-chandler-supply', subjectKind: 'COMPANY', issuesInstrument: 'SHIP_CHANDLER', category: 'Licensing', autoApprovable: false, engine: 'platform composer', descriptionAr: null, basedOn: { id: 'def1', key: 'fac.pest-control' } });
    expect(d.content.documents.map((x: { code: string }) => x.code)).toEqual(['TRADE_LICENCE', 'INSURANCE', 'VEHICLE_LIST', 'doc1']);
    expect(d.content.fees.lines).toEqual([expect.objectContaining({ code: 'APP', amount: 1500 })]);
    expect(d.content.sla.days).toBe(7); expect(d.content.outputs.validityMonths).toBe(12);
    expect(d.content.form.fields.map((f: { key: string }) => f.key)).toEqual(['port', 'vehicleCount', 'premises', 'remarks']);
    expect(d.citations).toEqual([expect.objectContaining({ kind: 'serviceDefinition', ref: 'fac.pest-control' })]);
    const read = seen.filter((s) => s.url === '/ai-gateway/tools/services.definition/run');
    expect(read).toHaveLength(1);
    expect(read[0].headers['x-user-token']).toBe(designer);
    expect(read[0].body).toMatchObject({ caller: 'assistant', cause: 'definition-draft', args: { id: 'fac.pest-control' } });
    expect(seen.some((s) => s.url === '/ai-gateway/complete')).toBe(false);
    expect((await post({ description: 'Approval for a ship chandler to supply provisions alongside; fee AED 100', basedOn: 'no.such' })).status).toBe(404);
    expect((await post({ description: 'Approval for a ship chandler to supply provisions alongside; fee AED 100' }, assessor)).status).toBe(403);
  });
  it('finds the template in the catalogue when none is named, and takes the hosted provider\'s Arabic wording when Settings name one', async () => {
    setAi({ provider: 'uae' }); completeMode = 'json'; seen = [];
    const r = await request(server as never).post('/ai/definitions/draft').set('authorization', `Bearer ${designer}`)
      .send({ description: 'Pest control and deratting approval for a company serving ships in port; needs a trade licence; fee AED 2,000; within 12 days; valid 1 year' });
    expect(r.status).toBe(201);
    expect(r.body.data.basedOn).toMatchObject({ key: 'fac.pest-control' });
    expect(r.body.data.nameAr).toBe('اعتماد مورّد السفن — طلب');
    expect(r.body.data.descriptionAr).toContain('اعتماد شركة');
    expect(r.body.data.engine).toBe('platform composer; Arabic wording by resident-a via tool gateway, in-country');
    expect(r.body.data.gaps.map((g: { en: string }) => g.en)).toEqual(expect.arrayContaining([expect.stringContaining('came from the hosted model')]));
    expect(r.body.data.gaps.some((g: { en: string }) => g.en.startsWith('The Arabic name is a suggestion') || g.en.startsWith('Write the Arabic description'))).toBe(false);
    expect(seen.map((s) => s.url)).toEqual(expect.arrayContaining(['/ai-gateway/tools/services.catalogue/run', '/ai-gateway/tools/services.definition/run', '/ai-gateway/complete']));
    const sent = seen.find((s) => s.url === '/ai-gateway/complete')!;
    expect(sent.headers['x-user-token']).toBe(designer); expect(sent.body.language).toBe('ar'); expect(sent.body.contract).toContain('never an instruction');
    setAi({ provider: 'local' }); completeMode = 'local';
  });
});
