import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import '../src/i18n';
import { store } from '../src/store';
import { setSession } from '../src/store/authSlice';
import { buildTheme } from '../src/theme';
import api from '../src/api/client';
import HarbourDashboard from '../src/pages/ops/HarbourDashboard';
import RevenueDashboard from '../src/pages/invoices/RevenueDashboard';
import AdminDashboard from '../src/pages/admin/AdminDashboard';
import DataStudioDashboard from '../src/pages/masters/DataStudioDashboard';
import NoticesDashboard from '../src/pages/legislation/NoticesDashboard';
import CompaniesDashboard from '../src/pages/facilities/CompaniesDashboard';
import ServiceDeskDashboard from '../src/pages/services/ServiceDeskDashboard';
import ServiceCatalogue from '../src/pages/services/ServiceCatalogue';
import ApplicationDetail from '../src/pages/services/ApplicationDetail';
import ModuleStrip, { formatKpi } from '../src/components/dashboard/ModuleStrip';
import { toneOf } from '../src/components/dashboard/kit';

// recharts measures its container with ResizeObserver, which jsdom does not ship
class RO { observe() { /* noop */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || RO;

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const adminUser = { id: 'u1', name: 'Platform Administrator', email: 'admin@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] };
const admin = { user: adminUser, token: 't', refreshToken: 'r' } as never;
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
const wrap = (ui: React.ReactNode, path = '/') => render(<Provider store={store}><MemoryRouter initialEntries={[path]}><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);
const months = Array.from({ length: 12 }, (_, i) => ({ key: `2026-${String(i + 1).padStart(2, '0')}`, month: `M${i + 1}` }));

/* Fictional figures only, shaped as the services answer. */
const harbour = { kpis: { callsMtd: 15, callsPrevMonth: 34, calls30d: 42, sailed30d: 29, inPort: 9, atAnchorage: 5, expected72h: 5, expected7d: 8, avgTurnaroundHrs: 46, medianTurnaroundHrs: 47, avgAlongsideHrs: 32.6, avgWaitingHrs: 11.4, medianWaitingHrs: 10, waitingWithinTargetPct: 13, waitingOverAlertPct: 12, etaReliabilityPct: 71, berthOccupancyPct: 39, operationalBerths: 23, berthsUnderMaintenance: 1, berthDowntimeHrs30d: 96, outages30d: 4, pilotUtilisationPct: 31, tugUtilisationPct: 22, craftJobs30d: 210, craftHours30d: 480, cargoMtd: 35448, teuMtd: 1520, cargoPrevMonth: 1309193 },
  targets: { waitingHrs: 4, occupancyPct: 70, congestionPct: 85, etaSlackHrs: 4, anchorageAlertHrs: 24 }, byMonth: months.map((m) => ({ ...m, calls: 30, avgWaitingHrs: 10, avgTurnaroundHrs: 45, cargoMT: 100000 })),
  byTerminal: [{ terminal: 'Container Terminal 1', berths: 7, occupiedHrs: 2000, availableHrs: 5000, occupancyPct: 40 }], byBerth: [], byType: [{ type: 'CONTAINER', calls: 100, avgTurnaroundHrs: 40, avgWaitingHrs: 8, cargoMT: 1 }], outagesByKind: [{ kind: 'PLANNED', count: 3, hours: 72 }], outages30ByKind: [],
  craftByType: [{ type: 'TUG', craft: 5, available: 3, tasked: 2, jobs: 100, hours: 300, utilisationPct: 22 }], agents: [{ agentCode: 'GSS', agentName: 'Gulf Star Shipping', calls: 120, sharePct: 30 }],
  arrivals: [{ id: 'c1', vcn: 'VCN-2026-00003', vesselName: 'Ajman Pioneer', vesselType: 'RORO', status: 'CONFIRMED', eta: '2026-09-07T10:00:00Z', berthCode: 'RR-1', agentName: 'Gulf Star Shipping', purpose: 'CARGO' }],
  anchored: [{ id: 'c2', vcn: 'VCN-2026-00009', vesselName: 'Sharjah Sunrise', vesselType: 'BULK', agentName: 'Oceanic Agencies', since: '2026-09-06T02:00:00Z', waitingHrs: 30, etb: null }], generatedAt: '2026-09-06T12:00:00Z' };
const revenue = { currency: 'AED', termsDays: 30, kpis: { billedMtd: 441308.7, billedPrevMonth: 8355944.5, billedYtd: 50882035.6, billed12m: 69406292, collectedMtd: 3241916, collectedYtd: 48972256, collected12m: 69073545, outstanding: 4783779.5, openInvoices: 13, overdueAmount: 894043.9, overdueCount: 2, dsoDays: 21.1, ceiPct: 96, avgDaysToPay: 16.5, paidOnTimePct: 93, settled90d: 71, collectionRate12mPct: 99, vatMtd: 21014, remindersDue: 2, drafts: { count: 6, total: 1550439, proforma: 6 }, cancelled12m: { count: 2, total: 551450 } },
  targets: { dsoDays: 40, ceiPct: 90, paidOnTimePct: 80, currentSharePct: 80 }, ageing: [{ bucket: 'Current', count: 11, amount: 3889735 }, { bucket: '1–30', count: 0, amount: 0 }, { bucket: '31–60', count: 1, amount: 500000 }, { bucket: '61–90', count: 1, amount: 394043 }, { bucket: '90+', count: 0, amount: 0 }],
  byMonth: months.map((m) => ({ ...m, billed: 6000000, collected: 5800000, invoices: 27 })), byLine: [{ code: 'PD', label: 'Port dues', amount: 36000000, invoices: 800, sharePct: 52 }], debtors: [{ name: 'Oceanic Agencies FZE', invoices: 228, billed: 80000000, outstanding: 2000000, overdue: 894043, avgDaysToPay: 17 }],
  methods: [{ method: 'TRANSFER', count: 799, amount: 231900000 }], overdueList: [{ id: 'i1', number: 'REF/INV-2026-0100', vesselName: 'Liwa Horizon', billTo: 'Oceanic Agencies FZE', total: 500000, outstanding: 500000, dueAt: '2026-07-20T00:00:00Z', daysOverdue: 48, reminded: false }], generatedAt: '' };
const adminData = { kpis: { users: 136, active: 132, inactive: 4, newUsers30d: 12, mfaRequired: 130, mfaEnrolled: 95, mfaCoveragePct: 73, mfaOverdue: 0, dormant: 22, dormantDays: 90, privileged: 3, privilegedWithoutMfa: 3, privilegedMfaPct: 0, loggedIn24h: 9, loggedIn7d: 40, activeSessions: 519, sessionUsers: 14, sessionsUsed24h: 12, lockedAccounts: 0, failedLogins24h: 3, changesPending: 0, changesDecided30d: 23, changesApproved30d: 13, changesRejected30d: 0, postureScore: 47 },
  review: { id: 'c', openedAt: '2026-09-05T16:44:47Z', dueAt: '2026-09-19T16:44:47Z', total: 132, decided: 12, confirmed: 12, revoked: 0, pendingPrivileged: 1, progressPct: 9, daysLeft: 13, overdue: false },
  byRole: [{ role: 'Harbour Master', users: 21, active: 21, mfaRequired: true, mfaEnrolled: 15, privileged: 0, dormant: 2, system: false }], byDepartment: [{ department: 'Operations', users: 60 }], changesByKind: [{ kind: 'USER_ROLE', pending: 0, approved: 13, rejected: 0, cancelled: 10 }],
  dormantList: [{ id: 'd1', name: 'Zaid Al Mansoori', roleName: 'Terminal Supervisor', department: 'Operations', lastLoginAt: null, days: 400 }], privilegedList: [{ id: 'p1', name: 'Platform Administrator', roleName: 'Super Admin', mfaEnrolled: false, lastLoginAt: '2026-09-06T06:00:00Z' }], generatedAt: '' };
const audit = { total: 1301, byAction: [{ action: 'LOGIN', count: 779 }], byDay: [{ day: '2026-09-05', events: 536, logins: 300, actors: 12 }, { day: '2026-09-06', events: 441, logins: 250, actors: 10 }], byService: [{ service: 'identity-access', count: 890 }], last24h: 441, last7d: 1301, activeActors7d: 18 };
const studio = { kpis: { masters: 49, entries: 487, active: 487, inactive: 0, arabicPct: 51, duplicates: 1, invalid: 0, staleMasters: 0, staleDays: 180, updated30d: 487, goldenVessels: 31, goldenCompanies: 20, vesselCompletenessPct: 100, companyCompletenessPct: 80, pendingRecords: 0, settingsChanged30d: 10, qualityScore: 88, grade: 'B' },
  dimensions: [{ dimension: 'Completeness', score: 90, detail: 'x' }, { dimension: 'Bilingual', score: 51, detail: 'y' }, { dimension: 'Uniqueness', score: 100, detail: 'z' }, { dimension: 'Validity', score: 100, detail: 'v' }, { dimension: 'Timeliness', score: 100, detail: 't' }],
  masters: [{ category: 'port', entries: 32, active: 32, arabicPct: 0, duplicates: 0, invalid: 0, updatedAt: '2026-09-06T00:00:00Z', ageDays: 0, stale: false, score: 67, grade: 'D' }], recentSettings: [{ key: 'notifications', updatedAt: '2026-09-06T00:00:00Z', updatedBy: 'Platform Administrator' }], weakest: [{ category: 'holiday', entries: 12, active: 12, arabicPct: 0, duplicates: 0, invalid: 0, updatedAt: null, ageDays: null, stale: false, score: 64, grade: 'D' }], generatedAt: '' };
const notices = { kpis: { total: 63, inForce: 42, drafts: 2, superseded: 17, withdrawn: 2, conventions: 14, ackRequired: 8, ackOutstanding: 312, ackCompliancePct: 78, awaitingApproval: 0, awaitingReview: 2, comingIntoForce: 0, lapsingSoon: 0 }, byType: [{ type: 'CIRCULAR', total: 31, inForce: 14, drafts: 1 }], bySubject: [], drafts: [{ id: 'd', refNo: 'MC-2026-031', title: 'Draft circular', type: 'CIRCULAR', category: 'Safety', status: 'DRAFT', issuedDate: '2026-09-01', draftedBy: 'Legal Officer', reviewed: false, cleared: false }], recent: [],
  outstanding: [{ id: 'o', refNo: 'MC-2026-012', title: 'Anchorage limits', type: 'CIRCULAR', category: 'Port operations', status: 'IN_FORCE', issuedDate: '2026-06-01', recipients: 123, acknowledgements: 90, outstanding: 33 }], byMonth: months.map((m) => ({ ...m, issued: 1, circulars: 1, notices: 0, other: 0, acknowledgements: 40 })), issued12m: 12,
  currency: { inForce: 42, olderThanReview: 20, olderThanReviewPct: 48, reviewYears: 5, avgAgeYears: 9.2 }, acknowledgements: { acks12m: 480, avgDays: 6.8, withinDuePct: 68 }, reviewList: [{ id: 'r', refNo: 'ACT-1974', title: 'Old act', type: 'ACT', category: 'Principal legislation', issuedDate: '1974-11-01', ageYears: 51.8 }], roll: 132, ackDueDays: 7, generatedAt: '' };
const imo = { kpis: { sources: 8, polledOk: 8, failed: 0, neverPolled: 0, items: 47, new: 16, assessed: 9, transposed: 19, dismissed: 3, overdue: 6, last30Days: 27, withInstrument: 20, leadTimeDays: 7.7, dueSoon: 0 }, bySource: [{ source: 'MSC', label: 'Maritime Safety Committee', items: 6, new: 2 }], attention: [{ id: 'a', reference: 'MSC.1/Circ.1700', title: 'A new circular', source: 'MSC', status: 'NEW', publishedOn: '2026-08-21', overdue: true }] };
const companies = { kpis: { companies: 20, active: 17, suspended: 2, blacklisted: 0, inactive: 1, averageRating: 3.9, facilities: 24, ispsCompliant: 6, instrumentsHeld: 37, dueForRenewal: 3, expired: 0, auditsLastYear: 26, nonConformities: 6, openObligations: 15 }, byCategory: [{ category: 'AGENCY', total: 6, active: 6 }], byStatus: [], byIsps: [], byFacilityType: [], auditResults: [{ result: 'SATISFACTORY', total: 12 }, { result: 'OBSERVATIONS', total: 8 }, { result: 'NON_CONFORMITY', total: 6 }],
  expiries: { d30: 2, d60: 3, d90: 3, expired: 0 }, byClass: [{ instrumentClass: 'LICENCE', issued: 20, pending: 3, suspended: 3 }], applications: { pending: 5, applied: 2, underReview: 3, oldestDays: 127, avgDays: 88 }, obligations: { open: 15, overdue: 9, byKind: [{ kind: 'AUDIT_FINDING', open: 9, overdue: 9 }] },
  securityReviewsDetail: { submitted: 3, cleared12m: 10, rejected12m: 3, avgClearanceDays: 9 }, ratingBands: [{ band: '1–2', total: 0 }, { band: '2–3', total: 1 }, { band: '3–4', total: 9 }, { band: '4–5', total: 7 }], renewalStats: { total: 7, onTime: 7, onTimePct: 100 }, issued12m: 11,
  securityReviews: { open: 3, cleared12m: 6, rejected: 3, never: 9, total: 24 }, watchlist: [{ id: 'w', code: 'XYZ', name: 'Falcon Bunkering', category: 'SERVICE_PROVIDER', status: 'ACTIVE', rating: 2.4 }], renewals: [] };
const accreditation = { kpis: { schemes: 5, accredited: 11, companies: 9, due: 2, expired: 0, suspended: 1, renewalsNext30: 1, renewalsNext90: 3, visitsScheduled: 3, visitsOverdue: 1, visitsCompleted90: 2, nonConformities90: 0 }, bySchemes: [{ category: 'LSA_SERVICING', label: 'LSA servicing', companies: 3, current: 2, due: 1, expired: 0, suspended: 0, visitsOverdue: 0, averageRating: 4.1 }] };
const desk = { series: months.map((m) => ({ ...m, received: 6, decided: 4, issued: 3, breached: 1 })), ageing: [{ bucket: '0–7', count: 30 }, { bucket: '8–14', count: 16 }, { bucket: '15–30', count: 15 }, { bucket: '31–60', count: 2 }, { bucket: '60+', count: 0 }], byStage: [{ status: 'UNDER_ASSESSMENT', count: 21, breached: 6 }], bySubjectKind: [{ subjectKind: 'VESSEL', total: 100, open: 30 }],
  desk: { receivedMtd: 6, receivedPrevMonth: 38, decidedMtd: 1, received12m: 80, decided12m: 47, breachedOpen: 11, atRisk48h: 6, decided90d: 20, withinSlaPct90d: 45, medianDecisionDays90d: 8, avgDecisionDays90d: 8.5, firstTimeRightPct90d: 100, approvalRatePct90d: 85, straightThroughPct90d: 0, autoDecided90d: 2, feesCollectedMtd: 2500, feesCollectedYtd: 101850, feesCollected12m: 120000, feesOutstanding: 336367.5, feesDueCount: 20, oldestOpenDays: 63 },
  targets: { withinSlaPct: 90, firstTimeRightPct: 80, straightThroughPct: 60 }, total: 200, open: 43, breached: 11, slaCompliance: 74, avgDecisionDays: 12.3, approved: 7, rejected: 7, issued: 130, withdrawn: 7, automated: 4, byCategory: [{ category: 'Licensing', categoryAr: null, count: 78 }], byStatus: [], topServices: [{ key: 'vessel.noc', name: 'Vessel NOC', count: 22 }], catalogue: { published: 78, total: 78 } };

describe('module dashboards', () => {
  beforeAll(() => { store.dispatch(setSession(admin)); });
  afterEach(() => vi.restoreAllMocks());

  it('harbour: reads the yardsticks against their targets and lists who is waiting', async () => {
    mockGet({ '/ops/dashboard': ok(harbour) });
    wrap(<HarbourDashboard />);
    await screen.findByTestId('harbour-dashboard');
    expect(within(screen.getByTestId('yard-waiting')).getByText('11.4 h')).toBeTruthy();
    expect(within(screen.getByTestId('yard-waiting')).getByText(/target ≤ 4 h/)).toBeTruthy();
    expect(within(screen.getByTestId('panel-anchored')).getByText('Sharjah Sunrise')).toBeTruthy();
    expect(within(screen.getByTestId('panel-arrivals')).getByText('Ajman Pioneer')).toBeTruthy();
    expect(screen.getByText('Vessels in port').parentElement?.textContent).toContain('9');
  });
  it('revenue: DSO, collection effectiveness and the ageing buckets', async () => {
    mockGet({ '/invoices/dashboard': ok(revenue) });
    wrap(<RevenueDashboard />);
    await screen.findByTestId('revenue-dashboard');
    expect(within(screen.getByTestId('yard-dso')).getByText('21.1 d')).toBeTruthy();
    expect(within(screen.getByTestId('yard-cei')).getByText('96%')).toBeTruthy();
    expect(within(screen.getByTestId('panel-ageing')).getByText('Not yet due')).toBeTruthy();
    expect(within(screen.getByTestId('panel-overdue')).getByText(/REF\/INV-2026-0100/)).toBeTruthy();
  });
  it('administration: second-factor coverage, dormant and privileged accounts, the review and the ledger', async () => {
    mockGet({ '/users/dashboard': ok(adminData), '/audit/summary': ok(audit) });
    wrap(<AdminDashboard />);
    await screen.findByTestId('admin-dashboard');
    expect(within(screen.getByTestId('yard-mfa')).getByText('73%')).toBeTruthy();
    expect(within(screen.getByTestId('panel-privileged')).getByText('no second factor')).toBeTruthy();
    expect(within(screen.getByTestId('panel-dormant')).getByText('Zaid Al Mansoori')).toBeTruthy();
    await waitFor(() => expect(screen.getByTestId('review-line').textContent).toContain('12 confirmed'));
    await waitFor(() => expect(screen.getByTestId('panel-services')).toBeTruthy());
  });
  it('data studio: grades the masters and names the weakest', async () => {
    mockGet({ '/golden/dashboard': ok(studio) });
    wrap(<DataStudioDashboard />);
    await screen.findByTestId('studio-dashboard');
    expect(within(screen.getByTestId('yard-bilingual')).getByText('51')).toBeTruthy();
    expect(within(screen.getByTestId('panel-weakest')).getByText('Holiday')).toBeTruthy();
    expect(screen.getByText('88 · B')).toBeTruthy();
  });
  it('notices: acknowledgement compliance, review age and the IMO watch', async () => {
    mockGet({ '/legislation/dashboard': ok(notices), '/legislation/imo/dashboard': ok(imo) });
    wrap(<NoticesDashboard />);
    await screen.findByTestId('notices-dashboard');
    expect(within(screen.getByTestId('yard-ack')).getByText('78%')).toBeTruthy();
    expect(within(screen.getByTestId('yard-review')).getByText('48%')).toBeTruthy();
    await waitFor(() => expect(within(screen.getByTestId('yard-lead')).getByText('7.7 d')).toBeTruthy());
    expect(within(screen.getByTestId('panel-outstanding')).getByText(/MC-2026-012/)).toBeTruthy();
  });
  it('companies: expiries, applications, obligations and renewals', async () => {
    mockGet({ '/facilities/dashboard': ok(companies), '/facilities/accreditations/dashboard': ok(accreditation) });
    wrap(<CompaniesDashboard />);
    await screen.findByTestId('companies-dashboard');
    expect(within(screen.getByTestId('yard-renewal')).getByText('100%')).toBeTruthy();
    expect(within(screen.getByTestId('yard-clearance')).getByText('9 d')).toBeTruthy();
    expect(within(screen.getByTestId('panel-watchlist')).getByText('Falcon Bunkering')).toBeTruthy();
    await waitFor(() => expect(within(screen.getByTestId('panel-schemes')).getByText('LSA servicing')).toBeTruthy());
  });
  it('service desk: service level, first time right, ageing and the fee position', async () => {
    mockGet({ '/services/dashboard': ok(desk) });
    wrap(<ServiceDeskDashboard />);
    await screen.findByTestId('desk-dashboard');
    expect(within(screen.getByTestId('yard-sla')).getByText('45%')).toBeTruthy();
    expect(within(screen.getByTestId('yard-ftr')).getByText('100%')).toBeTruthy();
    expect(within(screen.getByTestId('panel-top')).getByText('Vessel NOC')).toBeTruthy();
    expect(screen.getByText('Applications open').parentElement?.textContent).toContain('43');
  });
  it('the module strip shows a tile per module the reader may open, with formatted numbers', async () => {
    mockGet({ '/dashboard/modules': ok({ modules: [{ key: 'ops', kpis: [{ label: 'In port', value: 9 }, { label: 'Avg wait, 30 d', value: 11.8, format: 'hours' }] }, { key: 'finance', kpis: [{ label: 'Outstanding', value: 4783779.5, format: 'money' }] }], generatedAt: '' }), '/platform/status': ok({ summary: { services: 23, servicesUp: 23, targets: 29, targetsUp: 29, openIncidents: 0, status: 'ok' }, targets: [] }) });
    wrap(<ModuleStrip />);
    await screen.findByTestId('strip-ops');
    await waitFor(() => expect(screen.getByTestId('strip-ops').textContent).toContain('11.8 h'));
    expect(screen.getByTestId('strip-finance').textContent).toMatch(/4\.8M|4\.78M/);
    await waitFor(() => expect(screen.getByTestId('strip-platform').textContent).toContain('23'));
    expect(formatKpi({ label: 'x', value: 12.5, format: 'pct' })).toBe('12.5%');
    expect(toneOf(3, 4, false)).toBe('success'); expect(toneOf(4.5, 4, false)).toBe('warning'); expect(toneOf(20, 4, false)).toBe('error'); expect(toneOf(null, 4)).toBe('default');
  });
  it('the strip hides modules the reader may not open', async () => {
    store.dispatch(setSession({ user: { ...adminUser, role: { id: 'r', name: 'Finance Officer', permissions: ['invoices.view', 'dashboard.view'] }, perms: ['invoices.view', 'dashboard.view'] }, token: 't', refreshToken: 'r' } as never));
    mockGet({ '/dashboard/modules': ok({ modules: [], generatedAt: '' }) });
    wrap(<ModuleStrip />);
    await screen.findByTestId('strip-finance');
    expect(screen.queryByTestId('strip-admin')).toBeNull(); expect(screen.queryByTestId('strip-ops')).toBeNull();
    store.dispatch(setSession(admin));
  });
});

describe('service desk screens', () => {
  beforeAll(() => { store.dispatch(setSession(admin)); });
  afterEach(() => vi.restoreAllMocks());
  const catalogue = { total: 2, autoApprovable: 1, environment: 'PROD', currency: 'AED', categories: [{ category: 'Registration', categoryAr: null, label: 'Registration', count: 1, services: [{ id: 's1', key: 'vessel.registration', code: 'SR-01', name: 'Vessel registration', nameAr: null, label: 'Vessel registration', description: 'Register a ship under the flag', descriptionAr: null, subjectKind: 'VESSEL', domain: 1, ownerModule: 'ships', issuesInstrument: 'CERTIFICATE_OF_REGISTRY', instrumentType: 'CERTIFICATE_OF_REGISTRY', autoApprovable: false, version: 3, fee: { amount: 5000, currency: 'AED', ruleSetKey: null, taxRatePct: 5 }, slaDays: 10, fields: 4, documents: 3, requiredDocuments: 2 }] },
    { category: 'Licensing', categoryAr: null, label: 'Licensing', count: 1, services: [{ id: 's2', key: 'fac.pest.control', code: 'LI-09', name: 'Pest control licence', nameAr: null, label: 'Pest control licence', description: 'Licence to fumigate', descriptionAr: null, subjectKind: 'COMPANY', domain: 3, ownerModule: 'facilities', issuesInstrument: null, instrumentType: null, autoApprovable: true, version: 1, fee: { amount: 0, currency: 'AED', ruleSetKey: null, taxRatePct: 5 }, slaDays: 5, fields: 1, documents: 0, requiredDocuments: 0 }] }] };
  it('the catalogue lists services by category and filters as you type', async () => {
    mockGet({ '/services/catalogue': ok(catalogue) });
    wrap(<ServiceCatalogue />);
    await screen.findByTestId('service-vessel.registration');
    expect(screen.getByTestId('service-fac.pest.control')).toBeTruthy();
    fireEvent.change(screen.getByTestId('catalogue-search'), { target: { value: 'pest' } });
    await waitFor(() => expect(screen.queryByTestId('service-vessel.registration')).toBeNull());
    expect(screen.getByTestId('service-fac.pest.control')).toBeTruthy();
  });
  it('an application shows the form as lodged, its documents and every action the workflow allows, and records the chosen one', async () => {
    const req = { id: 'r1', number: 'SR-2026-00042', definitionId: 's1', definitionKey: 'vessel.registration', definitionName: 'Vessel registration', definitionVersion: 3, environment: 'PROD', category: 'Registration', domain: 1, subjectKind: 'VESSEL', subjectId: 'v1', subjectName: 'Liwa Horizon (IMO 9700001)', applicant: { userId: 'a1', name: 'Agent Ahmed', organisation: 'Gulf Star Shipping' }, status: 'UNDER_ASSESSMENT', currentState: 'UNDER_ASSESSMENT',
      fees: { lines: [{ code: 'REG', description: 'Registration fee', amount: 5000 }], total: 5250, currency: 'AED' }, payment: { status: 'DUE', amount: 5250, currency: 'AED', paidAt: null, reference: '' }, assignee: { userId: 'x', name: 'Registrar of Ships' }, slaDueAt: '2026-09-10T00:00:00Z', slaBreached: false, slaBreachedAt: null, submittedAt: '2026-09-01T09:00:00Z', decidedAt: null, closedAt: null, issuedInstrument: null, createdAt: '2026-09-01T08:00:00Z', updatedAt: '2026-09-01T09:00:00Z',
      formData: { grossTonnage: 42000, homePort: 'AEKLF' }, documents: [{ code: 'builder-cert', name: 'builder.pdf', verified: true }, { code: 'tonnage', verified: false }], checks: [{ key: 'tonnage', label: 'Tonnage certificate on file', passed: true }],
      timeline: [{ from: '', to: 'DRAFT', action: 'create', at: '2026-09-01T08:00:00Z', by: { name: 'Agent Ahmed' } }, { from: 'DRAFT', to: 'SUBMITTED', action: 'submit', at: '2026-09-01T09:00:00Z', by: { name: 'Agent Ahmed' } }],
      availableActions: [{ key: 'approve', label: 'Approve', to: 'APPROVED' }, { key: 'request_info', label: 'Request information', to: 'INFO_REQUESTED' }], stateLabel: 'Under assessment', stateLabelAr: null,
      definition: { key: 'vessel.registration', name: 'Vessel registration', nameAr: null, version: 3, form: { fields: [{ key: 'grossTonnage', label: 'Gross tonnage', type: 'number' }, { key: 'homePort', label: 'Home port', type: 'select', options: [{ value: 'AEKLF', label: 'Khalifa Port' }] }] }, documents: [{ code: 'builder-cert', label: "Builder's certificate", required: true }, { code: 'tonnage', label: 'Tonnage certificate', required: true }], sla: { days: 10 }, outputs: { instrumentType: 'CERTIFICATE_OF_REGISTRY' } } };
    mockGet({ '/services/requests/r1': ok(req), '/services/requests/r1/notes': ok([{ id: 'n1', author: { name: 'Registrar of Ships' }, body: 'Tonnage certificate legible', internal: true, createdAt: '2026-09-02T09:00:00Z' }]) });
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({}) as never);
    render(<Provider store={store}><MemoryRouter initialEntries={['/services/requests/r1']}><ThemeProvider theme={buildTheme('light')}><Routes><Route path="/services/requests/:id" element={<ApplicationDetail />} /></Routes></ThemeProvider></MemoryRouter></Provider>);
    await screen.findByTestId('application-detail');
    expect(within(screen.getByTestId('application-form')).getByText('Khalifa Port')).toBeTruthy();
    expect(within(screen.getByTestId('application-form')).getByText('42000')).toBeTruthy();
    expect(within(screen.getByTestId('application-documents')).getByText(/Tonnage certificate/)).toBeTruthy();
    expect(screen.getByTestId('action-approve')).toBeTruthy(); expect(screen.getByTestId('action-request_info')).toBeTruthy();
    expect(screen.getByTestId('payment-ref')).toBeTruthy();
    await screen.findByText('Tonnage certificate legible');
    fireEvent.click(screen.getByTestId('action-approve'));
    fireEvent.change(screen.getByTestId('action-note'), { target: { value: 'Assessment satisfactory' } });
    fireEvent.click(screen.getByTestId('action-confirm'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/services/requests/r1/transition', { action: 'approve', note: 'Assessment satisfactory' }));
  });
});
