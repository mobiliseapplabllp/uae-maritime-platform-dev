import type { Pool } from 'pg';
import type { SettingsClient } from '@maritime/service-kit';
import { pointInRing } from './spatial';
import { categoryOfRegisterType } from './targets';

/* Traffic analytics over time.
 *
 * Everything here is computed from the fixes the track store already holds — the register's own ships' history and the
 * thinned tracks of every other target the feeds reported — and the sea areas the chart publishes. Nothing is stored
 * and nothing is assumed: the window and the cell size come from Harbour Operations → module settings (a request may
 * narrow either), the grid is laid over whatever the fixes cover, and an area's dwell is read off the fixes that fell
 * inside it. Three questions a watch asks of a period are answered: where the traffic was (density), which way it ran
 * (lanes — the cells where the courses agree), and how long ships spent in each published area (dwell). */

export interface Fix { key: string; name: string; registered: boolean; category: string; lat: number; lon: number; sog: number; cog: number; at: Date }
export interface Area { code: string; name: string; kind: string; ring: number[][]; bbox: { minLat: number; maxLat: number; minLon: number; maxLon: number } }
export interface Bounds { minLat: number; maxLat: number; minLon: number; maxLon: number }
export interface AnalyticsOptions {
  /** Cell height in nautical miles; the width is the same distance at the fixes' mean latitude. */
  cellNm: number;
  days: number;
  now?: Date;
  bounds?: Bounds;
  /** A lane needs this many moving fixes in a cell, agreeing on their course to this degree (the mean resultant length, 0–1). */
  laneMinFixes?: number;
  laneMinFlow?: number;
  /** The most cells returned, busiest first; the analysis itself counts every cell. */
  maxCells?: number;
}
export interface Cell { lat: number; lon: number; ships: number; fixes: number; moving: number; meanSog: number; bearing: number | null; flow: number; categories: Record<string, number> }
export interface AreaDwell { code: string; name: string; kind: string; ships: number; visits: number; hours: number; avgVisitHours: number; longest: { key: string; name: string; hours: number } | null }
export interface DayRow { day: string; ships: number; registered: number; fixes: number; movingPct: number }

export const DEFAULT_ANALYTICS = { trafficCellNm: 2, trafficWindowDays: 7 };
const positive = (v: unknown, fallback: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fallback; };
/** What Harbour Operations has set for the analysis; the seeded defaults when the settings service cannot be reached. */
export async function analyticsDefaults(settings?: SettingsClient | null): Promise<{ cellNm: number; days: number }> {
  if (!settings) return { cellNm: DEFAULT_ANALYTICS.trafficCellNm, days: DEFAULT_ANALYTICS.trafficWindowDays };
  const v = await settings.moduleGet<Record<string, unknown>>('ops', { ...DEFAULT_ANALYTICS });
  return { cellNm: positive(v.trafficCellNm, DEFAULT_ANALYTICS.trafficCellNm), days: Math.round(positive(v.trafficWindowDays, DEFAULT_ANALYTICS.trafficWindowDays)) };
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const r3 = (n: number) => Math.round(n * 1000) / 1000;
const isMoving = (f: Fix) => f.sog >= 0.5;
const dayOf = (d: Date) => d.toISOString().slice(0, 10);

/** The grid: one cell per (row, column) at the chosen size, with who was there, how much, how fast and which way. */
export function densityGrid(fixes: Fix[], opts: AnalyticsOptions): { cells: Cell[]; lanes: Cell[]; dLat: number; dLon: number } {
  const cellNm = Math.max(0.25, opts.cellNm);
  const dLat = cellNm / 60;
  const midLat = fixes.length ? fixes.reduce((s, f) => s + f.lat, 0) / fixes.length : (opts.bounds ? (opts.bounds.minLat + opts.bounds.maxLat) / 2 : 25);
  const dLon = cellNm / (60 * Math.max(0.2, Math.cos((midLat * Math.PI) / 180)));
  interface Acc { row: number; col: number; ships: Set<string>; fixes: number; moving: number; sog: number; vx: number; vy: number; categories: Record<string, number>; shipCategory: Map<string, string> }
  const acc = new Map<string, Acc>();
  for (const f of fixes) {
    const row = Math.floor(f.lat / dLat); const col = Math.floor(f.lon / dLon);
    const k = `${row}:${col}`;
    let a = acc.get(k);
    if (!a) { a = { row, col, ships: new Set(), fixes: 0, moving: 0, sog: 0, vx: 0, vy: 0, categories: {}, shipCategory: new Map() }; acc.set(k, a); }
    a.ships.add(f.key); a.fixes += 1; a.shipCategory.set(f.key, f.category);
    if (isMoving(f)) { a.moving += 1; a.sog += f.sog; const rad = (f.cog * Math.PI) / 180; a.vx += Math.sin(rad); a.vy += Math.cos(rad); }
  }
  const cells: Cell[] = [...acc.values()].map((a) => {
    const flow = a.moving ? Math.sqrt(a.vx * a.vx + a.vy * a.vy) / a.moving : 0;
    const bearing = a.moving && flow > 0 ? (Math.round((Math.atan2(a.vx, a.vy) * 180) / Math.PI) + 360) % 360 : null;
    const categories: Record<string, number> = {};
    for (const c of a.shipCategory.values()) categories[c] = (categories[c] ?? 0) + 1;
    return { lat: r3((a.row + 0.5) * dLat), lon: r3((a.col + 0.5) * dLon), ships: a.ships.size, fixes: a.fixes, moving: a.moving, meanSog: a.moving ? r1(a.sog / a.moving) : 0, bearing, flow: r3(flow), categories };
  }).sort((x, y) => y.ships - x.ships || y.fixes - x.fixes || x.lat - y.lat || x.lon - y.lon);
  const minFixes = opts.laneMinFixes ?? 3; const minFlow = opts.laneMinFlow ?? 0.6;
  const lanes = cells.filter((c) => c.moving >= minFixes && c.flow >= minFlow && c.bearing !== null);
  return { cells: cells.slice(0, opts.maxCells ?? 2000), lanes, dLat: Math.round(dLat * 1e5) / 1e5, dLon: Math.round(dLon * 1e5) / 1e5 };
}

/** Dwell: for each published area, the visits ships paid it — a visit is a run of consecutive fixes inside — and the hours they add up to. */
export function dwellByArea(fixes: Fix[], areas: Area[]): AreaDwell[] {
  const byShip = new Map<string, Fix[]>();
  for (const f of fixes) { const list = byShip.get(f.key); if (list) list.push(f); else byShip.set(f.key, [f]); }
  for (const list of byShip.values()) list.sort((a, b) => a.at.getTime() - b.at.getTime());
  return areas.map((area) => {
    const inside = (f: Fix) => f.lat >= area.bbox.minLat && f.lat <= area.bbox.maxLat && f.lon >= area.bbox.minLon && f.lon <= area.bbox.maxLon && pointInRing(f.lat, f.lon, area.ring);
    let visits = 0; let hours = 0; const ships = new Set<string>(); let longest: AreaDwell['longest'] = null;
    for (const [key, list] of byShip) {
      let start: Fix | null = null; let last: Fix | null = null;
      const close = () => {
        if (!start || !last) return;
        const h = (last.at.getTime() - start.at.getTime()) / 3_600_000;
        visits += 1; hours += h; ships.add(key);
        if (!longest || h > longest.hours) longest = { key, name: start.name, hours: r1(h) };
        start = null; last = null;
      };
      for (const f of list) { if (inside(f)) { if (!start) start = f; last = f; } else close(); }
      close();
    }
    return { code: area.code, name: area.name, kind: area.kind, ships: ships.size, visits, hours: r1(hours), avgVisitHours: visits ? r1(hours / visits) : 0, longest };
  }).sort((a, b) => b.hours - a.hours || b.visits - a.visits || a.name.localeCompare(b.name));
}

/** The period day by day: how many ships were heard, how many of them the register's own, how many fixes, how much of it under way. */
export function perDay(fixes: Fix[], opts: AnalyticsOptions): DayRow[] {
  const now = opts.now ?? new Date();
  const days: DayRow[] = [];
  const acc = new Map<string, { ships: Set<string>; registered: Set<string>; fixes: number; moving: number }>();
  for (let i = opts.days - 1; i >= 0; i -= 1) { const d = dayOf(new Date(now.getTime() - i * 86_400_000)); acc.set(d, { ships: new Set(), registered: new Set(), fixes: 0, moving: 0 }); }
  for (const f of fixes) {
    const a = acc.get(dayOf(f.at)); if (!a) continue;
    a.ships.add(f.key); if (f.registered) a.registered.add(f.key); a.fixes += 1; if (isMoving(f)) a.moving += 1;
  }
  for (const [day, a] of acc) days.push({ day, ships: a.ships.size, registered: a.registered.size, fixes: a.fixes, movingPct: a.fixes ? Math.round((a.moving / a.fixes) * 100) : 0 });
  return days;
}

export interface TrafficAnalytics {
  window: { from: string; to: string; days: number }; cellNm: number; grid: { dLat: number; dLon: number };
  kpis: { ships: number; registered: number; fixes: number; movingPct: number; meanSogKn: number; cellsUsed: number; lanes: number; busiestCell: Cell | null; busiestArea: AreaDwell | null; areasVisited: number };
  cells: Cell[]; lanes: Cell[]; areas: AreaDwell[]; byDay: DayRow[]; byCategory: { category: string; ships: number; fixes: number }[]; generatedAt: string;
}
export function trafficAnalytics(fixes: Fix[], areas: Area[], opts: AnalyticsOptions): TrafficAnalytics {
  const now = opts.now ?? new Date();
  const from = new Date(now.getTime() - opts.days * 86_400_000);
  const { cells, lanes, dLat, dLon } = densityGrid(fixes, opts);
  const dwell = dwellByArea(fixes, areas);
  const ships = new Set(fixes.map((f) => f.key)); const registered = new Set(fixes.filter((f) => f.registered).map((f) => f.key));
  const moving = fixes.filter(isMoving);
  const cat = new Map<string, { ships: Set<string>; fixes: number }>();
  for (const f of fixes) { let c = cat.get(f.category); if (!c) { c = { ships: new Set(), fixes: 0 }; cat.set(f.category, c); } c.ships.add(f.key); c.fixes += 1; }
  const visited = dwell.filter((a) => a.visits > 0);
  return {
    window: { from: from.toISOString(), to: now.toISOString(), days: opts.days }, cellNm: opts.cellNm, grid: { dLat, dLon },
    kpis: {
      ships: ships.size, registered: registered.size, fixes: fixes.length, movingPct: fixes.length ? Math.round((moving.length / fixes.length) * 100) : 0,
      meanSogKn: moving.length ? r1(moving.reduce((s, f) => s + f.sog, 0) / moving.length) : 0,
      cellsUsed: cells.length, lanes: lanes.length, busiestCell: cells[0] ?? null, busiestArea: visited[0] ?? null, areasVisited: visited.length,
    },
    cells, lanes, areas: dwell, byDay: perDay(fixes, opts),
    byCategory: [...cat.entries()].map(([category, c]) => ({ category, ships: c.ships.size, fixes: c.fixes })).sort((a, b) => b.ships - a.ships || a.category.localeCompare(b.category)),
    generatedAt: now.toISOString(),
  };
}

/** The fixes of the window: the register's own history and every other target's thinned track, within the bounds when given. */
export async function loadFixes(pool: Pool, since: Date, bounds?: Bounds, limit = 250_000): Promise<Fix[]> {
  const where = bounds ? ' AND lat BETWEEN $2 AND $3 AND lon BETWEEN $4 AND $5' : '';
  const params: unknown[] = bounds ? [since, bounds.minLat, bounds.maxLat, bounds.minLon, bounds.maxLon, limit] : [since, limit];
  const lim = `$${params.length}`;
  const r = await pool.query<{ key: string; name: string; registered: boolean; type: string | null; category: string | null; lat: string; lon: string; sog: string; cog: number; at: Date }>(
    `SELECT * FROM (
       SELECT p.vessel_id AS key, COALESCE(v.name, '') AS name, true AS registered, v.type AS type, NULL::text AS category, p.lat, p.lon, p.sog, p.cog, p.received_at AS at
         FROM position_history p LEFT JOIN vessels v ON v.id = p.vessel_id WHERE p.received_at >= $1${where.replace(/\blat\b/g, 'p.lat').replace(/\blon\b/g, 'p.lon')}
       UNION ALL
       SELECT h.mmsi AS key, COALESCE(t.name, '') AS name, false AS registered, NULL::text AS type, t.category, h.lat, h.lon, h.sog, h.cog, h.received_at AS at
         FROM ais_target_history h LEFT JOIN ais_targets t ON t.mmsi = h.mmsi WHERE h.received_at >= $1 AND t.vessel_id IS NULL${where.replace(/\blat\b/g, 'h.lat').replace(/\blon\b/g, 'h.lon')}
     ) f ORDER BY at LIMIT ${lim}`, params);
  return r.rows.map((x) => ({
    key: x.key, name: x.name, registered: x.registered, category: x.registered ? categoryOfRegisterType(x.type) : (x.category || 'other'),
    lat: Number(x.lat), lon: Number(x.lon), sog: Number(x.sog), cog: Number(x.cog), at: new Date(x.at),
  }));
}

/** The published sea areas as rings the analysis can test a fix against. */
export async function loadAreas(pool: Pool): Promise<Area[]> {
  const r = await pool.query<{ code: string; name: string; kind: string; geojson: { type: string; coordinates: number[][][] }; min_lat: string; max_lat: string; min_lon: string; max_lon: string }>(
    'SELECT code, name, kind, geojson, min_lat, max_lat, min_lon, max_lon FROM geofences WHERE active ORDER BY kind, code');
  return r.rows.map((g) => ({
    code: g.code, name: g.name, kind: g.kind, ring: g.geojson?.coordinates?.[0] ?? [],
    bbox: { minLat: Number(g.min_lat), maxLat: Number(g.max_lat), minLon: Number(g.min_lon), maxLon: Number(g.max_lon) },
  }));
}
