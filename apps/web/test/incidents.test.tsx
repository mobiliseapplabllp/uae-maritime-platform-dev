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
import IncidentsRegister from '../src/pages/incidents/IncidentsRegister';
import IncidentDashboard from '../src/pages/incidents/IncidentDashboard';
import IncidentCase from '../src/pages/incidents/IncidentCase';
import RiskMatrix from '../src/pages/incidents/RiskMatrix';
import { buildTimeline, directionLabel, docSize, isLive, isReopen, matrixBand, transitionLabel, transitionsFor } from '../src/pages/incidents/constants';
import type { Incident, IncidentDashboardData, IncidentRow, RiskMatrixData } from '../src/pages/incidents/types';

// recharts measures its container with ResizeObserver, which jsdom does not ship
class RO { observe() { /* noop */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || RO;

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Duty Officer', email: 'nmc@maritime.example', active: true, kind: 'user', scope: { level: 'PORT' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
const wrap = (ui: React.ReactNode, path = '/') => render(<Provider store={store}><MemoryRouter initialEntries={[path]}><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

/* Every case here is fictional. The shapes follow `incidentRowApi` / `incidentApi` / `incidentDashboard`
 * and `riskMatrix` in services/maritime-centre/src/incidents.ts. */
const spill: IncidentRow = {
  id: 'i1', number: 'INC-2026-0117', category: 'ENVIRONMENT', type: 'OIL_SPILL', severity: 'HIGH', priority: 'P2', status: 'RESPONDING',
  title: 'Sheen observed astern of a bunkering barge', vesselId: 'v1', vesselName: 'MV Coral Reach', berthId: 'b1', berthCode: 'CT-1', berthTerminal: 'Container Terminal',
  location: { area: 'Inner harbour', lat: 24.81, lon: 54.64 }, reportedAt: '2026-09-01T05:20:00Z', reportedBy: 'Patrol launch 3', source: 'PATROL',
  assignedToId: 'u9', assignedTo: 'Pollution Response Officer',
};
const nearMiss: IncidentRow = {
  id: 'i2', number: 'INC-2026-0118', category: 'NAVIGATION', type: 'NEAR_MISS', severity: 'LOW', priority: 'P4', status: 'CLOSED',
  title: 'Two craft closing in the approach channel', vesselId: null, vesselName: 'Workboat Falcon 4', location: { area: 'Approach channel' },
  reportedAt: '2026-08-24T11:00:00Z', reportedBy: 'VTS', source: 'VHF', assignedToId: null, assignedTo: 'Duty Officer',
};
const caseFile: Incident = {
  ...spill,
  description: 'A thin sheen was seen astern of a bunkering barge during a transfer; the transfer was stopped.',
  assets: ['Pollution response launch', 'Boom trailer'], injuries: 0, pollutionTier: 1, weather: { windKn: 12, seaState: 2 },
  comms: [
    { id: 'cm1', at: '2026-09-01T05:25:00Z', by: 'Patrol launch 3', channel: 'VHF', direction: 'IN', message: 'Sheen roughly 40 m by 10 m, transfer stopped' },
    { id: 'cm2', at: '2026-09-01T05:40:00Z', by: 'Duty Officer', channel: 'PHONE', direction: 'OUT', message: 'Response launch tasked with boom' },
  ],
  documents: [{ id: 'd1', name: 'site-photographs.zip', docType: 'PHOTO', sizeKB: 2400, uploadedBy: 'Patrol launch 3', at: '2026-09-01T06:10:00Z', note: '' }],
  tasks: [
    { id: 't1', title: 'Deploy containment boom', assignee: 'Response launch', due: '2026-09-01', status: 'DONE', doneAt: '2026-09-01T06:00:00Z' },
    { id: 't2', title: 'Sample the sheen for laboratory analysis', assignee: 'Environment officer', due: '2026-09-02', status: 'OPEN', doneAt: null },
  ],
  log: [{ at: '2026-09-01T06:05:00Z', by: 'Duty Officer', entry: 'Boom deployed, sheen contained inside the berth pocket' }],
  statusHistory: [
    { from: '', to: 'OPEN', at: '2026-09-01T05:20:00Z', by: 'Patrol launch 3', note: 'First information' },
    { from: 'OPEN', to: 'RESPONDING', at: '2026-09-01T05:45:00Z', by: 'Duty Officer', note: 'Launch tasked' },
  ],
  rca: { rootCause: '', category: '', correctiveAction: '', preventiveAction: '' },
  acknowledgedAt: '2026-09-01T05:30:00Z', resolvedAt: null, closedAt: null, outcome: '',
};
const dashboard: IncidentDashboardData = {
  sla: { mttaTargetMin: 15, mttrTargetHrs: 24 },
  kpis: { open: 7, highOpen: 2, loggedYtd: 96, closedYtd: 84, mttrHrs: 19.4, mttaMin: 12, injuriesYtd: 3 },
  byMonth: [{ month: 'Jul 26', LOW: 4, MEDIUM: 3, HIGH: 1, CRITICAL: 0, total: 8 }, { month: 'Aug 26', LOW: 6, MEDIUM: 2, HIGH: 2, CRITICAL: 1, total: 11 }],
  byType: [{ type: 'NEAR_MISS', count: 21 }, { type: 'OIL_SPILL', count: 6 }],
  byCategory: [{ category: 'NAVIGATION', count: 24 }, { category: 'ENVIRONMENT', count: 9 }],
  byStatus: [{ status: 'RESPONDING', count: 4 }, { status: 'CLOSED', count: 84 }],
  aging: [{ bucket: '0-24h', count: 3 }, { bucket: '1-3d', count: 2 }, { bucket: '3-7d', count: 1 }, { bucket: '>7d', count: 1 }],
  openList: [{ id: 'i1', number: 'INC-2026-0117', title: 'Sheen observed astern of a bunkering barge', severity: 'HIGH', status: 'RESPONDING', reportedAt: '2026-09-01T05:20:00Z', priority: 'P2', assignedTo: 'Pollution Response Officer' }],
};
const matrix: RiskMatrixData = {
  days: 180, total: 33,
  initial: [{ likelihood: 4, consequence: 4, count: 2, sample: [{ id: 'i1', number: 'INC-2026-0117', title: 'Sheen observed astern of a bunkering barge', status: 'RESPONDING' }] }],
  residual: [{ likelihood: 3, consequence: 3, count: 2, sample: [{ id: 'i1', number: 'INC-2026-0117', title: 'Sheen observed astern of a bunkering barge', status: 'RESPONDING' }] }],
};
const cards = [
  { label: 'Open / unacknowledged', value: 7, sub: 'awaiting response', tone: 'error' },
  { label: 'In response', value: 4, sub: 'assets tasked', tone: 'warning' },
  { label: 'High severity YTD', value: 11, sub: 'high + critical', tone: 'default' },
  { label: 'Near misses', value: 21, sub: 'reported — a good sign', tone: 'default' },
];
const registerRoutes = { '/stats/incidents': ok({ cards }), '/incidents': ok([spill, nearMiss], { total: 2 }) };
const caseAt = (id = 'i1') => wrap(<Routes><Route path="/incidents/:id" element={<IncidentCase />} /></Routes>, `/incidents/${id}`);

describe('Incident register', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('lists every logged case with its severity, standing and case officer', async () => {
    mockGet(registerRoutes);
    wrap(<IncidentsRegister />);
    expect(await screen.findByText('INC-2026-0117')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Incident register' })).toBeInTheDocument();

    const stats = document.querySelector('[data-stats-scope="incidents"]') as HTMLElement;
    expect(within(stats).getByText('Open / unacknowledged')).toBeInTheDocument();
    expect(within(stats).getByText('awaiting response')).toBeInTheDocument();

    const table = screen.getByRole('table');
    const body = within(table).getAllByRole('rowgroup')[1];
    expect(within(body).getByText('Sheen observed astern of a bunkering barge')).toBeInTheDocument();
    expect(within(body).getByText('Environment')).toBeInTheDocument();
    expect(within(body).getByText('High')).toBeInTheDocument();
    expect(within(body).getByText('Responding')).toBeInTheDocument();
    expect(within(body).getByText('Closed')).toBeInTheDocument();
    expect(within(body).getByText('MV Coral Reach')).toBeInTheDocument();
    expect(within(body).getByText('Workboat Falcon 4')).toBeInTheDocument();
    expect(within(body).getByText('Pollution Response Officer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Log incident' })).toBeInTheDocument();
  });

  it('filters the register down to one severity band', async () => {
    const get = mockGet(registerRoutes);
    wrap(<IncidentsRegister />);
    await screen.findByText('INC-2026-0117');
    fireEvent.mouseDown(screen.getAllByLabelText('Severity')[0]);
    fireEvent.click(await screen.findByRole('option', { name: 'Critical' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/incidents', { params: expect.objectContaining({ severity: 'CRITICAL', page: 1 }) }));
  });

  it('logs a new case from the report drawer', async () => {
    mockGet({ ...registerRoutes, '/vessels': ok([{ id: 'v1', name: 'MV Coral Reach' }]), '/berths': ok([{ id: 'b1', code: 'CT-1', terminal: 'Container Terminal' }]), '/lookups': ok([{ id: 'l1', code: 'INNER', label: 'Inner harbour' }]) });
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({ id: 'i9', number: 'INC-2026-0119' }) as never);
    wrap(<IncidentsRegister />);
    fireEvent.click(await screen.findByRole('button', { name: 'Log incident' }));
    const drawer = await screen.findByRole('presentation');
    expect(within(drawer).getByText('A case number is assigned automatically; the lifecycle starts at OPEN')).toBeInTheDocument();
    fireEvent.change(within(drawer).getByLabelText(/^Title/), { target: { value: 'Mooring line parted at CT-1' } });
    fireEvent.mouseDown(within(drawer).getByLabelText(/^Incident type/));
    fireEvent.click(await screen.findByRole('option', { name: 'Mooring Failure' }));
    fireEvent.click(within(drawer).getAllByRole('button', { name: 'Log incident' })[0]);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/incidents', expect.objectContaining({ title: 'Mooring line parted at CT-1', type: 'MOORING_FAILURE', category: 'MARINE', severity: 'MEDIUM' })));
  });
});

describe('Incident dashboard', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows the response posture, the ageing of open work and the live case list', async () => {
    mockGet({ '/incidents/dashboard': ok(dashboard) });
    wrap(<IncidentDashboard />);
    expect(await screen.findByText('Open cases')).toBeInTheDocument();
    const open = screen.getByText('Open cases').closest('.MuiCard-root') as HTMLElement;
    expect(within(open).getByText('7')).toBeInTheDocument();
    expect(screen.getByText('2 high / critical')).toBeInTheDocument();
    expect(screen.getByText('84 closed YTD')).toBeInTheDocument();
    expect(screen.getByText('19.4 h')).toBeInTheDocument();
    expect(screen.getByText('acknowledge in ~12 min')).toBeInTheDocument();
    expect(screen.getByText('Open-case ageing')).toBeInTheDocument();
    expect(screen.getByText('Responding · 4')).toBeInTheDocument();
    expect(screen.getByText('Navigation · 24')).toBeInTheDocument();
    const live = screen.getByRole('table', { name: 'Live open cases' });
    expect(within(live).getByText('INC-2026-0117')).toBeInTheDocument();
    expect(within(live).getByText('High')).toBeInTheDocument();
  });
});

describe('Incident case file', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('draws the facts, the threads and the lifecycle moves the case allows', async () => {
    mockGet({ '/incidents/i1': ok(caseFile), '/lookups': ok([{ id: 'l1', code: 'PHOTO', label: 'Photo' }]) });
    caseAt();
    expect(await screen.findByRole('heading', { name: /INC-2026-0117/ })).toBeInTheDocument();
    expect(screen.getByText('Sheen observed astern of a bunkering barge')).toBeInTheDocument();
    expect(screen.getByText('Environment · Oil Spill')).toBeInTheDocument();
    expect(screen.getByText('Patrol launch 3 · via PATROL')).toBeInTheDocument();
    expect(screen.getByText('CT-1 — Container Terminal')).toBeInTheDocument();
    expect(screen.getByText('Wind 12 kn · sea state 2')).toBeInTheDocument();
    expect(screen.getByText('Tier 1')).toBeInTheDocument();
    expect(screen.getByText('Pollution response launch, Boom trailer')).toBeInTheDocument();
    // RESPONDING may move to MONITORING or RESOLVED, and to nothing else
    expect(screen.getByRole('button', { name: 'Move to monitoring' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Resolve' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close case' })).not.toBeInTheDocument();

    expect(screen.getByText('Sheen roughly 40 m by 10 m, transfer stopped')).toBeInTheDocument();
    expect(screen.getByText('Received')).toBeInTheDocument();
    expect(screen.getByText('Sent')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Tasks & response/ }));
    const tasks = await screen.findByRole('table', { name: 'Response tasks' });
    const taskRows = within(tasks).getAllByRole('rowgroup')[1];
    expect(within(taskRows).getByText('Deploy containment boom')).toBeInTheDocument();
    expect(within(taskRows).getByText('Environment officer')).toBeInTheDocument();
    expect(within(taskRows).getByText('Done')).toBeInTheDocument();
    expect(within(taskRows).getByText('Open')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Documents (1)' }));
    expect(await screen.findByText('site-photographs.zip')).toBeInTheDocument();
    expect(screen.getByText(/Photo · 2.3 MB · Patrol launch 3/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Timeline & logs' }));
    expect(await screen.findByText('Boom deployed, sheen contained inside the berth pocket')).toBeInTheDocument();
    expect(screen.getByText('OPEN → RESPONDING — Launch tasked')).toBeInTheDocument();
    expect(screen.getByText('Attached site-photographs.zip')).toBeInTheDocument();
  });

  it('closes a response task and moves the case through its lifecycle', async () => {
    mockGet({ '/incidents/i1': ok(caseFile), '/lookups': ok([]) });
    const put = vi.spyOn(api, 'put').mockResolvedValue(ok({}) as never);
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({}) as never);
    caseAt();
    fireEvent.click(await screen.findByRole('tab', { name: /Tasks & response/ }));
    fireEvent.click(await screen.findByRole('checkbox', { name: 'Done — Sample the sheen for laboratory analysis' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/incidents/i1/tasks/t2', { status: 'DONE' }));

    fireEvent.click(screen.getByRole('button', { name: 'Resolve' }));
    const dialog = await screen.findByRole('dialog');
    // a resolution needs a summary before it will go through
    expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Resolution summary (required)'), { target: { value: 'Sheen recovered, no shoreline impact' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/incidents/i1/transition', { to: 'RESOLVED', note: 'Sheen recovered, no shoreline impact' }));
  });
});

describe('Risk matrix', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('draws initial next to residual risk and reloads for a different window', async () => {
    const get = mockGet({ '/incidents/risk-matrix': ok(matrix) });
    wrap(<RiskMatrix />);
    expect(await screen.findByRole('grid', { name: 'Initial risk' })).toBeInTheDocument();
    expect(screen.getByRole('grid', { name: 'Residual risk (after response)' })).toBeInTheDocument();
    expect(screen.getByText('33 incidents scored by likelihood (priority) × consequence (severity)')).toBeInTheDocument();
    expect(screen.getAllByText('Cases from the last 180 days')).toHaveLength(2);
    const initial = screen.getByRole('grid', { name: 'Initial risk' });
    expect(within(initial).getByRole('gridcell', { name: 'Likely × Major: 2' })).toBeInTheDocument();
    expect(within(initial).getByRole('gridcell', { name: 'Rare × Negligible: 0' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '1 year' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/incidents/risk-matrix', { params: { days: 365 } }));
  });
});

describe('case-file helpers', () => {
  it('offers only the successors the declared lifecycle allows, and names a reopen a reopen', () => {
    expect(transitionsFor('RESPONDING')).toEqual(['MONITORING', 'RESOLVED']);
    expect(transitionsFor('CLOSED')).toEqual(['RESPONDING']);
    expect(isReopen('CLOSED', 'RESPONDING')).toBe(true);
    expect(isReopen('OPEN', 'RESPONDING')).toBe(false);
    expect(transitionLabel('CLOSED', 'RESPONDING')).toBe('Reopen');
    expect(transitionLabel('RESPONDING', 'RESOLVED')).toBe('Resolve');
    expect(isLive('MONITORING')).toBe(true);
    expect(isLive('CLOSED')).toBe(false);
  });
  it('merges status changes, log entries and attachments newest first', () => {
    const rows = buildTimeline(caseFile);
    expect(rows).toHaveLength(4);
    expect(rows[0]).toMatchObject({ kind: 'DOC', text: 'Attached site-photographs.zip' });
    expect(rows[3]).toMatchObject({ kind: 'STATUS', text: 'New → OPEN — First information' });
  });
  it('labels a communication by its direction and sizes an attachment', () => {
    expect(directionLabel('IN')).toBe('Received');
    expect(directionLabel('OUT')).toBe('Sent');
    expect(directionLabel('INTERNAL')).toBe('Internal note');
    expect(docSize(640)).toBe('640 KB');
    expect(docSize(2400)).toBe('2.3 MB');
  });
  it('bands the 5×5 heatmap by likelihood × consequence', () => {
    expect(matrixBand(5, 5)).toBe('#B3452E');
    expect(matrixBand(2, 4)).toBe('#C77B2E');
    expect(matrixBand(2, 2)).toBe('#C7A62E');
    expect(matrixBand(1, 2)).toBe('#3D8361');
  });
});
