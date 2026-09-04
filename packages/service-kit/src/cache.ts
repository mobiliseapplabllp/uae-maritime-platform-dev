import { createHash } from 'node:crypto';
import type { Principal } from './auth/principal';
import { keysOf } from './scope';

/* A cache in front of a tenancy-scoped read model is a place where one reader can be handed another
 * reader's answer. The predicate that made the answer safe lives in the query; the cache sees only a
 * string. So the scope has to be *in the key*, and it has to get there by construction rather than by
 * the caller remembering — which is what `scopedKey` is for. A key built any other way is a bug waiting
 * for two users with different scopes to ask the same question.
 *
 * Permissions go into the key alongside the scope, because two readers at the same scope with different
 * permissions do not get the same answer either: the dashboard drops the cards a reader cannot open.
 *
 * Cached values are read models, never decisions. Nothing that issues, approves or bills is served from
 * here — a stale licence is a different class of mistake from a stale count. */

export type CacheDriver = 'memory' | 'redis';

export interface CacheStats { hits: number; misses: number; sets: number; evictions: number; errors: number }

export interface Cache {
  readonly driver: CacheDriver;
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T, ttlSec?: number): Promise<void>;
  del(...keys: string[]): Promise<void>;
  /** Drops every key under a prefix. The unit of invalidation: one read model's entries, not the whole cache. */
  delPrefix(prefix: string): Promise<number>;
  /** Read-through: return the cached value, or load it, store it and return it. A loader that throws is not cached. */
  wrap<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T>;
  stats(): CacheStats;
  health(): Promise<{ ok: boolean; driver: CacheDriver; detail: string }>;
  close(): Promise<void>;
}

const newStats = (): CacheStats => ({ hits: 0, misses: 0, sets: 0, evictions: 0, errors: 0 });

/**
 * A cache key that carries the reader's scope and permissions, so an entry cannot be served across a
 * tenancy boundary. The identity is hashed rather than spelled out: a company code in a key is a company
 * code in a log line, a Redis `KEYS` dump and a support screenshot.
 */
export function scopedKey(user: Pick<Principal, 'perms' | 'scope'>, ...parts: (string | number)[]): string {
  const scope = user.scope;
  const identity = JSON.stringify({
    level: scope?.level ?? 'NONE',
    keys: [...keysOf(scope)].sort(),
    perms: [...(user.perms ?? [])].sort(),
  });
  const who = createHash('sha256').update(identity).digest('base64url').slice(0, 16);
  return `${parts.map((p) => String(p)).join(':')}:${who}`;
}

/** A key with no reader in it — for values that are the same for everyone, such as a lookup table. */
export const publicKey = (...parts: (string | number)[]): string => `${parts.map((p) => String(p)).join(':')}:public`;

interface Entry { value: unknown; expiresAt: number }

/**
 * The development and single-process default. Bounded so a long-running service cannot grow without limit;
 * eviction is oldest-first, which for read-model answers is close enough to least-useful.
 */
export class MemoryCache implements Cache {
  readonly driver = 'memory' as const;
  private readonly entries = new Map<string, Entry>();
  private readonly counters = newStats();
  private readonly inflight = new Map<string, Promise<unknown>>();
  constructor(private readonly maxEntries = 5_000, private readonly defaultTtlSec = 60) {}

  private sweep(now: number) {
    for (const [k, e] of this.entries) { if (e.expiresAt <= now) this.entries.delete(k); }
  }
  async get<T>(key: string): Promise<T | undefined> {
    const e = this.entries.get(key);
    if (!e) { this.counters.misses += 1; return undefined; }
    if (e.expiresAt <= Date.now()) { this.entries.delete(key); this.counters.misses += 1; return undefined; }
    this.counters.hits += 1;
    return e.value as T;
  }
  async set<T>(key: string, value: T, ttlSec = this.defaultTtlSec): Promise<void> {
    const now = Date.now();
    if (this.entries.size >= this.maxEntries) {
      this.sweep(now);
      while (this.entries.size >= this.maxEntries) {
        const oldest = this.entries.keys().next();
        if (oldest.done) break;
        this.entries.delete(oldest.value);
        this.counters.evictions += 1;
      }
    }
    this.entries.delete(key); // re-insert so insertion order tracks recency of write
    this.entries.set(key, { value, expiresAt: now + Math.max(1, ttlSec) * 1000 });
    this.counters.sets += 1;
  }
  async del(...keys: string[]): Promise<void> { for (const k of keys) this.entries.delete(k); }
  async delPrefix(prefix: string): Promise<number> {
    let n = 0;
    for (const k of [...this.entries.keys()]) if (k.startsWith(prefix)) { this.entries.delete(k); n += 1; }
    return n;
  }
  async wrap<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T> { return wrapWith(this, this.inflight, key, ttlSec, load); }
  stats(): CacheStats { return { ...this.counters }; }
  async health() { return { ok: true, driver: this.driver, detail: `${this.entries.size} of ${this.maxEntries} entries` }; }
  async close(): Promise<void> { this.entries.clear(); }
}

/** The minimum of ioredis this module uses, so the client can be substituted in a test. */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'EX', ttl: number): Promise<unknown>;
  del(...keys: string[]): Promise<number>;
  scan(cursor: string, match: 'MATCH', pattern: string, count: 'COUNT', n: number): Promise<[string, string[]]>;
  ping(): Promise<string>;
  quit(): Promise<unknown>;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
}

/**
 * Redis or Valkey — the wire protocol is the same, and the deployment picks which one runs.
 *
 * A cache that fails closed takes the service down with it, which is the wrong trade for a read model that
 * can always be recomputed: every operation here degrades to a miss on error, counts it, and lets the
 * caller fall through to the database.
 */
export class RedisCache implements Cache {
  readonly driver = 'redis' as const;
  private readonly counters = newStats();
  private readonly inflight = new Map<string, Promise<unknown>>();
  constructor(private readonly client: RedisLike, private readonly prefix = 'maritime', private readonly defaultTtlSec = 60) {}

  private k(key: string) { return `${this.prefix}:${key}`; }
  async get<T>(key: string): Promise<T | undefined> {
    try {
      const raw = await this.client.get(this.k(key));
      if (raw === null || raw === undefined) { this.counters.misses += 1; return undefined; }
      this.counters.hits += 1;
      return JSON.parse(raw) as T;
    } catch { this.counters.errors += 1; this.counters.misses += 1; return undefined; }
  }
  async set<T>(key: string, value: T, ttlSec = this.defaultTtlSec): Promise<void> {
    try {
      await this.client.set(this.k(key), JSON.stringify(value), 'EX', Math.max(1, Math.round(ttlSec)));
      this.counters.sets += 1;
    } catch { this.counters.errors += 1; }
  }
  async del(...keys: string[]): Promise<void> {
    if (!keys.length) return;
    try { await this.client.del(...keys.map((k) => this.k(k))); } catch { this.counters.errors += 1; }
  }
  /** SCAN rather than KEYS: invalidation must not stall the server the whole platform shares. */
  async delPrefix(prefix: string): Promise<number> {
    let cursor = '0'; let removed = 0;
    try {
      do {
        const [next, batch] = await this.client.scan(cursor, 'MATCH', `${this.k(prefix)}*`, 'COUNT', 500);
        cursor = next;
        if (batch.length) { await this.client.del(...batch); removed += batch.length; }
      } while (cursor !== '0');
    } catch { this.counters.errors += 1; }
    return removed;
  }
  async wrap<T>(key: string, ttlSec: number, load: () => Promise<T>): Promise<T> { return wrapWith(this, this.inflight, key, ttlSec, load); }
  stats(): CacheStats { return { ...this.counters }; }
  async health() {
    try { const pong = await this.client.ping(); return { ok: pong === 'PONG', driver: this.driver, detail: `ping ${pong}` }; }
    catch (err) { return { ok: false, driver: this.driver, detail: err instanceof Error ? err.message : 'unreachable' }; }
  }
  async close(): Promise<void> { await this.client.quit().catch(() => undefined); }
}

/**
 * Shared read-through. The in-flight map collapses a stampede: when twenty requests miss the same key at
 * once, one of them queries and the rest wait on it, instead of twenty identical queries hitting a database
 * that is already the reason the cache exists.
 */
async function wrapWith<T>(cache: Cache, inflight: Map<string, Promise<unknown>>, key: string, ttlSec: number, load: () => Promise<T>): Promise<T> {
  const hit = await cache.get<T>(key);
  if (hit !== undefined) return hit;
  const running = inflight.get(key);
  if (running) return running as Promise<T>;
  const p = (async () => {
    const value = await load();
    if (value !== undefined) await cache.set(key, value, ttlSec);
    return value;
  })().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export interface CacheConfig {
  CACHE_DRIVER: CacheDriver;
  CACHE_URL?: string;
  CACHE_PREFIX: string;
  CACHE_TTL_SEC: number;
  CACHE_MAX_ENTRIES: number;
}

/**
 * Builds the cache the configuration asks for. A redis driver that cannot load its client is a
 * configuration error and says so at boot, rather than silently running without a cache in production.
 */
export async function createCache(cfg: CacheConfig, onError?: (err: Error) => void): Promise<Cache> {
  if (cfg.CACHE_DRIVER !== 'redis') return new MemoryCache(cfg.CACHE_MAX_ENTRIES, cfg.CACHE_TTL_SEC);
  const url = cfg.CACHE_URL;
  if (!url) throw new Error('CACHE_DRIVER is redis but CACHE_URL is not set');
  let Redis: new (url: string, opts: Record<string, unknown>) => RedisLike;
  try {
    const mod = (await import('ioredis')) as unknown as { default: new (url: string, opts: Record<string, unknown>) => RedisLike };
    Redis = mod.default;
  } catch (err) {
    throw new Error(`CACHE_DRIVER is redis but the client could not be loaded: ${err instanceof Error ? err.message : String(err)}`);
  }
  const client = new Redis(url, { maxRetriesPerRequest: 2, enableOfflineQueue: false, lazyConnect: false, connectTimeout: 2_000 });
  client.on('error', (...args: unknown[]) => onError?.(args[0] instanceof Error ? args[0] : new Error(String(args[0]))));
  return new RedisCache(client, cfg.CACHE_PREFIX, cfg.CACHE_TTL_SEC);
}
