import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { EVENTS, subjectFor } from '@maritime/contracts';
import { PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256 } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedAiPlatform } from '../src/seed';
import { applyBins, compare, psi, summarise, verdictFor } from '../src/drift';
import { StubProvider, percentiles, serve } from '../src/serving';

const DB = 'maritime_ai_platform_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const scientist = tok('scientist'); const assurance = tok('assurance'); const viewer = tok('viewer'); const officer = tok('officer');
const g = (p: string, t = admin) => request(server as never).get(p).set('authorization', t);
const post = (p: string, body?: unknown, t = admin) => request(server as never).post(p).set('authorization', t).send((body ?? {}) as never);
const outbox = async (type: string) => (await pool.query('SELECT payload FROM outbox WHERE subject = $1 ORDER BY id', [subjectFor(type)])).rows.map((r) => r.payload as { type: string; data: Record<string, unknown> });

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedAiPlatform(URL);
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, MDM_URL: 'http://127.0.0.1:1', ALLOWED_PROD_RESIDENCY: 'AE' } as never);
  const base = { scope: { level: 'NATIONAL' as const }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    admin: { ...base, id: 'admin', sub: 'admin', name: 'Platform Administrator', perms: ['*'] },
    scientist: { ...base, id: 'scientist', sub: 'scientist', name: 'Data Scientist', perms: ['models.view', 'models.manage'] },
    assurance: { ...base, id: 'assurance', sub: 'assurance', name: 'Model Assurance', perms: ['models.view', 'models.manage', 'models.deploy'] },
    viewer: { ...base, id: 'viewer', sub: 'viewer', name: 'Compliance Analyst', perms: ['models.view'] },
    officer: { ...base, id: 'officer', sub: 'officer', name: 'Duty Officer', perms: ['ai.use'] },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer(); pool = new Pool({ connectionString: URL });
});
afterAll(async () => { await app?.close(); await pool?.end(); });

describe('the registry', () => {
  it('lists the seeded models with what is serving in each environment', async () => {
    const r = await g('/ai-platform/models');
    expect(r.status).toBe(200);
    const keys = r.body.data.map((m: { key: string }) => m.key).sort();
    expect(keys).toEqual(['document-extraction', 'eta-prediction', 'inspection-targeting', 'speech-transcription']);
    const targeting = r.body.data.find((m: { key: string }) => m.key === 'inspection-targeting');
    expect(targeting.serving.PROD).toBe(targeting.currentVersion);
    expect(targeting.residency.region).toBe('AE');
  });

  it('carries a model through draft, validation, approval and deployment', async () => {
    const created = await post('/ai-platform/models', {
      key: 'berth-ranking', name: 'Berth allocation ranking', task: 'RANKING',
      purpose: 'Ranks candidate berths for an expected arrival.', owner: 'Harbour Operations', residencyRegion: 'AE',
    }, scientist);
    expect(created.status).toBe(201);
    const v = await post('/ai-platform/models/berth-ranking/versions', { artifactRef: 'registry://berth-ranking/1', metrics: { ndcg: 0.71 }, changeNote: 'First fit' }, scientist);
    expect(v.body.data.version).toBe(1);
    expect(v.body.data.status).toBe('DRAFT');

    // Deployment before approval is refused: the registry is the record of what was allowed to serve.
    expect((await post('/ai-platform/models/berth-ranking/versions/1/deploy', { environment: 'UAT' }, assurance)).status).toBe(409);

    expect((await post('/ai-platform/models/berth-ranking/versions/1/validate', {}, scientist)).body.data.status).toBe('VALIDATED');
    const deployed = await post('/ai-platform/models/berth-ranking/versions/1/approve', {}, assurance);
    expect(deployed.body.data.status).toBe('APPROVED');
    expect(deployed.body.data.approvedBy).toBe('Model Assurance');

    const d = await post('/ai-platform/models/berth-ranking/versions/1/deploy', { environment: 'UAT', endpoint: 'https://serving.internal/berth-ranking' }, assurance);
    expect(d.status).toBe(201);
    expect(d.body.data.environment).toBe('UAT');
    expect((await g('/ai-platform/models/berth-ranking')).body.data.versions[0].status).toBe('DEPLOYED');
  });

  it('refuses an approval by the person who created the version', async () => {
    await post('/ai-platform/models', { key: 'self-approve', name: 'Self approval probe', task: 'CLASSIFICATION' }, scientist);
    await post('/ai-platform/models/self-approve/versions', { changeNote: 'v1' }, scientist);
    await post('/ai-platform/models/self-approve/versions/1/validate', {}, scientist);
    const r = await post('/ai-platform/models/self-approve/versions/1/approve', {}, scientist);
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/other than the person who created it/i);
  });

  it('keeps one live deployment per environment and supersedes the rest', async () => {
    await post('/ai-platform/models/berth-ranking/versions', { changeNote: 'Second fit' }, scientist);
    await post('/ai-platform/models/berth-ranking/versions/2/validate', {}, scientist);
    await post('/ai-platform/models/berth-ranking/versions/2/approve', {}, assurance);
    await post('/ai-platform/models/berth-ranking/versions/2/deploy', { environment: 'UAT' }, assurance);
    const list = (await g('/ai-platform/models/berth-ranking/deployments')).body.data as { environment: string; status: string; version: number }[];
    const activeUat = list.filter((d) => d.environment === 'UAT' && d.status === 'ACTIVE');
    expect(activeUat).toHaveLength(1);
    expect(activeUat[0].version).toBe(2);
    expect(list.some((d) => d.status === 'SUPERSEDED' && d.version === 1)).toBe(true);
  });

  /*
   * Residency is the commitment that is easiest to make and hardest to keep, because nothing in a normal
   * deployment pipeline checks it. Here it is a refusal, so a model served outside the permitted region
   * cannot reach production however the pipeline is driven.
   */
  it('refuses a production deployment for a model that runs outside the permitted region', async () => {
    await post('/ai-platform/models', { key: 'offshore-model', name: 'Hosted elsewhere', task: 'CLASSIFICATION', residencyRegion: 'IE', residencyNote: 'Vendor-hosted endpoint' }, scientist);
    await post('/ai-platform/models/offshore-model/versions', { changeNote: 'v1' }, scientist);
    await post('/ai-platform/models/offshore-model/versions/1/validate', {}, scientist);
    await post('/ai-platform/models/offshore-model/versions/1/approve', {}, assurance);
    const prod = await post('/ai-platform/models/offshore-model/versions/1/deploy', { environment: 'PROD' }, assurance);
    expect(prod.status).toBe(400);
    expect(prod.body.message).toMatch(/production accepts only AE/i);
    // The same version is fine in a test environment: the restriction is about serving the public.
    expect((await post('/ai-platform/models/offshore-model/versions/1/deploy', { environment: 'UAT' }, assurance)).status).toBe(201);
  });

  it('keeps a failed training run rather than discarding it', async () => {
    const run = await post('/ai-platform/models/berth-ranking/training-runs', { datasetRef: 'datasets://berth/3', datasetRows: 9000 }, scientist);
    const done = await post(`/ai-platform/models/berth-ranking/training-runs/${run.body.data.id}/finish`, { status: 'FAILED', metrics: { ndcg: 0.42 }, note: 'Worse than v2; not promoted' }, scientist);
    expect(done.body.data.status).toBe('FAILED');
    expect((await g('/ai-platform/models/berth-ranking/training-runs')).body.data.some((r: { status: string }) => r.status === 'FAILED')).toBe(true);
  });

  it('separates reading the registry from changing it and from deploying', async () => {
    expect((await g('/ai-platform/models', viewer)).status).toBe(200);
    expect((await post('/ai-platform/models', { key: 'nope', name: 'Nope', task: 'CLASSIFICATION' }, viewer)).status).toBe(403);
    expect((await post('/ai-platform/models/berth-ranking/versions/2/deploy', { environment: 'DEV' }, scientist)).status).toBe(403);
    expect((await g('/ai-platform/models', officer)).status).toBe(403);
  });

  it('publishes the registry lifecycle as events', async () => {
    const registered = await outbox(EVENTS.ai.modelRegistered);
    const deployed = await outbox(EVENTS.ai.modelDeployed);
    expect(registered.some((e) => e.data.key === 'berth-ranking')).toBe(true);
    expect(deployed.some((e) => e.data.key === 'berth-ranking' && e.data.environment === 'UAT')).toBe(true);
  });
});

describe('serving', () => {
  it('answers from the deployment and reports the latency against the budget', async () => {
    const r = await post('/ai-platform/infer/inspection-targeting', {
      features: { shipAgeYears: 22, daysSinceLastInspection: 410, priorDeficiencies: 9, priorDetentions: 1, shipType: 'BULK_CARRIER', flag: 'PA' },
      subject: 'IMO9123456',
    }, officer);
    expect(r.status).toBe(201);
    expect(r.body.data.environment).toBe('PROD');
    expect(r.body.data.residency).toBe('AE');
    expect(r.body.data.withinSla).toBe(true);
    expect(r.body.data.budgetMs).toBe(5000);
    expect(r.body.data.output.label).toBe('HIGH');
  });

  it('moves with the evidence rather than answering at random', async () => {
    const clean = await post('/ai-platform/infer/inspection-targeting', {
      features: { shipAgeYears: 3, daysSinceLastInspection: 30, priorDeficiencies: 0, priorDetentions: 0, shipType: 'CONTAINER', flag: 'AE' },
    }, officer);
    expect(clean.body.data.output.score).toBeLessThan(0.4);
  });

  it('refuses a model with no deployment, and keeps the refusal on the record', async () => {
    await post('/ai-platform/models', { key: 'undeployed', name: 'Not deployed', task: 'CLASSIFICATION' }, scientist);
    const r = await post('/ai-platform/infer/undeployed', { features: { x: 1 } }, officer);
    expect(r.status).toBe(409);
    const rows = await pool.query(`SELECT status FROM inferences WHERE model_key = 'undeployed'`);
    expect(rows.rows[0].status).toBe('REFUSED');
  });

  it('extracts document fields and is honest about the ones it could not read', async () => {
    const r = await post('/ai-platform/vision/extract', {
      documentRef: 'documents://scan/4471', pages: 2,
      fields: ['certificateType', 'certificateNo', 'issuedDate'],
      hints: { certificateType: 'IOPP Certificate', certificateNo: 'IOPP-2026-0442' },
    }, officer);
    expect(r.status).toBe(201);
    expect(r.body.data.fields.certificateNo.value).toBe('IOPP-2026-0442');
    expect(r.body.data.fields.certificateNo.confidence).toBeGreaterThan(0.8);
    // Nothing was supplied for the issue date, so it is returned with low confidence rather than invented
    // at high confidence — the difference between a field to confirm and a field to check.
    expect(r.body.data.fields.issuedDate.confidence).toBeLessThan(0.5);
  });

  it('transcribes a recording and counts what it heard', async () => {
    const r = await post('/ai-platform/speech/transcribe', {
      audioRef: 'documents://audio/2210', durationSec: 48, language: 'en',
      transcriptHint: 'Port control this is Falcon Trader requesting permission to shift to berth CT1-3',
    }, officer);
    expect(r.body.data.words).toBe(13);
    expect(r.body.data.language).toBe('en');
    expect(r.body.data.confidence).toBeGreaterThan(0.7);
  });

  it('reports latency as percentiles, not as an average', async () => {
    const r = await g('/ai-platform/serving/stats?days=365', viewer);
    expect(r.status).toBe(200);
    expect(r.body.data.calls).toBeGreaterThan(1000);
    expect(r.body.data.budgetMs).toBe(5000);
    expect(r.body.data.latencyMs.p95).toBeGreaterThanOrEqual(r.body.data.latencyMs.p50);
    expect(r.body.data.latencyMs.p99).toBeGreaterThanOrEqual(r.body.data.latencyMs.p95);
    expect(r.body.data.models.length).toBeGreaterThanOrEqual(4);
  });
});

describe('drift', () => {
  it('finds the feature that moved and leaves the ones that did not', async () => {
    const r = await post('/ai-platform/drift/inspection-targeting/run', { days: 200 }, assurance);
    expect(r.status).toBe(201);
    expect(r.body.data.verdict).toBe('SIGNIFICANT');
    const worst = r.body.data.results[0];
    expect(worst.feature).toBe('shipAgeYears');
    expect(worst.psi).toBeGreaterThan(0.25);
    const shipType = r.body.data.results.find((f: { feature: string }) => f.feature === 'shipType');
    expect(shipType.verdict).toBe('STABLE');
  });

  it('publishes a significant reading rather than only filing it', async () => {
    const events = await outbox(EVENTS.ai.modelDrifted);
    expect(events.some((e) => e.data.key === 'inspection-targeting' && e.data.verdict === 'SIGNIFICANT')).toBe(true);
  });

  it('refuses to run without a captured baseline', async () => {
    const r = await post('/ai-platform/drift/berth-ranking/run', {}, assurance);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/no captured baseline/i);
  });

  it('refuses to capture a baseline from too few inferences', async () => {
    const r = await post('/ai-platform/drift/berth-ranking/baseline', { version: 1 }, assurance);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/at least/i);
  });

  it('keeps the history of runs and the baselines they were measured against', async () => {
    const r = await g('/ai-platform/drift/inspection-targeting', viewer);
    expect(r.body.data.runs.length).toBeGreaterThan(0);
    expect(r.body.data.baselines.length).toBe(1);
    expect(r.body.data.thresholds).toEqual({ moderate: 0.1, significant: 0.25 });
  });
});

/* The statistic itself, tested apart from the service. These are the properties the whole feature rests on;
 * if any of them is wrong the API will still answer, and answer "stable" for ever. */
describe('the population stability index', () => {
  it('is zero when nothing moved', () => {
    const base = summarise([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(psi(base.bins.map((b) => b.share), applyBins(base, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toBeCloseTo(0, 6);
  });

  it('rises as the distribution shifts', () => {
    const base = summarise(Array.from({ length: 200 }, (_, i) => i % 20));
    const small = psi(base.bins.map((b) => b.share), applyBins(base, Array.from({ length: 200 }, (_, i) => (i % 20) + 1)));
    const large = psi(base.bins.map((b) => b.share), applyBins(base, Array.from({ length: 200 }, (_, i) => (i % 20) + 15)));
    expect(large).toBeGreaterThan(small);
    expect(large).toBeGreaterThan(0.25);
  });

  /*
   * The mistake that makes drift monitoring useless: bucketing the observed sample with its own quantiles
   * instead of the baseline's. Every period then looks like every other, and nothing is ever reported.
   */
  it('buckets the observed sample with the baseline edges, not its own', () => {
    const base = summarise(Array.from({ length: 100 }, (_, i) => i));
    const shifted = Array.from({ length: 100 }, (_, i) => i + 500);
    expect(psi(base.bins.map((b) => b.share), applyBins(base, shifted))).toBeGreaterThan(1);
    // Re-summarising the shifted sample would report the two as identical, which is the bug.
    const wrong = summarise(shifted);
    expect(psi(base.bins.map((b) => b.share), wrong.bins.map((b) => b.share))).toBeCloseTo(0, 6);
  });

  it('handles a category that appears only after the baseline was captured', () => {
    const base = summarise(['CONTAINER', 'CONTAINER', 'BULK', 'BULK', 'TANKER']);
    const shares = applyBins(base, ['LNG', 'LNG', 'LNG', 'CONTAINER', 'BULK']);
    expect(shares.reduce((s, v) => s + v, 0)).toBeLessThanOrEqual(1.0001);
    expect(psi(base.bins.map((b) => b.share), shares)).toBeGreaterThan(0);
  });

  it('takes the worst feature rather than the average, and says so when the sample is too small', () => {
    const baseline = { features: { a: summarise([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]), b: summarise([1, 1, 1, 2, 2, 2, 3, 3, 3, 3]) } };
    const thin = compare(baseline, { features: { a: [1, 2, 3] } }, { minSample: 30, thresholds: { moderate: 0.1, significant: 0.25 } });
    expect(thin.verdict).toBe('INSUFFICIENT');

    const many = (v: number) => Array.from({ length: 60 }, () => v);
    const one = compare(baseline, { features: { a: many(99), b: [...many(1), ...many(2)] } }, { minSample: 30, thresholds: { moderate: 0.1, significant: 0.25 } });
    expect(one.verdict).toBe('SIGNIFICANT');
    expect(one.features[0].feature).toBe('a');
  });

  it('reads the thresholds the conventional way', () => {
    const t = { moderate: 0.1, significant: 0.25 };
    expect(verdictFor(0.05, t)).toBe('STABLE');
    expect(verdictFor(0.15, t)).toBe('MODERATE');
    expect(verdictFor(0.4, t)).toBe('SIGNIFICANT');
  });
});

describe('the latency budget', () => {
  it('abandons a provider that outruns the budget and records it as a breach', async () => {
    const slow = { mode: 'stub' as const, infer: (_r: unknown, signal: AbortSignal) => new Promise<never>((_res, rej) => { signal.addEventListener('abort', () => rej(new Error('aborted'))); }) };
    const outcome = await serve(slow as never, { modelKey: 'x', task: 'CLASSIFICATION', version: 1, features: {} }, 40);
    expect(outcome.status).toBe('TIMEOUT');
    expect(outcome.withinSla).toBe(false);
    expect(outcome.error).toMatch(/40 ms budget/);
  });

  it('reports a provider error separately from a timeout', async () => {
    const broken = { mode: 'live' as const, infer: async () => { throw new Error('Model server answered 503'); } };
    const outcome = await serve(broken as never, { modelKey: 'x', task: 'CLASSIFICATION', version: 1, features: {} }, 5000);
    expect(outcome.status).toBe('ERROR');
    expect(outcome.error).toBe('Model server answered 503');
  });

  it('answers the same way for the same input', async () => {
    const p = new StubProvider();
    const req = { modelKey: 'm', task: 'CLASSIFICATION' as const, version: 1, features: { a: 12, b: 'X' } };
    const one = await p.infer(req, new AbortController().signal);
    const two = await p.infer(req, new AbortController().signal);
    expect(one).toEqual(two);
  });

  it('takes percentiles from real observations', () => {
    expect(percentiles([])).toEqual({ p50: 0, p95: 0, p99: 0, max: 0 });
    const p = percentiles([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]);
    expect(p.p50).toBe(50); expect(p.max).toBe(100);
    expect([90, 100]).toContain(p.p95);
  });
});
