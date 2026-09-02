import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import { store } from '../src/store';
import { setSession } from '../src/store/authSlice';
import { buildTheme } from '../src/theme';
import api from '../src/api/client';
import TrafficMap from '../src/pages/nmc/TrafficMap';
import { bboxAround, fmtLat, fmtLon, gridTicks, inBbox, makeProjector } from '../src/pages/nmc/geo';
import type { OpenIncident, TrafficPicture } from '../src/pages/nmc/types';

const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Duty Officer', email: 'mrcc@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
const wrap = (ui: React.ReactNode) => render(<Provider store={store}><MemoryRouter><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

// A fictional picture around the default home port: two targets, one derived alert, one open case.
const picture: TrafficPicture = {
  port: { name: 'Khalifa Port', lat: 24.808, lon: 54.643, zoomKm: 25 },
  zones: [
    { id: 'z-land', kind: 'LAND', label: 'Mainland', points: [{ lat: 24.95, lon: 54.2 }, { lat: 24.95, lon: 55.1 }, { lat: 24.85, lon: 55.1 }, { lat: 24.85, lon: 54.2 }] },
    { id: 'z-anch', kind: 'ANCHORAGE', label: 'Anchorage A', points: [{ lat: 24.72, lon: 54.68 }, { lat: 24.72, lon: 54.76 }, { lat: 24.66, lon: 54.76 }, { lat: 24.66, lon: 54.68 }] },
    { id: 'z-ch', kind: 'CHANNEL', label: 'Approach ch.', points: [{ lat: 24.80, lon: 54.65 }, { lat: 24.68, lon: 54.58 }] },
    { id: 'z-spm', kind: 'SPM', label: 'SPM 1', points: [{ lat: 24.64, lon: 54.55 }] },
  ],
  positions: [
    { id: 'p1', vesselId: 'v1', vessel: { id: 'v1', name: 'MV Coral Reach', imo: '9000001', type: 'CONT', flag: 'Panama' }, lat: 24.75, lon: 54.60, course: 120, speed: 8, navStatus: 'UNDERWAY', destination: 'Khalifa Port', receivedAt: new Date().toISOString() },
    { id: 'p2', vesselId: 'v2', vessel: { id: 'v2', name: 'MV Amber Dune', imo: '9000002', type: 'BULK', flag: 'Liberia' }, lat: 24.70, lon: 54.70, course: 45, speed: 0, navStatus: 'AT_ANCHOR', receivedAt: new Date().toISOString() },
  ],
  alerts: [{ id: 'a1', type: 'AIS_GAP', severity: 'warning', vesselId: 'v2', vessel: { id: 'v2', name: 'MV Amber Dune' }, note: 'No AIS position for 42 minutes', at: new Date().toISOString(), acknowledged: false }],
  generatedAt: new Date().toISOString(), coverage: 'Terrestrial AIS (simulated feed) — approaches sector',
};
const cases: OpenIncident[] = [{ id: 'i1', number: 'INC-2026-0007', severity: 'HIGH', position: { lat: 24.72, lon: 54.62 } }];

describe('Live traffic picture', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('draws targets, zones and open cases on the chart with a text alternative', async () => {
    mockGet({ '/tracking': ok(picture), '/incidents': ok(cases, { total: 1 }) });
    wrap(<TrafficMap />);
    expect(await screen.findByText('Live traffic picture')).toBeInTheDocument();
    expect(screen.getByText('2 tracked targets · 1 open incident on the picture · Terrestrial AIS (simulated feed) — approaches sector')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Traffic picture around Khalifa Port' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MV Coral Reach — Underway, 8 kn, course 120°' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open incident INC-2026-0007' })).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Tracked targets' });
    expect(within(table).getByText('24.75°N 54.60°E')).toBeInTheDocument();
    expect(within(table).getByText('At anchor')).toBeInTheDocument();
    expect(screen.getByText('Restricted manoeuvrability')).toBeInTheDocument();
  });

  it('selects a target and acknowledges an MDA alert', async () => {
    mockGet({ '/tracking': ok(picture), '/incidents': ok(cases, { total: 1 }) });
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({}) as never);
    wrap(<TrafficMap />);
    fireEvent.click(await screen.findByRole('button', { name: /MV Coral Reach — Underway/ }));
    expect(await screen.findByRole('button', { name: 'Open vessel record' })).toBeInTheDocument();
    expect(screen.getByText('IMO 9000001 · CONT · Panama')).toBeInTheDocument();
    expect(screen.getByText('MDA alerts (1)')).toBeInTheDocument();
    expect(screen.getByText('AIS GAP')).toBeInTheDocument();
    expect(screen.getByText('No AIS position for 42 minutes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge ais gap — MV Amber Dune' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tracking/alerts/a1/ack'));
  });
});

describe('chart projection', () => {
  const box = bboxAround(24.808, 54.643, 25, 980 / 640);
  it('boxes the home port symmetrically and widens east–west to the aspect ratio', () => {
    expect((box.latMin + box.latMax) / 2).toBeCloseTo(24.808, 6);
    expect((box.lonMin + box.lonMax) / 2).toBeCloseTo(54.643, 6);
    expect(box.latMax - box.latMin).toBeCloseTo(50 / 111.32, 4);
    expect(box.lonMax - box.lonMin).toBeCloseTo((50 * (980 / 640)) / (111.32 * Math.cos((24.808 * Math.PI) / 180)), 4);
  });
  it('projects the box corners onto the canvas with north up', () => {
    const { X, Y } = makeProjector(box, 980, 640);
    expect(X(box.lonMin)).toBe(0); expect(X(box.lonMax)).toBeCloseTo(980);
    expect(Y(box.latMax)).toBeCloseTo(0); expect(Y(box.latMin)).toBe(640);
    expect(inBbox(box, 24.808, 54.643)).toBe(true);
    expect(inBbox(box, 22.74, 69.70)).toBe(false);
  });
  it('draws a legible graticule and labels hemispheres', () => {
    expect(gridTicks(22.35, 22.9)).toEqual([22.4, 22.5, 22.6, 22.7, 22.8]);
    const lons = gridTicks(box.lonMin, box.lonMax);
    expect(lons.length).toBeLessThanOrEqual(8);
    expect(lons.every((v) => v > box.lonMin && v < box.lonMax)).toBe(true);
    expect(fmtLat(24.808)).toBe('24.81°N'); expect(fmtLat(-12.5)).toBe('12.50°S');
    expect(fmtLon(54.643)).toBe('54.64°E'); expect(fmtLon(-0.5)).toBe('0.50°W');
  });
});
