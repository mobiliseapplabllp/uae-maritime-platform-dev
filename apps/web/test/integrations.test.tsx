import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import '../src/i18n';
import { store } from '../src/store';
import { clearSession, setSession } from '../src/store/authSlice';
import { buildTheme } from '../src/theme';
import IntegrationsPanel from '../src/pages/admin/IntegrationsPanel';
import api from '../src/api/client';

const admin = { id: 'u-admin', name: 'Ashish Sharma', email: 'admin@maritime.example', active: true, kind: 'user' as const, scope: { level: 'NATIONAL' as const }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] };
const viewer = { ...admin, id: 'u-view', name: 'Viewer', role: { id: 'v', name: 'Viewer', permissions: ['settings.view'] }, perms: ['settings.view'] };
const session = (user: typeof admin) => ({ user, token: 't', refreshToken: 'r', sessionId: 's', policy: { accessTokenMinutes: 15, idleTimeoutMinutes: 30, mfaRequiredFrom: null, mfaGraceDays: 14 }, mfa: { required: false, enrolled: false, dueAt: null } });
const wrap = (el: React.ReactNode) => render(<Provider store={store}><MemoryRouter><ThemeProvider theme={buildTheme('light')}>{el}</ThemeProvider></MemoryRouter></Provider>);
const mohre = {
  key: 'mohre', name: 'MOHRE', nameAr: null, counterpart: 'Ministry of Human Resources and Emiratisation', kind: 'system', protocol: 'rest', description: '', reference: 'RFP §5.3 D2', mode: 'stub', enabled: true, baseUrl: 'https://stub.local/mohre', defaultBaseUrl: 'https://stub.local/mohre', contractVersion: '1.0.0', timeoutMs: 8000, maxAttempts: 3,
  auth: { type: 'apiKey', header: 'x-mohre-key' }, secrets: { apiKey: true }, headers: { 'x-tenant': 'maritime' }, healthPath: '', schedule: {}, inbound: { enabled: false, secretSet: false },
  operations: [{ key: 'verifyEmployment', summary: 'Confirm employment', method: 'GET', path: '/v1/employment/{emiratesId}', required: ['emiratesId'], idempotent: false }], updatedAt: null, updatedBy: null,
  last24h: { calls: 4, failed: 0, dead: 0, latencyP95: 12, lastCallAt: new Date().toISOString(), inbound: 0, lastInboundAt: null }, openDeadLetters: 0, certification: { passed: 2, operations: 2, certifiedAt: new Date().toISOString() },
};
const detail = { ...mohre, inboundUrl: 'https://maritime.example/api/integrations/inbound/mohre', recentCalls: [{ id: '1', operation: 'verifyEmployment', status: 'ok', mode: 'stub', httpStatus: 200, attempts: 1, durationMs: 9, error: null, correlationId: 'seafarer:1', startedAt: new Date().toISOString() }], certifications: [], recentInbound: [] };

describe('the integrations screen', () => {
  beforeEach(() => { store.dispatch(clearSession()); vi.restoreAllMocks(); });

  it('shows every adapter with its mode, never shows a credential, and saves a change with the credential only when one was typed', async () => {
    store.dispatch(setSession(session(admin) as never));
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url === '/integrations') return { success: true, data: [mohre] } as never;
      if (url === '/integrations/mohre') return { success: true, data: detail } as never;
      if (url === '/integrations/dead-letters') return { success: true, data: [] } as never;
      throw new Error(`unexpected ${url}`);
    });
    const put = vi.spyOn(api, 'put').mockImplementation(async () => ({ success: true, data: mohre }) as never);
    wrap(<IntegrationsPanel />);
    const card = await screen.findByTestId('adapter-card-mohre');
    expect(card).toHaveTextContent('MOHRE'); expect(card).toHaveTextContent('Stub'); expect(card).toHaveTextContent('API key header');
    fireEvent.click(card);
    const drawer = await screen.findByTestId('adapter-drawer');
    await waitFor(() => expect(within(drawer).getByTestId('adapter-base-url')).toHaveValue('https://stub.local/mohre'));
    const secret = within(drawer).getByTestId('adapter-secret-apiKey') as HTMLInputElement;
    expect(secret.value).toBe(''); expect(secret.placeholder).toMatch(/Set — leave blank/);
    expect(drawer.textContent).not.toContain('k-12345');
    // a save without touching the credential leaves it out of the request
    fireEvent.click(within(drawer).getByTestId('adapter-save'));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    expect(put.mock.calls[0][0]).toBe('/integrations/mohre');
    expect(put.mock.calls[0][1]).not.toHaveProperty('secrets');
    expect(put.mock.calls[0][1]).toMatchObject({ mode: 'stub', headers: { 'x-tenant': 'maritime' }, auth: { type: 'apiKey', header: 'x-mohre-key' } });
    // typed, it travels
    fireEvent.change(secret, { target: { value: 'k-new' } });
    fireEvent.click(within(drawer).getByTestId('adapter-save'));
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(put.mock.calls[1][1]).toMatchObject({ secrets: { apiKey: 'k-new' } });
  });

  it('tests the connection from the activity tab and shows the outcome; a viewer can look but not act', async () => {
    store.dispatch(setSession(session(admin) as never));
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url === '/integrations') return { success: true, data: [mohre] } as never;
      if (url === '/integrations/mohre') return { success: true, data: detail } as never;
      if (url === '/integrations/dead-letters') return { success: true, data: [] } as never;
      throw new Error(`unexpected ${url}`);
    });
    vi.spyOn(api, 'post').mockImplementation(async (url: string) => {
      if (url === '/integrations/mohre/test') return { success: true, data: { mode: 'stub', ok: true, httpStatus: null, durationMs: 1, target: null, detail: 'answers from the recorded contract — 2 of 2 operations recorded' } } as never;
      throw new Error(`unexpected ${url}`);
    });
    wrap(<IntegrationsPanel />);
    fireEvent.click(await screen.findByTestId('adapter-card-mohre'));
    const drawer = await screen.findByTestId('adapter-drawer');
    fireEvent.click(await within(drawer).findByRole('tab', { name: /Activity/ }));
    fireEvent.click(within(drawer).getByTestId('adapter-test'));
    await waitFor(() => expect(within(drawer).getByTestId('adapter-test-result')).toHaveTextContent(/2 of 2 operations recorded/));
    expect(within(drawer).getByTestId('adapter-calls')).toHaveTextContent('verifyEmployment');
    // a viewer
    store.dispatch(clearSession()); store.dispatch(setSession(session(viewer) as never));
    const { unmount } = wrap(<IntegrationsPanel />);
    expect(screen.queryByTestId('add-integration')).toBeNull();
    unmount();
  });

  it('adds a counterpart nobody declared, with its operations', async () => {
    store.dispatch(setSession(session(admin) as never));
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url === '/integrations') return { success: true, data: [mohre] } as never;
      if (url === '/integrations/port-community') return { success: true, data: { ...detail, key: 'port-community', name: 'Port community system', kind: 'custom' } } as never;
      if (url === '/integrations/dead-letters') return { success: true, data: [] } as never;
      throw new Error(`unexpected ${url}`);
    });
    const post = vi.spyOn(api, 'post').mockImplementation(async (url: string, body?: unknown) => {
      if (url === '/integrations') { expect(body).toMatchObject({ key: 'port-community', name: 'Port community system', counterpart: 'Port community platform', protocol: 'rest', operations: [{ key: 'manifest', method: 'GET', path: '/v2/calls/{vcn}/manifest' }] }); return { success: true, data: { ...mohre, key: 'port-community', name: 'Port community system', kind: 'custom' } } as never; }
      throw new Error(`unexpected ${url}`);
    });
    wrap(<IntegrationsPanel />);
    fireEvent.click(await screen.findByTestId('add-integration'));
    fireEvent.change(screen.getByTestId('new-adapter-key'), { target: { value: 'port-community' } });
    fireEvent.change(screen.getByTestId('new-adapter-name'), { target: { value: 'Port community system' } });
    fireEvent.change(screen.getByTestId('new-adapter-counterpart'), { target: { value: 'Port community platform' } });
    fireEvent.change(screen.getByTestId('new-op-key-0'), { target: { value: 'manifest' } });
    fireEvent.change(screen.getByTestId('new-op-path-0'), { target: { value: '/v2/calls/{vcn}/manifest' } });
    fireEvent.click(screen.getByTestId('add-integration-save'));
    await waitFor(() => expect(post).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByTestId('adapter-drawer')).toHaveTextContent('Port community system'));
  });
});
