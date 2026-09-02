import { join } from 'node:path';
import { createDb, runMigrations, withTx } from '@maritime/service-kit';
import { env } from './env';
import { SEED_JOBS, upsertJob } from './jobs';

/** Registers the platform's standing jobs. Idempotent: schedules already in place keep their next run. */
export async function seedScheduler(databaseUrl: string, timezone = 'Asia/Dubai') {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const jobs = await withTx(pool, async (c) => { for (const job of SEED_JOBS) await upsertJob(c, job, timezone); return SEED_JOBS.length; });
  await pool.end();
  return { jobs, timezone };
}
if (require.main === module) { const e = env(); seedScheduler(e.DATABASE_URL, e.SCHEDULER_TIMEZONE).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); }); }
