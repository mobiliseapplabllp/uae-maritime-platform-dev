import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { EVENTS, subjectFor } from '@maritime/contracts';
import { PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256 } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedAiPlatform } from '../src/seed';
import { applyBins, compare, psi, summarise, verdictFor } from '../src/drift';
import { StubProvider, percentiles, serve } from '../src/serving';

const DB = 'maritime_ai_platform_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret'; const TOKEN = 'test-service-token-test-service-token';
let app: INestApplication; let server: unknown; let pool: Pool;
/* A model server standing in for ai-models: it answers on the contract, only on the service token, and from the features. */
let models: Server; let modelsUrl = ''; const served: { key: string; body: Record<string, unknown>; token: string }[] = [];
/* A documents service standing in: the specimen certificate and a recording, read only by a session that carries a token. */
let docs: Server; let docsUrl = ''; const docReads: { id: string; token: string }[] = [];
const FIXTURE = readFileSync(join(__dirname, 'fixtures', 'certificate.png'));
const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVEfmt '), Buffer.from([16, 0, 0, 0, 1, 0, 1, 0, 0x80, 0x3e, 0, 0, 0, 0x7d, 0, 0, 2, 0, 16, 0]), Buffer.from('data'), Buffer.alloc(4), Buffer.alloc(3200)]);
/* A tool gateway standing in: answers a completion as a hosted provider would, or says no provider is configured. */
let gateway: Server; let gatewayUrl = ''; const completions: Record<string, unknown>[] = []; let hostedProvider = false;
const bands = (score: number) => (score >= 0.66 ? 'HIGH' : score >= 0.33 ? 'MEDIUM' : 'LOW');
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const scientist = tok('scientist'); const assurance = tok('assurance'); const viewer = tok('viewer'); const officer = tok('officer');
const g = (p: string, t = admin) => request(server as never).get(p).set('authorization', t);
const post = (p: string, body?: unknown, t = admin) => request(server as never).post(p).set('authorization', t).send((body ?? {}) as never);
const outbox = async (type: string) => (await pool.query('SELECT payload FROM outbox WHERE subject = $1 ORDER BY id', [subjectFor(type)])).rows.map((r) => r.payload as { type: string; data: Record<string, unknown> });

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedAiPlatform(URL);
  models = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      const m = /\/v1\/models\/([^/]+)\/infer$/.exec(req.url ?? '');
      if (!m || req.method !== 'POST') { res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"success":false}'); return; }
      if (req.headers['x-service-token'] !== TOKEN) { res.writeHead(401, { 'content-type': 'application/json' }); res.end('{"success":false,"message":"Service token required"}'); return; }
      const body = JSON.parse(raw) as { task?: string; features?: Record<string, unknown> }; served.push({ key: m[1], body, token: String(req.headers['x-service-token']) });
      const f = body.features ?? {};
      const answer = body.task === 'REGRESSION'
        ? { output: { value: 3 + 1.5 * Number(f.queueAhead ?? 0) + (f.shipType === 'TANK' ? 7 : 0), unit: 'hours' }, confidence: 0.7 }
        : (() => { const score = Math.round(Math.min(0.95, (Number(f.shipAgeYears ?? 0) / 25) * 0.5 + Number(f.priorDetentions ?? 0) * 0.3 + Number(f.priorDeficiencies ?? 0) / 20) * 1000) / 1000; return { output: { score, label: bands(score) }, confidence: 0.8 }; })();
      res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, data: answer }));
    });
  });
  await new Promise<void>((r) => models.listen(0, '127.0.0.1', () => r()));
  modelsUrl = `http://127.0.0.1:${(models.address() as { port: number }).port}`;
  docs = createServer((req, res) => {
    const m = /^\/documents\/([^/]+)\/content$/.exec(req.url ?? '');
    const token = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (!m) { res.writeHead(404); res.end(); return; }
    if (!token) { res.writeHead(401); res.end(); return; }
    docReads.push({ id: m[1], token });
    if (m[1] === 'cert-1') { res.writeHead(200, { 'content-type': 'image/png' }); res.end(FIXTURE); return; }
    if (m[1] === '2210') { res.writeHead(200, { 'content-type': 'audio/wav' }); res.end(WAV); return; }
    if (m[1] === 'form-7') { res.writeHead(200, { 'content-type': 'application/pdf' }); res.end(Buffer.from('%PDF-1.4 specimen')); return; }
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"success":false,"message":"Document not found"}');
  });
  await new Promise<void>((r) => docs.listen(0, '127.0.0.1', () => r()));
  docsUrl = `http://127.0.0.1:${(docs.address() as { port: number }).port}`;
  gateway = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      if (req.url !== '/ai-gateway/complete' || req.method !== 'POST') { res.writeHead(404); res.end('{}'); return; }
      if (req.headers['x-service-token'] !== TOKEN) { res.writeHead(401); res.end('{"success":false}'); return; }
      const body = JSON.parse(raw) as Record<string, unknown>; completions.push(body);
      const answer = hostedProvider
        ? { outcome: 'OK', provider: 'hosted-test', profile: 'default', residency: 'AE', latencyMs: 40, text: 'Here is the JSON: {"issuer": "MARITIME ADMINISTRATION (SAMPLE)", "holderName": null}', redactions: 0, redactionKinds: {}, injection: { score: 0, flags: [] } }
        : { outcome: 'LOCAL', provider: '', profile: '', residency: '', latencyMs: 1, code: 'NO_PROVIDER', reason: 'No hosted provider is configured in Settings → AI', redactions: 0, redactionKinds: {}, injection: { score: 0, flags: [] } };
      res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, data: answer }));
    });
  });
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', () => r()));
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as { port: number }).port}`;
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, SERVICE_TOKEN: TOKEN, MDM_URL: 'http://127.0.0.1:1', ALLOWED_PROD_RESIDENCY: 'AE', AI_MODELS_URL: modelsUrl, DOCUMENTS_URL: docsUrl, AI_TOOL_GATEWAY_URL: gatewayUrl, VISION_LANGS: 'eng', VISION_CACHE_PATH: join(__dirname, '..', '.tessdata-test'), AI_SPEECH_COMMAND: process.execPath, AI_SPEECH_ARGS: `${join(__dirname, 'fixtures', 'fake-transcriber.js')} {file} --language {language}` } as never);
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
afterAll(async () => { await app?.close(); await pool?.end(); for (const s of [models, docs, gateway]) await new Promise<void>((r) => s.close(() => r())); });

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
      features: { shipAgeYears: 22, daysSinceLastInspection: 410, priorDeficiencies: 9, priorDetentions: 1, shipType: 'BULK', homeFlag: 'foreign' },
      subject: 'IMO9123456',
    }, officer);
    expect(r.status).toBe(201);
    expect(r.body.data.environment).toBe('PROD');
    expect(r.body.data.residency).toBe('AE');
    expect(r.body.data.withinSla).toBe(true);
    expect(r.body.data.budgetMs).toBe(5000);
    expect(r.body.data.output.label).toBe('HIGH');
    // the deployment names the platform's own model server, reached live on the service token with the deployed version
    expect(r.body.data).toMatchObject({ mode: 'live', servedBy: 'ai-models', version: 2 });
    expect(served[served.length - 1]).toMatchObject({ key: 'inspection-targeting', token: TOKEN, body: { version: 2, task: 'CLASSIFICATION' } });
  });

  it('moves with the evidence rather than answering at random', async () => {
    const clean = await post('/ai-platform/infer/inspection-targeting', {
      features: { shipAgeYears: 3, daysSinceLastInspection: 30, priorDeficiencies: 0, priorDetentions: 0, shipType: 'CONT', homeFlag: 'home' },
    }, officer);
    expect(clean.body.data.output.score).toBeLessThan(0.4);
    const wait = await post('/ai-platform/infer/eta-prediction', { features: { shipType: 'TANK', agentCode: 'GSS', etaHour: 23, etaWeekday: '6', queueAhead: 6, teu: 0, cargoMt: 80000, prevPort: 'SAJED' } }, officer);
    expect(wait.body.data.output).toMatchObject({ unit: 'hours' }); expect(wait.body.data.output.value).toBeGreaterThan(10);
  });

  it('records a model server that does not answer as an error against the budget, and a pipeline of the platform’s own answers from the fallback', async () => {
    await post('/ai-platform/models', { key: 'remote-scoring', name: 'A model served elsewhere', task: 'CLASSIFICATION', residencyRegion: 'AE' }, scientist);
    await post('/ai-platform/models/remote-scoring/versions', { artifactRef: 'registry://remote-scoring/1' }, scientist);
    await post('/ai-platform/models/remote-scoring/versions/1/validate', {}, scientist);
    await post('/ai-platform/models/remote-scoring/versions/1/approve', {}, assurance);
    const deployed = await post('/ai-platform/models/remote-scoring/versions/1/deploy', { environment: 'DEV', endpoint: 'http://127.0.0.1:1' }, assurance);
    expect(deployed.status).toBe(201);
    const r = await post('/ai-platform/infer/remote-scoring', { features: { x: 1 } }, officer);
    expect(r.status).toBe(409); expect(r.body.message).toMatch(/fetch failed|ECONNREFUSED|Model server/i);
    const rows = await pool.query(`SELECT status, error FROM inferences WHERE model_key = 'remote-scoring'`);
    expect(rows.rows[0].status).toBe('ERROR'); expect(rows.rows[0].error).toBeTruthy();
    // vision runs on the platform's own pipeline, in-country, whatever else is configured
    const v = await post('/ai-platform/vision/extract', { fields: ['certificateNo'], hints: { certificateNo: 'X-1' } }, officer);
    expect(v.body.data).toMatchObject({ mode: 'live', servedBy: 'platform-vision' });
  });

  it('refuses a model with no deployment, and keeps the refusal on the record', async () => {
    await post('/ai-platform/models', { key: 'undeployed', name: 'Not deployed', task: 'CLASSIFICATION' }, scientist);
    const r = await post('/ai-platform/infer/undeployed', { features: { x: 1 } }, officer);
    expect(r.status).toBe(409);
    const rows = await pool.query(`SELECT status FROM inferences WHERE model_key = 'undeployed'`);
    expect(rows.rows[0].status).toBe('REFUSED');
  });

  it('keeps a caller’s hints as hints and is honest about the fields it could not read when the document is not there', async () => {
    const r = await post('/ai-platform/vision/extract', {
      documentRef: 'documents://scan/4471', pages: 2,
      fields: ['certificateType', 'certificateNo', 'issuedDate'],
      hints: { certificateType: 'IOPP Certificate', certificateNo: 'IOPP-2026-0442' },
    }, officer);
    expect(r.status).toBe(201);
    expect(r.body.data.fields.certificateNo).toMatchObject({ value: 'IOPP-2026-0442', source: 'hint' });
    expect(r.body.data.fields.certificateNo.confidence).toBeGreaterThan(0.8);
    // Nothing was supplied for the issue date and nothing could be read, so it is returned unfound with no
    // confidence rather than invented — the difference between a field to confirm and a field to check.
    expect(r.body.data.fields.issuedDate).toMatchObject({ value: null, confidence: 0, source: 'none' });
    expect(r.body.data.warning).toMatch(/documents service answered 404/);
    expect(r.body.data.source).toBe('none');
    // the document was asked for as the person, never on the service token
    expect(docReads[docReads.length - 1]).toMatchObject({ id: '4471' }); expect(docReads[docReads.length - 1].token).not.toBe(TOKEN);
  });

  it('reads a photographed certificate in-country: the fields by their labels and their shape, the hints confirmed, every field with a source', async () => {
    hostedProvider = false; const before = completions.length;
    const r = await post('/ai-platform/vision/extract', {
      documentRef: 'cert-1', fields: ['certificateType', 'certificateNo', 'vesselName', 'imo', 'portOfRegistry', 'grossTonnage', 'issuedDate', 'expiryDate', 'issuer'],
      hints: { certificateNo: 'IOPP-2026-0442' }, subject: 'KHOR FAKKAN STAR',
    }, officer);
    expect(r.status).toBe(201);
    const f = r.body.data.fields;
    expect(r.body.data).toMatchObject({ mode: 'live', servedBy: 'platform-vision', source: 'image' });
    expect(r.body.data.ocr).toMatchObject({ engine: 'tesseract', languages: ['eng'] }); expect(r.body.data.ocr.confidence).toBeGreaterThan(0.8); expect(r.body.data.ocr.words).toBeGreaterThan(40);
    expect(f.certificateType.value).toMatch(/INTERNATIONAL OIL POLLUTION PREVENTION/); expect(f.certificateType.source).toBe('read');
    expect(f.certificateNo).toMatchObject({ value: 'IOPP-2026-0442', source: 'read+hint' }); expect(f.certificateNo.confidence).toBeGreaterThan(0.85);
    expect(f.vesselName).toMatchObject({ value: 'KHOR FAKKAN STAR', source: 'read' }); expect(f.vesselName.confidence).toBeGreaterThan(0.7);
    expect(f.imo).toMatchObject({ value: '9700196', source: 'read' }); expect(f.imo.confidence).toBeGreaterThan(0.8); // the check digit holds, so the read is trusted beyond the engine's word-level figure
    expect(f.portOfRegistry.value).toBe('ABU DHABI'); expect(f.grossTonnage.value).toBe('54,320');
    expect(f.issuedDate).toMatchObject({ value: '14 March 2026', normalised: '2026-03-14', source: 'read' });
    expect(f.expiryDate).toMatchObject({ value: '13 March 2031', normalised: '2031-03-13', source: 'read' });
    // no label for the issuer on the specimen: unread, and with no hosted provider the gateway said LOCAL and the field stays unread
    expect(f.issuer).toMatchObject({ value: null, source: 'none' });
    expect(completions.length).toBe(before + 1); expect(completions[completions.length - 1]).toMatchObject({ caller: 'svc:ai-platform', purpose: 'extract' });
    expect(String((completions[completions.length - 1].grounding as { text: string }[])[0].text)).toMatch(/KHOR FAKKAN STAR/);
    expect(r.body.data.refined).toEqual([]);
    expect(r.body.data.confidence).toBeGreaterThan(0.7);
    // recorded without the image: the reference, the hints and the size
    const row = await pool.query(`SELECT features, output FROM inferences WHERE model_key = 'document-extraction' AND subject = 'KHOR FAKKAN STAR'`);
    expect(row.rows[0].features).toMatchObject({ documentRef: 'cert-1', certificateNo: 'IOPP-2026-0442' }); expect(JSON.stringify(row.rows[0].output)).not.toMatch(/iVBOR/);
  });

  it('refines what stayed unread through the gateway when a hosted provider is configured, and says which fields came from it', async () => {
    hostedProvider = true;
    const r = await post('/ai-platform/vision/extract', { documentRef: 'documents://cert-1', fields: ['certificateNo', 'issuer', 'holderName'] }, officer);
    expect(r.body.data.fields.issuer).toMatchObject({ value: 'MARITIME ADMINISTRATION (SAMPLE)', source: 'hosted', confidence: 0.7 });
    expect(r.body.data.fields.holderName).toMatchObject({ value: null, source: 'none' });
    expect(r.body.data.fields.certificateNo.source).toBe('read');
    expect(r.body.data.refined).toEqual(['issuer']);
    hostedProvider = false;
    // a page of text needs no engine at all, and a document that is not an image is said to be one
    const text = await post('/ai-platform/vision/extract', { content: 'Certificate No. NAV-2026-0091\nName of ship SAADIYAT BREEZE\nValid until 2027-05-01', fields: ['certificateNo', 'vesselName', 'expiryDate'] }, officer);
    expect(text.body.data.source).toBe('text');
    expect(text.body.data.fields.certificateNo.value).toBe('NAV-2026-0091'); expect(text.body.data.fields.vesselName.value).toBe('SAADIYAT BREEZE'); expect(text.body.data.fields.expiryDate.normalised).toBe('2027-05-01');
    const pdf = await post('/ai-platform/vision/extract', { documentRef: 'form-7', fields: ['certificateNo'] }, officer);
    expect(pdf.body.data.warning).toMatch(/application\/pdf is not an image/); expect(pdf.body.data.fields.certificateNo.source).toBe('none');
  });

  it('transcribes a recording through the speech model on the host, as a command with no shell, and cleans up after itself', async () => {
    const r = await post('/ai-platform/speech/transcribe', {
      audioRef: 'documents://audio/2210', durationSec: 48, language: 'en',
      transcriptHint: 'Port control this is Falcon Trader requesting permission to shift to berth CT1-3',
    }, officer);
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ mode: 'live', servedBy: 'platform-speech', words: 13, language: 'en', durationSec: 48 });
    expect(r.body.data.transcript).toMatch(/^Port control this is Falcon Trader/);
    expect(r.body.data.segments).toHaveLength(2); expect(r.body.data.segments[1]).toMatchObject({ from: 21.5, to: 48 });
    expect(r.body.data.confidence).toBeGreaterThan(0.7); expect(r.body.data.engine.confidenceBasis).toBe('reported by the command');
    expect(docReads.some((d) => d.id === '2210')).toBe(true);
    // a recording that is not there is an answer with a reason, not a crash
    const missing = await post('/ai-platform/speech/transcribe', { audioRef: 'documents://audio/nope', durationSec: 5 }, officer);
    expect(missing.body.data).toMatchObject({ words: 0, confidence: 0 }); expect(missing.body.data.warning).toMatch(/404/);
  });

  it('reports latency as percentiles, not as an average', async () => {
    const r = await g('/ai-platform/serving/stats?days=365', viewer);
    expect(r.status).toBe(200);
    expect(r.body.data.calls).toBeGreaterThan(1000);
    expect(r.body.data.budgetMs).toBe(5000);
    expect(r.body.data.latencyMs.p95).toBeGreaterThanOrEqual(r.body.data.latencyMs.p50);
    expect(r.body.data.latencyMs.p99).toBeGreaterThanOrEqual(r.body.data.latencyMs.p95);
    expect(r.body.data.models.length).toBeGreaterThanOrEqual(4);
    expect(r.body.data.servers).toMatchObject({ modelServer: modelsUrl, endpoint: null, fallback: 'stub' });
  });
});

describe('the registry’s service face', () => {
  const trained = (key: string, body: Record<string, unknown>, token = TOKEN) => request(server as never).post(`/ai-platform/internal/models/${key}/trained`).set('x-service-token', token).send(body as never);
  const report = { artifactRef: 'ai-models://inspection-targeting/3', framework: 'gradient-boosted trees (ai-models)', featureSet: 'history', params: { rounds: 150, depth: 3 }, metrics: { auc: 0.71, rows: 176, heldOut: 35, confidence: 0.71 }, datasetRef: 'ai-models://datasets/d-1', datasetRows: 176, note: 'Fitted again on the records that accrued', initiatedBy: 'Data Scientist', startedAt: '2026-09-07T08:00:00Z', finishedAt: '2026-09-07T08:00:01Z' };
  it('records a fit the model server executed as a run and a draft version carrying the measured metrics, on the service token only', async () => {
    expect((await trained('inspection-targeting', { ...report, version: 3 }, 'wrong')).status).toBe(401);
    expect((await request(server as never).post('/ai-platform/internal/models/inspection-targeting/trained').set('authorization', admin).send({ ...report, version: 3 } as never)).status).toBe(401);
    const r = await trained('inspection-targeting', { ...report, version: 3 });
    expect(r.status).toBe(201);
    expect(r.body.data).toMatchObject({ version: 3, status: 'DRAFT', created: true, artifactRef: 'ai-models://inspection-targeting/3', metrics: { auc: 0.71 }, createdBy: 'Data Scientist' });
    const runs = await g('/ai-platform/models/inspection-targeting/training-runs', viewer);
    const run = runs.body.data.find((x: { id: string }) => x.id === r.body.data.trainingRunId);
    expect(run).toMatchObject({ status: 'SUCCEEDED', datasetRows: 176, metrics: { auc: 0.71 }, note: 'Fitted again on the records that accrued' });
    const events = await outbox(EVENTS.ai.modelTrained);
    expect(events.some((e) => e.data.key === 'inspection-targeting' && e.data.version === 3 && e.data.created === true)).toBe(true);
  });
  it('brings a version it already knows up to date rather than duplicating it — the seeded fits carry the measured metrics after the model server reports them', async () => {
    const again = await trained('inspection-targeting', { ...report, version: 3, metrics: { auc: 0.74, rows: 190 } });
    expect(again.body.data).toMatchObject({ version: 3, created: false, metrics: { auc: 0.74 } });
    const versions = await g('/ai-platform/models/inspection-targeting/versions', viewer);
    expect(versions.body.data.filter((v: { version: number }) => v.version === 3)).toHaveLength(1);
    // the deployed version, seeded with no metrics, takes the model server's word
    const seeded = await trained('inspection-targeting', { ...report, version: 2, artifactRef: 'ai-models://inspection-targeting/2', metrics: { auc: 0.69, heldOut: 35 } });
    expect(seeded.body.data).toMatchObject({ version: 2, status: 'DEPLOYED', created: false, metrics: { auc: 0.69 } });
    const runs = await g('/ai-platform/models/inspection-targeting/training-runs', viewer);
    expect(runs.body.data.filter((x: { datasetRef: string }) => x.datasetRef === 'ai-models://datasets/d-1')).toHaveLength(2);
    expect((await trained('no-such-model', { ...report, version: 1 })).status).toBe(404);
    expect((await trained('inspection-targeting', { ...report, version: 0 })).status).toBe(400);
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
