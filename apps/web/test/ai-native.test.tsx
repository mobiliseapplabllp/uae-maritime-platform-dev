import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import '../src/i18n';
import { store } from '../src/store';
import { setSession } from '../src/store/authSlice';
import { buildTheme } from '../src/theme';
import api from '../src/api/client';
import AiInsights, { columnsOf, rowsOf } from '../src/components/ai/AiInsights';
import DraftDialog from '../src/components/ai/DraftDialog';
import ExtractDialog from '../src/components/ai/ExtractDialog';
import AiDock, { moduleOfPath } from '../src/components/shell/AiDock';

const ok = <T,>(data: T) => ({ success: true as const, data });
const adminUser = { id: 'u1', name: 'Platform Administrator', email: 'admin@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] };
store.dispatch(setSession({ user: adminUser, token: 't', refreshToken: 'r' } as never));
const wrap = (ui: React.ReactNode, path = '/') => render(<Provider store={store}><MemoryRouter initialEntries={[path]}><ThemeProvider theme={buildTheme('light')}><Routes><Route path="*" element={ui} /></Routes></ThemeProvider></MemoryRouter></Provider>);
afterEach(() => vi.restoreAllMocks());

/* Fictional figures only, shaped as the agent service answers. */
const finance = {
  module: 'finance', generatedAt: '2026-09-06T10:00:00Z', source: 'rules', counts: { critical: 1, warning: 1, info: 0 },
  insights: [
    { id: 'finance.overdue', module: 'finance', severity: 'critical', title: 'Invoices are overdue', titleAr: 'فواتير متأخرة', detail: 'AED 125,000 is overdue on 2 invoice(s).', detailAr: '…', metric: { label: 'Overdue', value: 125000, format: 'money' }, link: '/invoices?overdue=true', action: { tool: 'finance.invoices', args: { overdue: 'true', limit: 20 }, label: 'List the overdue invoices', labelAr: 'اعرض الفواتير المتأخرة', tier: 'READ' } },
    { id: 'finance.remind-inv-1', module: 'finance', severity: 'warning', title: 'Remind Gulf Star Shipping Agency LLC about MAR/INV/2026/0101', titleAr: '…', detail: 'Overdue 12 days, no reminder yet.', detailAr: '…', metric: { label: 'Days overdue', value: 12, format: 'days' }, link: '/invoices/inv-1', action: { tool: 'finance.send_reminder', args: { id: 'inv-1' }, label: 'Send the reminder', labelAr: 'أرسل التذكير', tier: 'ACT' } },
  ],
};

describe('insights and next actions', () => {
  it('renders the module\'s insights with their severity, metric and actions', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(ok(finance) as never);
    wrap(<AiInsights module="finance" />);
    expect(await screen.findByTestId('insight-finance.overdue')).toBeInTheDocument();
    expect(screen.getByText('Invoices are overdue')).toBeInTheDocument();
    expect(screen.getByText(/Overdue: AED 125,000/)).toBeInTheDocument();
    expect(screen.getByText('1 critical')).toBeInTheDocument();
    expect(screen.getByTestId('insight-action-finance.remind-inv-1')).toHaveTextContent('Send the reminder');
  });
  it('runs a read action through the agent service and shows the rows it returned', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(ok(finance) as never);
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({ outcome: 'OK', tool: 'finance.invoices', tier: 'READ', callId: 'c1', data: { items: [{ id: 'i1', number: 'MAR/INV/2026/0101', billTo: 'Gulf Star Shipping Agency LLC', status: 'ISSUED', balance: 80000, dueAt: '2026-08-25T00:00:00Z' }], meta: { total: 1 } } }) as never);
    wrap(<AiInsights module="finance" />);
    fireEvent.click(await screen.findByTestId('insight-action-finance.overdue'));
    const dialog = await screen.findByTestId('insight-result');
    await waitFor(() => expect(within(dialog).getByText('MAR/INV/2026/0101')).toBeInTheDocument());
    expect(post).toHaveBeenCalledWith('/agents/insights/act', { module: 'finance', insightId: 'finance.overdue', tool: 'finance.invoices', args: { overdue: 'true', limit: 20 } });
  });
  it('asks before an action that changes a record, then carries it and reports the gateway\'s answer', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(ok(finance) as never);
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({ outcome: 'REFUSED', tool: 'finance.send_reminder', tier: 'ACT', code: 'PERMISSION', reason: 'Platform Administrator does not hold invoices.issue' }) as never);
    wrap(<AiInsights module="finance" />);
    fireEvent.click(await screen.findByTestId('insight-action-finance.remind-inv-1'));
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(await screen.findByTestId('insight-confirm'));
    expect(await screen.findByTestId('insight-result-refused')).toHaveTextContent('does not hold invoices.issue');
    expect(post).toHaveBeenCalledWith('/agents/insights/act', expect.objectContaining({ tool: 'finance.send_reminder', args: { id: 'inv-1' } }));
  });
  it('says plainly when nothing needs attention, and when the module is outside the reader\'s permissions', async () => {
    vi.spyOn(api, 'get').mockResolvedValueOnce(ok({ module: 'ops', generatedAt: '', source: 'rules', insights: [], counts: { critical: 0, warning: 0, info: 0 } }) as never).mockResolvedValueOnce(ok({ module: 'ops', generatedAt: '', source: 'rules', insights: [], refused: { code: 'PERMISSION', reason: 'needs portcalls.view' } }) as never);
    const { unmount } = wrap(<AiInsights module="ops" />);
    expect(await screen.findByTestId('ai-insights-clear')).toBeInTheDocument();
    unmount();
    wrap(<AiInsights module="ops" />);
    expect(await screen.findByTestId('ai-insights-refused')).toHaveTextContent('needs portcalls.view');
  });
  it('finds the rows and columns in whatever shape a tool answered', () => {
    expect(rowsOf([{ a: 1 }])).toEqual([{ a: 1 }]);
    expect(rowsOf({ items: [{ number: 'X' }], meta: {} })).toEqual([{ number: 'X' }]);
    expect(rowsOf({ overdueList: [{ id: 1 }] })).toEqual([{ id: 1 }]);
    expect(rowsOf({ kpis: { a: 1 } })).toEqual([{ kpis: { a: 1 } }]);
    expect(columnsOf([{ id: 'x', number: 'N', status: 'S', nested: { a: 1 }, vesselName: 'V' }])).toEqual(['number', 'vesselName', 'status']);
  });
});

describe('bilingual drafting and document reading', () => {
  it('prepares a draft in the language asked for and shows what it drew on', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({ id: 'd1', kind: 'DECISION_LETTER', title: 'Decision on SR-2026-00027', body: 'Dear applicant,\n\nYour application is approved.', citations: [{ label: 'Application SR-2026-00027', link: '/services/requests/r1' }], language: 'ar', engine: 'assistant-default (grounded)', subjectLabel: 'SR-2026-00027' }) as never);
    wrap(<DraftDialog open onClose={() => {}} kind="DECISION_LETTER" subjectId="r1" subjectLabel="SR-2026-00027" />);
    fireEvent.click(screen.getByTestId('draft-lang-ar'));
    fireEvent.change(screen.getByTestId('draft-note'), { target: { value: 'Mention the fee' } });
    fireEvent.click(screen.getByTestId('draft-prepare'));
    expect(await screen.findByTestId('draft-body')).toHaveTextContent('Your application is approved.');
    expect(post).toHaveBeenCalledWith('/ai/drafts', { kind: 'DECISION_LETTER', subjectId: 'r1', language: 'ar', note: 'Mention the fee' });
    expect(screen.getByText('Application SR-2026-00027')).toBeInTheDocument();
    expect(screen.getByTestId('draft-body').querySelector('pre')?.getAttribute('dir')).toBe('rtl');
  });
  it('reads the fields asked for and flags what it could not read', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({ callId: 'c9', model: 'document-extraction', version: 3, residency: 'AE', mode: 'stub', fields: { imo: { value: '9720500', confidence: 0.93 }, expiryDate: { value: 'expiryDate-unreadable', confidence: 0.2 } }, pages: 1, confidence: 0.56, latencyMs: 12, withinSla: true }) as never);
    wrap(<ExtractDialog open onClose={() => {}} documentRef="doc1" subject="SR-2026-00027" defaultFields={['imo', 'expiryDate']} />);
    fireEvent.click(screen.getByTestId('extract-read'));
    const out = await screen.findByTestId('extract-result');
    expect(within(out).getByText('9720500')).toBeInTheDocument();
    expect(within(out).getByText(/check by hand/)).toBeInTheDocument();
    expect(within(out).getByText('Residency AE')).toBeInTheDocument();
    expect(post).toHaveBeenCalledWith('/ai/extract', { documentRef: 'doc1', fields: ['imo', 'expiryDate'], subject: 'SR-2026-00027' });
  });
});

describe('the dock follows the screen', () => {
  it('names the module the reader is on and asks for its suggestions', async () => {
    expect(moduleOfPath('/invoices/overview')?.key).toBe('finance');
    expect(moduleOfPath('/ops/berth-plan')?.key).toBe('ops');
    expect(moduleOfPath('/agents/decisions')?.key).toBe('agents');
    expect(moduleOfPath('/nowhere')).toBeNull();
    const get = vi.spyOn(api, 'get').mockImplementation(((url: string) => Promise.resolve(url === '/ai/status' ? ok({ enabled: true, profile: 'assistant-default', composer: 'platform composer', budget: { dailyTokens: 0, remaining: null, exhausted: false } }) : ok(['Which invoices are overdue?']))) as never);
    wrap(<AiDock open onClose={() => {}} />, '/invoices/overview');
    expect(await screen.findByTestId('ai-dock-intro')).toHaveTextContent('Ask about Revenue');
    await waitFor(() => expect(get).toHaveBeenCalledWith('/ai/suggestions', expect.objectContaining({ params: { module: 'finance' } })));
    expect(await screen.findByText('Which invoices are overdue?')).toBeInTheDocument();
  });
});
