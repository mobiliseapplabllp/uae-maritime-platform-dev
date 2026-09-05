import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { store } from '../src/store';
import { setSession } from '../src/store/authSlice';
import { buildTheme } from '../src/theme';
import api from '../src/api/client';
import VesselsList from '../src/pages/vessels/VesselsList';
import VesselDetail from '../src/pages/vessels/VesselDetail';
import type { Vessel, VesselDetailData } from '../src/pages/vessels/types';
import type { MasterRecord, Registration, Transcript } from '../src/pages/registry/types';

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Harbour Master', email: 'hm@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
const wrap = (ui: React.ReactNode, path = '/') => render(<Provider store={store}><MemoryRouter initialEntries={[path]}><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

// Fictional ship — no real caller, no real registry number.
const vessel: Vessel = {
  id: 'v1', name: 'MV Coral Reach', imo: '9000001', callSign: 'A6CR', flag: 'Panama', type: 'CONT', built: 2014, dwt: 52000, grt: 41000, loa: 260, beam: 32.2, maxDraft: 12.5,
  owner: 'Coral Reach Shipping (sample)', agent: 'AG-01', classSociety: 'DNV', status: 'ACTIVE',
  certificates: [{ id: 'c1', certType: 'Load Line Certificate', number: 'LL-2026-0001', issuer: 'DNV', issueDate: '2025-01-10', expiryDate: '2030-01-09', status: 'VALID' }],
};
const detail: VesselDetailData = {
  ...vessel,
  recentCalls: [{ id: 'pc1', vcn: 'VCN-2026-0001', status: 'BERTHED', eta: '2026-09-01T06:00:00Z', berthCode: 'CT-1', terminal: 'Container Terminal' }],
  recentInspections: [], recentIncidents: [], crewOnBoard: [], lastPosition: null,
};
const transcript: Transcript = {
  vessel: { id: 'v1', name: 'MV Coral Reach', imo: '9000001', flag: 'Panama', type: 'CONT', grt: 41000 },
  registry: { state: 'REGISTERED', officialNumber: '500123', portOfRegistry: 'KHL', certificateNo: 'KHL/CR/2026/0001', registeredOn: '2026-03-01' },
  registrar: 'Registrar of Ships', portOfRegistry: { code: 'KHL', name: 'Khalifa Port' }, firstRegistered: '2026-03-01', tonnage: { gross: 41000, net: 22000 },
  owners: [{ name: 'Coral Reach Shipping (sample)', shares: 64, kind: 'BODY_CORPORATE', cin: 'CO-1001' }],
  shareLedger: { denominator: 64, held: 64, balanced: true, owners: 1, maxOwners: 10, withinLimit: true }, encumbrances: [], closure: null, entries: [],
};
const registrations: Registration[] = [{
  id: 'r1', applicationNo: 'REG-2026-00001', kind: 'PERMANENT', vesselId: 'v1', vesselName: 'MV Coral Reach', imo: '9000001', portOfRegistry: 'KHL',
  owners: [], evidence: [], encumbrances: [], status: 'GRANTED', certificateNo: 'KHL/CR/2026/0001', grantedOn: '2026-03-01', history: [], slaBreached: false,
}];

describe('Fleet Manager pages', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('lists the vessel register from /vessels', async () => {
    mockGet({ '/stats/vessels': ok({ cards: [] }), '/lookups': ok([{ id: 'l1', category: 'vesselType', code: 'CONT', label: 'Container', active: true }]), '/vessels': ok([vessel], { total: 1 }) });
    wrap(<VesselsList />);
    expect(screen.getByText('Vessel registry')).toBeInTheDocument();
    expect(await screen.findByText('MV Coral Reach')).toBeInTheDocument();
    expect(screen.getByText('9000001')).toBeInTheDocument();
    expect(screen.getByText('1 records')).toBeInTheDocument();
  });

  it('renders the vessel record with its tabs and the registry transcript', async () => {
    const record: MasterRecord = {
      vessel: { id: 'v1', name: 'MV Coral Reach', imo: '9000001', flag: 'United Arab Emirates', type: 'CONT', grt: 41000, owner: 'Coral Reach Shipping (sample)', operator: 'Coral Reach Shipping (sample)', manager: 'Harbour Ship Management LLC (sample)', status: 'ACTIVE' },
      registry: transcript.registry, portOfRegistry: transcript.portOfRegistry, registrar: transcript.registrar, onRegister: true, firstRegistered: transcript.firstRegistered,
      currentEntry: { applicationNo: 'REG-2026-00001', kind: 'PERMANENT', certificateNo: 'KHL/CR/2026/0001', grantedOn: '2026-03-01', expiresOn: null, particulars: {} },
      owners: transcript.owners, shareLedger: transcript.shareLedger, tonnage: transcript.tonnage, encumbrances: [], dischargedEncumbrances: [], caveats: [], titleBlocked: false, closure: null,
      applications: registrations, certificates: [{ certificateNo: 'KHL/CR/2026/0001', kind: 'PERMANENT', series: 'CR', grantedOn: '2026-03-01', expiresOn: null, applicationNo: 'REG-2026-00001' }],
      transactions: [{ id: 't1', number: 'RTX-2026-00001', vesselId: 'v1', vesselName: 'MV Coral Reach', officialNumber: '500123', type: 'REGISTRATION', registrationId: 'r1', applicationNo: 'REG-2026-00001', particulars: { certificateNo: 'KHL/CR/2026/0001', officialNumber: '500123' }, status: 'RECORDED', recordedOn: '2026-03-01T09:00:00Z', recordedBy: 'Registrar', notes: '', digest: null }],
      transcripts: [], generatedAt: '2026-09-05T08:00:00Z',
    };
    mockGet({ '/vessels/v1': ok(detail), '/vessels/v1/registry': ok(record) });
    wrap(<Routes><Route path="/vessels/:id" element={<VesselDetail />} /></Routes>, '/vessels/v1');
    // the name is both the last breadcrumb and the h1, so target the heading
    expect(await screen.findByRole('heading', { name: /MV Coral Reach/ })).toBeInTheDocument();
    expect(screen.getByText(/IMO 9000001/)).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Certificates (1)' })).toBeInTheDocument();
    expect(screen.getByText('Load Line Certificate')).toBeInTheDocument();
    expect(screen.getByText('Valid')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Registry' }));
    expect(await screen.findByText('Registered')).toBeInTheDocument();
    expect(screen.getByText('500123')).toBeInTheDocument();
    expect(screen.getAllByText('REG-2026-00001').length).toBeGreaterThan(0);
    expect(screen.getByText('RTX-2026-00001')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Registry ledger' })).toBeInTheDocument();
  });
});
