import { EVENTS } from '@maritime/contracts';
import { geoFor } from '@maritime/world';
import { enqueue, eventFromContext, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { iso, num, type Row } from './incidents';

/* The surveillance picture.
 *
 * The platform draws its own approach chart rather than pulling map tiles, so the picture has to carry its
 * features with it: the land mass, the anchorage, the approach channel, the offshore moorings and any water
 * currently under restriction. Everything except the restrictions is deployment geography, derived from the
 * jurisdiction's port profile; the restrictions are live records, which is why a proposal already shows on the
 * chart while the harbour master is still deciding it. */

export const NAV_STATUS = ['MOORED', 'AT_ANCHOR', 'UNDERWAY', 'RESTRICTED'] as const;
export const ALERT_TYPES = ['AIS_GAP', 'SPEED_IN_CHANNEL', 'ZONE_ENTRY', 'ANCHOR_DRIFT', 'CLOSE_QUARTERS'] as const;
export const ALERT_SEVERITIES = ['info', 'warning', 'error'] as const;
export const RESTRICTION_KINDS = ['AREA_CLOSURE', 'SPEED_LIMIT', 'NO_ANCHORING', 'SAFETY_ZONE', 'TRAFFIC_SEPARATION'] as const;
export const RESTRICTION_STATUS = ['PROPOSED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'EXPIRED'] as const;

export interface PositionRow {
  id: string; vessel_id: string; vessel_name: string; mmsi: string; lat: string | number; lon: string | number; sog: string | number; cog: number; heading: number;
  nav_status: string; destination: string; source: string; received_at: Date; updated_at: Date;
}
export interface AlertRow {
  id: string; type: string; severity: string; vessel_id: string | null; vessel_name: string; note: string; at: Date;
  acknowledged: boolean; acknowledged_by_id: string | null; acknowledged_by: string; acknowledged_at: Date | null; incident_id: string | null;
}
export interface RestrictionRow {
  id: string; number: string; kind: string; label: string; reason: string; area: { lat: number; lon: number }[];
  effective_from: Date | null; effective_to: Date | null; status: string; incident_id: string | null;
  proposed_by_id: string | null; proposed_by: string; decided_by_id: string | null; decided_by: string; decided_at: Date | null; decision_note: string;
  created_at: Date; updated_at: Date;
}
export interface VesselFacts { id: string; name: string; imo: string; type: string; flag: string; status: string }

/** The tracked target as the traffic picture draws it — the ship's identity travels with the fix. */
export const positionApi = (p: PositionRow, vessel?: VesselFacts, staleMinutes = 45) => {
  const ageMin = Math.round((Date.now() - new Date(p.received_at).getTime()) / 60000);
  return {
    id: p.id, vesselId: p.vessel_id,
    vessel: { id: p.vessel_id, name: vessel?.name ?? p.vessel_name, imo: vessel?.imo ?? '', type: vessel?.type ?? '', flag: vessel?.flag ?? '', status: vessel?.status ?? '' },
    vesselName: vessel?.name ?? p.vessel_name, mmsi: p.mmsi,
    lat: Number(p.lat), lon: Number(p.lon), speed: Number(p.sog), sog: Number(p.sog), course: p.cog, cog: p.cog, heading: p.heading,
    navStatus: p.nav_status, destination: p.destination, source: p.source, receivedAt: iso(p.received_at)!,
    ageMinutes: ageMin, stale: ageMin > staleMinutes,
  };
};
export type PositionApi = ReturnType<typeof positionApi>;

export const alertApi = (a: AlertRow) => ({
  id: a.id, type: a.type, severity: a.severity, vesselId: a.vessel_id, vesselName: a.vessel_name,
  vessel: a.vessel_id ? { id: a.vessel_id, name: a.vessel_name } : null,
  note: a.note, at: iso(a.at)!, acknowledged: a.acknowledged, acknowledgedById: a.acknowledged_by_id, acknowledgedBy: a.acknowledged_by,
  acknowledgedAt: iso(a.acknowledged_at), incidentId: a.incident_id,
});
export type AlertApi = ReturnType<typeof alertApi>;

export const restrictionApi = (r: RestrictionRow) => ({
  id: r.id, number: r.number, kind: r.kind, label: r.label, reason: r.reason, area: r.area ?? [],
  effectiveFrom: iso(r.effective_from), effectiveTo: iso(r.effective_to), status: r.status, incidentId: r.incident_id,
  proposedById: r.proposed_by_id, proposedBy: r.proposed_by, decidedById: r.decided_by_id, decidedBy: r.decided_by,
  decidedAt: iso(r.decided_at), decisionNote: r.decision_note, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});
export type RestrictionApi = ReturnType<typeof restrictionApi>;

/* ------------------------------------------------------------------------ chart features --- */

export interface Zone { id: string; kind: string; label: string; points: { lat: number; lon: number }[] }
const pt = (lat: number, lon: number) => ({ lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4 });
const box = (lat: number, lon: number, dLat: number, dLon: number) => [pt(lat - dLat, lon - dLon), pt(lat - dLat, lon + dLon), pt(lat + dLat, lon + dLon), pt(lat + dLat, lon - dLon)];

/** The port's own geography as the chart draws it: the coast, the anchorage, the fairway and the offshore moorings. */
export function chartZones(profile: string): Zone[] {
  const geo = geoFor(profile);
  const berths = Object.entries(geo.berthPos).filter(([code]) => !code.startsWith('SPM'));
  const lats = berths.map(([, p]) => p[0]); const lons = berths.map(([, p]) => p[1]);
  const latMin = Math.min(...lats); const latMax = Math.max(...lats); const lonMin = Math.min(...lons); const lonMax = Math.max(...lons);
  // the land mass runs behind the quay line, away from the approach; the port sits on its seaward edge
  const inland = latMin < geo.approach[0] ? -1 : 1;
  const land: Zone = {
    id: 'zone-land', kind: 'LAND', label: geo.portName,
    points: [
      pt(latMin + inland * 0.004, lonMin - 0.030), pt(latMax + inland * 0.004, lonMax + 0.030),
      pt(latMax + inland * 0.090, lonMax + 0.060), pt(latMin + inland * 0.090, lonMin - 0.060),
    ],
  };
  const anchorage: Zone = { id: 'zone-anchorage', kind: 'ANCHORAGE', label: 'Outer anchorage A1', points: box(geo.anchorage[0], geo.anchorage[1], 0.030, 0.038) };
  const channel: Zone = {
    id: 'zone-channel', kind: 'CHANNEL', label: 'Approach channel',
    points: [
      pt(geo.approach[0] - 0.150, geo.approach[1] - 0.150), pt(geo.approach[0] - 0.060, geo.approach[1] - 0.060),
      pt(geo.approach[0], geo.approach[1]), pt((latMin + latMax) / 2 - inland * 0.012, (lonMin + lonMax) / 2),
    ],
  };
  const spms = Object.entries(geo.berthPos).filter(([code]) => code.startsWith('SPM'));
  const spm: Zone[] = spms.length ? [{ id: 'zone-spm', kind: 'SPM', label: 'Single point moorings', points: spms.map(([, p]) => pt(p[0], p[1])) }] : [];
  return [land, anchorage, channel, ...spm];
}

/** Water under a live or proposed restriction, drawn on the chart alongside the fixed features. */
export const restrictionZones = (rows: RestrictionRow[]): Zone[] => rows
  .filter((r) => (r.area ?? []).length >= 3)
  .map((r) => ({ id: `zone-restriction-${r.id}`, kind: 'RESTRICTED', label: `${r.label}${r.status === 'PROPOSED' ? ' (proposed)' : ''}`, points: r.area.map((p) => pt(Number(p.lat), Number(p.lon))) }));

/** Where the chart is centred and how much water it shows. */
export function portCentre(profile: string, zoomKm: number) {
  const geo = geoFor(profile);
  const berths = Object.entries(geo.berthPos).filter(([code]) => !code.startsWith('SPM')).map(([, p]) => p);
  const lat = berths.reduce((s, p) => s + p[0], 0) / berths.length;
  const lon = berths.reduce((s, p) => s + p[1], 0) / berths.length;
  return { name: geo.portName, code: geo.portCode, lat: Math.round(lat * 1e4) / 1e4, lon: Math.round(lon * 1e4) / 1e4, zoomKm };
}

/* ------------------------------------------------------------------------- track maths --- */

const R_NM = 3440.065;
const rad = (d: number) => (d * Math.PI) / 180;
/** Great-circle distance in nautical miles — good enough for a track summary at port scale. */
export function distanceNm(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const dLat = rad(b.lat - a.lat); const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R_NM * Math.asin(Math.min(1, Math.sqrt(h))) * 100) / 100;
}
export interface Fix { lat: number; lon: number; sog: number; cog: number; navStatus: string; receivedAt: string }
/** A ship's track over the window, with the ground it covered and the fastest fix on it. */
export function trackSummary(fixes: Fix[]) {
  let distanceNmTotal = 0;
  for (let i = 1; i < fixes.length; i += 1) distanceNmTotal += distanceNm(fixes[i - 1], fixes[i]);
  const speeds = fixes.map((f) => f.sog);
  return {
    fixes: fixes.length,
    from: fixes[0]?.receivedAt ?? null, to: fixes[fixes.length - 1]?.receivedAt ?? null,
    distanceNm: Math.round(distanceNmTotal * 100) / 100,
    maxSpeedKn: speeds.length ? Math.max(...speeds) : 0,
    avgSpeedKn: speeds.length ? Math.round((speeds.reduce((s, v) => s + v, 0) / speeds.length) * 10) / 10 : 0,
  };
}

/* ------------------------------------------------------------------------- publishing --- */

/** A fix is published as a read-model snapshot so the ship register can show her last known position. */
export async function publishPosition(c: Queryable, env: Env, p: PositionRow, vessel?: VesselFacts) {
  const entity = positionApi(p, vessel, env.POSITION_STALE_MIN);
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.upserted, { kind: 'position', entity }, { subject: p.vessel_id }));
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.maritimeCentre.positionUpdated, {
    vesselId: p.vessel_id, vesselName: entity.vessel.name, mmsi: p.mmsi, lat: entity.lat, lon: entity.lon,
    speed: entity.speed, course: entity.course, navStatus: p.nav_status, destination: p.destination, receivedAt: entity.receivedAt,
  }, { subject: p.vessel_id }));
  return entity;
}
export async function publishAlert(c: Queryable, env: Env, a: AlertRow, event: string, data: Row = {}) {
  const entity = alertApi(a);
  await enqueue(c, eventFromContext(env.SERVICE_NAME, event, { alertId: a.id, type: a.type, severity: a.severity, vesselId: a.vessel_id, vesselName: a.vessel_name, note: a.note, at: iso(a.at), alert: entity, ...data }, { subject: a.id }));
  return entity;
}
export async function publishRestriction(c: Queryable, env: Env, r: RestrictionRow, event: string, data: Row = {}) {
  const entity = restrictionApi(r);
  await enqueue(c, eventFromContext(env.SERVICE_NAME, event, { restrictionId: r.id, number: r.number, kind: r.kind, label: r.label, status: r.status, effectiveFrom: iso(r.effective_from), effectiveTo: iso(r.effective_to), restriction: entity, ...data }, { subject: r.id }));
  return entity;
}

export const coverageNote = (profile: string) => `Terrestrial AIS (simulated feed) — ${geoFor(profile).portName} approaches and anchorage sectors`;
export const asNumber = num;
