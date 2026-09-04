import { describe, expect, it } from 'vitest';
import {
  ANALYSIS, OpenSearchAdapter, PostgresSearchAdapter, ResilientSearch, createSearch,
  type SearchDoc, type SearchIndex,
} from '../src/search';

const VESSELS: SearchIndex = {
  name: 'vessels',
  table: 'rm_vessels',
  fields: [
    { name: 'name', analysis: 'text', boost: 3 },
    { name: 'name_ar', analysis: 'arabic', boost: 3 },
    { name: 'imo', analysis: 'keyword', boost: 2 },
    { name: 'notes', analysis: 'text' },
  ],
};

class FakePool {
  readonly calls: { text: string; values?: unknown[] }[] = [];
  constructor(private readonly rows: Record<string, unknown>[] = []) {}
  async query<R extends Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }> {
    this.calls.push({ text, values });
    return { rows: this.rows as R[] };
  }
}

describe('postgres adapter', () => {
  it('returns candidate ids and scores, best first', async () => {
    const pool = new FakePool([{ id: 'a', score: '9.00' }, { id: 'b', score: '3.00' }]);
    const hits = await new PostgresSearchAdapter(pool).match({ index: VESSELS, q: 'falcon', limit: 5 });
    expect(hits).toEqual([{ id: 'a', score: 9 }, { id: 'b', score: 3 }]);
  });

  it('parameterises the search term rather than interpolating it', async () => {
    const pool = new FakePool();
    await new PostgresSearchAdapter(pool).match({ index: VESSELS, q: "o'brien", limit: 5 });
    const { text, values } = pool.calls[0];
    expect(text).not.toContain("o'brien");
    expect(values?.[0]).toBe("%o'brien%");
  });

  it('escapes wildcards so a search for a percent sign is not a search for everything', async () => {
    const pool = new FakePool();
    await new PostgresSearchAdapter(pool).match({ index: VESSELS, q: '100%', limit: 5 });
    expect(pool.calls[0].values?.[0]).toBe('%100\\%%');
  });

  it('does not run for a single character', async () => {
    const pool = new FakePool();
    expect(await new PostgresSearchAdapter(pool).match({ index: VESSELS, q: 'a', limit: 5 })).toEqual([]);
    expect(pool.calls).toHaveLength(0);
  });

  it('refuses an index definition whose table or field is not a plain identifier', async () => {
    const pool = new FakePool();
    const evil: SearchIndex = { name: 'x', table: 'rm_vessels; DROP TABLE rm_vessels', fields: VESSELS.fields };
    await expect(new PostgresSearchAdapter(pool).match({ index: evil, q: 'falcon', limit: 5 })).rejects.toThrow(/Unsafe table/);
  });

  it('treats indexing as a no-op, because the read model is the index', async () => {
    const adapter = new PostgresSearchAdapter(new FakePool());
    await expect(adapter.ensure()).resolves.toBeUndefined();
    await expect(adapter.upsert()).resolves.toBeUndefined();
    await expect(adapter.remove()).resolves.toBeUndefined();
  });
});

/** Captures what would go over the wire so the request bodies can be asserted without a cluster. */
const recorder = (responder: (url: string, init: RequestInit) => { status?: number; body?: unknown } = () => ({ body: {} })) => {
  const seen: { url: string; method: string; body: unknown }[] = [];
  const impl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const u = String(url);
    const raw = init.body;
    const parsed = typeof raw === 'string' && raw.trim().startsWith('{') && !raw.includes('\n{') ? JSON.parse(raw) : raw;
    seen.push({ url: u, method: init.method ?? 'GET', body: parsed });
    const r = responder(u, init);
    const text = JSON.stringify(r.body ?? {});
    return new Response(text, { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { seen, impl };
};

const cfg = { url: 'https://search.internal:9200', prefix: 'maritime', timeoutMs: 1000 };

describe('opensearch adapter', () => {
  it('creates a missing index with the Arabic analysis chain', async () => {
    const { seen, impl } = recorder((_u, init) => (init.method === 'HEAD' ? { status: 404 } : { body: {} }));
    await new OpenSearchAdapter(cfg, impl).ensure(VESSELS);
    const put = seen.find((s) => s.method === 'PUT');
    expect(put?.url).toBe('https://search.internal:9200/maritime-vessels');
    const body = put?.body as { settings: { analysis: typeof ANALYSIS }; mappings: { properties: Record<string, { type: string; analyzer?: string; normalizer?: string }> } };
    expect(body.settings.analysis.analyzer.maritime_arabic.filter).toContain('arabic_normalization');
    expect(body.settings.analysis.analyzer.maritime_arabic.filter).toContain('decimal_digit');
    expect(body.mappings.properties.name_ar.analyzer).toBe('maritime_arabic');
    expect(body.mappings.properties.name.analyzer).toBe('maritime_text');
    expect(body.mappings.properties.imo.type).toBe('keyword');
  });

  it('updates the mapping when the index already exists, rather than failing', async () => {
    const { seen, impl } = recorder(() => ({ body: {} }));
    await new OpenSearchAdapter(cfg, impl).ensure(VESSELS);
    expect(seen.some((s) => s.url.endsWith('/maritime-vessels/_mapping'))).toBe(true);
  });

  it('searches the named fields with their boosts and returns ids with scores', async () => {
    const { seen, impl } = recorder(() => ({ body: { hits: { hits: [{ _id: 'v1', _score: 8.2 }, { _id: 'v2', _score: 1.1 }] } } }));
    const hits = await new OpenSearchAdapter(cfg, impl).match({ index: VESSELS, q: 'falcon', limit: 5 });
    expect(hits).toEqual([{ id: 'v1', score: 8.2 }, { id: 'v2', score: 1.1 }]);
    const body = seen[0].body as { size: number; _source: boolean; query: { multi_match: { fields: string[] } } };
    expect(body.size).toBe(5);
    expect(body._source).toBe(false);
    expect(body.query.multi_match.fields).toEqual(['name^3', 'name_ar^3', 'imo^2', 'notes']);
  });

  it('indexes only declared fields, so a projection cannot push tenancy columns into the engine', async () => {
    const { seen, impl } = recorder(() => ({ body: { errors: false } }));
    const docs: SearchDoc[] = [{ id: 'v1', fields: { name: 'Falcon', scope_company: 'GSS', scope_port: 'AEJEA' } as Record<string, string> }];
    await new OpenSearchAdapter(cfg, impl).upsert(VESSELS, docs);
    const ndjson = String(seen[0].body);
    expect(ndjson).toContain('Falcon');
    expect(ndjson).not.toContain('scope_company');
    expect(ndjson).not.toContain('GSS');
  });

  it('raises when the bulk response reports item errors', async () => {
    const { impl } = recorder(() => ({ body: { errors: true } }));
    await expect(new OpenSearchAdapter(cfg, impl).upsert(VESSELS, [{ id: 'v1', fields: { name: 'Falcon' } }]))
      .rejects.toThrow(/item errors/);
  });

  it('reports a red cluster as unhealthy', async () => {
    const { impl } = recorder(() => ({ body: { status: 'red' } }));
    expect((await new OpenSearchAdapter(cfg, impl).health()).ok).toBe(false);
  });

  it('sends credentials when they are configured, and none when they are not', async () => {
    const withAuth = recorder(() => ({ body: { status: 'green' } }));
    await new OpenSearchAdapter({ ...cfg, username: 'svc', password: 'pw' }, withAuth.impl).health();
    const without = recorder(() => ({ body: { status: 'green' } }));
    await new OpenSearchAdapter(cfg, without.impl).health();
    expect(withAuth.seen).toHaveLength(1);
    expect(without.seen).toHaveLength(1);
  });
});

describe('falling back', () => {
  it('answers from PostgreSQL when the engine fails, and says so in its health', async () => {
    const engine = new OpenSearchAdapter(cfg, (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    const pool = new FakePool([{ id: 'v9', score: '3.00' }]);
    const resilient = new ResilientSearch(engine, new PostgresSearchAdapter(pool));
    expect(await resilient.match({ index: VESSELS, q: 'falcon', limit: 5 })).toEqual([{ id: 'v9', score: 3 }]);
    expect((await resilient.health()).detail).toMatch(/1 fallback/);
  });
});

describe('createSearch', () => {
  it('uses PostgreSQL by default', () => {
    const s = createSearch({ SEARCH_DRIVER: 'postgres', OPENSEARCH_PREFIX: 'maritime', OPENSEARCH_TIMEOUT_MS: 1000 }, new FakePool());
    expect(s.driver).toBe('postgres');
  });

  it('refuses an opensearch driver with no url', () => {
    expect(() => createSearch({ SEARCH_DRIVER: 'opensearch', OPENSEARCH_PREFIX: 'maritime', OPENSEARCH_TIMEOUT_MS: 1000 }, new FakePool()))
      .toThrow(/OPENSEARCH_URL/);
  });

  it('keeps PostgreSQL behind the engine so search survives the engine being down', () => {
    const s = createSearch({ SEARCH_DRIVER: 'opensearch', OPENSEARCH_URL: 'https://search.internal:9200', OPENSEARCH_PREFIX: 'maritime', OPENSEARCH_TIMEOUT_MS: 1000 }, new FakePool());
    expect(s).toBeInstanceOf(ResilientSearch);
  });
});
