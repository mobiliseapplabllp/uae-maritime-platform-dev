import { describe, expect, it } from 'vitest';
import { densityGrid, dwellByArea, perDay, trafficAnalytics, type Area, type Fix } from '../src/analytics';

/* The analysis is a pure function of the fixes and the areas: the same period always reads the same, every figure traces
 * to a fix, and nothing is assumed about the sea beyond what the chart publishes. Fictional ships on a fictional day. */
const T0 = new Date('2026-09-05T00:00:00Z');
const at = (h: number) => new Date(T0.getTime() + h * 3_600_000);
const fix = (key: string, lat: number, lon: number, sog: number, cog: number, h: number, extra: Partial<Fix> = {}): Fix => ({ key, name: `Ship ${key}`, registered: true, category: 'cargo', lat, lon, sog, cog, at: at(h), ...extra });

// a lane: three ships running due east along 25.0N through the same cells over two hours
const lane: Fix[] = [];
for (const [i, key] of ['A', 'B', 'C'].entries()) for (let s = 0; s < 6; s += 1) lane.push(fix(key, 25.0 + i * 0.001, 55.0 + s * 0.02, 12, 90, s * 0.4));
// a ship at anchor inside the anchorage for three hours, then under way outside it
const anchorage: Area = { code: 'ANCH', name: 'Test anchorage', kind: 'ANCHORAGE', ring: [[56.36, 25.08], [56.56, 25.08], [56.56, 25.26], [56.36, 25.26], [56.36, 25.08]], bbox: { minLat: 25.08, maxLat: 25.26, minLon: 56.36, maxLon: 56.56 } };
const anchored: Fix[] = [0, 1, 2, 3].map((h) => fix('D', 25.15, 56.45, 0.1, 0, h, { category: 'tanker' }));
const left: Fix[] = [4, 5].map((h) => fix('D', 25.30, 56.60, 9, 20, h, { category: 'tanker' }));
// a stranger the feed heard once, not on the register
const stranger = fix('S', 25.0, 55.5, 7, 270, 1, { registered: false, category: 'other', name: '' });
// a contrary course in a lane cell lowers the agreement: three fixes east and one west agree only halfway
const contrary = fix('X', 25.0, 55.0, 8, 270, 0.1, { category: 'other' });

describe('maritime-centre — traffic analytics', () => {
  it('lays a grid of the chosen size over the fixes and finds the lane where the courses agree', () => {
    const { cells, lanes, dLat, dLon } = densityGrid([...lane, ...anchored, ...left, stranger], { cellNm: 2, days: 1 });
    expect(dLat).toBeCloseTo(2 / 60, 4); expect(dLon).toBeGreaterThan(dLat); expect(dLon).toBeCloseTo(2 / (60 * Math.cos((25.05 * Math.PI) / 180)), 2);
    // the busiest cell holds the three lane ships
    expect(cells[0].ships).toBeGreaterThanOrEqual(3); expect(cells[0].categories.cargo).toBe(3);
    const laneCells = lanes.filter((c) => c.bearing !== null && Math.abs(c.bearing - 90) <= 2);
    expect(laneCells.length).toBeGreaterThan(0);
    expect(laneCells[0].flow).toBeGreaterThan(0.95);
    // the anchorage cell has ships but no lane: a stopped ship has no course to agree on
    const anchCell = cells.find((c) => Math.abs(c.lat - 25.15) < dLat && Math.abs(c.lon - 56.45) < dLon)!;
    expect(anchCell.ships).toBe(1); expect(anchCell.moving).toBe(0); expect(anchCell.bearing).toBeNull();
    expect(lanes.some((c) => c === anchCell)).toBe(false);
    // a ship running against the lane lowers the agreement in her cell: six fixes east, one west
    const mixed = densityGrid([...lane, contrary], { cellNm: 2, days: 1 }).cells.find((c) => c.ships === 4)!;
    expect(mixed.moving).toBe(7); expect(mixed.flow).toBeCloseTo(5 / 7, 2); expect(mixed.bearing).toBe(90);
  });
  it('reads dwell off the fixes that fell inside an area, visit by visit', () => {
    const dwell = dwellByArea([...anchored, ...left, ...lane], [anchorage]);
    expect(dwell).toHaveLength(1);
    expect(dwell[0]).toMatchObject({ code: 'ANCH', ships: 1, visits: 1, hours: 3, avgVisitHours: 3, longest: { key: 'D', name: 'Ship D', hours: 3 } });
    // two visits when she leaves and comes back
    const back = [fix('D', 25.15, 56.45, 0.1, 0, 8), fix('D', 25.15, 56.45, 0.1, 0, 9.5)];
    const twice = dwellByArea([...anchored, ...left, ...back], [anchorage])[0];
    expect(twice.visits).toBe(2); expect(twice.hours).toBe(4.5); expect(twice.avgVisitHours).toBe(2.3);
    expect(dwellByArea(lane, [anchorage])[0]).toMatchObject({ ships: 0, visits: 0, hours: 0, longest: null });
  });
  it('counts the days of the window, distinct ships and the share under way, with empty days kept', () => {
    const days = perDay([...lane, ...anchored, stranger], { cellNm: 2, days: 3, now: at(30) });
    expect(days.map((d) => d.day)).toEqual(['2026-09-04', '2026-09-05', '2026-09-06']);
    expect(days[0]).toMatchObject({ ships: 0, fixes: 0, movingPct: 0 });
    expect(days[1]).toMatchObject({ ships: 5, registered: 4, fixes: lane.length + anchored.length + 1 });
    expect(days[1].movingPct).toBe(Math.round(((lane.length + 1) / (lane.length + anchored.length + 1)) * 100));
  });
  it('composes the whole answer: window, headline figures, the busiest cell and area, and the classes', () => {
    const a = trafficAnalytics([...lane, ...anchored, ...left, stranger], [anchorage], { cellNm: 2, days: 2, now: at(12) });
    expect(a.window.days).toBe(2); expect(a.window.to).toBe(at(12).toISOString());
    expect(a.kpis).toMatchObject({ ships: 5, registered: 4, fixes: lane.length + anchored.length + left.length + 1, areasVisited: 1 });
    expect(a.kpis.busiestArea?.code).toBe('ANCH'); expect(a.kpis.busiestCell?.ships).toBeGreaterThanOrEqual(3); expect(a.kpis.lanes).toBeGreaterThan(0);
    expect(a.kpis.meanSogKn).toBeGreaterThan(9);
    expect(a.byCategory[0]).toMatchObject({ category: 'cargo', ships: 3 });
    expect(a.byCategory.map((c) => c.category)).toEqual(['cargo', 'other', 'tanker']);
    const empty = trafficAnalytics([], [anchorage], { cellNm: 2, days: 1 });
    expect(empty.kpis).toMatchObject({ ships: 0, fixes: 0, lanes: 0, busiestCell: null, busiestArea: null, areasVisited: 0 });
  });
});
