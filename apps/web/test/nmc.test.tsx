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
import type { Layers, MdaAlert, OpenIncident, Target, TargetDetail, TargetsResponse, WatchItem } from '../src/pages/nmc/types';

/* The live traffic picture in a document model: the map itself is a canvas over Leaflet that a browser drives
 * (e2e/traffic.spec.ts); here the page's own furniture is proved — the counts, the legend, the text alternative, the
 * alerts panel, the search that opens a card, the fleet. */
const ok = <T,>(data: T, meta: Record<string, unknown> = {}) => ({ success: true as const, data, meta });
const session = { user: { id: 'u1', name: 'Duty Officer', email: 'mrcc@maritime.example', active: true, kind: 'user', scope: { level: 'NATIONAL' }, role: { id: 'r', name: 'Super Admin', permissions: ['*'] }, perms: ['*'] }, token: 't', refreshToken: 'r' };
const mockGet = (routes: Record<string, unknown>) => vi.spyOn(api, 'get').mockImplementation(((url: string) => (url in routes ? Promise.resolve(routes[url]) : Promise.reject(new Error(`Unmocked GET ${url}`)))) as never);
const wrap = (ui: React.ReactNode) => render(<Provider store={store}><MemoryRouter><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>);

const now = new Date().toISOString();
const coral: Target = { mmsi: '470000001', imo: '9000001', name: 'MV Coral Reach', callSign: 'A6C1', shipType: null, category: 'cargo', typeLabel: 'CONT', flag: 'PA', lat: 24.75, lon: 54.60, sog: 8, cog: 120, heading: 118, navStatus: 'UNDERWAY', navStatusCode: null, destination: 'Khalifa Port', eta: '', draught: null, length: null, width: null, source: 'AIS (stub contract)', receivedAt: now, ageMinutes: 0, registered: true, vesselId: 'v1', vesselStatus: 'ACTIVE' };
const stranger: Target = { mmsi: '470000002', imo: '', name: 'GULF TRADER', callSign: '', shipType: 80, category: 'tanker', typeLabel: 'Tanker', flag: 'AE', lat: 24.70, lon: 54.70, sog: 0.1, cog: 45, heading: null, navStatus: 'AT_ANCHOR', navStatusCode: 1, destination: 'AEJEA', eta: '09-07 04:30', draught: 9.4, length: 180, width: 30, source: 'aisstream', receivedAt: now, ageMinutes: 0, registered: false, vesselId: null, vesselStatus: null };
const picture: TargetsResponse = {
  targets: [coral, stranger], clusters: [], total: 2, clustered: false, generatedAt: now, totals: { all: 1240, registered: 26, freshHour: 900 },
  legend: [{ key: 'cargo', label: 'Cargo' }, { key: 'tanker', label: 'Tanker' }], coverage: 'Terrestrial AIS (simulated feed) — approaches sector', thresholds: { channelSpeedLimitKn: 8, aisGapAlertMin: 30, anchorDriftNm: 0.2, zoneEntryWatch: true },
};
const layers: Layers = { ports: [{ code: 'AEJEA', name: 'Jebel Ali', country: 'AE', lat: 25.01, lon: 55.06 }], home: { name: 'Khalifa Port', code: 'AEAUH', lat: 24.808, lon: 54.643, zoomKm: 25 }, areas: [], zones: [{ id: 'z-ch', kind: 'CHANNEL', label: 'Approach channel', points: [{ lat: 24.80, lon: 54.65 }, { lat: 24.68, lon: 54.58 }] }], restrictions: [] };
const alerts: MdaAlert[] = [{ id: 'a1', type: 'AIS_GAP', severity: 'warning', vesselId: 'v2', vessel: { id: 'v2', name: 'MV Amber Dune' }, note: 'No AIS position for 42 minutes', at: now, acknowledged: false }];
const cases: OpenIncident[] = [{ id: 'i1', number: 'INC-2026-0007', severity: 'HIGH', position: { lat: 24.72, lon: 54.62 } }];
const detail: TargetDetail = { ...stranger, following: false, alerts: [], destinationPort: 'Jebel Ali' };
const fleet: WatchItem[] = [{ mmsi: '470000001', vesselId: 'v1', name: 'MV Coral Reach', addedAt: now, target: coral }];
const routes = () => ({ '/tracking/targets': ok(picture), '/tracking/layers': ok(layers), '/tracking/alerts': ok({ items: alerts, total: 1 }), '/incidents': ok(cases, { total: 1 }), '/tracking/feed': ok({ lastStatus: 'ok', lastMode: 'stub', ageMinutes: 1, received: 3, matched: 2, pollMinutes: 2 }), '/tracking/watch': ok(fleet), '/tracking/targets/search': ok([stranger]), '/tracking/targets/470000002': ok(detail) });

describe('Live traffic picture', () => {
  beforeAll(() => { store.dispatch(setSession(session as never)); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('counts the picture, offers the legend and the layers, and carries every target in view as text', async () => {
    mockGet(routes());
    wrap(<TrafficMap />);
    expect(await screen.findByText('Live traffic picture')).toBeInTheDocument();
    expect(await screen.findByText(/1,240 ships on the picture · 26 on the register · 2 in view/)).toBeInTheDocument();
    expect(screen.getByTestId('feed-status')).toHaveTextContent('AIS feed · stub · ok');
    expect(screen.getByTestId('surveillance-thresholds')).toHaveTextContent('channel 8 kn');
    const table = screen.getByRole('table', { name: 'Targets in view' });
    expect(within(table).getByText('MV Coral Reach')).toBeInTheDocument();
    expect(within(table).getByText('At anchor')).toBeInTheDocument();
    const legend = screen.getByTestId('traffic-legend');
    expect(within(legend).getByRole('button', { name: 'Tanker' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(legend).getByLabelText('Ports')).toBeChecked();
    // hiding a class takes it off the picture and out of the text alternative alike
    fireEvent.click(within(legend).getByRole('button', { name: 'Tanker' }));
    expect(within(legend).getByRole('button', { name: 'Tanker' })).toHaveAttribute('aria-pressed', 'false');
    await waitFor(() => expect(within(table).queryByText('At anchor')).toBeNull());
    expect(within(table).getByText('MV Coral Reach')).toBeInTheDocument();
    expect(screen.getByRole('application', { name: 'Traffic map' })).toBeInTheDocument();
  });

  it('lists the alerts and the fleet in the side panel, acknowledges an alert, and opens a card from the search box', async () => {
    mockGet(routes());
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok({}) as never);
    wrap(<TrafficMap />);
    expect(await screen.findByText('No AIS position for 42 minutes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Acknowledge ais gap — MV Amber Dune' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tracking/alerts/a1/ack'));
    fireEvent.click(screen.getByRole('tab', { name: 'My fleet (1)' }));
    expect(within(screen.getByTestId('my-fleet')).getByText(/MV Coral Reach/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Search a ship'), { target: { value: 'gulf' } });
    const results = await screen.findByTestId('traffic-search-results');
    expect(within(results).getByText(/GULF TRADER/)).toBeInTheDocument();
    fireEvent.click(within(results).getByRole('button'));
    const card = await screen.findByTestId('vessel-card');
    expect(card).toHaveTextContent('GULF TRADER'); expect(card).toHaveTextContent('Tanker'); expect(card).toHaveTextContent('At anchor'); expect(card).toHaveTextContent('9.4 m');
    expect(screen.getByTestId('card-voyage')).toHaveTextContent('Jebel Ali');
    fireEvent.click(within(card).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByTestId('vessel-card')).toBeNull());
  });
});

describe('chart projection (kept for the schematic chart helpers)', () => {
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
