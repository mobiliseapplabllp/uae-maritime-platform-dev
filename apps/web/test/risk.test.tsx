import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { store } from '../src/store';
import { setSession } from '../src/store/authSlice';
import { buildTheme } from '../src/theme';
import api from '../src/api/client';
import RiskRegister from '../src/pages/risk/RiskRegister';
import TargetingPage from '../src/pages/risk/TargetingPage';
import type { RiskScoreRow, TargetingRow } from '../src/pages/risk/types';

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Marine Surveyor', email: 'surveyor@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
const wrap = (ui: React.ReactNode) => render(<Provider store={store}><MemoryRouter><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

const weights = { age: 20, certificates: 20, deficiencies: 15, detentions: 20, inspectionGap: 10, agentPerformance: 15 };
// Fictional ships; the scores are what the engine would return, factors sorted by points.
const rows: RiskScoreRow[] = [
  { vesselId: 'v1', name: 'MV Coral Reach', imo: '9000001', type: 'CONT', flag: 'Panama', built: 2004, score: 72, band: 'HIGH', factors: [
    { key: 'age', label: 'Vessel age', points: 20, max: 20, evidence: '22 years (built 2004)' },
    { key: 'certificates', label: 'Statutory certificates', points: 10, max: 20, evidence: '1 expiring ≤30d' },
  ] },
  { vesselId: 'v2', name: 'MV Amber Dune', imo: '9000002', type: 'BULK', flag: 'Liberia', built: 2018, score: 18, band: 'LOW', factors: [
    { key: 'age', label: 'Vessel age', points: 2, max: 20, evidence: '8 years (built 2018)' },
  ] },
];
const targets: TargetingRow[] = [
  { callId: 'c1', vcn: 'VCN-2026-0001', status: 'AT_ANCHORAGE', eta: '2026-09-02T10:00:00Z', berth: null, vessel: 'MV Coral Reach', vesselId: 'v1', risk: rows[0] },
  { callId: 'c2', vcn: 'VCN-2026-0002', status: 'BERTHED', eta: '2026-09-01T04:00:00Z', berth: 'CT-1', vessel: 'MV Amber Dune', vesselId: 'v2', risk: rows[1] },
];

describe('Risk pages', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('renders the risk register, expands a factor decomposition and opens the weights drawer', async () => {
    mockGet({ '/risk/scores': ok(rows, { weights, computedAt: '2026-09-02T08:00:00Z' }), '/stats/risk': ok({ cards: [] }) });
    wrap(<RiskRegister />);
    expect(await screen.findByText('MV Coral Reach')).toBeInTheDocument();
    expect(screen.getByText('Vessel risk register')).toBeInTheDocument();
    expect(screen.getByText('High')).toBeInTheDocument();
    expect(screen.getByText('Low')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Expand MV Coral Reach' }));
    expect(await screen.findByText('22 years (built 2004)')).toBeInTheDocument();
    expect(screen.getByText('20/20')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Model weights' }));
    expect(await screen.findByText('Risk model weights')).toBeInTheDocument();
    expect(screen.getAllByRole('slider')).toHaveLength(6);
    expect(screen.getByText('Agent fleet record')).toBeInTheDocument();
  });

  it('renders the targeting list ordered as served, with berth or ETA and the primary driver', async () => {
    mockGet({ '/risk/targeting': ok(targets, { computedAt: '2026-09-02T08:00:00Z' }) });
    wrap(<TargetingPage />);
    expect(await screen.findByText('MV Coral Reach')).toBeInTheDocument();
    expect(screen.getByText('PSC targeting list')).toBeInTheDocument();
    expect(screen.getByText('01')).toBeInTheDocument();
    expect(screen.getByText('At anchorage')).toBeInTheDocument();
    expect(screen.getByText('Berth CT-1')).toBeInTheDocument();
    expect(screen.getByText('Vessel age — 22 years (built 2004)')).toBeInTheDocument();
  });
});
