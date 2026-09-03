import { randomUUID } from 'node:crypto';
import { EVENTS, makeEvent, type Actor, type EventEnvelope, type PortCallStatus } from '@maritime/contracts';
import { enqueue, eventFromContext, nextNumber, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { HOUR, iso, num, round1 } from './history';

/* The vessel-call row and everything both the API and the event consumer do to it: the API shape, numbering, patching,
 * the derived documents (statement of facts, movements) and the read-model snapshot every write publishes. */
export const ACTIVE_STATUSES: PortCallStatus[] = ['CONFIRMED', 'AT_ANCHORAGE', 'BERTHED'];
export const OPEN_STATUSES: PortCallStatus[] = ['ANNOUNCED', ...ACTIVE_STATUSES];
export const CLOSED_STATUSES: PortCallStatus[] = ['SAILED', 'CANCELLED'];
export const SERVICE_TYPES = ['PILOTAGE', 'TUGS', 'BERTH_HIRE', 'FRESH_WATER', 'GARBAGE', 'ANCHORAGE', 'MOORING', 'OTHER'] as const;
export const CARGO_UNITS = ['MT', 'TEU', 'UNITS'] as const;
export const CARGO_OPERATIONS = ['DISCHARGE', 'LOAD'] as const;
/** Tonnage equivalents for throughput statistics: a laden TEU is taken at 12 t, a ro-ro unit at 1.5 t. */
export const MT_FACTOR: Record<string, number> = { MT: 1, TEU: 12, UNITS: 1.5 };
export const toMT = (qty: number, unit: string) => Math.round(qty * (MT_FACTOR[unit] ?? 1));

export interface CallService { id: string; type: string; tariffCode: string; description: string; qty: number; unit: string; at: string | null; remarks: string; createdAt: string }
export interface CargoOp { id: string; cargoType: string; operation: 'DISCHARGE' | 'LOAD'; qty: number; unit: 'MT' | 'TEU' | 'UNITS'; qtyMT: number; gangs: number; startedAt: string | null; completedAt: string | null; remarks: string; createdAt: string }
export interface SofEntry { id: string; at: string; event: string; detail: string; by: string }
export interface HistoryEntry { from: string; to: string; at: string; by: string; note: string }
export interface PdaLine { code: string; description: string; unit: string; qty: number; rate: number; amount: number }
export interface Pda { number: string; lines: PdaLine[]; subtotal: number; taxRate: number; taxAmount: number; total: number; currency: string; basis: { grt: number; plannedDays: number; tugs: number }; generatedAt: string; generatedBy: string }
export interface Crew { count: number; master: string }
export interface Row {
  id: string; vcn: string; vessel_id: string; vessel_name: string; vessel_imo: string; vessel_type: string | null; vessel_flag: string | null; agent_code: string; agent_name: string; purpose: string; status: string;
  eta: Date; etb: Date | null; etd: Date | null; ata: Date | null; atb: Date | null; atd: Date | null; berth_id: string | null; berth_code: string | null; prev_port: string; next_port: string;
  draft_arrival: string | null; draft_departure: string | null; crew: Crew; remarks: string; detention: boolean; services: CallService[]; cargo_ops: CargoOp[]; sof_entries: SofEntry[]; status_history: HistoryEntry[]; pda: Pda | null; created_at: Date; updated_at: Date;
}
/** The row joined with the berth it holds and the ship's registered facts. */
export interface View extends Row { berth_name: string | null; berth_terminal: string | null; berth_type: string | null; v_grt: number | null; v_dwt: number | null; v_loa: string | null; v_max_draft: string | null; v_status: string | null; v_type: string | null; v_flag: string | null; v_real: boolean | null }
export const VIEW_SQL = 'SELECT pc.*, b.name AS berth_name, b.terminal AS berth_terminal, b.berth_type AS berth_type, v.grt AS v_grt, v.dwt AS v_dwt, v.loa AS v_loa, v.max_draft AS v_max_draft, v.status AS v_status, v.type AS v_type, v.flag AS v_flag, v.real AS v_real FROM port_calls pc LEFT JOIN berths b ON b.id = pc.berth_id LEFT JOIN vessels v ON v.id = pc.vessel_id';

export function toApi(r: View) {
  const services = r.services ?? []; const cargoOps = r.cargo_ops ?? [];
  const now = Date.now();
  return {
    id: r.id, vcn: r.vcn, status: r.status as PortCallStatus,
    vesselId: r.vessel_id, vesselName: r.vessel_name, vesselImo: r.vessel_imo, vesselType: r.vessel_type ?? r.v_type ?? null, vesselFlag: r.vessel_flag ?? r.v_flag ?? null, vesselGrt: r.v_grt ?? null, vesselDwt: r.v_dwt ?? null, vesselLoa: num(r.v_loa), vesselMaxDraft: num(r.v_max_draft), vesselReal: !!r.v_real,
    berthId: r.berth_id, berthCode: r.berth_code, berthName: r.berth_name, berthTerminal: r.berth_terminal, agentCode: r.agent_code, agentName: r.agent_name, purpose: r.purpose,
    eta: iso(r.eta)!, etb: iso(r.etb), etd: iso(r.etd), ata: iso(r.ata), atb: iso(r.atb), atd: iso(r.atd), prevPort: r.prev_port, nextPort: r.next_port, draftArrival: num(r.draft_arrival), draftDeparture: num(r.draft_departure), crew: r.crew ?? { count: 0, master: '' }, remarks: r.remarks, detention: r.detention,
    vessel: { id: r.vessel_id, name: r.vessel_name, imo: r.vessel_imo, type: r.vessel_type ?? r.v_type ?? null, flag: r.vessel_flag ?? r.v_flag ?? null, grt: r.v_grt ?? null, dwt: r.v_dwt ?? null, loa: num(r.v_loa), maxDraft: num(r.v_max_draft), status: r.v_status ?? null, real: !!r.v_real },
    berth: r.berth_id ? { id: r.berth_id, code: r.berth_code, name: r.berth_name, terminal: r.berth_terminal, berthType: r.berth_type } : null,
    services, cargoOps, sofEntries: r.sof_entries ?? [], statusHistory: r.status_history ?? [], pda: r.pda ?? null,
    cargoMT: cargoOps.reduce((s, o) => s + Number(o.qtyMT || 0), 0), teu: cargoOps.filter((o) => o.unit === 'TEU').reduce((s, o) => s + Number(o.qty || 0), 0),
    waitingHours: r.ata && r.atb ? round1((r.atb.getTime() - r.ata.getTime()) / HOUR) : null,
    alongsideHours: r.atb ? round1(((r.atd?.getTime() ?? now) - r.atb.getTime()) / HOUR) : null,
    turnaroundHours: r.ata && r.atd ? round1((r.atd.getTime() - r.ata.getTime()) / HOUR) : null,
    createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  };
}
export type CallApi = ReturnType<typeof toApi>;

export async function findCall(c: Queryable, idOrVcn: string): Promise<View | null> {
  const r = await c.query<View>(`${VIEW_SQL} WHERE pc.id::text = $1 OR pc.vcn = $1`, [idOrVcn]); return r.rows[0] ?? null;
}
export async function lockCall(c: Queryable, idOrVcn: string): Promise<View | null> {
  const l = await c.query<{ id: string }>('SELECT id FROM port_calls WHERE id::text = $1 OR vcn = $1 FOR UPDATE', [idOrVcn]);
  return l.rows[0] ? findCall(c, l.rows[0].id) : null;
}
const COLS: Record<string, string> = { status: 'status', vesselId: 'vessel_id', vesselName: 'vessel_name', vesselImo: 'vessel_imo', vesselType: 'vessel_type', vesselFlag: 'vessel_flag', agentCode: 'agent_code', agentName: 'agent_name', purpose: 'purpose', eta: 'eta', etb: 'etb', etd: 'etd', ata: 'ata', atb: 'atb', atd: 'atd', berthId: 'berth_id', berthCode: 'berth_code', prevPort: 'prev_port', nextPort: 'next_port', draftArrival: 'draft_arrival', draftDeparture: 'draft_departure', crew: 'crew', remarks: 'remarks', detention: 'detention', services: 'services', cargoOps: 'cargo_ops', sofEntries: 'sof_entries', statusHistory: 'status_history', pda: 'pda' };
export type Patch = Partial<{ status: string; vesselId: string; vesselName: string; vesselImo: string; vesselType: string | null; vesselFlag: string | null; agentCode: string; agentName: string; purpose: string; eta: Date; etb: Date | null; etd: Date | null; ata: Date | null; atb: Date | null; atd: Date | null; berthId: string | null; berthCode: string | null; prevPort: string; nextPort: string; draftArrival: number | null; draftDeparture: number | null; crew: Crew; remarks: string; detention: boolean; services: CallService[]; cargoOps: CargoOp[]; sofEntries: SofEntry[]; statusHistory: HistoryEntry[]; pda: Pda | null }>;
export async function updateCall(c: Queryable, id: string, patch: Patch): Promise<View> {
  const keys = Object.keys(patch).filter((k) => COLS[k] && (patch as Record<string, unknown>)[k] !== undefined);
  if (keys.length) {
    const vals = keys.map((k) => { const v = (patch as Record<string, unknown>)[k]; return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v; });
    await c.query(`UPDATE port_calls SET ${keys.map((k, i) => `${COLS[k]} = $${i + 2}`).concat('updated_at = now()').join(', ')} WHERE id = $1`, [id, ...vals]);
  }
  return (await findCall(c, id))!;
}
export interface NewCall { vcn: string; vesselId: string; vesselName: string; vesselImo: string; vesselType?: string | null; vesselFlag?: string | null; agentCode?: string; agentName?: string; purpose?: string; status?: string; eta: Date; etb?: Date | null; etd?: Date | null; berthId?: string | null; berthCode?: string | null; prevPort?: string; nextPort?: string; draftArrival?: number | null; crew?: Crew; remarks?: string; statusHistory: HistoryEntry[] }
export async function insertCall(c: Queryable, n: NewCall): Promise<View> {
  const r = await c.query<{ id: string }>('INSERT INTO port_calls(vcn, vessel_id, vessel_name, vessel_imo, vessel_type, vessel_flag, agent_code, agent_name, purpose, status, eta, etb, etd, berth_id, berth_code, prev_port, next_port, draft_arrival, crew, remarks, status_history) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id',
    [n.vcn, n.vesselId, n.vesselName, n.vesselImo, n.vesselType ?? null, n.vesselFlag ?? null, n.agentCode ?? '', n.agentName ?? '', n.purpose ?? '', n.status ?? 'ANNOUNCED', n.eta, n.etb ?? null, n.etd ?? null, n.berthId ?? null, n.berthCode ?? null, n.prevPort ?? '', n.nextPort ?? '', n.draftArrival ?? null, JSON.stringify(n.crew ?? { count: 0, master: '' }), n.remarks ?? '', JSON.stringify(n.statusHistory)]);
  return (await findCall(c, r.rows[0].id))!;
}
/** `${prefix}-YYYY-NNNNN`: one atomic series per calendar year of the ETA. */
export async function nextVcn(c: Queryable, env: Env, eta: Date): Promise<string> {
  const series = `${env.VCN_PREFIX}-${eta.getUTCFullYear()}`; return nextNumber(c, series, `${series}-`, 5);
}
export const newId = () => randomUUID();
export const stamp = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

export interface SofEvent { at: string; event: string; detail: string; source: 'CALL' | 'STATUS' | 'CARGO' | 'SERVICE' | 'ENTRY' }
const fmtQty = (n: number) => new Intl.NumberFormat('en-AE').format(n);
/** Statement of Facts — the chronological port-stay record, compiled from what the call already carries plus the entries the desk typed in. */
export function sofOf(call: CallApi): SofEvent[] {
  const ev: SofEvent[] = [];
  const push = (at: string | null | undefined, event: string, detail: string, source: SofEvent['source']) => { if (at) ev.push({ at: new Date(at).toISOString(), event, detail: detail || '', source }); };
  push(call.createdAt, 'Vessel call announced', `VCN ${call.vcn} issued to ${call.agentName || call.agentCode || 'agent'}`, 'CALL');
  for (const h of call.statusHistory) if (h.from) push(h.at, `Status: ${String(h.from).replace(/_/g, ' ')} → ${String(h.to).replace(/_/g, ' ')}`, h.note, 'STATUS');
  push(call.ata, 'Arrived pilot station / anchorage', call.draftArrival ? `Arrival draft ${call.draftArrival} m` : '', 'CALL');
  push(call.atb, `All fast alongside ${call.berthCode ?? ''}`.trim(), call.berthTerminal ?? '', 'CALL');
  for (const c of call.cargoOps) {
    const what = `${c.operation === 'LOAD' ? 'Loading' : 'Discharge'} ${c.cargoType} — ${fmtQty(Number(c.qty))} ${c.unit}`;
    push(c.startedAt, `${what} commenced`, c.gangs ? `${c.gangs} gangs` : '', 'CARGO');
    push(c.completedAt, `${what} completed`, c.remarks, 'CARGO');
  }
  for (const s of call.services) push(s.at, `Service rendered: ${String(s.type).replace(/_/g, ' ')}`, s.description || s.remarks, 'SERVICE');
  for (const e of call.sofEntries) push(e.at, e.event, e.detail, 'ENTRY');
  push(call.atd, 'Vessel sailed', call.draftDeparture ? `Sailing draft ${call.draftDeparture} m · for ${call.nextPort || 'sea'}` : call.nextPort ? `For ${call.nextPort}` : '', 'CALL');
  return ev.sort((a, b) => a.at.localeCompare(b.at));
}
/** Planned and actual movements of the call, oldest first. */
export function movementsOf(call: CallApi) {
  const out: { kind: string; label: string; at: string; planned: boolean; detail: string }[] = [];
  const add = (kind: string, label: string, at: string | null, planned: boolean, detail = '') => { if (at) out.push({ kind, label, at, planned, detail }); };
  add('ETA', 'Expected at pilot station', call.eta, true); add('ETB', 'Planned berthing', call.etb, true, call.berthCode ?? ''); add('ETD', 'Planned departure', call.etd, true);
  add('ATA', 'Arrived pilot station / anchorage', call.ata, false); add('ATB', 'Berthed', call.atb, false, call.berthCode ?? ''); add('ATD', 'Sailed', call.atd, false, call.nextPort);
  return out.sort((a, b) => a.at.localeCompare(b.at));
}
/** Every write ends by publishing the API-shaped snapshot (first, so a consumer reacting to the business event already sees the state) and then the business event itself. */
export async function publishState(c: Queryable, env: Env, r: View, opts: { event?: string; data?: Record<string, unknown>; cause?: EventEnvelope; actor?: Actor } = {}) {
  const entity = toApi(r);
  const mk = <T,>(type: string, data: T) => (opts.cause ? makeEvent({ type, source: env.SERVICE_NAME, data, subject: r.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor }) : eventFromContext(env.SERVICE_NAME, type, data, { subject: r.id, actor: opts.actor }));
  await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'portCall', entity }));
  if (opts.event) await enqueue(c, mk(opts.event, { portCallId: r.id, vcn: r.vcn, vesselId: r.vessel_id, vesselName: r.vessel_name, vesselImo: r.vessel_imo, vesselReal: !!r.v_real, agentCode: r.agent_code, agentName: r.agent_name, berthId: r.berth_id, berthCode: r.berth_code, status: r.status, eta: entity.eta, etb: entity.etb, etd: entity.etd, ata: entity.ata, atb: entity.atb, atd: entity.atd, portCall: entity, ...(opts.data ?? {}) }));
}
