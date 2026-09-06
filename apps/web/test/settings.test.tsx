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
import SettingsPage from '../src/pages/admin/SettingsPage';
import SettingsSection from '../src/pages/admin/SettingsSection';
import ModuleSettingsPage from '../src/pages/ModuleSettingsPage';

/* Platform settings as an administrator meets them: a landing of cards that say what each setting governs and what it is
 * set to, a section page that saves and shows the live state the section governs, and a module page that names the
 * screens its values reach. */
const admin = { id: 'u-admin', name: 'Ashish Sharma', email: 'admin@maritime.example', active: true, kind: 'user' as const, scope: { level: 'NATIONAL' as const }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] };
const viewer = { ...admin, id: 'u-view', name: 'Viewer', role: { id: 'v', name: 'Viewer', permissions: ['settings.view'] }, perms: ['settings.view'] };
const session = (user: typeof admin) => ({ user, token: 't', refreshToken: 'r', sessionId: 's', policy: { accessTokenMinutes: 15, idleTimeoutMinutes: 30, mfaRequiredFrom: null, mfaGraceDays: 14 }, mfa: { required: false, enrolled: false, dueAt: null } });
const ok = <T,>(data: T) => ({ success: true, data });
const wrap = (path: string) => render(
  <Provider store={store}><MemoryRouter initialEntries={[path]}><ThemeProvider theme={buildTheme('light')}>
    <Routes>
      <Route path="/admin/settings" element={<SettingsPage />} />
      <Route path="/admin/settings/:section" element={<SettingsSection />} />
      <Route path="/settings/module/:moduleKey" element={<ModuleSettingsPage />} />
      <Route path="/risk" element={<div>Risk register</div>} />
    </Routes>
  </ThemeProvider></MemoryRouter></Provider>,
);
const platform = {
  sections: ['org', 'billing', 'notifications', 'smtp', 'ai'],
  values: {
    org: { portName: 'Khalifa Port', unlocode: 'AEKHL', timezone: 'Asia/Dubai', operator: 'Ministry of Energy and Infrastructure' },
    billing: { taxName: 'VAT', taxRate: 5, currency: 'AED', placeOfSupply: 'Abu Dhabi' },
    notifications: { emailEnabled: true, smsEnabled: false, digestHour: 7, escalationHours: 4 },
    smtp: { host: 'smtp.maritime.example', port: 587, secure: false, user: 'notifications@maritime.example', password: '••••••••', from: 'Maritime Platform <notifications@maritime.example>' },
    ai: { enabled: true, provider: 'local', model: 'assistant-default', temperature: 0.2, groundedOnly: true, dailyTokenBudget: 500000, apiKey: '' },
  },
  meta: { org: { updatedAt: '2026-09-01T08:00:00Z', updatedBy: 'Ashish Sharma' }, billing: { updatedAt: null, updatedBy: null }, notifications: { updatedAt: null, updatedBy: null }, smtp: { updatedAt: null, updatedBy: null }, ai: { updatedAt: null, updatedBy: null } },
};
const modules = {
  keys: ['ops', 'incidents'],
  modules: {
    ops: { defaults: {}, values: { vcnPrefix: 'MAR', channelSpeedLimitKn: 8, aisGapAlertMin: 30, anchorDriftNm: 0.2, zoneEntryWatch: true }, updatedAt: null, updatedBy: null },
    incidents: { defaults: {}, values: { mttaTargetMin: 30, mttrTargetHrs: 24, autoNotifySeverity: 'HIGH', reopenWindowDays: 30, injuryReportHrs: 24 }, updatedAt: '2026-09-02T10:00:00Z', updatedBy: 'Duty Officer' },
  },
};
const deliveries = { items: [], last24h: {}, escalation: { hours: 4, escalated24h: 2, unreadCritical: 1 }, channels: { email: true, sms: false, relay: 'smtp.maritime.example:587' } };
const routes: Record<string, unknown> = { '/settings': ok(platform), '/module-settings': ok(modules), '/notifications/deliveries': ok(deliveries), '/ai/status': ok({ enabled: true, profile: 'assistant-default', composer: 'platform composer', keyConfigured: false, budget: { dailyTokens: 500000, usedToday: 1200, questionsToday: 3, remaining: 498800, exhausted: false } }), '/module-settings/ops': ok({ key: 'ops', defaults: modules.modules.ops.values, values: modules.modules.ops.values }) };
const mockGet = () => vi.spyOn(api, 'get').mockImplementation(async (url: string) => { if (url in routes) return routes[url] as never; throw new Error(`unexpected GET ${url}`); });

describe('platform settings', () => {
  afterEach(() => vi.restoreAllMocks());

  it('the landing is a card for every platform section and every module, with the values that matter and who reads them', async () => {
    store.dispatch(setSession(session(viewer) as never));
    mockGet();
    wrap('/admin/settings');
    const org = await screen.findByTestId('settings-card-org');
    expect(org).toHaveTextContent('Organisation'); expect(org).toHaveTextContent('Khalifa Port'); expect(org).toHaveTextContent('AEKHL'); expect(org).toHaveTextContent('by Ashish Sharma');
    expect(org).toHaveTextContent('Revenue & Billing');
    const billing = screen.getByTestId('settings-card-billing');
    expect(billing).toHaveTextContent('VAT 5%'); expect(billing).toHaveTextContent('Seeded defaults');
    expect(screen.getByTestId('settings-card-notifications')).toHaveTextContent('email on · SMS off');
    expect(screen.getByTestId('settings-card-smtp')).toHaveTextContent('smtp.maritime.example:587');
    expect(screen.getByTestId('settings-card-ai')).toHaveTextContent('500,000 tokens');
    expect(screen.getByTestId('settings-card-integrations')).toHaveTextContent('Integrations');
    await waitFor(() => expect(screen.getByTestId('settings-card-module-ops')).toHaveTextContent('Channel limit'));
    expect(screen.getByTestId('settings-card-module-ops')).toHaveTextContent('8 kn'); expect(screen.getByTestId('settings-card-module-ops')).toHaveTextContent('Live Traffic');
    expect(screen.getByTestId('settings-card-module-incidents')).toHaveTextContent('by Duty Officer');
    // no secret ever reaches a card
    expect(screen.getByTestId('settings-card-smtp')).not.toHaveTextContent('••••');
    // a card opens its section
    fireEvent.click(within(screen.getByTestId('settings-card-notifications')).getByRole('button'));
    expect(await screen.findByRole('heading', { name: 'Notifications — settings' })).toBeInTheDocument();
  });

  it('a retired tab address lands on the page that now owns the value', async () => {
    store.dispatch(setSession(session(admin) as never));
    mockGet();
    wrap('/admin/settings?tab=riskWeights');
    expect(await screen.findByText('Risk register')).toBeInTheDocument();
  });

  it('a section page saves, shows where it is used, and — for notifications — the escalation sweep it governs', async () => {
    store.dispatch(setSession(session(admin) as never));
    mockGet();
    const put = vi.spyOn(api, 'put').mockImplementation(async (_url: string, body: unknown) => ok(body) as never);
    const post = vi.spyOn(api, 'post').mockImplementation(async () => ok({ escalated: 1, recipients: 2, hours: 4 }) as never);
    wrap('/admin/settings/notifications');
    const hours = await screen.findByLabelText('Escalate unread critical alerts after (hours)');
    expect(hours).toHaveValue(4);
    expect(screen.getByText('Where this is used')).toBeInTheDocument();
    expect(screen.getByText(/Scheduler — the digest jobs/)).toBeInTheDocument();
    const panel = await screen.findByTestId('escalation-panel');
    expect(panel).toHaveTextContent('sent on after 4 h'); expect(panel).toHaveTextContent('1 unread critical'); expect(panel).toHaveTextContent('smtp.maritime.example:587');
    fireEvent.change(hours, { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save Notifications' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/settings/notifications', expect.objectContaining({ escalationHours: 6 })));
    fireEvent.click(within(panel).getByRole('button', { name: 'Run escalation now' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/notifications/escalate'));
  });

  it('the SMTP test reports the relay\'s own answer, failure included, and the AI page shows the day\'s budget', async () => {
    store.dispatch(setSession(session(admin) as never));
    mockGet();
    vi.spyOn(api, 'put').mockImplementation(async (_url: string, body: unknown) => ok(body) as never);
    vi.spyOn(api, 'post').mockImplementation(async () => ok({ status: 'FAILED', ok: false, tls: false, authenticated: false, durationMs: 12, detail: 'smtp.maritime.example: connection refused' }) as never);
    const { unmount } = wrap('/admin/settings/smtp');
    fireEvent.click(await screen.findByRole('button', { name: 'Test connection' }));
    const result = await screen.findByTestId('smtp-result');
    expect(result).toHaveTextContent('connection refused'); expect(result.className).toMatch(/Error|error/);
    unmount();
    wrap('/admin/settings/ai');
    const ai = await screen.findByTestId('assistant-panel');
    expect(ai).toHaveTextContent('platform composer'); expect(ai).toHaveTextContent('3 questions today'); expect(ai).toHaveTextContent('498,800 of 500,000 left');
  });

  it('a viewer sees the section read-only and an unknown section is a 404', async () => {
    store.dispatch(setSession(session(viewer) as never));
    mockGet();
    const { unmount } = wrap('/admin/settings/billing');
    expect(await screen.findByLabelText('Tax name')).toBeDisabled();
    expect(screen.queryByRole('button', { name: /Save Billing/ })).toBeNull();
    unmount();
    wrap('/admin/settings/nonsense');
    expect(await screen.findByText('No such settings section')).toBeInTheDocument();
  });

  it('the module page carries the settings the module actually reads and says where they land', async () => {
    store.dispatch(setSession(session(admin) as never));
    mockGet();
    wrap('/settings/module/ops');
    expect(await screen.findByLabelText('Berth window slack (hours)')).toBeInTheDocument();
    expect(screen.getByLabelText('Channel speed limit (kn)')).toHaveValue(8);
    expect(screen.getByTestId('module-settings-used-by')).toHaveTextContent('Live Traffic — channel speed, AIS gap, anchor drift, zone entry');
    expect(screen.getByRole('button', { name: 'All settings' })).toBeInTheDocument();
  });
});
