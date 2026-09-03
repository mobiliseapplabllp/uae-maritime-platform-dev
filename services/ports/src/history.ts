/* Shared helpers for the history and utilisation readings computed off outage windows and service records.
 * Month buckets are UTC calendar months — everything is stored in UTC and rendered locally by the clients. */
export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export type Instant = Date | string | number | null | undefined;
export const round1 = (n: unknown) => Math.round((Number(n) || 0) * 10) / 10;
export const iso = (d: Instant): string | null => (d == null || d === '' ? null : new Date(d).toISOString());
export const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
export const ms = (d: Instant) => (d == null || d === '' ? NaN : new Date(d).getTime());
export const monthKey = (d: Date | string | number) => { const x = new Date(d); return `${x.getUTCFullYear()}-${String(x.getUTCMonth() + 1).padStart(2, '0')}`; };
export const monthLabel = (key: string) => `${MONTHS[Number(key.slice(5, 7)) - 1]} ${key.slice(2, 4)}`;
/** Clamp a ?months= query to something sane. */
export const clampMonths = (v: unknown, dflt = 12, max = 48) => Math.min(max, Math.max(1, parseInt(String(v ?? ''), 10) || dflt));
export interface MonthBucket { key: string; label: string; from: Date; to: Date }
export interface MonthsWindow { bounds: MonthBucket[]; keys: string[]; from: Date; to: Date }
/** The last `n` calendar months ending with the current one, oldest first, plus the overall window. */
export function monthWindow(n: number, now = new Date()): MonthsWindow {
  const bounds: MonthBucket[] = [];
  for (let i = n - 1; i >= 0; i -= 1) {
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    const to = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i + 1, 1));
    bounds.push({ key: monthKey(from), label: monthLabel(monthKey(from)), from, to });
  }
  return { bounds, keys: bounds.map((b) => b.key), from: bounds[0].from, to: bounds[bounds.length - 1].to };
}
/** Days of [from,to) that fall inside [winFrom,winTo). */
export function overlapDays(from: Instant, to: Instant, winFrom: Instant, winTo: Instant): number {
  if (from == null || to == null) return 0;
  const a = Math.max(ms(from), ms(winFrom)); const b = Math.min(ms(to), ms(winTo));
  return b > a ? (b - a) / DAY : 0;
}
export interface OutageWindow { from: Instant; to: Instant }
/** Share of a window not spent out of service, from a list of outage windows. */
export function availability(outages: OutageWindow[] | null | undefined, from: Instant, to: Instant) {
  const span = (ms(to) - ms(from)) / DAY;
  const days = (outages ?? []).reduce((s, o) => s + overlapDays(o.from, o.to, from, to), 0);
  return { days: round1(days), availabilityPct: span > 0 ? round1(Math.max(0, 100 - (days / span) * 100)) : 100 };
}
export const daysBetween = (from: Instant, to: Instant) => round1(Math.max(0, (ms(to) - ms(from)) / DAY));
/** UTC midnight of the day an instant falls on. */
export const dayStart = (d: Instant = new Date()) => { const x = new Date(ms(d)); x.setUTCHours(0, 0, 0, 0); return x; };
export const dayKey = (d: Instant) => new Date(ms(d)).toISOString().slice(0, 10);
