/* Helpers the accreditation and visit screens share: translated status maps, the scheme list from the master, and date arithmetic. */
import { useEffect, useMemo, useState } from 'react';
import type { TFunction } from 'i18next';
import api from '../../api/client';
import { useAppSelector } from '../../store';
import type { StatusMeta } from '../../utils/status';
import type { Scheme } from './types';

export const cycleStatusMeta = (t: TFunction): StatusMeta => ({
  CURRENT: { label: t('facilities.cycleStatus.CURRENT'), color: 'success' }, DUE: { label: t('facilities.cycleStatus.DUE'), color: 'warning' }, EXPIRED: { label: t('facilities.cycleStatus.EXPIRED'), color: 'error' },
  SUSPENDED: { label: t('facilities.cycleStatus.SUSPENDED'), color: 'warning' }, WITHDRAWN: { label: t('facilities.cycleStatus.WITHDRAWN'), color: 'error' }, RENEWED: { label: t('facilities.cycleStatus.RENEWED'), color: 'default' },
});
export const visitStatusMeta = (t: TFunction): StatusMeta => ({
  SCHEDULED: { label: t('facilities.visitStatus.SCHEDULED'), color: 'info' }, COMPLETED: { label: t('facilities.visitStatus.COMPLETED'), color: 'success' }, CANCELLED: { label: t('facilities.visitStatus.CANCELLED'), color: 'default' },
});
export const severityMeta = (t: TFunction): StatusMeta => ({
  MINOR: { label: t('facilities.severityLabel.MINOR'), color: 'default' }, MAJOR: { label: t('facilities.severityLabel.MAJOR'), color: 'warning' }, CRITICAL: { label: t('facilities.severityLabel.CRITICAL'), color: 'error' },
});
export const OBLIGATION_STATUS_META = (t: TFunction): StatusMeta => ({ OPEN: { label: t('facilities.open'), color: 'warning' }, CLEARED: { label: t('facilities.cleared'), color: 'success' } });

let SCHEMES: Promise<Scheme[]> | null = null;
export const fetchSchemes = () => { if (!SCHEMES) SCHEMES = api.get<Scheme[]>('/facilities/accreditations/schemes').then((r) => r.data).catch(() => { SCHEMES = null; return [] as Scheme[]; }); return SCHEMES; };
/** The accreditation schemes as the master declares them, labelled in the interface language. */
export function useSchemes() {
  const lang = useAppSelector((s) => s.ui.lang);
  const [rows, setRows] = useState<Scheme[]>([]);
  useEffect(() => { let live = true; fetchSchemes().then((r) => { if (live) setRows(r); }); return () => { live = false; }; }, []);
  return useMemo(() => ({
    schemes: rows,
    label: (category?: string | null) => { const s = rows.find((x) => x.category === category); return s ? (lang === 'ar' && s.labelAr ? s.labelAr : s.label) : (category ?? ''); },
    options: rows.map((s) => ({ value: s.category, label: lang === 'ar' && s.labelAr ? s.labelAr : s.label })),
  }), [rows, lang]);
}
export const daysBetween = (from: string | null | undefined, to = new Date()) => (from ? Math.round((new Date(from).getTime() - to.getTime()) / 86_400_000) : null);
