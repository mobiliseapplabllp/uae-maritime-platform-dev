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
import AccreditationDesk from '../src/pages/facilities/AccreditationDesk';
import { categoryLabel, nextActions, subjectPath, verifyPath } from '../src/pages/facilities/shared';
import type { AccreditationCycle, AccreditationDashboard, ChecksResult, Company, CompanyOverlay, EndorsementsView, Licence, LicenceDetail, LicenceMeta, Scheme, Visit } from '../src/pages/facilities/types';

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

/* The administration's overlay on a company: the accreditation cycles it holds, the visits paid, the audits and the obligations. Fictional. */
const schemes: Scheme[] = [
  { category: 'PEST_CONTROL', label: 'Pest control and deratting', labelAr: 'مكافحة الآفات وإبادة القوارض', instrumentType: 'PEST_CONTROL', cycleMonths: 12, visitsPerCycle: 1, reminderDays: [90, 30, 7], ratingWeight: 0.8 },
  { category: 'LSA_SERVICING', label: 'Life-saving appliance servicing', labelAr: 'صيانة معدات إنقاذ الأرواح', instrumentType: 'LSA_SERVICING', cycleMonths: 12, visitsPerCycle: 1, reminderDays: [90, 30, 7], ratingWeight: 1.2 },
];
const cycle = (over: Partial<AccreditationCycle>): AccreditationCycle => ({
  id: 'cy1', companyId: 'c1', companyName: 'Gulf Coast Agencies (sample)', category: 'PEST_CONTROL', instrumentId: 'i9', instrumentNo: 'ACC-PST-2026-0004', cycleNo: 2, startsOn: '2026-03-01', endsOn: '2027-03-01',
  status: 'CURRENT', storedStatus: 'CURRENT', statusReason: 'Accreditation renewed', daysLeft: 177, visitsRequired: 1, visitsDone: 0, visitsOutstanding: 1, lastVisitAt: null, lastVisitResult: null, nextVisitDue: '2026-12-01', visitOverdue: false, rating: 4.2, reminders: [], grantedBy: 'Registry', ...over,
});
const visit = (over: Partial<Visit>): Visit => ({
  id: 'v1', number: 'VIS-2026-0012', subjectKind: 'COMPANY', subjectId: 'c1', subjectName: 'Gulf Coast Agencies (sample)', category: 'PEST_CONTROL', cycleId: 'cy1', visitType: 'ANNUAL', status: 'SCHEDULED', scheduledOn: '2026-10-05', visitedOn: null,
  inspector: 'S. Al Marzouqi', result: null, score: null, findings: [], remarks: '', cancelReason: '', overdue: false, createdBy: 'Accreditation Officer', ...over,
});
const overlay: CompanyOverlay = {
  ...agency, statusReason: '', statusChangedAt: null, statusChangedBy: '', auditCount: 1, lastAuditAt: '2026-06-02', lastAuditResult: 'OBSERVATIONS', nonConformities: 0,
  audits: [{ id: 'a1', number: 'AUD-2026-0007', subjectKind: 'COMPANY', subjectId: 'c1', date: '2026-06-02', auditor: 'Accreditation Officer', result: 'OBSERVATIONS', scope: 'Periodic compliance audit', remarks: 'Two observations on record keeping', instrumentNo: 'LIC-2026-0041' }],
  obligations: [{ id: 'o1', kind: 'VISIT_FINDING', title: 'PC-01 — Fumigation log not kept', detail: 'MAJOR: raised on visit VIS-2026-0009', sourceRef: 'VIS-2026-0009:1', dueAt: '2026-08-01', status: 'OPEN', raisedAt: '2026-07-01', raisedBy: 'Accreditation Officer', clearedAt: null, clearedBy: '', clearanceNote: '', overdue: true }],
  openObligations: 1, overdueObligations: 1, history: [{ from: '', to: 'ACTIVE', reason: 'Recorded on the directory', at: '2021-04-11', by: 'Registry' }],
  accreditations: [cycle({}), cycle({ id: 'cy2', category: 'LSA_SERVICING', status: 'DUE', storedStatus: 'DUE', daysLeft: 21, endsOn: '2026-09-26', visitsDone: 1, visitsOutstanding: 0, nextVisitDue: null, lastVisitAt: '2026-06-20', lastVisitResult: 'SATISFACTORY', instrumentNo: 'ACC-LSA-2025-0011' })],
  accreditedFor: ['PEST_CONTROL', 'LSA_SERVICING'], accreditationsDue: 1, accreditationsExpired: 0,
  visits: [visit({}), visit({ id: 'v0', number: 'VIS-2026-0009', status: 'COMPLETED', scheduledOn: '2026-07-01', visitedOn: '2026-07-01', result: 'NON_CONFORMITY', score: 55, findings: [{ code: 'PC-01', title: 'Fumigation log not kept', severity: 'MAJOR', dueDays: 30 }], remarks: 'Fumigation logs missing' })],
  visitsScheduled: 1, lastVisitAt: '2026-07-01',
};
const visitTypes = ok([{ id: 'vt1', category: 'visitType', code: 'ANNUAL', label: 'Annual accreditation visit', labelAr: 'زيارة الاعتماد السنوية', active: true }, { id: 'vt2', category: 'visitType', code: 'SPOT_CHECK', label: 'Unannounced spot check', labelAr: 'تفتيش مفاجئ', active: true }]);
const dashboard: AccreditationDashboard = {
  kpis: { schemes: 6, accredited: 7, companies: 5, due: 2, expired: 1, suspended: 1, renewalsNext30: 1, renewalsNext90: 3, visitsScheduled: 4, visitsOverdue: 1, visitsCompleted90: 6, nonConformities90: 1 },
  bySchemes: [{ category: 'PEST_CONTROL', label: 'Pest control and deratting', labelAr: null, cycleMonths: 12, companies: 2, current: 1, due: 1, expired: 0, suspended: 0, withdrawn: 0, visitsOverdue: 1, averageRating: 3.9 }],
  byStatus: [{ status: 'CURRENT', total: 4 }, { status: 'DUE', total: 2 }], renewals: [cycle({ id: 'cy2', status: 'DUE', daysLeft: 21 })], visitsDue: [visit({ overdue: true, scheduledOn: '2026-08-20' })], generatedAt: '2026-09-05T08:00:00Z',
};

describe('Annual accreditation and inspection visits', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows a company\'s accreditation position, read against the calendar, with the visits it calls for', async () => {
    mockGet({ '/companies/c1': ok(agency), '/instruments/subjects/COMPANY/c1': ok([detailOf(issued)]), '/facilities/companies/c1': ok(overlay), '/facilities/accreditations/schemes': ok(schemes), '/facilities/companies/c1/accreditations': ok({ position: overlay.accreditations, history: overlay.accreditations }), '/lookups': visitTypes });
    wrap(<Routes><Route path="/companies/:id" element={<CompanyDetail />} /></Routes>, '/companies/c1?tab=accreditation');
    await screen.findByRole('heading', { name: /Gulf Coast Agencies \(sample\)/ });
    const pest = await screen.findByTestId('cycle-PEST_CONTROL');
    expect(within(pest).getByText('Pest control and deratting')).toBeInTheDocument();
    expect(within(pest).getByText('Current')).toBeInTheDocument();
    expect(within(pest).getByText('Cycle 2 · ACC-PST-2026-0004')).toBeInTheDocument();
    expect(within(pest).getByText('177 days left')).toBeInTheDocument();
    expect(within(pest).getByText('Visits 0 of 1')).toBeInTheDocument();
    const lsa = screen.getByTestId('cycle-LSA_SERVICING');
    expect(within(lsa).getByText('Renewal due')).toBeInTheDocument();
    expect(within(lsa).getByText('21 days left')).toBeInTheDocument();
    // an approver can record a grant by hand; the scheme list is the master's
    expect(screen.getByRole('button', { name: 'Record accreditation' })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Cycle history' })).toBeInTheDocument();
  });

  it('lists the visits paid, and offers to record a visit now or schedule one', async () => {
    mockGet({ '/companies/c1': ok(agency), '/instruments/subjects/COMPANY/c1': ok([]), '/facilities/companies/c1': ok(overlay), '/facilities/accreditations/schemes': ok(schemes), '/lookups': visitTypes });
    wrap(<Routes><Route path="/companies/:id" element={<CompanyDetail />} /></Routes>, '/companies/c1?tab=visits');
    const table = await screen.findByRole('table', { name: 'Visits' });
    expect(within(table).getByText('VIS-2026-0012')).toBeInTheDocument();
    expect(within(table).getByText('VIS-2026-0009')).toBeInTheDocument();
    expect(within(table).getByText('Non-conformity')).toBeInTheDocument();
    expect(within(table).getByText('55')).toBeInTheDocument();
    expect(within(table).getByText('Major')).toBeInTheDocument();
    await waitFor(() => expect(within(table).getAllByText('Annual accreditation visit').length).toBeGreaterThan(0));
    expect(within(table).getByRole('button', { name: 'Record outcome VIS-2026-0012' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Record a visit now' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.getByLabelText('Record the outcome now')).toBeChecked();
    expect(screen.getByText('Findings (0)')).toBeInTheDocument();
  });

  it('shows what the company owes and how its rating is earned', async () => {
    mockGet({ '/companies/c1': ok(agency), '/instruments/subjects/COMPANY/c1': ok([]), '/facilities/companies/c1': ok(overlay), '/facilities/accreditations/schemes': ok(schemes), '/lookups': ok([{ id: 'ok1', category: 'obligationKind', code: 'VISIT_FINDING', label: 'Inspection visit finding', active: true }]),
      '/facilities/companies/c1/rating': ok({ rating: 3.4, recorded: 3.4, considered: 2, method: 'Recency-weighted mean.', entries: [{ source: 'VISIT', number: 'VIS-2026-0009', date: '2026-07-01', result: 'NON_CONFORMITY', score: 55, value: 2.75, recency: 0.9, typeWeight: 1, weight: 0.9 }, { source: 'AUDIT', number: 'AUD-2026-0007', date: '2026-06-02', result: 'OBSERVATIONS', score: null, value: 3.5, recency: 0.88, typeWeight: 1, weight: 0.88 }] }) });
    wrap(<Routes><Route path="/companies/:id" element={<CompanyDetail />} /></Routes>, '/companies/c1?tab=compliance');
    const obligations = await screen.findByRole('table', { name: 'Obligations' });
    expect(within(obligations).getByText('PC-01 — Fumigation log not kept')).toBeInTheDocument();
    expect(within(obligations).getByText('Overdue')).toBeInTheDocument();
    await waitFor(() => expect(within(obligations).getByText('Inspection visit finding')).toBeInTheDocument());
    const breakdown = await screen.findByRole('table', { name: 'How the rating is earned' });
    expect(within(breakdown).getByText('VIS-2026-0009')).toBeInTheDocument();
    expect(within(breakdown).getByText('2.75')).toBeInTheDocument();
    expect(within(screen.getByRole('table', { name: 'Audit history (1)' })).getByText('AUD-2026-0007')).toBeInTheDocument();
  });

  it('runs the accreditation desk: schemes, renewals, visits due and the work list', async () => {
    const get = mockGet({ '/facilities/accreditations/dashboard': ok(dashboard), '/facilities/accreditations/schemes': ok(schemes), '/facilities/accreditations': ok(overlay.accreditations, { total: 2 }), '/lookups': visitTypes });
    wrap(<AccreditationDesk />);
    expect(await screen.findByRole('heading', { name: 'Accreditation desk' })).toBeInTheDocument();
    const byScheme = await screen.findByRole('table', { name: 'By scheme' });
    await waitFor(() => expect(within(byScheme).getByText('Pest control and deratting')).toBeInTheDocument());
    expect(within(byScheme).getByText('3.9')).toBeInTheDocument();
    const due = screen.getByRole('table', { name: 'Visits due' });
    expect(within(due).getByText('VIS-2026-0012')).toBeInTheDocument(); expect(within(due).getByText('Overdue')).toBeInTheDocument();
    expect(await screen.findByText('ACC-LSA-2025-0011', { exact: false })).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByLabelText('Status'));
    fireEvent.click(await screen.findByRole('option', { name: 'Renewal due' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/facilities/accreditations', { params: expect.objectContaining({ status: 'DUE', page: 1 }) }));
  });
});
