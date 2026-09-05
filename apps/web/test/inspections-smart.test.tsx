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
import AuditDashboard from '../src/pages/inspections/AuditDashboard';
import InspectionDetail from '../src/pages/inspections/InspectionDetail';
import InspectionsList from '../src/pages/inspections/InspectionsList';
import PlanInspectionDialog from '../src/pages/inspections/PlanInspectionDialog';
import type { Inspection, InspectionDashboardData, InspectionKpis, InspectionRow, SubjectOption } from '../src/pages/inspections/types';

/* Smart Inspection on the web: the six programme KPIs on the dashboard, the dossier, prediction, report, notice and
 * recommendation panels on a survey, subjects beyond ships on the register and in the plan dialog. Every survey, ship,
 * facility and person here is fictional; the shapes follow services/inspection/src/{smart,inspections}.ts. */
class RO { observe() { /* noop */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || RO;

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Port State Control Officer', email: 'psc@maritime.example', active: true, kind: 'user', scope: { level: 'PORT' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const regimes = [
  { id: 'r1', category: 'inspectionRegime', code: 'PSC', label: 'Port State Control', labelAr: 'رقابة دولة الميناء', active: true, meta: { subjectKind: 'VESSEL', convention: 'Riyadh MoU' } },
  { id: 'r2', category: 'inspectionRegime', code: 'HSE', label: 'HSE inspection', active: true, meta: { subjectKind: 'PORT_FACILITY' } },
  { id: 'r3', category: 'inspectionRegime', code: 'ISM_DOC', label: 'ISM company audit (DOC)', active: true, meta: { subjectKind: 'COMPANY' } },
];
type Call = { url: string; cfg?: { params?: Record<string, unknown> } };
const calls: Call[] = [];
const mockGet = (routes: Record<string, unknown | ((cfg?: Call['cfg']) => unknown)>) => vi.spyOn(api, 'get').mockImplementation(((url: string, cfg?: Call['cfg']) => {
  calls.push({ url, cfg });
  if (url === '/lookups') return Promise.resolve(ok(cfg?.params?.category === 'inspectionRegime' ? regimes : []));
  if (!(url in routes)) return Promise.reject(new Error(`Unmocked GET ${url}`));
  const r = routes[url]; const body = typeof r === 'function' ? (r as (c?: Call['cfg']) => unknown)(cfg) : r;
  return body instanceof Error ? Promise.reject(body) : Promise.resolve(body);
}) as never);
const wrap = (ui: React.ReactNode, path = '/') => render(<Provider store={store}><MemoryRouter initialEntries={[path]}><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

const dashboard: InspectionDashboardData = { kpis: { open: 3, closedYtd: 40, satisfactionPct: 70, detentionRatePct: 5, avgFindings: 2.1, openFindings: 9, checklistCompliancePct: 90 }, byMonth: [{ month: 'Aug 26', SATISFACTORY: 5, DEFICIENCIES: 2, DETAINED: 1 }], byType: [{ type: 'PSC', total: 30, closed: 28, detained: 2 }, { type: 'HSE', total: 6, closed: 6, detained: 0 }] };
const kpis: InspectionKpis = {
  programme: { start: '2025-06-01T00:00:00.000Z', end: '2026-12-01T00:00:00.000Z', monthsTotal: 18, monthsElapsed: 15.1, pct: 84 },
  kpis: [
    { key: 'dossierCoverage', label: 'Dossier before boarding', target: 100, unit: '%', value: 96.2, required: 83.9, status: 'ON_TRACK', numerator: 76, denominator: 79, detail: '76 of 79 boardings held a dossier before the party boarded' },
    { key: 'aiReports', label: 'Reports first drafted by AI', target: 70, unit: '%', value: 72.5, required: 58.7, status: 'MET', numerator: 58, denominator: 80, detail: '58 of 80 reports were first drafted by the assistant' },
    { key: 'noticeSpeed', label: 'Notices drafted within the window', target: 80, unit: '%', value: 61, required: 67.1, status: 'BEHIND', numerator: 25, denominator: 41, detail: '25 of 41 surveys with findings had an AI-drafted notice within 30 min (33 within the window from any source)' },
    { key: 'predictionCorrelation', label: 'Predictions that matched the findings', target: 65, unit: '%', value: 66.7, required: 54.5, status: 'MET', numerator: 40, denominator: 60, detail: '40 of 60 predictions scored in the last 12 months agreed with the findings' },
    { key: 'reportTurnaround', label: 'Report time reduced', target: 50, unit: '%', value: null, required: 41.9, status: 'NOT_CAPTURED', numerator: 0, denominator: 80, detail: 'No baseline: set the manual-era median in the module settings, or record manual reports the platform can measure', baselineMinutes: null, currentMinutes: 350 },
    { key: 'restrictionRouting', label: 'Restrictions routed within the hour', target: 100, unit: '%', value: 100, required: 83.9, status: 'MET', numerator: 6, denominator: 6, detail: '6 of 6 recommendations reached the deciding officer within 60 min' },
  ],
  trend: [{ month: 'Aug 26', key: '2026-08', closed: 6, dossierCoverage: 100, aiReports: 80, noticeSpeed: 60, predictionCorrelation: 66.7, restrictionRouting: 100, reportTurnaroundMinutes: 300 }],
  asOf: '2026-09-05T06:00:00Z', targets: { programmeMonths: 18, aiReportTargetPct: 70 },
};
const facility: InspectionRow = { id: 'in9', number: 'INS-2026-120', vesselId: null, vesselName: '', type: 'HSE', regime: 'HSE', subjectKind: 'PORT_FACILITY', subjectId: 'b1', subjectName: 'Container Terminal 1 — CT1-01', inspector: 'Marine Surveyor', plannedAt: '2026-09-02T04:00:00Z', startedAt: '2026-09-02T04:30:00Z', closedAt: null, status: 'IN_PROGRESS', result: '', detention: false, scorePct: null, findingsCount: 0, hasDossier: true };
const psc: InspectionRow = { id: 'in1', number: 'INS-2026-121', vesselId: 'v1', vesselName: 'MV Coral Reach', type: 'PSC', regime: 'PSC', subjectKind: 'VESSEL', subjectId: 'v1', subjectName: 'MV Coral Reach', inspector: 'Port State Control Officer', plannedAt: '2026-09-01T07:00:00Z', startedAt: '2026-09-01T07:20:00Z', closedAt: '2026-09-01T13:00:00Z', status: 'CLOSED', result: 'DEFICIENCIES', detention: false, scorePct: 78, findingsCount: 2, hasDossier: true, severity: 'MAJOR', recommendation: 'RESTRICT' };
const survey: Inspection = {
  ...psc, portCallId: 'pc1', vcn: 'VCN-2026-0041', templateId: 'tpl1', remarks: '', checklist: [],
  findings: [{ id: 'f1', deficiencyCode: '11101', deficiencyLabel: 'Lifeboats', description: 'Lifeboat falls beyond their renewal date', actionCode: '17', dueDate: '2026-09-20', status: 'OPEN', closedAt: null }, { id: 'f2', deficiencyCode: '01101', description: 'Certificate not endorsed', actionCode: '17', dueDate: '2026-09-20', status: 'OPEN', closedAt: null }],
  dossierPreparedAt: '2026-08-31T10:00:00Z', dossierSource: 'AUTO',
  dossier: { subject: { kind: 'VESSEL', name: 'MV Coral Reach', code: '9000001' }, portCall: { vcn: 'VCN-2026-0041', berthCode: 'CT1-01' }, history: { inspections: 4, lastInspectionAt: '2026-03-02T00:00:00Z', lastResult: 'DEFICIENCIES', detentions: 1, lastDetentionAt: '2025-11-10T00:00:00Z', openFindings: [{ code: '07105', label: 'Fire doors', number: 'INS-2026-088', dueDate: '2026-09-10' }], recurringCodes: [{ code: '11101', label: 'Lifeboats', times: 2 }] }, prediction: { source: 'A5', band: 'HIGH', riskScore: 71, predictedCodes: ['11101'] }, agentDossier: { expiredCertificates: 1 }, checklist: { templateId: 'tpl1', questions: 10, critical: 2 }, preparedAt: '2026-08-31T10:00:00Z', source: 'AUTO' },
  prediction: { id: 'p1', source: 'A5', decisionId: 'dec-1', predictedAt: '2026-08-31T10:00:00Z', riskScore: 71, band: 'HIGH', predictedCodes: ['11101', '07105'], basis: {}, scoredAt: '2026-09-01T13:00:00Z', outcome: { findings: 2, codes: ['11101', '01101'], matched: ['11101'], bandAgrees: true }, correlated: true },
  reports: [{ id: 'rep1', version: 1, source: 'AI', status: 'DRAFT', draftId: 'draft-1', title: 'Inspection report — INS-2026-121', summary: '', body: 'INSPECTION SUMMARY — INS-2026-121\nDeficiencies raised: 2.', severity: 'MAJOR', recommendation: 'RESTRICT', draftedAt: '2026-09-01T13:06:00Z', draftedBy: 'Assistant', issuedAt: null, issuedBy: '', aiDrafted: true }],
  notices: [{ id: 'not1', number: 'NOT-2026-0042', kind: 'DEFICIENCY', source: 'AI', status: 'DRAFT', addressedTo: 'MV Coral Reach', subject: 'Deficiency notice — INS-2026-121', body: 'DEFICIENCY NOTICE', findingIds: ['f1', 'f2'], draftedAt: '2026-09-01T13:09:00Z', draftedBy: 'Assistant', issuedAt: null, issuedBy: '', aiDrafted: true }],
  recommendations: [{ id: 'rec1', kind: 'RESTRICTION', source: 'RULES', grounds: '5 deficiencies open at close, 2 of them major', findingCodes: ['11101', '01101'], recommendedAt: '2026-09-01T13:00:00Z', recommendedBy: 'Severity rules', routedAt: '2026-09-01T13:02:00Z', decidedAt: null, decidedBy: '', decision: '', decisionNote: '', detentionId: null, status: 'PENDING', routedMinutes: 2, decidedMinutes: null }],
  timeline: [{ id: '1', kind: 'PLANNED', at: '2026-08-31T09:00:00Z', source: 'DESK', meta: {} }, { id: '2', kind: 'DOSSIER_PREPARED', at: '2026-08-31T10:00:00Z', source: 'AUTO', meta: {} }, { id: '3', kind: 'STARTED', at: '2026-09-01T07:20:00Z', source: 'DESK', meta: {} }, { id: '4', kind: 'CLOSED', at: '2026-09-01T13:00:00Z', source: 'DESK', meta: { findings: 2 } }, { id: '5', kind: 'RESTRICTION_ROUTED', at: '2026-09-01T13:02:00Z', source: 'BUS', meta: {} }],
};
const subjects: SubjectOption[] = [{ kind: 'PORT_FACILITY', id: 'b1', code: 'CT1-01', name: 'Container Terminal 1 — CT1-01', status: 'OPERATIONAL' }, { kind: 'PORT_FACILITY', id: 'b2', code: 'BT-02', name: 'Bulk Terminal — BT-02', status: 'OPERATIONAL' }];

describe('the Smart Inspection programme on the dashboard', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); calls.length = 0; });
  it('shows the six KPIs with their standing, the programme clock and "not captured" where nothing can be measured', async () => {
    mockGet({ '/inspections/dashboard': ok(dashboard), '/inspections/kpis': ok(kpis) });
    wrap(<AuditDashboard />);
    expect(await screen.findByRole('heading', { name: /Smart Inspection programme/ })).toBeInTheDocument();
    expect(await screen.findByText('Month 16 of 18')).toBeInTheDocument();
    const dossier = screen.getByTestId('kpi-dossierCoverage');
    expect(within(dossier).getByText('96.2%')).toBeInTheDocument(); expect(within(dossier).getByText('On track')).toBeInTheDocument();
    expect(within(dossier).getByText(/target 100%/)).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-aiReports')).getByText('Met')).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-noticeSpeed')).getByText('Behind')).toBeInTheDocument();
    const turnaround = screen.getByTestId('kpi-reportTurnaround');
    expect(within(turnaround).getByText('not captured')).toBeInTheDocument(); expect(within(turnaround).getByText('Not captured')).toBeInTheDocument();
    expect(within(turnaround).getByText(/No baseline/)).toBeInTheDocument();
    expect(within(screen.getByTestId('kpi-restrictionRouting')).getByText('100%')).toBeInTheDocument();
    // the regime table labels codes from the master
    expect(screen.getByText('HSE inspection')).toBeInTheDocument();
  });
  it('says so when the KPI service does not answer, and still shows the rest of the dashboard', async () => {
    mockGet({ '/inspections/dashboard': ok(dashboard), '/inspections/kpis': new Error('down') });
    wrap(<AuditDashboard />);
    expect(await screen.findByText('The KPI service did not answer.')).toBeInTheDocument();
    expect(screen.getByText('Open surveys')).toBeInTheDocument();
  });
});

describe('a survey with its Smart Inspection records', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); calls.length = 0; });
  const routes = { '/inspections/in1': ok(survey), '/checklist-templates': ok([]), '/module-settings/inspect': ok({ passScorePct: 80 }) };
  const at = () => wrap(<Routes><Route path="/inspections/:id" element={<InspectionDetail />} /></Routes>, '/inspections/in1');

  it('shows the dossier, the prediction and how it scored, the machine-drafted report and notice, and the pending recommendation', async () => {
    mockGet(routes);
    at();
    expect((await screen.findAllByText('INS-2026-121')).length).toBeGreaterThan(0);
    const dossier = screen.getByTestId('dossier-card');
    expect(within(dossier).getByText(/Prepared .* Automatic/)).toBeInTheDocument();
    expect(within(dossier).getByText('4 · last deficiencies')).toBeInTheDocument();
    expect(within(dossier).getByText('07105 · INS-2026-088')).toBeInTheDocument();
    expect(within(dossier).getByText(/Recurring codes: 11101 ×2/)).toBeInTheDocument();
    const prediction = screen.getByTestId('prediction-card');
    expect(within(prediction).getByText('High risk')).toBeInTheDocument(); expect(within(prediction).getByText('Smart Inspection agent')).toBeInTheDocument();
    expect(within(prediction).getByText('Prediction matched the findings (11101)')).toBeInTheDocument();
    const report = screen.getByTestId('report-card');
    expect(within(report).getByText('AI-drafted')).toBeInTheDocument(); expect(within(report).getByText('Draft')).toBeInTheDocument();
    expect(within(report).getByText(/Drafted by Assistant/)).toBeInTheDocument();
    const notice = screen.getByTestId('notice-card');
    expect(within(notice).getByText('NOT-2026-0042')).toBeInTheDocument(); expect(within(notice).getByText('Deficiency notice')).toBeInTheDocument();
    const rec = screen.getByTestId('recommendation-card');
    expect(within(rec).getByText('Operational restriction')).toBeInTheDocument(); expect(within(rec).getByText('Awaiting decision')).toBeInTheDocument();
    expect(within(rec).getByText(/reached the deciding officer in 2 min/)).toBeInTheDocument();
    expect(within(screen.getByTestId('timeline-card')).getByText('recommendation delivered')).toBeInTheDocument();
    expect(screen.getByText('Major')).toBeInTheDocument(); expect(screen.getByText('rules say: restrict')).toBeInTheDocument();
  });
  it('lets the officer issue the report and the notice, and decide on the recommendation', async () => {
    mockGet(routes);
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({}) as never);
    at();
    await screen.findAllByText('INS-2026-121');
    fireEvent.click(within(screen.getByTestId('report-card')).getByRole('button', { name: 'Issue' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/inspections/in1/report/rep1/issue'));
    fireEvent.click(within(screen.getByTestId('notice-card')).getByRole('button', { name: 'Issue' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/inspections/in1/notices/not1/issue'));
    fireEvent.click(within(screen.getByTestId('recommendation-card')).getByRole('button', { name: 'Decide' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('5 deficiencies open at close, 2 of them major')).toBeInTheDocument();
    fireEvent.mouseDown(within(dialog).getByLabelText(/Decision/));
    fireEvent.click(await screen.findByRole('option', { name: 'Rejected' }));
    fireEvent.change(within(dialog).getByLabelText('Note'), { target: { value: 'Rectification plan accepted' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/inspections/in1/recommendations/rec1/decide', { decision: 'REJECTED', note: 'Rectification plan accepted' }));
  });
  it('lets the officer write a report and draft a notice by hand, which the KPIs count as manual', async () => {
    mockGet(routes);
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({}) as never);
    at();
    await screen.findAllByText('INS-2026-121');
    fireEvent.click(screen.getByRole('button', { name: 'Write report' }));
    let dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Text/), { target: { value: "The officer's own account." } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/inspections/in1/report', { title: undefined, summary: undefined, body: "The officer's own account." }));
    fireEvent.click(await screen.findByRole('button', { name: 'Draft notice' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/Text/), { target: { value: 'Rectify within 14 days.' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/inspections/in1/notices', expect.objectContaining({ kind: 'DEFICIENCY', body: 'Rectify within 14 days.', findingIds: ['f1', 'f2'] })));
  });
  it('shows a reader the records without the buttons', async () => {
    store.dispatch(setSession({ ...session, user: { ...session.user, role: { id: 'r2', name: 'Reader', permissions: ['inspections.view'] }, perms: ['inspections.view'] } } as never));
    mockGet(routes);
    at();
    await screen.findAllByText('INS-2026-121');
    expect(screen.queryByRole('button', { name: 'Issue' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Decide' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Write report' })).not.toBeInTheDocument();
    store.dispatch(setSession(session as never));
  });
});

describe('subjects beyond ships', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); calls.length = 0; });
  it('lists a facility audit with its subject kind and the regime label from the master, and filters by both', async () => {
    mockGet({ '/stats/inspections': ok({ cards: [] }), '/inspections': ok([facility, psc], { total: 2 }) });
    wrap(<InspectionsList />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Container Terminal 1 — CT1-01')).toBeInTheDocument();
    expect(within(table).getByText('Port facility')).toBeInTheDocument();
    expect(within(table).getByText('HSE inspection')).toBeInTheDocument(); expect(within(table).getByText('Port State Control')).toBeInTheDocument();
    expect(within(table).getAllByText('Ready')).toHaveLength(2);
    fireEvent.mouseDown(screen.getByLabelText('Regime'));
    fireEvent.click(await screen.findByRole('option', { name: 'ISM company audit (DOC)' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/inspections' && c.cfg?.params?.regime === 'ISM_DOC')).toBe(true));
    fireEvent.mouseDown(screen.getByLabelText('Subject'));
    fireEvent.click(await screen.findByRole('option', { name: 'Company' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/inspections' && c.cfg?.params?.subjectKind === 'COMPANY')).toBe(true));
  });
  it('plans a facility inspection: the regime decides the subject kind, the subject comes from the register', async () => {
    mockGet({ '/checklist-templates': ok([{ id: 'tpl-hse', name: 'HSE Walkabout — Terminal', inspectionType: 'HSE', items: [{ seq: 1, text: 'PPE', category: 'PPE', answerType: 'YES_NO', weight: 1, critical: false }], active: true, version: 1, passScorePct: 80 }]), '/inspections/subjects': (cfg) => ok(cfg?.params?.kind === 'PORT_FACILITY' ? subjects : []) });
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({ id: 'new', number: 'INS-2026-130' }) as never);
    const onPlanned = vi.fn();
    wrap(<PlanInspectionDialog open onClose={() => undefined} onPlanned={onPlanned} />);
    fireEvent.mouseDown(await screen.findByLabelText(/Regime/));
    fireEvent.click(await screen.findByRole('option', { name: 'HSE inspection' }));
    expect(await screen.findByText('This regime applies to a Port facility')).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url === '/inspections/subjects' && c.cfg?.params?.kind === 'PORT_FACILITY')).toBe(true));
    const subject = screen.getByLabelText(/Port facility/);
    fireEvent.change(subject, { target: { value: 'Bulk' } });
    fireEvent.click(await screen.findByRole('option', { name: 'Bulk Terminal — BT-02 · BT-02' }));
    fireEvent.mouseDown(screen.getByLabelText(/Checklist template/));
    fireEvent.click(await screen.findByRole('option', { name: 'HSE Walkabout — Terminal (1 items)' }));
    fireEvent.click(screen.getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/inspections', expect.objectContaining({ type: 'HSE', subjectKind: 'PORT_FACILITY', subjectId: 'b2', templateId: 'tpl-hse' })));
    await waitFor(() => expect(onPlanned).toHaveBeenCalledWith({ id: 'new', number: 'INS-2026-130' }));
  });
});
