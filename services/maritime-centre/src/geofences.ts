import type { Pool } from 'pg';

/* Named sea areas for the track store. Port limits, anchorages and approach channels are published
 * navigational facts, so these are real areas at approximate published extents rather than invented
 * ones — a geofence that does not correspond to a real place teaches an operator the wrong picture.
 * The rings are simplified rectangles at chart scale: exact enough to demonstrate entry and exit,
 * and explicitly not a substitute for the chart. */

export interface GeofenceSeed {
  code: string; name: string; nameAr: string;
  kind: 'PORT_LIMIT' | 'ANCHORAGE' | 'CHANNEL' | 'RESTRICTED' | 'TSS' | 'FISHING' | 'CUSTOM';
  alertOn: 'NONE' | 'ENTRY' | 'EXIT' | 'BOTH';
  /** GeoJSON ring, [lon, lat] pairs, closed. */
  ring: [number, number][];
}

const rect = (minLon: number, minLat: number, maxLon: number, maxLat: number): [number, number][] =>
  [[minLon, minLat], [maxLon, minLat], [maxLon, maxLat], [minLon, maxLat], [minLon, minLat]];

export const GEOFENCES: GeofenceSeed[] = [
  { code: 'AEJEA-LIMIT', name: 'Jebel Ali port limits', nameAr: 'حدود ميناء جبل علي', kind: 'PORT_LIMIT', alertOn: 'BOTH', ring: rect(54.9700, 24.9600, 55.1200, 25.0600) },
  { code: 'AEJEA-ANCH',  name: 'Jebel Ali anchorage',   nameAr: 'مرسى جبل علي',       kind: 'ANCHORAGE',  alertOn: 'ENTRY', ring: rect(54.8800, 24.9000, 55.0200, 25.0000) },
  { code: 'AEDXB-LIMIT', name: 'Port Rashid limits',    nameAr: 'حدود ميناء راشد',    kind: 'PORT_LIMIT', alertOn: 'BOTH', ring: rect(55.2500, 25.2400, 55.3300, 25.3000) },
  { code: 'AEKLF-LIMIT', name: 'Khor Fakkan limits',    nameAr: 'حدود خورفكان',        kind: 'PORT_LIMIT', alertOn: 'BOTH', ring: rect(56.3300, 25.3200, 56.4200, 25.3900) },
  { code: 'AEFJR-ANCH',  name: 'Fujairah anchorage',    nameAr: 'مرسى الفجيرة',        kind: 'ANCHORAGE',  alertOn: 'ENTRY', ring: rect(56.3600, 25.0800, 56.5600, 25.2600) },
  { code: 'AEAUH-LIMIT', name: 'Khalifa Port limits',   nameAr: 'حدود ميناء خليفة',    kind: 'PORT_LIMIT', alertOn: 'BOTH', ring: rect(54.6200, 24.7600, 54.7600, 24.8600) },
  { code: 'HORMUZ-TSS',  name: 'Strait of Hormuz traffic separation scheme', nameAr: 'نظام الفصل المروري في مضيق هرمز', kind: 'TSS', alertOn: 'NONE', ring: rect(56.2000, 26.2000, 56.8000, 26.7000) },
  { code: 'AEJEA-RESTR', name: 'Jebel Ali restricted approach', nameAr: 'منطقة الاقتراب المقيّدة بجبل علي', kind: 'RESTRICTED', alertOn: 'ENTRY', ring: rect(55.0000, 25.0000, 55.0600, 25.0400) },
];

const bbox = (ring: [number, number][]) => ({
  minLon: Math.min(...ring.map((p) => p[0])), maxLon: Math.max(...ring.map((p) => p[0])),
  minLat: Math.min(...ring.map((p) => p[1])), maxLat: Math.max(...ring.map((p) => p[1])),
});

/** Idempotent: the seed runs on every boot and a re-run must not duplicate or reshape an area an
 *  operator has since edited by hand — hence code as the key and a plain upsert of the definition. */
export async function seedGeofences(pool: Pool): Promise<number> {
  let n = 0;
  for (const g of GEOFENCES) {
    const b = bbox(g.ring);
    const geojson = JSON.stringify({ type: 'Polygon', coordinates: [g.ring] });
    const r = await pool.query(
      `INSERT INTO geofences(code, name, name_ar, kind, alert_on, geojson, min_lat, max_lat, min_lon, max_lon)
       VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,$8,$9,$10)
       ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, name_ar = EXCLUDED.name_ar,
         kind = EXCLUDED.kind, alert_on = EXCLUDED.alert_on, geojson = EXCLUDED.geojson,
         min_lat = EXCLUDED.min_lat, max_lat = EXCLUDED.max_lat,
         min_lon = EXCLUDED.min_lon, max_lon = EXCLUDED.max_lon`,
      [g.code, g.name, g.nameAr, g.kind, g.alertOn, geojson, b.minLat, b.maxLat, b.minLon, b.maxLon]);
    n += r.rowCount ?? 0;
  }
  return n;
}
