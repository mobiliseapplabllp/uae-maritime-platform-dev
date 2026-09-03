/* Crew module constants and pure helpers shared by the seafarer screens. */
import { SEAFARER_CERT_TYPES, SEAFARER_RANKS } from '@maritime/contracts';
import type { Option } from '../../types';
import type { CrewDashboardData, SeafarerRow } from './types';

export const DAY_MS = 86_400_000;
export const RANK_OPTIONS: Option[] = SEAFARER_RANKS.map((r) => ({ value: r, label: r }));
export const CERT_TYPE_OPTIONS: Option[] = SEAFARER_CERT_TYPES.map((c) => ({ value: c, label: c }));
/** Whole days between sign-on and sign-off, never negative. */
export const seaDays = (from: string | Date, to: string | Date) => Math.max(0, Math.round((new Date(to).getTime() - new Date(from).getTime()) / DAY_MS));
/** Days until a document expires — negative once it has lapsed. */
export const daysLeft = (expiry: string | Date, now = new Date()) => Math.floor((new Date(expiry).getTime() - now.getTime()) / DAY_MS);
export const isMedical = (certType: string) => /medical/i.test(certType);
export const onBoard = (s: Pick<SeafarerRow, 'currentVesselId'>) => !!s.currentVesselId;
/** The document-expiry funnel in the order the chart draws it. */
export const funnelBands = (f: CrewDashboardData['funnel']) => [
  { band: 'Expired', count: f.expired }, { band: '≤30 d', count: f.d30 }, { band: '31–90 d', count: f.d90 }, { band: 'Valid >90 d', count: f.valid },
];
/** A sea-service entry is valid when it names a vessel and a rank and signs off after it signed on. */
export const serviceValid = (v: { vesselName?: string; rank?: string; from?: string; to?: string }) => !!v.vesselName && !!v.rank && !!v.from && !!v.to && new Date(v.to).getTime() > new Date(v.from).getTime();
