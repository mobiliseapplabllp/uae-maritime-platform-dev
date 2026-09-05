/* Crew module pure helpers shared by the seafarer screens. Ranks and document types are not constants here:
 * they come from the `seafarerRank` and `seafarerCertType` masters through `useLookups`, so a rank added in
 * Data Studio reaches every crew form without a release. */
import type { TFunction } from 'i18next';
import type { StatusMeta } from '../../utils/status';
import type { CrewDashboardData, SeafarerRow } from './types';

export const DAY_MS = 86_400_000;
/** The masters the crew screens draw their dropdowns from. */
export const RANK_LOOKUP = 'seafarerRank';
export const CERT_TYPE_LOOKUP = 'seafarerCertType';
export const accreditationStatusMeta = (t: TFunction): StatusMeta => ({
  NONE: { label: t('seafarers.met.accrStatus.NONE'), color: 'default' }, CURRENT: { label: t('seafarers.met.accrStatus.CURRENT'), color: 'success' }, DUE: { label: t('seafarers.met.accrStatus.DUE'), color: 'warning' },
  EXPIRED: { label: t('seafarers.met.accrStatus.EXPIRED'), color: 'error' }, SUSPENDED: { label: t('seafarers.met.accrStatus.SUSPENDED'), color: 'warning' }, WITHDRAWN: { label: t('seafarers.met.accrStatus.WITHDRAWN'), color: 'error' },
});
export const institutionStatusMeta = (t: TFunction): StatusMeta => ({ ACTIVE: { label: t('seafarers.met.instStatus.ACTIVE'), color: 'success' }, SUSPENDED: { label: t('seafarers.met.instStatus.SUSPENDED'), color: 'warning' }, CLOSED: { label: t('seafarers.met.instStatus.CLOSED'), color: 'default' } });
export const programmeStatusMeta = (t: TFunction): StatusMeta => ({ PENDING: { label: t('seafarers.met.progStatus.PENDING'), color: 'info' }, APPROVED: { label: t('seafarers.met.progStatus.APPROVED'), color: 'success' }, SUSPENDED: { label: t('seafarers.met.progStatus.SUSPENDED'), color: 'warning' }, WITHDRAWN: { label: t('seafarers.met.progStatus.WITHDRAWN'), color: 'default' } });
export const listStatusMeta = (t: TFunction): StatusMeta => ({ RECEIVED: { label: t('seafarers.cl.statuses.RECEIVED'), color: 'info' }, CHECKED: { label: t('seafarers.cl.statuses.CHECKED'), color: 'warning' }, CLEARED: { label: t('seafarers.cl.statuses.CLEARED'), color: 'success' }, QUERIED: { label: t('seafarers.cl.statuses.QUERIED'), color: 'error' } });
export const matchMeta = (t: TFunction): StatusMeta => ({ REGISTER: { label: t('seafarers.cl.match.REGISTER'), color: 'success' }, FOREIGN: { label: t('seafarers.cl.match.FOREIGN'), color: 'info' }, UNREGISTERED_NATIONAL: { label: t('seafarers.cl.match.UNREGISTERED_NATIONAL'), color: 'error' } });
export const ledgerStatusMeta = (t: TFunction): StatusMeta => ({ LEDGER: { label: t('seafarers.fl.status.LEDGER'), color: 'default' }, WATCH: { label: t('seafarers.fl.status.WATCH'), color: 'warning' }, RECONCILED: { label: t('seafarers.fl.status.RECONCILED'), color: 'success' }, REGISTERED: { label: t('seafarers.fl.status.REGISTERED'), color: 'success' } });
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
