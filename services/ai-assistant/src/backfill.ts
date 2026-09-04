import { Inject, Injectable, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { KIT_LOGGER, KIT_POOL, type AppLogger, type Queryable } from '@maritime/service-kit';
import { reindex } from './corpus';
import { INDEX_VERSION } from './retrieval';

/* Bringing an existing corpus up to the index the running code expects.
 *
 * A migration can add a column but not fill it: the vectors are computed in this service, not in SQL. And a
 * change to what is indexed — a field, the tokeniser, the embedder — leaves every stored vector stale while
 * it still looks perfectly valid, which no migration can see either. Both cases produce the same failure: a
 * service that comes up working, and wrong, retrieving from an index that does not match its own code.
 *
 * So the index carries the version it was built by, and this compares it at boot. Nothing to do is the
 * normal case and costs one row; otherwise the index is rebuilt before the first question is asked. It runs
 * once however many replicas start together — the advisory lock decides which of them does the work. */

/** Only one replica reindexes. The constant is this service's own; nothing else takes it. */
export const BACKFILL_LOCK_KEY = 8842_1501;

@Injectable()
export class CorpusBackfill implements OnModuleInit {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_LOGGER) private readonly log: AppLogger) {}

  async onModuleInit() {
    try { await this.run(); } catch (err) {
      // A corpus that could not be reindexed is a degraded index, not a dead service: retrieval still ranks
      // on the word-level half, and the next seed or published notice will rebuild the rest.
      this.log.warn({ err: String(err) }, 'corpus backfill did not run; retrieval falls back to the word-level index');
    }
  }

  /** Returns what was rebuilt, or null when there was nothing to do or another replica was doing it. */
  async run(): Promise<{ documents: number; terms: number } | null> {
    if (!(await this.pending())) return null;
    const client = await this.pool.connect();
    try {
      const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [BACKFILL_LOCK_KEY]);
      if (!lock.rows[0].ok) return null;
      try {
        // re-checked under the lock: by now the replica that held it may already have done the work
        const reason = await this.pending(client);
        if (!reason) return null;
        const result = await reindex(client);
        this.log.info({ ...result, version: INDEX_VERSION, reason }, 'rebuilt the retrieval index');
        return result;
      } finally {
        await client.query('SELECT pg_advisory_unlock($1)', [BACKFILL_LOCK_KEY]);
      }
    } finally {
      client.release();
    }
  }

  /** Why the index needs rebuilding, or null if it does not. */
  private async pending(db: Queryable = this.pool): Promise<'unembedded' | 'stale' | null> {
    const r = await db.query<{ unembedded: string; version: string | null }>(
      `SELECT (SELECT count(*)::text FROM corpus WHERE dense IS NULL) AS unembedded,
              (SELECT version FROM corpus_index WHERE id) AS version`);
    if (Number(r.rows[0].unembedded) > 0) return 'unembedded';
    // an index built by a version that is not this one no longer matches the code that will read it
    return r.rows[0].version === INDEX_VERSION ? null : 'stale';
  }
}
