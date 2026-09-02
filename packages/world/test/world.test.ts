import { describe, expect, it } from 'vitest';
import { buildWorld, isRealLiner, imoCheck } from '../src';

describe('world', () => {
  const now = new Date('2026-09-02T12:00:00Z');
  const w = buildWorld({ profile: 'AE', now });
  it('makes valid, stable UUIDs', () => { expect(w.users[0].id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/); expect(new Set(w.users.map((u) => u.id)).size).toBe(w.users.length); });
  it('is deterministic', () => { const w2 = buildWorld({ profile: 'AE', now }); expect(w2.users.map((u) => u.email)).toEqual(w.users.map((u) => u.email)); expect(w2.portCalls.length).toBe(w.portCalls.length); });
  it('seeds the seven login accounts, staff and a directory of about 130 users with unique emails', () => {
    expect(w.users.filter((u) => u.login)).toHaveLength(7);
    expect(w.users.length).toBeGreaterThanOrEqual(125);
    expect(new Set(w.users.map((u) => u.email)).size).toBe(w.users.length);
    expect(w.users.find((u) => u.email === 'admin@maritime.example')?.roleName).toBe('Super Admin');
  });
  it('covers all nineteen lookup categories, 24 berths, 18 companies and 31 vessels', () => {
    expect(new Set(w.lookups.map((l) => l.category)).size).toBe(19);
    expect(w.berths).toHaveLength(24); expect(w.companies).toHaveLength(18); expect(w.vessels).toHaveLength(31);
    expect(w.vessels.filter((v) => v.real)).toHaveLength(8);
    for (const v of w.vessels) expect(imoCheck(v.imo.slice(0, 6))).toBe(v.imo[6]);
  });
  it('produces multi-year port-call history plus a live snapshot', () => {
    expect(w.portCalls.length).toBeGreaterThan(900);
    expect(w.portCalls.filter((c) => c.status === 'BERTHED').length).toBeGreaterThan(5);
    expect(w.portCalls[0].eta < '2023-02-01').toBe(true);
    expect(isRealLiner('MSC Anna')).toBe(true);
  });
  it('switches jurisdiction by profile', () => {
    const inw = buildWorld({ profile: 'IN', now });
    expect(inw.settings.find((s) => s.key === 'billing')?.value.taxName).toBe('GST');
    expect(w.settings.find((s) => s.key === 'billing')?.value.taxName).toBe('VAT');
  });
});
