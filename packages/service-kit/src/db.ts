import { Pool, PoolClient } from 'pg';
import { drizzle, NodePgDatabase } from 'drizzle-orm/node-postgres';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AppLogger } from './logger';

export type Db = NodePgDatabase<Record<string, never>>;
export type Queryable = Pool | PoolClient;
export interface DbHandle { pool: Pool; db: Db }

export function createDb(url: string, opts: { max?: number } = {}): DbHandle {
  const pool = new Pool({ connectionString: url, max: opts.max ?? 10 });
  return { pool, db: drizzle(pool) };
}

export async function withTx<T>(pool: Pool, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw e;
  } finally { client.release(); }
}

/** Tables every service carries: outbox, inbox and atomic numbering series. Applied before the service's own migrations. */
export const KIT_SQL = `
CREATE TABLE IF NOT EXISTS _migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS outbox (
  id bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  subject text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  published_at timestamptz
);
CREATE INDEX IF NOT EXISTS outbox_unpublished_idx ON outbox (id) WHERE published_at IS NULL;
CREATE TABLE IF NOT EXISTS processed_events (
  event_id uuid PRIMARY KEY,
  subject text NOT NULL,
  processed_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS numbering_series (series text PRIMARY KEY, last_value bigint NOT NULL DEFAULT 0);
-- the local copy of Data Studio's masters (see lookups.ts): every service validates against its own mirror, never a call
CREATE TABLE IF NOT EXISTS lookup_mirror (
  id text PRIMARY KEY,
  category text NOT NULL,
  code text NOT NULL,
  label text NOT NULL DEFAULT '',
  label_ar text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lookup_mirror_category_idx ON lookup_mirror(category, active, code);
`;

/** Applies `*.sql` files from a directory in name order, once each, each inside its own transaction. */
export async function runMigrations(pool: Pool, dir: string, log?: AppLogger): Promise<string[]> {
  await pool.query(KIT_SQL);
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const applied = new Set((await pool.query<{ name: string }>('SELECT name FROM _migrations')).rows.map((r) => r.name));
  const done: string[] = [];
  for (const f of files) {
    if (applied.has(f)) continue;
    const sql = readFileSync(join(dir, f), 'utf8');
    await withTx(pool, async (c) => { await c.query(sql); await c.query('INSERT INTO _migrations(name) VALUES ($1)', [f]); });
    done.push(f);
    log?.info({ migration: f }, 'migration applied');
  }
  return done;
}

/** Atomic per-series numbering: `${prefix}${n padded}`; the series row is the lock. */
export async function nextNumber(client: Queryable, series: string, prefix: string, pad = 4): Promise<string> {
  const r = await client.query<{ last_value: string }>(
    'INSERT INTO numbering_series(series, last_value) VALUES ($1, 1) ON CONFLICT (series) DO UPDATE SET last_value = numbering_series.last_value + 1 RETURNING last_value',
    [series],
  );
  return `${prefix}${String(r.rows[0].last_value).padStart(pad, '0')}`;
}
