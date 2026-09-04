/* Search is split in two on purpose: the engine decides what *matches*, the database decides what the
 * reader may *see*.
 *
 * An adapter returns candidate identifiers and a score. The caller then puts those identifiers through the
 * same tenancy predicate every other query uses, and reads the rows from PostgreSQL. Nothing is returned to
 * a user that the database did not just re-authorise.
 *
 * The tempting alternative — copy `scope_company`, `scope_port` and friends into the search index and filter
 * there — is faster and wrong. It puts the tenancy boundary in two systems that are reindexed on different
 * schedules, and the first time a reindex lags, the index answers with a record the database would have
 * refused. One boundary, in one place, is worth the extra round trip.
 *
 * So a `SearchDoc` carries text and an id, and deliberately carries no scope columns: there is nowhere in
 * this interface to put them, which is the point. */

export type SearchDriver = 'postgres' | 'opensearch';

/** How a field is analysed. Arabic gets its own analysis chain; `keyword` is matched whole, for codes. */
export type FieldAnalysis = 'text' | 'arabic' | 'keyword';

export interface SearchField {
  /** Column in the read model, and property name in the indexed document. */
  name: string;
  analysis: FieldAnalysis;
  /** Relative weight when several fields match. A name beats a description. */
  boost?: number;
}

export interface SearchIndex {
  /** Logical index name, e.g. `vessels`. Prefixed per environment by the adapter. */
  name: string;
  /** The PostgreSQL read model this index mirrors — the fallback driver reads it directly. */
  table: string;
  fields: readonly SearchField[];
}

export interface SearchDoc { id: string; fields: Record<string, string | null | undefined> }
export interface SearchHit { id: string; score: number }
export interface MatchRequest { index: SearchIndex; q: string; limit: number }

export interface SearchAdapter {
  readonly driver: SearchDriver;
  /** Candidate ids, best first. Authorisation is the caller's job and happens after this returns. */
  match(req: MatchRequest): Promise<SearchHit[]>;
  /** Create or update the index definition, including its analysis chain. */
  ensure(index: SearchIndex): Promise<void>;
  upsert(index: SearchIndex, docs: SearchDoc[]): Promise<void>;
  remove(index: SearchIndex, ids: string[]): Promise<void>;
  health(): Promise<{ ok: boolean; driver: SearchDriver; detail: string }>;
}

/** Column and index names come from code, never from a request, but the assertion is cheap and permanent. */
const IDENT = /^[a-z_][a-z0-9_]{0,62}$/;
const identOf = (v: string, what: string): string => {
  if (!IDENT.test(v)) throw new Error(`Unsafe ${what} in search index definition: ${v}`);
  return v;
};

export const escapeForLike = (v: string): string => v.replace(/[\\%_]/g, (c) => `\\${c}`);

interface QueryablePool { query<R extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }> }

/**
 * The development and small-deployment driver: the read model is the index. `ensure`, `upsert` and `remove`
 * are deliberately empty — the projection that maintains the read model has already done that work, and a
 * second copy would be a second thing to fall behind.
 *
 * Ranking is by match position rather than relevance: exact, then prefix, then anywhere. It is cruder than
 * an engine's scoring, and it is the same ordering users already see, so switching drivers changes the
 * quality of results and not their meaning.
 */
export class PostgresSearchAdapter implements SearchAdapter {
  readonly driver = 'postgres' as const;
  constructor(private readonly pool: QueryablePool) {}

  async match({ index, q, limit }: MatchRequest): Promise<SearchHit[]> {
    const term = q.trim();
    if (term.length < 2) return [];
    const table = identOf(index.table, 'table');
    const fields = index.fields.map((f) => ({ ...f, name: identOf(f.name, 'field') }));
    if (!fields.length) return [];
    const where = fields.map((f) => `coalesce(${f.name}::text, '') ILIKE $1`).join(' OR ');
    // Score in SQL so the ordering is the database's and not a second sort in Node over a truncated page.
    const score = fields
      .map((f) => {
        const b = f.boost ?? 1;
        const col = `coalesce(${f.name}::text, '')`;
        return `CASE WHEN lower(${col}) = lower($2) THEN ${(3 * b).toFixed(2)} WHEN ${col} ILIKE $3 THEN ${(2 * b).toFixed(2)} WHEN ${col} ILIKE $1 THEN ${b.toFixed(2)} ELSE 0 END`;
      })
      .join(' + ');
    const like = `%${escapeForLike(term)}%`;
    const prefix = `${escapeForLike(term)}%`;
    const sql = `SELECT id::text AS id, (${score}) AS score FROM ${table} WHERE ${where} ORDER BY score DESC, id LIMIT $4`;
    const { rows } = await this.pool.query<{ id: string; score: string }>(sql, [like, term, prefix, limit]);
    return rows.map((r) => ({ id: r.id, score: Number(r.score) }));
  }

  async ensure(): Promise<void> { /* the read model is the index */ }
  async upsert(): Promise<void> { /* the projection already wrote the row */ }
  async remove(): Promise<void> { /* the projection already deleted the row */ }
  async health() {
    try { await this.pool.query('SELECT 1'); return { ok: true, driver: this.driver, detail: 'read models queried directly' }; }
    catch (err) { return { ok: false, driver: this.driver, detail: err instanceof Error ? err.message : 'unreachable' }; }
  }
}

/**
 * Arabic is not an afterthought here: the register is bilingual, and a search that only folds Latin text
 * fails half its users.
 *
 * `arabic_normalization` settles the variants that a person types interchangeably — the several forms of
 * alef, the final ya and alef maqsura, ta marbuta and ha — so a vessel indexed one way is found the other.
 * `decimal_digit` folds Eastern Arabic-Indic digits onto ASCII, so an IMO number typed in Arabic numerals
 * matches the one stored in Latin ones. Stemming is applied for prose and withheld from names, because
 * stemming a proper noun is how a ship stops being findable by its own name.
 */
export const ANALYSIS = {
  analyzer: {
    maritime_arabic: { type: 'custom', tokenizer: 'standard', filter: ['lowercase', 'decimal_digit', 'arabic_normalization', 'arabic_stop'] },
    maritime_text: { type: 'custom', tokenizer: 'standard', filter: ['lowercase', 'asciifolding', 'decimal_digit'] },
  },
  normalizer: {
    maritime_code: { type: 'custom', filter: ['lowercase', 'asciifolding'] },
  },
} as const;

const mappingFor = (fields: readonly SearchField[]) => {
  const properties: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.analysis === 'keyword') properties[f.name] = { type: 'keyword', normalizer: 'maritime_code' };
    else properties[f.name] = { type: 'text', analyzer: f.analysis === 'arabic' ? 'maritime_arabic' : 'maritime_text' };
  }
  return { properties };
};

export interface OpenSearchConfig { url: string; prefix: string; username?: string; password?: string; timeoutMs: number }

/**
 * OpenSearch over its REST API — no client library, because five calls do not justify a dependency that
 * would have to be kept current for the life of the platform.
 */
export class OpenSearchAdapter implements SearchAdapter {
  readonly driver = 'opensearch' as const;
  constructor(private readonly cfg: OpenSearchConfig, private readonly fetchImpl: typeof fetch = fetch) {}

  private indexName(index: SearchIndex) { return `${this.cfg.prefix}-${index.name}`; }
  private async call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = { accept: 'application/json' };
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.cfg.username) headers.authorization = `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password ?? ''}`).toString('base64')}`;
    const res = await this.fetchImpl(`${this.cfg.url.replace(/\/+$/, '')}${path}`, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(this.cfg.timeoutMs),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenSearch ${method} ${path} failed: ${res.status} ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async ensure(index: SearchIndex): Promise<void> {
    const name = this.indexName(index);
    const exists = await this.fetchImpl(`${this.cfg.url.replace(/\/+$/, '')}/${name}`, { method: 'HEAD', signal: AbortSignal.timeout(this.cfg.timeoutMs) }).then((r) => r.ok).catch(() => false);
    if (exists) { await this.call('PUT', `/${name}/_mapping`, mappingFor(index.fields)); return; }
    await this.call('PUT', `/${name}`, { settings: { analysis: ANALYSIS }, mappings: mappingFor(index.fields) });
  }

  async upsert(index: SearchIndex, docs: SearchDoc[]): Promise<void> {
    if (!docs.length) return;
    const name = this.indexName(index);
    const allowed = new Set(index.fields.map((f) => f.name));
    const lines: string[] = [];
    for (const d of docs) {
      // Only declared fields are indexed. A projection that starts attaching scope columns to its documents
      // cannot leak them into the engine through here.
      const doc: Record<string, string> = {};
      for (const [k, v] of Object.entries(d.fields)) if (allowed.has(k) && v !== null && v !== undefined) doc[k] = String(v);
      lines.push(JSON.stringify({ index: { _index: name, _id: d.id } }), JSON.stringify(doc));
    }
    await this.bulk(`${lines.join('\n')}\n`);
  }

  private async bulk(body: string): Promise<void> {
    const headers: Record<string, string> = { 'content-type': 'application/x-ndjson', accept: 'application/json' };
    if (this.cfg.username) headers.authorization = `Basic ${Buffer.from(`${this.cfg.username}:${this.cfg.password ?? ''}`).toString('base64')}`;
    const res = await this.fetchImpl(`${this.cfg.url.replace(/\/+$/, '')}/_bulk?refresh=wait_for`, { method: 'POST', headers, body, signal: AbortSignal.timeout(this.cfg.timeoutMs) });
    const text = await res.text();
    if (!res.ok) throw new Error(`OpenSearch bulk failed: ${res.status} ${text.slice(0, 300)}`);
    const parsed = JSON.parse(text || '{}') as { errors?: boolean };
    if (parsed.errors) throw new Error('OpenSearch bulk reported item errors');
  }

  async remove(index: SearchIndex, ids: string[]): Promise<void> {
    if (!ids.length) return;
    const name = this.indexName(index);
    const lines = ids.map((id) => JSON.stringify({ delete: { _index: name, _id: id } }));
    await this.bulk(`${lines.join('\n')}\n`);
  }

  async match({ index, q, limit }: MatchRequest): Promise<SearchHit[]> {
    const term = q.trim();
    if (term.length < 2) return [];
    const body = {
      size: limit,
      _source: false,
      query: {
        multi_match: {
          query: term,
          fields: index.fields.map((f) => (f.boost && f.boost !== 1 ? `${f.name}^${f.boost}` : f.name)),
          type: 'best_fields',
          operator: 'and',
          fuzziness: 'AUTO',
        },
      },
    };
    const res = await this.call<{ hits: { hits: { _id: string; _score: number }[] } }>('POST', `/${this.indexName(index)}/_search`, body);
    return res.hits.hits.map((h) => ({ id: h._id, score: h._score }));
  }

  async health() {
    try {
      const res = await this.call<{ status?: string }>('GET', '/_cluster/health');
      return { ok: res.status !== 'red', driver: this.driver, detail: `cluster ${res.status ?? 'unknown'}` };
    } catch (err) { return { ok: false, driver: this.driver, detail: err instanceof Error ? err.message : 'unreachable' }; }
  }
}

export interface SearchConfig {
  SEARCH_DRIVER: SearchDriver;
  OPENSEARCH_URL?: string;
  OPENSEARCH_PREFIX: string;
  OPENSEARCH_USERNAME?: string;
  OPENSEARCH_PASSWORD?: string;
  OPENSEARCH_TIMEOUT_MS: number;
}

/**
 * Builds the driver the configuration asks for.
 *
 * `fallback` is the PostgreSQL adapter, and an OpenSearch deployment keeps it: a search engine is not a
 * system of record, and when it is unreachable the register is still there to be searched. `resilient`
 * wraps the pair so a failing engine degrades to a slower search rather than a broken one.
 */
export function createSearch(cfg: SearchConfig, pool: QueryablePool, onFallback?: (err: Error) => void): SearchAdapter {
  const postgres = new PostgresSearchAdapter(pool);
  if (cfg.SEARCH_DRIVER !== 'opensearch') return postgres;
  if (!cfg.OPENSEARCH_URL) throw new Error('SEARCH_DRIVER is opensearch but OPENSEARCH_URL is not set');
  const engine = new OpenSearchAdapter({
    url: cfg.OPENSEARCH_URL, prefix: cfg.OPENSEARCH_PREFIX,
    username: cfg.OPENSEARCH_USERNAME, password: cfg.OPENSEARCH_PASSWORD, timeoutMs: cfg.OPENSEARCH_TIMEOUT_MS,
  });
  return new ResilientSearch(engine, postgres, onFallback);
}

/** Uses the engine, and falls back to the database when it fails. Reports which one answered. */
export class ResilientSearch implements SearchAdapter {
  readonly driver = 'opensearch' as const;
  private fallbacks = 0;
  constructor(private readonly engine: SearchAdapter, private readonly fallback: SearchAdapter, private readonly onFallback?: (err: Error) => void) {}
  async match(req: MatchRequest): Promise<SearchHit[]> {
    try { return await this.engine.match(req); }
    catch (err) {
      this.fallbacks += 1;
      this.onFallback?.(err instanceof Error ? err : new Error(String(err)));
      return this.fallback.match(req);
    }
  }
  async ensure(index: SearchIndex) { return this.engine.ensure(index); }
  async upsert(index: SearchIndex, docs: SearchDoc[]) { return this.engine.upsert(index, docs); }
  async remove(index: SearchIndex, ids: string[]) { return this.engine.remove(index, ids); }
  async health() {
    const h = await this.engine.health();
    return { ...h, detail: `${h.detail}; ${this.fallbacks} fallback(s) to postgres` };
  }
}
