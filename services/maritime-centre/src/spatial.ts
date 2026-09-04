import type { Pool } from 'pg';

/* Spatial queries in the two modes the platform has to run in.
 *
 * With PostGIS the work goes to a GiST index and the distances are geodesic. Without it, the same
 * questions are answered from the numeric lat/lon that is canonical either way: a bounding box in
 * SQL narrows the rows, then haversine gives the exact answer. Same results, different cost — and
 * a machine without the extension still runs the platform. */

export type SpatialMode = 'postgis' | 'geodesic';

let mode: SpatialMode | null = null;

export async function detectMode(pool: Pool, forceGeodesic = false): Promise<SpatialMode> {
  // The override only ever forces downwards: PostGIS cannot be willed into a cluster that lacks it.
  if (forceGeodesic) { mode = 'geodesic'; return mode; }
  if (mode) return mode;
  const r = await pool.query<{ n: string }>("SELECT count(*)::text AS n FROM pg_extension WHERE extname = 'postgis'");
  mode = Number(r.rows[0].n) > 0 ? 'postgis' : 'geodesic';
  return mode;
}
export const currentMode = (): SpatialMode | null => mode;
/** Tests reset the cached detection between databases. */
export const resetMode = () => { mode = null; };

const R = 6_371_000; // mean Earth radius in metres
const rad = (d: number) => (d * Math.PI) / 180;

/** Great-circle distance in metres, on a sphere of mean radius.
 *
 *  PostGIS geography measures on the WGS84 ellipsoid instead, so the two disagree by a fraction of a
 *  percent — tens of metres at a hundred kilometres. That is immaterial for "which vessels are near
 *  this incident", and it is why a vessel sitting exactly on a radius boundary can fall inside under
 *  one mode and outside under the other. Anything that must not be ambiguous at a boundary should
 *  ask for a margin rather than an exact edge. */
export function haversine(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const dLat = rad(bLat - aLat), dLon = rad(bLon - aLon);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(aLat)) * Math.cos(rad(bLat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/** Latitude/longitude deltas that bound a radius. Longitude degrees shrink with latitude, so the
 *  cosine matters; near the poles it is clamped rather than allowed to explode. */
export function boundingBox(lat: number, lon: number, metres: number) {
  const dLat = (metres / R) * (180 / Math.PI);
  const cos = Math.max(Math.cos(rad(lat)), 0.01);
  const dLon = dLat / cos;
  return { minLat: lat - dLat, maxLat: lat + dLat, minLon: lon - dLon, maxLon: lon + dLon };
}

export interface NearRow { vessel_id: string; vessel_name: string | null; mmsi: string | null; lat: string; lon: string; sog: string | null; nav_status: string | null; received_at: Date; distance_m: number }

/** Vessels within a radius of a point, newest position per vessel. */
export async function vesselsWithin(pool: Pool, lat: number, lon: number, metres: number, limit = 200, forceGeodesic = false): Promise<NearRow[]> {
  const m = await detectMode(pool, forceGeodesic);
  if (m === 'postgis') {
    const r = await pool.query<NearRow>(
      `SELECT vessel_id, vessel_name, mmsi, lat::text, lon::text, sog::text, nav_status, received_at,
              ST_Distance(geog, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography)::int AS distance_m
         FROM positions
        WHERE geog IS NOT NULL
          AND ST_DWithin(geog, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography, $3)
        ORDER BY distance_m LIMIT $4`, [lat, lon, metres, limit]);
    return r.rows;
  }
  const b = boundingBox(lat, lon, metres);
  const r = await pool.query<Omit<NearRow, 'distance_m'>>(
    `SELECT vessel_id, vessel_name, mmsi, lat::text, lon::text, sog::text, nav_status, received_at
       FROM positions
      WHERE lat BETWEEN $1 AND $2 AND lon BETWEEN $3 AND $4`,
    [b.minLat, b.maxLat, b.minLon, b.maxLon]);
  // The box is a superset of the circle; the exact test removes its corners.
  return r.rows
    .map((x) => ({ ...x, distance_m: Math.round(haversine(lat, lon, Number(x.lat), Number(x.lon))) }))
    .filter((x) => x.distance_m <= metres)
    .sort((a, b2) => a.distance_m - b2.distance_m)
    .slice(0, limit);
}

/** Ray casting against a GeoJSON ring. Used in geodesic mode, and small enough to be worth having
 *  rather than depending on a geometry library for one predicate. */
export function pointInRing(lat: number, lon: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = [ring[i][0], ring[i][1]];
    const [xj, yj] = [ring[j][0], ring[j][1]];
    const hit = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}

export interface FenceRow { id: string; code: string; name: string; kind: string; geojson: { type: string; coordinates: number[][][] } }

/** Which named sea areas contain this point. */
export async function fencesContaining(pool: Pool, lat: number, lon: number, forceGeodesic = false): Promise<Array<{ id: string; code: string; name: string; kind: string }>> {
  const m = await detectMode(pool, forceGeodesic);
  if (m === 'postgis') {
    const r = await pool.query<{ id: string; code: string; name: string; kind: string }>(
      `SELECT id::text, code, name, kind FROM geofences
        WHERE active AND area IS NOT NULL
          AND ST_Intersects(area, ST_SetSRID(ST_MakePoint($2,$1),4326)::geography)
        ORDER BY code`, [lat, lon]);
    return r.rows;
  }
  // The stored bounding box does the cheap rejection first, exactly as the spatial index would.
  const r = await pool.query<FenceRow>(
    `SELECT id::text, code, name, kind, geojson FROM geofences
      WHERE active AND $1 BETWEEN min_lat AND max_lat AND $2 BETWEEN min_lon AND max_lon`, [lat, lon]);
  return r.rows
    .filter((f) => (f.geojson.coordinates ?? []).some((ring) => pointInRing(lat, lon, ring)))
    .map(({ id, code, name, kind }) => ({ id, code, name, kind }));
}
