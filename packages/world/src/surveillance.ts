import { Prng, D, H, stableId, iso } from './prng';
import { usersByRole, type WorldUser } from './people';
import type { WorldVessel } from './vessels';
import type { WorldPortCall } from './operations';
import { geoFor } from './geo';

export type NavStatus = 'MOORED' | 'AT_ANCHOR' | 'UNDERWAY' | 'RESTRICTED';
export type MdaAlertType = 'AIS_GAP' | 'SPEED_IN_CHANNEL' | 'ZONE_ENTRY' | 'ANCHOR_DRIFT' | 'CLOSE_QUARTERS';
/** Simulated AIS picture — one target per tracked vessel around the port. */
export interface WorldPosition { id: string; vesselId: string; vesselName: string; mmsi: string; lat: number; lon: number; sog: number; cog: number; heading: number; navStatus: NavStatus; destination: string; timestamp: string; source: string }
export interface WorldMdaAlert { id: string; type: MdaAlertType; severity: 'info' | 'warning' | 'error'; vesselId: string | null; vesselName: string; note: string; at: string; acknowledged: boolean; acknowledgedById: string | null; acknowledgedBy: string; acknowledgedAt: string | null }

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
/** Berthed, anchored and inbound targets from the live calls, some transiting traffic, one target restricted in her ability to manoeuvre; alerts never involve a documented liner caller. */
export function buildSurveillance(rng: Prng, profile: string, users: WorldUser[], vessels: WorldVessel[], portCalls: WorldPortCall[], now: Date): { positions: WorldPosition[]; mdaAlerts: WorldMdaAlert[] } {
  const geo = geoFor(profile); const vById = new Map(vessels.map((v) => [v.id, v]));
  const positions: WorldPosition[] = []; const seen = new Set<string>();
  const put = (v: WorldVessel | undefined, lat: number, lon: number, sog: number, cog: number, navStatus: NavStatus, destination: string, minutesAgo: number) => {
    if (!v || seen.has(v.id)) return; seen.add(v.id);
    positions.push({ id: stableId('position', v.id), vesselId: v.id, vesselName: v.name, mmsi: v.mmsi, lat: r4(lat), lon: r4(lon), sog, cog, heading: navStatus === 'MOORED' ? cog : (cog + rng.int(-3, 3) + 360) % 360, navStatus, destination, timestamp: iso(now.getTime() - minutesAgo * 60000), source: 'AIS-T (simulated)' });
  };
  for (const c of portCalls.filter((x) => x.status === 'BERTHED')) { const p = geo.berthPos[c.berthCode ?? ''] ?? geo.berthPos['CT1-1']; put(vById.get(c.vesselId), p[0], p[1], 0, 210, 'MOORED', geo.portCode, rng.int(1, 4)); }
  portCalls.filter((x) => x.status === 'AT_ANCHORAGE').forEach((c, i) => put(vById.get(c.vesselId), geo.anchorage[0] + (i % 3) * 0.014, geo.anchorage[1] + Math.floor(i / 3) * 0.02, 0.1, 320, 'AT_ANCHOR', geo.portCode, rng.int(2, 6)));
  portCalls.filter((x) => x.status === 'CONFIRMED').forEach((c, i) => put(vById.get(c.vesselId), geo.approach[0] - 0.08 - i * 0.05, geo.approach[1] - 0.10 - i * 0.06, rng.int(9, 13), 38, 'UNDERWAY', geo.portCode, rng.int(1, 3)));
  // transiting traffic not bound for the port, and one target restricted in her ability to manoeuvre
  const others = vessels.filter((v) => !v.real && !seen.has(v.id));
  others.slice(0, 3).forEach((v, i) => put(v, geo.approach[0] - 0.4 + i * 0.06, geo.approach[1] - 0.3 + i * 0.11, rng.int(10, 14), i === 1 ? 255 : 82, 'UNDERWAY', i === 1 ? 'AEJEA' : 'INNSA', rng.int(1, 5)));
  put(others[3], geo.approach[0] - 0.27, geo.approach[1] + 0.07, 2.8, 212, 'RESTRICTED', 'CHANNEL SURVEY', 2);
  const duty = usersByRole(users, 'NMC Duty Officer').slice(0, 4); const fleet = vessels.filter((v) => !v.real);
  const anchored = portCalls.find((x) => x.status === 'AT_ANCHORAGE' && !vById.get(x.vesselId)?.real); const driftV = anchored ? vById.get(anchored.vesselId)! : fleet[8];
  const mk = (type: MdaAlertType, severity: WorldMdaAlert['severity'], v: WorldVessel, note: string, at: Date, ack: WorldUser | null): WorldMdaAlert => ({ id: stableId('mda', `${type}:${iso(at)}:${v.id}`), type, severity, vesselId: v.id, vesselName: v.name, note, at: iso(at), acknowledged: !!ack, acknowledgedById: ack?.id ?? null, acknowledgedBy: ack?.name ?? '', acknowledgedAt: ack ? iso(at.getTime() + (18 + rng.int(0, 4) * 22) * 60000) : null });
  const mdaAlerts: WorldMdaAlert[] = [
    mk('AIS_GAP', 'warning', others[0] ?? fleet[0], 'No AIS transmission for 42 min in covered sector; last SOG 11.5 kn', new Date(now.getTime() - 40 * 60000), null),
    mk('SPEED_IN_CHANNEL', 'warning', fleet[2], '11.8 kn in approach channel (limit 8 kn)', new Date(now.getTime() - 3 * H), null),
    mk('ANCHOR_DRIFT', 'error', driftV, 'Position moved 0.28 nm from anchor drop point; wind 22 kn', new Date(now.getTime() - 55 * 60000), null),
    mk('ZONE_ENTRY', 'info', others[1] ?? fleet[10], 'Entered port limits without pre-arrival notification on file', new Date(now.getTime() - 6 * H), null),
    mk('CLOSE_QUARTERS', 'error', fleet[5], 'CPA 0.18 nm / TCPA 6 min with anchored tanker east of A1; both targets called on Ch 16', new Date(now.getTime() - 22 * 60000), null),
    mk('AIS_GAP', 'info', fleet[7], 'Transmission resumed after a 12 min gap; track re-established automatically', new Date(now.getTime() - 4.5 * H), null),
  ];
  // the acknowledged back-catalogue — a year of the watch actually working the rail
  const types: MdaAlertType[] = ['AIS_GAP', 'SPEED_IN_CHANNEL', 'ZONE_ENTRY', 'ANCHOR_DRIFT', 'CLOSE_QUARTERS'];
  const note = (t: MdaAlertType, k: number) => ({ AIS_GAP: `No AIS transmission for ${28 + (k % 5) * 7} min in the covered sector; track re-established`, SPEED_IN_CHANNEL: `${(9.4 + (k % 4) * 0.8).toFixed(1)} kn in the approach channel (limit 8 kn); master cautioned on Ch 12`,
    ZONE_ENTRY: 'Entered port limits without pre-arrival notification on file; agent contacted', ANCHOR_DRIFT: `Position moved 0.${18 + (k % 4) * 4} nm from the anchor drop point; re-anchored under pilot advice`, CLOSE_QUARTERS: `CPA 0.${2 + (k % 3)} nm in the anchorage approaches; both targets called on Ch 16` }[t]);
  for (let k = 0; k < 38; k++) { const type = types[k % 5]; mdaAlerts.push(mk(type, k % 9 === 0 ? 'error' : k % 3 === 0 ? 'info' : 'warning', fleet[(k * 3 + 1) % fleet.length], note(type, k), new Date(now.getTime() - (26 + k * 9.6) * D + (k % 7) * H), duty[k % duty.length])); }
  return { positions, mdaAlerts: mdaAlerts.sort((a, b) => a.at.localeCompare(b.at)) };
}
