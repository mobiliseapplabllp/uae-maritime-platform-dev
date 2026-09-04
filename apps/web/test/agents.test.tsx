import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import '../src/i18n';
import { store } from '../src/store';
import { setSession } from '../src/store/authSlice';
import { setLang } from '../src/store/uiSlice';
import { buildTheme } from '../src/theme';
import api from '../src/api/client';
import AgentOperations from '../src/pages/agents/AgentOperations';
import DecisionRegister from '../src/pages/agents/DecisionRegister';
import EscalationQueue from '../src/pages/agents/EscalationQueue';
import Assurance from '../src/pages/agents/Assurance';
import { escalationText, escalationMeta, isRunnable, raisesAutonomy, runSummary, dispositionMeta, pctText } from '../src/pages/agents/constants';
import type {
  Agent, AgentDashboardData, AgentRow, AiDecision, AiDecisionDetail, BiasData, CoverageData, DriftData, ServiceLevelData,
} from '../src/pages/agents/types';

// recharts measures its container with ResizeObserver, which jsdom does not ship
class RO { observe() { /* noop */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || RO;

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Registrar of Ships', email: 'registrar@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
const wrap = (ui: React.ReactNode) => render(<Provider store={store}><MemoryRouter><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

/* Every agent, decision, ship and officer below is fictional; the profile is the UAE default. */
const stats = (over: Partial<AgentRow['stats']> = {}) => ({ decisions: 0, autoApplied: 0, escalated: 0, awaitingReview: 0, overridden: 0, approved: 0, avgConfidence: 0, lastRunAt: null, ...over });
const agentBase = {
  nameAr: null, descriptionAr: null, domain: 0, mandated: false, trigger: { kind: 'SCHEDULE', subjects: [], cron: '0 3 * * *', cadence: 'DAILY' },
  schedule: { cadence: 'DAILY', cron: '0 3 * * *', timezone: 'Asia/Dubai' }, requiresConfirmation: false, maxActionsPerHour: 50, escalateTo: '',
  suspended: false, suspendedReason: '', suspendedBy: '', suspendedAt: null, lastRunAt: null, createdAt: null, updatedAt: null,
};
const roster: AgentRow[] = [
  {
    ...agentBase, id: 'ag1', agentId: 'a2_vessel_compliance', name: 'Vessel Compliance Scoring', role: 'Rescores a ship against her certificates',
    description: 'Rescores a ship against her certificates, her inspections and her detentions.', domain: 2, mandated: true,
    enabled: true, autonomyLevel: 'ASSISTED', confidenceThreshold: 0.8, requiresConfirmation: true, maxActionsPerHour: 40, escalateTo: 'Registrar of Ships',
    lastRunAt: '2026-09-02T05:00:00Z', stats: stats({ decisions: 42, autoApplied: 30, escalated: 8, awaitingReview: 4, overridden: 3, approved: 12, avgConfidence: 0.86, lastRunAt: '2026-09-02T05:00:00Z' }), agreementRate: 80,
  },
  {
    ...agentBase, id: 'ag2', agentId: 'a5_smart_inspection', name: 'Smart Inspection Targeting', role: 'Selects ships for boarding from composite risk',
    description: 'Selects ships for boarding and hands the boarding party a dossier.', domain: 5, mandated: true,
    enabled: true, autonomyLevel: 'SUPERVISED', confidenceThreshold: 0.75, requiresConfirmation: true, maxActionsPerHour: 20, escalateTo: 'Port State Control',
    suspended: true, suspendedReason: 'Targeting skewed towards one class society', suspendedBy: 'Registrar of Ships', suspendedAt: '2026-08-30T09:00:00Z',
    stats: stats({ decisions: 18, escalated: 18, awaitingReview: 6, overridden: 2, approved: 6, avgConfidence: 0.7 }), agreementRate: 75,
  },
  {
    ...agentBase, id: 'ag3', agentId: 'sentinel', name: 'Berth Sentinel', role: 'Watches waiting time and berth occupancy',
    description: 'Flags a sustained departure from the berth-occupancy baseline.', enabled: true, autonomyLevel: 'AUTONOMOUS', confidenceThreshold: 0.6,
    stats: stats({ decisions: 9, autoApplied: 9, avgConfidence: 0.91 }), agreementRate: null,
  },
];
const dashboard: AgentDashboardData = {
  agents: 3, active: 2, suspended: 1,
  byLevel: [{ level: 'SUPERVISED', count: 1 }, { level: 'ASSISTED', count: 1 }, { level: 'AUTONOMOUS', count: 1 }],
  decisions: 69, decisions30d: 21, autoAppliedPct: 57, pendingReview: 10, agreementRate: 78.3, avgConfidence: 0.83,
  perAgent: roster.map((a) => ({
    agentId: a.agentId, name: a.name, autonomyLevel: a.autonomyLevel, suspended: a.suspended, decisions: a.stats.decisions,
    autoApplied: a.stats.autoApplied, escalated: a.stats.escalated, awaitingReview: a.stats.awaitingReview, overridden: a.stats.overridden,
    pending: a.stats.awaitingReview, avgConfidence: a.stats.avgConfidence, agreementRate: a.agreementRate,
  })),
};
const decisionBase = {
  entityType: 'Vessel', entityId: 'v1', entityLabel: 'MV Coral Reach', inputs: { imo: '9000001' }, output: { band: 'HIGH' },
  reviewedById: null, reviewedBy: '', reviewedAt: null, overrideReason: '', supersedesId: null, superseded: false,
  modelKey: 'platform-local', modelVersion: '2026-09', latencyMs: 42, cohort: { flag: 'Panama', vesselType: 'CONT' }, createdAt: null,
};
const decisions: AiDecision[] = [
  {
    ...decisionBase, id: 'd1', agentId: 'a2_vessel_compliance', agentName: 'Vessel Compliance Scoring', action: 'Compliance score refreshed', effect: 'REVERSIBLE',
    subjectType: 'Vessel', subjectId: 'v1', subjectLabel: 'MV Coral Reach', explanation: 'Every statutory certificate is in force and no deficiency is outstanding.',
    factors: [{ factor: 'Certificates in force', weight: 0.4, value: '8 of 8', contribution: 0.4 }, { factor: 'Detentions in 36 months', weight: 0.3, value: 0, contribution: 0.3 }],
    confidence: 0.94, autonomyLevel: 'ASSISTED', threshold: 0.8, disposition: 'AUTO_APPLIED', reviewStatus: 'AUTO', escalationCode: null, escalationReason: '', applied: true,
    at: '2026-09-02T05:04:00Z',
  },
  {
    ...decisionBase, id: 'd2', agentId: 'a5_smart_inspection', agentName: 'Smart Inspection Targeting', action: 'Board on arrival', effect: 'REVERSIBLE',
    subjectType: 'PortCall', subjectId: 'pc2', subjectLabel: 'VCN-2026-0002 · MV Amber Dune', explanation: 'Composite risk in the top band and 14 months since the last boarding.',
    factors: [{ factor: 'Months since last inspection', weight: 0.5, value: 14, contribution: 0.5 }],
    confidence: 0.62, autonomyLevel: 'SUPERVISED', threshold: 0.75, disposition: 'ESCALATED', reviewStatus: 'PENDING',
    escalationCode: 'BELOW_THRESHOLD', escalationReason: 'Confidence 62% is below the 75% threshold set for Smart Inspection Targeting', applied: false,
    at: '2026-08-29T07:30:00Z',
  },
  {
    ...decisionBase, id: 'd3', agentId: 'a2_vessel_compliance', agentName: 'Vessel Compliance Scoring', action: 'Suspend certificate endorsement', effect: 'IRREVERSIBLE',
    subjectType: 'Vessel', subjectId: 'v3', subjectLabel: 'MV Sable Wind', explanation: 'The survey window closed without an endorsement.',
    factors: [{ factor: 'Days past survey window', weight: 0.6, value: 21, contribution: 0.6 }],
    confidence: 0.9, autonomyLevel: 'ASSISTED', threshold: 0.8, disposition: 'AWAITING_REVIEW', reviewStatus: 'PENDING',
    escalationCode: 'IRREVERSIBLE_EFFECT', escalationReason: 'The effect cannot be undone, so it is put to a human whatever the confidence', applied: false,
    at: '2026-08-28T11:15:00Z',
  },
];
const detail: AiDecisionDetail = { ...decisions[1], factorTotal: 0.5, review: null, supersedes: null, openForReview: true };
const agentDetail: Agent = { ...roster[0], runnable: true, recentDecisions: [decisions[0]], changes: [{ field: 'autonomyLevel', from: 'SUPERVISED', to: 'ASSISTED', at: '2026-08-01T08:00:00Z', by: 'Registrar of Ships', byId: 'u1', reason: 'Six months of reviewed decisions at 90% agreement' }] };

const drift: DriftData = {
  windowDays: 30, bucketDays: 7, from: '2026-08-04T00:00:00Z', to: '2026-09-03T00:00:00Z', decisions: 60, drifting: ['a5_smart_inspection'],
  perAgent: [
    {
      agentId: 'a5_smart_inspection', name: 'Smart Inspection Targeting', autonomyLevel: 'SUPERVISED', suspended: true, decisions: 18, reviewed: 8,
      agreementRate: 62.5, avgConfidence: 0.7, baselineAgreement: 88, latestAgreement: 60, agreementDelta: -28, drifting: true,
      buckets: [
        { from: '2026-08-04T00:00:00Z', to: '2026-08-11T00:00:00Z', decisions: 6, reviewed: 3, overridden: 0, agreementRate: 100, avgConfidence: 0.78, escalationRate: 50 },
        { from: '2026-08-25T00:00:00Z', to: '2026-09-01T00:00:00Z', decisions: 7, reviewed: 5, overridden: 2, agreementRate: 60, avgConfidence: 0.7, escalationRate: 71.4 },
      ],
      confidence: [{ band: '0.6–0.7', from: 0.6, to: 0.7, decisions: 11, share: 61.1, agreementRate: 55 }, { band: '0.7–0.8', from: 0.7, to: 0.8, decisions: 7, share: 38.9, agreementRate: 80 }],
    },
    {
      agentId: 'sentinel', name: 'Berth Sentinel', autonomyLevel: 'AUTONOMOUS', suspended: false, decisions: 0, reviewed: 0,
      agreementRate: null, avgConfidence: 0, baselineAgreement: null, latestAgreement: null, agreementDelta: null, drifting: false, buckets: [], confidence: [],
    },
  ],
};
const bias: BiasData = {
  agentId: null, minCohort: 5, flagDeltaPct: 20, decisions: 69, flagged: 1,
  dimensions: [
    {
      dimension: 'classSociety', decisions: 40, populationEscalationRate: 30, populationOverrideRate: 12,
      cohorts: [
        { value: 'Gulf Register (sample)', decisions: 22, escalationRate: 62, overrideRate: 20, autoAppliedRate: 38, avgConfidence: 0.71, escalationDelta: 32, overrideDelta: 8, sufficient: true, flagged: true },
        { value: 'Northern Bureau (sample)', decisions: 3, escalationRate: 33, overrideRate: null, autoAppliedRate: 67, avgConfidence: 0.88, escalationDelta: 3, overrideDelta: null, sufficient: false, flagged: false },
      ],
      flagged: ['Gulf Register (sample)'],
    },
    { dimension: 'flag', decisions: 0, populationEscalationRate: 30, populationOverrideRate: 12, cohorts: [], flagged: [] },
  ],
};
const levels: ServiceLevelData = {
  agentId: null, windowDays: 30, from: '2026-08-04T00:00:00Z', to: '2026-09-03T00:00:00Z',
  decisions: 60, reviewed: 24, escalated: 22, highRiskCalls: 14, highRiskReviewed: 10, falsePositives: 3,
  metrics: [
    { key: 'agreement', label: 'Agreement with reviewers', value: 79.2, target: 85, unit: '%', meets: false },
    { key: 'falsePositiveHighRisk', label: 'False-positive rate — high-risk vessel scoring', value: 30, target: 15, unit: '%', meets: false },
    { key: 'escalation', label: 'Decisions escalated to a human', value: 36.7, target: null, unit: '%', meets: null },
    { key: 'avgConfidence', label: 'Mean confidence', value: 0.83, target: null, unit: 'ratio', meets: null },
  ],
};

const adoption: CoverageData = {
  windowDays: 90, from: '2026-06-06T00:00:00Z', to: '2026-09-04T00:00:00Z',
  services: 5, covered: 2, serviceRate: 40,
  autonomousServices: 1, autonomousRate: 20,
  requests: 10, requestsTouched: 3, requestRate: 30,
  withoutRequests: 1,
  target: {
    start: '2026-01-01T00:00:00Z', end: '2028-01-01T00:00:00Z', monthsElapsed: 8.1,
    required: 60.1, startTarget: 50, endTarget: 80, meets: false, servicesToRequired: 2, servicesToEndTarget: 2,
  },
  byDomain: [
    { domain: 1, services: 3, covered: 2, rate: 66.7, requests: 8, touched: 3 },
    { domain: 4, services: 2, covered: 0, rate: 0, requests: 2, touched: 0 },
  ],
  rows: [
    { code: 'REG-PROVISIONAL', name: 'Provisional registration of a ship', nameAr: 'التسجيل المؤقت للسفينة', domain: 1, requests: 5, touched: 2, decisions: 4, autonomous: 2, agents: ['a1_document_intelligence'], lastAt: '2026-09-03T09:00:00Z', covered: true },
    { code: 'SEAFARER-CRA', name: 'Certificate of Receipt of Application', domain: 1, requests: 3, touched: 1, decisions: 1, autonomous: 0, agents: ['a3_service_processing'], lastAt: '2026-09-01T09:00:00Z', covered: true },
    { code: 'NMC-ALERT-REVIEW', name: 'Navigational alert review', domain: 4, requests: 2, touched: 0, decisions: 0, autonomous: 0, agents: [], lastAt: null, covered: false },
    { code: 'PORT-WAIVER', name: 'Port dues waiver', domain: 1, requests: 0, touched: 0, decisions: 0, autonomous: 0, agents: [], lastAt: null, covered: false },
    { code: 'NMC-DRILL', name: 'Contingency drill notification', domain: 4, requests: 0, touched: 0, decisions: 0, autonomous: 0, agents: [], lastAt: null, covered: false },
  ],
};

describe('Agent operations — the roster', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('shows the console header and every agent with its latitude and recent activity', async () => {
    mockGet({ '/agents': ok(roster), '/agents/dashboard': ok(dashboard) });
    wrap(<AgentOperations />);
    expect(await screen.findByText('Vessel Compliance Scoring')).toBeInTheDocument();
    expect(screen.getByText('Agent operations')).toBeInTheDocument();
    expect(screen.getByText('Agents registered')).toBeInTheDocument();
    expect(screen.getByText('2 active · 1 suspended')).toBeInTheDocument();
    expect(screen.getByText('21 in the last 30 days')).toBeInTheDocument();
    expect(screen.getByText('78%')).toBeInTheDocument();
    // level, mandate, trigger, confirmation and the suspension are all on the card
    expect(screen.getAllByText('Assisted')).toHaveLength(2); // the level stat card and the agent's own chip
    expect(screen.getAllByText('Mandated')).toHaveLength(2);
    expect(screen.getAllByText('Confirms first')).toHaveLength(2);
    expect(screen.getByText('Suspended')).toBeInTheDocument();
    expect(screen.getByText('threshold 0.80 · max 40/h · escalates to Registrar of Ships')).toBeInTheDocument();
    expect(screen.getAllByText('Has not run yet')).toHaveLength(2);
    expect(screen.getByText('3 agents')).toBeInTheDocument();
    expect(screen.getByText('Agent performance')).toBeInTheDocument();
  });

  it('filters the roster by autonomy level and searches it', async () => {
    const get = mockGet({ '/agents': ok(roster), '/agents/dashboard': ok(dashboard) });
    wrap(<AgentOperations />);
    await screen.findByText('Vessel Compliance Scoring');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Autonomy' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Autonomous' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/agents', { params: { level: 'AUTONOMOUS' } }));
    const search = screen.getByLabelText('Search name, key or role…');
    fireEvent.change(search, { target: { value: 'sentinel' } });
    fireEvent.keyDown(search, { key: 'Enter' });
    await waitFor(() => expect(get).toHaveBeenCalledWith('/agents', { params: { level: 'AUTONOMOUS', q: 'sentinel' } }));
  });

  it('opens an agent with its governance history, recent decisions and a manual run', async () => {
    mockGet({ '/agents': ok(roster), '/agents/dashboard': ok(dashboard), '/agents/a2_vessel_compliance': ok(agentDetail) });
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({ ran: 'Vessel Compliance Scoring', agentId: 'a2_vessel_compliance', recorded: 3, applied: 2, escalated: 1, byDisposition: { AUTO_APPLIED: 2, ESCALATED: 1 }, decisions: [] }) as never);
    wrap(<AgentOperations />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Vessel Compliance Scoring' }));
    expect(await screen.findByText('Governance history')).toBeInTheDocument();
    expect(screen.getByText((_, el) => {
      const s = el?.textContent || '';
      return el?.tagName === 'P' && s.startsWith('Autonomy level SUPERVISED → ASSISTED') && s.includes('Registrar of Ships — “Six months of reviewed decisions at 90% agreement”');
    })).toBeInTheDocument();
    expect(screen.getByText('Recent decisions (1)')).toBeInTheDocument();
    expect(screen.getByText('Compliance score refreshed')).toBeInTheDocument();
    expect(screen.getByText('Certificates in force')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/agents/a2_vessel_compliance/run', {}));
    expect(await screen.findByText('Vessel Compliance Scoring ran over live records — 3 decision(s) recorded (2 auto applied, 1 escalated).')).toBeInTheDocument();
  });

  it('refuses to suspend an agent without a written reason', async () => {
    mockGet({ '/agents': ok(roster), '/agents/dashboard': ok(dashboard), '/agents/a2_vessel_compliance': ok(agentDetail) });
    const post = vi.spyOn(api, 'post');
    wrap(<AgentOperations />);
    fireEvent.click(await screen.findByRole('button', { name: 'Open Vessel Compliance Scoring' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Suspend agent' }));
    expect(await screen.findByText('Suspending an agent requires a written reason.')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });
});

describe('The decision register', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('lists decisions with disposition, confidence, review state and the reason they were not applied', async () => {
    mockGet({ '/agents': ok(roster), '/agents/decisions': ok(decisions, { total: 3, page: 1, limit: 20 }) });
    wrap(<DecisionRegister />);
    expect(await screen.findByText('Compliance score refreshed')).toBeInTheDocument();
    expect(screen.getByText('AI decision register')).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Applied automatically')).toBeInTheDocument();
    expect(within(table).getByText('Escalated')).toBeInTheDocument();
    expect(within(table).getByText('Awaiting review')).toBeInTheDocument();
    expect(within(table).getByText('0.62')).toBeInTheDocument();
    expect(within(table).getByText('No review needed')).toBeInTheDocument();
    expect(within(table).getAllByText('With a human')).toHaveLength(2);
    // the refusal codes read as sentences, never as raw enums
    expect(within(table).getByText('Below its threshold')).toBeInTheDocument();
    expect(within(table).getByText('Effect cannot be undone')).toBeInTheDocument();
    expect(within(table).queryByText('BELOW_THRESHOLD')).not.toBeInTheDocument();
  });

  it('applies the full filter set the register offers', async () => {
    const get = mockGet({ '/agents': ok(roster), '/agents/decisions': ok(decisions, { total: 3, page: 1, limit: 20 }) });
    wrap(<DecisionRegister />);
    await screen.findByText('Compliance score refreshed');

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Agent' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Smart Inspection Targeting' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/agents/decisions', { params: { page: 1, limit: 20, sort: '-at', q: undefined, agentId: 'a5_smart_inspection' } }));

    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Outcome' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Escalated' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/agents/decisions', { params: { page: 1, limit: 20, sort: '-at', q: undefined, agentId: 'a5_smart_inspection', disposition: 'ESCALATED' } }));

    fireEvent.click(screen.getByRole('button', { name: /More filters/ }));
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: 'Why not applied' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Below its threshold' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/agents/decisions', { params: { page: 1, limit: 20, sort: '-at', q: undefined, agentId: 'a5_smart_inspection', disposition: 'ESCALATED', escalationCode: 'BELOW_THRESHOLD' } }));

    fireEvent.change(screen.getByLabelText('Min confidence'), { target: { value: '0.5' } });
    await waitFor(() => expect(get).toHaveBeenCalledWith('/agents/decisions', expect.objectContaining({ params: expect.objectContaining({ minConfidence: '0.5' }) })));
    fireEvent.click(screen.getByLabelText('Awaiting a human'));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/agents/decisions', expect.objectContaining({ params: expect.objectContaining({ pending: 'true' }) })));
  });

  it('opens a decision, explains the refusal and overturns it with a reason on the record', async () => {
    mockGet({ '/agents': ok(roster), '/agents/decisions': ok(decisions, { total: 3, page: 1, limit: 20 }), '/agents/decisions/d2': ok(detail) });
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({ id: 'd4' }) as never);
    wrap(<DecisionRegister />);
    fireEvent.click(await screen.findByText('Board on arrival'));
    expect(await screen.findByText('What it was given, and what it produced')).toBeInTheDocument();
    expect(screen.getAllByText('Below its threshold').length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Confidence 62% is below the 75% threshold set for Smart Inspection Targeting/).length).toBeGreaterThan(0);
    expect(screen.getByText('Months since last inspection')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Overturn' }));
    expect(await screen.findByText('Overturning a decision requires a reason on the record.')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Reason — recorded against the decision'), { target: { value: 'Boarded last week under a joint inspection' } });
    fireEvent.click(screen.getByRole('button', { name: 'Overturn' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/agents/decisions/d2/review', { accept: false, reason: 'Boarded last week under a joint inspection' }));
  });
});

describe('The escalation queue', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('groups what is waiting by the rule that refused it, oldest first', async () => {
    const queue = [decisions[2], decisions[1]];
    const get = mockGet({
      '/agents': ok(roster),
      '/agents/decisions/escalations': ok(queue, {
        page: 1, limit: 25, total: 2, oldest: decisions[2].at,
        byCode: [{ code: 'IRREVERSIBLE_EFFECT', decisions: 1 }, { code: 'BELOW_THRESHOLD', decisions: 1 }],
        byAgent: [{ agentId: 'a2_vessel_compliance', name: 'Vessel Compliance Scoring', decisions: 1, oldest: decisions[2].at }],
      }),
    });
    wrap(<EscalationQueue />);
    expect(await screen.findByText('Suspend certificate endorsement')).toBeInTheDocument();
    expect(screen.getByText('Escalation queue')).toBeInTheDocument();
    expect(screen.getByText('Awaiting a human')).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Effect cannot be undone' })).toBeInTheDocument();
    expect(screen.getByRole('table', { name: 'Below its threshold' })).toBeInTheDocument();
    expect(screen.getByText('The action could not have been reversed, so it is put to a human at any level and at any confidence.')).toBeInTheDocument();
    await waitFor(() => expect(get).toHaveBeenCalledWith('/agents/decisions/escalations', { params: { page: 1, limit: 25, sort: 'at' } }));
    fireEvent.click(screen.getByText('Below its threshold · 1'));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/agents/decisions/escalations', { params: { page: 1, limit: 25, sort: 'at', escalationCode: 'BELOW_THRESHOLD' } }));
  });
});

describe('Assurance — drift, bias and the service levels', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  const routes = {
    '/agents': ok(roster), '/agents/monitoring/drift': ok(drift), '/agents/monitoring/bias': ok(bias), '/agents/monitoring/metrics': ok(levels),
    '/agents/coverage': ok(adoption),
  };

  it('names the drifting agents and draws the rolling accuracy and confidence distribution', async () => {
    mockGet(routes);
    wrap(<Assurance />);
    expect(await screen.findByText(/1 agent\(s\) agreeing with reviewers materially less often than before: Smart Inspection Targeting/)).toBeInTheDocument();
    expect(screen.getByText('Assurance')).toBeInTheDocument();
    expect(screen.getByText('Supervised · 18 decisions, 8 reviewed')).toBeInTheDocument();
    expect(screen.getByText('Agreement 63%')).toBeInTheDocument();
    expect(screen.getByText('-28 points against baseline')).toBeInTheDocument();
    expect(screen.getByText('Where its confidence actually sits')).toBeInTheDocument();
    // an agent with no decisions in the window is not charted at all
    expect(screen.queryByText('Berth Sentinel')).not.toBeInTheDocument();
  });

  it('shows the bias audit across cohorts and never calls a small cohort biased', async () => {
    mockGet(routes);
    wrap(<Assurance />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Bias audit (1 flagged)' }));
    expect(await screen.findByText('Class society')).toBeInTheDocument();
    expect(screen.getByText('1 cohort(s) depart from the population by more than 20 points and warrant a human audit.')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Class society' });
    expect(within(table).getByText('Gulf Register (sample)')).toBeInTheDocument();
    expect(within(table).getByText('+32')).toBeInTheDocument();
    expect(within(table).getByText('Audit')).toBeInTheDocument();
    expect(within(table).getByText('Human audit')).toBeInTheDocument();
    expect(within(table).getByText('Too small to say')).toBeInTheDocument();
    // a dimension no record carries is not given an empty table
    expect(screen.queryByText('Flag state')).not.toBeInTheDocument();
  });

  it('measures each service level against its target, including the high-risk false-positive ceiling', async () => {
    mockGet(routes);
    wrap(<Assurance />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Service levels' }));
    expect(await screen.findByText('False-positive rate — high-risk vessel scoring')).toBeInTheDocument();
    expect(screen.getByText('ceiling 15%')).toBeInTheDocument();
    expect(screen.getByText('target 85%')).toBeInTheDocument();
    expect(screen.getAllByText('Below target')).toHaveLength(2);
    expect(screen.getByText('High-risk vessel scoring')).toBeInTheDocument();
    expect(screen.getByText('Reviewed by a human')).toBeInTheDocument();
    expect(screen.getByText(/Calls nobody reviewed are excluded rather than assumed correct/)).toBeInTheDocument();
  });

  it('states the agentic service rate against the rate the directive owes today', async () => {
    mockGet(routes);
    wrap(<Assurance />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Adoption' }));
    expect(await screen.findByText('40%')).toBeInTheDocument();            // the rate held
    expect(screen.getAllByText('owed today 60.1%').length).toBeGreaterThan(0);
    expect(screen.getByText(/Below the rate owed/)).toBeInTheDocument();
    expect(screen.getByText(/2 more services to stand at the rate owed today/)).toBeInTheDocument();
    expect(screen.getByText('Agentic service rate')).toBeInTheDocument();
    expect(screen.getByText('2 / 5')).toBeInTheDocument();
  });

  it('shows breadth beside depth, so wide and shallow cannot pass for wide and deep', async () => {
    mockGet(routes);
    wrap(<Assurance />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Adoption' }));
    expect(await screen.findByText('30%')).toBeInTheDocument();            // applications reached
    expect(screen.getByText('Applications an agent reached')).toBeInTheDocument();
    expect(screen.getByText('3 / 10')).toBeInTheDocument();
    expect(screen.getByText('20%')).toBeInTheDocument();                   // completed without a human
    expect(screen.getByText('1 / 5')).toBeInTheDocument();
    expect(screen.getByText(/Wide and shallow is a real state/)).toBeInTheDocument();
  });

  it('names the whole catalogue as the denominator, including the services nobody applied for', async () => {
    mockGet(routes);
    wrap(<Assurance />);
    fireEvent.click(await screen.findByRole('tab', { name: 'Adoption' }));
    expect(await screen.findByText(/5 services — including 1 that received no application/)).toBeInTheDocument();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Provisional registration of a ship')).toBeInTheDocument();
    // the three states are distinguished: covered, applied for but untouched, and never applied for
    expect(within(table).getAllByText('Covered')).toHaveLength(2);
    expect(within(table).getByText('Not covered')).toBeInTheDocument();
    expect(within(table).getAllByText('No applications')).toHaveLength(2);
  });

  it('names each service in the reader\'s own language', async () => {
    // the language switch that changes i18next lives in App, which this harness does not mount; the row name
    // is read from the store, which is the part under test here
    mockGet(routes);
    store.dispatch(setLang('ar'));
    try {
      wrap(<Assurance />);
      fireEvent.click(await screen.findByRole('tab', { name: 'Adoption' }));
      const table = await screen.findByRole('table');
      expect(within(table).getByText('التسجيل المؤقت للسفينة')).toBeInTheDocument();
      expect(within(table).queryByText('Provisional registration of a ship')).not.toBeInTheDocument();
      // a service the catalogue holds in English only keeps its English name rather than showing nothing
      expect(within(table).getByText('Certificate of Receipt of Application')).toBeInTheDocument();
    } finally {
      store.dispatch(setLang('en'));
    }
  });

  it('does not narrow adoption to one agent, because coverage is a property of the catalogue', async () => {
    const get = mockGet(routes);
    wrap(<Assurance />);
    await screen.findByText('Assurance');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Agent' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Berth Sentinel' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/agents/monitoring/drift', { params: { agentId: 'sentinel' } }));
    // every coverage call is unfiltered: one agent's share of the catalogue is not the adoption rate
    const coverageCalls = get.mock.calls.filter((c: unknown[]) => c[0] === '/agents/coverage');
    expect(coverageCalls.length).toBeGreaterThan(0);
    for (const c of coverageCalls) expect(c[1]).toBeUndefined();
  });

  it('narrows every assurance report to one agent', async () => {
    const get = mockGet(routes);
    wrap(<Assurance />);
    await screen.findByText('Assurance');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Agent' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Berth Sentinel' }));
    await waitFor(() => expect(get).toHaveBeenCalledWith('/agents/monitoring/drift', { params: { agentId: 'sentinel' } }));
    expect(get).toHaveBeenCalledWith('/agents/monitoring/bias', { params: { agentId: 'sentinel' } });
    expect(get).toHaveBeenCalledWith('/agents/monitoring/metrics', { params: { agentId: 'sentinel' } });
  });
});

describe('console wording', () => {
  it('turns every refusal code into a sentence and keeps the service wording when it gave one', () => {
    expect(escalationMeta('RATE_LIMIT').label).toBe('Hourly ceiling reached');
    expect(escalationText('CONFIRMATION_REQUIRED')).toMatch(/an officer confirms the conclusion/);
    expect(escalationText('BELOW_FLOOR', 'Confidence 40% is below the platform floor of 50%')).toBe('Confidence 40% is below the platform floor of 50%');
    expect(escalationMeta(null).label).toBe('Not escalated');
    expect(escalationMeta('SOMETHING_NEW').label).toBe('something new');
  });
  it('knows which changes widen an agent and which agents may be run by hand', () => {
    expect(raisesAutonomy('SUPERVISED', 'AUTONOMOUS')).toBe(true);
    expect(raisesAutonomy('AUTONOMOUS', 'SUPERVISED')).toBe(false);
    expect(isRunnable('a5_smart_inspection')).toBe(true);
    expect(isRunnable('sentinel')).toBe(false);
  });
  it('reports a rate the service could not compute as unknown, not as zero', () => {
    expect(pctText(null)).toBe('—');
    expect(pctText(0)).toBe('0%');
    expect(pctText(78.34)).toBe('78.3%');
    expect(dispositionMeta('OVERRIDDEN', true).label).toBe('Overturned');
    expect(runSummary({ ran: 'Berth Sentinel', agentId: 'sentinel', recorded: 0, applied: 0, escalated: 0, byDisposition: {}, decisions: [] }))
      .toBe('Berth Sentinel ran over live records — 0 decision(s) recorded.');
  });
});
