import { EVENTS } from '@maritime/contracts';
import type { Queryable, SettingsClient } from '@maritime/service-kit';
import type { Env } from './env';
import { pointInRing } from './spatial';
import { chartZones, distanceNm, publishAlert, type AlertRow, type PositionRow } from './tracking';

/* The derived signals.
 *
 * The watch is told four things the picture can work out for itself: a ship making more than the channel speed
 * limit in the approach, a ship crossing a published sea area that asks to be told about crossings, a ship at
 * anchor that has moved off her anchor position, and a ship the feed has gone quiet about. Every threshold comes
 * from Harbour Operations → module settings, read each time a fix is judged, so a harbour master who tightens the
 * channel limit sees the change on the next fix rather than the next deployment. Each signal is raised once: a
 * second fix over the limit does not raise a second alert while the first is still on the board unacknowledged. */

export interface Thresholds { channelSpeedLimitKn: number; aisGapAlertMin: number; anchorDriftNm: number; zoneEntryWatch: boolean }
export const DEFAULT_THRESHOLDS: Thresholds = { channelSpeedLimitKn: 8, aisGapAlertMin: 30, anchorDriftNm: 0.2, zoneEntryWatch: true };

const positive = (v: unknown, fallback: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : fallback; };
/** What Harbour Operations has set; the seeded defaults when the settings service cannot be reached. */
export async function thresholdsOf(settings?: SettingsClient | null): Promise<Thresholds> {
  if (!settings) return DEFAULT_THRESHOLDS;
  const v = await settings.moduleGet<Record<string, unknown>>('ops', { ...DEFAULT_THRESHOLDS });
  return {
    channelSpeedLimitKn: positive(v.channelSpeedLimitKn, DEFAULT_THRESHOLDS.channelSpeedLimitKn),
    aisGapAlertMin: positive(v.aisGapAlertMin, DEFAULT_THRESHOLDS.aisGapAlertMin),
    anchorDriftNm: positive(v.anchorDriftNm, DEFAULT_THRESHOLDS.anchorDriftNm),
    zoneEntryWatch: !(v.zoneEntryWatch === false || String(v.zoneEntryWatch).toLowerCase() === 'false'),
  };
}

export interface DerivedAlert { type: 'AIS_GAP' | 'SPEED_IN_CHANNEL' | 'ZONE_ENTRY' | 'ANCHOR_DRIFT'; severity: 'info' | 'warning' | 'error'; vesselId: string | null; vesselName: string; note: string; at?: Date; /** Dedupe on the note as well as the type, for a signal that names a place. */ byNote?: boolean }

/** Raises a derived alert unless the same signal is already on the board, unacknowledged, for that ship. */
export async function raiseAlert(c: Queryable, env: Env, a: DerivedAlert): Promise<AlertRow | null> {
  const dup = await c.query(
    `SELECT 1 FROM mda_alerts WHERE type = $1 AND vessel_id IS NOT DISTINCT FROM $2 AND NOT acknowledged AND ($3::boolean = false OR note = $4) LIMIT 1`,
    [a.type, a.vesselId, !!a.byNote, a.note]);
  if (dup.rowCount) return null;
  const r = await c.query<AlertRow>('INSERT INTO mda_alerts(type, severity, vessel_id, vessel_name, note, at) VALUES ($1,$2,$3,$4,$5, COALESCE($6, now())) RETURNING *',
    [a.type, a.severity, a.vesselId, a.vesselName, a.note, a.at ?? null]);
  await publishAlert(c, env, r.rows[0], EVENTS.maritimeCentre.alertRaised, { derived: true });
  return r.rows[0];
}

export interface FenceAt { id: string; code: string; name: string; kind: string; alert_on: string; geojson: { coordinates?: number[][][] } }
/** The published sea areas containing a point, with what each asks to be told. Bounding box first, ring test second. */
export async function fencesAt(c: Queryable, lat: number, lon: number): Promise<FenceAt[]> {
  const r = await c.query<FenceAt>(
    'SELECT id::text, code, name, kind, alert_on, geojson FROM geofences WHERE active AND $1 BETWEEN min_lat AND max_lat AND $2 BETWEEN min_lon AND max_lon ORDER BY code', [lat, lon]);
  return r.rows.filter((f) => (f.geojson?.coordinates ?? []).some((ring) => pointInRing(lat, lon, ring)));
}

/** Whether a point lies in the port's approach channel as the chart draws it. */
export function inApproachChannel(profile: string, lat: number, lon: number): boolean {
  const channel = chartZones(profile).find((z) => z.kind === 'CHANNEL');
  if (!channel) return false;
  const ring = channel.points.map((p) => [p.lon, p.lat]);
  ring.push(ring[0]);
  return pointInRing(lat, lon, ring);
}

/** Where she dropped anchor: the first fix of the current anchor spell, before the fix being judged. */
async function anchorPositionOf(c: Queryable, vesselId: string, before: Date): Promise<{ lat: number; lon: number } | null> {
  const r = await c.query<{ lat: string; lon: string }>(
    `SELECT lat, lon FROM position_history
      WHERE vessel_id = $1 AND received_at < $2 AND nav_status = 'AT_ANCHOR'
        AND received_at > COALESCE((SELECT max(received_at) FROM position_history WHERE vessel_id = $1 AND nav_status <> 'AT_ANCHOR' AND received_at < $2), '-infinity'::timestamptz)
      ORDER BY received_at LIMIT 1`, [vesselId, before]);
  return r.rows[0] ? { lat: Number(r.rows[0].lat), lon: Number(r.rows[0].lon) } : null;
}

export interface PreviousFix { lat: number; lon: number; nav_status: string; received_at: Date }

/** Judges one recorded fix against the thresholds and raises what it finds. */
export async function watchFix(c: Queryable, env: Env, t: Thresholds, p: PositionRow, prev: PreviousFix | null): Promise<AlertRow[]> {
  const out: AlertRow[] = [];
  const lat = Number(p.lat); const lon = Number(p.lon); const sog = Number(p.sog);
  const push = (a: AlertRow | null) => { if (a) out.push(a); };
  const here = await fencesAt(c, lat, lon);

  // speed in the approach: the chart's own channel, or any published channel area
  const inChannel = here.some((f) => f.kind === 'CHANNEL') || inApproachChannel(env.JURISDICTION, lat, lon);
  if (inChannel && sog > t.channelSpeedLimitKn && p.nav_status !== 'MOORED') {
    push(await raiseAlert(c, env, { type: 'SPEED_IN_CHANNEL', severity: sog > t.channelSpeedLimitKn * 1.5 ? 'error' : 'warning', vesselId: p.vessel_id, vesselName: p.vessel_name, at: p.received_at, note: `${sog.toFixed(1)} kn in the approach channel — limit ${t.channelSpeedLimitKn} kn` }));
  }

  // crossings: every one is recorded; only the areas that ask to be told raise an alert
  if (t.zoneEntryWatch) {
    const before = prev ? await fencesAt(c, prev.lat, prev.lon) : [];
    const wasIn = new Set(before.map((f) => f.id)); const isIn = new Set(here.map((f) => f.id));
    for (const f of here) {
      if (wasIn.has(f.id)) continue;
      await c.query('INSERT INTO geofence_events(geofence_id, vessel_id, kind, at, lat, lon) VALUES ($1::uuid,$2,$3,$4,$5,$6)', [f.id, p.vessel_id, 'ENTRY', p.received_at, lat, lon]);
      if (f.alert_on === 'ENTRY' || f.alert_on === 'BOTH') push(await raiseAlert(c, env, { type: 'ZONE_ENTRY', severity: f.kind === 'RESTRICTED' ? 'warning' : 'info', vesselId: p.vessel_id, vesselName: p.vessel_name, at: p.received_at, note: `Entered ${f.name}`, byNote: true }));
    }
    for (const f of before) {
      if (isIn.has(f.id)) continue;
      await c.query('INSERT INTO geofence_events(geofence_id, vessel_id, kind, at, lat, lon) VALUES ($1::uuid,$2,$3,$4,$5,$6)', [f.id, p.vessel_id, 'EXIT', p.received_at, lat, lon]);
      if (f.alert_on === 'EXIT' || f.alert_on === 'BOTH') push(await raiseAlert(c, env, { type: 'ZONE_ENTRY', severity: 'info', vesselId: p.vessel_id, vesselName: p.vessel_name, at: p.received_at, note: `Left ${f.name}`, byNote: true }));
    }
  }

  // drift: a ship still reporting herself at anchor, some way from where she anchored
  if (p.nav_status === 'AT_ANCHOR' && prev?.nav_status === 'AT_ANCHOR') {
    const anchor = await anchorPositionOf(c, p.vessel_id, new Date(p.received_at));
    if (anchor) {
      const drift = distanceNm(anchor, { lat, lon });
      if (drift > t.anchorDriftNm) push(await raiseAlert(c, env, { type: 'ANCHOR_DRIFT', severity: 'warning', vesselId: p.vessel_id, vesselName: p.vessel_name, at: p.received_at, note: `${drift.toFixed(2)} nm off the anchor position — threshold ${t.anchorDriftNm} nm` }));
    }
  }
  return out;
}

/** The scheduled sweep: a target not moored whose last fix is older than the gap threshold, and younger than a day — after that she is a lost target, not a gap. */
export async function sweepAisGaps(c: Queryable, env: Env, t: Thresholds, now = new Date()): Promise<{ gapMinutes: number; checked: number; raised: number; vessels: string[] }> {
  const r = await c.query<PositionRow>(
    `SELECT * FROM positions
      WHERE nav_status <> 'MOORED' AND received_at < $1::timestamptz - ($2::text || ' minutes')::interval AND received_at > $1::timestamptz - interval '24 hours'
        AND source NOT ILIKE 'LRIT%'
        AND NOT EXISTS (SELECT 1 FROM mda_alerts a WHERE a.type = 'AIS_GAP' AND a.vessel_id = positions.vessel_id AND NOT a.acknowledged)
      ORDER BY received_at LIMIT 200`, [now, String(t.aisGapAlertMin)]);
  const vessels: string[] = [];
  for (const p of r.rows) {
    const minutes = Math.round((now.getTime() - new Date(p.received_at).getTime()) / 60_000);
    const a = await raiseAlert(c, env, { type: 'AIS_GAP', severity: minutes >= t.aisGapAlertMin * 3 ? 'error' : 'warning', vesselId: p.vessel_id, vesselName: p.vessel_name, at: now, note: `No AIS fix for ${minutes} min — threshold ${t.aisGapAlertMin} min` });
    if (a) vessels.push(p.vessel_name);
  }
  return { gapMinutes: t.aisGapAlertMin, checked: r.rowCount ?? 0, raised: vessels.length, vessels };
}
