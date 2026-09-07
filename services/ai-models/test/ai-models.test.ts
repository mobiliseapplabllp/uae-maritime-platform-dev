import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createServer, type Server } from 'node:http';
import { EVENTS, makeEvent } from '@maritime/contracts';
import { PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256 } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedAiModels } from '../src/seed';
import { CATALOGUE } from '../src/catalogue';
import { applyEvent, retrainGrown } from '../src/consumer';
import { runTraining } from '../src/training';

/*
 * The model server end to end: seeded from the shared world, every catalogue model fitted along its lineage, each fit
 * measured on rows it did not see; a fit on request becomes the next version and is reported to the registry; serving
 * answers only for the platform, only from an artefact, and moves with the evidence.
 */
const DB = 'maritime_ai_models_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret'; const TOKEN = 'test-service-token-test-service-token';
let app: INestApplication; let server: unknown; let pool: Pool;
let registry: Server; let registryUrl = ''; const reports: { key: string; body: Record<string, unknown>; token: string }[] = [];
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const scientist = tok('scientist'); const viewer = tok('viewer'); const officer = tok('officer');
const g = (p: string, t = viewer) => request(server as never).get(p).set('authorization', t);
const post = (p: string, body?: unknown, t = scientist) => request(server as never).post(p).set('authorization', t).send((body ?? {}) as never);
const infer = (key: string, body: unknown, token = TOKEN) => request(server as never).post(`/v1/models/${key}/infer`).set('x-service-token', token).send(body as never);
let env: ReturnType<typeof loadEnv<typeof envSchema>>;

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  // a fake registry: records what it is told and answers as the platform would
  registry = createServer((req, res) => {
    let raw = ''; req.on('data', (c) => { raw += c; }); req.on('end', () => {
      const m = /\/ai-platform\/internal\/models\/([^/]+)\/trained$/.exec(req.url ?? '');
      if (!m || req.method !== 'POST') { res.writeHead(404); res.end('{}'); return; }
      const body = JSON.parse(raw); reports.push({ key: decodeURIComponent(m[1]), body, token: String(req.headers['x-service-token'] ?? '') });
      if (m[1] === 'eta-prediction' && body.version > 1) { res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: false, message: 'No model "eta-prediction"' })); return; }
      res.writeHead(201, { 'content-type': 'application/json' }); res.end(JSON.stringify({ success: true, data: { version: body.version, status: 'DRAFT', trainingRunId: `run-${body.version}`, created: true } }));
    });
  });
  await new Promise<void>((r) => registry.listen(0, '127.0.0.1', () => r()));
  registryUrl = `http://127.0.0.1:${(registry.address() as { port: number }).port}`;
  process.env.DATABASE_URL = URL; process.env.AI_PLATFORM_URL = registryUrl; process.env.SERVICE_TOKEN = TOKEN;
  await seedAiModels(URL);
  env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, SERVICE_TOKEN: TOKEN, AI_PLATFORM_URL: registryUrl, REGISTRY_SYNC_ATTEMPTS: '0', MDM_URL: 'http://127.0.0.1:1' } as never);
  const base = { scope: { level: 'NATIONAL' as const }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    scientist: { ...base, id: 'scientist', sub: 'scientist', name: 'Data Scientist', perms: ['models.view', 'models.manage'] },
    viewer: { ...base, id: 'viewer', sub: 'viewer', name: 'Compliance Analyst', perms: ['models.view'] },
    officer: { ...base, id: 'officer', sub: 'officer', name: 'Duty Officer', perms: ['ai.use'] },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer(); pool = new Pool({ connectionString: URL });
});
afterAll(async () => { await app?.close(); await pool?.end(); await new Promise<void>((r) => registry.close(() => r())); });

describe('the seed', () => {
  it('projects the world and fits every catalogue model along its lineage, one version per feature set', async () => {
    const rm = await pool.query<{ v: string; i: string; p: string }>('SELECT (SELECT count(*) FROM rm_vessels) AS v, (SELECT count(*) FROM rm_inspections) AS i, (SELECT count(*) FROM rm_port_calls) AS p');
    expect(Number(rm.rows[0].v)).toBeGreaterThan(20); expect(Number(rm.rows[0].i)).toBeGreaterThan(150); expect(Number(rm.rows[0].p)).toBeGreaterThan(900);
    const a = await pool.query<{ model_key: string; version: number; metrics: Record<string, number | string> }>('SELECT model_key, version, metrics FROM artefacts ORDER BY model_key, version');
    expect(a.rows.map((r) => `${r.model_key}@${r.version}`)).toEqual(['eta-prediction@1', 'inspection-targeting@1', 'inspection-targeting@2']);
    for (const def of CATALOGUE) expect(a.rows.filter((r) => r.model_key === def.key)).toHaveLength(def.featureSets.length);
    const runs = await pool.query<{ status: string; initiated_by: string }>('SELECT status, initiated_by FROM training_runs');
    expect(runs.rows.every((r) => r.status === 'SUCCEEDED' && r.initiated_by === 'seed')).toBe(true);
  });
  it('measures each fit on rows it did not see, and the world it was fitted on carries a signal', async () => {
    const a = await pool.query<{ version: number; metrics: Record<string, number> }>("SELECT version, metrics FROM artefacts WHERE model_key = 'inspection-targeting' ORDER BY version");
    for (const r of a.rows) { expect(r.metrics.heldOut).toBeGreaterThan(20); expect(r.metrics.trained + r.metrics.heldOut).toBe(r.metrics.rows); expect(r.metrics.auc).toBeGreaterThan(0.4); }
    // the lineage's latest fit, with the ship's history, finds the signal the world carries
    expect(a.rows[a.rows.length - 1].metrics.auc).toBeGreaterThan(0.6);
    const eta = await pool.query<{ metrics: Record<string, number> }>("SELECT metrics FROM artefacts WHERE model_key = 'eta-prediction'");
    expect(eta.rows[0].metrics.rows).toBeGreaterThan(900); expect(eta.rows[0].metrics.mae).toBeLessThan(eta.rows[0].metrics.baselineMae); expect(eta.rows[0].metrics.r2).toBeGreaterThan(0.2);
  });
});

describe('the fitter’s face', () => {
  it('lists the catalogue with what was fitted, on what, and how well', async () => {
    const r = await g('/ai-models');
    expect(r.status).toBe(200);
    const keys = r.body.data.map((m: { key: string }) => m.key).sort();
    expect(keys).toEqual(['eta-prediction', 'inspection-targeting']);
    const t = r.body.data.find((m: { key: string }) => m.key === 'inspection-targeting');
    expect(t.latest.version).toBe(2); expect(t.latest.featureSet).toBe('history'); expect(t.latest.features).toContain('priorDetentions');
    expect(t.artefacts).toHaveLength(2); expect(t.lastRun.status).toBe('SUCCEEDED'); expect(t.runs).toBe(2);
    expect(t.defaults.rounds).toBe(env.TRAIN_ROUNDS);
    expect(t.artefacts[0].trees).toBeGreaterThan(5);
    // the trees themselves are not on the API — their count and the schema are
    expect(t.latest.model).toBe('inspection-targeting'); expect(t.latest.base).toBeUndefined(); expect(Array.isArray(t.latest.schema)).toBe(true);
  });
  it('describes the rows a model would be fitted on now, without fitting it', async () => {
    const r = await g('/ai-models/inspection-targeting/dataset');
    expect(r.status).toBe(200);
    expect(r.body.data.rows).toBeGreaterThan(150); expect(r.body.data.positives).toBeGreaterThan(10); expect(r.body.data.positives).toBeLessThan(r.body.data.rows / 2);
    expect(r.body.data.featureSet).toBe('history');
    expect(r.body.data.schema.map((f: { name: string }) => f.name)).toEqual(['daysSinceLastInspection', 'homeFlag', 'priorDeficiencies', 'priorDetentions', 'shipAgeYears', 'shipType']);
    expect(r.body.data.schema.find((f: { name: string }) => f.name === 'homeFlag').categories).toEqual(['foreign', 'home']);
    expect(r.body.data.sample.length).toBeLessThanOrEqual(20);
    expect((await pool.query('SELECT count(*) AS n FROM datasets')).rows[0].n).toBe('3');
    const eta = await g('/ai-models/eta-prediction/dataset');
    expect(eta.body.data.unit).toBe('hours'); expect(eta.body.data.labelMean).toBeGreaterThan(5); expect(eta.body.data.labelMean).toBeLessThan(30);
    expect((await g('/ai-models/no-such-model/dataset')).status).toBe(404);
  });
  it('fits a model again on request as the next version, records the run and reports it to the registry on the service token', async () => {
    const before = reports.length;
    const r = await post('/ai-models/inspection-targeting/train', { rounds: 60, depth: 2, note: 'A shallower fit to compare' });
    expect(r.status).toBe(201);
    expect(r.body.data.artefact.version).toBe(3); expect(r.body.data.run.status).toBe('SUCCEEDED'); expect(r.body.data.run.params).toMatchObject({ rounds: 60, depth: 2, featureSet: 'history', note: 'A shallower fit to compare' });
    expect(r.body.data.run.durationMs).toBeGreaterThanOrEqual(0); expect(r.body.data.dataset.rows).toBeGreaterThan(150);
    expect(r.body.data.registry).toMatchObject({ ok: true, version: 3, status: 'DRAFT', trainingRunId: 'run-3' });
    expect(r.body.data.run.registryVersion).toBe(3); expect(r.body.data.run.registryRunId).toBe('run-3');
    expect(reports).toHaveLength(before + 1);
    const sent = reports[reports.length - 1];
    expect(sent.key).toBe('inspection-targeting'); expect(sent.token).toBe(TOKEN);
    expect(sent.body).toMatchObject({ version: 3, artifactRef: 'ai-models://inspection-targeting/3', featureSet: 'history', initiatedBy: 'Data Scientist' });
    expect((sent.body.metrics as Record<string, number>).auc).toBeGreaterThan(0.5); expect(sent.body.datasetRows).toBeGreaterThan(150);
    // a named feature set is honoured; an unknown one is refused before anything is fitted
    const baseline = await post('/ai-models/inspection-targeting/train', { featureSet: 'baseline' });
    expect(baseline.body.data.artefact.version).toBe(4); expect(baseline.body.data.artefact.features).not.toContain('priorDetentions');
    expect((await post('/ai-models/inspection-targeting/train', { featureSet: 'no-such-set' })).status).toBe(409);
    expect((await post('/ai-models/inspection-targeting/train', {}, viewer)).status).toBe(403);
    expect((await post('/ai-models/inspection-targeting/train', {}, officer)).status).toBe(403);
    const audit = await pool.query("SELECT count(*) AS n FROM outbox WHERE payload->>'type' = $1 AND payload->'data'->>'action' = 'TRAIN'", [EVENTS.audit.recorded]);
    expect(Number(audit.rows[0].n)).toBe(2);
  });
  it('keeps a registry it could not reach as an outcome on the run, not as a failed fit', async () => {
    const r = await post('/ai-models/eta-prediction/train', { note: 'The registry answers 404 to this one' });
    expect(r.status).toBe(201);
    expect(r.body.data.artefact.version).toBe(2); expect(r.body.data.run.status).toBe('SUCCEEDED');
    expect(r.body.data.registry).toMatchObject({ ok: false, httpStatus: 404 }); expect(r.body.data.run.registryVersion).toBeNull();
    const detail = await g('/ai-models/eta-prediction');
    expect(detail.body.data.artefacts.map((a: { version: number }) => a.version)).toEqual([2, 1]);
    expect(detail.body.data.runs).toHaveLength(2); expect(detail.body.data.datasets.length).toBeGreaterThanOrEqual(2);
    expect(detail.body.data.minRows).toBe(env.TRAIN_MIN_ROWS);
  });
  it('tells the registry about every artefact it holds, and says which landed', async () => {
    const r = await post('/ai-models/reconcile');
    expect(r.status).toBe(201);
    expect(r.body.data.artefacts).toBe(6); expect(r.body.data.reported).toBe(5);
    const failed = r.body.data.results.find((x: { ok: boolean }) => !x.ok);
    expect(failed).toMatchObject({ model: 'eta-prediction', version: 2, httpStatus: 404 });
    expect((await post('/ai-models/reconcile', {}, viewer)).status).toBe(403);
  });
});

describe('serving', () => {
  it('answers only to the service token, only from an artefact, and moves with the evidence', async () => {
    expect((await infer('inspection-targeting', { version: 2, features: {} }, 'wrong-token')).status).toBe(401);
    expect((await request(server as never).post('/v1/models/inspection-targeting/infer').set('authorization', scientist).send({ version: 2, features: {} })).status).toBe(401);
    expect((await infer('inspection-targeting', { version: 99, features: {} })).status).toBe(404);
    expect((await infer('no-such-model', { version: 1, features: {} })).status).toBe(404);
    const old = await infer('inspection-targeting', { version: 2, task: 'CLASSIFICATION', features: { shipAgeYears: 20, daysSinceLastInspection: 400, priorDeficiencies: 9, priorDetentions: 2, shipType: 'BULK', homeFlag: 'foreign' } });
    expect(old.status).toBe(201);
    expect(old.body.data).toMatchObject({ model: 'inspection-targeting', version: 2, task: 'CLASSIFICATION' });
    expect(old.body.data.output.score).toBeGreaterThan(0); expect(old.body.data.output.score).toBeLessThanOrEqual(1);
    expect(['LOW', 'MEDIUM', 'HIGH']).toContain(old.body.data.output.label);
    expect(old.body.data.output.imputed).toEqual([]); expect(old.body.data.output.unknown).toEqual([]);
    const young = await infer('inspection-targeting', { version: 2, features: { shipAgeYears: 2, daysSinceLastInspection: 60, priorDeficiencies: 0, priorDetentions: 0, shipType: 'CONT', homeFlag: 'home' } });
    expect(old.body.data.output.score).toBeGreaterThan(young.body.data.output.score);
    // a feature left out is imputed and said so, and the confidence is lowered for it
    const partial = await infer('inspection-targeting', { version: 2, features: { shipAgeYears: 20, shipType: 'BULK_CARRIER' } });
    expect(partial.body.data.output.imputed.sort()).toEqual(['daysSinceLastInspection', 'homeFlag', 'priorDeficiencies', 'priorDetentions']);
    expect(partial.body.data.output.unknown).toEqual(['shipType']);
    expect(partial.body.data.confidence).toBeLessThan(old.body.data.confidence);
    const eta = await infer('eta-prediction', { version: 1, features: { shipType: 'TANK', agentCode: 'GSS', etaHour: 23, etaWeekday: '6', queueAhead: 6, teu: 0, cargoMt: 80000, prevPort: 'SAJED' } });
    expect(eta.body.data.output.unit).toBe('hours'); expect(eta.body.data.output.value).toBeGreaterThan(5); expect(eta.body.data.output.value).toBeLessThan(60);
    const quiet = await infer('eta-prediction', { version: 1, features: { shipType: 'CONT', agentCode: 'GSS', etaHour: 10, etaWeekday: '2', queueAhead: 0, teu: 3000, cargoMt: 36000, prevPort: 'SGSIN' } });
    expect(eta.body.data.output.value).toBeGreaterThan(quiet.body.data.output.value);
    const log = await pool.query('SELECT count(*) AS n FROM inference_log');
    expect(Number(log.rows[0].n)).toBe(5);
    const stats = await g('/ai-models/inspection-targeting');
    expect(stats.body.data.served.calls).toBe(3);
  });
  it('describes what it holds for a model, to the platform only', async () => {
    const r = await request(server as never).get('/v1/models/inspection-targeting').set('x-service-token', TOKEN);
    expect(r.status).toBe(200); expect(r.body.data.versions.map((v: { version: number }) => v.version)).toEqual([4, 3, 2, 1]);
    expect((await request(server as never).get('/v1/models/inspection-targeting').set('authorization', viewer)).status).toBe(401);
  });
});

describe('what it learns from the platform', () => {
  it('projects the read-model snapshots it fits on, and a scheduled refit waits for enough new rows', async () => {
    const c = await pool.connect();
    try {
      await applyEvent(c, makeEvent({ type: EVENTS.readModel.upserted, source: 'test', data: { kind: 'vessel', entity: { id: 'v-new', imo: '9999999', name: 'Test Ship', type: 'GEN', flag: 'AE', built: 2001, real: false } } }));
      await applyEvent(c, makeEvent({ type: EVENTS.readModel.upserted, source: 'test', data: { kind: 'inspection', entity: { id: 'i-new', number: 'INS-T-1', vesselId: 'v-new', type: 'PSC', status: 'CLOSED', detention: true, plannedAt: '2026-09-01T06:00:00Z', closedAt: '2026-09-01T12:00:00Z', findings: [{ status: 'OPEN' }, { status: 'CLOSED' }], subjectKind: 'VESSEL' } } }));
      await applyEvent(c, makeEvent({ type: EVENTS.readModel.upserted, source: 'test', data: { kind: 'portCall', entity: { id: 'pc-new', vcn: 'MAR-2026-9999', vesselId: 'v-new', agentCode: 'GSS', status: 'SAILED', eta: '2026-09-01T02:00:00Z', atb: '2026-09-01T14:00:00Z', atd: '2026-09-03T00:00:00Z', prevPort: 'SGSIN', cargoOps: [{ unit: 'TEU', qty: 1200, qtyMT: 14400 }] } } }));
      expect((await c.query("SELECT built FROM rm_vessels WHERE id = 'v-new'")).rows[0].built).toBe(2001);
      expect((await c.query("SELECT total_findings, detention FROM rm_inspections WHERE id = 'i-new'")).rows[0]).toMatchObject({ total_findings: 2, detention: true });
      expect((await c.query("SELECT teu, cargo_mt::float AS mt FROM rm_port_calls WHERE id = 'pc-new'")).rows[0]).toMatchObject({ teu: 1200, mt: 14400 });
      await applyEvent(c, makeEvent({ type: EVENTS.readModel.deleted, source: 'test', data: { kind: 'portCall', id: 'pc-new' } }));
      expect((await c.query("SELECT 1 FROM rm_port_calls WHERE id = 'pc-new'")).rowCount).toBe(0);
    } finally { c.release(); }
    const considered = await retrainGrown(pool, env, null);
    expect(considered.map((x) => x.fitted)).toEqual([false, false]);
    expect(considered[0].reason).toMatch(/new rows/);
    // with the bar lowered, the grown model is fitted again by the scheduler's hand
    const eager = await retrainGrown(pool, { ...env, RETRAIN_MIN_NEW_ROWS: 1 }, null);
    expect(eager.find((x) => x.model === 'inspection-targeting')).toMatchObject({ fitted: true, reason: 'version 5' });
    expect((await pool.query("SELECT initiated_by FROM training_runs WHERE version = 5 AND model_key = 'inspection-targeting'")).rows[0].initiated_by).toBe('scheduler');
  });
  it('refuses to fit on too few rows and keeps the refusal on the record', async () => {
    await expect(runTraining(pool, { ...env, TRAIN_MIN_ROWS: 100000 }, null, { key: 'eta-prediction', initiatedBy: 'test' })).rejects.toThrow(/needs at least 100000/);
    const failed = await pool.query("SELECT status, error FROM training_runs WHERE model_key = 'eta-prediction' AND status = 'FAILED'");
    expect(failed.rows).toHaveLength(1); expect(failed.rows[0].error).toMatch(/too few rows/);
  });
});
