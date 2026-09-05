import type { PoolClient } from 'pg';
import { EVENTS, type EventEnvelope } from '@maritime/contracts';
import type { Queryable } from '@maritime/service-kit';
import type { Row } from './inspections';

/* Local snapshots of the facts other domains own. A survey is raised against a ship the register owns and is
 * usually attached to a call the harbour desk owns; the deficiency and action codes come from the master data
 * service. All three are projected from their read-model events, so the survey register renders and validates
 * from one database rather than three synchronous hops — and so a survey planned against a ship keeps her name
 * and IMO on its own row when the register later changes them. */

export async function upsertVessel(c: Queryable, v: Row) {
  await c.query(`INSERT INTO vessels(id, imo, name, type, flag, grt, built, agent_code, status, real) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO UPDATE SET imo = EXCLUDED.imo, name = EXCLUDED.name, type = EXCLUDED.type, flag = EXCLUDED.flag, grt = EXCLUDED.grt, built = EXCLUDED.built,
      agent_code = EXCLUDED.agent_code, status = EXCLUDED.status, real = EXCLUDED.real, updated_at = now()`,
    [String(v.id), v.imo ?? '', v.name ?? '', v.type ?? 'GEN', v.flag ?? '', v.grt ?? null, v.built ?? null, v.agentCode ?? v.agent ?? null, v.status ?? 'ACTIVE', !!v.real]);
}
export async function upsertPortCall(c: Queryable, p: Row) {
  /* `scopePort` arrives stamped by the service that owns the call and is projected as it came. Writing it
   * moves the inspections raised against this call with it, through the trigger the migration installed. */
  await c.query(`INSERT INTO port_calls(id, vcn, vessel_id, status, berth_code, eta, atb, atd, scope_port) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (id) DO UPDATE SET vcn = EXCLUDED.vcn, vessel_id = EXCLUDED.vessel_id, status = EXCLUDED.status, berth_code = EXCLUDED.berth_code,
      eta = EXCLUDED.eta, atb = EXCLUDED.atb, atd = EXCLUDED.atd, scope_port = EXCLUDED.scope_port, updated_at = now()`,
    [String(p.id), p.vcn ?? '', String(p.vesselId ?? ''), p.status ?? 'ANNOUNCED', p.berthCode ?? null, p.eta ?? null, p.atb ?? null, p.atd ?? null, p.scopePort ?? '']);
}
/** The deficiency master, so a finding carries the label and category the register knows the code by. */
export async function deficiencyMaster(c: Queryable, code: string): Promise<{ label: string; category: string } | null> {
  const r = await c.query<{ label: string; meta: Row }>(`SELECT label, meta FROM lookup_mirror WHERE category = 'deficiencyCode' AND code = $1 AND active LIMIT 1`, [code]);
  const row = r.rows[0];
  return row ? { label: row.label, category: String(row.meta?.category ?? '') } : null;
}

const DELETE_TABLE: Record<string, string> = { vessel: 'vessels', portCall: 'port_calls' };

/** Applies a read-model event to the local snapshots. Returns whether the event was relevant. */
export async function projectSnapshot(c: PoolClient, event: EventEnvelope): Promise<boolean> {
  const d = (event.data ?? {}) as Row;
  if (event.type === EVENTS.readModel.upserted) {
    const e: Row = d.entity ?? {};
    if (!e.id) return false;
    switch (d.kind) {
      case 'vessel': await upsertVessel(c, e); return true;
      case 'portCall': await upsertPortCall(c, e); return true;
      default: return false;
    }
  }
  if (event.type === EVENTS.readModel.deleted && DELETE_TABLE[d.kind] && d.id) { await c.query(`DELETE FROM ${DELETE_TABLE[d.kind]} WHERE id = $1`, [String(d.id)]); return true; }
  if (event.type === EVENTS.mdm.vesselUpserted && d.vesselId) { await upsertVessel(c, { id: String(d.vesselId), imo: d.imo, name: d.name, status: d.status }); return true; }
  return false;
}

/* A survey that was planned before its ship's particulars changed keeps stale facts on its own row. When the
 * register republishes the ship, the open surveys against her are refreshed — closed ones are left exactly as
 * they were, because a closed survey is a record of what was found on the day. */
export async function refreshOpenInspections(c: PoolClient, vessel: Row): Promise<string[]> {
  const r = await c.query<{ id: string }>(
    `UPDATE inspections SET vessel_name = $2, vessel_imo = $3, vessel_flag = $4, vessel_type = $5, updated_at = now()
       WHERE vessel_id::text = $1 AND status <> 'CLOSED'
         AND (vessel_name <> $2 OR vessel_imo <> $3 OR vessel_flag <> $4 OR vessel_type <> $5) RETURNING id`,
    [String(vessel.id), vessel.name ?? '', vessel.imo ?? '', vessel.flag ?? '', vessel.type ?? '']);
  return r.rows.map((x) => x.id);
}
