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
import Models from '../src/pages/agents/Models';

class RO { observe() { /* noop */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || RO;

const ok = <T,>(data: T) => ({ success: true as const, data, meta: {} });
const perms = ['models.view', 'models.manage', 'agents.view'];
const user = { id: 'u1', name: 'AI Governance', email: 'aig@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'AIG', permissions: perms }, permissions: perms, perms };

/* Fictional figures shaped as the two services answer them. */
const registry = [
  { id: 'm1', key: 'inspection-targeting', name: 'Port state inspection targeting', nameAr: null, task: 'CLASSIFICATION', purpose: 'Scores an expected arrival.', purposeAr: null, owner: 'Maritime Safety', framework: 'gradient-boosted trees (ai-models)', residency: { region: 'AE', note: '' }, status: 'ACTIVE', currentVersion: 2, serving: { PROD: 2 } },
  { id: 'm2', key: 'document-extraction', name: 'Certificate and form extraction', nameAr: null, task: 'VISION', purpose: 'Reads a certificate.', purposeAr: null, owner: 'Registrar', framework: 'document-vision', residency: { region: 'AE', note: '' }, status: 'ACTIVE', currentVersion: 1, serving: { PROD: 1 } },
];
const metrics = { rows: 176, trained: 141, heldOut: 35, auc: 0.69, precision: 0, recall: 0, positiveRate: 0.171, precisionAtBaseRate: 0.5, lift: 2.917, confidence: 0.69, featureSet: 'history', importance: { shipAgeYears: 0.41, priorDeficiencies: 0.22, daysSinceLastInspection: 0.2, priorDetentions: 0.1, shipType: 0.05, homeFlag: 0.02 } };
const artefact = (version: number, m = metrics) => ({ id: `a${version}`, model: 'inspection-targeting', version, task: 'CLASSIFICATION', artifactRef: `ai-models://inspection-targeting/${version}`, framework: 'gradient-boosted trees (ai-models)', featureSet: m.featureSet, features: Object.keys(m.importance), schema: [], metrics: m, trees: 7, depth: 3, learningRate: 0.1, trainingRunId: `r${version}`, createdAt: '2026-09-07T08:00:00Z' });
const run = (version: number) => ({ id: `r${version}`, model: 'inspection-targeting', datasetId: 'd1', params: { rounds: 150, depth: 3, learningRate: 0.1, featureSet: 'history' }, metrics, status: 'SUCCEEDED', error: null, initiatedBy: 'seed', version, registryVersion: version, registryRunId: 'x', startedAt: '2026-09-07T08:00:00Z', finishedAt: '2026-09-07T08:00:01Z', durationMs: 412 });
const serverModel = {
  key: 'inspection-targeting', task: 'CLASSIFICATION', name: 'Port state inspection targeting', description: 'd', label: 'The inspection found a detention', unit: null,
  features: [{ name: 'shipAgeYears', kind: 'num', description: 'Years since built' }, { name: 'priorDeficiencies', kind: 'num', description: 'Earlier deficiencies' }, { name: 'daysSinceLastInspection', kind: 'num', description: 'Days since last boarding' }, { name: 'priorDetentions', kind: 'num', description: 'Earlier detentions' }, { name: 'shipType', kind: 'cat', description: 'Type' }, { name: 'homeFlag', kind: 'cat', description: 'Home flag' }],
  featureSets: [{ name: 'baseline', features: ['shipAgeYears'], note: 'First fit' }, { name: 'history', features: ['shipAgeYears', 'priorDeficiencies'], note: 'With history' }],
  artefacts: [artefact(2), artefact(1, { ...metrics, auc: 0.74, lift: 1.944, featureSet: 'baseline' })], latest: artefact(2), lastRun: run(2), runs: 2, served: { calls: 12, p50Ms: 3, p95Ms: 9, lastAt: '2026-09-07T09:00:00Z' }, defaults: { rounds: 150, depth: 3, learningRate: 0.1, minLeaf: 5, holdout: 0.2, seed: 7, patience: 20 },
};
const stats = { windowDays: 30, budgetMs: 5000, mode: 'stub', servers: { modelServer: 'http://127.0.0.1:5505', endpoint: null, fallback: 'stub' }, calls: 1682, breaches: 3, withinSlaPct: 99.8, latencyMs: { p50: 120, p95: 260, p99: 400, max: 5100 }, models: [] };
const registryDetail = { ...registry[0], versions: [
  { id: 'v2', version: 2, artifactRef: 'ai-models://inspection-targeting/2', framework: 'gbt', trainingRunId: 'r2', metrics: { auc: 0.69, lift: 2.917 }, params: {}, status: 'DEPLOYED', changeNote: 'Added the ship’s own history', createdBy: 'Data Science', validatedBy: 'Model Assurance', approvedBy: 'Platform Administrator', approvedAt: '2026-01-01T00:00:00Z', retiredAt: null, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  { id: 'v1', version: 1, artifactRef: 'ai-models://inspection-targeting/1', framework: 'gbt', trainingRunId: 'r1', metrics: { auc: 0.74, lift: 1.944 }, params: {}, status: 'RETIRED', changeNote: 'First fit', createdBy: 'Data Science', validatedBy: null, approvedBy: null, approvedAt: null, retiredAt: null, createdAt: '2025-10-01T00:00:00Z', updatedAt: '2025-10-01T00:00:00Z' },
], deployments: [{ id: 'd1', version: 2, environment: 'PROD', status: 'ACTIVE', endpoint: 'ai-models://inspection-targeting', replicas: 2, residencyRegion: 'AE', note: '', deployedBy: 'Platform Administrator', deployedAt: '2026-01-02T00:00:00Z', retiredAt: null }], trainingRuns: [], baselines: [] };
const serverDetail = { ...serverModel, runs: [run(2), run(1)], datasets: [{ id: 'd1', builtAt: '2026-09-07T08:00:00Z', rows: 176, positives: 30, labelMean: 0.17, labelStd: 0.38, note: 'history' }], minRows: 30 };

beforeAll(() => { store.dispatch(setSession({ user, token: 't', refreshToken: 'r' } as never)); });
afterEach(() => vi.restoreAllMocks());
const wrap = (ui: React.ReactNode) => render(<Provider store={store}><MemoryRouter initialEntries={['/agents/models']}><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

const mockGets = () => vi.spyOn(api, 'get').mockImplementation((url: string) => {
  if (url === '/ai-platform/models') return Promise.resolve(ok(registry) as never);
  if (url === '/ai-models') return Promise.resolve(ok([serverModel]) as never);
  if (url === '/ai-platform/serving/stats') return Promise.resolve(ok(stats) as never);
  if (url === '/ai-platform/models/inspection-targeting') return Promise.resolve(ok(registryDetail) as never);
  if (url === '/ai-models/inspection-targeting') return Promise.resolve(ok(serverDetail) as never);
  if (url === '/ai-models/inspection-targeting/dataset') return Promise.resolve(ok({ model: 'inspection-targeting', featureSet: 'history', features: [], rows: 177, positives: 31, labelMean: 0.175, labelStd: 0.38, schema: [{ name: 'shipAgeYears', kind: 'num', median: 12 }, { name: 'shipType', kind: 'cat', categories: ['BULK', 'CONT'] }], sample: [], builtAt: '2026-09-07T09:00:00Z', label: 'x', unit: null }) as never);
  if (url === '/ai-platform/models/document-extraction') return Promise.resolve(ok({ ...registry[1], versions: [], deployments: [{ id: 'd2', version: 1, environment: 'PROD', status: 'ACTIVE', endpoint: 'platform://vision', replicas: 1, residencyRegion: 'AE', note: '', deployedBy: null, deployedAt: '2026-01-02T00:00:00Z', retiredAt: null }], trainingRuns: [], baselines: [] }) as never);
  return Promise.reject(new Error(`unexpected GET ${url}`));
});

describe('models', () => {
  it('shows the registry and the fits side by side, opens a model, reads the dataset, and fits it again as a draft', async () => {
    mockGets();
    const posts: { url: string; body: unknown }[] = [];
    vi.spyOn(api, 'post').mockImplementation((url: string, body?: unknown) => {
      posts.push({ url, body });
      if (url === '/ai-models/inspection-targeting/train') return Promise.resolve(ok({ run: { ...run(3), initiatedBy: 'AI Governance', durationMs: 388 }, artefact: artefact(3, { ...metrics, auc: 0.72, lift: 2.5 }), dataset: { rows: 177, positives: 31, featureSet: 'history' }, registry: { ok: true, version: 3, status: 'DRAFT', trainingRunId: 'run-3', created: true } }) as never);
      if (url === '/ai-models/reconcile') return Promise.resolve(ok({ artefacts: 3, reported: 3, results: [] }) as never);
      return Promise.reject(new Error(`unexpected POST ${url}`));
    });
    wrap(<Models />);
    expect(await screen.findByTestId('model-row-inspection-targeting')).toBeTruthy();
    expect(screen.getByTestId('models-stat-registered').textContent).toContain('2');
    expect(screen.getByTestId('models-stat-fitted').textContent).toContain('1');
    expect(screen.getByTestId('models-stat-calls').textContent).toContain('1,682');
    const row = screen.getByTestId('model-row-inspection-targeting');
    expect(row.textContent).toContain('PROD · v2'); expect(row.textContent).toContain('AUC 0.69'); expect(row.textContent).toContain('2.9× lift'); expect(row.textContent).toContain('176');
    expect(screen.getByTestId('model-row-document-extraction').textContent).toContain('No fit on the model server');

    fireEvent.click(row);
    expect(await screen.findByTestId('model-detail')).toBeTruthy();
    const versions = screen.getByTestId('model-versions');
    expect(within(versions).getByText('Deployed')).toBeTruthy(); expect(within(versions).getByText('Retired')).toBeTruthy();
    expect(versions.textContent).toContain('approved by Platform Administrator'); expect(versions.textContent).toContain('ai-models://inspection-targeting');
    expect(screen.getByTestId('model-fit-headline').textContent).toContain('AUC 0.69');
    expect(screen.getByTestId('model-importance').textContent).toContain('shipAgeYears');
    expect(screen.getByTestId('model-runs').textContent).toContain('v2 in the registry');

    fireEvent.click(screen.getByTestId('model-preview-dataset'));
    expect((await screen.findByTestId('model-dataset-preview')).textContent).toContain('177 rows');

    fireEvent.click(screen.getByTestId('model-train'));
    fireEvent.change(screen.getByTestId('train-rounds'), { target: { value: '60' } });
    fireEvent.change(screen.getByTestId('train-note'), { target: { value: 'A shorter fit' } });
    fireEvent.click(screen.getByTestId('train-confirm'));
    await waitFor(() => expect(posts.some((p) => p.url === '/ai-models/inspection-targeting/train')).toBe(true));
    expect(posts.find((p) => p.url === '/ai-models/inspection-targeting/train')!.body).toEqual({ note: 'A shorter fit', featureSet: 'history', rounds: 60 });
    const outcome = await screen.findByTestId('model-train-outcome');
    expect(outcome.textContent).toContain('v3'); expect(outcome.textContent).toContain('AUC 0.72'); expect(outcome.textContent).toContain('DRAFT');

    fireEvent.click(screen.getByTestId('models-reconcile'));
    await waitFor(() => expect(posts.some((p) => p.url === '/ai-models/reconcile')).toBe(true));
  });
  it('says when a model runs on the platform’s own pipeline and has no fit to show', async () => {
    mockGets();
    wrap(<Models />);
    fireEvent.click(await screen.findByTestId('model-row-document-extraction'));
    expect(await screen.findByTestId('model-detail')).toBeTruthy();
    expect(screen.getByText(/runs on the platform’s own pipeline/)).toBeTruthy();
    expect(screen.queryByTestId('model-train')).toBeNull();
  });
});
