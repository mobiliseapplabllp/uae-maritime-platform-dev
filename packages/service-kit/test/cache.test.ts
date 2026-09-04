import { describe, expect, it, vi } from 'vitest';
import type { TenancyScope } from '@maritime/contracts';
import { MemoryCache, RedisCache, createCache, publicKey, scopedKey, type Cache, type RedisLike } from '../src/cache';

const principal = (level: TenancyScope['level'], keys: string[], perms: string[]) => {
  const scope = { level, ports: [], zones: [], facilities: [], companies: [] } as unknown as TenancyScope;
  const bucket = { PORT: 'ports', ZONE: 'zones', FACILITY: 'facilities', COMPANY: 'companies', NATIONAL: '' }[level];
  if (bucket) (scope as unknown as Record<string, string[]>)[bucket] = keys;
  return { perms, scope };
};

/** A Redis stand-in with the same semantics this module relies on: string values, EX expiry, SCAN paging. */
class FakeRedis implements RedisLike {
  readonly store = new Map<string, { value: string; expiresAt: number }>();
  failing = false;
  async get(key: string) {
    if (this.failing) throw new Error('connection lost');
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) { this.store.delete(key); return null; }
    return e.value;
  }
  async set(key: string, value: string, _mode: 'EX', ttl: number) {
    if (this.failing) throw new Error('connection lost');
    this.store.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
    return 'OK';
  }
  async del(...keys: string[]) { let n = 0; for (const k of keys) if (this.store.delete(k)) n += 1; return n; }
  async scan(cursor: string, _m: 'MATCH', pattern: string, _c: 'COUNT', n: number): Promise<[string, string[]]> {
    const re = new RegExp(`^${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*')}$`);
    const all = [...this.store.keys()].filter((k) => re.test(k));
    const from = Number(cursor);
    const page = all.slice(from, from + n);
    const next = from + n >= all.length ? '0' : String(from + n);
    return [next, page];
  }
  async ping() { if (this.failing) throw new Error('connection lost'); return 'PONG'; }
  async quit() { return 'OK'; }
  on() { return this; }
}

const both = (): [string, Cache][] => [
  ['memory', new MemoryCache(50, 60)],
  ['redis', new RedisCache(new FakeRedis(), 'test', 60)],
];

describe('cache contract', () => {
  for (const [name, cache] of both()) {
    describe(name, () => {
      it('stores and returns a value, and misses an absent key', async () => {
        await cache.set('a:1', { n: 1 }, 30);
        expect(await cache.get<{ n: number }>('a:1')).toEqual({ n: 1 });
        expect(await cache.get('a:absent')).toBeUndefined();
      });

      it('expires a value once its ttl has passed', async () => {
        vi.useFakeTimers();
        try {
          await cache.set('a:ttl', 'here', 1);
          expect(await cache.get('a:ttl')).toBe('here');
          vi.advanceTimersByTime(1_500);
          expect(await cache.get('a:ttl')).toBeUndefined();
        } finally { vi.useRealTimers(); }
      });

      it('deletes a whole prefix and leaves neighbouring keys alone', async () => {
        await cache.set('stats:vessels:x', 1, 60);
        await cache.set('stats:vessels:y', 2, 60);
        await cache.set('stats:invoices:z', 3, 60);
        const removed = await cache.delPrefix('stats:vessels');
        expect(removed).toBe(2);
        expect(await cache.get('stats:vessels:x')).toBeUndefined();
        expect(await cache.get('stats:invoices:z')).toBe(3);
      });

      it('loads once when many callers miss the same key at the same time', async () => {
        let calls = 0;
        const load = async () => { calls += 1; await new Promise((r) => setTimeout(r, 5)); return 'loaded'; };
        const all = await Promise.all([1, 2, 3, 4, 5].map(() => cache.wrap('stampede', 30, load)));
        expect(all).toEqual(['loaded', 'loaded', 'loaded', 'loaded', 'loaded']);
        expect(calls).toBe(1);
      });

      it('does not cache a loader that throws', async () => {
        await expect(cache.wrap('bad', 30, async () => { throw new Error('database down'); })).rejects.toThrow('database down');
        expect(await cache.get('bad')).toBeUndefined();
      });

      it('reports its health', async () => {
        const h = await cache.health();
        expect(h.ok).toBe(true);
        expect(h.driver).toBe(name);
      });
    });
  }
});

describe('scoped keys', () => {
  /* The reason this module exists. Two readers asking the same question are only allowed the same cache
   * entry when the database would have given them the same answer. */
  it('separates two companies asking the same question', () => {
    const gss = scopedKey(principal('COMPANY', ['GSS'], ['vessels.view']), 'stats', 'fleet');
    const oap = scopedKey(principal('COMPANY', ['OAP'], ['vessels.view']), 'stats', 'fleet');
    expect(gss).not.toBe(oap);
  });

  it('separates a national reader from a company reader', () => {
    const national = scopedKey(principal('NATIONAL', [], ['vessels.view']), 'stats', 'fleet');
    const company = scopedKey(principal('COMPANY', ['GSS'], ['vessels.view']), 'stats', 'fleet');
    expect(national).not.toBe(company);
  });

  it('separates two readers at the same scope holding different permissions', () => {
    const viewer = scopedKey(principal('PORT', ['AEJEA'], ['vessels.view']), 'dashboard');
    const editor = scopedKey(principal('PORT', ['AEJEA'], ['vessels.view', 'vessels.edit']), 'dashboard');
    expect(viewer).not.toBe(editor);
  });

  it('gives the same key to the same reader regardless of list order', () => {
    const a = scopedKey(principal('COMPANY', ['GSS', 'OAP'], ['b.view', 'a.view']), 'stats');
    const b = scopedKey(principal('COMPANY', ['OAP', 'GSS'], ['a.view', 'b.view']), 'stats');
    expect(a).toBe(b);
  });

  it('does not put the tenancy key itself into the string', () => {
    expect(scopedKey(principal('COMPANY', ['GSS'], ['vessels.view']), 'stats')).not.toContain('GSS');
  });

  it('keys public values without a reader', () => {
    expect(publicKey('lookups', 'ports')).toBe('lookups:ports:public');
  });
});

describe('redis failure', () => {
  it('degrades to a miss rather than throwing, so the caller falls through to the database', async () => {
    const redis = new FakeRedis();
    const cache = new RedisCache(redis, 'test', 60);
    await cache.set('k', 'v', 30);
    redis.failing = true;
    expect(await cache.get('k')).toBeUndefined();
    expect(cache.stats().errors).toBeGreaterThan(0);
    const h = await cache.health();
    expect(h.ok).toBe(false);
  });

  it('still returns the loaded value when the backend is unavailable', async () => {
    const redis = new FakeRedis();
    redis.failing = true;
    const cache = new RedisCache(redis, 'test', 60);
    expect(await cache.wrap('k', 30, async () => 'from the database')).toBe('from the database');
  });
});

describe('memory cache bounds', () => {
  it('evicts rather than growing without limit', async () => {
    const cache = new MemoryCache(10, 60);
    for (let i = 0; i < 25; i += 1) await cache.set(`k${i}`, i, 60);
    expect(cache.stats().evictions).toBeGreaterThan(0);
    expect(await cache.get('k24')).toBe(24);
  });
});

describe('createCache', () => {
  it('builds the in-process cache by default', async () => {
    const cache = await createCache({ CACHE_DRIVER: 'memory', CACHE_PREFIX: 'maritime', CACHE_TTL_SEC: 60, CACHE_MAX_ENTRIES: 100 });
    expect(cache.driver).toBe('memory');
  });

  it('refuses to start on a redis driver with no url, rather than silently running without a cache', async () => {
    await expect(createCache({ CACHE_DRIVER: 'redis', CACHE_PREFIX: 'maritime', CACHE_TTL_SEC: 60, CACHE_MAX_ENTRIES: 100 }))
      .rejects.toThrow(/CACHE_URL/);
  });
});
