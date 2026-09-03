import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import '../src/i18n';
import { store } from '../src/store';
import { setSession } from '../src/store/authSlice';
import { buildTheme } from '../src/theme';
import api, { ApiError } from '../src/api/client';
import SeafarersList from '../src/pages/seafarers/SeafarersList';
import SeafarerDetail from '../src/pages/seafarers/SeafarerDetail';
import CrewDashboard from '../src/pages/seafarers/CrewDashboard';
import { daysLeft, funnelBands, seaDays, serviceValid } from '../src/pages/seafarers/shared';
import type { CrewDashboardData, Seafarer, SeafarerRow } from '../src/pages/seafarers/types';

// recharts measures its container with ResizeObserver, which jsdom does not ship
class RO { observe() { /* noop */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || RO;

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Crew Desk Officer', email: 'crew@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
const wrap = (ui: React.ReactNode, path = '/') => render(<Provider store={store}><MemoryRouter initialEntries={[path]}><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

/* Every seafarer here is fictional. The shapes follow `seafarerApi`, `certApi`, `serviceApi` and
 * `crewDashboard` in services/seafarers/src/crew.ts; the AE profile labels the seafarer id "SID". */
const master: SeafarerRow = {
  id: 's1', cdcNo: 'CDC-100241', seafarerId: 'SID-88120', seafarerIdLabel: 'SID', nationalId: '784-1988-1234567-1', nationalIdLabel: 'Emirates ID',
  name: 'Capt. R. Haddad', dob: '1981-04-12', nationality: 'Lebanon', rank: 'Master', phone: '+971 50 000 0001', email: 'r.haddad@maritime.example',
  status: 'ACTIVE', currentVesselId: 'v1', currentVesselName: 'MV Coral Reach', signedOnAt: '2026-06-01T06:00:00Z', remarks: '', certAlerts: 1, totalSeaDays: 3120,
};
const cadet: SeafarerRow = {
  id: 's2', cdcNo: 'CDC-100788', seafarerId: 'SID-91044', seafarerIdLabel: 'SID', name: 'A. Fernandes', dob: '2001-11-02', nationality: 'India',
  rank: 'Deck Cadet', status: 'SIGNED_OFF', currentVesselId: null, currentVesselName: null, signedOnAt: null, certAlerts: 0, totalSeaDays: 210,
};
const detail: Seafarer = {
  ...master,
  certificates: [
    { id: 'c1', certType: 'Certificate of Competency', grade: 'Master Mariner', number: 'COC-4471', issuer: 'Ministry of Energy and Infrastructure', issueDate: '2022-03-01', expiryDate: '2027-03-01', status: 'VALID', remarks: '' },
    { id: 'c2', certType: 'Medical Fitness Certificate', grade: '', number: 'MED-9902', issuer: 'Approved marine clinic', issueDate: '2024-05-10', expiryDate: '2026-05-10', status: 'EXPIRED', remarks: '' },
  ],
  seaService: [
    { id: 'sv1', vesselId: 'v1', vesselName: 'MV Coral Reach', imo: '9000001', rank: 'Master', from: '2026-06-01', to: '2026-09-01', verified: true, remarks: '' },
    { id: 'sv2', vesselId: null, vesselName: 'MV Amber Dune', imo: '9000002', rank: 'Chief Officer', from: '2025-01-10', to: '2025-07-10', verified: false, remarks: '' },
  ],
};
const dashboard: CrewDashboardData = {
  kpis: { roll: 48, onboard: 31, ashore: 17, medicalIssues: 2, avgSeaDays: 1240, medicalWindow: 60 },
  byRank: [{ rank: 'Able Seafarer', count: 12 }, { rank: 'Master', count: 6 }, { rank: 'Deck Cadet', count: 4 }],
  funnel: { expired: 3, d30: 5, d90: 9, valid: 121 },
  alertList: [{ id: 's1', name: 'Capt. R. Haddad', rank: 'Master', vessel: 'MV Coral Reach', alerts: 2 }],
};
const cards = [
  { label: 'Registered', value: 48, sub: 'seafarers on the roll', tone: 'default' },
  { label: 'On board', value: 31, sub: 'currently assigned', tone: 'success' },
  { label: 'Certificate alerts', value: 3, sub: 'medical / STCW review', tone: 'warning' },
  { label: 'Ashore', value: 17, sub: 'available for assignment', tone: 'default' },
];
const registerRoutes = { '/stats/seafarers': ok({ cards }), '/seafarers': ok([master, cadet], { total: 2 }) };
const detailAt = (id = 's1') => wrap(<Routes><Route path="/seafarers/:id" element={<SeafarerDetail />} /></Routes>, `/seafarers/${id}`);

describe('Crew register', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('lists the roll with the identity labels the jurisdiction uses', async () => {
    mockGet(registerRoutes);
    wrap(<SeafarersList />);
    expect(await screen.findByText('Capt. R. Haddad')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Crew & Manning' })).toBeInTheDocument();

    const stats = document.querySelector('[data-stats-scope="seafarers"]') as HTMLElement;
    expect(within(stats).getByText('Registered')).toBeInTheDocument();
    expect(within(stats).getByText('seafarers on the roll')).toBeInTheDocument();

    const table = screen.getByRole('table');
    expect(within(table).getByText('SID')).toBeInTheDocument();
    expect(within(table).getByText('SID-88120')).toBeInTheDocument();
    expect(within(table).getByText('CDC-100788')).toBeInTheDocument();
    expect(within(table).getByText('MV Coral Reach')).toBeInTheDocument();
    expect(within(table).getByText('Ashore')).toBeInTheDocument();
    expect(within(table).getByText('Review')).toBeInTheDocument();
    expect(within(table).getByText('3,120')).toBeInTheDocument();
    expect(within(table).getByText('Active')).toBeInTheDocument();
    expect(within(table).getByText('Signed off')).toBeInTheDocument();
  });

  it('narrows the roll to one rank from the toolbar', async () => {
    const get = mockGet(registerRoutes);
    wrap(<SeafarersList />);
    await screen.findByText('Capt. R. Haddad');
    fireEvent.mouseDown(screen.getByLabelText('Rank'));
    fireEvent.click(await screen.findByRole('option', { name: 'Master' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/seafarers', { params: expect.objectContaining({ rank: 'Master', page: 1 }) }));
  });
});

describe('Crew dashboard', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('draws the manning picture, the expiry funnel and who needs attention', async () => {
    mockGet({ '/seafarers/dashboard': ok(dashboard), '/stats/seafarers': ok({ cards }) });
    wrap(<CrewDashboard />);
    expect(await screen.findByText('On the roll')).toBeInTheDocument();
    const roll = screen.getByText('On the roll').closest('.MuiCard-root') as HTMLElement;
    expect(within(roll).getByText('48')).toBeInTheDocument();
    expect(screen.getByText('31 on board · 17 ashore')).toBeInTheDocument();
    expect(screen.getByText('expiring within 60 days')).toBeInTheDocument();
    expect(screen.getByText('Expired documents')).toBeInTheDocument();
    expect(screen.getByText('5 more within 30 days')).toBeInTheDocument();
    expect(screen.getByText('1,240 d')).toBeInTheDocument();
    expect(screen.getByText('Rank distribution')).toBeInTheDocument();
    expect(screen.getByText('Every competency and medical document by time left')).toBeInTheDocument();
    const attention = screen.getByRole('table', { name: 'Needs attention' });
    expect(within(attention).getByText('Capt. R. Haddad')).toBeInTheDocument();
    expect(within(attention).getByText('Master · MV Coral Reach')).toBeInTheDocument();
  });
});

describe('Seafarer record', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows the identity header, the documents that gate a sign-on and the service book', async () => {
    mockGet({ '/seafarers/s1': ok(detail) });
    detailAt();
    expect(await screen.findByText('Master · CDC CDC-100241 · SID SID-88120 · Lebanon')).toBeInTheDocument();
    expect(screen.getByText('Total sea days')).toBeInTheDocument();
    expect(screen.getByText('3,120')).toBeInTheDocument();
    expect(screen.getByText('1 to review')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Documents (2)' }));
    const certs = await screen.findByRole('table', { name: 'Documents' });
    expect(within(certs).getByText('Certificate of Competency')).toBeInTheDocument();
    expect(within(certs).getByText('Master Mariner')).toBeInTheDocument();
    expect(within(certs).getByText('MED-9902')).toBeInTheDocument();
    expect(within(certs).getByText('Expired')).toBeInTheDocument();
    expect(within(certs).getByText(/lapsed \d+ days ago/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Sea service (2)' }));
    const service = await screen.findByRole('table', { name: 'Sea service' });
    const tours = within(service).getAllByRole('rowgroup')[1];
    expect(within(tours).getByText('MV Amber Dune')).toBeInTheDocument();
    expect(within(tours).getByText('Chief Officer')).toBeInTheDocument();
    expect(within(tours).getByText('Verified')).toBeInTheDocument();
    expect(within(tours).getByText('Declared')).toBeInTheDocument();
    expect(within(tours).getByText('92')).toBeInTheDocument();
  });

  it('records a new competency document against the record', async () => {
    mockGet({ '/seafarers/s1': ok(detail) });
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({}) as never);
    detailAt();
    fireEvent.click(await screen.findByRole('tab', { name: 'Documents (2)' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Add document' }));
    const drawer = await screen.findByRole('presentation');
    fireEvent.change(within(drawer).getByLabelText(/Document type/), { target: { value: 'GMDSS' } });
    fireEvent.click(await screen.findByRole('option', { name: 'GMDSS GOC' }));
    fireEvent.change(within(drawer).getByLabelText(/Expiry date/), { target: { value: '2029-01-31' } });
    fireEvent.click(within(drawer).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/seafarers/s1/certificates', expect.objectContaining({ certType: 'GMDSS GOC', expiryDate: '2029-01-31' })));
  });

  it('signs a seafarer off and closes the tour', async () => {
    mockGet({ '/seafarers/s1': ok(detail) });
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({ signedOff: true, seaServiceDays: 92 }) as never);
    detailAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign off' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Currently on MV Coral Reach')).toBeInTheDocument();
    expect(within(dialog).getByText('Signing off closes the tour and writes the verified sea-service record for it.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Remarks (optional)'), { target: { value: 'End of contract' } });
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Sign off' })[0]);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/seafarers/s1/sign-off', { remarks: 'End of contract' }));
  });

  it('stops a sign-on the documents block, then takes it on an officer’s override', async () => {
    const ashore: Seafarer = { ...detail, ...cadet, certificates: detail.certificates, seaService: [] };
    mockGet({ '/seafarers/s2': ok(ashore), '/vessels': ok([{ id: 'v1', name: 'MV Coral Reach', imo: '9000001' }]) });
    const gate = new ApiError('Documents block this sign-on', 422, { data: { failures: ['Medical Fitness Certificate expired on 10 May 2026'] } });
    const post = vi.spyOn(api, 'post').mockRejectedValueOnce(gate).mockResolvedValue(ok({ signedOn: true }) as never);
    detailAt('s2');
    fireEvent.click(await screen.findByRole('button', { name: 'Sign on' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(dialog).getByLabelText(/^Ship/));
    fireEvent.click(await screen.findByRole('option', { name: 'MV Coral Reach — IMO 9000001' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Check documents and sign on' }));

    expect(await within(dialog).findByText('Documents block this sign-on')).toBeInTheDocument();
    expect(within(dialog).getByText('• Medical Fitness Certificate expired on 10 May 2026')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Reason for the override'), { target: { value: 'Medical booked for tomorrow ashore' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Override and sign on' }));
    await waitFor(() => expect(post).toHaveBeenLastCalledWith('/seafarers/s2/sign-on', { vesselId: 'v1', rank: undefined, override: true, overrideReason: 'Medical booked for tomorrow ashore' }));
  });
});

describe('crew maths', () => {
  it('counts whole sea days and never goes negative', () => {
    expect(seaDays('2026-06-01', '2026-09-01')).toBe(92);
    expect(seaDays('2026-09-01', '2026-06-01')).toBe(0);
  });
  it('reads a document expiry as days left, negative once it has lapsed', () => {
    const now = new Date('2026-09-03T00:00:00Z');
    expect(daysLeft('2026-09-13T00:00:00Z', now)).toBe(10);
    expect(daysLeft('2026-05-10T00:00:00Z', now)).toBeLessThan(0);
  });
  it('orders the expiry funnel from lapsed to comfortable', () => {
    expect(funnelBands(dashboard.funnel)).toEqual([
      { band: 'Expired', count: 3 }, { band: '≤30 d', count: 5 }, { band: '31–90 d', count: 9 }, { band: 'Valid >90 d', count: 121 },
    ]);
  });
  it('accepts a service entry only when it names a ship, a rank and a tour that ends after it starts', () => {
    expect(serviceValid({ vesselName: 'MV Coral Reach', rank: 'Master', from: '2026-01-01', to: '2026-04-01' })).toBe(true);
    expect(serviceValid({ vesselName: 'MV Coral Reach', rank: 'Master', from: '2026-04-01', to: '2026-01-01' })).toBe(false);
    expect(serviceValid({ rank: 'Master', from: '2026-01-01', to: '2026-04-01' })).toBe(false);
  });
});
