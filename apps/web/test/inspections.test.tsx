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
import InspectionsList from '../src/pages/inspections/InspectionsList';
import AuditDashboard from '../src/pages/inspections/AuditDashboard';
import InspectionDetail from '../src/pages/inspections/InspectionDetail';
import ChecklistBuilder from '../src/pages/inspections/ChecklistBuilder';
import { answerTypeLabel, groupSections, moveItem, reseq, scoreChecklist, totalWeight } from '../src/pages/inspections/constants';
import type { ChecklistItem, ChecklistTemplate, Inspection, InspectionDashboardData, InspectionRow } from '../src/pages/inspections/types';

// recharts measures its container with ResizeObserver, which jsdom does not ship
class RO { observe() { /* noop */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || RO;

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Port State Control Officer', email: 'psc@maritime.example', active: true, kind: 'user', scope: { level: 'PORT' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
const wrap = (ui: React.ReactNode, path = '/') => render(<Provider store={store}><MemoryRouter initialEntries={[path]}><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

/* Every survey here is fictional. The shapes follow `inspectionApi`, `findingApi`, `templateApi` and
 * `auditDashboard` in services/inspection/src/inspections.ts. */
const psc: InspectionRow = {
  id: 'in1', number: 'INSP-2026-0091', vesselId: 'v1', vesselName: 'MV Coral Reach', vesselImo: '9000001', vesselFlag: 'Panama', type: 'PSC',
  inspectorId: 'u1', inspector: 'Port State Control Officer', plannedAt: '2026-09-01T07:00:00Z', startedAt: '2026-09-01T07:20:00Z', closedAt: null,
  status: 'IN_PROGRESS', result: '', detention: false, scorePct: null, findingsCount: 2,
};
const ism: InspectionRow = {
  id: 'in2', number: 'INSP-2026-0088', vesselId: 'v2', vesselName: 'MV Amber Dune', vesselImo: '9000002', vesselFlag: 'Liberia', type: 'ISM',
  inspectorId: 'u2', inspector: 'Flag State Surveyor', plannedAt: '2026-08-19T06:00:00Z', startedAt: '2026-08-19T06:15:00Z', closedAt: '2026-08-19T11:40:00Z',
  status: 'CLOSED', result: 'SATISFACTORY', detention: false, scorePct: 94, findingsCount: 0,
};
const template: ChecklistTemplate = {
  id: 'tpl1', name: 'PSC — general inspection', inspectionType: 'PSC', description: 'Riyadh MoU general items', active: true, version: 3, passScorePct: 80,
  items: [
    { seq: 1, text: 'Certificates and documentation on board and valid', category: 'Documents', answerType: 'YES_NO_NA', weight: 2, critical: true, guidance: 'Statutory certificates in force' },
    { seq: 2, text: 'Lifeboat launching arrangements operable', category: 'Life saving', answerType: 'YES_NO', weight: 3, critical: true },
    { seq: 3, text: 'Crew accommodation clean and maintained', category: 'MLC', answerType: 'YES_NO_NA', weight: 1, critical: false },
  ],
};
const survey: Inspection = {
  ...psc, portCallId: 'pc1', vcn: 'VCN-2026-0041', templateId: 'tpl1', remarks: 'Boarded alongside CT-1',
  checklist: [
    { seq: 1, text: 'Certificates and documentation on board and valid', category: 'Documents', answer: 'YES', note: '' },
    { seq: 2, text: 'Lifeboat launching arrangements operable', category: 'Life saving', answer: 'NO', note: 'Falls beyond renewal date' },
    { seq: 3, text: 'Crew accommodation clean and maintained', category: 'MLC', answer: '', note: '' },
  ],
  findings: [
    { id: 'f1', deficiencyCode: '11101', deficiencyLabel: 'Lifeboats', description: 'Lifeboat falls beyond their renewal date', actionCode: '30', dueDate: '2026-09-05', status: 'OPEN', closedAt: null },
    { id: 'f2', deficiencyCode: '01220', deficiencyLabel: 'Load line certificate', description: 'Load line certificate not endorsed at the annual survey', actionCode: '17', dueDate: '2026-09-20', status: 'CLOSED', closedAt: '2026-09-02T09:00:00Z' },
  ],
};
const dashboard: InspectionDashboardData = {
  kpis: { open: 5, closedYtd: 61, satisfactionPct: 72, detentionRatePct: 4.5, avgFindings: 2.4, openFindings: 18, checklistCompliancePct: 91 },
  byMonth: [{ month: 'Jul 26', SATISFACTORY: 6, DEFICIENCIES: 3, DETAINED: 0 }, { month: 'Aug 26', SATISFACTORY: 8, DEFICIENCIES: 2, DETAINED: 1 }],
  byType: [{ type: 'PSC', total: 34, closed: 30, detained: 2 }, { type: 'ISM', total: 12, closed: 12, detained: 0 }],
};
const cards = [
  { label: 'Open inspections', value: 5, sub: 'planned + in progress', tone: 'default' },
  { label: 'Open findings', value: 18, sub: 'deficiencies to rectify', tone: 'warning' },
  { label: 'Detentions YTD', value: 2, sub: '', tone: 'error' },
  { label: 'Satisfactory', value: '72%', sub: 'closed with no deficiency', tone: 'success' },
];
const registerRoutes = { '/stats/inspections': ok({ cards }), '/inspections': ok([psc, ism], { total: 2 }) };
const detailRoutes = { '/inspections/in1': ok(survey), '/checklist-templates': ok([template]), '/module-settings/inspect': ok({ passScorePct: 80 }), '/lookups': ok([{ id: 'l1', code: '11101', label: 'Lifeboats' }]) };
const detailAt = () => wrap(<Routes><Route path="/inspections/:id" element={<InspectionDetail />} /></Routes>, '/inspections/in1');

describe('Survey register', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('lists surveys with their type, standing, result and finding count', async () => {
    mockGet(registerRoutes);
    wrap(<InspectionsList />);
    expect(await screen.findByText('INSP-2026-0091')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Inspections & audits' })).toBeInTheDocument();
    expect(screen.getByText('PSC, flag state, ISM, ISPS and MLC inspections')).toBeInTheDocument();

    const stats = document.querySelector('[data-stats-scope="inspections"]') as HTMLElement;
    expect(within(stats).getByText('Open findings')).toBeInTheDocument();
    expect(within(stats).getByText('deficiencies to rectify')).toBeInTheDocument();

    const body = within(screen.getByRole('table')).getAllByRole('rowgroup')[1];
    expect(within(body).getByText('MV Coral Reach')).toBeInTheDocument();
    expect(within(body).getByText('Flag State Surveyor')).toBeInTheDocument();
    expect(within(body).getByText('In progress')).toBeInTheDocument();
    expect(within(body).getByText('Closed')).toBeInTheDocument();
    expect(within(body).getByText('Satisfactory')).toBeInTheDocument();
    expect(within(body).getByText('2')).toBeInTheDocument();
  });

  it('narrows the register to one survey type', async () => {
    const get = mockGet(registerRoutes);
    wrap(<InspectionsList />);
    await screen.findByText('INSP-2026-0091');
    fireEvent.mouseDown(screen.getAllByLabelText('Type')[0]);
    fireEvent.click(await screen.findByRole('option', { name: 'ISM' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/inspections', { params: expect.objectContaining({ type: 'ISM', page: 1 }) }));
  });

  it('plans a survey against a ship and a checklist template', async () => {
    mockGet({ ...registerRoutes, '/vessels': ok([{ id: 'v1', name: 'MV Coral Reach', imo: '9000001' }]), '/checklist-templates': ok([template]) });
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({ id: 'in9', number: 'INSP-2026-0092' }) as never);
    wrap(<InspectionsList />);
    fireEvent.click(await screen.findByRole('button', { name: 'New inspection' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Plan inspection')).toBeInTheDocument();
    fireEvent.mouseDown(within(dialog).getByLabelText(/^Vessel/));
    fireEvent.click(await screen.findByRole('option', { name: 'MV Coral Reach · IMO 9000001' }));
    fireEvent.mouseDown(within(dialog).getByLabelText(/^Inspection type/));
    fireEvent.click(await screen.findByRole('option', { name: 'PSC' }));
    fireEvent.mouseDown(within(dialog).getByLabelText('Checklist template'));
    fireEvent.click(await screen.findByRole('option', { name: 'PSC — general inspection (3 items)' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Create' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/inspections', expect.objectContaining({ vesselId: 'v1', type: 'PSC', templateId: 'tpl1', inspector: 'Port State Control Officer' })));
  });
});

describe('Survey & audit dashboard', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows outcomes, deficiency intensity and checklist compliance', async () => {
    mockGet({ '/inspections/dashboard': ok(dashboard) });
    wrap(<AuditDashboard />);
    expect(await screen.findByText('Open surveys')).toBeInTheDocument();
    expect(screen.getByText('61 closed YTD')).toBeInTheDocument();
    expect(screen.getByText('72%')).toBeInTheDocument();
    expect(screen.getByText('detention rate 4.5%')).toBeInTheDocument();
    expect(screen.getByText('18 findings still open')).toBeInTheDocument();
    expect(screen.getByText('91%')).toBeInTheDocument();
    const byType = screen.getByRole('table', { name: 'By survey type' });
    expect(within(byType).getByText('PSC')).toBeInTheDocument();
    expect(within(byType).getByText('34')).toBeInTheDocument();
    expect(within(byType).getByText('—')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deficiency analysis report' })).toBeInTheDocument();
  });
});

describe('Survey record', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('draws the answered checklist, the live weighted score and the findings raised', async () => {
    mockGet(detailRoutes);
    detailAt();
    expect(await screen.findByRole('heading', { name: /INSP-2026-0091/ })).toBeInTheDocument();
    expect(screen.getByText(/^PSC inspection · Port State Control Officer · planned 01 Sep 2026/)).toBeInTheDocument();
    expect(screen.getByText('In progress')).toBeInTheDocument();
    expect(screen.getByText('Call VCN-2026-0041')).toBeInTheDocument();
    // question 2 carries weight 3 and is critical: answered NO it fails the survey outright
    expect(await screen.findByText('40% compliance (live)')).toBeInTheDocument();
    expect(screen.getByText('Critical item failed')).toBeInTheDocument();
    expect(screen.getByText('(2/3 answered)')).toBeInTheDocument();

    const checklist = screen.getByRole('table', { name: 'Checklist' });
    expect(within(checklist).getByText('Lifeboat launching arrangements operable')).toBeInTheDocument();
    expect(within(checklist).getByText('Life saving')).toBeInTheDocument();
    expect(within(checklist).getByRole('group', { name: 'Answer — Crew accommodation clean and maintained' })).toBeInTheDocument();

    expect(screen.getByText('Findings (2)')).toBeInTheDocument();
    expect(screen.getByText('Lifeboat falls beyond their renewal date')).toBeInTheDocument();
    expect(screen.getByText('Action 30')).toBeInTheDocument();
    expect(screen.getByText('Boarded alongside CT-1')).toBeInTheDocument();
  });

  it('answers a checklist question and saves the sheet', async () => {
    mockGet(detailRoutes);
    const put = vi.spyOn(api, 'put').mockResolvedValue(ok({}) as never);
    detailAt();
    const checklist = await screen.findByRole('table', { name: 'Checklist' });
    const group = within(checklist).getByRole('group', { name: 'Answer — Crew accommodation clean and maintained' });
    fireEvent.click(within(group).getByRole('button', { name: 'YES' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Save answers' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/inspections/in1', { checklist: expect.arrayContaining([expect.objectContaining({ seq: 3, answer: 'YES' })]) }));
  });

  it('closes the survey with the result the checklist suggests', async () => {
    mockGet(detailRoutes);
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({}) as never);
    detailAt();
    fireEvent.click(await screen.findByRole('button', { name: 'Close inspection' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/1 open finding\(s\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/a critical question failed/)).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Closing remarks'), { target: { value: 'Detained pending renewal of the lifeboat falls' } });
    fireEvent.click(within(dialog).getAllByRole('button', { name: 'Close inspection' })[0]);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/inspections/in1/close', { result: 'DETAINED', remarks: 'Detained pending renewal of the lifeboat falls' }));
  });
});

describe('Checklist builder', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('opens a template, groups its questions by section and adds one', async () => {
    mockGet({ '/checklist-templates': ok([template]) });
    wrap(<ChecklistBuilder />);
    expect(await screen.findByRole('button', { name: 'Open checklist PSC — general inspection' })).toBeInTheDocument();
    expect(screen.getByText('3 questions · v3 · pass ≥80%')).toBeInTheDocument();
    expect(screen.getByText('3 questions')).toBeInTheDocument();
    expect(screen.getByText('total weight 6')).toBeInTheDocument();
    expect(screen.getByText('2 critical')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Section Life saving' })).toBeInTheDocument();
    expect(screen.getByText('Statutory certificates in force')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Add question' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText(/^Question/), { target: { value: 'Oil record book up to date' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add question' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText('4 questions')).toBeInTheDocument();
    expect(screen.getByText('total weight 7')).toBeInTheDocument();
    // the new question lands in the section the builder was last working in
    const mlc = screen.getByRole('table', { name: 'Section MLC' });
    expect(within(mlc).getByText('Oil record book up to date')).toBeInTheDocument();
  });
});

describe('checklist scoring and editing', () => {
  const items = template.items;
  it('scores the weighted compliance the way the service does at close', () => {
    const all = [{ seq: 1, text: items[0].text, category: 'Documents', answer: 'YES' as const }, { seq: 2, text: items[1].text, category: 'Life saving', answer: 'YES' as const }, { seq: 3, text: items[2].text, category: 'MLC', answer: 'YES' as const }];
    expect(scoreChecklist(all, template)).toEqual({ pct: 100, criticalFail: false, suggested: 'SATISFACTORY' });
    // N/A and unanswered questions leave the denominator alone
    expect(scoreChecklist([{ ...all[0] }, { ...all[1], answer: 'NA' as const }, { ...all[2], answer: '' as const }], template)).toEqual({ pct: 100, criticalFail: false, suggested: 'SATISFACTORY' });
    // a NO on a critical question detains, whatever the percentage says
    expect(scoreChecklist([{ ...all[0] }, { ...all[1], answer: 'NO' as const }, { ...all[2] }], template)).toEqual({ pct: 50, criticalFail: true, suggested: 'DETAINED' });
    // a NO on an ordinary question only drags the score under the pass mark
    expect(scoreChecklist([{ ...all[0] }, { ...all[1] }, { ...all[2], answer: 'NO' as const }], template)).toMatchObject({ criticalFail: false, suggested: 'SATISFACTORY' });
    expect(scoreChecklist([], template)).toEqual({ pct: null, criticalFail: false, suggested: 'SATISFACTORY' });
  });
  it('groups sections in first-seen order and keeps each question’s place', () => {
    const grouped = groupSections(items);
    expect(grouped.map(([cat]) => cat)).toEqual(['Documents', 'Life saving', 'MLC']);
    expect(grouped[1][1][0]).toMatchObject({ idx: 1, seq: 2 });
  });
  it('reorders and renumbers the questions', () => {
    const moved = moveItem(items as ChecklistItem[], 0, 1);
    expect(moved.map((i) => i.text)).toEqual([items[1].text, items[0].text, items[2].text]);
    expect(moved.map((i) => i.seq)).toEqual([1, 2, 3]);
    expect(moveItem(items as ChecklistItem[], 0, -1)).toBe(items);
    expect(reseq(moved.slice(1)).map((i) => i.seq)).toEqual([1, 2]);
    expect(totalWeight(items as ChecklistItem[])).toBe(6);
    expect(answerTypeLabel('YES_NO_NA')).toBe('Yes / No / N.A.');
  });
});
