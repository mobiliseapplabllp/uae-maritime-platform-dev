import { describe, expect, it } from 'vitest';
import { signHS256, verifyJwt, decodeJwt } from '../src/auth/jwt';
import { parsePage } from '../src/http/pagination';
import { MemoryBus } from '../src/events/bus';
import { makeEvent } from '@maritime/contracts';
import { stripSecrets } from '../src/audit';
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
