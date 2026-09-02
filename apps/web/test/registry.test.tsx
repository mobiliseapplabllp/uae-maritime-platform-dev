import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { store } from '../src/store';
import { setSession } from '../src/store/authSlice';
import { buildTheme } from '../src/theme';
import api from '../src/api/client';
import RegistrationsList from '../src/pages/registry/RegistrationsList';
import RegistrationDetail from '../src/pages/registry/RegistrationDetail';
import type { Registration, RegistrationChecks, RegistrationDetailData, RegistryReference } from '../src/pages/registry/types';

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Registrar', email: 'registrar@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
const wrap = (ui: React.ReactNode, path = '/') => render(<Provider store={store}><MemoryRouter initialEntries={[path]}><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

const reference: RegistryReference = {
  registrar: 'Registrar of Ships', statute: 'the Maritime Code', nationalityRule: 'Owned by nationals or bodies established under the law of the flag',
  portsOfRegistry: [{ code: 'KHL', name: 'Khalifa Port', default: true }], defaultPort: 'KHL',
  shareRules: { denominator: 64, maxOwners: 10, confirmed: true, sources: [] }, kinds: [], provisionalValidityMonths: 6,
};
// A fictional first registration, mid-scrutiny, with one mandatory document still to come and a live mortgage.
const row: Registration = {
  id: 'r1', applicationNo: 'REG-2026-00001', kind: 'PERMANENT', vesselId: 'v1', vesselName: 'MV Coral Reach', imo: '9000001', portOfRegistry: 'KHL', portOfRegistryName: 'Khalifa Port',
  owners: [{ name: 'Coral Reach Shipping (sample)', shares: 64, kind: 'BODY_CORPORATE', cin: 'CO-1001', address: 'Marina Tower, Zone 3' }],
  tonnage: { gross: 41000, net: 22000, measuredBy: 'DNV', certificateNo: 'TM-1001' },
  evidence: [{ id: 'e1', key: 'DECLARATION_OF_OWNERSHIP', reference: 'DO-77', issuedBy: 'Notary public', verified: false, createdAt: '2026-08-01' }],
  encumbrances: [{ id: 'm1', kind: 'MORTGAGE', holder: 'Gulf Maritime Bank (sample)', amount: 2500000, registeredOn: '2026-08-02' }],
  status: 'UNDER_SCRUTINY', submittedAt: '2026-08-01', dueAt: '2026-08-31', slaBreached: true, fee: { amount: 5000, currency: 'AED', paid: false },
  history: [{ from: '', to: 'SUBMITTED', at: '2026-08-01T09:00:00Z', by: 'Shipping agent', note: 'permanent registration lodged' }, { from: 'SUBMITTED', to: 'UNDER_SCRUTINY', at: '2026-08-02T09:00:00Z', by: 'Registrar' }],
};
const detail: RegistrationDetailData = {
  ...row,
  vessel: { id: 'v1', name: 'MV Coral Reach', imo: '9000001', flag: 'Panama', grt: 41000, type: 'CONT', status: 'ACTIVE' },
  requiredEvidence: [{ key: 'DECLARATION_OF_OWNERSHIP', label: 'Declaration of ownership', mandatory: true }, { key: 'TITLE_DOCUMENT', label: "Builder's certificate or bill of sale", mandatory: true }],
  shareLedger: { denominator: 64, held: 64, balanced: true, owners: 1, maxOwners: 10, withinLimit: true },
};
const failing = { check: 'Mandatory evidence on file', passed: false, blocking: true, detail: "Not lodged: Builder's certificate or bill of sale" };
const checks: RegistrationChecks = { applicationNo: 'REG-2026-00001', kind: 'PERMANENT', checks: [{ check: 'Ship is not already on the register', passed: true, blocking: true, detail: 'No subsisting entry' }, failing], blocked: [failing] };

describe('Ship registration pages', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('lists the register with the jurisdiction registrar in the header', async () => {
    mockGet({ '/registrations/reference': ok(reference), '/stats/registry': ok({ cards: [] }), '/registrations': ok([row], { total: 1 }) });
    wrap(<RegistrationsList />);
    expect(screen.getByText('Ship Register')).toBeInTheDocument();
    expect(await screen.findByText('REG-2026-00001')).toBeInTheDocument();
    expect(await screen.findByText('Registrar of Ships — registration, amendment and closure of registry under the Maritime Code')).toBeInTheDocument();
    expect(screen.getByText('Under scrutiny')).toBeInTheDocument();
    expect(screen.getByText('Past due')).toBeInTheDocument();
    expect(screen.getByText('Khalifa Port')).toBeInTheDocument();
  });

  it('shows the file with live checks, offers the next moves and posts a refusal with its reason', async () => {
    mockGet({ '/registrations/r1': ok(detail), '/registrations/r1/checks': ok(checks) });
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({}) as never);
    wrap(<Routes><Route path="/registry/:id" element={<RegistrationDetail />} /></Routes>, '/registry/r1');
    expect(await screen.findByRole('heading', { name: 'REG-2026-00001' })).toBeInTheDocument();
    expect(screen.getByText(/1 statutory condition is not met/)).toBeInTheDocument();
    expect(screen.getByText('No subsisting entry')).toBeInTheDocument();
    expect(screen.getByText(/unpaid/)).toBeInTheDocument();
    expect(screen.getByText('Past the registry SLA')).toBeInTheDocument();
    for (const name of ['Issue the carving and marking note', 'Approve', 'Refuse', 'Open the ship']) expect(screen.getByRole('button', { name })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Evidence (1)' }));
    expect(await screen.findByText('Not lodged')).toBeInTheDocument();
    expect(screen.getByText('Awaiting check')).toBeInTheDocument();
    expect(screen.getByText(/Not yet lodged: Builder's certificate or bill of sale/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Charges (1)' }));
    expect(await screen.findByText('Subsisting')).toBeInTheDocument();
    expect(screen.getByText('Gulf Maritime Bank (sample)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Refuse' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Refuse');
    const confirm = screen.getByRole('button', { name: 'Confirm' });
    expect(confirm).toBeDisabled();
    fireEvent.change(screen.getByLabelText('Reason (required)'), { target: { value: 'Ownership not proven' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/registrations/r1/transition', { to: 'REJECTED', note: 'Ownership not proven', override: false }));
  });
});
