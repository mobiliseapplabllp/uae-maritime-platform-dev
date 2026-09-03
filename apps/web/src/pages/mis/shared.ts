/* MIS constants and pure helpers: how a saved report is charted and formatted, and how the MIS months roll up. */
import { moduleByKey } from '../../modules';
import { fmtD, fmtDT, fmtDec, fmtMoney, fmtNum } from '../../utils/format';
import type { MisMonth, MisTotals, ReportColumn, ReportRow } from './types';

/** Report categories map onto the module that owns the data, which gives each group its accent colour. */
export const CATEGORY_MODULE: Record<string, string> = { Traffic: 'ops', Fleet: 'ships', Revenue: 'finance', Compliance: 'inspect', Safety: 'incidents', Crew: 'crew', Companies: 'facil', Administration: 'admin' };
export const categoryColor = (category: string) => moduleByKey(CATEGORY_MODULE[category] || '')?.color || '#5A6B78';
export const MIS_PRESETS = [3, 6, 12, 24];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}|$)/;
const IDENTIFIER = /(^|_)(imo|number|no|code|id|ref|cdc_no)$/;
const MONEY = /^(subtotal|tax|total|collected|billed|amount|rate|outstanding|revenue)$/;
export const isNumeric = (v: unknown): boolean => typeof v === 'number' ? Number.isFinite(v) : typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v));
export const isIsoDate = (v: unknown): v is string => typeof v === 'string' && ISO_DATE.test(v);
/** Columns that carry a number in every row (identifiers such as IMO or invoice numbers excluded), in report order. */
export function numericColumns(columns: ReportColumn[], rows: ReportRow[]): string[] {
  return columns.filter((c, i) => i > 0 && !IDENTIFIER.test(c.key) && rows.some((r) => r[c.key] != null) && rows.every((r) => r[c.key] == null || isNumeric(r[c.key]))).map((c) => c.key);
}
/** What a report can chart: its first column as the label, up to three numeric series — nothing when the table is too long to read as bars. */
export function chartSpec(columns: ReportColumn[], rows: ReportRow[]): { label: string; series: string[] } | null {
  if (!columns.length || rows.length === 0 || rows.length > 60) return null;
  const series = numericColumns(columns, rows).slice(0, 3);
  return series.length ? { label: columns[0].key, series } : null;
}
export const chartRows = (rows: ReportRow[], spec: { label: string; series: string[] }) => rows.map((r) => ({ label: String(r[spec.label] ?? ''), ...Object.fromEntries(spec.series.map((s) => [s, Number(r[s] ?? 0)])) }));
/** Cell text for a report value: dates, money heads, whole numbers and decimals each get the jurisdiction's formatting. */
export function fmtCell(v: unknown, key: string): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (isIsoDate(v)) return v.length > 10 && !/T00:00(:00)?/.test(v) ? fmtDT(v) : fmtD(v);
  if (isNumeric(v)) { const n = Number(v); if (MONEY.test(key)) return fmtMoney(n); return Number.isInteger(n) ? fmtNum(n) : fmtDec(n, 2); }
  return String(v);
}
export const columnLabel = (c: ReportColumn) => c.label || c.key;
/** Average of a monthly figure over the months that had activity. */
export const avgOf = (rows: MisMonth[], key: keyof MisMonth, activeKey: keyof MisMonth = 'calls') => { const on = rows.filter((r) => Number(r[activeKey]) > 0); return on.length ? Math.round((on.reduce((s, r) => s + Number(r[key]), 0) / on.length) * 10) / 10 : 0; };
export const outstandingOf = (t: MisTotals) => Math.max(0, t.revenue - t.collected);
export const collectionPct = (t: MisTotals) => (t.revenue ? Math.round((t.collected / t.revenue) * 1000) / 10 : 0);
const BENCHMARK_LABELS: Record<string, string> = { turnaroundHours: 'Turnaround (hours)', preBerthingWaitHours: 'Pre-berthing wait (hours)', pscDetentionRatePct: 'PSC detention rate (%)', berthOccupancyHealthyPct: 'Healthy berth occupancy (%)', collectionEfficiencyPct: 'Collection efficiency (%)' };
export const benchmarkLabel = (key: string) => BENCHMARK_LABELS[key] || key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());
export const benchmarkValue = (v: number | number[]) => (Array.isArray(v) ? v.join(' – ') : String(v));
