import { describe, expect, it, vi } from 'vitest';
import type { TenancyScope } from '@maritime/contracts';
import { EVENTS, makeEvent, subjectFor } from '@maritime/contracts';
import { base32Decode, base32Encode, generateRecoveryCodes, generateTotpSecret, hotp, otpauthUri, totpCode, verifyTotp } from '../src/auth/totp';
import { keysAt, keysOf, scopeWhere, visibleTo, type ScopeOptions } from '../src/scope';
import { MemoryBus } from '../src/events/bus';
import { HttpPrincipalResolver } from '../src/auth/principal';
import { SettingsClient } from '../src/settings-client';
import { startKitWatches } from '../src/kit.module';
import { createLogger } from '../src/logger';

describe('time-based one-time passwords', () => {
  // RFC 6238 appendix B: the SHA-1 secret "12345678901234567890" at T = 59 s (step 1) gives 94287082 — the last six digits are the six-digit code
  const RFC_SECRET = base32Encode(Buffer.from('12345678901234567890', 'ascii'));
  it('reproduces the RFC 6238 test vector', () => {
    expect(RFC_SECRET).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(hotp(RFC_SECRET, 1)).toBe('287082');
    expect(totpCode(RFC_SECRET, 59_000)).toBe('287082');
    expect(hotp(RFC_SECRET, Math.floor(1111111109 / 30))).toBe('081804');
  });
  it('round-trips base32 and makes secrets an authenticator app accepts', () => {
    const s = generateTotpSecret();
    expect(s).toMatch(/^[A-Z2-7]{32}$/);
    expect(base32Encode(base32Decode(s))).toBe(s);
    expect(otpauthUri('Maritime Platform', 'a@b.example', s)).toBe(`otpauth://totp/Maritime%20Platform:a%40b.example?secret=${s}&issuer=Maritime%20Platform&algorithm=SHA1&digits=6&period=30`);
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8); for (const c of codes) expect(c).toMatch(/^[a-z2-7]{4}-[a-z2-7]{4}$/);
    expect(new Set(codes).size).toBe(8);
  });
  it('accepts one step of drift either way, refuses anything older, and never accepts a step twice', () => {
    const at = 1_700_000_000_000; const step = Math.floor(at / 1000 / 30);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step), { at })).toBe(step);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 1), { at })).toBe(step - 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), { at })).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step - 2), { at })).toBeNull();
    // a replay: the step already accepted, and every earlier one, is refused even though the arithmetic still holds
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step), { at, notBefore: step })).toBeNull();
    expect(verifyTotp(RFC_SECRET, hotp(RFC_SECRET, step + 1), { at, notBefore: step })).toBe(step + 1);
    expect(verifyTotp(RFC_SECRET, '12345', { at })).toBeNull();
    expect(verifyTotp(RFC_SECRET, 'abcdef', { at })).toBeNull();
    expect(verifyTotp(RFC_SECRET, ` ${hotp(RFC_SECRET, step).slice(0, 3)} ${hotp(RFC_SECRET, step).slice(3)} `, { at })).toBe(step);
  });
});

describe('containment is a hierarchy', () => {
  const portOnly: ScopeOptions = { columns: ['port'] };
  const facilityRegister: ScopeOptions = { columns: ['facility', 'port'] };
  const build = (scope: TenancyScope | undefined, opts: ScopeOptions) => { const where: string[] = []; const args: unknown[] = []; const added = scopeWhere(scope, where, args, opts); return { added, sql: where.join(' AND '), args }; };
  const terminal: TenancyScope = { level: 'FACILITY', facilities: ['CT3-1'], ports: ['AEAUH'] };
  const terminalNoPort: TenancyScope = { level: 'FACILITY', facilities: ['CT3-1'] };
  it('contains a facility reader to their port on a register that is partitioned by port but not by facility', () => {
    const r = build(terminal, portOnly);
    expect(r.added).toBe(true); expect(r.sql).toBe("(scope_port = '' OR scope_port = ANY($1))"); expect(r.args).toEqual([['AEAUH']]);
    expect(visibleTo(terminal, { scope_port: 'AEAUH' }, portOnly)).toBe(true);
    expect(visibleTo(terminal, { scope_port: 'AEFJR' }, portOnly)).toBe(false);
    expect(visibleTo(terminal, { scope_port: '' }, portOnly)).toBe(true);
  });
  it('restricts on the facility itself where the register carries it, and reads the port list only as containment', () => {
    const r = build(terminal, facilityRegister);
    expect(r.sql).toBe("(scope_facility = '' OR scope_facility = ANY($1))"); expect(r.args).toEqual([['CT3-1']]);
    expect(keysOf(terminal)).toEqual(['CT3-1']); expect(keysAt(terminal, 'port')).toEqual(['AEAUH']);
    expect(visibleTo(terminal, { scope_facility: 'CT4-1', scope_port: 'AEAUH' }, facilityRegister)).toBe(false);
  });
  it('leaves a facility reader unrestricted on a port register when the scope names no port — nothing to narrow to', () => {
    expect(build(terminalNoPort, portOnly).added).toBe(false);
    expect(visibleTo(terminalNoPort, { scope_port: 'AEFJR' }, portOnly)).toBe(true);
  });
  it('never lets the broader list widen a narrower one', () => {
    // a port reader's facilities list is not read at all, and a company reader is unaffected by containment
    expect(build({ level: 'PORT', ports: ['AEAUH'], facilities: ['CT3-1'] }, facilityRegister).args).toEqual([['AEAUH']]);
    expect(build({ level: 'COMPANY', companies: ['GSS'], ports: ['AEAUH'] }, { columns: ['port'], publicToCompanies: false }).sql).toBe('false');
  });
});

describe('a service drops what it cached the moment identity says it changed', () => {
  it('re-resolves a principal after a user, role or session event, and keys the cache by session', async () => {
    const bus = new MemoryBus();
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => { calls.push(url); return { ok: true, status: 200, json: async () => ({ success: true, data: { id: 'u1', sub: 'u1', name: 'A', email: 'a@x', perms: ['dashboard.view'], scope: { level: 'NATIONAL' }, kind: 'user', active: true } }) }; });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const resolver = new HttpPrincipalResolver('http://identity.test', 'tok');
      const settings = new SettingsClient('http://mdm.test', 'tok');
      const watches = await startKitWatches(bus, resolver, settings, createLogger('test', 'silent'));
      await resolver.resolve({ sub: 'u1', sid: 's1' }); await resolver.resolve({ sub: 'u1', sid: 's1' });
      expect(calls).toHaveLength(1); expect(calls[0]).toBe('http://identity.test/internal/principals/u1?sid=s1');
      // a second session of the same person is its own entry
      await resolver.resolve({ sub: 'u1', sid: 's2' }); expect(calls).toHaveLength(2);
      await bus.publish(subjectFor(EVENTS.identity.userChanged), makeEvent({ type: EVENTS.identity.userChanged, source: 'identity-access', data: { userId: 'u1', change: 'updated' } })); await bus.drain();
      await resolver.resolve({ sub: 'u1', sid: 's1' }); expect(calls).toHaveLength(3);
      await bus.publish(subjectFor(EVENTS.identity.sessionRevoked), makeEvent({ type: EVENTS.identity.sessionRevoked, source: 'identity-access', data: { userId: 'u1', family: 's1' } })); await bus.drain();
      await resolver.resolve({ sub: 'u1', sid: 's1' }); expect(calls).toHaveLength(4);
      // a role change may touch anyone, so everything goes
      await resolver.resolve({ sub: 'u2' }); expect(calls).toHaveLength(5);
      await bus.publish(subjectFor(EVENTS.identity.roleChanged), makeEvent({ type: EVENTS.identity.roleChanged, source: 'identity-access', data: { roleId: 'r1' } })); await bus.drain();
      await resolver.resolve({ sub: 'u2' }); expect(calls).toHaveLength(6);
      for (const w of watches) await w.stop();
    } finally { vi.unstubAllGlobals(); }
  });
});
