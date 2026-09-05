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
import MetRegister from '../src/pages/seafarers/MetRegister';
import MetInstitutionDetail from '../src/pages/seafarers/MetInstitutionDetail';
import CrewLists from '../src/pages/seafarers/CrewLists';
import CrewListDetail from '../src/pages/seafarers/CrewListDetail';
import ManningScales from '../src/pages/seafarers/ManningScales';
import ForeignLedger from '../src/pages/seafarers/ForeignLedger';
import type { CrewList, CrewListDashboard, ForeignSeafarer, Institution, ManningScale, MetDashboard } from '../src/pages/seafarers/metTypes';

/* The phase-3 crew screens: the MET register, the FAL-5 crew lists, safe manning and the foreign ledger.
 * Every institution, list, ship and person here is fictional; the shapes follow the seafarers service's API. */
class RO { observe() { /* noop */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || RO;

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Crew Desk Officer', email: 'crew@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const lookups: Record<string, unknown[]> = {
  metInstitutionType: [{ id: '1', category: 'metInstitutionType', code: 'ACADEMY', label: 'Maritime academy', labelAr: 'أكاديمية بحرية', active: true }, { id: '2', category: 'metInstitutionType', code: 'TRAINING_CENTRE', label: 'Training centre', active: true }],
  metProgramme: [{ id: '3', category: 'metProgramme', code: 'BST', label: 'Basic Safety Training', active: true, meta: { regulation: 'VI/1' } }, { id: '4', category: 'metProgramme', code: 'ECDIS', label: 'ECDIS generic', active: true, meta: { regulation: 'II/1', simulator: true } }],
  seafarerRank: [{ id: '5', category: 'seafarerRank', code: 'MASTER', label: 'Master', active: true, meta: { officer: true, cocGrade: 'MASTER', order: 1 } }, { id: '6', category: 'seafarerRank', code: 'AB', label: 'Able Seaman', active: true, meta: { order: 11 } }, { id: '7', category: 'seafarerRank', code: 'CHIEF_OFFICER', label: 'Chief Officer', active: true, meta: { officer: true, cocGrade: 'CHIEF_MATE', order: 2 } }],
  crewListSource: [{ id: '8', category: 'crewListSource', code: 'MSW', label: 'Maritime Single Window', active: true }, { id: '9', category: 'crewListSource', code: 'AGENT_PORTAL', label: 'Agent portal', active: true }],
  cocGrade: [{ id: '10', category: 'cocGrade', code: 'MASTER', label: 'Master', active: true }, { id: '11', category: 'cocGrade', code: 'CHIEF_MATE', label: 'Chief Mate', active: true }],
  tradingArea: [{ id: '12', category: 'tradingArea', code: 'UNLIMITED', label: 'Unlimited', active: true }, { id: '13', category: 'tradingArea', code: 'GULF', label: 'Gulf and Gulf of Oman', active: true }],
};
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string, cfg?: { params?: { category?: string } }) => {
  if (url === '/lookups') return Promise.resolve(ok(lookups[cfg?.params?.category ?? ''] ?? []));
  return url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`));
}) as never);
const wrap = (ui: React.ReactNode, path = '/') => render(<Provider store={store}><MemoryRouter initialEntries={[path]}><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);
const cards = [{ label: 'Institutions', value: 2, sub: 'on the MET register', tone: 'default' }];

const academy: Institution = {
  id: 'i1', companyId: 'c1', code: 'AMI', name: 'Arabian Maritime Institute', nameAr: 'المعهد البحري العربي', institutionType: 'ACADEMY', city: 'Abu Dhabi', address: 'Corniche Road', contactName: 'Layla Haddad', contactEmail: 'ops@ami.example', contactPhone: '+971 2 000 0000',
  status: 'ACTIVE', statusReason: '', accreditation: { status: 'CURRENT', reason: 'Cycle renewed', instrumentId: 'x', instrumentNo: 'MET-2026-0008', cycleId: 'cy', cycleNo: 4, from: '2026-09-01', until: '2027-09-01', daysLeft: 360 },
  accredited: true, instructors: 24, capacity: 320, simulators: ['Full-mission bridge', 'GMDSS'], qualitySystem: 'ISO 9001:2015', establishedOn: '2009-04-12', remarks: '',
  programmes: [
    { id: 'p1', institutionId: 'i1', programme: 'BST', title: 'Basic Safety Training', regulation: 'VI/1', seatsPerIntake: 20, intakesPerYear: 10, seatsPerYear: 200, status: 'APPROVED', statusReason: '', approvalNo: 'PA-2024-0003', instrumentId: null, approvedOn: '2024-03-01', expiresOn: '2029-03-01', expired: false, remarks: '' },
    { id: 'p2', institutionId: 'i1', programme: 'ECDIS', title: 'ECDIS generic', regulation: 'II/1', seatsPerIntake: 12, intakesPerYear: 6, seatsPerYear: 72, status: 'PENDING', statusReason: 'Application under review', approvalNo: '', instrumentId: null, approvedOn: null, expiresOn: null, expired: false, remarks: '' },
  ],
  programmeCount: 2, approvedProgrammes: 1, pendingProgrammes: 1, suspendedProgrammes: 0, seatsPerYear: 200, createdAt: '2026-01-01', updatedAt: '2026-09-01',
};
const centre: Institution = { ...academy, id: 'i2', companyId: 'c2', code: 'KRM', name: 'Khaleej Recruitment & Manning FZE', nameAr: '', institutionType: 'TRAINING_CENTRE', city: 'Dubai', status: 'ACTIVE', accreditation: { ...academy.accreditation, status: 'NONE', instrumentNo: '', until: null, daysLeft: null, reason: 'No accreditation instrument held' }, accredited: false, programmes: [], programmeCount: 0, approvedProgrammes: 0, seatsPerYear: 0, simulators: [] };
const metDash: MetDashboard = { kpis: { institutions: 2, accredited: 1, due: 0, expired: 0, suspended: 0, unaccredited: 1, programmes: 2, approved: 1, pending: 1, suspendedProgrammes: 0, seatsPerYear: 200, instructors: 30, simulatorCentres: 1, programmesOffered: 1, programmesInMaster: 2 },
  byType: [], byProgramme: [{ programme: 'BST', title: 'Basic Safety Training', titleAr: null, regulation: 'VI/1', simulator: false, providers: 1, seatsPerYear: 200 }], attention: [{ id: 'i2', code: 'KRM', name: 'Khaleej Recruitment & Manning FZE', accreditationStatus: 'NONE', daysLeft: null, suspendedProgrammes: 0, pendingProgrammes: 0, reason: 'No accreditation in force' }], generatedAt: '2026-09-05T00:00:00Z' };

const list: CrewList = {
  id: 'l1', number: 'CL-2026-0042', vcn: 'MAR-2026-0410', portCallId: 'pc1', vesselId: 'v1', vesselName: 'Saadiyat Breeze', imo: '9000001', port: 'MAR', movement: 'ARRIVAL', date: '2026-09-04T06:00:00Z', source: 'MSW', sourceLabel: 'Maritime Single Window',
  agentCode: 'GSS', agentName: 'Gulf Star Shipping Agency LLC', submittedBy: 'gss.ops@agent.example', declaredCrew: 3, rowCount: 2, matched: 1, foreignCount: 1, flagged: 1, status: 'CHECKED',
  checks: { manning: { rows: [{ rankCode: 'MASTER', rank: 'Master', required: 1, listed: 1, shortfall: 0 }, { rankCode: 'AB', rank: 'Able Seaman', required: 2, listed: 1, shortfall: 1 }], required: 3, listed: 2, shortfalls: 1, ok: false, unscheduled: [] }, scaleRecorded: true, msmdNo: 'MSMD-2026-0007',
    documents: [], identity: [], endorsements: [], unregisteredNationals: [], unknownRanks: [], declaration: { declared: 3, listed: 2, matches: false }, nationalFlag: true, summary: ['Short of the safe manning scale by 1: Able Seaman 1/2', 'General declaration gives 3 crew, the list has 2'], ok: false, checkedAt: '2026-09-04T08:00:00Z' },
  ok: false, checkedAt: '2026-09-04T08:00:00Z', checkedBy: 'Crew desk', decidedAt: null, decidedBy: '', decisionNote: '', remarks: '',
  rows: [
    { id: 'r1', seq: 1, familyName: 'Haddad', givenNames: 'Rami', name: 'Rami Haddad', rank: 'Master', rankCode: 'MASTER', nationality: 'United Arab Emirates', dob: '1978-01-02', pob: 'Abu Dhabi', gender: 'M', idType: 'SID', idNumber: 'SID-784-100', idExpiry: '2029-01-01', cdcNo: 'AUH-52000', match: 'REGISTER', seafarerId: 's1', foreignId: null, issues: [] },
    { id: 'r2', seq: 2, familyName: 'Santos', givenNames: 'Ramon', name: 'Ramon Santos', rank: 'Able Seaman', rankCode: 'AB', nationality: 'Philippines', dob: '1990-05-05', pob: 'Cebu', gender: 'M', idType: 'Passport', idNumber: 'PH7000001', idExpiry: '2027-01-01', cdcNo: '', match: 'FOREIGN', seafarerId: null, foreignId: 'f1', issues: [] },
  ], createdAt: '2026-09-04T06:00:00Z', updatedAt: '2026-09-04T08:00:00Z',
};
const clDash: CrewListDashboard = { kpis: { lists: 1, last30Days: 1, received: 0, checked: 1, cleared: 0, queried: 0, passing: 0, shortOfManning: 1, unregisteredNationals: 0, linesRead: 2, registerMatched: 1, foreignLines: 1, ledger: 1, ledgerWatch: 0, ledgerReconciled: 0, repeatAppearances: 0 },
  bySource: [{ source: 'MSW', label: 'Maritime Single Window', lists: 1 }], attention: [{ id: 'l1', number: 'CL-2026-0042', vesselName: 'Saadiyat Breeze', vcn: 'MAR-2026-0410', date: '2026-09-04T06:00:00Z', status: 'CHECKED', summary: ['Short of the safe manning scale by 1'] }], generatedAt: '2026-09-05T00:00:00Z' };
const scale: ManningScale = { id: 'm1', vesselId: 'v1', vesselName: 'Saadiyat Breeze', imo: '9000001', msmdNo: 'MSMD-2026-0007', instrumentId: 'x', issuedOn: '2025-01-01', expiresOn: null, tradingArea: 'UNLIMITED', tradingAreaLabel: 'Unlimited',
  rows: [{ rankCode: 'MASTER', rank: 'Master', count: 1, cocGrade: 'MASTER', cocGradeLabel: 'Master', notes: '' }, { rankCode: 'AB', rank: 'Able Seaman', count: 2, cocGrade: '', cocGradeLabel: '', notes: '' }], total: 3, officers: 1, recorded: true, documented: true, remarks: '', recordedBy: 'Registry',
  compliance: { rows: [{ rankCode: 'MASTER', rank: 'Master', required: 1, listed: 1, shortfall: 0 }, { rankCode: 'AB', rank: 'Able Seaman', required: 2, listed: 0, shortfall: 2 }], required: 3, listed: 1, shortfalls: 2, ok: false, unscheduled: [] }, createdAt: '2026-01-01', updatedAt: '2026-01-01' };
const foreign: ForeignSeafarer = { id: 'f1', idType: 'Passport', idNumber: 'PH7000001', familyName: 'Santos', givenNames: 'Ramon', name: 'Ramon Santos', nationality: 'Philippines', dob: '1990-05-05', idExpiry: '2027-01-01', idExpired: false, cdcNo: '', lastRank: 'Able Seaman', lastRankCode: 'AB',
  firstSeenAt: '2026-06-01', lastSeenAt: '2026-09-04', appearances: 2, vessels: [], distinctVessels: 1, status: 'LEDGER', statusReason: 'First seen on a crew list', reconciledSeafarerId: null, reconciledAt: null, reconciledBy: '', endorsement: null, remarks: '', createdAt: '2026-06-01', updatedAt: '2026-09-04',
  appearanceList: [{ crewListId: 'l1', number: 'CL-2026-0042', vcn: 'MAR-2026-0410', vesselName: 'Saadiyat Breeze', date: '2026-09-04T06:00:00Z', rank: 'Able Seaman', issues: [], listStatus: 'CHECKED' }] };

describe('MET register', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });
  it('lists the providers with their accreditation, programmes and the sector picture from the masters', async () => {
    mockGet({ '/stats/met': ok({ cards }), '/seafarers/met/dashboard': ok(metDash), '/seafarers/met/institutions': ok([academy, centre], { total: 2 }) });
    wrap(<MetRegister />);
    expect(await screen.findByText('Arabian Maritime Institute')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'MET Institutions' })).toBeInTheDocument();
    const table = screen.getAllByRole('table').at(-1) as HTMLElement;
    expect(within(table).getByText('Maritime academy')).toBeInTheDocument();
    expect(within(table).getByText('Training centre')).toBeInTheDocument();
    expect(within(table).getByText('Accredited')).toBeInTheDocument();
    expect(within(table).getByText('Not accredited')).toBeInTheDocument();
    expect(within(table).getByText('1/2')).toBeInTheDocument();
    expect(screen.getByText('No accreditation in force')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register institution' })).toBeInTheDocument();
  });
  it('opens one provider with its programmes and the master\'s labels', async () => {
    mockGet({ '/seafarers/met/institutions/i1': ok(academy), '/seafarers/met/reference': ok({ institutionTypes: [], programmes: [], schemes: ['MET_INSTITUTION'], institutionStatuses: ['ACTIVE', 'SUSPENDED', 'CLOSED'], accreditationStatuses: [], programmeStatuses: [] }) });
    wrap(<Routes><Route path="/seafarers/met/:id" element={<MetInstitutionDetail />} /></Routes>, '/seafarers/met/i1');
    expect(await screen.findByText('AMI · Maritime academy · Abu Dhabi · المعهد البحري العربي')).toBeInTheDocument();
    expect(screen.getByText('MET-2026-0008')).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Programmes' });
    expect(within(table).getByText('Basic Safety Training')).toBeInTheDocument();
    expect(within(table).getByText('PA-2024-0003')).toBeInTheDocument();
    expect(within(table).getByText('Pending')).toBeInTheDocument();
    expect(within(table).getByText('Application under review')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add programme' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Profile' }));
    expect(await screen.findByText('ISO 9001:2015')).toBeInTheDocument();
    expect(screen.getByText('Full-mission bridge')).toBeInTheDocument();
  });
});

describe('Crew lists', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });
  it('shows the desk: the lists waiting on a decision and what each check found', async () => {
    mockGet({ '/stats/crewLists': ok({ cards }), '/seafarers/crew-lists/dashboard': ok(clDash), '/seafarers/crew-lists': ok([list], { total: 1 }) });
    wrap(<CrewLists />);
    expect(await screen.findByRole('heading', { name: 'Crew Lists (FAL 5)' })).toBeInTheDocument();
    expect((await screen.findAllByText('CL-2026-0042')).length).toBeGreaterThan(0);
    const table = screen.getAllByRole('table').at(-1) as HTMLElement;
    expect(within(table).getByText('Maritime Single Window')).toBeInTheDocument();
    expect(within(table).getByText('2 finding(s)')).toBeInTheDocument();
    expect(within(table).getByText('Checked')).toBeInTheDocument();
    expect(screen.getByText('Short of the safe manning scale by 1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Receive crew list' }));
    expect(await screen.findByLabelText(/Port call \(VCN\)/)).toBeInTheDocument();
    expect(screen.getByTestId('crew-line-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add person' }));
    expect(screen.getByTestId('crew-line-2')).toBeInTheDocument();
  });
  it('reads one list against the scale, the declaration and the register, and takes a decision', async () => {
    mockGet({ '/seafarers/crew-lists/l1': ok(list) });
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({ ...list, status: 'CLEARED', decidedBy: 'Crew Desk Officer', decidedAt: '2026-09-05T00:00:00Z', decisionNote: 'Ratings to be presented at the next call' }) as never);
    wrap(<Routes><Route path="/seafarers/crew-lists/:id" element={<CrewListDetail />} /></Routes>, '/seafarers/crew-lists/l1');
    expect(await screen.findByText('Short of the safe manning scale by 1: Able Seaman 1/2')).toBeInTheDocument();
    const manning = screen.getByRole('table', { name: 'Safe manning' });
    expect(within(manning).getByText('Able Seaman')).toBeInTheDocument();
    expect(within(manning).getAllByText('1').length).toBeGreaterThan(0);
    expect(screen.getByText('declares 3 · list has 2')).toBeInTheDocument();
    const lines = screen.getByRole('table', { name: 'Lines' });
    expect(within(lines).getByText('Rami Haddad')).toBeInTheDocument();
    expect(within(lines).getByText('Register')).toBeInTheDocument();
    expect(within(lines).getByText('Foreign ledger')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear' }));
    fireEvent.change(await screen.findByLabelText(/Note/), { target: { value: 'Ratings to be presented at the next call' } });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/seafarers/crew-lists/l1/clear', { note: 'Ratings to be presented at the next call' }));
    expect(await screen.findByText('Cleared')).toBeInTheDocument();
  });
});

describe('Safe manning and the foreign ledger', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });
  it('lists every scale against who is aboard and opens the editor on the masters', async () => {
    mockGet({ '/seafarers/manning': ok([scale], { total: 1 }) });
    wrap(<ManningScales />);
    expect(await screen.findByText('Saadiyat Breeze')).toBeInTheDocument();
    expect(screen.getByText('MSMD-2026-0007')).toBeInTheDocument();
    expect(screen.getByText('Unlimited')).toBeInTheDocument();
    expect(screen.getByText('Short by 2')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Saadiyat Breeze'));
    expect(await screen.findByText('Record scale')).toBeInTheDocument();
    expect(screen.getByTestId('scale-row-2')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add capacity' }));
    expect(screen.getByTestId('scale-row-3')).toBeInTheDocument();
  });
  it('shows the ledger with appearances, and records an endorsement', async () => {
    mockGet({ '/seafarers/foreign': ok([foreign], { total: 1 }), '/seafarers/foreign/f1': ok(foreign) });
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({ ...foreign, endorsement: { number: 'FSE-2026-0100', issuer: 'Ministry', expiryDate: '2028-01-01', valid: true } }) as never);
    wrap(<ForeignLedger />);
    expect(await screen.findByText('Ramon Santos')).toBeInTheDocument();
    expect(screen.getByText('Philippines')).toBeInTheDocument();
    expect(screen.getByText('None recorded')).toBeInTheDocument();
    fireEvent.click(screen.getByText('Ramon Santos'));
    expect(await screen.findByRole('table', { name: 'Crew-list appearances' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Record endorsement' }));
    fireEvent.change(await screen.findByLabelText(/Endorsement no/), { target: { value: 'FSE-2026-0100' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/seafarers/foreign/f1/endorsement', expect.objectContaining({ number: 'FSE-2026-0100' })));
    expect(await screen.findByText(/FSE-2026-0100/)).toBeInTheDocument();
  });
});
