import type { PoolClient } from 'pg';
import { EVENTS, type EventEnvelope } from '@maritime/contracts';
import type { Queryable } from '@maritime/service-kit';

/* Local snapshots of the facts other domains own. The harbour desk announces calls against the ship register, bills through the
 * rate card and shows the agent's name from the company directory — none of which this service owns. Each is projected from the
 * owning service's read-model events, so a call can be announced without a synchronous hop into another domain. */
type Row = Record<string, any>;

export interface VesselSnapshot { id: string; imo: string; name: string; type: string; flag: string; grt: number | null; dwt: number | null; loa: number | null; maxDraft: number | null; agentCode: string | null; status: string; real: boolean }

export async function upsertVessel(c: Queryable, v: Partial<VesselSnapshot> & { id: string }) {
  await c.query(`INSERT INTO vessels(id, imo, name, type, flag, grt, dwt, loa, max_draft, agent_code, status, real) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (id) DO UPDATE SET imo = EXCLUDED.imo, name = EXCLUDED.name, type = EXCLUDED.type, flag = EXCLUDED.flag, grt = EXCLUDED.grt, dwt = EXCLUDED.dwt, loa = EXCLUDED.loa, max_draft = EXCLUDED.max_draft, agent_code = EXCLUDED.agent_code, status = EXCLUDED.status, real = EXCLUDED.real, updated_at = now()`,
    [String(v.id), v.imo ?? '', v.name ?? '', v.type ?? 'GEN', v.flag ?? '', v.grt ?? null, v.dwt ?? null, v.loa ?? null, v.maxDraft ?? null, v.agentCode ?? null, v.status ?? 'ACTIVE', !!v.real]);
}
export async function upsertCompany(c: Queryable, o: { id: string; code: string; name?: string; category?: string | null; status?: string }) {
  await c.query('INSERT INTO companies(id, code, name, category, status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, category = EXCLUDED.category, status = EXCLUDED.status, updated_at = now()',
    [String(o.id), o.code, o.name ?? '', o.category ?? null, o.status ?? 'ACTIVE']);
}
export async function upsertTariff(c: Queryable, t: { id: string; code: string; name?: string; category?: string | null; unit?: string; rate?: number; currency?: string; active?: boolean }) {
  await c.query('INSERT INTO tariffs(id, code, name, category, unit, rate, currency, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, category = EXCLUDED.category, unit = EXCLUDED.unit, rate = EXCLUDED.rate, currency = EXCLUDED.currency, active = EXCLUDED.active, updated_at = now()',
    [String(t.id), t.code, t.name ?? '', t.category ?? null, t.unit ?? '', t.rate ?? 0, t.currency ?? 'AED', t.active ?? true]);
}
export async function upsertInvoice(c: Queryable, i: Row) {
  await c.query('INSERT INTO invoices(id, number, port_call_id, status, lines, subtotal, tax_amount, total, currency, issued_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, port_call_id = EXCLUDED.port_call_id, status = EXCLUDED.status, lines = EXCLUDED.lines, subtotal = EXCLUDED.subtotal, tax_amount = EXCLUDED.tax_amount, total = EXCLUDED.total, currency = EXCLUDED.currency, issued_at = EXCLUDED.issued_at, updated_at = now()',
    [String(i.id), i.number ?? '', i.portCallId ?? null, i.status ?? 'DRAFT', JSON.stringify(i.lines ?? []), i.subtotal ?? 0, i.taxAmount ?? 0, i.total ?? 0, i.currency ?? 'AED', i.issuedAt ?? null]);
}

/** Tariff heads, keyed by code, as the estimate maths wants them. */
export interface TariffHead { code: string; name: string; unit: string; rate: number; currency: string }
export async function activeTariffs(c: Queryable): Promise<Record<string, TariffHead>> {
  const r = await c.query<{ code: string; name: string; unit: string; rate: string; currency: string }>('SELECT code, name, unit, rate, currency FROM tariffs WHERE active ORDER BY code');
  return Object.fromEntries(r.rows.map((t) => [t.code, { code: t.code, name: t.name, unit: t.unit, rate: Number(t.rate), currency: t.currency }]));
}

const DELETE_TABLE: Record<string, string> = { vessel: 'vessels', company: 'companies', tariff: 'tariffs', invoice: 'invoices' };
/** Applies a read-model event to the local snapshots. Returns whether the event was relevant. */
export async function projectSnapshot(c: PoolClient, event: EventEnvelope): Promise<boolean> {
  const d = (event.data ?? {}) as Row;
  if (event.type === EVENTS.readModel.upserted) {
    const e: Row = d.entity ?? {};
    if (!e.id) return false;
    switch (d.kind) {
      case 'vessel': await upsertVessel(c, { id: e.id, imo: e.imo, name: e.name, type: e.type, flag: e.flag, grt: e.grt, dwt: e.dwt, loa: e.loa, maxDraft: e.maxDraft, agentCode: e.agentCode ?? e.agent, status: e.status, real: !!e.real }); return true;
      case 'company': await upsertCompany(c, { id: e.id, code: e.code, name: e.name, category: e.category, status: e.status }); return true;
      case 'tariff': await upsertTariff(c, { id: e.id, code: e.code, name: e.name, category: e.category, unit: e.unit, rate: Number(e.rate) || 0, currency: e.currency, active: e.active }); return true;
      case 'invoice': await upsertInvoice(c, e); return true;
      default: return false;
    }
  }
  if (event.type === EVENTS.readModel.deleted && DELETE_TABLE[d.kind] && d.id) { await c.query(`DELETE FROM ${DELETE_TABLE[d.kind]} WHERE id = $1`, [String(d.id)]); return true; }
  if (event.type === EVENTS.mdm.vesselUpserted && d.vesselId) { await upsertVessel(c, { id: String(d.vesselId), imo: d.imo, name: d.name, status: d.status }); return true; }
  if (event.type === EVENTS.mdm.companyUpserted && d.company?.id) { await upsertCompany(c, { id: String(d.company.id), code: d.company.code, name: d.company.name, category: d.company.category, status: d.company.status }); return true; }
  return false;
}
