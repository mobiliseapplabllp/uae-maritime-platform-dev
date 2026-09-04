/* Fleet Manager constants and pure helpers shared by the vessel screens. */
import dayjs from 'dayjs';
import type { ChipColor, StatusMeta } from '../../utils/status';
import type { SurveyEventType, SurveyLane, SurveyStatus } from './types';

export const VESSEL_STATUS_META: StatusMeta = { ACTIVE: { label: 'Active', color: 'success' }, INACTIVE: { label: 'Inactive', color: 'default' } };
export const TYPE_LABELS: Record<string, string> = { CONT: 'Container', BULK: 'Bulk carrier', TANK: 'Tanker', GEN: 'General cargo', RORO: 'Ro-Ro', OSV: 'OSV' };
export const typeLabel = (t: string) => TYPE_LABELS[t] || t;
export const CERT_TYPES = ['Certificate of Registry', 'Classification Certificate', 'Safety Management Certificate', 'International Ship Security Certificate', 'IOPP Certificate', 'Load Line Certificate', 'Maritime Labour Certificate', 'Safety Equipment Certificate', 'Safety Radio Certificate', 'Tonnage Certificate'];
export const BAND_COLOR: Record<string, ChipColor> = { LOW: 'success', MEDIUM: 'warning', HIGH: 'error' };
export const SURVEY_TYPE_LABEL: Record<SurveyEventType, string> = { ANNUAL: 'Annual', INTERMEDIATE: 'Intermediate', SPECIAL: 'Special survey', DRY_DOCK: 'Dry dock' };
export const SURVEY_STATUS_COLOR: Record<SurveyStatus, string> = { OVERDUE: '#B3452E', WINDOW_OPEN: '#B77817', PLANNED: '#056A73' };

/** Share of fleet certificates that are valid, as a whole percentage — null when the fleet holds none. */
export const certHealthPct = (c: { valid: number; expiring: number; expired: number }) => { const total = c.valid + c.expiring + c.expired; return total ? Math.round((c.valid / total) * 100) : null; };

/** Horizontal scale for the planner: the percentage position of any date across the horizon, plus one gridline per month. */
export function plannerScale(from: string | Date, to: string | Date) {
  const start = new Date(from).getTime();
  const end = new Date(to).getTime();
  const total = Math.max(1, end - start);
  const pctOf = (d: string | Date | number) => Math.min(100, Math.max(0, ((new Date(d).getTime() - start) / total) * 100));
  const monthTicks: { pct: number; label: string }[] = [];
  const cur = new Date(start); cur.setDate(1); cur.setHours(0, 0, 0, 0);
  while (cur.getTime() < end) { monthTicks.push({ pct: pctOf(cur), label: dayjs(cur).format('MMM YY') }); cur.setMonth(cur.getMonth() + 1); }
  return { pctOf, monthTicks };
}
export const laneMatches = (lane: SurveyLane, q: string) => { const s = q.trim().toLowerCase(); return !s || lane.vessel.name.toLowerCase().includes(s) || String(lane.vessel.imo || '').includes(s); };
export const overdueCount = (lanes: SurveyLane[]) => lanes.reduce((s, l) => s + l.events.filter((e) => e.status === 'OVERDUE').length, 0);
