import { join } from 'node:path';
import { buildWorld, type World } from '@maritime/world';
import { createDb, runMigrations, withTx } from '@maritime/service-kit';
import { CATALOGUE } from './catalogue';
import { env as loadEnvironment } from './env';
import { upsertInspection, upsertPortCall, upsertVessel } from './consumer';
import { TrainingRefused, runTraining } from './training';

/*
 * The seed does two things the running service does over time: it projects the shared world's ships, boardings and
 * port calls into the records this server learns from, and it fits every catalogue model along its lineage — one
 * version per feature set — so the platform's registry can be told about fits that were actually executed, with the
 * metrics that were actually measured. Nothing is typed in: a reseed refits, and the numbers are whatever the world gives.
 */
export async function seedAiModels(databaseUrl: string, opts: { world?: World } = {}): Promise<Record<string, number>> {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const env = loadEnvironment();
  const world = opts.world ?? buildWorld();
  const counts: Record<string, number> = { vessels: 0, inspections: 0, portCalls: 0, artefacts: 0, runs: 0, refused: 0 };

  await withTx(pool, async (c) => {
    await c.query('TRUNCATE inference_log, artefacts, training_runs, datasets, rm_port_calls, rm_inspections, rm_vessels RESTART IDENTITY CASCADE');
    for (const v of world.vessels) { await upsertVessel(c, v); counts.vessels += 1; }
    for (const i of world.inspections) { await upsertInspection(c, { ...i, totalFindings: i.findings.length }); counts.inspections += 1; }
    for (const p of world.portCalls) { await upsertPortCall(c, p); counts.portCalls += 1; }
  });

  for (const def of CATALOGUE) {
    for (const [i, set] of def.featureSets.entries()) {
      try {
        await runTraining(pool, env, null, { key: def.key, featureSet: set.name, version: i + 1, initiatedBy: 'seed', note: set.note });
        counts.artefacts += 1; counts.runs += 1;
      } catch (e) {
        if (!(e instanceof TrainingRefused)) throw e;
        counts.refused += 1; counts.runs += 1;
      }
    }
  }
  await pool.end();
  return counts;
}

if (require.main === module) {
  const e = loadEnvironment();
  seedAiModels(e.DATABASE_URL).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
