import type { PoolClient } from 'pg';
import { EVENTS, type EventEnvelope } from '@maritime/contracts';
import type { Queryable } from '@maritime/service-kit';
import type { Row } from './incidents';

/* Local snapshots of the facts other domains own. A case is raised against a ship the register owns and located
 * at a berth the port owns; the traffic picture names its targets from the same ship register. Both are
 * projected from their read-model events so the desk renders and validates from one database. */

export async function upsertVessel(c: Queryable, v: Row) {
  await c.query(`INSERT INTO vessels(id, imo, mmsi, name, type, flag, status, real) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (id) DO UPDATE SET imo = EXCLUDED.imo, mmsi = EXCLUDED.mmsi, name = EXCLUDED.name, type = EXCLUDED.type, flag = EXCLUDED.flag,
      status = EXCLUDED.status, real = EXCLUDED.real, updated_at = now()`,
    [String(v.id), v.imo ?? '', v.mmsi ?? '', v.name ?? '', v.type ?? 'GEN', v.flag ?? '', v.status ?? 'ACTIVE', !!v.real]);
}
export async function upsertBerth(c: Queryable, b: Row) {
  await c.query(`INSERT INTO berths(id, code, name, terminal, status) VALUES ($1,$2,$3,$4,$5)
    ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, terminal = EXCLUDED.terminal, status = EXCLUDED.status, updated_at = now()`,
    [String(b.id), b.code ?? '', b.name ?? '', b.terminal ?? '', b.status ?? 'OPERATIONAL']);
}

const DELETE_TABLE: Record<string, string> = { vessel: 'vessels', berth: 'berths' };

/** Applies a read-model event to the local snapshots. Returns the kind it recognised, or null. */
export async function projectSnapshot(c: PoolClient, event: EventEnvelope): Promise<string | null> {
  const d = (event.data ?? {}) as Row;
  if (event.type === EVENTS.readModel.upserted) {
    const e: Row = d.entity ?? {};
    if (!e.id) return null;
    switch (d.kind) {
      case 'vessel': await upsertVessel(c, e); return 'vessel';
      case 'berth': await upsertBerth(c, e); return 'berth';
      default: return null;
    }
  }
  if (event.type === EVENTS.readModel.deleted && DELETE_TABLE[d.kind] && d.id) { await c.query(`DELETE FROM ${DELETE_TABLE[d.kind]} WHERE id = $1`, [String(d.id)]); return null; }
  if (event.type === EVENTS.mdm.vesselUpserted && d.vesselId) { await upsertVessel(c, { id: String(d.vesselId), imo: d.imo, name: d.name, status: d.status }); return 'vessel'; }
  return null;
}

/* An open case that names a ship keeps her name on its own row, so the register reads without a join into a
 * snapshot that may not have arrived yet. When the ship register renames her, the live cases are corrected —
 * closed ones are left alone, because a closed case records what was reported at the time. */
export async function refreshOpenIncidents(c: PoolClient, vessel: Row, live: readonly string[]): Promise<string[]> {
  const r = await c.query<{ id: string }>(
    `UPDATE incidents SET vessel_name = $2, updated_at = now() WHERE vessel_id::text = $1 AND status = ANY($3) AND vessel_name <> $2 RETURNING id`,
    [String(vessel.id), vessel.name ?? '', live]);
  return r.rows.map((x) => x.id);
}

/* A fix that arrives on the bus for a ship this service has never heard of still belongs on the picture: the
 * target is real whatever the register knows. The name travels with the fix so the chart can label it. */
export async function upsertPositionFromEvent(c: Queryable, d: Row): Promise<string | null> {
  const vesselId = String(d.vesselId ?? d.id ?? '');
  if (!vesselId || d.lat == null || d.lon == null) return null;
  await c.query(`INSERT INTO positions(vessel_id, vessel_name, mmsi, lat, lon, sog, cog, heading, nav_status, destination, source, received_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12, now()))
    ON CONFLICT (vessel_id) DO UPDATE SET vessel_name = EXCLUDED.vessel_name, mmsi = EXCLUDED.mmsi, lat = EXCLUDED.lat, lon = EXCLUDED.lon, sog = EXCLUDED.sog,
      cog = EXCLUDED.cog, heading = EXCLUDED.heading, nav_status = EXCLUDED.nav_status, destination = EXCLUDED.destination, source = EXCLUDED.source,
      received_at = EXCLUDED.received_at, updated_at = now()`,
    [vesselId, d.vesselName ?? '', d.mmsi ?? '', Number(d.lat), Number(d.lon), Number(d.speed ?? d.sog) || 0, Math.round(Number(d.course ?? d.cog) || 0),
      Math.round(Number(d.heading ?? d.course ?? d.cog) || 0), d.navStatus ?? 'UNDERWAY', d.destination ?? '', d.source ?? 'AIS-T (simulated)', d.receivedAt ?? null]);
  await c.query('INSERT INTO position_history(vessel_id, lat, lon, sog, cog, nav_status, received_at) VALUES ($1,$2,$3,$4,$5,$6, COALESCE($7, now())) ON CONFLICT DO NOTHING',
    [vesselId, Number(d.lat), Number(d.lon), Number(d.speed ?? d.sog) || 0, Math.round(Number(d.course ?? d.cog) || 0), d.navStatus ?? 'UNDERWAY', d.receivedAt ?? null]);
  return vesselId;
}

/** Keeps the track to the window the watch actually looks at; the picture is a watch tool, not an archive. */
export async function pruneTrack(c: Queryable, hours: number) {
  const r = await c.query(`DELETE FROM position_history WHERE received_at < now() - ($1 || ' hours')::interval`, [hours]);
  return r.rowCount ?? 0;
}
