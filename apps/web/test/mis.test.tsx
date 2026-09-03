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
import ReportLibrary from '../src/pages/mis/ReportLibrary';
import ReportViewer from '../src/pages/mis/ReportViewer';
import MisReport from '../src/pages/mis/MisReport';
import { avgOf, benchmarkLabel, benchmarkValue, chartSpec, collectionPct, fmtCell, numericColumns, outstandingOf } from '../src/pages/mis/shared';
import type { MisData, MisMonth, ReportDef, ReportRun } from '../src/pages/mis/types';

// recharts measures its container with ResizeObserver, which jsdom does not ship
class RO { observe() { /* noop */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || RO;

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Planning Officer', email: 'mis@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
const wrap = (ui: React.ReactNode, path = '/') => render(<Provider store={store}><MemoryRouter initialEntries={[path]}><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

/* Fictional figures. The catalogue rows are the raw `report_definitions` columns the reporting service
 * selects (snake_case `name_ar` / `query_key`); the MIS payload follows ReportsController.mis. */
const catalog: ReportDef[] = [
  { key: 'port-calls-by-month', name: 'Port calls by month', name_ar: 'رحلات السفن حسب الشهر', category: 'Traffic', description: 'Calls, turnaround and tonnage per month', perm: 'portcalls.view', params: [{ name: 'months', label: 'Months', type: 'number', default: 12 }], columns: [{ key: 'month', label: 'Month' }, { key: 'calls', label: 'Calls', align: 'right' }, { key: 'cargo_mt', label: 'Cargo MT', align: 'right' }], query_key: 'portCallsByMonth' },
  { key: 'revenue-by-month', name: 'Revenue by month', name_ar: null, category: 'Revenue', description: 'Billed and collected per month', perm: 'invoices.view', params: [{ name: 'months', label: 'Months', type: 'number', default: 12 }], columns: [{ key: 'month', label: 'Month' }, { key: 'total', label: 'Billed', align: 'right' }, { key: 'collected', label: 'Collected', align: 'right' }], query_key: 'revenueByMonth' },
  { key: 'crew-roster', name: 'Crew roster', name_ar: null, category: 'Crew', description: 'Every seafarer on the roll with the ship they are on', perm: 'seafarers.view', params: [], columns: [{ key: 'name', label: 'Name' }, { key: 'rank', label: 'Rank' }, { key: 'cdc_no', label: 'CDC no' }], query_key: 'crewRoster' },
];
const run: ReportRun = {
  report: catalog[0], params: { months: '3' }, generatedAt: '2026-09-02T06:30:00Z', currency: 'AED',
  rows: [
    { month: '2026-06', calls: 41, cargo_mt: 812000 },
    { month: '2026-07', calls: 38, cargo_mt: 764500 },
    { month: '2026-08', calls: 45, cargo_mt: 903200 },
  ],
};
const month = (key: string, label: string, over: Partial<MisMonth> = {}): MisMonth => ({
  key, month: label, calls: 40, cargoMT: 800000, teu: 22000, container: 400000, dryBulk: 250000, liquid: 120000, other: 30000,
  avgTurnaroundH: 26.4, avgWaitH: 8.1, revenue: 1200000, collected: 900000, inspections: 12, detentions: 1, findings: 34, incidents: 6, highIncidents: 1, ...over,
});
const mis: MisData = {
  months: 3, currency: 'AED', generatedAt: '2026-09-02T06:30:00Z',
  rows: [month('2026-06', 'Jun 26'), month('2026-07', 'Jul 26', { calls: 38, revenue: 1100000, collected: 1000000 }), month('2026-08', 'Aug 26', { calls: 45, inspections: 15, detentions: 2 })],
  totals: { calls: 123, cargoMT: 2400000, teu: 66000, revenue: 3500000, collected: 2800000, inspections: 39, detentions: 3, incidents: 18 },
  benchmarks: [
    { key: 'turnaroundHours', value: [20, 28], confirmed: true, source: 'Published port performance statistics' },
    { key: 'pscDetentionRatePct', value: 3.2, confirmed: false, source: 'Regional memorandum annual report' },
  ],
};

describe('Report library', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('groups the saved reports by the module that owns the data', async () => {
    mockGet({ '/reports/catalog': ok(catalog) });
    wrap(<ReportLibrary />);
    expect(await screen.findByText('Port calls by month')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Report library' })).toBeInTheDocument();
    for (const group of ['Traffic', 'Revenue', 'Crew']) expect(screen.getByRole('region', { name: group })).toBeInTheDocument();
    const traffic = screen.getByRole('region', { name: 'Traffic' });
    expect(within(traffic).getByText('Calls, turnaround and tonnage per month')).toBeInTheDocument();
    expect(within(traffic).getByText('Months = 12')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run report: Crew roster' })).toBeInTheDocument();
    expect(screen.getByText('3 reports available')).toBeInTheDocument();
  });

  it('hides a report the signed-in role may not run', async () => {
    store.dispatch(setSession({ ...session, user: { ...session.user, perms: ['reports.view', 'invoices.view'] } } as never));
    mockGet({ '/reports/catalog': ok(catalog) });
    wrap(<ReportLibrary />);
    expect(await screen.findByText('Revenue by month')).toBeInTheDocument();
    expect(screen.queryByText('Port calls by month')).not.toBeInTheDocument();
    expect(screen.queryByText('Crew roster')).not.toBeInTheDocument();
    expect(screen.getByText('1 reports available')).toBeInTheDocument();
    store.dispatch(setSession(session as never));
  });
});

describe('Report viewer', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('runs a saved report and renders its rows, chart and parameters', async () => {
    mockGet({ '/reports/run/port-calls-by-month': ok(run) });
    wrap(<Routes><Route path="/reports/view/:key" element={<ReportViewer />} /></Routes>, '/reports/view/port-calls-by-month');
    expect(await screen.findByRole('heading', { level: 1, name: 'Port calls by month' })).toBeInTheDocument();
    expect(screen.getByText('Calls, turnaround and tonnage per month · generated 02 Sep 2026, 06:30')).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Report parameters' })).toBeInTheDocument();
    expect(screen.getAllByText('3 rows').length).toBeGreaterThan(0);
    expect(screen.getByText('AED')).toBeInTheDocument();
    expect(screen.getByText('Calls, Cargo MT by row')).toBeInTheDocument();

    const table = screen.getByRole('table', { name: 'Port calls by month' });
    expect(within(table).getByText('2026-08')).toBeInTheDocument();
    expect(within(table).getByText('903,200')).toBeInTheDocument();
    expect(within(table).getByText('41')).toBeInTheDocument();
  });

  it('re-runs the report with an edited parameter', async () => {
    const get = mockGet({ '/reports/run/port-calls-by-month': ok(run) });
    wrap(<Routes><Route path="/reports/view/:key" element={<ReportViewer />} /></Routes>, '/reports/view/port-calls-by-month');
    await screen.findByRole('heading', { level: 1, name: 'Port calls by month' });
    fireEvent.change(screen.getByLabelText('Months'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run report' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/reports/run/port-calls-by-month', { params: { months: '6' } }));
  });
});

describe('MIS report', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('rolls the window up into the management headline and the traffic table', async () => {
    mockGet({ '/reports/mis': ok(mis) });
    wrap(<MisReport />);
    expect(await screen.findByText('Port calls')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'MIS report' })).toBeInTheDocument();
    expect(screen.getByText('123')).toBeInTheDocument();
    expect(screen.getByText('avg turnaround 26.4 h')).toBeInTheDocument();
    expect(screen.getByText('66,000 TEU')).toBeInTheDocument();
    expect(screen.getByText('AED 2.80M collected')).toBeInTheDocument();
    expect(screen.getByText('3 detentions')).toBeInTheDocument();
    expect(screen.getByText('Jun 26 to Aug 26 · generated 02 Sep 2026, 06:30')).toBeInTheDocument();

    const traffic = screen.getByRole('table', { name: 'Traffic by month' });
    expect(within(traffic).getByText('Avg wait (h)')).toBeInTheDocument();
    expect(within(traffic).getByText('Aug 26')).toBeInTheDocument();
    expect(within(traffic).getAllByText('800,000')).toHaveLength(3);
    expect(screen.getByText('Cargo by month')).toBeInTheDocument();
    expect(screen.getByText('average pre-berthing wait 8.1 h')).toBeInTheDocument();
  });

  it('moves between the cargo, revenue and compliance views', async () => {
    mockGet({ '/reports/mis': ok(mis) });
    wrap(<MisReport />);
    await screen.findByText('Port calls');

    fireEvent.click(screen.getByRole('tab', { name: 'Revenue' }));
    expect(await screen.findByText('Billed against collected')).toBeInTheDocument();
    expect(screen.getByText('Monthly, in AED')).toBeInTheDocument();
    expect(screen.getByText('Outstanding')).toBeInTheDocument();
    expect(screen.getByText('AED 700.0K')).toBeInTheDocument();
    expect(screen.getByText('80%')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Compliance & safety' }));
    expect(await screen.findByText('39 closed inspections · 3 detentions')).toBeInTheDocument();
    expect(screen.getByText('18 cases in the window')).toBeInTheDocument();
    const bench = screen.getByRole('table', { name: 'Jurisdiction benchmarks' });
    expect(within(bench).getByText('Turnaround (hours)')).toBeInTheDocument();
    expect(within(bench).getByText('20 – 28')).toBeInTheDocument();
    expect(within(bench).getByText('Confirmed')).toBeInTheDocument();
    expect(within(bench).getByText('Unverified')).toBeInTheDocument();
    expect(within(bench).getByText('PSC detention rate (%)')).toBeInTheDocument();
  });

  it('reloads the report for a different window from the period presets', async () => {
    const get = mockGet({ '/reports/mis': ok(mis) });
    wrap(<MisReport />);
    await screen.findByText('Port calls');
    fireEvent.click(screen.getByText('6 months'));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/reports/mis', { params: { months: 6 } }));
  });
});

describe('report formatting helpers', () => {
  const columns = [{ key: 'month', label: 'Month' }, { key: 'calls', label: 'Calls' }, { key: 'imo', label: 'IMO' }, { key: 'total', label: 'Billed' }];
  const rows = [{ month: '2026-08', calls: 45, imo: '9000001', total: 1200000 }];
  it('charts numeric columns but never identifiers', () => {
    expect(numericColumns(columns, rows)).toEqual(['calls', 'total']);
    expect(chartSpec(columns, rows)).toEqual({ label: 'month', series: ['calls', 'total'] });
    expect(chartSpec(columns, [])).toBeNull();
  });
  it('formats a cell by what the value and its column mean', () => {
    expect(fmtCell(null, 'calls')).toBe('—');
    expect(fmtCell(true, 'ack_required')).toBe('Yes');
    expect(fmtCell('2026-08-14', 'issued_at')).toBe('14 Aug 2026');
    expect(fmtCell(1200000, 'total').replace(/\u00a0/g, ' ')).toBe('AED 1,200,000.00');
    expect(fmtCell(45, 'calls')).toBe('45');
    expect(fmtCell(26.44, 'avg_turnaround_h')).toBe('26.44');
  });
  it('averages only the months that had activity and reads the benchmark table', () => {
    const quiet = [month('2026-06', 'Jun 26', { calls: 0, avgWaitH: 0 }), month('2026-07', 'Jul 26', { avgWaitH: 10 })];
    expect(avgOf(quiet, 'avgWaitH')).toBe(10);
    expect(outstandingOf(mis.totals)).toBe(700000);
    expect(collectionPct(mis.totals)).toBe(80);
    expect(collectionPct({ ...mis.totals, revenue: 0 })).toBe(0);
    expect(benchmarkLabel('preBerthingWaitHours')).toBe('Pre-berthing wait (hours)');
    expect(benchmarkLabel('someNewMeasure')).toBe('Some New Measure');
    expect(benchmarkValue([20, 28])).toBe('20 – 28');
  });
});
