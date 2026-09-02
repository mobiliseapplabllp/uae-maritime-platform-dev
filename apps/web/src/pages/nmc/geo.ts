/* Linear chart projection around the home port — no tiles, no external services. */
export interface BBox { latMin: number; latMax: number; lonMin: number; lonMax: number }
const KM_PER_DEG = 111.32;
/** A box `km` kilometres north and south of the centre, widened east–west to the chart's aspect ratio. */
export const bboxAround = (lat: number, lon: number, km: number, aspect = 980 / 640): BBox => {
  const halfLat = km / KM_PER_DEG;
  const halfLon = (km * aspect) / (KM_PER_DEG * Math.max(0.2, Math.cos((lat * Math.PI) / 180)));
  return { latMin: lat - halfLat, latMax: lat + halfLat, lonMin: lon - halfLon, lonMax: lon + halfLon };
};
export const makeProjector = (b: BBox, w: number, h: number) => ({
  X: (lon: number) => ((lon - b.lonMin) / (b.lonMax - b.lonMin)) * w,
  Y: (lat: number) => h - ((lat - b.latMin) / (b.latMax - b.latMin)) * h,
});
export const inBbox = (b: BBox, lat: number, lon: number) => lat >= b.latMin && lat <= b.latMax && lon >= b.lonMin && lon <= b.lonMax;
const STEPS = [0.05, 0.1, 0.2, 0.25, 0.5, 1, 2, 5];
/** Graticule values strictly inside (min, max) at the finest step that draws at most eight lines. */
export const gridTicks = (min: number, max: number) => {
  const step = STEPS.find((s) => (max - min) / s <= 8) || STEPS[STEPS.length - 1];
  const out: number[] = [];
  for (let v = Math.ceil(min / step) * step; v < max; v += step) { const r = Math.round(v * 1e4) / 1e4; if (r > min && r < max) out.push(r); }
  return out;
};
export const fmtLat = (v: number) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'N' : 'S'}`;
export const fmtLon = (v: number) => `${Math.abs(v).toFixed(2)}°${v >= 0 ? 'E' : 'W'}`;
