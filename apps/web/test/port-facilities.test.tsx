import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import '../src/i18n';
import { store } from '../src/store';
import { setSession } from '../src/store/authSlice';
import { buildTheme } from '../src/theme';
import api from '../src/api/client';
import PortFacilitiesPage from '../src/pages/facilities/PortFacilitiesPage';
import PortFacilityDetail from '../src/pages/facilities/PortFacilityDetail';
import { reviewOpen, subjectPath } from '../src/pages/facilities/shared';
import type { PortFacility } from '../src/pages/facilities/types';

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Port Security Desk', email: 'security@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const wrap = (ui: React.ReactNode, path = '/') => render(<Provider store={store}><MemoryRouter initialEntries={[path]}><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

/* Fictional facilities in the register's shape (`facilityApi` in services/facilities/src/directory.ts). */
const base = {
  nameAr: null, berthType: 'CONTAINER', ispsLevel: 1, pssoName: 'H. Al Mazrouei', pssoPhone: '+971 2 000 0100', capabilities: ['CONTAINER', 'REEFER_PLUGS'], loaMax: 366, draftMax: 16, capacity: 250000, capacityUnit: 'TEU/yr',
  status: 'OPERATIONAL' as const, remarks: '', instruments: [], instrumentsHeld: 0, audits: [], auditCount: 0, lastAuditAt: null, lastAuditResult: null, obligations: [], openObligations: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
};
const cleared: PortFacility = {
  ...base, id: 'f1', code: 'CT1-1', name: 'Container Terminal 1 Berth 1 (sample)', facilityType: 'BERTH', terminal: 'Container Terminal 1', operatorId: 'c1', operatorName: 'Gulf Container Terminals (sample)',
  ispsStatus: 'COMPLIANT', socNo: 'SOC-2026-0101', socExpiry: '2027-03-31', ispsInForce: true,
  icpReview: { reference: 'ICP-REV-2025-004003', status: 'CLEARED', reason: 'Annual verification of the facility security plan', requestedAt: '2025-10-01T08:00:00Z', requestedBy: 'H. Al Mazrouei', expectedBy: null, decidedAt: '2025-10-12T09:20:00Z', conditions: [], checkedAt: '2025-10-12T09:20:00Z', mode: 'seed' },
};
const pending: PortFacility = {
  ...base, id: 'f2', code: 'BT2-3', name: 'Bulk Terminal Berth 3 (sample)', facilityType: 'BERTH', terminal: 'Bulk Terminal', operatorId: 'c2', operatorName: 'Gulf Bulk Handling (sample)',
  ispsStatus: 'PROVISIONAL', socNo: 'SOC-2026-0202', socExpiry: '2026-12-31', ispsInForce: false,
  icpReview: { reference: 'ICP-REV-2026-004017', status: 'SUBMITTED', reason: 'Renewal of the Statement of Compliance', requestedAt: '2026-09-03T08:00:00Z', requestedBy: 'H. Al Mazrouei', expectedBy: '2026-09-15', decidedAt: null, conditions: [], checkedAt: '2026-09-03T08:00:00Z', mode: 'stub' },
};
const fresh: PortFacility = { ...base, id: 'f3', code: 'MP-5', name: 'Multipurpose Berth 5 (sample)', facilityType: 'JETTY', terminal: 'General Cargo', operatorId: null, operatorName: '', ispsStatus: 'NOT_APPLICABLE', socNo: '', socExpiry: null, ispsInForce: false, icpReview: null };
const dashboard = { kpis: { facilities: 3, ispsCompliant: 1 }, securityReviews: { open: 1, cleared12m: 1, rejected: 0, never: 1, total: 3 } };

describe('the port-facility register', () => {
  afterEach(() => vi.restoreAllMocks());

  it('lists every facility with its ISPS standing and where the federal review stands', async () => {
    store.dispatch(setSession(session as never));
    vi.spyOn(api, 'get').mockImplementation(((url: string) => {
      if (url === '/facilities/port-facilities') return Promise.resolve(ok([cleared, pending, fresh], { total: 3 }));
      if (url === '/facilities/dashboard') return Promise.resolve(ok(dashboard));
      return Promise.reject(new Error(`Unmocked GET ${url}`));
    }) as never);
    wrap(<PortFacilitiesPage />);
    expect(await screen.findByText('Container Terminal 1 Berth 1 (sample)')).toBeInTheDocument();
    const rows = screen.getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Compliant'); expect(rows[1]).toHaveTextContent('Cleared'); expect(rows[1]).toHaveTextContent('ICP-REV-2025-004003');
    expect(rows[2]).toHaveTextContent('Provisional'); expect(rows[2]).toHaveTextContent('Submitted');
    expect(rows[3]).toHaveTextContent('Never submitted');
    expect(await screen.findByText('Reviews with the authority')).toBeInTheDocument();
    expect(screen.getByText('Cleared · 12 months')).toBeInTheDocument();
  });

  it('submits a facility for review with a reason, then asks the authority for the outcome', async () => {
    store.dispatch(setSession(session as never));
    let current: PortFacility = fresh;
    vi.spyOn(api, 'get').mockImplementation(((url: string) => {
      if (url === '/facilities/port-facilities/f3') return Promise.resolve(ok(current));
      if (url === '/facilities/port-facilities/f3/icp-reviews') return Promise.resolve(ok(current.icpReview ? [{ ...current.icpReview, id: 'h1', open: reviewOpen(current.icpReview) }] : []));
      if (url === '/facilities/port-facilities/f3/visits') return Promise.resolve(ok({ subjectId: 'f3', subjectName: fresh.name, scheduled: 0, overdue: 0, visits: [] }));
      return Promise.reject(new Error(`Unmocked GET ${url}`));
    }) as never);
    const post = vi.spyOn(api, 'post').mockImplementation(((url: string, body: unknown) => {
      if (url === '/facilities/port-facilities/f3/icp-review') {
        current = { ...fresh, icpReview: { ...pending.icpReview!, reference: 'ICP-REV-2026-MP-5', reason: (body as { reason: string }).reason, mode: 'stub' } };
        return Promise.resolve(ok(current));
      }
      if (url === '/facilities/port-facilities/f3/icp-review/refresh') {
        current = { ...current, icpReview: { ...current.icpReview!, status: 'CLEARED', decidedAt: '2026-09-11T09:20:00Z' } };
        return Promise.resolve(ok(current));
      }
      return Promise.reject(new Error(`Unmocked POST ${url}`));
    }) as never);
    wrap(<Routes><Route path="/port-facilities/:id" element={<PortFacilityDetail />} /></Routes>, '/port-facilities/f3');
    expect((await screen.findAllByText('Multipurpose Berth 5 (sample)')).length).toBeGreaterThan(0);
    expect(screen.getByTestId('review-status')).toHaveTextContent(/not been submitted/);
    // the reason is required before the submission can go
    fireEvent.click(screen.getByTestId('submit-review'));
    const dialog = await screen.findByRole('dialog');
    const confirm = within(dialog).getByTestId('submit-review-confirm');
    expect(confirm).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/Reason for the review/), { target: { value: 'Change of terminal operator' } });
    expect(confirm).toBeEnabled();
    fireEvent.click(confirm);
    await waitFor(() => expect(post).toHaveBeenCalledWith('/facilities/port-facilities/f3/icp-review', { reason: 'Change of terminal operator' }));
    await waitFor(() => expect(screen.getByTestId('review-status')).toHaveTextContent('Submitted'));
    const card = screen.getByTestId('security-review');
    expect(card).toHaveTextContent('ICP-REV-2026-MP-5'); expect(card).toHaveTextContent('Recorded contract'); expect(card).toHaveTextContent('Change of terminal operator');
    expect(screen.queryByTestId('submit-review')).toBeNull();
    // the outcome, asked for
    fireEvent.click(screen.getByTestId('check-review'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/facilities/port-facilities/f3/icp-review/refresh', {}));
    await waitFor(() => expect(screen.getByTestId('review-status')).toHaveTextContent('Cleared'));
    expect(screen.queryByTestId('check-review')).toBeNull();
    expect(screen.getByTestId('submit-review')).toHaveTextContent('Submit a new review');
    expect(within(screen.getByTestId('review-history')).getAllByRole('row')).toHaveLength(2);
  });

  it('keeps a review open until the authority closes it, and sends a facility subject to its own record', () => {
    expect(reviewOpen({ status: 'SUBMITTED' })).toBe(true); expect(reviewOpen({ status: 'in_review' })).toBe(true);
    expect(reviewOpen({ status: 'CLEARED' })).toBe(false); expect(reviewOpen({ status: 'REJECTED' })).toBe(false); expect(reviewOpen(null)).toBe(false);
    expect(subjectPath('PORT_FACILITY', 'f1')).toBe('/port-facilities/f1');
  });
});
