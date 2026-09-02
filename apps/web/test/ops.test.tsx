import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { store } from '../src/store';
import { setSession } from '../src/store/authSlice';
import { buildTheme } from '../src/theme';
import api from '../src/api/client';
import { fmtD } from '../src/utils/format';
import BerthPlanner from '../src/pages/ops/BerthPlanner';
import VesselSchedule from '../src/pages/ops/VesselSchedule';
import PortTwin from '../src/pages/ops/PortTwin';
import MarineServices from '../src/pages/ops/MarineServices';
import { DAY, dayLabel, dayTicks, groupByDay, pctOf, plannerStart, spanOf } from '../src/pages/ops/planner';
import { SLOT_GAP, SLOT_W, shipWidth, shortName, twinLayout } from '../src/pages/ops/twin';
import type { BerthPlan, FleetUtilisationData, MarineResource, ResourceHistory, ScheduleData, ScheduleEvent, TwinBerth, TwinData } from '../src/pages/ops/types';

// recharts measures its container with ResizeObserver, which jsdom does not ship
class RO { observe() { /* noop */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || RO;

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Harbour Master', email: 'hm@maritime.example', active: true, kind: 'user', scope: { level: 'PORT' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
const wrap = (ui: React.ReactNode) => render(<Provider store={store}><MemoryRouter><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);
const at = (base: Date, days: number, hours = 0) => new Date(base.getTime() + days * DAY + hours * 3600 * 1000).toISOString();

// Fictional ships throughout.
const from = plannerStart();
const plan: BerthPlan = {
  window: { from: from.toISOString(), to: at(from, 7), days: 6 },
  berths: [
    { id: 'b-ct1', code: 'CT-1', name: 'Container berth 1', terminal: 'Container Terminal', berthType: 'CONTAINER', status: 'OPERATIONAL', loaMax: 366, draftMax: 16 },
    { id: 'b-bb2', code: 'BB-2', name: 'Bulk berth 2', terminal: 'Bulk Terminal', berthType: 'BULK', status: 'MAINTENANCE', loaMax: 250, draftMax: 14 },
  ],
  blocks: [
    { id: 'pc1', vcn: 'VCN-2026-0001', berthId: 'b-ct1', status: 'BERTHED', vessel: { name: 'MV Coral Reach', loa: 260, type: 'CONT' }, start: at(from, 1), end: at(from, 3), actual: true },
    { id: 'pc2', vcn: 'VCN-2026-0002', berthId: 'b-ct1', status: 'CONFIRMED', vessel: { name: 'MV Amber Dune', loa: 190, type: 'CONT' }, start: at(from, 2), end: at(from, 4), actual: false },
  ],
  conflicts: [{ a: 'VCN-2026-0001', b: 'VCN-2026-0002', berthId: 'b-ct1' }],
  unallocated: [{ id: 'pc3', vcn: 'VCN-2026-0003', eta: at(from, 2, 6), status: 'ANNOUNCED', vessel: { name: 'MV Sable Wind', loa: 120, type: 'GEN' } }],
};
const today = new Date(); today.setHours(0, 0, 0, 0);
const schedule: ScheduleData = {
  from: at(today, -1), to: at(today, 5),
  events: [
    { callId: 'pc1', vcn: 'VCN-2026-0001', vesselId: 'v1', vessel: 'MV Coral Reach', type: 'CONT', berth: 'CT-1', agent: 'Gulf Coast Agencies (sample)', status: 'BERTHED', kind: 'SAILING', at: at(today, 0, 18), planned: true },
    { callId: 'pc2', vcn: 'VCN-2026-0002', vesselId: 'v2', vessel: 'MV Amber Dune', type: 'BULK', berth: '—', status: 'CONFIRMED', kind: 'ARRIVAL', at: at(today, 1, 6), planned: true },
    { callId: 'pc4', vcn: 'VCN-2026-0004', vesselId: 'v4', vessel: 'MV Sable Wind', type: 'GEN', berth: 'BB-2', status: 'SAILED', kind: 'SAILED', at: at(today, 0, 9), planned: false },
  ],
};
const twinBerths: TwinBerth[] = [
  { id: 'b-ct1', code: 'CT-1', name: 'Container berth 1', terminal: 'Container Terminal', berthType: 'CONTAINER', loaMax: 366, draftMax: 16, status: 'OPERATIONAL', occupiedBy: { callId: 'pc1', vcn: 'VCN-2026-0001', vesselId: 'v1', vessel: 'MV Coral Reach', type: 'CONT', loa: 260, atb: at(today, -1, 4), etd: at(today, 1, 6), cargo: 'discharge 1,200 TEU CONTAINERS' } },
  { id: 'b-bb2', code: 'BB-2', name: 'Bulk berth 2', terminal: 'Bulk Terminal', berthType: 'BULK', loaMax: 250, draftMax: 14, status: 'OPERATIONAL', occupiedBy: null },
  { id: 'b-spm1', code: 'SPM-1', name: 'Single point mooring 1', terminal: 'Offshore', berthType: 'SPM', loaMax: 340, draftMax: 22, status: 'OPERATIONAL', occupiedBy: null },
];
const twin: TwinData = {
  berths: twinBerths,
  anchorage: [{ callId: 'pc2', vcn: 'VCN-2026-0002', vesselId: 'v2', vessel: 'MV Amber Dune', type: 'BULK', loa: 190, since: at(today, 0, 2), etb: at(today, 0, 20) }],
  inbound: [{ callId: 'pc3', vcn: 'VCN-2026-0003', vesselId: 'v3', vessel: 'MV Sable Wind', type: 'GEN', loa: 120, eta: at(today, 1, 8), status: 'ANNOUNCED' }],
};
const digest = { jobs: 412, hours: 618.5, windowJobs: 30, windowHours: 45, jobs30d: 4, lastJobAt: at(today, -2), outages: 1, outageDays: 6, availabilityPct: 98.4 };
const resources: MarineResource[] = [
  { id: 't1', code: 'TUG-01', name: 'Harbour Falcon', type: 'TUG', spec: 'ASD tug — 60 T bollard pull', status: 'AVAILABLE', master: 'Capt. F. Nasser', contact: 'VHF 12', service: digest },
  { id: 'p1', code: 'PLT-01', name: 'Capt. N. Al Marzouqi', type: 'PILOT', spec: 'Unrestricted pilot licence', status: 'TASKED', currentTask: 'VCN-2026-0001 — berthing CT-1', contact: 'VHF 14', service: { ...digest, jobs: 260, windowJobs: 10 } },
];
const history: ResourceHistory = {
  resource: { id: 't1', code: 'TUG-01', name: 'Harbour Falcon', type: 'TUG', spec: 'ASD tug — 60 T bollard pull', status: 'AVAILABLE', master: 'Capt. F. Nasser', contact: 'VHF 12' },
  summary: {
    window: { from: at(today, -365), to: at(today, 0), months: 12 }, jobs: 30, hours: 45, avgHours: 1.5, avgJobsPerMonth: 2.5, outageDays: 6, availabilityPct: 98.4,
    busiestMonth: { month: '2026-05', label: 'May 26', jobs: 5, hours: 7.5 }, lifetime: { jobs: 412, hours: 618.5, firstJobAt: '2023-01-04T06:00:00Z', lastJobAt: at(today, -2), outages: 1, outageDays: 6 },
    series: [{ month: '2026-05', label: 'May 26', jobs: 5, hours: 7.5 }, { month: '2026-06', label: 'Jun 26', jobs: 3, hours: 4 }], byKind: [{ kind: 'BERTHING', jobs: 18, hours: 27 }, { kind: 'UNBERTHING', jobs: 12, hours: 18 }],
  },
  outages: [{ id: 'o1', from: '2026-03-02T00:00:00Z', to: '2026-03-08T00:00:00Z', reason: 'Annual survey', days: 6 }],
  jobs: [{ id: 'j1', at: at(today, -2, 5), kind: 'BERTHING', vcn: 'VCN-2026-0001', vesselName: 'MV Coral Reach', berth: 'CT-1', hours: 1.5 }],
};
const utilisation: FleetUtilisationData = {
  window: { from: at(today, -365), to: at(today, 0), months: 12 },
  totals: { craft: 2, jobs: 40, hours: 60, jobsAllTime: 672, hoursAllTime: 990, avgJobsPerMonth: 3.3, avgHoursPerJob: 1.5, outageDays: 6, availabilityPct: 99.2 },
  series: history.summary.series, byKind: history.summary.byKind, byType: [{ type: 'TUG', craft: 1, jobs: 30, hours: 45 }, { type: 'PILOT', craft: 1, jobs: 10, hours: 15 }],
  craft: [{ id: 't1', code: 'TUG-01', name: 'Harbour Falcon', type: 'TUG', status: 'AVAILABLE', jobs: 30, hours: 45, jobsAllTime: 412, hoursAllTime: 618.5, outageDays: 6, availabilityPct: 98.4, lastJobAt: at(today, -2) }],
};

describe('Harbour-operations pages', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('draws the berth window planner with conflicts and the unallocated rail', async () => {
    mockGet({ '/ops/berth-plan': ok(plan) });
    wrap(<BerthPlanner />);
    expect(await screen.findByText('1 berth conflict')).toBeInTheDocument();
    expect(screen.getByText('Berth Window Planner')).toBeInTheDocument();
    expect(screen.getByText('CT-1')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /CT-1: MV Coral Reach · VCN-2026-0001 · BERTHED \(actual\) — conflict/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /MV Amber Dune · VCN-2026-0002 · CONFIRMED \(planned\)/ })).toBeInTheDocument();
    expect(screen.getByText('Awaiting berth allocation (1)')).toBeInTheDocument();
    expect(screen.getByText(/MV Sable Wind — ETA/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Today' })).toBeInTheDocument();
  });

  it('groups the vessel schedule by day and reloads for a wider window', async () => {
    const get = mockGet({ '/ops/schedule': ok(schedule) });
    wrap(<VesselSchedule />);
    expect(await screen.findByText(/^Today — /)).toBeInTheDocument();
    expect(screen.getByText(/^Tomorrow — /)).toBeInTheDocument();
    expect(screen.getByText('2 movements')).toBeInTheDocument();
    expect(screen.getByText('Sailing (planned)')).toBeInTheDocument();
    expect(screen.getAllByText('Sailed').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Arrival').length).toBeGreaterThan(0);
    expect(screen.getByText('MV Coral Reach')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/ops/schedule', { params: { days: 7 } }));
  });

  it('renders the quay twin with accessible ships and a text alternative', async () => {
    mockGet({ '/ops/twin': ok(twin) });
    wrap(<PortTwin />);
    expect(await screen.findByText('Quay view — live 2-D twin')).toBeInTheDocument();
    expect(screen.getByText('1 of 3 berths occupied · 1 at anchorage · 1 inbound — refreshes every minute')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Quay view — berths, anchorage and inbound traffic' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /MV Coral Reach · VCN-2026-0001 · discharge 1,200 TEU CONTAINERS/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /MV Amber Dune · VCN-2026-0002 · At anchor since/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MV Sable Wind — open call VCN-2026-0003' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Berth occupancy' });
    expect(within(table).getByText('MV Coral Reach (VCN-2026-0001)')).toBeInTheDocument();
    expect(within(table).getAllByText('Free')).toHaveLength(2);
    expect(screen.getByText('Ship length drawn to scale against its berth')).toBeInTheDocument();
  });

  it('shows the craft board and changes a unit status from its menu', async () => {
    mockGet({ '/ops/resources': ok(resources), '/stats/marine': ok({ cards: [] }) });
    const put = vi.spyOn(api, 'put').mockResolvedValue(ok({}) as never);
    wrap(<MarineServices />);
    expect(await screen.findByText('Harbour Falcon')).toBeInTheDocument();
    expect(screen.getByText('Marine craft & pilots')).toBeInTheDocument();
    expect(screen.getByText('Pilotage runs 24×365 · 1 available · 1 tasked now')).toBeInTheDocument();
    expect(screen.getByText('Tugs')).toBeInTheDocument();
    expect(screen.getByText('Pilot roster')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Craft board (2)' })).toBeInTheDocument();
    expect(screen.getByText('VCN-2026-0001 — berthing CT-1')).toBeInTheDocument();
    expect(screen.getByText(`412 jobs on record · last ${fmtD(digest.lastJobAt)}`)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Set status — Harbour Falcon' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Maintenance' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/ops/resources/t1', { status: 'MAINTENANCE' }));
  });

  it('opens a craft service record and the fleet utilisation tab', async () => {
    mockGet({ '/ops/resources': ok(resources), '/stats/marine': ok({ cards: [] }), '/ops/resources/t1/history': ok(history, { total: 1, page: 1, limit: 10, kinds: ['BERTHING', 'UNBERTHING'] }), '/ops/resources/utilisation': ok(utilisation) });
    wrap(<MarineServices />);
    fireEvent.click(await screen.findByRole('button', { name: 'Service record — Harbour Falcon' }));
    expect(await screen.findByText('TUG-01 — Harbour Falcon')).toBeInTheDocument();
    expect(await screen.findByText('Jobs since 2023')).toBeInTheDocument();
    expect(screen.getByText('Annual survey')).toBeInTheDocument();
    expect(screen.getByText('berthing · 18 jobs · 27 h')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Jobs done' })).toHaveTextContent('MV Coral Reach');
    fireEvent.click(screen.getByRole('button', { name: 'Close' }));
    fireEvent.click(await screen.findByRole('tab', { name: 'Fleet utilisation · 40 jobs in 12 months' }));
    expect(await screen.findByText('Jobs per month across the fleet')).toBeInTheDocument();
    expect(screen.getByText('672')).toBeInTheDocument();
    expect(screen.getByText('30 jobs · Harbour Falcon')).toBeInTheDocument();
  });
});

describe('planner maths', () => {
  const start = new Date(2026, 8, 1); const end = new Date(2026, 8, 8);
  const span = spanOf(start.toISOString(), end.toISOString());
  it('places instants inside the window as a clamped percentage', () => {
    expect(span.totalMs).toBe(7 * DAY);
    expect(pctOf(span, new Date(2026, 8, 4, 12))).toBe(50);
    expect(pctOf(span, new Date(2026, 7, 1))).toBe(0);
    expect(pctOf(span, new Date(2026, 9, 1))).toBe(100);
  });
  it('draws one tick per local midnight', () => {
    const ticks = dayTicks(span);
    expect(ticks).toHaveLength(8);
    expect(ticks[0]).toEqual({ pct: 0, label: '01 Sep' });
    expect(ticks[7]).toEqual({ pct: 100, label: '08 Sep' });
    expect(ticks.every((t, i) => i === 0 || t.pct > ticks[i - 1].pct)).toBe(true);
  });
  it('opens on yesterday and names days relative to today', () => {
    const s = plannerStart(new Date(2026, 8, 2, 15, 30));
    expect([s.getFullYear(), s.getMonth(), s.getDate(), s.getHours()]).toEqual([2026, 8, 1, 0]);
    expect(dayLabel(new Date())).toMatch(/^Today — /);
    expect(dayLabel(new Date(Date.now() + DAY))).toMatch(/^Tomorrow — /);
    expect(dayLabel(new Date(Date.now() - DAY))).toMatch(/^Yesterday — /);
    expect(dayLabel(new Date(2026, 8, 20), new Date(2026, 8, 2))).toBe('Sunday, 20 Sep');
  });
  it('groups movements by local day in date order', () => {
    const ev = (i: number, day: number): ScheduleEvent => ({ callId: `c${i}`, vcn: `V${i}`, vesselId: `v${i}`, vessel: `MV ${i}`, berth: '—', status: 'CONFIRMED', kind: 'ARRIVAL', at: new Date(2026, 8, day, 10 + i).toISOString(), planned: true });
    const days = groupByDay([ev(1, 5), ev(2, 3), ev(3, 5)]);
    expect(days.map((d) => d.date.getDate())).toEqual([3, 5]);
    expect(days[1].events.map((e) => e.callId)).toEqual(['c1', 'c3']);
  });
});

describe('quay twin layout', () => {
  it('puts container quays on top, SPMs offshore and everything else between', () => {
    const l = twinLayout(twinBerths);
    expect(l.rows[0].map((g) => g.terminal)).toEqual(['Container Terminal']);
    expect(l.rows[1].map((g) => g.terminal)).toEqual(['Bulk Terminal']);
    expect(l.rows[2].map((g) => g.terminal)).toEqual(['Offshore']);
    expect(l.rows[0][0]).toMatchObject({ x: 24, w: SLOT_W + SLOT_GAP + 14 });
    expect(l.width).toBe(1500);
  });
  it('scales the hull against the berth and keeps it legible', () => {
    expect(shipWidth({ ...twinBerths[0], loaMax: 300, occupiedBy: { ...twinBerths[0].occupiedBy!, loa: 150 } })).toBe(68);
    expect(shipWidth({ ...twinBerths[0], loaMax: 300, occupiedBy: { ...twinBerths[0].occupiedBy!, loa: 60 } })).toBe(56);
    expect(shipWidth(twinBerths[1])).toBeCloseTo(108.8);
    expect(shortName('MV Coral Reach')).toBe('Coral');
    expect(shortName(null)).toBe('');
  });
});
