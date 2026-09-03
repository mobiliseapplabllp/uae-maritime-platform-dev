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
import InvoicesList from '../src/pages/invoices/InvoicesList';
import InvoiceDetail from '../src/pages/invoices/InvoiceDetail';
import type { Invoice, InvoiceRow } from '../src/pages/invoices/types';

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Finance Officer', email: 'finance@maritime.example', active: true, kind: 'user', scope: { level: 'PORT' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
const wrap = (ui: React.ReactNode, path = '/') => render(<Provider store={store}><MemoryRouter initialEntries={[path]}><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

/* Fictional accounts. The shapes follow `toApi` in services/revenue/src/invoicing.ts and the joined
 * vessel / port-call detail assembled by InvoicesController.detail. Money is the AE profile: AED, VAT 5%. */
const billTo = { companyId: 'c1', name: 'Gulf Coast Agencies (sample)', address: 'Marina Tower, Zone 3', taxId: '100123456700003', taxIdLabel: 'TRN' };
const rowBase = {
  taxName: 'VAT', taxRatePct: 5, currency: 'AED', proforma: false, paidAmount: 0, payments: [], cancelReason: '', notes: '',
  history: [], overdue: false, createdAt: '2026-08-20T06:00:00Z', updatedAt: '2026-08-25T06:00:00Z', vesselImo: '9000001',
};
const draft: InvoiceRow = {
  ...rowBase, id: 'inv1', number: 'MAR/INV/2026/00041', portCallId: 'pc1', vcn: 'VCN-2026-0041', vesselId: 'v1', vesselName: 'MV Coral Reach',
  billTo, subtotal: 42000, taxAmount: 2100, total: 44100, status: 'DRAFT', issuedAt: null, dueAt: null, paidAt: null, paymentRef: '',
};
const issued: InvoiceRow = {
  ...rowBase, id: 'inv2', number: 'MAR/INV/2026/00040', portCallId: 'pc2', vcn: 'VCN-2026-0040', vesselId: 'v2', vesselName: 'MV Amber Dune',
  billTo: { ...billTo, name: 'Northern Star Shipping (sample)' }, subtotal: 18000, taxAmount: 900, total: 18900, status: 'ISSUED',
  issuedAt: '2026-08-22T06:00:00Z', dueAt: '2026-09-21T06:00:00Z', paidAt: null, paymentRef: '',
};
const paid: InvoiceRow = {
  ...rowBase, id: 'inv3', number: 'MAR/INV/2026/00039', portCallId: 'pc3', vcn: 'VCN-2026-0039', vesselId: 'v3', vesselName: 'MV Sable Wind',
  billTo: { ...billTo, name: 'Harbour Line Agency (sample)' }, subtotal: 9000, taxAmount: 450, total: 9450, status: 'PAID',
  issuedAt: '2026-07-30T06:00:00Z', dueAt: '2026-08-29T06:00:00Z', paidAt: '2026-08-14T09:00:00Z', paymentRef: 'TT-88213', paidAmount: 9450,
};
const detail = (row: InvoiceRow): Invoice => ({
  ...row,
  lines: [
    { code: 'PORT-DUES', description: 'Port dues', unit: 'per GRT', qty: 41000, rate: 0.8, amount: 32800 },
    { code: 'PILOT', description: 'Pilotage — inward and outward', unit: 'per act', qty: 2, rate: 3200, amount: 6400 },
    { code: 'BERTH-HIRE', description: 'Berth hire', unit: 'per day', qty: 2, rate: 1400, amount: 2800 },
  ],
  vessel: { id: 'v1', name: 'MV Coral Reach', imo: '9000001', flag: 'Panama', grt: 41000 },
  portCall: { id: 'pc1', vcn: 'VCN-2026-0041', eta: '2026-08-18T04:00:00Z', atd: '2026-08-20T22:00:00Z', agentName: 'Gulf Coast Agencies (sample)' },
});
const cards = [
  { label: 'Outstanding', value: 'AED 18.9K', sub: '1 issued invoices', tone: 'warning' },
  { label: 'Drafts', value: 1, sub: 'awaiting issue', tone: 'default' },
  { label: 'Collected MTD', value: 'AED 9.45K', sub: '', tone: 'success' },
  { label: 'Collection rate', value: '33.3%', sub: 'of everything billed', tone: 'warning' },
];
const listRoutes = { '/stats/invoices': ok({ cards }), '/invoices': ok([draft, issued, paid], { total: 3 }) };
const detailRoutes = (row: InvoiceRow) => ({ [`/invoices/${row.id}`]: ok(detail(row)), '/settings': ok({ values: { org: { portName: 'Khalifa Port', operator: 'Ministry of Energy and Infrastructure', taxId: '100999888700003', taxIdLabel: 'TRN' } } }) });
const detailAt = (row: InvoiceRow) => wrap(<Routes><Route path="/invoices/:id" element={<InvoiceDetail />} /></Routes>, `/invoices/${row.id}`);

describe('Revenue & Billing register', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('lists the ledger with the finance stat strip and money in the jurisdiction currency', async () => {
    mockGet(listRoutes);
    wrap(<InvoicesList />);
    expect(await screen.findByText('MAR/INV/2026/00041')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Revenue & Billing' })).toBeInTheDocument();
    expect(screen.getByText('Port charges billed per call — draft, issue and collect')).toBeInTheDocument();

    const stats = document.querySelector('[data-stats-scope="invoices"]') as HTMLElement;
    expect(within(stats).getByText('Outstanding')).toBeInTheDocument();
    expect(within(stats).getByText('AED 18.9K')).toBeInTheDocument();
    expect(within(stats).getByText('Collection rate')).toBeInTheDocument();

    const table = screen.getByRole('table');
    expect(within(table).getByText('Total incl. VAT')).toBeInTheDocument();
    expect(within(table).getByText('MV Coral Reach')).toBeInTheDocument();
    expect(within(table).getByText('VCN-2026-0040')).toBeInTheDocument();
    expect(within(table).getByText('Northern Star Shipping (sample)')).toBeInTheDocument();
    expect(within(table).getByText('AED 44,100.00')).toBeInTheDocument();
    const body = within(table).getAllByRole('rowgroup')[1];
    expect(within(body).getByText('Draft')).toBeInTheDocument();
    expect(within(body).getByText('Issued')).toBeInTheDocument();
    expect(within(body).getByText('Paid')).toBeInTheDocument();
    expect(within(body).getByText('14 Aug 2026')).toBeInTheDocument();
  });

  it('filters the ledger down to one status', async () => {
    const get = mockGet(listRoutes);
    wrap(<InvoicesList />);
    await screen.findByText('MAR/INV/2026/00041');
    fireEvent.mouseDown(screen.getAllByLabelText('Status')[0]);
    fireEvent.click(await screen.findByRole('option', { name: 'Issued' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/invoices', { params: expect.objectContaining({ status: 'ISSUED', page: 1 }) }));
  });

  it('draws the printable account with its charge lines, the tax head and the payer', async () => {
    mockGet(detailRoutes(draft));
    detailAt(draft);
    expect(await screen.findByRole('article', { name: 'Invoice MAR/INV/2026/00041' })).toBeInTheDocument();
    expect(screen.getByText('MV Coral Reach · call VCN-2026-0041')).toBeInTheDocument();
    expect(screen.getByText('Pro-forma')).toBeInTheDocument();
    expect(screen.getByText('Not yet issued')).toBeInTheDocument();
    expect(await screen.findByText('Khalifa Port')).toBeInTheDocument();

    const charges = screen.getByRole('table', { name: 'Charges' });
    expect(within(charges).getByText('Pilotage — inward and outward')).toBeInTheDocument();
    expect(within(charges).getByText('per GRT')).toBeInTheDocument();
    expect(within(charges).getByText('AED 32,800.00')).toBeInTheDocument();

    expect(screen.getByText('Gulf Coast Agencies (sample)')).toBeInTheDocument();
    expect(screen.getByText((_, el) => el?.textContent === 'MV Coral Reach (IMO 9000001)' && el.tagName === 'P')).toBeInTheDocument();
    expect(screen.getByText(/Call VCN-2026-0041 · GRT 41,000 · sailed 20 Aug 2026/)).toBeInTheDocument();
    expect(screen.getByText('VAT @ 5%')).toBeInTheDocument();
    expect(screen.getByText('Total payable')).toBeInTheDocument();
    expect(screen.getByText('AED 44,100.00')).toBeInTheDocument();
    // a draft may be issued or deleted, never paid
    expect(screen.getByRole('button', { name: 'Issue invoice' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete draft' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
  });

  it('issues a draft account', async () => {
    mockGet(detailRoutes(draft));
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok(detail({ ...draft, status: 'ISSUED' })) as never);
    detailAt(draft);
    fireEvent.click(await screen.findByRole('button', { name: 'Issue invoice' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/invoices/inv1/issue', undefined));
  });

  it('records a payment against an issued account with its reference', async () => {
    mockGet(detailRoutes(issued));
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok(detail({ ...issued, status: 'PAID', paidAt: '2026-09-03T08:00:00Z', paymentRef: 'TT-90114' })) as never);
    detailAt(issued);
    expect(await screen.findByText('Issued 22 Aug 2026')).toBeInTheDocument();
    expect(screen.getByText('Due 21 Sep 2026')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Record payment' }));

    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Records the full AED 18,900.00 as received against this account.')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Payment reference'), { target: { value: 'TT-90114' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Mark paid' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/invoices/inv2/pay', { paymentRef: 'TT-90114' }));
  });

  it('shows a settled account as paid and offers neither issue nor cancellation', async () => {
    mockGet(detailRoutes(paid));
    detailAt(paid);
    expect(await screen.findByText('Paid 14 Aug 2026 · TT-88213')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Issue invoice' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Record payment' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    expect(screen.getByText('Demonstration document — every charge and payment on it is fictional.')).toBeInTheDocument();
  });
});
