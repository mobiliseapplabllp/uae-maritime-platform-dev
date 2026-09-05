import { describe, expect, it } from 'vitest';
import {
  ALL_PERMISSIONS, PERMISSION_GROUPS, ROLE_CATALOGUE, hasPerm, isKnownPermission,
  canTransition, PORTCALL_TRANSITIONS, INSTRUMENT_TRANSITIONS, REQUEST_TRANSITIONS, REGISTRATION_TRANSITIONS, INCIDENT_TRANSITIONS, LICENSE_TRANSITIONS,
  LICENSE_TYPES, instrumentClassOf, numberPrefixOf, validityMonthsOf, typeAllowedFor,
  makeEvent, EVENTS, subjectFor, getJurisdiction, unconfirmedFigures, LOOKUP_CATEGORIES, lookupCategory, pick,
  PASSWORD_MIN, PASSWORD_RULE_TEXT, passwordAcceptable, passwordProblems,
} from '../src';

describe('permission catalogue', () => {
  it('has 24 groups producing exactly 66 permissions', () => {
    expect(PERMISSION_GROUPS).toHaveLength(24);
    expect(ALL_PERMISSIONS).toHaveLength(66);
    expect(new Set(ALL_PERMISSIONS).size).toBe(66);
  });
  it('seeds seventeen roles whose permissions are all known, eleven of them system roles', () => {
    expect(ROLE_CATALOGUE).toHaveLength(17);
    expect(ROLE_CATALOGUE.filter((r) => r.system)).toHaveLength(11);
    for (const r of ROLE_CATALOGUE) for (const p of r.permissions) expect(isKnownPermission(p), `${r.name}: ${p}`).toBe(true);
    const counts = Object.fromEntries(ROLE_CATALOGUE.map((r) => [r.code, r.permissions.length]));
    expect(counts).toMatchObject({ HM: 27, MS: 26, FO: 16, AG: 12, MA: 10, ND: 14, TS: 8, HO: 9, BC: 7, SO: 6, PP: 5, LO: 11, AP: 10, RS: 23, MV: 17, AIG: 8 });
  });

  it('lets somebody other than the administrator approve a model version', () => {
    // A model version may not be approved by whoever created it. If the wildcard were the only permission
    // that could approve one, the gate would be unsatisfiable wherever a single administrator is seeded —
    // a blocked pipeline rather than a control. At least one role that is not the wildcard must be able to.
    const approvers = ROLE_CATALOGUE.filter((r) => !r.permissions.includes('*') && r.permissions.includes('models.manage'));
    expect(approvers.map((r) => r.code)).toContain('AIG');
    const aig = ROLE_CATALOGUE.find((r) => r.code === 'AIG')!;
    expect(aig.permissions).toContain('models.deploy');
    // and it governs models only — it reaches no register, instrument or ledger of its own
    for (const p of aig.permissions) expect(p, p).not.toMatch(/^(vessels|portcalls|invoices|seafarers|registry|services|incidents|inspections|certificates|tariffs)\./);
  });

  it('gives the two external roles disjoint reach', () => {
    // A shipping agent and a manning agency are both company-scoped tenants, and they are not the same
    // tenant: one lodges calls and pays invoices, the other places seafarers. Neither should acquire the
    // other's register by being external.
    const role = (code: string) => ROLE_CATALOGUE.find((r) => r.code === code)!;
    expect(role('AG').permissions).not.toContain('seafarers.view');
    expect(role('MA').permissions).not.toContain('portcalls.view');
    expect(role('MA').permissions).not.toContain('invoices.view');
    // neither may reach anything the administration keeps to itself
    for (const code of ['AG', 'MA']) {
      for (const withheld of ['users.view', 'incidents.view', 'inspections.view', 'audit.view', 'settings.manage', 'nmc.view']) {
        expect(role(code).permissions, `${code} holds ${withheld}`).not.toContain(withheld);
      }
    }
  });
  it('denies by default and honours the wildcard', () => {
    expect(hasPerm(['vessels.view'], 'vessels.view')).toBe(true);
    expect(hasPerm(['vessels.view'], 'vessels.edit')).toBe(false);
    expect(hasPerm(['*'], 'anything.at.all')).toBe(true);
    expect(hasPerm(undefined, 'vessels.view')).toBe(false);
  });
  it('keeps the two acts that confer legal status with one office each', () => {
    const grant = ROLE_CATALOGUE.filter((r) => r.permissions.includes('registry.grant')).map((r) => r.code);
    const issue = ROLE_CATALOGUE.filter((r) => r.permissions.includes('certificates.manage')).map((r) => r.code);
    expect(grant).toEqual(['RS']);
    expect(issue).toEqual(['MS', 'RS']);
    const both = ROLE_CATALOGUE.filter((r) => r.permissions.includes('legislation.manage') && r.permissions.includes('legislation.approve'));
    expect(both).toHaveLength(0);
  });
});

describe('lifecycles', () => {
  it('walks port calls forward only', () => {
    expect(canTransition(PORTCALL_TRANSITIONS, 'ANNOUNCED', 'CONFIRMED')).toBe(true);
    expect(canTransition(PORTCALL_TRANSITIONS, 'BERTHED', 'ANNOUNCED')).toBe(false);
    expect(canTransition(PORTCALL_TRANSITIONS, 'SAILED', 'BERTHED')).toBe(false);
  });
  it('never walks an instrument backwards', () => {
    expect(canTransition(INSTRUMENT_TRANSITIONS, 'DRAFT', 'IN_FORCE')).toBe(true);
    expect(canTransition(INSTRUMENT_TRANSITIONS, 'SUPERSEDED', 'IN_FORCE')).toBe(false);
  });
  it('allows reinstatement, reopening and info requests where the reference does', () => {
    expect(canTransition(LICENSE_TRANSITIONS, 'SUSPENDED', 'ISSUED')).toBe(true);
    expect(canTransition(INCIDENT_TRANSITIONS, 'CLOSED', 'RESPONDING')).toBe(true);
    expect(canTransition(REQUEST_TRANSITIONS, 'INFO_REQUESTED', 'UNDER_ASSESSMENT')).toBe(true);
    expect(canTransition(REGISTRATION_TRANSITIONS, 'UNDER_SCRUTINY', 'GRANTED')).toBe(false);
  });
});

describe('instrument engine constants', () => {
  it('classifies, numbers and dates every type', () => {
    for (const t of LICENSE_TYPES) {
      expect(instrumentClassOf(t)).toBeTruthy();
      expect(numberPrefixOf(t)).toMatch(/^[A-Z-]+$/);
      expect(validityMonthsOf(t)).toBeGreaterThan(0);
    }
    expect(numberPrefixOf('NAVIGATION_LICENCE')).toBe('NAV');
    expect(validityMonthsOf('TONNAGE_CERTIFICATE')).toBe(1200);
    expect(typeAllowedFor('VESSEL', 'NAVIGATION_LICENCE')).toBe(true);
    expect(typeAllowedFor('SEAFARER', 'NAVIGATION_LICENCE')).toBe(false);
  });
});

describe('events, jurisdictions, reference', () => {
  it('builds a CloudEvents-style envelope with correlation id', () => {
    const e = makeEvent({ type: EVENTS.audit.recorded, source: 'identity-access', data: { a: 1 } });
    expect(e.specversion).toBe('1.0');
    expect(e.id).toMatch(/[0-9a-f-]{36}/);
    expect(e.correlationid).toBeTruthy();
    expect(subjectFor(e.type)).toBe('maritime.audit.recorded');
  });
  it('defaults to the UAE profile and flags every unconfirmed figure', () => {
    expect(getJurisdiction().code).toBe('AE');
    expect(getJurisdiction('in').code).toBe('IN');
    expect(unconfirmedFigures('AE').map((u) => u.key)).toContain('registry.shareDenominator');
  });
  it('declares every master the platform reads from data, each with a group and an Arabic label', () => {
    expect(LOOKUP_CATEGORIES).toHaveLength(48);
    expect(new Set(LOOKUP_CATEGORIES.map((c) => c.key)).size).toBe(48);
    for (const c of LOOKUP_CATEGORIES) { expect(c.group).toBeTruthy(); expect(c.labelAr).toBeTruthy(); for (const m of c.metaFields ?? []) expect(m.key).toMatch(/^[a-z][A-Za-z0-9]*$/); }
    // the vocabularies the five Phase 3 domains validate against
    for (const k of ['accreditationCategory', 'visitType', 'registrationKind', 'registryTransactionType', 'seafarerRank', 'metProgramme', 'crewListSource', 'legalInstrumentType', 'imoSource', 'inspectionRegime']) expect(lookupCategory(k)).toBeDefined();
    expect(lookupCategory('accreditationCategory')?.system).toBe(true);
    expect(pick({ en: 'Hello', ar: 'مرحبا' }, 'ar')).toBe('مرحبا');
    expect(pick({ en: 'Hello' }, 'ar')).toBe('Hello');
  });
});

describe('password policy', () => {
  it('states one rule and enforces exactly that rule', () => {
    expect(PASSWORD_RULE_TEXT).toContain(String(PASSWORD_MIN));
    expect(passwordProblems('Harbourmaster2026')).toEqual([]);
    expect(passwordAcceptable('Harbourmaster2026')).toBe(true);
  });

  it('names every reason at once rather than one per round trip', () => {
    const problems = passwordProblems('short');
    expect(problems.length).toBeGreaterThan(1);
    expect(problems.join(' ')).toContain(String(PASSWORD_MIN));
    expect(problems.join(' ')).toMatch(/upper-case/);
  });

  it('rejects what composition rules alone would pass', () => {
    // long enough, three character classes, and still the first thing anyone tries
    expect(passwordProblems('Password1234')).not.toEqual([]);
    expect(passwordProblems('Qwertyuiop12A')).not.toEqual([]);
    expect(passwordProblems('AAAAAAAAAAAA')).not.toEqual([]);
  });

  it('refuses a password built out of the account it protects', () => {
    const subject = { email: 'rakesh.nair@maritime.example', name: 'Rakesh Nair' };
    expect(passwordProblems('Rakesh.Nair2026', subject).join(' ')).toContain('e-mail address');
    expect(passwordProblems('Nair-Is-Here-9', subject).join(' ')).toContain('your name');
    expect(passwordProblems('Khalifa-Quay-71', subject)).toEqual([]);
  });

  it('treats a missing password as a problem, not as a pass', () => {
    for (const bad of [undefined, null, '', 42, {}]) expect(passwordProblems(bad)).not.toEqual([]);
  });
});
