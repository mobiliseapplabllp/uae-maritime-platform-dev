import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import dayjs from 'dayjs';
import i18n from '../src/i18n';
import { store } from '../src/store';
import { setSession } from '../src/store/authSlice';
import { buildTheme } from '../src/theme';
import api from '../src/api/client';
import ToolGateway from '../src/pages/agents/ToolGateway';
import DecisionDrawer from '../src/pages/agents/DecisionDrawer';
import { callerChanges, callerFormOf, outcomeColor, parseToolList, shortFingerprint } from '../src/pages/agents/constants';
import type { AiDecisionDetail, GatewayCall, GatewayCaller, GatewayInference, GatewayStats, GatewayTool } from '../src/pages/agents/types';

// recharts measures its container with ResizeObserver, which jsdom does not ship
class RO { observe() { /* noop */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || RO;

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Registrar of Ships', email: 'registrar@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const reader = { ...session, user: { ...session.user, role: { id: 'r2', name: 'Auditor', permissions: ['agents.view'] }, perms: ['agents.view'] } };
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
const wrap = (ui: React.ReactNode) => render(<Provider store={store}><MemoryRouter><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

/* Every caller, call, prompt and officer below is fictional; the profile is the UAE default. */
const callers: GatewayCaller[] = [
  { callerId: 'assistant', label: 'Operations assistant', kind: 'ASSISTANT', allowedTools: ['*'], maxTier: 'INFER', hourlyQuota: 1200, dailyQuota: 12000, enabled: true, note: 'Reads as the person asking', usage: { hour: 41, day: 388 } },
  { callerId: 'agent:a2_vessel_compliance', label: 'Vessel Compliance Agent', kind: 'AGENT', allowedTools: ['ships.vessel', 'ships.certificates', 'inspect.search'], maxTier: 'READ', hourlyQuota: 300, dailyQuota: 3000, enabled: true, note: 'Reads the register', usage: { hour: 250, day: 1200 } },
  { callerId: 'svc:workflow', label: 'Service Desk', kind: 'SERVICE', allowedTools: ['docs.search'], maxTier: 'READ', hourlyQuota: 600, dailyQuota: 6000, enabled: false, note: '', usage: { hour: 0, day: 0 } },
];
const tools: GatewayTool[] = [
  { name: 'ships.vessel', module: 'ships', label: 'Vessel record', labelAr: 'سجل السفينة', description: 'One vessel: particulars, ownership, class, certificates, registry.', tier: 'READ', permission: 'vessels.view', exposure: 'BOTH', upstream: 'GET ships/vessels/{id}', enabled: true, args: ['id'] },
  { name: 'ships.certificates', module: 'ships', label: 'Ship certificates', labelAr: 'شهادات السفن', description: 'Statutory certificates across the fleet.', tier: 'READ', permission: 'certificates.view', exposure: 'BOTH', upstream: 'GET ships/vessels/certificates/all', enabled: true, args: ['expiringDays'] },
  { name: 'ops.transition_call', module: 'ops', label: 'Move a port call', labelAr: 'تغيير حالة الزيارة', description: 'Moves a port call to its next state with a note.', tier: 'ACT', permission: 'portcalls.transition', exposure: 'BOTH', upstream: 'POST ports/port-calls/{id}/transition', enabled: false, args: ['id', 'action', 'note'] },
];
const stats: GatewayStats = {
  calls: { last24h: 128, last7d: 842, last30d: 3120, failed24h: 2, refused24h: 3, p50Ms: 84, p95Ms: 610 },
  byOutcome: { OK: 790, REFUSED: 31, FAILED: 14, DRY_RUN: 7 },
  byCaller: [{ callerId: 'assistant', calls: 500, refused: 12, failed: 6, acted: 0 }, { callerId: 'agent:a2_vessel_compliance', calls: 300, refused: 19, failed: 8, acted: 40 }],
  byTier: { READ: 720, PROPOSE: 40, ACT: 30 },
  byModule: [{ module: 'ships', calls: 410 }, { module: 'inspect', calls: 220 }, { module: 'ops', calls: 160 }],
  byTool: [{ tool: 'ships.vessel', calls: 310, p50Ms: 62 }, { tool: 'inspect.search', calls: 140, p50Ms: 95 }],
  refusals: [{ code: 'TIER_CEILING', count: 19 }, { code: 'HOURLY_QUOTA', count: 8 }, { code: 'PERMISSION', count: 4 }],
  inferences: [
    { provider: 'uae', outcome: 'OK', count: 57, tokensIn: 41000, tokensOut: 9800, redactions: 12, flagged: 1, p50Ms: 1420 },
    { provider: 'uae', outcome: 'REFUSED', count: 2, tokensIn: 0, tokensOut: 0, redactions: 0, flagged: 2, p50Ms: 3 },
  ],
  byDay: Array.from({ length: 14 }, (_, i) => ({ day: dayjs('2026-08-24').add(i, 'day').format('YYYY-MM-DD'), ok: 50 + i, refused: 2, failed: 1, inferences: 4 })),
  callers,
  tools: { registered: 52, byTier: { READ: 44, PROPOSE: 3, ACT: 4, INFER: 1 } },
  generatedAt: '2026-09-06T12:00:00Z',
};
const calls: GatewayCall[] = [
  { id: 'c1', at: '2026-09-06T09:12:00Z', callerId: 'assistant', principalId: 'u1', principalName: 'Registrar of Ships', principalKind: 'user', tool: 'ships.vessel', tier: 'READ', module: 'ships', argsHash: 'a1b2c3d4e5f6a7b8', args: { id: 'v1', imo: '9000001' }, outcome: 'OK', refusalCode: null, reason: '', httpStatus: 200, upstream: 'ships GET /vessels/{id}', latencyMs: 62, redactions: 0, cause: '', decisionId: null },
  { id: 'c2', at: '2026-09-06T08:40:00Z', callerId: 'agent:a2_vessel_compliance', principalId: 'agent:a2', principalName: 'Vessel Compliance Agent', principalKind: 'agent', tool: 'ops.transition_call', tier: 'ACT', module: 'ops', argsHash: 'ffeeddcc', args: { id: 'pc2', action: 'SAIL' }, outcome: 'REFUSED', refusalCode: 'TIER_CEILING', reason: 'ops.transition_call is an ACT tool; agent:a2_vessel_compliance may reach READ at most', httpStatus: null, upstream: 'ports POST /port-calls/{id}/transition', latencyMs: 3, redactions: 0, cause: 'decision', decisionId: 'd9' },
];
const inferences: GatewayInference[] = [
  { id: 'i1', at: '2026-09-06T09:00:00Z', callerId: 'assistant', principalName: 'Registrar of Ships', purpose: 'answer', provider: 'uae', profile: 'gulf-resident-1', residency: 'AE', promptFingerprint: 'sha256:0f9e8d7c6b5a4f3e2d1c', promptChars: 1840, groundingBlocks: 3, redactions: 2, redactionKinds: { email: 1, phone: 1 }, injectionScore: 0, injectionFlags: [], outcome: 'OK', reason: '', latencyMs: 1420, tokensIn: 610, tokensOut: 140, replyChars: 520 },
  { id: 'i2', at: '2026-09-06T08:10:00Z', callerId: 'assistant', principalName: 'Harbour Master', purpose: 'answer', provider: 'hosted', profile: 'general-1', residency: 'GLOBAL', promptFingerprint: 'sha256:aaaa1111bbbb2222', promptChars: 400, groundingBlocks: 0, redactions: 0, redactionKinds: {}, injectionScore: 0.95, injectionFlags: ['ignore-instructions', 'exfiltration'], outcome: 'REFUSED', reason: 'The prompt was judged adversarial (score 0.95)', latencyMs: 2, tokensIn: 0, tokensOut: 0, replyChars: 0 },
];
const routes = { '/ai-gateway/stats': ok(stats), '/ai-gateway/callers': ok(callers), '/ai-gateway/tools': ok(tools), '/ai-gateway/calls': ok(calls), '/ai-gateway/inferences': ok(inferences) };

const executed: AiDecisionDetail = {
  id: 'd1', agentId: 'a2_vessel_compliance', agentName: 'Vessel Compliance Scoring', action: 'Clear for departure', effect: 'REVERSIBLE',
  subjectType: 'PortCall', subjectId: 'pc2', subjectLabel: 'VCN-2026-0002 · MV Amber Dune', entityType: 'PortCall', entityId: 'pc2', entityLabel: 'VCN-2026-0002',
  inputs: { imo: '9000002' }, output: { clear: true }, explanation: 'Every statutory certificate is in force and no deficiency is outstanding.',
  factors: [{ factor: 'Certificates in force', weight: 0.6, value: '8 of 8', contribution: 0.6 }],
  confidence: 0.91, autonomyLevel: 'ASSISTED', threshold: 0.8, disposition: 'APPROVED_BY_HUMAN', reviewStatus: 'REVIEWED', escalationCode: null, escalationReason: '', applied: true,
  reviewedById: 'u1', reviewedBy: 'Registrar of Ships', reviewedAt: '2026-09-06T08:41:00Z', overrideReason: '', supersedesId: null, superseded: false,
  modelKey: 'platform-local', modelVersion: '2026-09', latencyMs: 40, cohort: {},
  execution: [
    { tool: 'ops.transition_call', label: 'Move a port call', outcome: 'OK', callId: 'c7', status: 200, at: '2026-09-06T08:41:00Z', as: 'person' },
    { tool: 'ships.flag_review', label: 'Flag for survey review', outcome: 'REFUSED', code: 'TIER_CEILING', reason: 'ships.flag_review is an ACT tool; agent:a2_vessel_compliance may reach READ at most', at: '2026-09-06T08:41:01Z', as: 'agent' },
  ],
  executedAt: '2026-09-06T08:41:01Z', at: '2026-09-06T08:30:00Z', createdAt: null,
  factorTotal: 0.6, review: null, supersedes: null, openForReview: false,
};

describe('The tool gateway — the governance face', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('reads the yardsticks, the fortnight chart and the panels from the gateway’s statistics', async () => {
    mockGet(routes);
    wrap(<ToolGateway />);
    expect(await screen.findByTestId('yard-calls')).toBeInTheDocument();
    expect(screen.getByTestId('gateway-page')).toBeInTheDocument();
    expect(screen.getByText('Tool Gateway')).toBeInTheDocument();
    expect(within(screen.getByTestId('yard-calls')).getByText('128')).toBeInTheDocument();
    expect(within(screen.getByTestId('yard-calls')).getByText('842 in 7 d')).toBeInTheDocument();
    expect(within(screen.getByTestId('yard-refused')).getByText('3')).toBeInTheDocument();
    expect(within(screen.getByTestId('yard-refused')).getByText('target 0')).toBeInTheDocument();
    expect(within(screen.getByTestId('yard-failed')).getByText('14 failed in 7 d')).toBeInTheDocument();
    expect(within(screen.getByTestId('yard-p95')).getByText('610 ms')).toBeInTheDocument();
    expect(within(screen.getByTestId('yard-p95')).getByText('target ≤ 1500 ms')).toBeInTheDocument();
    expect(within(screen.getByTestId('yard-inferences')).getByText('59')).toBeInTheDocument();
    expect(within(screen.getByTestId('yard-inferences')).getByText('3 flagged')).toBeInTheDocument();
    expect(within(screen.getByTestId('yard-inferences')).getByText('12 redactions')).toBeInTheDocument();
    expect(within(screen.getByTestId('yard-callers')).getByText('2 / 3')).toBeInTheDocument();
    expect(within(screen.getByTestId('yard-callers')).getByText('52 tools registered')).toBeInTheDocument();
    expect(screen.getByTestId('chart-gateway-days')).toBeInTheDocument();
    // a refusal reads as the rule that raised it, never as a raw code
    const refusals = screen.getByTestId('panel-refusals');
    expect(within(refusals).getByText('Above the caller’s ceiling')).toBeInTheDocument();
    expect(within(refusals).getByText('Hourly quota reached')).toBeInTheDocument();
    expect(within(refusals).queryByText('TIER_CEILING')).not.toBeInTheDocument();
    expect(within(screen.getByTestId('panel-tiers')).getByText('Propose')).toBeInTheDocument();
    expect(within(screen.getByTestId('panel-modules')).getByText('Fleet Manager')).toBeInTheDocument();
    expect(within(screen.getByTestId('panel-tools')).getByText('ships.vessel')).toBeInTheDocument();
    expect(within(screen.getByTestId('panel-tools')).getByText('p50 62 ms')).toBeInTheDocument();
    expect(within(screen.getByTestId('panel-inferences')).getByText('uae · Answered')).toBeInTheDocument();
    for (const name of ['Callers', 'Tools', 'Call log', 'Inferences']) expect(screen.getByRole('tab', { name })).toBeInTheDocument();
  });

  it('lists every caller with its kind, its ceiling, its allow-list and its usage against quota', async () => {
    mockGet(routes);
    wrap(<ToolGateway />);
    const table = await screen.findByTestId('callers-table');
    expect(within(table).getByText('Vessel Compliance Agent')).toBeInTheDocument();
    expect(within(table).getByText('agent:a2_vessel_compliance')).toBeInTheDocument();
    expect(within(table).getByText('Assistant')).toBeInTheDocument();
    expect(within(table).getByText('Service')).toBeInTheDocument();
    expect(within(table).getByText('every tool')).toBeInTheDocument();
    expect(within(table).getByText('3 tools')).toBeInTheDocument();
    expect(within(table).getByText('250 / 300')).toBeInTheDocument();
    expect(within(table).getByText('388 / 12000')).toBeInTheDocument();
    expect(within(table).getByText('Infer')).toBeInTheDocument();
    expect(within(table).getAllByText('Read')).toHaveLength(2);
    expect(screen.getByLabelText('Enable Service Desk')).not.toBeChecked();
    expect(screen.getByLabelText('Enable Operations assistant')).toBeChecked();
  });

  it('configures a caller and sends only the fields that moved', async () => {
    mockGet(routes);
    const put = vi.spyOn(api, 'put').mockResolvedValue(ok({ ...callers[1], maxTier: 'PROPOSE', hourlyQuota: 400 }) as never);
    wrap(<ToolGateway />);
    await screen.findByTestId('callers-table');
    fireEvent.click(screen.getByRole('button', { name: 'Configure Vessel Compliance Agent' }));
    expect(await screen.findByRole('heading', { name: 'Configure Vessel Compliance Agent' })).toBeInTheDocument();
    // nothing has moved yet, so nothing is sent
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Nothing changed')).toBeInTheDocument();
    expect(put).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Hourly quota'), { target: { value: '400' } });
    fireEvent.mouseDown(screen.getByRole('combobox', { name: /Ceiling/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'Propose' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/ai-gateway/callers/agent:a2_vessel_compliance', { maxTier: 'PROPOSE', hourlyQuota: 400 }));
    // the row now shows the caller as the service holds it
    expect(await within(screen.getByTestId('callers-table')).findByText('250 / 400')).toBeInTheDocument();
  });

  it('switches a caller and a tool off with one change each', async () => {
    mockGet(routes);
    const put = vi.spyOn(api, 'put').mockImplementation(((url: string, body: Record<string, unknown>) =>
      Promise.resolve(ok(url.includes('/tools/') ? { name: 'ships.vessel', ...body } : { ...callers[1], ...body }))) as never);
    wrap(<ToolGateway />);
    await screen.findByTestId('callers-table');
    fireEvent.click(screen.getByLabelText('Enable Vessel Compliance Agent'));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/ai-gateway/callers/agent:a2_vessel_compliance', { enabled: false }));
    await waitFor(() => expect(screen.getByLabelText('Enable Vessel Compliance Agent')).not.toBeChecked());

    fireEvent.click(screen.getByRole('tab', { name: 'Tools' }));
    const table = await screen.findByTestId('tools-table');
    expect(within(table).getByText('Fleet Manager · 2 tools')).toBeInTheDocument();
    expect(within(table).getByText('Harbour Operations · 1 tools')).toBeInTheDocument();
    expect(within(table).getByText('Vessel record')).toBeInTheDocument();
    expect(within(table).getByText('vessels.view')).toBeInTheDocument();
    expect(within(table).getByText('POST ports/port-calls/{id}/transition')).toBeInTheDocument();
    expect(within(table).getByText('Act')).toBeInTheDocument();
    expect(screen.getByLabelText('Enable ops.transition_call')).not.toBeChecked();
    fireEvent.click(screen.getByLabelText('Enable ships.vessel'));
    await waitFor(() => expect(put).toHaveBeenCalledWith('/ai-gateway/tools/ships.vessel', { enabled: false }));
    await waitFor(() => expect(screen.getByLabelText('Enable ships.vessel')).not.toBeChecked());
  });

  it('offers a reader without agents.configure no way to change the policy', async () => {
    mockGet(routes);
    const put = vi.spyOn(api, 'put');
    store.dispatch(setSession(reader as never));
    try {
      wrap(<ToolGateway />);
      await screen.findByTestId('callers-table');
      expect(screen.getByText('Changing what a caller or a tool may do needs the agents.configure permission.')).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /^Configure / })).not.toBeInTheDocument();
      expect(screen.getByLabelText('Enable Vessel Compliance Agent')).toBeDisabled();
      fireEvent.click(screen.getByRole('tab', { name: 'Tools' }));
      await screen.findByTestId('tools-table');
      expect(screen.getByLabelText('Enable ships.vessel')).toBeDisabled();
      expect(put).not.toHaveBeenCalled();
    } finally {
      store.dispatch(setSession(session as never));
    }
  });

  it('shows the call log with the rule that refused a call, and opens a row to the redacted arguments', async () => {
    const get = mockGet(routes);
    wrap(<ToolGateway />);
    await screen.findByTestId('callers-table');
    fireEvent.click(screen.getByRole('tab', { name: 'Call log' }));
    const table = await screen.findByTestId('calls-table');
    await waitFor(() => expect(get).toHaveBeenCalledWith('/ai-gateway/calls', { params: { limit: 100 } }));
    expect(within(table).getByText('Registrar of Ships')).toBeInTheDocument();
    expect(within(table).getByText('Operations assistant')).toBeInTheDocument();
    expect(within(table).getByText('ops.transition_call')).toBeInTheDocument();
    expect(within(table).getByText('Answered')).toBeInTheDocument();
    expect(within(table).getByText('Refused')).toBeInTheDocument();
    expect(within(table).getByText('Above the caller’s ceiling')).toBeInTheDocument();
    expect(within(table).getByText(/may reach READ at most/)).toBeInTheDocument();
    expect(within(table).getByText('62 ms')).toBeInTheDocument();
    expect(within(table).getByText('200')).toBeInTheDocument();

    fireEvent.click(within(table).getAllByRole('button', { name: 'Show details' })[0]);
    expect(await within(table).findByText(/"imo": "9000001"/)).toBeInTheDocument();
    expect(within(table).getByText(/Upstream: ships GET \/vessels\/\{id\}/)).toBeInTheDocument();
    fireEvent.click(within(table).getByRole('button', { name: 'Hide details' }));
    expect(within(table).queryByText(/"imo": "9000001"/)).not.toBeInTheDocument();
  });

  it('narrows the call log by outcome and by tier, leaving empty filters off the query', async () => {
    const get = mockGet(routes);
    wrap(<ToolGateway />);
    await screen.findByTestId('callers-table');
    fireEvent.click(screen.getByRole('tab', { name: 'Call log' }));
    await screen.findByTestId('calls-table');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: /Outcome/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'Refused' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/ai-gateway/calls', { params: { outcome: 'REFUSED', limit: 100 } }));
    await screen.findByTestId('calls-table');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: /Tier/ }));
    fireEvent.click(await screen.findByRole('option', { name: 'Act' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/ai-gateway/calls', { params: { outcome: 'REFUSED', tier: 'ACT', limit: 100 } }));
  });

  it('lists inferences with where they were answered, what was masked and what was flagged', async () => {
    const get = mockGet(routes);
    wrap(<ToolGateway />);
    await screen.findByTestId('callers-table');
    fireEvent.click(screen.getByRole('tab', { name: 'Inferences' }));
    const table = await screen.findByTestId('inferences-table');
    await waitFor(() => expect(get).toHaveBeenCalledWith('/ai-gateway/inferences', { params: { limit: 100 } }));
    expect(within(table).getByText('UAE')).toBeInTheDocument();
    expect(within(table).getByText('Global')).toBeInTheDocument();
    expect(within(table).getByText('gulf-resident-1')).toBeInTheDocument();
    expect(within(table).getByText('Harbour Master')).toBeInTheDocument();
    expect(within(table).getByText('score 0.95 · ignore-instructions, exfiltration')).toBeInTheDocument();
    expect(within(table).getByText('610 / 140')).toBeInTheDocument();
    expect(within(table).getByText('1,420 ms')).toBeInTheDocument();
    expect(within(table).getByText('sha256:0f9e8')).toBeInTheDocument();
    expect(within(table).getByText('Refused')).toBeInTheDocument();
  });

  it('names each tool in the reader’s own language', async () => {
    mockGet(routes);
    await i18n.changeLanguage('ar');
    try {
      wrap(<ToolGateway />);
      await screen.findByTestId('callers-table');
      expect(screen.getByText('بوابة الأدوات')).toBeInTheDocument();
      fireEvent.click(screen.getByTestId('tab-tools'));
      const table = await screen.findByTestId('tools-table');
      expect(within(table).getByText('سجل السفينة')).toBeInTheDocument();
      expect(within(table).queryByText('Vessel record')).not.toBeInTheDocument();
      expect(within(table).getByText('تنفيذ')).toBeInTheDocument();
    } finally {
      await i18n.changeLanguage('en');
    }
  });
});

describe('A decision’s execution trail', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('lists what the decision carried to the record, who it ran as, and why anything was refused', async () => {
    mockGet({ '/agents/decisions/d1': ok(executed) });
    wrap(<DecisionDrawer id="d1" onClose={() => {}} onReviewed={() => {}} />);
    expect(await screen.findByText('Carried to the record')).toBeInTheDocument();
    const trail = screen.getByTestId('decision-execution');
    expect(within(trail).getByText('Move a port call')).toBeInTheDocument();
    expect(within(trail).getByText('Answered')).toBeInTheDocument();
    expect(within(trail).getByText(/as the reviewer/)).toBeInTheDocument();
    expect(within(trail).getByText('Flag for survey review')).toBeInTheDocument();
    expect(within(trail).getByText('Refused')).toBeInTheDocument();
    expect(within(trail).getByText(/as the agent itself/)).toBeInTheDocument();
    expect(within(trail).getByText('Above the caller’s ceiling')).toBeInTheDocument();
    expect(within(trail).getByText(/may reach READ at most/)).toBeInTheDocument();
    expect(within(trail).getByText(/^carried /)).toBeInTheDocument();
  });

  it('says so when an applied conclusion had nothing to carry', async () => {
    mockGet({ '/agents/decisions/d2': ok({ ...executed, id: 'd2', execution: [], executedAt: null }) });
    wrap(<DecisionDrawer id="d2" onClose={() => {}} onReviewed={() => {}} />);
    expect(await screen.findByText('Nothing to carry: this conclusion is a recommendation.')).toBeInTheDocument();
  });

  it('shows no trail for a conclusion still with a human', async () => {
    mockGet({ '/agents/decisions/d3': ok({ ...executed, id: 'd3', execution: [], executedAt: null, applied: false, disposition: 'ESCALATED', reviewStatus: 'PENDING', escalationCode: 'BELOW_THRESHOLD', openForReview: true }) });
    wrap(<DecisionDrawer id="d3" onClose={() => {}} onReviewed={() => {}} />);
    expect(await screen.findByText('What it was given, and what it produced')).toBeInTheDocument();
    expect(screen.queryByText('Carried to the record')).not.toBeInTheDocument();
    expect(screen.queryByText('Nothing to carry: this conclusion is a recommendation.')).not.toBeInTheDocument();
  });
});

describe('console wording for the gateway', () => {
  it('parses an allow-list as typed and sends only what moved', () => {
    expect(parseToolList('ships.vessel, ships.certificates\n inspect.search,, ships.vessel ')).toEqual(['ships.vessel', 'ships.certificates', 'inspect.search']);
    const before = callers[1];
    expect(callerChanges(before, callerFormOf(before))).toEqual({});
    expect(callerChanges(before, { ...callerFormOf(before), hourlyQuota: '400', note: ' Reads the register ' })).toEqual({ hourlyQuota: 400 });
    expect(callerChanges(before, { ...callerFormOf(before), allowedTools: '*', maxTier: 'INFER' })).toEqual({ allowedTools: ['*'], maxTier: 'INFER' });
  });
  it('shortens a fingerprint and colours every outcome', () => {
    expect(shortFingerprint('sha256:0f9e8d7c6b5a4f3e2d1c')).toBe('sha256:0f9e8');
    expect(shortFingerprint(null)).toBe('—');
    expect(outcomeColor('OK')).toBe('success');
    expect(outcomeColor('REFUSED')).toBe('error');
    expect(outcomeColor('DRY_RUN')).toBe('info');
    expect(outcomeColor('SOMETHING_NEW')).toBe('default');
  });
});
