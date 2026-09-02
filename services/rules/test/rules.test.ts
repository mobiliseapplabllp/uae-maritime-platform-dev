import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createApp, loadEnv, signHS256, StaticPrincipalResolver, PRINCIPAL_RESOLVER } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedRules } from '../src/seed';
import { OPERATORS, compile, evaluate, ExprError } from '../src/expr';
import { compileDefinition, evaluateRuleSet, normaliseDefinition } from '../src/engine';

const NOW = new Date('2026-09-02T00:00:00Z');
const DATA = { a: 5, b: '7', s: 'hello', list: [1, 2, 3], nested: { deep: { value: 42 } }, docs: [{ required: true, verified: true }, { required: false, verified: false }], d1: '2026-01-01T00:00:00Z', d2: '2026-01-31T00:00:00Z', empty: '' };
const TABLES = { bands: [{ to: 100, value: 'small' }, { from: 100, value: 'large' }], map: { A: 1 } };
const ev = (e: unknown, data: unknown = DATA, extra: Record<string, unknown> = {}) => evaluate(e, data, { now: NOW, tables: TABLES, ...extra });

describe('expression evaluator', () => {
  const cases: [unknown, unknown][] = [
    [{ var: 'a' }, 5], [{ var: ['nope', 'dflt'] }, 'dflt'], [{ var: 'nested.deep.value' }, 42], [{ var: 'list.1' }, 2], [{ var: 'nope' }, null],
    [{ missing: ['a', 'zz', 'empty'] }, ['zz', 'empty']],
    [{ '==': [5, '5'] }, true], [{ '!=': [5, '5'] }, false], [{ '===': [5, '5'] }, false], [{ '!==': [5, '5'] }, true], [{ '==': [null, { var: 'nope' }] }, true],
    [{ '>': [{ var: 'b' }, { var: 'a' }] }, true], [{ '>=': [5, 5] }, true], [{ '<': [1, 3, 2] }, false], [{ '<=': [1, 2, 2] }, true], [{ '>': [{ var: 'nope' }, 1] }, false],
    [{ and: [true, 0, 'never'] }, 0], [{ and: [1, 'x'] }, 'x'], [{ or: [0, 'x'] }, 'x'], [{ or: [0, false] }, false], [{ '!': { var: 'a' } }, false], [{ '!!': [0] }, false], [{ '!!': [[]] }, false],
    [{ in: [2, { var: 'list' }] }, true], [{ in: ['ell', 'hello'] }, true], [{ in: [9, { var: 'list' }] }, false],
    [{ if: [false, 'a', true, 'b', 'c'] }, 'b'], [{ if: [false, 'a', 'c'] }, 'c'],
    [{ '+': [1, '2', 3] }, 6], [{ '+': [{ var: 'nope' }, 1] }, 1], [{ '-': [10, 4] }, 6], [{ '-': [5] }, -5], [{ '*': [2, 3, 4] }, 24], [{ '/': [9, 3] }, 3], [{ '%': [7, 4] }, 3],
    [{ min: [3, 1, 2] }, 1], [{ max: [{ var: 'list' }] }, 3], [{ round: [2.345, 2] }, 2.35], [{ round: [10.5] }, 11], [{ floor: [2.7] }, 2], [{ ceil: [2.1] }, 3], [{ abs: [-3] }, 3],
    [{ cat: ['a', 1, { var: 's' }] }, 'a1hello'], [{ upper: ['ab'] }, 'AB'], [{ lower: ['AB'] }, 'ab'],
    [{ daysBetween: [{ var: 'd1' }, { var: 'd2' }] }, 30], [{ now: [] }, NOW.toISOString()], [{ year: [{ var: 'd1' }] }, 2026],
    [{ some: [{ var: 'docs' }, { var: 'verified' }] }, true], [{ all: [{ var: 'docs' }, { var: 'verified' }] }, false], [{ all: [[], true] }, false], [{ none: [{ var: 'docs' }, { '==': [{ var: 'required' }, 'x'] }] }, true], [{ some: [{ var: 'nope' }, true] }, false],
    [{ sum: [{ var: 'list' }] }, 6], [{ sum: [{ var: 'docs' }, { if: [{ var: 'required' }, 2, 0] }] }, 2], [{ count: [{ var: 'docs' }, { var: 'verified' }] }, 1], [{ count: [{ var: 'list' }] }, 3],
    [{ lookup: ['bands', 150] }, 'large'], [{ lookup: ['bands', 5] }, 'small'], [{ lookup: ['map', 'A'] }, 1], [{ lookup: ['map', 'Z', 'none'] }, 'none'], [{ lookup: ['map', 'Z'] }, null],
    ['literal', 'literal'], [{ a: 1, b: 2 }, { a: 1, b: 2 }], [[1, { var: 'a' }], [1, 5]],
  ];
  it.each(cases)('%j evaluates to %j', (expr, expected) => { expect(ev(expr)).toEqual(expected); });
  it('exercises every operator of the language', () => {
    const used = new Set<string>();
    const walk = (n: unknown) => { if (Array.isArray(n)) n.forEach(walk); else if (n && typeof n === 'object') { const k = Object.keys(n as object); if (k.length === 1) used.add(k[0]); Object.values(n as object).forEach(walk); } };
    cases.forEach(([e]) => walk(e));
    for (const op of OPERATORS) expect(used.has(op), `operator ${op} untested`).toBe(true);
  });
  it('nests arbitrarily and stays deterministic', () => {
    const expr = { if: [{ and: [{ '>=': [{ var: 'a' }, 5] }, { in: [{ var: 's' }, ['hello', 'world']] }] }, { round: [{ '*': [{ '+': [{ var: 'a' }, { var: 'b' }] }, { lookup: ['map', 'A'] }, 1.5] }, 1] }, 0] };
    expect(ev(expr)).toBe(18); expect(ev(expr)).toBe(18);
    expect(ev({ cat: [{ now: [] }] }, {}, { now: new Date('2020-02-02T00:00:00Z') })).toBe('2020-02-02T00:00:00.000Z');
  });
  it('rejects unknown operators, type errors and division by zero', () => {
    expect(() => ev({ nope: [1] })).toThrow(ExprError);
    expect(() => ev({ '/': [1, 0] })).toThrow(/Division by zero/);
    expect(() => ev({ '+': [1, 'abc'] })).toThrow(/not a number/);
    expect(() => ev({ daysBetween: ['x', 'y'] })).toThrow(/not a date/);
    expect(() => ev({ lookup: ['unknown', 1] })).toThrow(/Unknown table/);
  });
  it('guards depth and node budget', () => {
    let deep: unknown = 1; for (let i = 0; i < 100; i++) deep = { '+': [1, deep] };
    expect(() => ev(deep)).toThrow(/too deep/);
    expect(() => ev({ '+': [1, { '+': [1, 1] }] }, {}, { maxDepth: 1 })).toThrow(/too deep/);
    expect(() => ev({ '+': [1, 2] }, {}, { maxNodes: 2 })).toThrow(/budget/);
    expect(ev({ '+': [1, 2] }, {}, { maxDepth: 3, maxNodes: 10 })).toBe(3);
  });
  it('compiles statically: operators, arities, tables and depth', () => {
    expect(compile({ and: [{ '>': [{ var: 'a' }, 1] }, { lookup: ['map', 'A'] }] }, { tables: TABLES })).toMatchObject({ ok: true, errors: [], depth: expect.any(Number) });
    const bad = compile({ and: [{ nope: [1] }, { '/': [1] }, { lookup: ['zz', 1] }] }, { tables: TABLES });
    expect(bad.ok).toBe(false); expect(bad.errors.join(' ')).toMatch(/unknown operator "nope"/); expect(bad.errors.join(' ')).toMatch(/"\/" expects 2/); expect(bad.errors.join(' ')).toMatch(/unknown table "zz"/);
    let deep: unknown = 1; for (let i = 0; i < 40; i++) deep = { '!': deep };
    expect(compile(deep, { maxDepth: 10 }).ok).toBe(false);
  });
});

describe('rule set engine', () => {
  it('computes fee lines with conditions, quantities, rates and exact minor-unit totals', () => {
    const def = normaliseDefinition('FEE', [{ code: 'A', description: 'a', amount: 0.1 }, { code: 'B', description: 'b', amount: 0.2 }, { code: 'C', description: 'c', amount: 5, taxable: false }, { code: 'D', description: 'd', amount: 9, when: false }, { code: 'E', description: 'e', qty: 3, rate: { var: 'params.rate' } }, { code: 'F', description: 'f', qty: 0, rate: 4 }]);
    expect(compileDefinition('FEE', def, { rate: 2.5 })).toEqual([]);
    const r = evaluateRuleSet('FEE', def, { rate: 2.5, currency: 'AED' }, {}, { now: NOW });
    expect(r.kind).toBe('FEE'); if (r.kind !== 'FEE') return;
    expect(r.lines.map((l) => l.code)).toEqual(['A', 'B', 'C', 'E']); expect(r.lines[3]).toMatchObject({ qty: 3, rate: 2.5, amount: 7.5, taxable: true });
    expect(r.subtotal).toBe(12.8); expect(r.taxableSubtotal).toBe(7.8); expect(r.currency).toBe('AED');
    expect(compileDefinition('FEE', normaliseDefinition('FEE', [{ code: 'X', description: 'x' }]), {})).toEqual(['lines[0]: needs an amount or a rate']);
  });
  it('runs checks with severities and SLA clocks', () => {
    const checks = normaliseDefinition('ELIGIBILITY', [{ code: 'TOO_SMALL', message: 'too small', when: { '<': [{ var: 'grt' }, 500] } }, { code: 'OLD', message: 'old', severity: 'WARN', when: { '>': [{ var: 'age' }, 25] } }]);
    const fail = evaluateRuleSet('ELIGIBILITY', checks, {}, { grt: 100, age: 30 }, { now: NOW });
    expect(fail).toMatchObject({ kind: 'ELIGIBILITY', passed: false, failed: ['TOO_SMALL'], warnings: ['OLD'] });
    const warnOnly = evaluateRuleSet('ELIGIBILITY', checks, {}, { grt: 900, age: 30 }, { now: NOW });
    expect(warnOnly).toMatchObject({ passed: true, failed: [], warnings: ['OLD'] }); if (warnOnly.kind === 'ELIGIBILITY') expect(warnOnly.results.find((x) => x.code === 'OLD')?.failed).toBe(true);
    expect(evaluateRuleSet('SLA', normaliseDefinition('SLA', 2.2), {}, {}, { now: NOW })).toEqual({ kind: 'SLA', days: 3 });
    expect(evaluateRuleSet('SLA', normaliseDefinition('SLA', { days: { if: [{ var: 'request.expedited' }, 3, 10] } }), {}, { request: { expedited: true } }, { now: NOW })).toEqual({ kind: 'SLA', days: 3 });
    expect(() => normaliseDefinition('FEE', { lines: [] })).toThrow();
  });
});

const DB = 'maritime_rules_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let seeded: Awaited<ReturnType<typeof seedRules>>;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const manager = tok('manager'); const viewer = tok('viewer');
const SVC = { 'x-service-token': 'development-service-token' };
const api = () => request(server as never);
const post = (p: string, body: unknown, t = manager) => api().post(p).set('authorization', t).send(body as object);
const put = (p: string, body: unknown, t = manager) => api().put(p).set('authorization', t).send(body as object);
const get = (p: string, t = viewer) => api().get(p).set('authorization', t);

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  seeded = await seedRules(URL, 'AE');
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET } as never);
  const principal = (id: string, perms: string[]) => ({ id, sub: id, name: id, email: `${id}@maritime.example`, perms, scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true });
  const resolver = new StaticPrincipalResolver({ admin: principal('admin', ['*']), manager: principal('manager', ['services.view', 'services.manage']), viewer: principal('viewer', ['services.view']), nobody: principal('nobody', ['dashboard.view']) });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer();
});
afterAll(async () => { await app?.close(); });

describe('rules API', () => {
  it('seeds the world rule sets as published v1 and lists them by kind', async () => {
    expect(seeded.total).toBe(78); expect(seeded.versions).toBe(78); expect(seeded.byKind).toEqual({ ELIGIBILITY: 2, FEE: 74, SLA: 1, VALIDATION: 1 });
    const again = await seedRules(URL, 'AE'); expect(again.versions).toBe(0); expect(again.unchanged).toBe(78);
    const fee = await get('/rules?kind=fee&limit=5&sort=key'); expect(fee.status).toBe(200); expect(fee.body.meta.total).toBe(74); expect(fee.body.data).toHaveLength(5); expect(fee.body.data[0]).toMatchObject({ kind: 'FEE', publishedVersion: 1, latestVersion: 1, draftVersion: null });
    const q = await get('/rules?q=registration'); expect(q.body.data.some((s: { key: string }) => s.key === 'eligibility.registration')).toBe(true);
    const one = await get('/rules/fees.port-call'); expect(one.body.data.published.status).toBe('PUBLISHED'); expect(one.body.data.published.definition.lines).toHaveLength(11); expect(one.body.data.versions).toHaveLength(1);
    expect((await get('/rules/does.not.exist')).status).toBe(404);
    expect((await api().get('/rules')).status).toBe(401); expect((await get('/rules', tok('nobody'))).status).toBe(403);
  });
  it('evaluates the port-call fee schedule exactly as the reference invoice maths', async () => {
    const context = { vessel: { grt: 30000, loa: 280 }, call: { movements: 2, stayDays: 3, waitedHours: 30 }, services: { freshWaterMt: 100, garbage: true },
      cargoOps: [{ unit: 'TEU', qty: 1200, cargoType: 'CONTAINERS' }, { unit: 'MT', qty: 5000, cargoType: 'CRUDE' }, { unit: 'MT', qty: 2000, cargoType: 'COAL' }, { unit: 'UNITS', qty: 50, cargoType: 'CARS' }] };
    const r = await post('/rules/evaluate', { key: 'fees.port-call', context }, viewer);
    expect(r.status).toBe(201); expect(r.body.data).toMatchObject({ key: 'fees.port-call', version: 1, kind: 'FEE', currency: 'AED' });
    const by = Object.fromEntries(r.body.data.lines.map((l: { code: string; amount: number; qty: number }) => [l.code, l]));
    expect(by.PD).toMatchObject({ qty: 30000, rate: 0.6, amount: 18000 }); expect(by.PIL.amount).toBe(7600); expect(by.TUG).toMatchObject({ qty: 6, amount: 16800 }); expect(by.BH).toMatchObject({ qty: 90000, amount: 18000 });
    expect(by.ANC).toMatchObject({ qty: 2, amount: 2200 }); expect(by.WTR.amount).toBe(1200); expect(by.GBG.amount).toBe(800);
    expect(by.WFC.amount).toBe(50400); expect(by.WFL.amount).toBe(21500); expect(by.WFB.amount).toBe(10400); expect(by.WFR.amount).toBe(3250);
    expect(r.body.data.subtotal).toBe(150150);
    const quick = await post('/rules/evaluate', { key: 'fees.port-call', context: { vessel: { grt: 1000, loa: 90 }, call: { movements: 2, stayDays: 1, waitedHours: 2 } } }, viewer);
    expect(quick.body.data.lines.map((l: { code: string }) => l.code)).toEqual(['PD', 'PIL', 'TUG', 'BH']); expect(quick.body.data.subtotal).toBe(600 + 7600 + 11200 + 200);
    const svc = await post('/rules/evaluate', { key: 'fee.reg.provisional' }, viewer); expect(svc.body.data.subtotal).toBe(1500); expect(svc.body.data.lines.map((l: { code: string }) => l.code)).toEqual(['APP', 'ISS']);
  });
  it('evaluates eligibility, validation and SLA sets', async () => {
    const foreign = await post('/rules/evaluate', { key: 'eligibility.registration', context: { subject: { ownerNationality: 'Panama', grt: 12000, built: 2015, classSociety: 'DNV' } } }, viewer);
    expect(foreign.body.data).toMatchObject({ kind: 'ELIGIBILITY', passed: false, failed: ['OWNER_NATIONALITY'] });
    expect(foreign.body.data.results.find((x: { code: string }) => x.code === 'OWNER_NATIONALITY').message).toMatch(/nationality/i);
    const ok = await post('/rules/evaluate', { key: 'eligibility.registration', context: { subject: { ownerNationality: 'United Arab Emirates', grt: 12000, built: 1995, classSociety: 'DNV' } }, now: NOW.toISOString() }, viewer);
    expect(ok.body.data).toMatchObject({ passed: true, failed: [], warnings: ['VESSEL_AGE'] });
    const coc = await post('/rules/evaluate', { key: 'eligibility.coc', context: { form: { grade: 'Master', seaServiceMonths: 40 }, subject: { medicalExpiry: '2027-06-01T00:00:00Z', dob: '1985-01-01T00:00:00Z' } }, now: NOW.toISOString() }, viewer);
    expect(coc.body.data).toMatchObject({ passed: true, failed: [], warnings: [] });
    const short = await post('/rules/evaluate', { key: 'eligibility.coc', context: { form: { grade: 'Master', seaServiceMonths: 20 }, subject: {} }, now: NOW.toISOString() }, viewer);
    expect(short.body.data.failed).toEqual(['SEA_SERVICE', 'MEDICAL_VALID']);
    const docs = await post('/rules/evaluate', { key: 'validation.documents', context: { documents: [{ code: 'doc1', required: true, verified: false }] } }, viewer); expect(docs.body.data.passed).toBe(false);
    const sla = await post('/rules/evaluate', { key: 'sla.standard', context: { definition: { slaDays: 21 }, request: { expedited: true } } }, viewer); expect(sla.body.data).toMatchObject({ kind: 'SLA', days: 11 });
    expect((await post('/rules/evaluate', { key: 'sla.standard', context: { definition: { slaDays: 'abc' } } }, viewer)).status).toBe(400);
  });
  it('enforces the draft → published → retired lifecycle with one live version', async () => {
    expect((await post('/rules', { key: 'test.fee', name: 'Test fee', kind: 'FEE' }, viewer)).status).toBe(403);
    expect((await api().post('/rules').send({ key: 'test.fee', name: 'Test fee', kind: 'FEE' })).status).toBe(401);
    const created = await post('/rules', { key: 'test.fee', name: 'Test fee', nameAr: 'رسم اختبار', kind: 'FEE', definition: [{ code: 'A', description: 'Line A', amount: 100 }], parameters: { currency: 'AED' } });
    expect(created.status).toBe(201); expect(created.body.data).toMatchObject({ key: 'test.fee', draftVersion: 1, publishedVersion: null }); expect(created.body.data.versions[0].status).toBe('DRAFT');
    expect((await post('/rules', { key: 'test.fee', name: 'Dup', kind: 'FEE' })).status).toBe(409);
    expect((await post('/rules', { key: 'Bad Key', name: 'Bad', kind: 'FEE' })).status).toBe(400);
    expect((await post('/rules', { key: 'bad.expr', name: 'Bad', kind: 'FEE', definition: [{ code: 'A', description: 'a', amount: { nope: [1] } }] })).status).toBe(400);
    const edited = await put('/rules/test.fee/versions/1', { definition: [{ code: 'A', description: 'Line A', amount: 150 }], changeNote: 'raise' });
    expect(edited.status).toBe(200); expect(edited.body.data.definition.lines[0].amount).toBe(150);
    expect((await put('/rules/test.fee/versions/1', { definition: [{ code: 'B', description: 'x', amount: { nope: [1] } }] })).status).toBe(400);
    const dry = await post('/rules/test.fee/versions/1/test', { context: {} }, viewer); expect(dry.status).toBe(201); expect(dry.body.data.ok).toBe(true); expect(dry.body.data.result.subtotal).toBe(150);
    expect((await post('/rules/evaluate', { key: 'test.fee' }, viewer)).status).toBe(404);
    const published = await post('/rules/test.fee/versions/1/publish', { note: 'go live' }); expect(published.status).toBe(201); expect(published.body.data).toMatchObject({ status: 'PUBLISHED', retired: [] });
    expect((await post('/rules/test.fee/versions/1/publish', {})).status).toBe(409);
    expect((await put('/rules/test.fee/versions/1', { changeNote: 'late' })).status).toBe(409);
    expect((await post('/rules/evaluate', { key: 'test.fee' }, viewer)).body.data.subtotal).toBe(150);
    const v2 = await post('/rules/test.fee/versions', { changeNote: 'second' }); expect(v2.status).toBe(201); expect(v2.body.data).toMatchObject({ version: 2, status: 'DRAFT' }); expect(v2.body.data.definition.lines[0].amount).toBe(150);
    expect((await post('/rules/test.fee/versions', {})).status).toBe(409);
    expect((await put('/rules/test.fee/versions/2', { definition: [] })).body.data.definition).toEqual({ lines: [] });
    expect((await post('/rules/test.fee/versions/2/publish', {})).status).toBe(400);
    await put('/rules/test.fee/versions/2', { definition: [{ code: 'A', description: 'Line A', amount: 200 }, { code: 'B', description: 'Line B', qty: { var: 'units' }, rate: 5 }] });
    const pub2 = await post('/rules/test.fee/versions/2/publish', {}); expect(pub2.body.data).toMatchObject({ status: 'PUBLISHED', retired: [1] });
    const set = await get('/rules/test.fee'); expect(set.body.data).toMatchObject({ publishedVersion: 2, latestVersion: 2, draftVersion: null }); expect(set.body.data.versions.map((x: { status: string }) => x.status)).toEqual(['RETIRED', 'PUBLISHED']);
    expect((await post('/rules/evaluate', { key: 'test.fee', context: { units: 4 } }, viewer)).body.data.subtotal).toBe(220);
    expect((await post('/rules/evaluate', { key: 'test.fee', version: 1 }, viewer)).body.data).toMatchObject({ version: 1, status: 'RETIRED', subtotal: 150 });
    const hist = await get('/rules/test.fee/history'); expect(hist.body.data.map((h: { action: string }) => h.action)).toEqual(expect.arrayContaining(['CREATE', 'EDIT', 'PUBLISH', 'DRAFT', 'RETIRE'])); expect(hist.body.data[0].actor.id).toBe('manager');
    const pool = new Pool({ connectionString: URL });
    const events = await pool.query<{ subject: string; payload: { data: Record<string, unknown> } }>("SELECT subject, payload FROM outbox WHERE payload->>'subject' = 'RuleSet:test.fee' ORDER BY id");
    const audits = await pool.query<{ n: string }>("SELECT count(*) AS n FROM outbox WHERE subject = 'maritime.audit.recorded' AND payload->'data'->>'entityLabel' LIKE 'test.fee%'");
    await pool.end();
    const subjects = events.rows.map((e) => e.subject);
    expect(subjects).toContain('maritime.rules.ruleset.published'); expect(subjects).toContain('maritime.rules.ruleset.retired'); expect(subjects).toContain('maritime.readmodel.upserted'); expect(Number(audits.rows[0].n)).toBeGreaterThanOrEqual(5);
    const pubEvent = events.rows.filter((e) => e.subject === 'maritime.rules.ruleset.published').pop()!.payload.data;
    expect(pubEvent).toMatchObject({ key: 'test.fee', version: 2, retired: [1] }); expect((pubEvent.definition as { lines: unknown[] }).lines).toHaveLength(2);
  });
  it('serves service-to-service evaluation with the service token only', async () => {
    const byKey = await api().post('/internal/rules/evaluate').set(SVC).send({ key: 'fee.vessel.nav.lic' }); expect(byKey.status).toBe(201); expect(byKey.body.data.subtotal).toBe(2500);
    const expr = await api().post('/internal/rules/evaluate').set(SVC).send({ expr: { '>': [{ var: 'form.units' }, 3] }, context: { form: { units: 4 } } }); expect(expr.body.data).toEqual({ value: true });
    expect((await api().post('/internal/rules/evaluate').set(SVC).send({ context: {} })).status).toBe(400);
    expect((await api().post('/internal/rules/evaluate').send({ key: 'fee.vessel.nav.lic' })).status).toBe(401);
    expect((await api().post('/internal/rules/evaluate').set('authorization', admin).send({ key: 'fee.vessel.nav.lic' })).status).toBe(401);
    expect((await post('/rules/compile', { expr: { and: [{ nope: 1 }] } }, viewer)).body.data.ok).toBe(false);
  });
});
