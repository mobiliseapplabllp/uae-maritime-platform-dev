import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { useAppSelector } from '../store';
import type { Option } from '../types';

/* Options from Data Studio, once per master per page load.
 *
 * A select that names a master (`lookup: 'companyCategory'`) gets its options from here rather than from a
 * constant in the screen, so a value a clerk adds in Data Studio appears in every form and filter that reads
 * the master without a release. The label follows the interface language when the master carries one. */

export interface LookupRow { id: string; category: string; code: string; label: string; labelAr?: string | null; meta?: Record<string, unknown>; active: boolean }
const cache = new Map<string, Promise<LookupRow[]>>();

export function fetchLookups(category: string): Promise<LookupRow[]> {
  if (!cache.has(category)) {
    const p = api.get<LookupRow[]>('/lookups', { params: { category, limit: 500, sort: 'code' } }).then((r) => r.data).catch(() => { cache.delete(category); return [] as LookupRow[]; });
    cache.set(category, p);
  }
  return cache.get(category)!;
}
/** Forgets a master (or all of them) so the next reader refetches — Data Studio calls this after a save. */
export function invalidateLookups(category?: string) { if (category) cache.delete(category); else cache.clear(); }

const order = (a: LookupRow, b: LookupRow) => (Number(a.meta?.order ?? 1e9) - Number(b.meta?.order ?? 1e9)) || a.code.localeCompare(b.code);

export function useLookups(category?: string | null, opts: { includeInactive?: boolean } = {}) {
  const lang = useAppSelector((s) => s.ui.lang);
  const [rows, setRows] = useState<LookupRow[]>([]);
  const [loading, setLoading] = useState(!!category);
  useEffect(() => {
    let live = true;
    if (!category) { setRows([]); setLoading(false); return () => { live = false; }; }
    setLoading(true);
    fetchLookups(category).then((r) => { if (live) { setRows(r); setLoading(false); } });
    return () => { live = false; };
  }, [category]);
  return useMemo(() => {
    const visible = rows.filter((r) => opts.includeInactive || r.active !== false).sort(order);
    const labelOf = (r: LookupRow) => (lang === 'ar' && r.labelAr ? r.labelAr : r.label);
    const byCode = new Map(rows.map((r) => [r.code, r]));
    return {
      rows: visible, loading,
      options: visible.map((r): Option => ({ value: r.code, label: labelOf(r) })),
      /** The label a stored code prints as; the code itself while the master is loading or does not know it. */
      label: (code?: string | null) => { const r = code ? byCode.get(code) : undefined; return r ? labelOf(r) : (code ?? ''); },
      meta: (code?: string | null) => (code ? byCode.get(code)?.meta ?? {} : {}),
      byCode,
    };
  }, [rows, loading, lang, opts.includeInactive]);
}
export function useLookupOptions(category?: string | null): Option[] { return useLookups(category).options; }
