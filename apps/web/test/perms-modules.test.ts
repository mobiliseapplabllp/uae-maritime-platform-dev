import { describe, expect, it } from 'vitest';
import { hasPerm } from '../src/utils/perms';
import { MODULES, moduleOf } from '../src/modules';
import type { SessionUser } from '../src/types';

const user = (perms: string[]): SessionUser => ({ id: 'u', name: 'U', email: 'u@x', active: true, kind: 'user', scope: { level: 'NATIONAL' } as never, role: { id: 'r', name: 'R', permissions: perms }, perms });

describe('permissions and module registry', () => {
  it('is deny-by-default with a wildcard for super admins', () => {
    expect(hasPerm(null, 'vessels.view')).toBe(false);
    expect(hasPerm(user([]), 'vessels.view')).toBe(false);
    expect(hasPerm(user(['vessels.view']), 'vessels.view')).toBe(true);
    expect(hasPerm(user(['*']), 'anything.at.all')).toBe(true);
    expect(hasPerm(user([]), undefined)).toBe(true);
  });
  it('resolves the active module from the pathname by longest prefix', () => {
    expect(moduleOf('/').key).toBe('home');
    expect(moduleOf('/port-calls/abc').key).toBe('ops');
    expect(moduleOf('/vessels/survey-planner').key).toBe('ships');
    expect(moduleOf('/masters/tariffs').key).toBe('finance');
    expect(moduleOf('/masters/berths').key).toBe('masters');
    expect(moduleOf('/incidents/overview').key).toBe('incidents');
    expect(moduleOf('/settings/module/crew').key).toBe('crew');
    expect(moduleOf('/nowhere').key).toBe('home');
  });
  it('gives every module a settings page and a permission', () => {
    for (const m of MODULES) {
      expect(m.perm).toMatch(/^[a-z]+\.[a-z]+$/);
      if (m.key !== 'home') expect(m.nav.some((g) => g.items.some((i) => i.to === `/settings/module/${m.key}`))).toBe(true);
    }
  });
});
