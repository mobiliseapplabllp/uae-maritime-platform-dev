import { describe, expect, it } from 'vitest';
import { assertProductionSafe, loadEnv, baseEnvSchema } from '../src/config';
import { signHS256, verifyJwt, decodeJwt } from '../src/auth/jwt';
import { parsePage } from '../src/http/pagination';
import { MemoryBus } from '../src/events/bus';
import { makeEvent } from '@maritime/contracts';
import { stripSecrets } from '../src/audit';
import { ApiError } from '../src/http/envelope';
import { CONTAINMENT, assertInScope, isNational, keysOf, scopeColumn, scopeDdl, scopeOfRecord, scopeWhere, visibleTo, type ScopeOptions } from '../src/scope';
import type { TenancyScope } from '@maritime/contracts';
import { loadEnv, baseEnvSchema } from '../src/config';

describe('jwt', () => {
  it('signs and verifies HS256 with expiry and issuer checks', async () => {
    const t = signHS256({ sub: 'u1', name: 'A' }, 'secret-secret', { expiresInSec: 60, issuer: 'iss' });
    const claims = await verifyJwt(t, { hsSecret: 'secret-secret', issuer: 'iss' });
    expect(claims.sub).toBe('u1');
    await expect(verifyJwt(t, { hsSecret: 'other-secret-x' })).rejects.toThrow('Invalid signature');
    await expect(verifyJwt(t, { hsSecret: 'secret-secret', issuer: 'nope' })).rejects.toThrow('Wrong issuer');
    const expired = signHS256({ sub: 'u1' }, 'secret-secret', { expiresInSec: -120 });
    await expect(verifyJwt(expired, { hsSecret: 'secret-secret' })).rejects.toThrow('Token expired');
  });
  it('rejects alg none and malformed tokens', async () => {
    const [h, p] = signHS256({ sub: 'x' }, 's', { expiresInSec: 10 }).split('.');
    const none = `${Buffer.from(JSON.stringify({ alg: 'none' })).toString('base64url')}.${p}.`;
    await expect(verifyJwt(none, { hsSecret: 's' })).rejects.toThrow('Unsupported algorithm');
    expect(() => decodeJwt('abc')).toThrow('Malformed');
    expect(h.length).toBeGreaterThan(0);
  });
});

describe('pagination', () => {
  it('applies defaults, caps and descending sort', () => {
    const p = parsePage({ page: '3', limit: '500', sort: '-name', q: '  x ' }, { sortable: ['name', 'createdAt'] });
    expect(p).toMatchObject({ page: 3, limit: 100, offset: 200, sortField: 'name', sortDir: 'desc', q: 'x' });
    expect(parsePage({ sort: 'hack' }, { sortable: ['name'], defaultSort: '-name' }).sortField).toBe('name');
  });
});

describe('memory bus', () => {
  it('delivers by wildcard and in order', async () => {
    const bus = new MemoryBus(); const seen: string[] = [];
    await bus.subscribe('t', ['maritime.audit.>'], async (e) => { seen.push(e.type); });
    await bus.publish('maritime.audit.recorded', makeEvent({ type: 'audit.recorded', source: 't', data: {} }));
    await bus.publish('maritime.mdm.lookup.changed', makeEvent({ type: 'mdm.lookup.changed', source: 't', data: {} }));
    await bus.drain();
    expect(seen).toEqual(['audit.recorded']);
  });
});

describe('audit and config', () => {
  it('never lets secrets into audit snapshots', () => {
    expect(stripSecrets({ a: 1, passwordHash: 'x', nested: { apiKey: 'k', b: 2 } })).toEqual({ a: 1, nested: { b: 2 } });
  });
  it('loads a validated environment with defaults', () => {
    const env = loadEnv(baseEnvSchema, { PORT: '5555' } as never);
    expect(env.PORT).toBe(5555); expect(env.AUTH_MODE).toBe('local');
    expect(() => loadEnv(baseEnvSchema, { PORT: 'x' } as never)).toThrow('Invalid environment');
  });
});

describe('production configuration guard', () => {
  it('refuses development defaults in production and accepts a hardened configuration', () => {
    const base = { NODE_ENV: 'production', AUTH_MODE: 'keycloak', KEYCLOAK_ISSUER: 'https://sso.example/realms/maritime', DATABASE_URL: 'postgres://svc:s3cret@db/maritime_x' };
    expect(assertProductionSafe({ ...base, JWT_SECRET: 'development-only-secret-change-me', SERVICE_TOKEN: 'development-service-token' })).toHaveLength(2);
    expect(assertProductionSafe({ ...base, JWT_SECRET: 'x'.repeat(40), SERVICE_TOKEN: 'y'.repeat(40) })).toEqual([]);
    expect(assertProductionSafe({ ...base, AUTH_MODE: 'local', JWT_SECRET: 'x'.repeat(40), SERVICE_TOKEN: 'y'.repeat(40) })).toContain('AUTH_MODE must be keycloak in production');
    expect(() => loadEnv(baseEnvSchema, { NODE_ENV: 'production' } as never)).toThrow(/Unsafe production configuration/);
    expect(assertProductionSafe({ NODE_ENV: 'development' })).toEqual([]);
  });
});

/* ============================================================================ tenancy scope === */

describe('tenancy scope', () => {
  const national: TenancyScope = { level: 'NATIONAL' };
  const khalifa: TenancyScope = { level: 'PORT', ports: ['AEAUH'] };
  const twoPorts: TenancyScope = { level: 'PORT', ports: ['AEAUH', 'AEFJR'] };
  const agent: TenancyScope = { level: 'COMPANY', companies: ['MAR-AG-014'] };
  const unassignedPort: TenancyScope = { level: 'PORT' };
  const unassignedCompany: TenancyScope = { level: 'COMPANY' };

  /** A port-partitioned operational register, e.g. the call register. */
  const operational: ScopeOptions = { columns: ['port', 'company'] };
  /** A register the administration keeps to itself: no company column, and not public to companies. */
  const internal: ScopeOptions = { columns: ['port'], publicToCompanies: false };
  /** Public infrastructure and published rules: no company column, and readable by every company. */
  const published: ScopeOptions = { columns: [], publicToCompanies: true };

  const build = (scope: TenancyScope | undefined, opts: ScopeOptions) => {
    const where: string[] = []; const args: unknown[] = [];
    const added = scopeWhere(scope, where, args, opts);
    return { added, sql: where.join(' AND '), args };
  };

  it('adds no clause at all for a national principal', () => {
    for (const opts of [operational, internal, published]) {
      const q = build(national, opts);
      expect(q.added).toBe(false); expect(q.sql).toBe(''); expect(q.args).toEqual([]);
    }
  });

  it('treats a port as containment: a record naming no port is above every port, so every port sees it', () => {
    const q = build(khalifa, operational);
    expect(q.added).toBe(true);
    expect(q.sql).toBe("(scope_port = '' OR scope_port = ANY($1))");
    expect(q.args).toEqual([['AEAUH']]);
    expect(build(twoPorts, operational).args).toEqual([['AEAUH', 'AEFJR']]);
    expect(build(khalifa, { ...operational, alias: 'pc' }).sql).toContain('pc.scope_port');
    // scoped to the level but assigned no port: the shared records and nothing else
    expect(build(unassignedPort, operational).sql).toBe("scope_port = ''");
  });

  it('treats a company as ownership: a record naming no company belongs to nobody, not to everybody', () => {
    const q = build(agent, operational);
    expect(q.added).toBe(true);
    // no empty escape here — this is the clause that would empty the model if it were written like the port one
    expect(q.sql).toBe('scope_company = ANY($1)');
    expect(q.args).toEqual([['MAR-AG-014']]);
    expect(build(unassignedCompany, operational).sql).toBe('false');
  });

  it('does not restrict a register that is not partitioned the way the reader is scoped', () => {
    // the ship register belongs to the administration, not to a port, so a port officer reads all of it
    expect(build(khalifa, { columns: ['company'] }).added).toBe(false);
    expect(build(khalifa, published).added).toBe(false);
  });

  it('makes a register with no company column say whether a company may read it, and denies when it does not', () => {
    expect(build(agent, published).added).toBe(false);
    expect(build(agent, internal).sql).toBe('false');
    // unstated is denied: a clause that quietly matches everything is how a tenancy model empties out
    expect(build(agent, { columns: ['port'] }).sql).toBe('false');
  });

  it('reads only the list belonging to the principal\'s own level, so another list cannot widen it', () => {
    const mixed: TenancyScope = { level: 'PORT', ports: ['AEAUH'], companies: ['ANY-CO'] };
    expect(build(mixed, operational).args).toEqual([['AEAUH']]);
    expect(keysOf(agent)).toEqual(['MAR-AG-014']);
    expect(keysOf({ level: 'COMPANY' })).toEqual([]);
    // duplicates and blanks in a stored scope must not reach the query
    expect(keysOf({ level: 'PORT', ports: ['AEAUH', 'AEAUH', ''] })).toEqual(['AEAUH']);
    expect(isNational(undefined)).toBe(false);
    expect(build({ level: 'MADE_UP' } as never, operational).sql).toBe('false');
    expect(build(undefined, operational).sql).toBe('false');
  });

  it('applies the same rule to a record already in hand, in either column style', () => {
    const own = { scope_port: 'AEAUH', scope_company: 'MAR-AG-014' };
    const elsewhere = { scope_port: 'AEFJR', scope_company: 'MAR-AG-099' };
    const federal = { scope_port: '', scope_company: '' };
    expect(visibleTo(khalifa, own, operational)).toBe(true);
    expect(visibleTo(khalifa, elsewhere, operational)).toBe(false);
    expect(visibleTo(khalifa, federal, operational)).toBe(true);
    expect(visibleTo(national, elsewhere, operational)).toBe(true);
    expect(visibleTo(khalifa, { port: 'AEAUH' }, operational)).toBe(true);
    // ownership: the unowned record is nobody's, however national it looks
    expect(visibleTo(agent, own, operational)).toBe(true);
    expect(visibleTo(agent, federal, operational)).toBe(false);
    expect(visibleTo(agent, elsewhere, operational)).toBe(false);
    expect(visibleTo(agent, own, published)).toBe(true);
    expect(visibleTo(agent, own, internal)).toBe(false);
    expect(visibleTo(khalifa, undefined, operational)).toBe(false);
  });

  it('answers "not found" for a record outside the scope, so its existence is not disclosed', () => {
    const elsewhere = { scope_port: 'AEFJR' };
    expect(() => assertInScope(khalifa, elsewhere, operational, 'Port call')).toThrow('Port call not found');
    try { assertInScope(khalifa, elsewhere, operational); } catch (e) { expect((e as ApiError).status).toBe(404); }
    expect(() => assertInScope(khalifa, { scope_port: 'AEAUH' }, operational)).not.toThrow();
    expect(() => assertInScope(national, elsewhere, operational)).not.toThrow();
  });

  it('stamps a new record with the one key its author unambiguously has', () => {
    expect(scopeOfRecord(khalifa)).toEqual({ port: 'AEAUH' });
    expect(scopeOfRecord(agent)).toEqual({ company: 'MAR-AG-014' });
    expect(scopeOfRecord(national)).toEqual({});
    // an author scoped to two ports has no single one to stamp; the record is left unpartitioned, not guessed
    expect(scopeOfRecord(twoPorts)).toEqual({});
    expect(scopeOfRecord(unassignedPort)).toEqual({});
  });

  it('names its columns the one way, so a migration and the predicate cannot drift', () => {
    expect(scopeColumn('port')).toBe('scope_port');
    expect(scopeDdl('port', 'company')).toBe("scope_port text NOT NULL DEFAULT '', scope_company text NOT NULL DEFAULT ''");
    expect(CONTAINMENT).toEqual(['port', 'zone', 'facility']);
  });
});
