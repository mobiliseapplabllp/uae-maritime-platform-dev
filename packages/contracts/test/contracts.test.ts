import { describe, expect, it } from 'vitest';
import { DEFAULT_KPI_TARGETS, evaluateInspectionKpis, kpiTargetsFrom, requiredToday, type KpiTimelineRow } from '../src/inspection-kpis';
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
    expect(LOOKUP_CATEGORIES).toHaveLength(49);
    expect(new Set(LOOKUP_CATEGORIES.map((c) => c.key)).size).toBe(49);
    for (const c of LOOKUP_CATEGORIES) { expect(c.group).toBeTruthy(); expect(c.labelAr).toBeTruthy(); for (const m of c.metaFields ?? []) expect(m.key).toMatch(/^[a-z][A-Za-z0-9]*$/); }
    // the vocabularies the five Phase 3 domains validate against
    for (const k of ['accreditationCategory', 'visitType', 'registrationKind', 'registryTransactionType', 'seafarerRank', 'seafarerCertType', 'metProgramme', 'metInstitutionType', 'crewListSource', 'tradingArea', 'legalInstrumentType', 'imoSource', 'inspectionRegime']) expect(lookupCategory(k)).toBeDefined();
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

describe('the six Smart Inspection KPIs, measured from a timeline', () => {
  const now = new Date('2026-09-05T12:00:00Z');
  const t = (inspectionId: string, kind: string, at: string, source = '', meta: Record<string, unknown> = {}): KpiTimelineRow => ({ inspectionId, kind, at, source, meta });
  const targets = kpiTargetsFrom({ kpiProgrammeStart: '2025-06-01', kpiProgrammeMonths: 18, kpiNoticeMinutes: 30, kpiRestrictionMinutes: 60, kpiReportBaselineMinutes: 0 });
  it('reads its targets from the module settings and falls back to the programme defaults', () => {
    expect(kpiTargetsFrom(null)).toEqual(DEFAULT_KPI_TARGETS);
    expect(kpiTargetsFrom({ kpiAiReportTargetPct: '75', kpiProgrammeStart: 'not a date', kpiNoticeMinutes: 0 })).toMatchObject({ aiReportTargetPct: 75, programmeStart: null, noticeMinutes: 30 });
  });
  it('says "not captured" for every figure when nothing has happened', () => {
    const r = evaluateInspectionKpis([], targets, now);
    expect(r.kpis.every((k) => k.status === 'NOT_CAPTURED' && k.value === null)).toBe(true);
    expect(r.programme).toMatchObject({ monthsTotal: 18, monthsElapsed: 15.1, pct: 84 });
    expect(r.trend).toHaveLength(12);
  });
  it('measures each figure from the dated facts, and grades it against the linear ramp', () => {
    const rows = [
      // survey A: dossier before boarding, AI report 8 min after close, AI notice 12 min after close, prediction agreed, detention routed in 3 min
      t('A', 'PLANNED', '2026-08-01T06:00:00Z'), t('A', 'DOSSIER_PREPARED', '2026-08-01T07:00:00Z', 'AUTO'), t('A', 'PREDICTION_RECORDED', '2026-08-01T07:05:00Z', 'A5'),
      t('A', 'STARTED', '2026-08-02T08:00:00Z'), t('A', 'CLOSED', '2026-08-02T14:00:00Z', 'DESK', { findings: 3, result: 'DETAINED' }),
      t('A', 'REPORT_DRAFTED', '2026-08-02T14:08:00Z', 'AI'), t('A', 'REPORT_ISSUED', '2026-08-02T18:00:00Z', 'AI'), t('A', 'NOTICE_DRAFTED', '2026-08-02T14:12:00Z', 'AI'),
      t('A', 'PREDICTION_SCORED', '2026-08-02T14:01:00Z', 'A5', { correlated: true }),
      t('A', 'RESTRICTION_RECOMMENDED', '2026-08-02T14:00:00Z', 'RULES', { recommendationId: 'r1' }), t('A', 'RESTRICTION_ROUTED', '2026-08-02T14:03:00Z', 'BUS', { recommendationId: 'r1' }),
      // survey B: boarded without a dossier, manual report two days later, manual notice, prediction disagreed, restriction routed after 90 min
      t('B', 'STARTED', '2026-08-10T08:00:00Z'), t('B', 'DOSSIER_PREPARED', '2026-08-10T09:00:00Z', 'DESK'), t('B', 'CLOSED', '2026-08-10T15:00:00Z', 'DESK', { findings: 2, result: 'DEFICIENCIES' }),
      t('B', 'REPORT_DRAFTED', '2026-08-12T15:00:00Z', 'MANUAL'), t('B', 'REPORT_ISSUED', '2026-08-12T16:00:00Z', 'MANUAL'), t('B', 'NOTICE_DRAFTED', '2026-08-10T15:20:00Z', 'MANUAL'),
      t('B', 'PREDICTION_SCORED', '2026-08-10T15:01:00Z', 'RULES', { correlated: false }),
      t('B', 'RESTRICTION_RECOMMENDED', '2026-08-10T15:00:00Z', 'RULES', { recommendationId: 'r2' }), t('B', 'RESTRICTION_ROUTED', '2026-08-10T16:30:00Z', 'BUS', { recommendationId: 'r2' }),
      // survey C: closed clean, no findings, no report yet
      t('C', 'STARTED', '2026-08-20T08:00:00Z'), t('C', 'DOSSIER_PREPARED', '2026-08-20T07:00:00Z', 'AUTO'), t('C', 'CLOSED', '2026-08-20T12:00:00Z', 'DESK', { findings: 0, result: 'SATISFACTORY' }),
      // survey D: before the programme started — a manual report five days after close sets the baseline, and nothing else counts
      t('D', 'STARTED', '2025-02-01T08:00:00Z'), t('D', 'CLOSED', '2025-02-01T16:00:00Z', 'DESK', { findings: 1 }), t('D', 'REPORT_DRAFTED', '2025-02-06T16:00:00Z', 'MANUAL'), t('D', 'REPORT_ISSUED', '2025-02-06T17:00:00Z', 'MANUAL'),
    ];
    const r = evaluateInspectionKpis(rows, targets, now);
    const by = Object.fromEntries(r.kpis.map((k) => [k.key, k]));
    expect(by.dossierCoverage).toMatchObject({ value: 66.7, numerator: 2, denominator: 3, status: 'BEHIND' });          // A and C before boarding; B after
    expect(by.aiReports).toMatchObject({ value: 50, numerator: 1, denominator: 2, status: 'BEHIND' });                  // A machine-first, B manual; C has no report
    expect(by.noticeSpeed).toMatchObject({ value: 50, numerator: 1, denominator: 2 });                                   // A's AI notice in 12 min; B's was manual
    expect(by.predictionCorrelation).toMatchObject({ value: 50, numerator: 1, denominator: 2 });
    expect(by.restrictionRouting).toMatchObject({ value: 50, numerator: 1, denominator: 2, status: 'BEHIND' });        // A in 3 min, B in 90
    // turnaround: A 240 min and B 2,940 min → median 1,590; the manual baseline is B's 2,940 and D's 7,260 → median 5,100; reduction 68.8 %
    expect(by.reportTurnaround).toMatchObject({ currentMinutes: 1590, baselineMinutes: 5100, value: 68.8, status: 'MET' });
    expect(by.reportTurnaround.detail).toContain('measured from manual reports');
    // a configured baseline wins over the measured one
    const configured = evaluateInspectionKpis(rows, { ...targets, reportBaselineMinutes: 2000 }, now).kpis.find((k) => k.key === 'reportTurnaround')!;
    expect(configured).toMatchObject({ baselineMinutes: 2000, value: 20.5, status: 'BEHIND' });
    expect(configured.detail).toContain('(configured)');
    // the required figure on the day is the target scaled by how far the programme has run
    expect(by.aiReports.required).toBe(58.7); expect(requiredToday(100, r.programme)).toBe(83.9);
    // the trend carries August's figures in the month they happened
    const aug = r.trend.find((p) => p.key === '2026-08')!;
    expect(aug).toMatchObject({ closed: 3, dossierCoverage: 66.7, aiReports: 50, restrictionRouting: 50, reportTurnaroundMinutes: 1590 });
  });
  it('grades a figure at or above target as met, above the ramp as on track, and below it as behind', () => {
    const rows = [t('A', 'STARTED', '2026-08-02T08:00:00Z'), t('A', 'DOSSIER_PREPARED', '2026-08-01T07:00:00Z', 'AUTO')];
    expect(evaluateInspectionKpis(rows, targets, now).kpis[0]).toMatchObject({ value: 100, status: 'MET' });
    const early = evaluateInspectionKpis([...rows, t('B', 'STARTED', '2026-08-03T08:00:00Z')], { ...targets, programmeStart: '2026-07-01' }, now).kpis[0];
    expect(early).toMatchObject({ value: 50, status: 'ON_TRACK' }); // two months in, the ramp asks for 11 %
  });
});
