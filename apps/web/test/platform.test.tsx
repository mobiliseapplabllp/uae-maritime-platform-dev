import { describe, expect, it, vi, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import '../src/i18n';
import { store } from '../src/store';
import { buildTheme } from '../src/theme';
import api from '../src/api/client';
import PlatformStatus from '../src/pages/platform/PlatformStatus';
import { availabilityColor, availabilityTone, duration, mb, outboxTone, pct } from '../src/pages/platform/shared';
import { MODULES } from '../src/modules';
import { ROUTES } from '../src/routes';

const wrap = (ui: React.ReactNode) => render(
  <Provider store={store}><MemoryRouter><ThemeProvider theme={buildTheme('light')}>{ui}</ThemeProvider></MemoryRouter></Provider>,
);

const target = (over: Record<string, unknown> = {}) => ({
  target: 'ships', kind: 'service', category: 'domain', url: 'http://127.0.0.1:5421',
  up: true, since: new Date().toISOString(), forSec: 120, lastSeenAt: null,
  lastProbeAt: new Date().toISOString(), latencyMs: 29, uptimeSec: 500, error: null,
  detail: { kind: 'domain', port: 5421, telemetry: { service: 'ships', version: '0.0.0', uptimeSec: 500, node: 'v22', memory: { rssMb: 98, heapUsedMb: 30, heapTotalMb: 33 }, db: { reachable: true, latencyMs: 2, poolTotal: 1, poolIdle: 1, poolWaiting: 0 }, outbox: { unpublished: 0, oldestUnpublishedSec: null, publishedLastHour: 4 }, inbox: { processed: 79, lastProcessedAt: null }, migrations: { applied: 1, last: '0001_ships.sql', lastAppliedAt: null } } },
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('platform formatting', () => {
  it('renders a duration in the largest unit that stays exact', () => {
    expect(duration(45)).toBe('45s');
    expect(duration(90)).toBe('1m 30s');
    expect(duration(3700)).toBe('1h 1m');
    expect(duration(90000)).toBe('1d 1h');
  });
  it('switches to GB only once a figure has earned it', () => {
    expect(mb(512)).toBe('512.0 MB');
    expect(mb(2048)).toBe('2.0 GB');
    expect(mb(undefined)).toBe('—');
  });
  it('scores availability on the thresholds an operator uses', () => {
    expect(availabilityTone(99.99)).toBe('success');
    expect(availabilityTone(99.5)).toBe('warning');
    expect(availabilityTone(97)).toBe('error');
    // Never measured is not the same as failing.
    expect(availabilityTone(null)).toBe('default');
    expect(pct(null)).toBe('—');
  });
  it('never produces a palette key that does not exist', () => {
    // `default.main` is not in the MUI palette; an unmeasured target must inherit its colour.
    expect(availabilityColor(null)).toBeUndefined();
    expect(availabilityColor(99.99)).toBe('success.main');
  });
  it('treats a persistent or aged outbox backlog as worse than a transient one', () => {
    expect(outboxTone(0, null)).toBe('success');
    expect(outboxTone(3, 10)).toBe('warning');
    expect(outboxTone(3, 600)).toBe('error');
    expect(outboxTone(500, 5)).toBe('error');
  });
});

describe('platform module registration', () => {
  it('gates every platform route and nav entry on platform.view', () => {
    const mod = MODULES.find((m) => m.key === 'platform');
    expect(mod?.perm).toBe('platform.view');
    expect(mod?.nav.flatMap((g) => g.items).every((i) => i.perm === 'platform.view')).toBe(true);
    const routes = ROUTES.filter((r) => r.path.startsWith('/platform'));
    expect(routes.length).toBeGreaterThanOrEqual(3);
    expect(routes.every((r) => r.perm === 'platform.view')).toBe(true);
  });
});

describe('platform status board', () => {
  it('shows each service with its measured state, not what the service claims', async () => {
    vi.spyOn(api, 'get').mockImplementation((url: string) => {
      if (url === '/platform/status') return Promise.resolve({ data: {
        generatedAt: new Date().toISOString(), lastSweepAt: new Date().toISOString(), tickMs: 15000,
        // services and total targets differ, as they do in reality: targets also counts infrastructure
        summary: { services: 2, servicesUp: 1, targets: 3, targetsUp: 2, openIncidents: 1, status: 'down' },
        targets: [target(), target({ target: 'ports', up: false, latencyMs: null, error: 'fetch failed', forSec: 45, detail: { kind: 'domain', port: 5426 } })],
        openIncidents: [],
      } } as never);
      if (url === '/platform/availability') return Promise.resolve({ data: [
        { target: 'ships', samples: 100, upSamples: 100, availability: 100, latencyP50: 20, latencyP95: 40, latencyMax: 60 },
        { target: 'ports', samples: 100, upSamples: 95, availability: 95, latencyP50: 20, latencyP95: 40, latencyMax: 60 },
      ] } as never);
      return Promise.resolve({ data: [] } as never);
    });
    wrap(<PlatformStatus />);
    await waitFor(() => expect(screen.getByTestId('platform-tile-ships')).toBeInTheDocument());
    expect(screen.getByTestId('platform-tile-ports')).toBeInTheDocument();
    // the down service must show its error, not a bare red dot
    expect(screen.getByText('fetch failed')).toBeInTheDocument();
    expect(screen.getByText('1/2')).toBeInTheDocument();   // services answering
    expect(screen.getByText('2/3')).toBeInTheDocument();   // all targets, infrastructure included
    // telemetry chips carry the internals that predict trouble
    expect(screen.getByText('outbox 0')).toBeInTheDocument();
    expect(screen.getByText('mig 1')).toBeInTheDocument();
  });

  it('surfaces an outbox backlog as its own warning rather than burying it in a tile', async () => {
    vi.spyOn(api, 'get').mockImplementation((url: string) => {
      if (url === '/platform/status') return Promise.resolve({ data: {
        generatedAt: new Date().toISOString(), lastSweepAt: new Date().toISOString(), tickMs: 15000,
        summary: { services: 1, servicesUp: 1, targets: 1, targetsUp: 1, openIncidents: 0, status: 'ok' },
        targets: [target({ detail: { kind: 'domain', port: 5421, telemetry: { ...target().detail.telemetry, outbox: { unpublished: 42, oldestUnpublishedSec: 900, publishedLastHour: 0 } } } })],
        openIncidents: [],
      } } as never);
      return Promise.resolve({ data: [] } as never);
    });
    wrap(<PlatformStatus />);
    await waitFor(() => expect(screen.getByText(/Unpublished events/i)).toBeInTheDocument());
    expect(screen.getByText('ships: 42 (900s)')).toBeInTheDocument();
  });
});
