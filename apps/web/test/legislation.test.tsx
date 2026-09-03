import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import '../src/i18n';
import { store } from '../src/store';
import { setSession } from '../src/store/authSlice';
import { buildTheme } from '../src/theme';
import api from '../src/api/client';
import LegislationPage from '../src/pages/legislation/LegislationPage';
import { approvalVerdict, canAcknowledge, hasAcknowledged } from '../src/pages/legislation/shared';
import type { LegalInstrument, PendingNotice } from '../src/pages/legislation/types';

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Director of Maritime Affairs', email: 'legal@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
const wrap = (ui: React.ReactNode) => render(<Provider store={store}><MemoryRouter><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

/* Every instrument below is fictional. The shapes follow `instrumentApi` in services/legislation/src/instruments.ts
 * and the pending-notice projection in services/legislation/src/notices.controller.ts. */
const base = {
  titleAr: null as string | null, effectiveDate: null as string | null, expiryDate: null as string | null, body: '', tags: [] as string[], attachments: [],
  supersedes: '', supersededBy: '', ackRequired: false, ackClass: 'ALL_STAFF', ackClassValue: '', ackClassLabel: 'All staff', ackDueDays: null,
  acknowledgedBy: [] as { userId: string; name: string; at: string }[], acknowledgements: 0, recipients: null, outstanding: null,
  draftedById: null as string | null, draftedBy: '', reviewedById: null, reviewedBy: '', reviewedAt: null, reviewNote: '',
  clearedById: null, clearedBy: '', clearedAt: null, clearanceNote: '',
  approvedById: null as string | null, approvedBy: '', approvedAt: null as string | null,
  withdrawnById: null, withdrawnBy: '', withdrawnAt: null, withdrawalReason: '', sourceNote: '', links: [],
  inForce: true, expired: false, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const act: LegalInstrument = {
  ...base, id: 'i1', refNo: 'ACT-1981-01', title: 'Maritime Code', type: 'ACT', category: 'Primary legislation', status: 'IN_FORCE',
  issuedBy: 'Ministry of Energy and Infrastructure', issuedDate: '1981-06-01', summary: 'The statute the registry and the harbour operate under.',
};
const circular: LegalInstrument = {
  ...base, id: 'i2', refNo: 'CIR-2026-014', title: 'Bunker delivery note retention', titleAr: 'الاحتفاظ بإشعار تسليم الوقود', type: 'CIRCULAR',
  category: 'Pollution prevention', status: 'IN_FORCE', issuedBy: 'Harbour Master', issuedDate: '2026-07-01', effectiveDate: '2026-08-01',
  summary: 'Bunker delivery notes are retained on board for three years.', body: 'Masters shall retain every bunker delivery note.',
  tags: ['MARPOL', 'bunkering'], supersedes: 'CIR-2023-009', ackRequired: true, acknowledgedBy: [], draftedById: 'u7', draftedBy: 'Port Engineer',
};
const draft: LegalInstrument = {
  ...base, id: 'i3', refNo: 'NOT-2026-003', title: 'Anchorage waiting-time reporting', type: 'NOTICE', category: 'Harbour operations',
  status: 'DRAFT', issuedBy: 'Harbour Master', issuedDate: '2026-08-20', summary: 'Agents report anchorage waiting time daily.',
  draftedById: 'u7', draftedBy: 'Port Engineer',
};
const pending: PendingNotice[] = [{ id: 'i2', refNo: 'CIR-2026-014', title: 'Bunker delivery note retention', issuedDate: '2026-07-01', type: 'CIRCULAR' }];
const cards = [
  { label: 'In force', value: 2, sub: 'instruments', tone: 'default' },
  { label: 'Need acknowledgment', value: 1, sub: 'organisation-wide', tone: 'default' },
  { label: 'Pending — you', value: 1, sub: 'awaiting your acknowledgment', tone: 'warning' },
  { label: 'Total register', value: 3, sub: 'acts, rules, notices, circulars', tone: 'default' },
];
const register = (rows: LegalInstrument[] = [act, circular, draft]) => ({
  '/notices/pending': ok(pending), '/stats/legislation': ok({ cards }), '/legislation/instruments': ok(rows, { total: rows.length }),
});

describe('Notices & Circulars register', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows the stat strip, the register rows and what the desk still owes a receipt on', async () => {
    mockGet(register());
    wrap(<LegislationPage />);
    expect(await screen.findByText('ACT-1981-01')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Notices & Circulars' })).toBeInTheDocument();

    const stats = document.querySelector('[data-stats-scope="legislation"]')!;
    expect(within(stats as HTMLElement).getByText('In force')).toBeInTheDocument();
    expect(within(stats as HTMLElement).getByText('Pending — you')).toBeInTheDocument();
    expect(within(stats as HTMLElement).getByText('acts, rules, notices, circulars')).toBeInTheDocument();

    const table = screen.getByRole('table');
    expect(within(table).getByText('Maritime Code')).toBeInTheDocument();
    expect(within(table).getByText('Bunker delivery note retention')).toBeInTheDocument();
    expect(within(table).getByText('Pollution prevention')).toBeInTheDocument();
    expect(within(table).getByText('01 Jul 2026')).toBeInTheDocument();
    expect(within(table).getAllByText('In force')).toHaveLength(2);
    expect(within(table).getByText('Draft')).toBeInTheDocument();
    // the circular needs a receipt this user has not given; the act needs none at all
    expect(within(table).getByText('Action required')).toBeInTheDocument();
    expect(within(table).getAllByText('—').length).toBeGreaterThan(0);

    // the outstanding-acknowledgment banner is driven by /notices/pending, not by the register page
    expect(screen.getByText('1 instrument(s) still await your acknowledgment')).toBeInTheDocument();
    expect(screen.getByText('CIR-2026-014 — Bunker delivery note retention')).toBeInTheDocument();
  });

  it('narrows the register by instrument type through the toolbar filter', async () => {
    const get = mockGet(register());
    wrap(<LegislationPage />);
    await screen.findByText('ACT-1981-01');
    fireEvent.mouseDown(screen.getByLabelText('Type'));
    fireEvent.click(await screen.findByRole('option', { name: 'CIRCULAR' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/legislation/instruments', { params: expect.objectContaining({ type: 'CIRCULAR', page: 1 }) }));
  });

  it('opens an instrument and records this reader’s acknowledgment', async () => {
    mockGet(register());
    const acknowledged = { ...circular, acknowledgedBy: [{ userId: 'u1', name: 'Director of Maritime Affairs', at: '2026-09-01T08:00:00Z' }], acknowledgements: 1 };
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok(acknowledged) as never);
    wrap(<LegislationPage />);
    fireEvent.click(await screen.findByText('Bunker delivery note retention'));

    expect(await screen.findByRole('heading', { name: 'CIR-2026-014' })).toBeInTheDocument();
    expect(screen.getByText('الاحتفاظ بإشعار تسليم الوقود')).toBeInTheDocument();
    expect(screen.getByText('Bunker delivery notes are retained on board for three years.')).toBeInTheDocument();
    expect(screen.getByText('Masters shall retain every bunker delivery note.')).toBeInTheDocument();
    expect(screen.getByText('Issued 01 Jul 2026 by Harbour Master')).toBeInTheDocument();
    expect(screen.getByText('In force from 01 Aug 2026')).toBeInTheDocument();
    expect(screen.getByText('Supersedes CIR-2023-009')).toBeInTheDocument();
    expect(screen.getByText('MARPOL')).toBeInTheDocument();
    expect(screen.getByText('Governance')).toBeInTheDocument();
    expect(screen.getByText('0 acknowledgment(s) recorded')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge receipt' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/notices/i2/acknowledge'));
    expect(await screen.findByText('You have acknowledged this')).toBeInTheDocument();
  });

  it('puts a draft in force from the governance panel', async () => {
    mockGet(register());
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({ ...draft, status: 'IN_FORCE', approvedBy: 'Director of Maritime Affairs', approvedAt: '2026-09-02T10:00:00Z' }) as never);
    wrap(<LegislationPage />);
    fireEvent.click(await screen.findByText('Anchorage waiting-time reporting'));
    expect(await screen.findByRole('heading', { name: 'NOT-2026-003' })).toBeInTheDocument();
    expect(screen.getByText(/Awaiting approval\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Put in force' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/legislation/instruments/i3/publish'));
    expect(await screen.findByText(/Director of Maritime Affairs/)).toBeInTheDocument();
  });

  it('refuses to offer approval on a draft this reader drafted', async () => {
    const mine = { ...draft, draftedById: 'u1', draftedBy: 'Director of Maritime Affairs' };
    mockGet(register([mine]));
    wrap(<LegislationPage />);
    fireEvent.click(await screen.findByText('Anchorage waiting-time reporting'));
    expect(await screen.findByText('A drafter cannot put their own draft in force — approval belongs to a second officer.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Put in force' })).not.toBeInTheDocument();
  });
});

describe('publication governance', () => {
  const user = { id: 'u1', perms: ['legislation.approve'] } as never;
  it('offers approval only to a second officer on a draft with a drafter', () => {
    expect(approvalVerdict({ status: 'IN_FORCE', draftedById: 'u7' }, user)).toEqual({ ok: false, reason: 'NOT_DRAFT' });
    expect(approvalVerdict({ status: 'DRAFT', draftedById: 'u7' }, { id: 'u1', perms: [] } as never)).toEqual({ ok: false, reason: 'NO_PERM' });
    expect(approvalVerdict({ status: 'DRAFT', draftedById: null }, user)).toEqual({ ok: false, reason: 'NO_DRAFTER' });
    expect(approvalVerdict({ status: 'DRAFT', draftedById: 'u1' }, user)).toEqual({ ok: false, reason: 'SELF' });
    expect(approvalVerdict({ status: 'DRAFT', draftedById: 'u7' }, user)).toEqual({ ok: true });
  });
  it('asks for a receipt once, and only while the instrument bites', () => {
    const row = { ackRequired: true, status: 'IN_FORCE' as const, acknowledgedBy: [] };
    expect(canAcknowledge(row, 'u1')).toBe(true);
    expect(canAcknowledge({ ...row, status: 'DRAFT' }, 'u1')).toBe(false);
    expect(canAcknowledge({ ...row, ackRequired: false }, 'u1')).toBe(false);
    expect(canAcknowledge({ ...row, acknowledgedBy: [{ userId: 'u1', name: 'Reader', at: '2026-09-01T00:00:00Z' }] }, 'u1')).toBe(false);
    expect(hasAcknowledged({ acknowledgedBy: [{ userId: 'u2', name: 'Other', at: '2026-09-01T00:00:00Z' }] }, 'u1')).toBe(false);
  });
});
