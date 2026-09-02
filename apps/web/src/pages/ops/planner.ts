/* Pure time-window helpers for the berth planner and the day schedule. */
import dayjs from 'dayjs';
import type { ScheduleEvent } from './types';

export const HOUR = 3600 * 1000;
export const DAY = 24 * HOUR;
export interface Span { start: number; end: number; totalMs: number }
export const spanOf = (from: string, to: string): Span => { const start = new Date(from).getTime(); const end = new Date(to).getTime(); return { start, end, totalMs: Math.max(1, end - start) }; };
/** Where an instant sits inside the window, clamped to 0–100 %. */
export const pctOf = (span: Span, d: string | number | Date) => { const t = Math.min(Math.max(new Date(d).getTime(), span.start), span.end); return ((t - span.start) / span.totalMs) * 100; };
export const fmtDayShort = (d: string | number | Date) => dayjs(d).format('DD MMM');
/** One tick per local midnight inside the window. */
export const dayTicks = (span: Span) => {
  const ticks: { pct: number; label: string }[] = [];
  for (let t = span.start; t <= span.end; t += DAY) {
    const d = new Date(t); d.setHours(0, 0, 0, 0);
    if (d.getTime() < span.start) continue;
    ticks.push({ pct: pctOf(span, d), label: fmtDayShort(d) });
  }
  return ticks;
};
/** The planner opens on yesterday's midnight so the vessel alongside now is visible. */
export const plannerStart = (now = new Date()) => { const d = new Date(now); d.setHours(0, 0, 0, 0); d.setDate(d.getDate() - 1); return d; };
export const groupByDay = (events: ScheduleEvent[]) => {
  const map = new Map<string, { date: Date; events: ScheduleEvent[] }>();
  for (const e of events) { const d = new Date(e.at); const key = d.toDateString(); if (!map.has(key)) map.set(key, { date: d, events: [] }); map.get(key)!.events.push(e); }
  return [...map.values()].sort((a, b) => a.date.getTime() - b.date.getTime());
};
export const dayLabel = (d: Date, today = new Date()) => {
  const t0 = new Date(today); t0.setHours(0, 0, 0, 0);
  const that = new Date(d); that.setHours(0, 0, 0, 0);
  const diff = Math.round((that.getTime() - t0.getTime()) / DAY);
  const base = dayjs(d).format('dddd, D MMM');
  return diff === 0 ? `Today — ${base}` : diff === -1 ? `Yesterday — ${base}` : diff === 1 ? `Tomorrow — ${base}` : base;
};
