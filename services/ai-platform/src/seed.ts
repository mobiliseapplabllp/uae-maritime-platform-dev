import { createDb, runMigrations, withTx } from '@maritime/service-kit';
import { join } from 'node:path';
import { env } from './env';
import { summarise, type Distribution } from './drift';
import { StubProvider, serve } from './serving';
import type { ModelTask } from './serving';

/*
 * A registry with history.
 *
 * Seeding the models alone would leave every read empty and every drift run "insufficient", so the seed also
 * plays a year of inference traffic through the same serving path the API uses, captures a baseline from the
 * early part of it, and lets the later part drift. That is what makes the drift report and the latency
 * percentiles show something on the first page load rather than after a month of use.
 *
 * The traffic is generated, not recorded: it is a demonstration of the machinery, and every figure in it is
 * fictional.
 */

interface Def {
  key: string; name: string; nameAr: string; task: ModelTask; purpose: string; owner: string; framework: string;
  residency: string; residencyNote: string;
  /** Feature generator. `t` runs 0 (oldest) to 1 (most recent) so a definition can make a feature drift. */
  features: (t: number, rnd: () => number) => Record<string, unknown>;
  versions: { artifact: string; metrics: Record<string, number>; note: string }[];
  /**
   * Where the deployed version is served. `ai-models://<key>` is the platform's own model server, which fits the model
   * on the platform's records and reports the measured metrics to this registry; `platform://<pipeline>` is a pipeline
   * the platform runs itself.
   */
  endpoint: string;
}

/** A small deterministic generator, so a reseed produces the same world. */
function prng(seed: number) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 0x1_0000_0000; };
}
const pick = <T,>(rnd: () => number, xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length) % xs.length];
const around = (rnd: () => number, mid: number, spread: number) => Math.round((mid + (rnd() - 0.5) * 2 * spread) * 100) / 100;

/* The ship types and agents as the shared world names them, and the previous ports as UN/LOCODEs: the generated traffic
 * carries the same feature names and vocabularies the model server fits on, so the baseline and the drift report read
 * the world the model actually sees. */
const SHIP_TYPES = ['CONT', 'BULK', 'TANK', 'GEN', 'RORO', 'OSV'] as const;
const AGENTS = ['GSS', 'ABM', 'OAP', 'WCM', 'SSL', 'TMA'] as const;
const PORTS = ['CNSHA', 'SGSIN', 'SAJED', 'MYPKG', 'NLRTM', 'KWKWI', 'OMSLL', 'QAHMD', 'INNSA', 'KRPUS'] as const;

const DEFS: Def[] = [
  {
    key: 'inspection-targeting', name: 'Port state inspection targeting', nameAr: 'استهداف التفتيش',
    task: 'CLASSIFICATION', purpose: 'Scores an expected arrival for how much a port state control inspection would be worth, from the ship’s age, detention history, class standing and time since its last inspection.',
    owner: 'Maritime Safety', framework: 'gradient-boosted trees (ai-models)', residency: 'AE', residencyNote: 'Served in-country by the platform’s own model server; no feature leaves the platform.',
    // Fleet age drifts upward across the window: the shift a targeting model would want to be told about.
    features: (t, rnd) => ({
      shipAgeYears: Math.round(around(rnd, 12 + t * 6, 5)),
      daysSinceLastInspection: Math.round(around(rnd, 210, 150)),
      priorDeficiencies: Math.max(0, Math.round(around(rnd, 3, 3))),
      priorDetentions: rnd() > 0.88 ? 1 : 0,
      shipType: pick(rnd, SHIP_TYPES), homeFlag: rnd() > 0.45 ? 'home' : 'foreign',
    }),
    // The metrics are not typed in: the model server fits each version on the platform's records and reports what it
    // measured on held-out rows, on its boot and after every fit.
    versions: [
      { artifact: 'ai-models://inspection-targeting/1', metrics: {}, note: 'First fit on the inspection outcomes: age, time since the last boarding, type and flag' },
      { artifact: 'ai-models://inspection-targeting/2', metrics: {}, note: 'Added the ship’s own deficiency and detention history' },
    ],
    endpoint: 'ai-models://inspection-targeting',
  },
  {
    key: 'eta-prediction', name: 'Arrival time prediction', nameAr: 'التنبؤ بوقت الوصول',
    task: 'REGRESSION', purpose: 'Predicts the hours a ship will wait between its reported arrival and its berth, from what is known when the call is announced: the ship, its agent, the hour and day of arrival, the queue ahead, the cargo and the previous port.',
    owner: 'Harbour Operations', framework: 'gradient-boosted trees (ai-models)', residency: 'AE', residencyNote: 'Served in-country by the platform’s own model server, alongside the traffic picture.',
    features: (_t, rnd) => ({
      shipType: pick(rnd, SHIP_TYPES), agentCode: pick(rnd, AGENTS), etaHour: Math.floor(rnd() * 24), etaWeekday: String(Math.floor(rnd() * 7)),
      queueAhead: Math.max(0, Math.round(around(rnd, 3, 3))), teu: rnd() > 0.6 ? Math.round(around(rnd, 2300, 1900)) : 0, cargoMt: Math.round(around(rnd, 40000, 38000)), prevPort: pick(rnd, PORTS),
    }),
    versions: [{ artifact: 'ai-models://eta-prediction/1', metrics: {}, note: 'Fit on the port calls that reached a berth' }],
    endpoint: 'ai-models://eta-prediction',
  },
  {
    key: 'document-extraction', name: 'Certificate and form extraction', nameAr: 'استخراج بيانات الشهادات',
    task: 'VISION', purpose: 'Reads a photographed or scanned statutory certificate and returns its fields with a confidence for each, so an officer confirms rather than retypes.',
    owner: 'Registrar of Ships', framework: 'in-country OCR (tesseract) with governed refinement', residency: 'AE', residencyNote: 'Images are read in the platform’s own process and are not retained after extraction; only text that stayed unread may be refined through the tool gateway, masked and fenced there.',
    features: (_t, rnd) => ({ pages: 1 + Math.floor(rnd() * 3), documentRef: `documents://scan/${Math.floor(rnd() * 9000) + 1000}`, contentLength: Math.round(around(rnd, 2400, 1800)) }),
    versions: [{ artifact: 'registry://models/document-extraction/1', metrics: { fieldAccuracy: 0.94, characterErrorRate: 0.021 }, note: 'Statutory certificate layouts, English and Arabic' }],
    endpoint: 'platform://vision',
  },
  {
    key: 'speech-transcription', name: 'Port control transcription', nameAr: 'تفريغ الاتصالات الصوتية',
    task: 'SPEECH', purpose: 'Transcribes VHF and port-control recordings attached to an incident so the case file is searchable.',
    owner: 'Maritime Surveillance', framework: 'speech model on the host, through a command', residency: 'AE', residencyNote: 'Audio is transcribed on the platform’s own host and the recording stays in the documents service.',
    features: (_t, rnd) => ({ durationSec: Math.round(around(rnd, 95, 80)), language: rnd() > 0.7 ? 'ar' : 'en', audioRef: `documents://audio/${Math.floor(rnd() * 9000) + 1000}` }),
    versions: [{ artifact: 'registry://models/speech-transcription/1', metrics: { wordErrorRate: 0.11 }, note: 'Bilingual, maritime vocabulary' }],
    endpoint: 'platform://speech',
  },
];

const DAY = 86_400_000;

export async function seedAiPlatform(databaseUrl: string): Promise<Record<string, number>> {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const counts: Record<string, number> = { models: 0, versions: 0, trainingRuns: 0, deployments: 0, inferences: 0, baselines: 0, driftRuns: 0 };
  const provider = new StubProvider();
  const now = new Date();
  const e = env();

  await withTx(pool, async (c) => {
    // One statement, no interpolation, and it resets the inference sequence so a reseed starts from 1.
    await c.query('TRUNCATE drift_runs, baselines, inferences, deployments, model_versions, training_runs, models RESTART IDENTITY CASCADE');

    for (const [di, def] of DEFS.entries()) {
      const m = await c.query<{ id: string }>(
        `INSERT INTO models(key, name, name_ar, task, purpose, owner, framework, residency_region, residency_note, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
        [def.key, def.name, def.nameAr, def.task, def.purpose, def.owner, def.framework, def.residency, def.residencyNote, 'Platform Administrator']);
      const modelId = m.rows[0].id;
      counts.models += 1;

      let deployedVersion = 0;
      for (const [vi, v] of def.versions.entries()) {
        const version = vi + 1;
        const started = new Date(now.getTime() - (330 - vi * 90) * DAY);
        const run = await c.query<{ id: string }>(
          `INSERT INTO training_runs(model_id, dataset_ref, dataset_rows, params, metrics, status, note, initiated_by, started_at, finished_at)
           VALUES ($1,$2,$3,$4,$5,'SUCCEEDED',$6,$7,$8,$9) RETURNING id`,
          [modelId, `datasets://${def.key}/v${version}`, 18_000 + vi * 4_000, JSON.stringify({ folds: 5, seed: 42 }), JSON.stringify(v.metrics), v.note, 'Data Science', started, new Date(started.getTime() + 4 * 3600_000)]);
        counts.trainingRuns += 1;
        const last = vi === def.versions.length - 1;
        await c.query(
          `INSERT INTO model_versions(model_id, version, artifact_ref, framework, training_run_id, metrics, params, status, change_note, created_by, validated_by, approved_by, approved_at, created_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [modelId, version, v.artifact, def.framework, run.rows[0].id, JSON.stringify(v.metrics), JSON.stringify({ folds: 5 }),
            last ? 'DEPLOYED' : 'RETIRED', v.note, 'Data Science', 'Model Assurance', 'Platform Administrator',
            new Date(started.getTime() + 6 * 3600_000), started]);
        counts.versions += 1;
        if (last) deployedVersion = version;
        else await c.query(`UPDATE model_versions SET retired_at = $2 WHERE model_id = $1 AND version = $3`, [modelId, new Date(now.getTime() - 200 * DAY), version]);
      }

      const deployedAt = new Date(now.getTime() - 240 * DAY);
      await c.query(
        `INSERT INTO deployments(model_id, version, environment, status, endpoint, replicas, residency_region, note, deployed_by, deployed_at)
         VALUES ($1,$2,'PROD','ACTIVE',$3,$4,$5,$6,$7,$8)`,
        [modelId, deployedVersion, def.endpoint, 2, def.residency, 'Approved for production serving', 'Platform Administrator', deployedAt]);
      counts.deployments += 1;
      await c.query('UPDATE models SET current_version = $2 WHERE id = $1', [modelId, deployedVersion]);

      // A year of traffic, played through the stub provider: the history is generated, and a figure in it is a
      // demonstration of the machinery, not a measurement of the model.
      const rnd = prng(9_000 + di * 17);
      const total = 420;
      const samples: { features: Record<string, unknown>; output: Record<string, unknown>; at: Date; latency: number; ok: boolean }[] = [];
      for (let i = 0; i < total; i += 1) {
        const t = i / (total - 1);
        const at = new Date(now.getTime() - (300 - Math.round(t * 295)) * DAY + Math.round(rnd() * 20 * 3600_000));
        const features = def.features(t, rnd);
        const outcome = await serve(provider, { modelKey: def.key, task: def.task, version: deployedVersion, features, fields: def.task === 'VISION' ? ['certificateType', 'certificateNo', 'issuedDate', 'expiryDate'] : undefined }, e.INFERENCE_SLA_MS);
        // Latency is synthesised rather than measured: a stub answers in microseconds, and a percentile
        // chart of microseconds says nothing about the commitment the platform actually made.
        const heavy = def.task === 'VISION' || def.task === 'SPEECH';
        const latency = Math.max(12, Math.round((heavy ? 900 : 120) * (0.5 + rnd() * 1.6)));
        const ok = rnd() > 0.012;
        const breached = latency > e.INFERENCE_SLA_MS;
        samples.push({ features, output: outcome.output, at, latency, ok: ok && !breached });
        await c.query(
          `INSERT INTO inferences(model_key, model_id, version, environment, status, latency_ms, within_sla, features, output, confidence, subject, actor, at)
           VALUES ($1,$2,$3,'PROD',$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [def.key, modelId, deployedVersion, ok ? 'OK' : 'ERROR', latency, latency <= e.INFERENCE_SLA_MS,
            JSON.stringify(features), JSON.stringify(ok ? outcome.output : {}), ok ? outcome.confidence : null,
            `subject-${1000 + i}`, JSON.stringify({ id: 'system', name: 'Scheduled run' }), at]);
        counts.inferences += 1;
      }

      // The baseline is captured from the first third — the period the version was accepted on — so the
      // comparison that follows has somewhere to have moved from.
      const early = samples.filter((s) => s.ok).slice(0, Math.floor(total / 3));
      const cols: Record<string, unknown[]> = {};
      for (const s of early) for (const [k, v] of Object.entries(s.features)) (cols[k] ??= []).push(v);
      const dists: Record<string, Distribution> = {};
      for (const [k, v] of Object.entries(cols)) dists[k] = summarise(v);
      const outs = early.map((s) => (typeof s.output.score === 'number' ? s.output.score : typeof s.output.value === 'number' ? s.output.value : s.output.label ?? null)).filter((v) => v !== null);
      await c.query(
        `INSERT INTO baselines(model_id, version, captured_from, captured_to, sample_size, features, output, note, created_by, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [modelId, deployedVersion, early[0]?.at ?? deployedAt, early[early.length - 1]?.at ?? deployedAt, early.length,
          JSON.stringify(dists), JSON.stringify(outs.length ? summarise(outs) : {}),
          'Captured on acceptance of the deployed version', 'Model Assurance', early[early.length - 1]?.at ?? deployedAt]);
      counts.baselines += 1;
    }
  });

  await pool.end();
  return counts;
}

if (require.main === module) {
  const e = env();
  seedAiPlatform(e.DATABASE_URL).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
