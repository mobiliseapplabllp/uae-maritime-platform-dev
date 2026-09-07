import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import '../src/i18n';
import { store } from '../src/store';
import { setSession } from '../src/store/authSlice';
import { buildTheme } from '../src/theme';
import api from '../src/api/client';

// the map is Leaflet on a real canvas; the page is tested around it
vi.mock('../src/pages/nmc/analytics/DensityMap', () => ({ default: ({ data }: { data: { cells: unknown[] } | null }) => <div data-testid="analytics-map">{data?.cells.length ?? 0} cells</div> }));
import TrafficAnalytics from '../src/pages/nmc/TrafficAnalytics';

class RO { observe() { /* noop */ } unobserve() { /* noop */ } disconnect() { /* noop */ } }
(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = (globalThis as unknown as { ResizeObserver?: unknown }).ResizeObserver || RO;

const ok = <T,>(data: T) => ({ success: true as const, data, meta: {} });
const user = { id: 'u1', name: 'NMC Duty Officer', email: 'nmc@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'NMC', permissions: ['nmc.view', 'ai.use'] }, permissions: ['nmc.view', 'ai.use'], perms: ['nmc.view', 'ai.use'] };
const cell = (lat: number, lon: number, ships: number, fixes: number, bearing: number | null, flow: number) => ({ lat, lon, ships, fixes, moving: bearing === null ? 0 : fixes, meanSog: 11.2, bearing, flow, categories: { cargo: ships } });
/* Fictional figures shaped as the service answers them. */
const analytics = (days: number, cellNm: number) => ({
  window: { from: '2026-08-31T00:00:00Z', to: '2026-09-07T00:00:00Z', days }, cellNm, grid: { dLat: 0.033, dLon: 0.037 },
  kpis: { ships: 14, registered: 9, fixes: 1210, movingPct: 62, meanSogKn: 10.4, cellsUsed: 37, lanes: 4, busiestCell: cell(25.02, 55.05, 6, 300, 90, 0.97), busiestArea: { code: 'AEJEA-ANCH', name: 'Jebel Ali anchorage', kind: 'ANCHORAGE', ships: 5, visits: 7, hours: 61.5, avgVisitHours: 8.8, longest: { key: 'v1', name: 'Liwa Horizon', hours: 19 } }, areasVisited: 3 },
  cells: [cell(25.02, 55.05, 6, 300, 90, 0.97), cell(25.05, 55.08, 4, 120, 88, 0.9), cell(24.95, 54.95, 3, 60, null, 0)],
  lanes: [cell(25.02, 55.05, 6, 300, 90, 0.97), cell(25.05, 55.08, 4, 120, 88, 0.9)],
  areas: [
    { code: 'AEJEA-ANCH', name: 'Jebel Ali anchorage', kind: 'ANCHORAGE', ships: 5, visits: 7, hours: 61.5, avgVisitHours: 8.8, longest: { key: 'v1', name: 'Liwa Horizon', hours: 19 } },
    { code: 'AEJEA-LIMIT', name: 'Jebel Ali port limits', kind: 'PORT_LIMIT', ships: 8, visits: 12, hours: 40.2, avgVisitHours: 3.4, longest: { key: 'v2', name: 'Delma Island', hours: 9 } },
    { code: 'HORMUZ-TSS', name: 'Strait of Hormuz traffic separation scheme', kind: 'TSS', ships: 0, visits: 0, hours: 0, avgVisitHours: 0, longest: null },
  ],
  byDay: Array.from({ length: days }, (_, i) => ({ day: `2026-09-0${(i % 7) + 1}`, ships: 8 + i, registered: 5, fixes: 150 + i * 10, movingPct: 60 })),
  byCategory: [{ category: 'cargo', ships: 9, fixes: 800 }, { category: 'tanker', ships: 5, fixes: 410 }],
  generatedAt: '2026-09-07T00:00:00Z',
});
const layers = { ports: [], home: { name: 'Home', code: 'AEJEA', lat: 24.98, lon: 55.06, zoomKm: 25 }, areas: [], zones: [], restrictions: [] };

beforeAll(() => { store.dispatch(setSession({ user, token: 't', refreshToken: 'r' } as never)); });
afterEach(() => vi.restoreAllMocks());
const wrap = (ui: React.ReactNode) => render(<Provider store={store}><MemoryRouter initialEntries={['/nmc/analytics']}><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

describe('traffic analytics', () => {
  it('reads the period from the service, shows the headline figures, the map, the cells, the days and the dwell, and re-reads when the window changes', async () => {
    const calls: Record<string, unknown>[] = [];
    vi.spyOn(api, 'get').mockImplementation(((url: string, cfg?: { params?: Record<string, unknown> }) => {
      if (url === '/tracking/layers') return Promise.resolve(ok(layers));
      if (url === '/tracking/analytics') { calls.push(cfg?.params ?? {}); return Promise.resolve(ok(analytics(Number(cfg?.params?.days ?? 7), Number(cfg?.params?.cellNm ?? 2)))); }
      return Promise.reject(new Error(`Unmocked GET ${url}`));
    }) as never);
    wrap(<TrafficAnalytics />);
    expect(await screen.findByTestId('traffic-analytics')).toBeTruthy();
    expect(screen.getByTestId('analytics-ships')).toHaveTextContent('14');
    expect(screen.getByTestId('analytics-ships')).toHaveTextContent('9 on the register');
    expect(screen.getByTestId('analytics-fixes')).toHaveTextContent('1,210');
    expect(screen.getByTestId('analytics-area')).toHaveTextContent('61.5 h');
    expect(screen.getByTestId('analytics-area')).toHaveTextContent('Jebel Ali anchorage');
    expect(screen.getByTestId('analytics-lanes')).toHaveTextContent('4');
    expect(screen.getByTestId('analytics-map')).toHaveTextContent('3 cells');
    expect(screen.getByTestId('analytics-cells')).toHaveTextContent('25.02° N, 55.05° E');
    expect(screen.getByTestId('analytics-cells')).toHaveTextContent('6 ships');
    expect(screen.getByTestId('analytics-dwell')).toHaveTextContent('Jebel Ali anchorage');
    expect(screen.getByTestId('analytics-dwell')).toHaveTextContent('5 ships · 7 visits · avg 8.8 h');
    // the strait, never visited, is not listed; the window starts from the settings' answer and is the reader's to change
    expect(screen.getByTestId('analytics-dwell')).not.toHaveTextContent('Hormuz');
    expect(calls[0]).toEqual({});
    fireEvent.click(screen.getByRole('button', { name: '30 d' }));
    await waitFor(() => expect(calls.some((c) => c.days === 30)).toBe(true));
    await waitFor(() => expect(screen.getByTestId('analytics-lanes')).toHaveTextContent('2 nm'));
    expect(screen.getByRole('button', { name: '30 d' }).getAttribute('aria-pressed')).toBe('true');
    // every card carries the explain control, as every dashboard card does
    expect(screen.getByTestId('explain-analytics-by-day')).toBeTruthy();
    expect(screen.getByTestId('explain-analytics-dwell')).toBeTruthy();
  });
});
