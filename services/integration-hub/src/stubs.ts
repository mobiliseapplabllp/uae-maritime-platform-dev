import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/* Stub mode answers from a recorded fixture rather than calling the counterpart.
 *
 * Plan v2 named WireMock for this. WireMock needs a JVM, and this platform installs and runs with
 * no Java anywhere — adding one to bootstrap.sh for every developer and every CI run is a real cost
 * for a recorded HTTP response. The fixtures are served in-process instead, which keeps the contract
 * in the repository next to the adapter that implements it and lets the contract test read exactly
 * the file the runtime reads. The trade is that the stub cannot exercise the counterpart's own
 * transport quirks; those surface at live-connection time, which is when a certification pack is
 * re-run anyway. */

export interface Fixture {
  /** Status the counterpart returns for this operation in the recorded contract. */
  status: number;
  body: unknown;
  /** Set on a fixture that records a counterpart's failure, so retry behaviour can be exercised. */
  failTimes?: number;
}

const DIR = join(__dirname, '..', 'stubs');
const cache = new Map<string, Fixture>();

export const fixturePath = (adapter: string, operation: string) => join(DIR, adapter, `${operation}.json`);

export function loadFixture(adapter: string, operation: string): Fixture | null {
  const key = `${adapter}/${operation}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const path = fixturePath(adapter, operation);
  if (!existsSync(path)) return null;
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Fixture;
  cache.set(key, parsed);
  return parsed;
}

/** Substitutes {placeholders} in a recorded body from the request, so a stub answer reflects what
 *  was actually asked rather than always returning the same identifiers. */
export function materialise(body: unknown, payload: Record<string, unknown>): unknown {
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      return v.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k: string) => (k in payload ? String(payload[k]) : m));
    }
    if (Array.isArray(v)) return v.map(walk);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(body);
}

export const clearFixtureCache = () => cache.clear();
