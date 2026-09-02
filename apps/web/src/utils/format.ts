import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { getProfile } from '../config/runtime';
dayjs.extend(relativeTime);

type D = string | number | Date | null | undefined;
export const fmtDT = (d: D) => (d ? dayjs(d).format('DD MMM YYYY, HH:mm') : '—');
export const fmtD = (d: D) => (d ? dayjs(d).format('DD MMM YYYY') : '—');
export const fromNow = (d: D) => (d ? dayjs(d).fromNow() : '—');
export const toInputDT = (d: D) => (d ? dayjs(d).format('YYYY-MM-DDTHH:mm') : '');
export const toInputD = (d: D) => (d ? dayjs(d).format('YYYY-MM-DD') : '');

const locale = () => getProfile().currency.locale;
export const fmtNum = (n: number | null | undefined) => (n === null || n === undefined ? '—' : new Intl.NumberFormat(locale()).format(Math.round(n)));
export const fmtDec = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? '—' : new Intl.NumberFormat(locale(), { maximumFractionDigits: digits }).format(n));

/** Money in the jurisdiction's currency: full form, e.g. "AED 1,250,000.00" or "₹12,50,000.00". */
export const fmtMoney = (n: number | null | undefined) => {
  if (n === null || n === undefined) return '—';
  const { code, locale: loc } = getProfile().currency;
  return new Intl.NumberFormat(loc, { style: 'currency', currency: code, maximumFractionDigits: 2 }).format(n);
};
/** Compact money for cards: "AED 1.25M" / "AED 350K" — or lakh-crore where the profile groups that way ("₹1.25 Cr"). */
export const fmtMoneyShort = (n: number | null | undefined) => {
  if (n === null || n === undefined) return '—';
  const { symbol, grouping, locale: loc } = getProfile().currency;
  const abs = Math.abs(n);
  if (grouping === 'lakh-crore') {
    if (abs >= 1e7) return `${symbol}${(n / 1e7).toFixed(2)} Cr`;
    if (abs >= 1e5) return `${symbol}${(n / 1e5).toFixed(1)} L`;
    return `${symbol}${new Intl.NumberFormat(loc).format(Math.round(n))}`;
  }
  const sep = symbol.length > 1 ? ' ' : '';
  if (abs >= 1e9) return `${symbol}${sep}${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${symbol}${sep}${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${symbol}${sep}${(n / 1e3).toFixed(1)}K`;
  return `${symbol}${sep}${new Intl.NumberFormat(loc).format(Math.round(n))}`;
};
export const fmtMT = (n: number | null | undefined) => {
  if (n === null || n === undefined) return '—';
  if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(2)} M MT`;
  if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}k MT`;
  return `${fmtNum(n)} MT`;
};
export const initials = (name?: string | null) => String(name || '?').replace(/^(MV|MT|FV|Capt\.|Cdr\.|Lt\.|Dr\.)\s+/i, '').split(' ').map((w) => w[0]).slice(0, 2).join('').toUpperCase();
export const titleCase = (s?: string | null) => String(s || '').toLowerCase().replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
