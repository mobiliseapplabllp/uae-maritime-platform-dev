import { join } from 'node:path';
import { createDb, runMigrations, createLogger } from '@maritime/service-kit';
import { env } from './env';
const e = env();
const { pool } = createDb(e.DATABASE_URL);
runMigrations(pool, join(__dirname, '..', 'migrations'), createLogger(e.SERVICE_NAME)).then(async (d) => { console.log('applied', d); await pool.end(); }).catch(async (err) => { console.error(err); await pool.end(); process.exit(1); });
