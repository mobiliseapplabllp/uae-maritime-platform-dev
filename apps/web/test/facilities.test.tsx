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
import CompaniesPage from '../src/pages/facilities/CompaniesPage';
import CompanyDetail from '../src/pages/facilities/CompanyDetail';
import FacilitiesList from '../src/pages/facilities/FacilitiesList';
import FacilityDetail from '../src/pages/facilities/FacilityDetail';
import { categoryLabel, nextActions, subjectPath, verifyPath } from '../src/pages/facilities/shared';
import type { ChecksResult, Company, EndorsementsView, Licence, LicenceDetail, LicenceMeta } from '../src/pages/facilities/types';

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Accreditation Officer', email: 'facilities@maritime.example', active: true, kind: 'user', scope: { level: 'PORT' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
const wrap = (ui: React.ReactNode, path = '/') => render(<Provider store={store}><MemoryRouter initialEntries={[path]}><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

/* Every company and instrument here is fictional. Company rows follow the mdm directory contract; the
 * instrument shapes follow `toApi` / `detail` in services/instruments/src/licences.ts and the
 * checks / endorsements views on LicencesController. */
const agency: Company = {
  id: 'c1', code: 'GCA', name: 'Gulf Coast Agencies (sample)', nameAr: 'وكالات الساحل الخليجي', category: 'AGENCY', types: ['SHIPPING_AGENCY'],
  contactName: 'N. Al Hosani', contactEmail: 'ops@gulfcoast.example', contactPhone: '+971 2 000 0001', taxId: '100123456700003', registrationNo: 'CN-1180041',
  address: 'Marina Tower, Zone 3', status: 'ACTIVE', onboardedAt: '2021-04-11', rating: 4.5,
};
const supplier: Company = {
  id: 'c2', code: 'DSS', name: 'Delta Ship Supply (sample)', nameAr: null, category: 'SUPPLIER', types: [],
  contactName: 'F. Rahman', contactEmail: 'sales@deltasupply.example', contactPhone: '+971 2 000 0002', taxId: '', registrationNo: 'CN-1180988',
  address: 'Industrial Area 2', status: 'SUSPENDED', onboardedAt: '2023-02-01', rating: 0,
};
const licenceBase = {
  subjectRef: 'c1', subjectModel: 'Company', typeLabelAr: null, contactPerson: 'N. Al Hosani', phone: '+971 2 000 0001', email: 'ops@gulfcoast.example',
  address: 'Marina Tower, Zone 3', taxId: '100123456700003', conditions: 'Agency work inside port limits only', issuer: 'Ministry of Energy and Infrastructure',
  requestId: null, requestNo: null, createdAt: '2026-01-04T06:00:00Z', updatedAt: '2026-01-20T06:00:00Z', endorsements: [], signature: null,
};
const issued: Licence = {
  ...licenceBase, id: 'l1', licenseNo: 'LIC-2026-0041', subjectKind: 'COMPANY', subjectId: 'c1', instrumentClass: 'LICENCE', classLabel: 'Licence',
  entityName: 'Gulf Coast Agencies (sample)', entityType: 'SHIPPING_AGENCY', typeLabel: 'Shipping agency', status: 'ISSUED',
  issueChecks: [{ check: 'Holder is on the directory and active', passed: true, blocking: true, detail: 'Gulf Coast Agencies (sample) — active' }],
  appliedDate: '2026-01-04', issueDate: '2026-01-20', expiryDate: '2027-01-19', performanceRating: 4.5,
  audits: [{ date: '2026-06-02', auditor: 'Accreditation Officer', result: 'OBSERVATIONS', remarks: 'Two observations on record keeping' }],
  history: [
    { from: '', to: 'APPLIED', at: '2026-01-04T06:00:00Z', by: 'Gulf Coast Agencies (sample)', note: 'Application lodged' },
    { from: 'APPLIED', to: 'UNDER_REVIEW', at: '2026-01-08T06:00:00Z', by: 'Accreditation Officer' },
    { from: 'UNDER_REVIEW', to: 'ISSUED', at: '2026-01-20T06:00:00Z', by: 'Accreditation Officer', note: 'Evidence complete' },
  ],
};
const application: Licence = {
  ...licenceBase, id: 'l2', licenseNo: 'LIC-2026-0058', subjectKind: 'COMPANY', subjectId: 'c2', subjectRef: 'c2', instrumentClass: 'LICENCE', classLabel: 'Licence',
  entityName: 'Delta Ship Supply (sample)', entityType: 'SHIP_CHANDLER', typeLabel: 'Ship chandler', status: 'UNDER_REVIEW', issueChecks: [],
  appliedDate: '2026-08-11', issueDate: null, expiryDate: null, performanceRating: 0, audits: [], conditions: '',
  history: [{ from: '', to: 'APPLIED', at: '2026-08-11T06:00:00Z', by: 'Delta Ship Supply (sample)' }, { from: 'APPLIED', to: 'UNDER_REVIEW', at: '2026-08-14T06:00:00Z', by: 'Accreditation Officer' }],
};
const detailOf = (l: Licence, over: Partial<LicenceDetail> = {}): LicenceDetail => ({
  ...l, statutory: false, nonExpiring: false, convention: '', certificateName: '', inForce: l.status === 'ISSUED', forceReason: '', endorsementState: null, ...over,
});
const statutory: LicenceDetail = detailOf(
  { ...issued, id: 'l3', licenseNo: 'SOC-2026-0007', subjectKind: 'PORT_FACILITY', subjectId: 'b1', subjectRef: 'b1', subjectModel: 'Berth', instrumentClass: 'CERTIFICATE', classLabel: 'Certificate', entityName: 'Container Terminal berth CT-1', entityType: 'ISPS_SOC', typeLabel: 'Statement of Compliance (ISPS)', audits: [] },
  { statutory: true, convention: 'ISPS Code', certificateName: 'Statement of Compliance of a Port Facility', inForce: false, forceReason: 'The annual survey window closed without an endorsement' },
);
const checks: ChecksResult = {
  subjectKind: 'COMPANY', subjectId: 'c2', subjectLinked: true,
  checks: [
    { check: 'Holder is on the directory and active', passed: false, blocking: true, detail: 'Delta Ship Supply (sample) is suspended' },
    { check: 'Contact details on file', passed: true, blocking: false, detail: 'Telephone and email recorded' },
  ],
  blocking: 1, canIssue: false,
};
const endorsements: EndorsementsView = {
  statutory: true, convention: 'ISPS Code', regime: { annual: true, intermediate: false },
  schedule: [
    { kind: 'ANNUAL', anniversary: '2027-01-20', dueFrom: '2026-10-20', dueTo: '2027-04-20', completedOn: null, state: 'OVERDUE' },
    { kind: 'RENEWAL', anniversary: '2031-01-19', dueFrom: '2030-10-19', dueTo: '2031-01-19', completedOn: null, state: 'SCHEDULED' },
  ],
  next: null, overdue: 1, due: 0, refused: 0, recorded: [], inForce: false, reason: 'The annual survey window closed without an endorsement',
};
const meta: LicenceMeta = {
  subjectKinds: ['COMPANY', 'VESSEL', 'SEAFARER', 'PORT_FACILITY', 'MET_INSTITUTION'], classes: ['LICENCE', 'CERTIFICATE'],
  licenseTypes: ['SHIPPING_AGENCY', 'SHIP_CHANDLER', 'ISPS_SOC'],
  typesBySubject: { COMPANY: ['SHIPPING_AGENCY', 'SHIP_CHANDLER'], PORT_FACILITY: ['ISPS_SOC'], MET_INSTITUTION: [], VESSEL: [], SEAFARER: [] },
  statuses: ['APPLIED', 'UNDER_REVIEW', 'ISSUED', 'REJECTED', 'SUSPENDED', 'REVOKED'], transitions: {},
  endorsementKinds: ['ANNUAL', 'INTERMEDIATE', 'RENEWAL', 'ADDITIONAL'], endorsementResults: ['ENDORSED', 'ENDORSED_WITH_CONDITIONS', 'NOT_ENDORSED'],
  statutoryTypes: ['ISPS_SOC'],
  types: [
    { value: 'SHIPPING_AGENCY', label: 'Shipping agency', instrumentClass: 'LICENCE', classLabel: 'Licence', statutory: false, termMonths: 12 },
    { value: 'SHIP_CHANDLER', label: 'Ship chandler', instrumentClass: 'LICENCE', classLabel: 'Licence', statutory: false, termMonths: 12 },
    { value: 'ISPS_SOC', label: 'Statement of Compliance (ISPS)', instrumentClass: 'CERTIFICATE', classLabel: 'Certificate', statutory: true, termMonths: 60, convention: 'ISPS Code' },
  ],
};
const cards = [
  { label: 'Issued', value: 41, sub: 'active licences', tone: 'success' },
  { label: 'In pipeline', value: 6, sub: 'applied / under review', tone: 'default' },
  { label: 'Expiring ≤90 d', value: 3, sub: 'renewals due', tone: 'warning' },
  { label: 'Audits logged', value: 128, sub: 'annual safety audits', tone: 'default' },
];
const registerRoutes = { '/stats/facilities': ok({ cards }), '/licenses': ok([issued, application], { total: 2 }), '/licenses/meta': ok(meta) };
/* The company categories as Data Studio serves them: the directory's column, filter and form read this master rather than a list in the screen. */
const categoryMaster = ok([
  { id: 'k1', category: 'companyCategory', code: 'AGENCY', label: 'Shipping agency', labelAr: 'وكالة ملاحية', active: true },
  { id: 'k2', category: 'companyCategory', code: 'SUPPLIER', label: 'Supplier', labelAr: 'مورّد', active: true },
  { id: 'k3', category: 'companyCategory', code: 'RETIRED', label: 'Retired category', labelAr: null, active: false },
]);
const facilityAt = (id: string) => wrap(<Routes><Route path="/facilities/:id" element={<FacilityDetail />} /></Routes>, `/facilities/${id}`);

describe('Port companies directory', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('lists the directory with the jurisdiction tax label on the column', async () => {
    mockGet({ '/stats/facilities': ok({ cards }), '/companies': ok([agency, supplier], { total: 2 }), '/lookups': categoryMaster });
    wrap(<CompaniesPage />);
    expect(await screen.findByText('Gulf Coast Agencies (sample)')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Port companies' })).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('TRN')).toBeInTheDocument();
    expect(within(table).getByText('100123456700003')).toBeInTheDocument();
    expect(within(table).getByText('Shipping agency')).toBeInTheDocument(); // the category column, labelled from the master
    expect(within(table).getByText('Supplier')).toBeInTheDocument();
    expect(within(table).getByText('Active')).toBeInTheDocument();
    expect(within(table).getByText('Suspended')).toBeInTheDocument();
    const stats = document.querySelector('[data-stats-scope="facilities"]') as HTMLElement;
    expect(within(stats).getByText('active licences')).toBeInTheDocument();
  });

  it('filters the directory to one category', async () => {
    const get = mockGet({ '/stats/facilities': ok({ cards }), '/companies': ok([agency, supplier], { total: 2 }), '/lookups': categoryMaster });
    wrap(<CompaniesPage />);
    await screen.findByText('Gulf Coast Agencies (sample)');
    fireEvent.mouseDown(screen.getByLabelText('Category'));
    fireEvent.click(await screen.findByRole('option', { name: 'Shipping agency' }));
    // an inactive entry of the master is not offered
    expect(screen.queryByRole('option', { name: 'Retired category' })).toBeNull();
    await waitFor(() => expect(get).toHaveBeenCalledWith('/companies', { params: expect.objectContaining({ category: 'AGENCY', page: 1 }) }));
  });

  it('shows one company with the instruments this administration issued to it', async () => {
    mockGet({ '/companies/c1': ok(agency), '/instruments/subjects/COMPANY/c1': ok([detailOf(issued)]) });
    wrap(<Routes><Route path="/companies/:id" element={<CompanyDetail />} /></Routes>, '/companies/c1');
    expect(await screen.findByRole('heading', { name: /Gulf Coast Agencies \(sample\)/ })).toBeInTheDocument();
    expect(screen.getByText('GCA · Shipping Agency')).toBeInTheDocument();
    expect(screen.getByText('N. Al Hosani')).toBeInTheDocument();
    expect(screen.getByText('+971 2 000 0001 · ops@gulfcoast.example')).toBeInTheDocument();
    expect(screen.getByText('TRN / Trade licence')).toBeInTheDocument();
    expect(screen.getByText('وكالات الساحل الخليجي')).toBeInTheDocument();
    const held = await screen.findByRole('table', { name: 'Instruments held (1)' });
    const rows = within(held).getAllByRole('rowgroup')[1];
    expect(within(rows).getByText('LIC-2026-0041')).toBeInTheDocument();
    expect(within(rows).getByText('Shipping agency')).toBeInTheDocument();
    expect(within(rows).getByText('Issued')).toBeInTheDocument();
    expect(within(rows).getByText('In force')).toBeInTheDocument();
  });
});

describe('Instrument register', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('lists every instrument with its holder, class and standing', async () => {
    mockGet(registerRoutes);
    wrap(<FacilitiesList />);
    expect(await screen.findByText('LIC-2026-0041')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Instrument register' })).toBeInTheDocument();
    const body = within(screen.getByRole('table')).getAllByRole('rowgroup')[1];
    expect(within(body).getByText('Gulf Coast Agencies (sample)')).toBeInTheDocument();
    expect(within(body).getByText('Ship chandler')).toBeInTheDocument();
    expect(within(body).getAllByText('Company')).toHaveLength(2);
    expect(within(body).getByText('Issued')).toBeInTheDocument();
    expect(within(body).getByText('Under review')).toBeInTheDocument();
    expect(await screen.findByText('3 types available')).toBeInTheDocument();
  });

  it('narrows the type list to the subject kind chosen', async () => {
    const get = mockGet(registerRoutes);
    wrap(<FacilitiesList />);
    await screen.findByText('3 types available');
    fireEvent.mouseDown(screen.getByLabelText('Subject'));
    fireEvent.click(await screen.findByRole('option', { name: 'Port facility' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/licenses', { params: expect.objectContaining({ subjectKind: 'PORT_FACILITY', page: 1 }) }));
    expect(await screen.findByText('1 types available')).toBeInTheDocument();
  });

  it('lodges an application against a directory record', async () => {
    mockGet({ ...registerRoutes, '/companies': ok([agency, supplier]), '/berths': ok([{ id: 'b1', code: 'CT-1', terminal: 'Container Terminal' }]) });
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({ id: 'l9', licenseNo: 'LIC-2026-0061' }) as never);
    wrap(<FacilitiesList />);
    fireEvent.click(await screen.findByRole('button', { name: 'New application' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('An instrument is issued against a directory record, or against a name for an applicant not yet on the directory.')).toBeInTheDocument();
    fireEvent.mouseDown(within(dialog).getByLabelText(/^Instrument type/));
    fireEvent.click(await screen.findByRole('option', { name: 'Ship chandler' }));
    fireEvent.mouseDown(within(dialog).getByLabelText('Directory record'));
    fireEvent.click(await screen.findByRole('option', { name: 'DSS · Delta Ship Supply (sample)' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Submit application' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/licenses', expect.objectContaining({ subjectKind: 'COMPANY', subjectRef: 'c2', entityType: 'SHIP_CHANDLER', entityName: 'Delta Ship Supply (sample)' })));
  });
});

describe('Instrument record', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('draws an issued licence with its audits, lifecycle and printable certificate', async () => {
    mockGet({ '/licenses/l1': ok(detailOf(issued)) });
    facilityAt('l1');
    expect(await screen.findByRole('heading', { name: /Gulf Coast Agencies \(sample\)/ })).toBeInTheDocument();
    expect(screen.getByText('LIC-2026-0041 · Shipping agency · Licence · Company')).toBeInTheDocument();
    expect(screen.getAllByText('In force').length).toBeGreaterThan(0);
    expect(screen.getByText('Agency work inside port limits only')).toBeInTheDocument();
    expect(screen.getByText('Not signed')).toBeInTheDocument();

    const audits = screen.getByRole('table', { name: 'Audit history (1)' });
    expect(within(audits).getByText('Observations')).toBeInTheDocument();
    expect(within(audits).getByText('Two observations on record keeping')).toBeInTheDocument();

    const lifecycle = screen.getByRole('list', { name: 'Lifecycle' });
    expect(within(lifecycle).getByText('Evidence complete', { exact: false })).toBeInTheDocument();
    // ISSUED may only be suspended or revoked
    expect(screen.getByRole('button', { name: 'Suspend' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Revoke' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reject' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Print certificate' }));
    const cert = await screen.findByRole('dialog');
    expect(within(cert).getByText('Licence — printable certificate')).toBeInTheDocument();
    expect(within(cert).getByText('This is to certify that')).toBeInTheDocument();
    expect(within(cert).getByText('holds a valid licence issued by this administration for')).toBeInTheDocument();
    expect(within(cert).getByText('Issued by Ministry of Energy and Infrastructure')).toBeInTheDocument();
  });

  it('reads the live issue checks and refuses to issue while one is blocking', async () => {
    mockGet({ '/licenses/l2': ok(detailOf(application)), '/licenses/l2/checks': ok(checks) });
    facilityAt('l2');
    expect(await screen.findByText('Read live against the subject record')).toBeInTheDocument();
    expect(screen.getByText('Delta Ship Supply (sample) is suspended')).toBeInTheDocument();
    expect(screen.getByText('1 blocking check(s) not met')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Issue licence' }));
    const dialog = await screen.findByRole('dialog');
    // the confirm stays shut until the officer takes the override on the record
    expect(within(dialog).getByRole('button', { name: 'Confirm' })).toBeDisabled();
    fireEvent.click(within(dialog).getByLabelText('Override 1 blocking check(s), with a reason'));
    fireEvent.change(within(dialog).getByLabelText(/^Reason/), { target: { value: 'Suspension lifted by the committee on 2 September' } });
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({}) as never);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/licenses/l2/transition', expect.objectContaining({ to: 'ISSUED', override: true, note: 'Suspension lifted by the committee on 2 September' })));
  });

  it('shows a statutory certificate out of force against its survey schedule, and records an endorsement', async () => {
    mockGet({ '/licenses/l3': ok(statutory), '/licenses/l3/endorsements': ok(endorsements) });
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({}) as never);
    facilityAt('l3');
    expect(await screen.findByText('Statement of Compliance of a Port Facility · ISPS Code')).toBeInTheDocument();
    expect(screen.getAllByText('Not in force').length).toBeGreaterThan(0);
    expect(await screen.findByText('1 overdue · 0 in window · 0 refused')).toBeInTheDocument();
    const schedule = screen.getByRole('table', { name: 'Survey endorsements' });
    expect(within(schedule).getByText('ANNUAL')).toBeInTheDocument();
    expect(within(schedule).getByText('Overdue')).toBeInTheDocument();
    expect(within(schedule).getByText('Scheduled')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Record endorsement' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('An endorsement answers one survey window. A refused survey takes the certificate out of force at once.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/^Surveyor/), { target: { value: 'A. Karim, recognised organisation' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/licenses/l3/endorsements', expect.objectContaining({ kind: 'ANNUAL', result: 'ENDORSED', surveyor: 'A. Karim, recognised organisation' })));
  });
});

describe('instrument lifecycle helpers', () => {
  it('offers only the moves the declared transition table allows, named for the class', () => {
    expect(nextActions('APPLIED', 'Licence')).toEqual([
      { to: 'UNDER_REVIEW', label: 'Start review', danger: false, needsNote: false },
      { to: 'REJECTED', label: 'Reject', danger: true, needsNote: true },
    ]);
    expect(nextActions('UNDER_REVIEW', 'Certificate')[0]).toMatchObject({ to: 'ISSUED', label: 'Issue certificate', danger: false });
    expect(nextActions('SUSPENDED')[0]).toMatchObject({ to: 'ISSUED', label: 'Reinstate' });
    expect(nextActions('REVOKED')).toEqual([]);
  });
  it('points each subject kind at the register that owns it', () => {
    expect(subjectPath('COMPANY', 'c1')).toBe('/companies/c1');
    expect(subjectPath('VESSEL', 'v1')).toBe('/vessels/v1');
    expect(subjectPath('SEAFARER', 's1')).toBe('/seafarers/s1');
    expect(subjectPath('PORT_FACILITY', 'b1')).toBe('/masters/berths');
    expect(subjectPath('COMPANY', null)).toBeNull();
  });
  it('names a category and builds the public verification path', () => {
    expect(categoryLabel('TERMINAL_OPERATOR')).toBe('Terminal Operator');
    expect(categoryLabel('SOMETHING_ELSE')).toBe('Something Else');
    expect(verifyPath('LIC-2026-0041')).toBe('/verify/LIC-2026-0041');
  });
});
