/** Five-field cron (minute hour day-of-month month day-of-week) with `*`, lists, ranges, steps and month/day names, evaluated in a named time zone through Intl — no dependency. */
export interface CronField { values: Set<number>; star: boolean }
export interface CronSpec { expr: string; minute: CronField; hour: CronField; dom: CronField; month: CronField; dow: CronField }
export class CronError extends Error {}
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

function parseValue(token: string, min: number, max: number, names: string[] | undefined, field: string): number {
  const t = token.trim().toUpperCase();
  if (names) { const i = names.indexOf(t); if (i >= 0) return min + i; }
  if (!/^\d+$/.test(t)) throw new CronError(`${field}: invalid value "${token}"`);
  const n = Number(t);
  if (n < min || n > max) throw new CronError(`${field}: ${n} is outside ${min}-${max}`);
  return n;
}
function parseField(text: string, min: number, max: number, names: string[] | undefined, field: string): CronField {
  const values = new Set<number>();
  for (const part of text.split(',')) {
    const pieces = part.split('/');
    if (!part || pieces.length > 2) throw new CronError(`${field}: invalid list item "${part}"`);
    const [range, stepText] = pieces;
    let step = 1;
    if (stepText !== undefined) { if (!/^\d+$/.test(stepText) || Number(stepText) < 1) throw new CronError(`${field}: invalid step "${stepText}"`); step = Number(stepText); }
    let lo: number; let hi: number;
    if (range === '*') { lo = min; hi = max; }
    else if (range.includes('-')) { const [a, b] = range.split('-'); lo = parseValue(a, min, max, names, field); hi = parseValue(b, min, max, names, field); if (lo > hi) throw new CronError(`${field}: range ${range} runs backwards`); }
    else { lo = parseValue(range, min, max, names, field); hi = stepText !== undefined ? max : lo; }
    for (let v = lo; v <= hi; v += step) values.add(field === 'day-of-week' && v === 7 ? 0 : v);
  }
  return { values, star: text.trim() === '*' };
}
export function parseCron(expr: string): CronSpec {
  const fields = String(expr ?? '').trim().split(/\s+/);
  if (fields.length !== 5 || !fields[0]) throw new CronError('cron expression needs five fields: minute hour day-of-month month day-of-week');
  return {
    expr: fields.join(' '),
    minute: parseField(fields[0], 0, 59, undefined, 'minute'), hour: parseField(fields[1], 0, 23, undefined, 'hour'), dom: parseField(fields[2], 1, 31, undefined, 'day-of-month'),
    month: parseField(fields[3], 1, 12, MONTHS, 'month'), dow: parseField(fields[4], 0, 7, DAYS, 'day-of-week'),
  };
}
export const isValidCron = (expr: string): boolean => { try { parseCron(expr); return true; } catch { return false; } };
export function isValidTimeZone(tz: string): boolean { try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; } }

export interface WallClock { year: number; month: number; day: number; hour: number; minute: number; second: number }
const formatters = new Map<string, Intl.DateTimeFormat>();
function formatter(tz: string): Intl.DateTimeFormat {
  let f = formatters.get(tz);
  if (!f) { f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); formatters.set(tz, f); }
  return f;
}
/** The zone's wall clock at an instant. */
export function wallClock(date: Date, tz: string): WallClock {
  const p: Record<string, number> = {};
  for (const part of formatter(tz).formatToParts(date)) if (part.type !== 'literal') p[part.type] = Number(part.value);
  return { year: p.year, month: p.month, day: p.day, hour: p.hour === 24 ? 0 : p.hour, minute: p.minute, second: p.second };
}
/** Zone offset at an instant in milliseconds east of UTC. */
export function zoneOffsetMs(date: Date, tz: string): number {
  const w = wallClock(date, tz);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second) - Math.floor(date.getTime() / 1000) * 1000;
}
/** The instant at which the zone's wall clock reads the given fields; a time inside a DST gap resolves with the offset in force afterwards. */
export function fromWallClock(w: { year: number; month: number; day: number; hour: number; minute: number }, tz: string): Date {
  const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute);
  let utc = wall - zoneOffsetMs(new Date(wall), tz);
  const off = zoneOffsetMs(new Date(utc), tz);
  if (wall - off !== utc) utc = wall - off;
  return new Date(utc);
}
const daysInMonth = (year: number, month: number): number => new Date(Date.UTC(year, month, 0)).getUTCDate();
const weekday = (year: number, month: number, day: number): number => new Date(Date.UTC(year, month - 1, day)).getUTCDay();

/** First instant strictly after `from` whose wall clock in `tz` matches the expression. Day-of-month and day-of-week both restricted means either (as cron does). */
export function nextRun(cron: string | CronSpec, from: Date, tz: string): Date {
  const spec = typeof cron === 'string' ? parseCron(cron) : cron;
  if (!isValidTimeZone(tz)) throw new CronError(`unknown time zone "${tz}"`);
  const start = new Date(Math.floor(from.getTime() / 60000) * 60000 + 60000);
  const w = wallClock(start, tz);
  let { year, month, day, hour, minute } = w;
  const limitYear = year + 5;
  const dayMatches = (y: number, m: number, d: number): boolean => {
    const domMatch = spec.dom.values.has(d); const dowMatch = spec.dow.values.has(weekday(y, m, d));
    if (spec.dom.star && spec.dow.star) return true;
    if (spec.dom.star) return dowMatch;
    if (spec.dow.star) return domMatch;
    return domMatch || dowMatch;
  };
  const nextDay = () => { day++; hour = 0; minute = 0; if (day > daysInMonth(year, month)) { day = 1; month++; if (month > 12) { month = 1; year++; } } };
  for (let guard = 0; guard < 200000; guard++) {
    if (year > limitYear) throw new CronError(`cron "${spec.expr}" never matches`);
    if (!spec.month.values.has(month)) { month++; day = 1; hour = 0; minute = 0; if (month > 12) { month = 1; year++; } continue; }
    if (day > daysInMonth(year, month) || !dayMatches(year, month, day)) { nextDay(); continue; }
    if (!spec.hour.values.has(hour)) { hour++; minute = 0; if (hour > 23) nextDay(); continue; }
    if (!spec.minute.values.has(minute)) { minute++; if (minute > 59) { minute = 0; hour++; if (hour > 23) nextDay(); } continue; }
    const candidate = fromWallClock({ year, month, day, hour, minute }, tz);
    if (candidate.getTime() <= from.getTime()) { minute++; if (minute > 59) { minute = 0; hour++; if (hour > 23) nextDay(); } continue; }
    return candidate;
  }
  throw new CronError(`cron "${spec.expr}": search exhausted`);
}
