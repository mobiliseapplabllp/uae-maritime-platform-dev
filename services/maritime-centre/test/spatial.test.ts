import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { join } from 'node:path';
import { runMigrations } from '@maritime/service-kit';
import { GEOFENCES, seedGeofences } from '../src/geofences';
import { boundingBox, detectMode, fencesContaining, haversine, pointInRing, resetMode, vesselsWithin } from '../src/spatial';

/* PostGIS and the geodesic fallback are two implementations of the same questions. The platform has
 * to run on a cluster without PostGIS — Homebrew's PostgreSQL, which is how a developer runs it —
 * so the fallback is not a curiosity, it is a supported mode. These tests put the same rows through
 * both and require the answers to match. */

const DB = 'maritime_maritime_centre_spatial_test';
const DB_URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`;
let pool: Pool; let hasPostgis = false;

/* Fixed points around Khalifa Port, where the seeded world's traffic actually sits. */
const KHALIFA = { lat: 24.81, lon: 54.65 };
const SHIPS: Array<[string, number, number]> = [
  ['v-1', 24.8085, 54.6390], ['v-2', 24.8121, 54.6522], ['v-3', 24.7926, 54.6310],
  ['v-4', 24.6800, 54.3800], ['v-5', 24.4600, 54.3000], ['v-6', 25.2631, 55.3094],
];

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  pool = new Pool({ connectionString: DB_URL });
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const ext = await pool.query("SELECT count(*)::int AS n FROM pg_extension WHERE extname='postgis'");
  hasPostgis = ext.rows[0].n > 0;
  for (const [id, lat, lon] of SHIPS) {
    await pool.query(
      `INSERT INTO positions(vessel_id, vessel_name, mmsi, lat, lon, sog, nav_status, source, received_at)
       VALUES ($1,$2,'470000000',$3,$4,10,'UNDERWAY','test',now())`, [id, id.toUpperCase(), lat, lon]);
  }
  await seedGeofences(pool);
});
afterAll(async () => { await pool?.end(); });

describe('geodesy', () => {
  it('measures a known distance', () => {
    // Khalifa Port to Jebel Ali, roughly 70 km along the coast.
    const d = haversine(24.81, 54.65, 25.01, 55.06);
    expect(d).toBeGreaterThan(40_000);
    expect(d).toBeLessThan(50_000);
    expect(haversine(24.81, 54.65, 24.81, 54.65)).toBe(0);
  });
  it('bounds a radius wider in longitude than latitude, because longitude degrees shrink', () => {
    const b = boundingBox(24.81, 54.65, 10_000);
    expect(b.maxLat - b.minLat).toBeLessThan(b.maxLon - b.minLon);
  });

  it('never clips the circle: every point inside the radius is inside the box', () => {
    /* This is the property the fallback depends on. The box is the cheap SQL filter and haversine
     * is the exact test afterwards, so a box that clipped the circle would silently drop vessels
     * that are genuinely within range — a wrong answer that looks like a right one. Sampled all the
     * way round rather than at the cardinal points, which are the easy case. */
    const lat = 24.81, lon = 54.65, radius = 10_000;
    const b = boundingBox(lat, lon, radius);
    const R = 6_371_000;
    for (let deg = 0; deg < 360; deg += 5) {
      const brg = (deg * Math.PI) / 180;
      // a point at very nearly the full radius, on this bearing
      const d = radius * 0.999;
      const dLat = ((d * Math.cos(brg)) / R) * (180 / Math.PI);
      const dLon = ((d * Math.sin(brg)) / R) * (180 / Math.PI) / Math.cos((lat * Math.PI) / 180);
      const pLat = lat + dLat, pLon = lon + dLon;
      expect(haversine(lat, lon, pLat, pLon), `bearing ${deg}`).toBeLessThanOrEqual(radius);
      expect(pLat, `bearing ${deg} lat`).toBeGreaterThanOrEqual(b.minLat);
      expect(pLat, `bearing ${deg} lat`).toBeLessThanOrEqual(b.maxLat);
      expect(pLon, `bearing ${deg} lon`).toBeGreaterThanOrEqual(b.minLon);
      expect(pLon, `bearing ${deg} lon`).toBeLessThanOrEqual(b.maxLon);
    }
  });
  it('decides ring containment by ray casting', () => {
    const square: number[][] = [[54.6, 24.7], [54.8, 24.7], [54.8, 24.9], [54.6, 24.9], [54.6, 24.7]];
    expect(pointInRing(24.8, 54.7, square)).toBe(true);
    expect(pointInRing(24.8, 54.9, square)).toBe(false);
    expect(pointInRing(25.0, 54.7, square)).toBe(false);
  });
});

describe('the two modes agree', () => {
  it('detects the mode the cluster actually supports, and only forces downwards', async () => {
    resetMode();
    expect(await detectMode(pool)).toBe(hasPostgis ? 'postgis' : 'geodesic');
    resetMode();
    // PostGIS cannot be willed into a cluster that lacks it; geodesic can always be forced.
    expect(await detectMode(pool, true)).toBe('geodesic');
    resetMode();
  });

  it('returns the same vessels within a radius either way', async () => {
    for (const radius of [1_000, 5_000, 20_000, 100_000]) {
      resetMode();
      const viaPostgis = await vesselsWithin(pool, KHALIFA.lat, KHALIFA.lon, radius, 100, false);
      resetMode();
      const viaGeodesic = await vesselsWithin(pool, KHALIFA.lat, KHALIFA.lon, radius, 100, true);
      resetMode();
      expect(viaGeodesic.map((v) => v.vessel_id).sort(), `radius ${radius}`)
        .toEqual(viaPostgis.map((v) => v.vessel_id).sort());
      /* The two disagree by a fraction of a percent and always will: PostGIS geography measures on
       * the WGS84 ellipsoid, haversine on a sphere of mean radius. At 100 km that is tens of metres.
       * The tolerance is therefore relative, with a floor for the very short distances where the
       * absolute difference is dominated by rounding to whole metres. */
      for (const g of viaGeodesic) {
        const p = viaPostgis.find((x) => x.vessel_id === g.vessel_id)!;
        const tolerance = Math.max(10, p.distance_m * 0.005);
        expect(Math.abs(g.distance_m - p.distance_m), `${g.vessel_id} @ ${radius}`).toBeLessThanOrEqual(tolerance);
      }
    }
  });

  it('returns the same containing areas either way', async () => {
    const probes: Array<[number, number]> = [
      [24.8085, 54.6390],  // inside the Khalifa port limit
      [25.0200, 55.0300],  // inside both Jebel Ali limit and its restricted approach
      [20.0000, 50.0000],  // open sea, inside nothing
    ];
    for (const [lat, lon] of probes) {
      resetMode();
      const a = await fencesContaining(pool, lat, lon, false);
      resetMode();
      const b = await fencesContaining(pool, lat, lon, true);
      resetMode();
      expect(b.map((f) => f.code).sort(), `${lat},${lon}`).toEqual(a.map((f) => f.code).sort());
    }
  });

  it('excludes the corners of the bounding box, which are outside the circle', async () => {
    resetMode();
    const rows = await vesselsWithin(pool, KHALIFA.lat, KHALIFA.lon, 3_000, 100, true);
    resetMode();
    // every returned vessel is genuinely inside the radius, not merely inside the box
    for (const r of rows) expect(r.distance_m).toBeLessThanOrEqual(3_000);
  });
});

describe('the published sea areas', () => {
  it('seeds every area, idempotently', async () => {
    const before = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM geofences');
    await seedGeofences(pool);
    const after = await pool.query<{ n: string }>('SELECT count(*)::text AS n FROM geofences');
    expect(after.rows[0].n).toBe(before.rows[0].n);
    expect(Number(after.rows[0].n)).toBe(GEOFENCES.length);
  });
  it('stores a bounding box that actually bounds the ring', async () => {
    const rows = await pool.query<{ code: string; min_lat: string; max_lat: string; min_lon: string; max_lon: string; geojson: { coordinates: number[][][] } }>(
      'SELECT code, min_lat::text, max_lat::text, min_lon::text, max_lon::text, geojson FROM geofences');
    for (const r of rows.rows) {
      for (const [lon, lat] of r.geojson.coordinates[0]) {
        expect(lat, r.code).toBeGreaterThanOrEqual(Number(r.min_lat));
        expect(lat, r.code).toBeLessThanOrEqual(Number(r.max_lat));
        expect(lon, r.code).toBeGreaterThanOrEqual(Number(r.min_lon));
        expect(lon, r.code).toBeLessThanOrEqual(Number(r.max_lon));
      }
    }
  });
  it('closes every ring, or containment is undefined', () => {
    for (const g of GEOFENCES) {
      expect(g.ring[0], g.code).toEqual(g.ring[g.ring.length - 1]);
      expect(g.ring.length, g.code).toBeGreaterThanOrEqual(4);
    }
  });
});
