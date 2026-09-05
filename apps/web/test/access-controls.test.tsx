import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import '../src/i18n';
import { store } from '../src/store';
import { clearSession, setSession } from '../src/store/authSlice';
import { buildTheme } from '../src/theme';
import Login from '../src/pages/Login';
import ProfilePage from '../src/pages/ProfilePage';
import AccessReviewsPage from '../src/pages/admin/AccessReviewsPage';
import AccessReviewDetail from '../src/pages/admin/AccessReviewDetail';
import api from '../src/api/client';

const admin = { id: 'u-admin', name: 'Ashish Sharma', email: 'admin@maritime.example', active: true, kind: 'user' as const, scope: { level: 'NATIONAL' as const }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] };
const session = { user: admin, token: 't', refreshToken: 'r', sessionId: 'fam-1', policy: { accessTokenMinutes: 15, idleTimeoutMinutes: 30, mfaRequiredFrom: null, mfaGraceDays: 14 }, mfa: { required: true, enrolled: false, dueAt: null } };
const wrap = (el: React.ReactNode, path = '/') => render(<Provider store={store}><MemoryRouter initialEntries={[path]}><ThemeProvider theme={buildTheme('light')}>{el}</ThemeProvider></MemoryRouter></Provider>);

describe('access controls on the screen', () => {
  beforeEach(() => { store.dispatch(clearSession()); vi.restoreAllMocks(); });

  it('stops sign-in for the second step and completes it with the authenticator code', async () => {
    const post = vi.spyOn(api, 'post').mockImplementation(async (url: string, body?: unknown) => {
      if (url === '/auth/login') return { success: true, data: { mfaRequired: true, mfaToken: 'mfa-token', method: 'totp', expiresInSec: 300 } } as never;
      if (url === '/auth/mfa/verify') { expect(body).toEqual({ mfaToken: 'mfa-token', code: '123456' }); return { success: true, data: { ...session, mfa: { required: true, enrolled: true, dueAt: null } } } as never; }
      throw new Error(`unexpected ${url}`);
    });
    wrap(<Login />);
    fireEvent.click(screen.getByTestId('login-super-admin'));
    await waitFor(() => expect(screen.getByTestId('mfa-step')).toBeInTheDocument());
    expect(screen.getByText('Two-step verification')).toBeInTheDocument();
    expect(store.getState().auth.user).toBeNull();
    fireEvent.change(screen.getByTestId('mfa-code'), { target: { value: '123456' } });
    fireEvent.click(screen.getByTestId('mfa-verify'));
    await waitFor(() => expect(store.getState().auth.user?.email).toBe('admin@maritime.example'));
    expect(store.getState().auth.sessionId).toBe('fam-1');
    expect(store.getState().auth.policy?.idleTimeoutMinutes).toBe(30);
    expect(post).toHaveBeenCalledTimes(2);
  });

  it('enrols from the sign-in screen when the policy demands it, shows the recovery codes once, then signs in', async () => {
    vi.spyOn(api, 'post').mockImplementation(async (url: string) => {
      if (url === '/auth/login') return { success: true, data: { mfaEnrolmentRequired: true, mfaToken: 'enrol-token', dueAt: '2026-01-01T00:00:00.000Z', expiresInSec: 300 } } as never;
      if (url === '/auth/mfa/setup') return { success: true, data: { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', otpauthUri: 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' } } as never;
      if (url === '/auth/mfa/activate') return { success: true, data: { ...session, mfa: { required: true, enrolled: true, dueAt: null }, recoveryCodes: ['aaaa-bbbb', 'cccc-dddd'] } } as never;
      throw new Error(`unexpected ${url}`);
    });
    wrap(<Login />);
    fireEvent.click(screen.getByTestId('login-super-admin'));
    await waitFor(() => expect(screen.getByTestId('mfa-secret')).toHaveTextContent('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
    fireEvent.change(screen.getByTestId('mfa-code'), { target: { value: '287082' } });
    fireEvent.click(screen.getByTestId('mfa-activate'));
    await waitFor(() => expect(screen.getByTestId('recovery-codes')).toHaveTextContent('aaaa-bbbb'));
    expect(store.getState().auth.user).toBeNull();
    fireEvent.click(screen.getByTestId('mfa-continue'));
    await waitFor(() => expect(store.getState().auth.user?.email).toBe('admin@maritime.example'));
  });

  it('shows the second factor and the sessions on the profile, and lets the person enrol', async () => {
    store.dispatch(setSession(session as never));
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url === '/auth/mfa') return { success: true, data: { enrolled: false, required: true, dueAt: null, recoveryCodesLeft: 0, enforcedFrom: null, graceDays: 14 } } as never;
      if (url === '/auth/sessions') return { success: true, data: [{ id: 'fam-1', device: 'Chrome on macOS', ip: '10.0.0.1', startedAt: '2026-09-05T08:00:00Z', lastUsedAt: '2026-09-05T08:30:00Z', expiresAt: '2026-09-05T20:00:00Z', userAgent: '' }, { id: 'fam-2', device: 'Safari on iOS', ip: '10.0.0.2', startedAt: '2026-09-04T08:00:00Z', lastUsedAt: '2026-09-04T09:00:00Z', expiresAt: '2026-09-04T20:00:00Z', userAgent: '' }] } as never;
      throw new Error(`unexpected ${url}`);
    });
    const post = vi.spyOn(api, 'post').mockImplementation(async (url: string) => {
      if (url === '/auth/mfa/setup') return { success: true, data: { secret: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ', otpauthUri: 'otpauth://totp/x?secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ' } } as never;
      if (url === '/auth/mfa/activate') return { success: true, data: { recoveryCodes: ['aaaa-bbbb'] } } as never;
      throw new Error(`unexpected ${url}`);
    });
    wrap(<ProfilePage />);
    await waitFor(() => expect(screen.getByTestId('mfa-status')).toHaveTextContent('Off'));
    expect(await screen.findByText('Chrome on macOS')).toBeInTheDocument();
    expect(screen.getByText('This device')).toBeInTheDocument();
    expect(screen.getByLabelText('End session Safari on iOS')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('mfa-setup'));
    await waitFor(() => expect(screen.getByTestId('mfa-secret')).toHaveTextContent('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'));
    fireEvent.change(screen.getByTestId('mfa-code'), { target: { value: '287082' } });
    fireEvent.click(screen.getByTestId('mfa-activate'));
    await waitFor(() => expect(screen.getByTestId('recovery-codes')).toHaveTextContent('aaaa-bbbb'));
    expect(post).toHaveBeenCalledWith('/auth/mfa/activate', { code: '287082' });
  });

  it('lists review cycles, opens the detail, and lets a second person attest an account but not their own', async () => {
    store.dispatch(setSession(session as never));
    const items = [
      { id: 'i1', userId: 'u-admin', userName: 'Ashish Sharma', userEmail: 'admin@maritime.example', roleName: 'Super Admin', scope: { level: 'NATIONAL' }, lastLoginAt: '2026-09-05T08:00:00Z', dormant: false, privileged: true, decision: 'PENDING', decidedBy: '', decidedAt: null, note: '' },
      { id: 'i2', userId: 'u-2', userName: 'Capt. Salem Al Dhanhani', userEmail: 'portofficer@maritime.example', roleName: 'Harbour Master', scope: { level: 'PORT', ports: ['AEFJR'] }, lastLoginAt: null, dormant: true, privileged: false, decision: 'PENDING', decidedBy: '', decidedAt: null, note: '' },
    ];
    const cycle = { id: 'c1', openedAt: '2026-09-01T06:00:00Z', dueAt: '2026-09-15T06:00:00Z', closedAt: null, openedBy: 'Access review schedule', closedBy: '', total: 2, note: '', pending: 2, confirmed: 0, revoked: 0, status: 'OPEN' };
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url === '/access-reviews') return { success: true, data: [cycle] } as never;
      if (url === '/access-reviews/c1') return { success: true, data: { ...cycle, items } } as never;
      throw new Error(`unexpected ${url}`);
    });
    const post = vi.spyOn(api, 'post').mockResolvedValue({ success: true, data: { ...items[1], decision: 'CONFIRMED' } } as never);
    wrap(<Routes><Route path="/admin/access-reviews" element={<AccessReviewsPage />} /><Route path="/admin/access-reviews/:id" element={<AccessReviewDetail />} /></Routes>, '/admin/access-reviews');
    expect(await screen.findByTestId('review-row')).toHaveTextContent('OPEN');
    fireEvent.click(screen.getByTestId('review-row'));
    await waitFor(() => expect(screen.getAllByTestId('review-item')).toHaveLength(2));
    expect(screen.getByText('Your own account — another reviewer attests it')).toBeInTheDocument();
    expect(screen.getByText('PORT: AEFJR')).toBeInTheDocument();
    expect(screen.getByText('dormant')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Confirm Capt. Salem Al Dhanhani'));
    fireEvent.click(await screen.findByTestId('decide-confirm'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/access-reviews/c1/items/i2', { decision: 'CONFIRMED', note: '' }));
    expect(screen.getByTestId('close-review')).toBeDisabled();
  });
});
