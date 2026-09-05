import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import i18n from '../src/i18n';
import { store } from '../src/store';
import { setSession } from '../src/store/authSlice';
import { setLang } from '../src/store/uiSlice';
import { buildTheme } from '../src/theme';
import api from '../src/api/client';
import LawPortal from '../src/pages/public/LawPortal';
import LawInstrument from '../src/pages/public/LawInstrument';
import ImoWatch from '../src/pages/legislation/ImoWatch';
import LegislationPage from '../src/pages/legislation/LegislationPage';
import { lawPath, portalAbsence } from '../src/pages/legislation/shared';
import type { ImoDashboard, ImoItem, ImoSource, LegalInstrument, PublicInstrument } from '../src/pages/legislation/types';

/* The public citable portal and the IMO watch. Every instrument, source document and person here is fictional;
 * the shapes follow services/legislation/src/{portal,imo,instruments}.ts. */
class RO { observe() { /* noop */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || RO;

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Legal Clerk', email: 'legal@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const lookups: Record<string, unknown[]> = {
  legalInstrumentType: [
    { id: 't1', category: 'legalInstrumentType', code: 'CIRCULAR', label: 'Circular', labelAr: 'تعميم', active: true, meta: { citable: true, refPrefix: 'CIRC', order: 3 } },
    { id: 't2', category: 'legalInstrumentType', code: 'NOTICE', label: 'Notice', active: true, meta: { citable: true, refPrefix: 'NOTICE', order: 4 } },
    { id: 't3', category: 'legalInstrumentType', code: 'INTERNAL', label: 'Internal instruction', active: true, meta: { citable: false, refPrefix: 'INS', order: 9 } },
  ],
  imoSource: [
    { id: 's1', category: 'imoSource', code: 'MSC', label: 'Maritime Safety Committee', labelAr: 'لجنة السلامة البحرية', active: true, meta: { body: 'MSC', series: 'MSC.1/Circ.', pollHours: 24 } },
    { id: 's2', category: 'imoSource', code: 'LEG', label: 'Legal Committee', active: true, meta: { body: 'LEG', series: 'LEG/Circ.', pollHours: 168 } },
  ],
};
type Call = { url: string; cfg?: { params?: Record<string, unknown> } };
const calls: Call[] = [];
const mockGet = (routes: Record<string, unknown | ((cfg?: Call['cfg']) => unknown)>) => vi.spyOn(api, 'get').mockImplementation(((url: string, cfg?: Call['cfg']) => {
  calls.push({ url, cfg });
  if (url === '/lookups') return Promise.resolve(ok(lookups[String(cfg?.params?.category ?? '')] ?? []));
  if (!(url in routes)) return Promise.reject(new Error(`Unmocked GET ${url}`));
  const r = routes[url];
  const body = typeof r === 'function' ? (r as (c?: Call['cfg']) => unknown)(cfg) : r;
  return body instanceof Error ? Promise.reject(body) : Promise.resolve(body);
}) as never);
const wrap = (ui: React.ReactNode, path = '/') => render(<Provider store={store}><MemoryRouter initialEntries={[path]}><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

const circular: PublicInstrument = {
  refNo: 'CIRC-02/2026', slug: 'circ-02-2026', url: 'https://maritime.example/law/circ-02-2026', title: 'Ballast water record book entries', titleAr: 'قيود سجل مياه الصابورة', type: 'CIRCULAR', typeLabel: 'Circular', typeLabelAr: 'تعميم', subject: 'Pollution prevention',
  status: 'IN_FORCE', standing: 'IN_FORCE', inForce: true, issuedBy: 'Harbour Master', issuedDate: '2026-02-01', effectiveDate: '2026-03-01', expiryDate: null, publishedAt: '2026-02-01T08:00:00Z',
  summary: 'Every ballast operation is entered in the record book before departure.', body: 'Masters shall record every uptake, exchange and discharge of ballast water.', tags: ['BWM', 'ballast'], attachments: [{ name: 'Form BW-1', kind: 'FORM', url: 'https://maritime.example/files/bw-1.pdf', sizeBytes: 1024 }],
  supersedes: 'CIRC-09/2023', supersededBy: '', withdrawnAt: null, links: [{ kind: 'SUPERSEDES', direction: 'OUT', refNo: 'CIRC-09/2023', url: 'https://maritime.example/law/circ-09-2023' }], contentHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', lastModified: '2026-02-02T09:00:00Z',
  citation: { en: 'Maritime administration, Circular CIRC-02/2026, "Ballast water record book entries" (in force from 01 March 2026). https://maritime.example/law/circ-02-2026 [version a1b2c3d4]', ar: 'الإدارة البحرية، تعميم CIRC-02/2026، «قيود سجل مياه الصابورة» (ساري من 01 مارس 2026). https://maritime.example/law/circ-02-2026 [الإصدار a1b2c3d4]' },
};
const old: PublicInstrument = { ...circular, refNo: 'CIRC-09/2023', slug: 'circ-09-2023', url: 'https://maritime.example/law/circ-09-2023', title: 'Ballast water record book (2023)', titleAr: null, status: 'SUPERSEDED', standing: 'SUPERSEDED', inForce: false, supersedes: '', supersededBy: 'CIRC-02/2026', links: [{ kind: 'SUPERSEDED_BY', direction: 'IN', refNo: 'CIRC-02/2026', url: 'https://maritime.example/law/circ-02-2026' }], citation: { en: 'Maritime administration, Circular CIRC-09/2023, "Ballast water record book (2023)" (superseded by CIRC-02/2026). https://maritime.example/law/circ-09-2023 [version a1b2c3d4]', ar: 'الإدارة البحرية، تعميم CIRC-09/2023' } };
const notice: PublicInstrument = { ...circular, refNo: 'NOTICE-04/2026', slug: 'notice-04-2026', url: 'https://maritime.example/law/notice-04-2026', title: 'Anchorage charges from October', titleAr: null, type: 'NOTICE', typeLabel: 'Notice', typeLabelAr: null, subject: 'Harbour operations', standing: 'NOT_YET_IN_FORCE', inForce: false, effectiveDate: '2026-10-01', supersedes: '', links: [], attachments: [], tags: [] };
const listing = (rows: PublicInstrument[], total = rows.length) => ({ success: true, data: rows, meta: { total, page: 1, limit: 20 }, facets: { types: [{ code: 'CIRCULAR', label: 'Circular', labelAr: 'تعميم', count: 2 }, { code: 'NOTICE', label: 'Notice', count: 1 }], subjects: [{ subject: 'Pollution prevention', count: 2 }, { subject: 'Harbour operations', count: 1 }], years: [{ year: 2026, count: 3 }] }, portal: { baseUrl: 'https://maritime.example', path: '/law', feed: 'https://maritime.example/api/public/legislation/feed' } });

const PortalApp = () => <Routes><Route path="/law" element={<LawPortal />} /><Route path="/law/:slug" element={<LawInstrument />} /></Routes>;

describe('the public citable portal', () => {
  afterEach(() => { vi.restoreAllMocks(); calls.length = 0; });

  it('lists the published register without a session, with the facets the service computed, and opens an instrument at its address', async () => {
    mockGet({ '/public/legislation': (cfg?: Call['cfg']) => listing(cfg?.params?.q === 'ballast' ? [circular, old] : [circular, notice, old], cfg?.params?.q === 'ballast' ? 2 : 3), '/public/legislation/circ-02-2026': ok(circular) });
    wrap(<PortalApp />, '/law');
    expect(await screen.findByRole('heading', { name: 'Legal instruments in force' })).toBeInTheDocument();
    expect(await screen.findByText('3 instrument(s)')).toBeInTheDocument();
    expect(screen.getByText('CIRC-02/2026')).toBeInTheDocument();
    expect(screen.getByText('Ballast water record book entries')).toBeInTheDocument();
    expect(screen.getByText('Not yet in force')).toBeInTheDocument();
    expect(screen.getByText('Superseded')).toBeInTheDocument();
    // the subject facet narrows the list; the type facet lists the master's labels with their counts
    expect(screen.getByText('Pollution prevention · 2')).toBeInTheDocument();
    fireEvent.mouseDown(screen.getByLabelText('Type'));
    expect(await screen.findByRole('option', { name: 'Circular (2)' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('option', { name: 'Notice (1)' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/public/legislation' && c.cfg?.params?.type === 'NOTICE')).toBe(true));
    // a search goes to the service as the q parameter
    fireEvent.change(screen.getByLabelText('Search the register'), { target: { value: 'ballast' } });
    fireEvent.submit(screen.getByRole('search'));
    expect(await screen.findByText('2 instrument(s)')).toBeInTheDocument();
    await waitFor(() => expect(calls.some((c) => c.url === '/public/legislation' && c.cfg?.params?.q === 'ballast')).toBe(true));
    // the history switch asks for superseded and withdrawn instruments too
    fireEvent.click(screen.getByLabelText('Include superseded and withdrawn'));
    await waitFor(() => expect(calls.some((c) => c.url === '/public/legislation' && c.cfg?.params?.history === 'true')).toBe(true));
    // opening an instrument lands on its stable address with the citation in both languages
    fireEvent.click(screen.getAllByText('Ballast water record book entries')[0]);
    expect(await screen.findByRole('heading', { level: 1, name: 'Ballast water record book entries' })).toBeInTheDocument();
    expect(screen.getByTestId('standing-banner')).toHaveTextContent('This instrument is in force.');
    const cite = screen.getByTestId('citation-box');
    expect(within(cite).getByText(/Circular CIRC-02\/2026, "Ballast water record book entries"/)).toBeInTheDocument();
    expect(within(cite).getByText(/تعميم CIRC-02\/2026/)).toBeInTheDocument();
    expect(screen.getByText('Masters shall record every uptake, exchange and discharge of ballast water.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Form BW-1' })).toHaveAttribute('href', 'https://maritime.example/files/bw-1.pdf');
    expect(screen.getByRole('link', { name: 'CIRC-09/2023' })).toHaveAttribute('href', '/law/circ-09-2023');
    expect(screen.getByText('a1b2c3d4e5f60718293a4b5c6d7e8f90')).toBeInTheDocument();
    expect(document.title).toBe('CIRC-02/2026 — Ballast water record book entries');
  });

  it('copies the citation, prints, and keeps a superseded instrument at its address pointing at its successor', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    Object.assign(navigator, { clipboard: { writeText } });
    const print = vi.spyOn(window, 'print').mockImplementation(() => undefined);
    mockGet({ '/public/legislation/circ-02-2026': ok(circular), '/public/legislation/circ-09-2023': ok(old) });
    wrap(<PortalApp />, lawPath('circ-02-2026'));
    await screen.findByRole('heading', { level: 1, name: 'Ballast water record book entries' });
    fireEvent.click(screen.getByRole('button', { name: 'Copy citation' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(circular.citation!.en));
    fireEvent.click(screen.getByRole('button', { name: 'Copy Arabic citation' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(circular.citation!.ar));
    fireEvent.click(screen.getByRole('button', { name: 'Copy address' }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://maritime.example/law/circ-02-2026'));
    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(print).toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'JSON' })).toHaveAttribute('href', '/api/public/legislation/circ-02-2026');
    // the superseded one
    fireEvent.click(screen.getByRole('link', { name: 'CIRC-09/2023' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Ballast water record book (2023)' })).toBeInTheDocument();
    expect(screen.getByTestId('standing-banner')).toHaveTextContent('This instrument has been superseded by CIRC-02/2026.');
    expect(screen.getByRole('link', { name: 'Open CIRC-02/2026' })).toHaveAttribute('href', '/law/circ-02-2026');
  });

  it('says plainly when no published instrument answers to a reference', async () => {
    mockGet({ '/public/legislation/no-such-1-2099': new Error('No published instrument answers to that reference') });
    wrap(<PortalApp />, lawPath('no-such-1-2099'));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No published instrument answers to that reference');
    expect(within(alert).getByRole('link', { name: 'Back to the register' })).toHaveAttribute('href', '/law');
  });

  it('switches the portal to Arabic without a session', async () => {
    // the effect that tells i18next about the store's language lives in App, which this harness does not mount;
    // the toggle's job is to change the store, so the test follows the store the way App does
    const follow = () => act(async () => { await i18n.changeLanguage(store.getState().ui.lang); });
    mockGet({ '/public/legislation': listing([circular]) });
    wrap(<PortalApp />, '/law');
    await screen.findByText('CIRC-02/2026');
    try {
      // the toggle is named after the language it switches to
      fireEvent.click(screen.getByRole('button', { name: 'العربية' }));
      expect(store.getState().ui.lang).toBe('ar');
      await follow();
      expect(await screen.findByRole('heading', { name: 'الصكوك القانونية السارية' })).toBeInTheDocument();
      expect(screen.getByText('قيود سجل مياه الصابورة')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'English' }));
      expect(store.getState().ui.lang).toBe('en');
      await follow();
      expect(await screen.findByRole('heading', { name: 'Legal instruments in force' })).toBeInTheDocument();
    } finally {
      store.dispatch(setLang('en'));
      await follow();
    }
  });
});

const sources: ImoSource[] = [
  { source: 'MSC', label: 'Maritime Safety Committee', labelAr: 'لجنة السلامة البحرية', body: 'MSC', series: 'MSC.1/Circ.', url: 'https://www.imo.org/en/MediaCentre/MeetingSummaries/Pages/MSC-Default.aspx', pollHours: 24, lastPolledAt: '2026-09-05T00:30:00Z', lastStatus: 'OK', lastError: '', lastItems: 3, newItems: 1, nextDueAt: '2026-09-06T00:30:00Z', polls: 12, mode: 'stub' },
  { source: 'LEG', label: 'Legal Committee', labelAr: null, body: 'LEG', series: 'LEG/Circ.', url: '', pollHours: 168, lastPolledAt: '2026-09-01T00:30:00Z', lastStatus: 'FAILED', lastError: 'LEG did not answer', lastItems: 0, newItems: 0, nextDueAt: '2026-09-05T06:30:00Z', polls: 4, mode: '' },
];
const items: ImoItem[] = [
  { id: 'x1', source: 'MSC', sourceLabel: 'Maritime Safety Committee', sourceLabelAr: null, body: 'MSC', series: 'MSC.1/Circ.', reference: 'MSC.1/Circ.SIM-2026-01', title: 'Guidance on fatigue on short-sea tankers', subject: 'Human element', publishedOn: '2026-08-20', entryIntoForce: '2027-01-01', url: 'https://www.imo.org/example/SIM-2026-01', status: 'NEW', assessment: '', assessedBy: '', assessedAt: null, dueOn: null, instrumentId: null, instrumentRef: '', firstSeenAt: '2026-08-21T00:30:00Z', lastSeenAt: '2026-09-05T00:30:00Z', seenCount: 15, overdue: false, createdAt: '2026-08-21T00:30:00Z', updatedAt: '2026-09-05T00:30:00Z' },
  { id: 'x2', source: 'MSC', sourceLabel: 'Maritime Safety Committee', sourceLabelAr: null, body: 'MSC', series: 'MSC.1/Circ.', reference: 'MSC.1/Circ.SIM-2026-02', title: 'Lifeboat release gear inspections', subject: 'Life-saving appliances', publishedOn: '2026-06-01', entryIntoForce: null, url: '', status: 'ASSESSED', assessment: 'A national circular is required', assessedBy: 'Legal Clerk', assessedAt: '2026-06-10T09:00:00Z', dueOn: '2026-08-31', instrumentId: null, instrumentRef: '', firstSeenAt: '2026-06-02T00:30:00Z', lastSeenAt: '2026-09-05T00:30:00Z', seenCount: 90, overdue: true, createdAt: '2026-06-02T00:30:00Z', updatedAt: '2026-06-10T09:00:00Z' },
];
const dashboard: ImoDashboard = { kpis: { sources: 2, polledOk: 1, failed: 1, neverPolled: 0, items: 2, new: 1, assessed: 1, transposed: 0, dismissed: 0, overdue: 1, last30Days: 1, withInstrument: 0 }, bySource: sources, attention: items, generatedAt: '2026-09-05T06:00:00Z' };
const target = { id: 'i9', refNo: 'CIRC-02/2026', title: 'Ballast water record book entries' } as LegalInstrument;

describe('the IMO watch', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); calls.length = 0; });
  const watch = () => mockGet({ '/legislation/imo/dashboard': ok(dashboard), '/legislation/imo/sources': ok(sources), '/legislation/imo/items': (cfg?: Call['cfg']) => ok(cfg?.params?.status === 'NEW' ? [items[0]] : items, { total: cfg?.params?.status === 'NEW' ? 1 : 2 }), '/legislation/instruments': ok([target], { total: 1 }) });

  it('shows the sources with the state of their last reading, the documents, and what needs attention', async () => {
    watch();
    wrap(<ImoWatch />, '/legislation/imo');
    expect(await screen.findByRole('heading', { name: 'IMO Watch' })).toBeInTheDocument();
    const srcTable = await screen.findByRole('table', { name: 'Sources' });
    expect(await within(srcTable).findByText('Maritime Safety Committee')).toBeInTheDocument();
    expect(within(srcTable).getByText('Legal Committee')).toBeInTheDocument();
    expect(within(srcTable).getByText('Read')).toBeInTheDocument();
    expect(within(srcTable).getByText('Failed')).toBeInTheDocument();
    expect(within(srcTable).getByText('LEG did not answer')).toBeInTheDocument();
    expect(within(srcTable).getByText('every 168 h')).toBeInTheDocument();
    expect(screen.getByText('New documents')).toBeInTheDocument();
    expect(screen.getByText('1 read, 1 failed')).toBeInTheDocument();
    expect(await screen.findByText('MSC.1/Circ.SIM-2026-01')).toBeInTheDocument();
    expect(screen.getAllByText('Overdue').length).toBeGreaterThan(0);
    // the status filter goes to the service
    fireEvent.mouseDown(screen.getByLabelText('Status'));
    fireEvent.click(await screen.findByRole('option', { name: 'New' }));
    await waitFor(() => expect(calls.some((c) => c.url === '/legislation/imo/items' && c.cfg?.params?.status === 'NEW')).toBe(true));
    // the source filter lists the master's labels
    fireEvent.mouseDown(screen.getByLabelText('Source'));
    expect(await screen.findByRole('option', { name: 'Legal Committee' })).toBeInTheDocument();
  });

  it('reads the sources now on request and reports what came back', async () => {
    watch();
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({ polled: [{ source: 'MSC', status: 'OK', items: 3, newItems: 2, error: '', mode: 'stub' }, { source: 'LEG', status: 'FAILED', items: 0, newItems: 0, error: 'LEG did not answer', mode: '' }], newItems: 2 }) as never);
    wrap(<ImoWatch />, '/legislation/imo');
    await screen.findByRole('heading', { name: 'IMO Watch' });
    fireEvent.click(screen.getByRole('button', { name: 'Read all sources now' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/legislation/imo/poll', { source: undefined, force: true }));
    await waitFor(() => expect(store.getState().ui.snackbar?.message).toContain('2 new document(s); failed: LEG: LEG did not answer'));
    const srcTable = await screen.findByRole('table', { name: 'Sources' });
    fireEvent.click(await within(srcTable).findByRole('button', { name: 'Read MSC now' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/legislation/imo/poll', { source: 'MSC', force: true }));
  });

  it('records the desk’s assessment of a document, and transposes it to an instrument on the register', async () => {
    watch();
    const post = vi.spyOn(api, 'post').mockImplementation(((_url: string, body: Record<string, unknown>) => Promise.resolve(ok({ ...items[0], status: body.status, assessment: body.assessment ?? '', instrumentRef: body.instrumentRef ?? '' }))) as never);
    wrap(<ImoWatch />, '/legislation/imo');
    fireEvent.click(await screen.findByText('Guidance on fatigue on short-sea tankers'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('link', { name: 'Open the IMO document' })).toHaveAttribute('href', 'https://www.imo.org/example/SIM-2026-01');
    expect(within(dialog).getByText('15 time(s) · first 21 Aug 2026 · last 05 Sep 2026')).toBeInTheDocument();
    // an assessment needs its text
    const record = within(dialog).getByRole('button', { name: 'Record' });
    expect(record).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Assessment'), { target: { value: 'A national circular is required' } });
    fireEvent.change(within(dialog).getByLabelText('Due date'), { target: { value: '2027-01-31' } });
    expect(record).toBeEnabled();
    fireEvent.click(record);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/legislation/imo/items/x1/assess', { status: 'ASSESSED', assessment: 'A national circular is required', dueOn: '2027-01-31', instrumentRef: null }));
    await waitFor(() => expect(store.getState().ui.snackbar?.message).toBe('Recorded as Assessed'));
    // transposing names the instrument that gives effect to it
    fireEvent.click(await screen.findByText('Guidance on fatigue on short-sea tankers'));
    const again = await screen.findByRole('dialog');
    fireEvent.mouseDown(within(again).getByLabelText('Decision'));
    fireEvent.click(await screen.findByRole('option', { name: 'Transposed' }));
    expect(within(again).getByRole('button', { name: 'Record' })).toBeDisabled();
    fireEvent.change(within(again).getByLabelText('National instrument'), { target: { value: 'CIRC' } });
    fireEvent.click(await screen.findByRole('option', { name: 'CIRC-02/2026 — Ballast water record book entries' }));
    fireEvent.click(within(again).getByRole('button', { name: 'Record' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/legislation/imo/items/x1/assess', expect.objectContaining({ status: 'TRANSPOSED', instrumentRef: 'CIRC-02/2026' })));
  });

  it('shows the watch read-only to a role without legislation.manage', async () => {
    store.dispatch(setSession({ ...session, user: { ...session.user, role: { id: 'r2', name: 'Reader', permissions: ['legislation.view'] }, perms: ['legislation.view'] } } as never));
    watch();
    wrap(<ImoWatch />, '/legislation/imo');
    await screen.findByText('MSC.1/Circ.SIM-2026-01');
    expect(screen.queryByRole('button', { name: 'Read all sources now' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('Guidance on fatigue on short-sea tankers'));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).queryByRole('button', { name: 'Record' })).not.toBeInTheDocument();
    store.dispatch(setSession(session as never));
  });
});

describe('the notice library and the portal', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); calls.length = 0; });
  const full = (over: Partial<LegalInstrument>): LegalInstrument => ({
    id: 'i2', refNo: 'CIRC-02/2026', title: 'Ballast water record book entries', titleAr: null, type: 'CIRCULAR', category: 'Pollution prevention', status: 'IN_FORCE', issuedBy: 'Harbour Master', issuedDate: '2026-02-01', effectiveDate: '2026-03-01',
    summary: 'Every ballast operation is entered in the record book before departure.', body: 'Masters shall record every uptake.', tags: [], attachments: [], supersedes: '', supersededBy: '', ackRequired: false, acknowledgedBy: [], draftedById: 'u7', draftedBy: 'Port Engineer', approvedById: 'u8', approvedBy: 'Director', approvedAt: '2026-02-01T09:00:00Z',
    links: [], public: true, publishedAt: '2026-02-01T09:00:00Z', contentHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f90', slug: 'circ-02-2026', inForce: true, expired: false,
    portal: { citable: true, url: 'https://maritime.example/law/circ-02-2026', citation: 'Maritime administration, Circular CIRC-02/2026, "Ballast water record book entries" (in force from 01 March 2026). https://maritime.example/law/circ-02-2026 [version a1b2c3d4]', citationAr: 'الإدارة البحرية، تعميم CIRC-02/2026' },
    ...over,
  });
  const cards = [{ label: 'In force', value: 1, sub: 'instruments', tone: 'default' }];

  it('labels the type from the master and hands the desk the public address and the citation of an in-force instrument', async () => {
    const row = full({});
    mockGet({ '/notices/pending': ok([]), '/stats/legislation': ok({ cards }), '/legislation/instruments': ok([row], { total: 1 }), '/legislation/instruments/i2': ok(row) });
    wrap(<LegislationPage />);
    const table = await screen.findByRole('table');
    expect(within(table).getByText('Circular')).toBeInTheDocument();
    fireEvent.click(within(table).getByText('Ballast water record book entries'));
    const box = await screen.findByTestId('portal-box');
    expect(within(box).getByRole('link', { name: 'https://maritime.example/law/circ-02-2026' })).toHaveAttribute('target', '_blank');
    expect(within(box).getByText(/Circular CIRC-02\/2026, "Ballast water record book entries"/)).toBeInTheDocument();
    expect(within(box).getByText('Content version a1b2c3d4e5f60718293a4b5c6d7e8f90')).toBeInTheDocument();
    expect(within(box).getByRole('button', { name: 'Open portal page' })).toBeInTheDocument();
  });

  it('explains why an instrument is off the portal: a draft, a non-citable type, or the desk’s switch', async () => {
    expect(portalAbsence({ status: 'DRAFT', public: true, portal: null })).toBe('DRAFT');
    expect(portalAbsence({ status: 'IN_FORCE', public: true, portal: { citable: false, url: null, citation: null, citationAr: null } })).toBe('TYPE');
    expect(portalAbsence({ status: 'IN_FORCE', public: false, portal: { citable: true, url: 'https://maritime.example/law/x', citation: 'c', citationAr: null } })).toBe('SWITCH');
    expect(portalAbsence({ status: 'IN_FORCE', public: true, portal: { citable: true, url: 'https://maritime.example/law/x', citation: 'c', citationAr: null } })).toBeNull();
    const hidden = full({ public: false });
    mockGet({ '/notices/pending': ok([]), '/stats/legislation': ok({ cards }), '/legislation/instruments': ok([hidden], { total: 1 }), '/legislation/instruments/i2': ok(hidden) });
    wrap(<LegislationPage />);
    fireEvent.click(await screen.findByText('Ballast water record book entries'));
    expect(await screen.findByText(/Kept off the public portal by the desk/)).toBeInTheDocument();
  });
});
