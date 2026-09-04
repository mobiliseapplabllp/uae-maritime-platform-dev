import type { Queryable } from '@maritime/service-kit';
import { EMBED_DIM, toVectorLiteral } from './embedding';

/* Retrieval in the two modes the platform has to run in.
 *
 * With pgvector the first pass runs in SQL: the reader's permissions narrow the rows in the WHERE clause,
 * and the ANN index orders what is left by distance. Without it, the same first pass happens in process
 * over the same numeric vectors. Either way the second pass — the exact tf-idf re-ranking — is the same
 * code, so the two modes return the same answer and differ only in what it cost to get there.
 *
 * The order matters more than the mechanism. The permission filter is a WHERE clause, not a filter applied
 * to results: a passage the reader may not see is never a candidate, so it cannot be counted, scored,
 * snippeted or leaked by the shape of what came back. */

export type VectorMode = 'pgvector' | 'memory';

let mode: VectorMode | null = null;

export async function detectVectorMode(db: Queryable, forceMemory = false): Promise<VectorMode> {
  // The override only ever forces downwards: pgvector cannot be willed into a cluster that lacks it.
  if (forceMemory) { mode = 'memory'; return mode; }
  if (mode) return mode;
  const r = await db.query<{ n: string }>(
    `SELECT count(*)::text AS n FROM pg_extension e
       JOIN information_schema.columns c ON c.table_name = 'corpus' AND c.column_name = 'embedding'
      WHERE e.extname = 'vector'`);
  mode = Number(r.rows[0].n) > 0 ? 'pgvector' : 'memory';
  return mode;
}
export const currentVectorMode = (): VectorMode | null => mode;
/** Tests reset the cached detection between databases. */
export const resetVectorMode = () => { mode = null; };

export interface Candidate { id: string; score: number }

/**
 * The recall pass: the ids of the passages this reader may see, nearest first by dense distance.
 *
 * `limit` is deliberately generous compared with the number of passages an answer will use. The dense
 * vector is a lexical projection and it is approximate twice over — once in the hashing, once in the ANN
 * traversal — so it is asked for a candidate pool rather than for the answer, and the exact vectors decide
 * the order within that pool.
 */
export async function recall(
  db: Queryable,
  query: readonly number[],
  opts: { permissions: readonly string[]; kinds?: string[]; limit: number },
): Promise<Candidate[]> {
  if (query.length !== EMBED_DIM) return [];
  const wildcard = opts.permissions.includes('*');
  const kinds = opts.kinds?.length ? opts.kinds : null;
  const r = await db.query<{ id: string; score: string }>(
    `SELECT id, (1 - (embedding <=> $1::vector))::text AS score
       FROM corpus
      WHERE embedding IS NOT NULL
        AND ($2::boolean OR permission = '' OR permission = ANY($3::text[]))
        AND ($4::text[] IS NULL OR kind = ANY($4::text[]))
      ORDER BY embedding <=> $1::vector
      LIMIT $5`,
    [toVectorLiteral(query), wildcard, [...opts.permissions], kinds, Math.max(1, opts.limit)]);
  return r.rows.map((row) => ({ id: row.id, score: Number(row.score) }));
}

/** Writes the canonical vector. The searchable copy, where there is one, is kept in step by the trigger the
 *  migration installed, so nothing outside this function has to know which mode the cluster is in. */
export async function writeDense(db: Queryable, id: string, dense: readonly number[]): Promise<void> {
  await db.query('UPDATE corpus SET dense = $2 WHERE id = $1', [id, dense.length === EMBED_DIM ? dense : null]);
}
