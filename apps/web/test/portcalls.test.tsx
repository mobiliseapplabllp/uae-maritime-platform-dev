import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { store } from '../src/store';
import { setSession } from '../src/store/authSlice';
import { buildTheme } from '../src/theme';
import api from '../src/api/client';
import PortCallsList from '../src/pages/portcalls/PortCallsList';
import PortCallDetail from '../src/pages/portcalls/PortCallDetail';
import { isClosed, nextActions } from '../src/pages/portcalls/constants';
import type { PdaData, PortCall, PortCallRow, SofData } from '../src/pages/portcalls/types';

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Harbour Master', email: 'hm@maritime.example', active: true, kind: 'user', scope: { level: 'PORT' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
const wrap = (ui: React.ReactNode, path = '/') => render(<Provider store={store}><MemoryRouter initialEntries={[path]}><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

// A fictional call by a fictional ship for a fictional agent.
const row: PortCallRow = {
  id: 'pc1', vcn: 'VCN-2026-0001', status: 'AT_ANCHORAGE', vesselId: 'v1', vesselName: 'MV Coral Reach', vesselImo: '9000001', vesselType: 'CONT', vesselFlag: 'Panama',
  berthId: null, berthCode: null, agentCode: 'AG-01', agentName: 'Gulf Coast Agencies (sample)', purpose: 'Discharge', eta: '2026-09-02T06:00:00Z', etd: '2026-09-04T18:00:00Z',
};
const call: PortCall = {
  ...row, status: 'CONFIRMED',
  vessel: { id: 'v1', name: 'MV Coral Reach', imo: '9000001', type: 'CONT', flag: 'Panama', grt: 41000, dwt: 52000, loa: 260, maxDraft: 12.5 }, berth: null,
  prevPort: 'SGSIN — Singapore', nextPort: 'AEJEA — Jebel Ali', crew: { count: 22, master: 'Capt. R. Haddad' },
  services: [{ id: 's1', type: 'PILOTAGE', qty: 1, unit: 'movement', tariffCode: 'PIL', at: '2026-09-02T05:00:00Z' }],
  cargoOps: [{ id: 'c1', cargoType: 'CONTAINERS', operation: 'DISCHARGE', qty: 1200, unit: 'TEU', qtyMT: 14400, gangs: 3 }],
  statusHistory: [{ from: '', to: 'ANNOUNCED', at: '2026-08-30T09:00:00Z', by: 'Shipping agent', note: 'Call announced' }, { from: 'ANNOUNCED', to: 'CONFIRMED', at: '2026-08-31T09:00:00Z', by: 'Harbour Master' }],
};
const sof: SofData = { call: { id: 'pc1', vcn: 'VCN-2026-0001', agentName: 'Gulf Coast Agencies (sample)', vessel: call.vessel, berth: null }, events: [{ at: '2026-08-30T09:00:00Z', event: 'Vessel call announced', detail: 'VCN VCN-2026-0001 issued to Gulf Coast Agencies (sample)' }] };
const pda: PdaData = {
  call: { vcn: 'VCN-2026-0001', vessel: call.vessel, agentName: 'Gulf Coast Agencies (sample)', eta: row.eta },
  pda: { number: 'PDA/VCN-2026-0001', lines: [{ code: 'PIL', description: 'Pilotage — inward + outward', unit: 'movement', qty: 2, rate: 500, amount: 1000 }], subtotal: 1000, taxRate: 5, taxAmount: 50, total: 1050, generatedAt: '2026-08-31T10:00:00Z' },
  variance: null,
};
const detailRoutes = { '/port-calls/pc1': ok(call), '/port-calls/pc1/sof': ok(sof), '/port-calls/pc1/pda': ok(pda) };
const renderDetail = () => wrap(<Routes><Route path="/port-calls/:id" element={<PortCallDetail />} /></Routes>, '/port-calls/pc1');

describe('Vessel-call pages', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('lists calls from /port-calls and opens the announce dialog', async () => {
    mockGet({ '/stats/portcalls': ok({ cards: [] }), '/port-calls': ok([row], { total: 1 }), '/vessels': ok([{ id: 'v1', name: 'MV Coral Reach', imo: '9000001' }]), '/lookups': ok([{ id: 'l1', code: 'AG-01', label: 'Gulf Coast Agencies (sample)' }]) });
    wrap(<PortCallsList />);
    expect(screen.getByText('Port calls')).toBeInTheDocument();
    expect(await screen.findByText('VCN-2026-0001')).toBeInTheDocument();
    expect(screen.getByText('MV Coral Reach')).toBeInTheDocument();
    expect(screen.getByText('At anchorage')).toBeInTheDocument();
    expect(screen.getByText('Gulf Coast Agencies (sample)')).toBeInTheDocument();
    expect(screen.getByText('1 records')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Announce call' }));
    expect(await screen.findByText('Announce port call')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Announce' })).toBeDisabled();
  });

  it('renders the call with its lifecycle buttons, tabs and timeline, and posts a transition', async () => {
    mockGet(detailRoutes);
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({}) as never);
    renderDetail();
    expect(await screen.findByRole('heading', { name: /MV Coral Reach/ })).toBeInTheDocument();
    expect(screen.getByText('Confirmed')).toBeInTheDocument();
    expect(screen.getByText(/Agent: Gulf Coast Agencies \(sample\)/)).toBeInTheDocument();
    for (const name of ['Statement of Facts', 'Cost estimate', 'Arrived at anchorage', 'Berth vessel', 'Cancel']) expect(screen.getByRole('button', { name })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Generate invoice' })).not.toBeInTheDocument();
    expect(screen.getByText('SGSIN — Singapore → AEJEA — Jebel Ali')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Services (1)' }));
    expect(await screen.findByText('PILOTAGE')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Cargo (1)' }));
    expect(await screen.findByText('CONTAINERS')).toBeInTheDocument();
    expect(screen.getByText('1,200 TEU')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Timeline' }));
    expect(await screen.findByText('(from Announced)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Arrived at anchorage' }));
    const confirm = await screen.findByRole('button', { name: 'Confirm' });
    fireEvent.click(confirm);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/port-calls/pc1/transition', expect.objectContaining({ to: 'AT_ANCHORAGE' })));
  });

  it('opens the Statement of Facts', async () => {
    mockGet(detailRoutes);
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Statement of Facts' }));
    expect(await screen.findByText('Vessel call announced')).toBeInTheDocument();
    expect(screen.getByText(/issued to Gulf Coast Agencies/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download PDF' })).toBeInTheDocument();
  });

  it('opens the cost estimate with the jurisdiction tax head and currency', async () => {
    mockGet(detailRoutes);
    renderDetail();
    fireEvent.click(await screen.findByRole('button', { name: 'Cost estimate' }));
    expect(await screen.findByText('PDA/VCN-2026-0001')).toBeInTheDocument();
    expect(screen.getByText('VAT @ 5%')).toBeInTheDocument();
    expect(screen.getByText(/1,050\.00/)).toBeInTheDocument();
    expect(screen.getByText('Variance appears once this call has an issued invoice.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Regenerate' })).toBeInTheDocument();
  });
});

describe('call lifecycle helpers', () => {
  it('offers the moves the declared transition table allows', () => {
    expect(nextActions('CONFIRMED').map((a) => a.label)).toEqual(['Arrived at anchorage', 'Berth vessel', 'Cancel']);
    expect(nextActions('CONFIRMED').find((a) => a.to === 'CANCELLED')?.danger).toBe(true);
    expect(nextActions('BERTHED')).toEqual([{ to: 'SAILED', label: 'Sail vessel', danger: false }]);
    expect(nextActions('SAILED')).toEqual([]);
  });
  it('treats sailed and cancelled calls as read-only record', () => {
    expect(isClosed('SAILED')).toBe(true);
    expect(isClosed('CANCELLED')).toBe(true);
    expect(isClosed('BERTHED')).toBe(false);
  });
});
