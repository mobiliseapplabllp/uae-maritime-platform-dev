import type { PoolClient } from 'pg';
import { EVENTS, type EventEnvelope } from '@maritime/contracts';
import type { Queryable } from '@maritime/service-kit';
import type { BillTo, BillableCall, CallCargoOp, CallService, TariffHead } from './invoicing';

/* Local snapshots of what billing needs from the rest of the platform: the call as the ports service last published it,
 * the ship register and the company directory. Fed by read-model events, so raising an invoice never calls another domain. */
type Row = Record<string, any>;

export interface CallSnapshot {
  id: string; vcn: string; vessel_id: string | null; vessel_name: string; vessel_imo: string; agent_code: string; agent_name: string; status: string;
  eta: Date | null; etb: Date | null; etd: Date | null; ata: Date | null; atb: Date | null; atd: Date | null; berth_code: string | null;
  services: Row[]; cargo_ops: Row[]; vessel: Row;
}

export async function upsertCall(c: Queryable, e: Row) {
  await c.query(`INSERT INTO port_calls(id, vcn, vessel_id, vessel_name, vessel_imo, agent_code, agent_name, status, eta, etb, etd, ata, atb, atd, berth_code, services, cargo_ops, vessel)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    ON CONFLICT (id) DO UPDATE SET vcn = EXCLUDED.vcn, vessel_id = EXCLUDED.vessel_id, vessel_name = EXCLUDED.vessel_name, vessel_imo = EXCLUDED.vessel_imo, agent_code = EXCLUDED.agent_code, agent_name = EXCLUDED.agent_name, status = EXCLUDED.status,
      eta = EXCLUDED.eta, etb = EXCLUDED.etb, etd = EXCLUDED.etd, ata = EXCLUDED.ata, atb = EXCLUDED.atb, atd = EXCLUDED.atd, berth_code = EXCLUDED.berth_code, services = EXCLUDED.services, cargo_ops = EXCLUDED.cargo_ops, vessel = EXCLUDED.vessel, updated_at = now()`,
    [String(e.id), e.vcn ?? '', e.vesselId ?? null, e.vesselName ?? '', e.vesselImo ?? '', e.agentCode ?? '', e.agentName ?? '', e.status ?? '', e.eta ?? null, e.etb ?? null, e.etd ?? null, e.ata ?? null, e.atb ?? null, e.atd ?? null, e.berthCode ?? null,
      JSON.stringify(e.services ?? []), JSON.stringify(e.cargoOps ?? []), JSON.stringify(e.vessel ?? {})]);
}
export async function upsertVessel(c: Queryable, v: Row) {
  await c.query(`INSERT INTO vessels(id, imo, name, type, flag, grt, dwt, loa, max_draft, agent_code, status, real) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (id) DO UPDATE SET imo = EXCLUDED.imo, name = EXCLUDED.name, type = EXCLUDED.type, flag = EXCLUDED.flag, grt = EXCLUDED.grt, dwt = EXCLUDED.dwt, loa = EXCLUDED.loa, max_draft = EXCLUDED.max_draft, agent_code = EXCLUDED.agent_code, status = EXCLUDED.status, real = EXCLUDED.real, updated_at = now()`,
    [String(v.id), v.imo ?? '', v.name ?? '', v.type ?? 'GEN', v.flag ?? '', v.grt ?? null, v.dwt ?? null, v.loa ?? null, v.maxDraft ?? null, v.agentCode ?? null, v.status ?? 'ACTIVE', !!v.real]);
}
export async function upsertCompany(c: Queryable, o: Row) {
  await c.query('INSERT INTO companies(id, code, name, address, tax_id, category, status) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, address = EXCLUDED.address, tax_id = EXCLUDED.tax_id, category = EXCLUDED.category, status = EXCLUDED.status, updated_at = now()',
    [String(o.id), o.code, o.name ?? '', o.address ?? '', o.taxId ?? o.gstin ?? '', o.category ?? null, o.status ?? 'ACTIVE']);
}

export async function findCallSnapshot(c: Queryable, ref: string): Promise<CallSnapshot | null> {
  const r = await c.query<CallSnapshot>('SELECT * FROM port_calls WHERE id = $1 OR vcn = $1', [ref]);
  return r.rows[0] ?? null;
}
/** The snapshot in the shape the invoice maths wants, with the ship's particulars merged in. */
export async function billableCall(c: Queryable, snap: CallSnapshot): Promise<BillableCall & { vesselId: string | null; vesselImo: string; agentCode: string; agentName: string }> {
  const v = snap.vessel ?? {};
  const reg = snap.vessel_id ? (await c.query<{ grt: number | null; loa: string | null; imo: string; name: string }>('SELECT grt, loa, imo, name FROM vessels WHERE id = $1', [snap.vessel_id])).rows[0] : undefined;
  return {
    vcn: snap.vcn, vesselName: snap.vessel_name || reg?.name || v.name || '', vesselId: snap.vessel_id, vesselImo: snap.vessel_imo || reg?.imo || v.imo || '',
    grt: v.grt ?? reg?.grt ?? null, loa: v.loa ?? (reg?.loa != null ? Number(reg.loa) : null),
    services: (snap.services ?? []) as CallService[], cargoOps: (snap.cargo_ops ?? []) as CallCargoOp[],
    ata: snap.ata ? snap.ata.toISOString() : null, atb: snap.atb ? snap.atb.toISOString() : null, atd: snap.atd ? snap.atd.toISOString() : null,
    agentCode: snap.agent_code, agentName: snap.agent_name,
  };
}
/** Who the account is raised against: the agent from the directory, else the name the call carries. */
export async function billToFor(c: Queryable, agentCode: string, agentName: string, taxIdLabel: string): Promise<BillTo> {
  const co = agentCode ? (await c.query<{ id: string; name: string; address: string; tax_id: string }>('SELECT id, name, address, tax_id FROM companies WHERE code = $1', [agentCode])).rows[0] : undefined;
  return { companyId: co?.id ?? null, name: co?.name || agentName || agentCode || 'Master / Owners', address: co?.address ?? '', taxId: co?.tax_id ?? '', taxIdLabel };
}
export async function activeTariffs(c: Queryable): Promise<Record<string, TariffHead>> {
  const r = await c.query<{ code: string; name: string; unit: string; rate: string; currency: string }>('SELECT code, name, unit, rate, currency FROM tariffs WHERE active ORDER BY code');
  return Object.fromEntries(r.rows.map((t) => [t.code, { code: t.code, name: t.name, unit: t.unit, rate: Number(t.rate), currency: t.currency }]));
}

const DELETE_TABLE: Record<string, string> = { portCall: 'port_calls', vessel: 'vessels', company: 'companies' };
/** Applies a read-model event to the local snapshots. Returns whether the event was relevant. */
export async function projectSnapshot(c: PoolClient, event: EventEnvelope): Promise<boolean> {
  const d = (event.data ?? {}) as Row;
  if (event.type === EVENTS.readModel.upserted) {
    const e: Row = d.entity ?? {}; if (!e.id) return false;
    switch (d.kind) {
      case 'portCall': await upsertCall(c, e); return true;
      case 'vessel': await upsertVessel(c, e); return true;
      case 'company': await upsertCompany(c, e); return true;
      default: return false;
    }
  }
  if (event.type === EVENTS.readModel.deleted && DELETE_TABLE[d.kind] && d.id) { await c.query(`DELETE FROM ${DELETE_TABLE[d.kind]} WHERE id = $1`, [String(d.id)]); return true; }
  if (event.type === EVENTS.mdm.companyUpserted && d.company?.id) { await upsertCompany(c, d.company); return true; }
  return false;
}
