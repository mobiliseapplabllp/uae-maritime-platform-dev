import type { Pool } from 'pg';
import { getJurisdiction } from '@maritime/contracts';

export const H = 3600_000; export const D = 24 * H;
export type Tone = 'default' | 'success' | 'warning' | 'error' | 'info';
export interface Card { label: string; value: string | number; sub: string; tone: Tone }
export const card = (label: string, value: string | number, sub = '', tone: Tone = 'default'): Card => ({ label, value, sub, tone });

let profileCode = process.env.JURISDICTION ?? 'AE';
export const setProfile = (code: string) => { profileCode = code; };
export const profile = () => getJurisdiction(profileCode);
export const nf = (n: number | null | undefined) => new Intl.NumberFormat(profile().currency.locale).format(Math.round(Number(n || 0)));
/** Compact money in the jurisdiction's currency, e.g. "AED 1.25M" or "₹1.25 Cr". */
export function money(n: number | null | undefined): string {
  const v = Number(n || 0); const abs = Math.abs(v); const { symbol, grouping, locale } = profile().currency;
  if (grouping === 'lakh-crore') { if (abs >= 1e7) return `${symbol}${(v / 1e7).toFixed(2)} Cr`; if (abs >= 1e5) return `${symbol}${(v / 1e5).toFixed(1)} L`; return `${symbol}${new Intl.NumberFormat(locale).format(Math.round(v))}`; }
  const sep = symbol.length > 1 ? ' ' : '';
  if (abs >= 1e9) return `${symbol}${sep}${(v / 1e9).toFixed(2)}B`; if (abs >= 1e6) return `${symbol}${sep}${(v / 1e6).toFixed(2)}M`; if (abs >= 1e3) return `${symbol}${sep}${(v / 1e3).toFixed(1)}K`;
  return `${symbol}${sep}${new Intl.NumberFormat(locale).format(Math.round(v))}`;
}
export const monthYear = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleDateString(profile().currency.locale, { month: 'short', year: 'numeric' }) : '—');
export const dayMonthYear = (d: Date | string | null | undefined) => (d ? new Date(d).toLocaleDateString(profile().currency.locale, { day: '2-digit', month: 'short', year: 'numeric' }) : '—');
export const monthKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
export const monthLabel = (d: Date) => d.toLocaleString('en-GB', { month: 'short', year: '2-digit' });
export const certStatus = (expiry: Date | string | null | undefined, now = new Date(), window = 30): 'VALID' | 'EXPIRING' | 'EXPIRED' => {
  if (!expiry) return 'VALID';
  const t = new Date(expiry).getTime();
  if (t < now.getTime()) return 'EXPIRED';
  if (t < now.getTime() + window * D) return 'EXPIRING';
  return 'VALID';
};
export const CARGO_GROUP: Record<string, 'container' | 'dryBulk' | 'liquid'> = { CONTAINERS: 'container', COAL: 'dryBulk', FERT: 'dryBulk', GRAIN: 'dryBulk', CRUDE: 'liquid', POL: 'liquid', EDIBLE: 'liquid', LNG: 'liquid' };
export const one = async <T>(pool: Pool, sql: string, params: unknown[] = []): Promise<T> => (await pool.query(sql, params)).rows[0] as T;
export const many = async <T>(pool: Pool, sql: string, params: unknown[] = []): Promise<T[]> => (await pool.query(sql, params)).rows as T[];
export const count = async (pool: Pool, sql: string, params: unknown[] = []): Promise<number> => Number((await one<{ n: string }>(pool, sql, params))?.n ?? 0);
export const months12 = (now: Date) => Array.from({ length: 12 }, (_, i) => { const d = new Date(now.getFullYear(), now.getMonth() - (11 - i), 1); return { key: monthKey(d), label: monthLabel(d) }; });
