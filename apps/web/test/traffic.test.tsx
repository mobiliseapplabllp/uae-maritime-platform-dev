import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { Provider } from 'react-redux';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '@mui/material';
import '../src/i18n';
import { store } from '../src/store';
import { setSession } from '../src/store/authSlice';
import { buildTheme } from '../src/theme';
import api from '../src/api/client';
import VesselCard from '../src/pages/nmc/traffic/VesselCard';
import { ageWords, flagEmoji, isMoving, navLabel, countryName, fmtCoord } from '../src/pages/nmc/traffic/legend';
import type { TargetDetail } from '../src/pages/nmc/types';

/* The vessel card as the picture shows a ship, and the words the legend puts on her. The map itself is driven in the
 * browser (e2e/traffic.spec.ts): a canvas drawn over Leaflet is not a thing a document model can see. */
const user = { id: 'u1', name: 'Duty Officer', email: 'duty@maritime.example', active: true, kind: 'user' as const, scope: { level: 'NATIONAL' as const }, role: { id: 'r', name: 'NMC', permissions: ['nmc.view', 'nmc.manage'] }, perms: ['nmc.view', 'nmc.manage'] };
const session = { user, token: 't', refreshToken: 'r', sessionId: 's', policy: { accessTokenMinutes: 15, idleTimeoutMinutes: 30, mfaRequiredFrom: null, mfaGraceDays: 14 }, mfa: { required: false, enrolled: false, dueAt: null } };
const wrap = (el: React.ReactNode) => render(<Provider store={store}><MemoryRouter><ThemeProvider theme={buildTheme('light')}>{el}</ThemeProvider></MemoryRouter></Provider>);
const ok = <T,>(data: T) => ({ success: true, data });
const stranger: TargetDetail = {
  mmsi: '470032162', imo: '9725354', name: 'GULF TRADER', callSign: 'A6E123', shipType: 70, category: 'cargo', typeLabel: 'Cargo', flag: 'AE', lat: 25.2012, lon: 55.2087, sog: 11.8, cog: 118, heading: 120,
  navStatus: 'UNDER_WAY', navStatusCode: 0, destination: 'AEJEA', eta: '09-07 04:30', draught: 9.4, length: 180, width: 30, source: 'aisstream', receivedAt: new Date(Date.now() - (6 * 60 + 2) * 60_000).toISOString(), ageMinutes: 362,
  registered: false, vesselId: null, vesselStatus: null, following: false, alerts: [], destinationPort: 'Jebel Ali',
};

describe('the traffic legend', () => {
  it('names statuses, reads a flag off a country code, tells a ship under way from one stopped, and says how old a report is', () => {
    expect(navLabel('UNDER_WAY')).toBe('Underway using engine'); expect(navLabel('AT_ANCHOR')).toBe('At anchor'); expect(navLabel('SOMETHING_ELSE')).toBe('Something else');
    expect(flagEmoji('AE')).toBe('🇦🇪'); expect(flagEmoji(null)).toBe(''); expect(countryName('AE')).toBe('United Arab Emirates'); expect(countryName('ZZ')).toBe('ZZ');
    expect(isMoving(11.8, 'UNDER_WAY')).toBe(true); expect(isMoving(0.2, 'UNDER_WAY')).toBe(false); expect(isMoving(3, 'MOORED')).toBe(false);
    const now = Date.now();
    expect(ageWords(new Date(now - 30_000).toISOString(), now)).toBe('30 seconds ago');
    expect(ageWords(new Date(now - (6 * 60 + 2) * 60_000).toISOString(), now)).toBe('6 hours, 2 minutes ago');
    expect(ageWords(new Date(now - 3 * 86_400_000).toISOString(), now)).toBe('3 days ago'); expect(ageWords(null)).toBe('never');
    expect(fmtCoord(25.2012, 55.2087)).toBe('25.2012° N, 55.2087° E'); expect(fmtCoord(-4.06, -39.66)).toBe('4.0600° S, 39.6600° W');
  });
});

describe('the vessel card', () => {
  afterEach(() => vi.restoreAllMocks());
  it('shows a ship not on the register as AIS reports her — flag, voyage, status, speed, draught, when she was heard — and lets a person follow her', async () => {
    store.dispatch(setSession(session as never));
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => { throw new Error(`unexpected ${url}`); });
    const post = vi.spyOn(api, 'post').mockImplementation(async () => ok({ following: true, mmsi: '470032162' }) as never);
    const onFollow = vi.fn(); const onTrack = vi.fn();
    wrap(<VesselCard target={stranger} trackShown={false} onClose={() => {}} onTrack={onTrack} onFollow={onFollow} />);
    const card = screen.getByTestId('vessel-card');
    expect(card).toHaveTextContent('GULF TRADER'); expect(card).toHaveTextContent('🇦🇪'); expect(card).toHaveTextContent('Cargo');
    expect(screen.getByTestId('card-voyage')).toHaveTextContent('Jebel Ali'); expect(card).toHaveTextContent('HIGH SEAS');
    expect(card).toHaveTextContent('Underway using engine'); expect(card).toHaveTextContent('11.8 kn / 120°'); expect(card).toHaveTextContent('9.4 m');
    expect(card).toHaveTextContent('6 hours, 2 minutes ago'); expect(card).toHaveTextContent('AIS source: aisstream'); expect(card).toHaveTextContent('MMSI 470032162 · IMO 9725354 · A6E123');
    fireEvent.click(screen.getByTestId('card-follow'));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/tracking/watch', { key: '470032162' }));
    await waitFor(() => expect(onFollow).toHaveBeenCalledWith(true));
    fireEvent.click(screen.getByTestId('card-track'));
    expect(onTrack).toHaveBeenCalled();
    // a ship not on the register has no record to open: her details are what she broadcasts
    fireEvent.click(screen.getByTestId('card-details'));
    expect(await screen.findByText(/as AIS reports her/)).toBeInTheDocument();
    expect(screen.getByText('180 m × 30 m')).toBeInTheDocument();
  });
  it('a ship on the register carries the harbour\'s own voyage and opens her record', async () => {
    store.dispatch(setSession(session as never));
    const ours: TargetDetail = { ...stranger, mmsi: '470009896', name: 'MV Khalifa Star', registered: true, vesselId: 'v-1', following: true, category: 'cargo', typeLabel: 'CONT', flag: 'AE', navStatus: 'MOORED', sog: 0, alerts: [{ id: 'a1', type: 'AIS_GAP', severity: 'warning', at: new Date().toISOString(), acknowledged: false }], destinationPort: null, destination: '' };
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url === '/port-calls') return ok([{ id: 'c1', vcn: 'MAR-2026-0102', status: 'BERTHED', eta: '2026-09-05T02:00:00Z', ata: '2026-09-05T03:10:00Z', atd: null, etd: '2026-09-07T10:00:00Z', prevPort: 'Jebel Ali', nextPort: 'Colombo' }]) as never;
      throw new Error(`unexpected ${url}`);
    });
    const del = vi.spyOn(api, 'delete').mockImplementation(async () => ok({ following: false, removed: 1 }) as never);
    const onFollow = vi.fn();
    wrap(<VesselCard target={ours} trackShown onClose={() => {}} onTrack={() => {}} onFollow={onFollow} />);
    await waitFor(() => expect(screen.getByTestId('card-voyage')).toHaveTextContent('Jebel Ali →'));
    const card = screen.getByTestId('vessel-card');
    expect(card).toHaveTextContent('IN PORT'); expect(card).toHaveTextContent('ATA:'); expect(card).toHaveTextContent('Call MAR-2026-0102 · BERTHED');
    expect(card).toHaveTextContent('on the register'); expect(card).toHaveTextContent('AIS GAP'); expect(card).toHaveTextContent('Hide track');
    expect(screen.getByTestId('card-follow')).toHaveTextContent('In my fleet');
    fireEvent.click(screen.getByTestId('card-follow'));
    await waitFor(() => expect(del).toHaveBeenCalledWith('/tracking/watch/470009896'));
    await waitFor(() => expect(onFollow).toHaveBeenCalledWith(false));
    expect(screen.getByTestId('card-details')).toHaveTextContent('Vessel details');
  });
});
