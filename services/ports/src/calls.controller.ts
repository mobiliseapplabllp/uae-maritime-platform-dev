import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, PORTCALL_STATUS, PORTCALL_TRANSITIONS, canTransition, getJurisdiction, type PageQuery, type PortCallStatus } from '@maritime/contracts';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, badRequest, conflict, enqueue, escapeLike, eventFromContext, notFound, paged, parsePage, withTx, zod, type Principal, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { assertBerthAvailable } from './berthing';
import { CARGO_OPERATIONS, CARGO_UNITS, CLOSED_STATUSES, OPEN_STATUSES, SERVICE_TYPES, VIEW_SQL, findCall, insertCall, lockCall, movementsOf, newId, nextVcn, publishState, sofOf, stamp, toApi, toMT, updateCall, type CallApi, type CargoOp, type CallService, type HistoryEntry, type Patch, type SofEntry, type View } from './calls';
import { buildEstimate, variance } from './pda';
import { activeTariffs } from './subjects';
import { HOUR, iso } from './history';

/* The vessel-call register. One lifecycle from announcement to sailing, enforced by the transition table; berth allocation
 * runs the estate checks on every move that takes a quay; cargo operations, services and statement-of-facts entries travel
 * with the call. Every write publishes the API-shaped snapshot and the business event, and records an audit entry. */
const text = (max: number) => z.string().trim().max(max);
const dt = z.string().trim().min(1).refine((v) => !Number.isNaN(new Date(v).getTime()), 'must be a date and time').transform((v) => new Date(v));
const optDt = dt.optional().nullable();
const crewSchema = z.object({ count: z.coerce.number().int().min(0).max(500).default(0), master: text(120).default('') });
const createSchema = z.object({
  vesselId: text(80).min(1), eta: dt, etb: optDt, etd: optDt, berthId: text(80).optional().nullable(),
  agentCode: text(30).optional(), agentName: text(200).optional(), purpose: text(120).optional(), prevPort: text(80).optional(), nextPort: text(80).optional(),
  draftArrival: z.coerce.number().min(0).max(60).optional().nullable(), crew: crewSchema.optional(), remarks: text(2000).optional(),
});
const updateSchema = z.object({
  eta: dt.optional(), etb: optDt, etd: optDt, berthId: text(80).optional().nullable(), agentCode: text(30).optional(), agentName: text(200).optional(), purpose: text(120).optional(),
  prevPort: text(80).optional(), nextPort: text(80).optional(), draftArrival: z.coerce.number().min(0).max(60).optional().nullable(), draftDeparture: z.coerce.number().min(0).max(60).optional().nullable(),
  crew: crewSchema.optional(), remarks: text(2000).optional(),
});
const transitionSchema = z.object({ to: z.enum(PORTCALL_STATUS), at: optDt, berthId: text(80).optional().nullable(), berth: text(80).optional().nullable(), note: text(2000).optional() });
const serviceSchema = z.object({ type: z.enum(SERVICE_TYPES), tariffCode: text(30).optional(), description: text(300).optional(), qty: z.coerce.number().min(0).max(1e9).default(1), unit: text(30).optional(), at: optDt, remarks: text(1000).optional() });
const cargoSchema = z.object({ cargoType: text(60).min(1), operation: z.enum(CARGO_OPERATIONS), qty: z.coerce.number().positive().max(1e9), unit: z.enum(CARGO_UNITS), gangs: z.coerce.number().int().min(0).max(50).optional(), startedAt: optDt, completedAt: optDt, remarks: text(1000).optional() });
const cargoPatchSchema = cargoSchema.partial();
const sofEntrySchema = z.object({ at: dt, event: text(200).min(1), detail: text(1000).optional(), by: text(120).optional() });

const SORT: Record<string, string> = { eta: 'pc.eta', etb: 'pc.etb', etd: 'pc.etd', ata: 'pc.ata', atb: 'pc.atb', atd: 'pc.atd', vcn: 'pc.vcn', status: 'pc.status', vesselName: 'pc.vessel_name', berthCode: 'pc.berth_code', agentName: 'pc.agent_name', createdAt: 'pc.created_at' };
type ListQuery = PageQuery & { status?: string; vessel?: string; vesselId?: string; berth?: string; berthId?: string; agentCode?: string; agent?: string; from?: string; to?: string; active?: string };
const words = (s: string) => s.replace(/_/g, ' ').toLowerCase();

@Controller('port-calls')
export class PortCallsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  @RequirePerm('portcalls.view') @Get()
  async list(@Query() query: ListQuery) {
    const p = parsePage(query, { defaultSort: '-eta', sortable: Object.keys(SORT), maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    const eq = (col: string, v: string | undefined) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
    eq('pc.status', query.status); eq('pc.vessel_id', query.vessel || query.vesselId); eq('pc.agent_code', query.agentCode || query.agent);
    const berth = query.berth || query.berthId;
    if (berth) { args.push(berth); where.push(`(pc.berth_id::text = $${args.length} OR pc.berth_code = $${args.length})`); }
    if (query.active === 'true') { args.push(OPEN_STATUSES); where.push(`pc.status = ANY($${args.length})`); }
    if (query.from) { args.push(new Date(query.from)); where.push(`pc.eta >= $${args.length}`); }
    if (query.to) { args.push(new Date(query.to)); where.push(`pc.eta <= $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(pc.vcn ILIKE $${args.length} OR pc.vessel_name ILIKE $${args.length} OR pc.vessel_imo ILIKE $${args.length} OR pc.agent_name ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM port_calls pc ${w}`, args);
    const rows = await this.pool.query<View>(`${VIEW_SQL} ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, pc.vcn LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(toApi), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  /** The lifecycle as the screens need it: which move is offered next, and what each one asks for. */
  @RequirePerm('portcalls.view') @Get('meta')
  meta() {
    return { statuses: PORTCALL_STATUS, transitions: PORTCALL_TRANSITIONS, serviceTypes: SERVICE_TYPES, cargoUnits: CARGO_UNITS, cargoOperations: CARGO_OPERATIONS, openStatuses: OPEN_STATUSES, closedStatuses: CLOSED_STATUSES, defaultStayHours: this.env.DEFAULT_STAY_HOURS };
  }

  @RequirePerm('portcalls.view') @Get(':id')
  async get(@Param('id') id: string) {
    const row = await findCall(this.pool, id); if (!row) throw notFound('Port call not found');
    return this.detail(this.pool, row);
  }

  /** The call with everything the record page draws: the compiled statement of facts, the movement list and where billing stands. */
  private async detail(c: Queryable, row: View) {
    const call = toApi(row);
    const inv = await c.query<{ id: string; number: string; status: string; lines: unknown; subtotal: string; tax_amount: string; total: string; currency: string; issued_at: Date | null }>(
      "SELECT id, number, status, lines, subtotal, tax_amount, total, currency, issued_at FROM invoices WHERE port_call_id = $1 AND status <> 'CANCELLED' ORDER BY updated_at DESC LIMIT 1", [row.id]);
    const i = inv.rows[0];
    const j = getJurisdiction(this.env.JURISDICTION);
    return {
      ...call, sof: sofOf(call), movements: movementsOf(call),
      charges: {
        currency: call.pda?.currency ?? j.currency.code, taxName: j.tax.name, services: call.services.length, cargoParcels: call.cargoOps.length,
        estimate: call.pda ? { number: call.pda.number, subtotal: call.pda.subtotal, taxAmount: call.pda.taxAmount, total: call.pda.total, generatedAt: call.pda.generatedAt } : null,
        invoice: i ? { id: i.id, number: i.number, status: i.status, subtotal: Number(i.subtotal), taxAmount: Number(i.tax_amount), total: Number(i.total), currency: i.currency, issuedAt: iso(i.issued_at) } : null,
      },
    };
  }

  @RequirePerm('portcalls.create') @Post()
  async create(@Body(zod(createSchema)) b: z.infer<typeof createSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const v = await c.query<{ id: string; name: string; imo: string; type: string; flag: string; status: string; loa: string | null; max_draft: string | null; agent_code: string | null }>('SELECT id, name, imo, type, flag, status, loa, max_draft, agent_code FROM vessels WHERE id = $1 OR imo = $1', [b.vesselId]);
      const vessel = v.rows[0]; if (!vessel) throw badRequest('Vessel not found on the register');
      if (vessel.status !== 'ACTIVE') throw badRequest(`${vessel.name} is marked ${words(vessel.status)} in the registry`);
      const agentCode = b.agentCode ?? vessel.agent_code ?? '';
      const agent = agentCode ? (await c.query<{ name: string }>('SELECT name FROM companies WHERE code = $1', [agentCode])).rows[0] : undefined;
      const now = new Date();
      let berthId: string | null = null; let berthCode: string | null = null;
      if (b.berthId) {
        const from = b.etb ?? b.eta; const to = b.etd ?? new Date(from.getTime() + this.env.DEFAULT_STAY_HOURS * HOUR);
        const berth = await assertBerthAvailable(c, b.berthId, from, to, { vessel: { vesselName: vessel.name, loa: Number(vessel.loa) || null, draft: b.draftArrival ?? (Number(vessel.max_draft) || null) } });
        berthId = berth.id; berthCode = berth.code;
      }
      const history: HistoryEntry[] = [{ from: '', to: 'ANNOUNCED', at: now.toISOString(), by: user?.name ?? 'system', note: 'Call announced' }];
      const row = await insertCall(c, {
        vcn: await nextVcn(c, this.env, b.eta), vesselId: vessel.id, vesselName: vessel.name, vesselImo: vessel.imo, vesselType: vessel.type, vesselFlag: vessel.flag,
        agentCode, agentName: b.agentName ?? agent?.name ?? '', purpose: b.purpose ?? '', eta: b.eta, etb: b.etb ?? null, etd: b.etd ?? null, berthId, berthCode,
        prevPort: b.prevPort ?? '', nextPort: b.nextPort ?? '', draftArrival: b.draftArrival ?? null, crew: b.crew ?? { count: 0, master: '' }, remarks: b.remarks ?? '', statusHistory: history,
      });
      await this.audit.record(c, { action: 'CREATE', entity: 'PortCall', entityId: row.id, entityLabel: row.vcn, after: toApi(row) });
      await publishState(c, this.env, row, { event: EVENTS.ports.portCallScheduled });
      return toApi(row);
    });
  }

  @RequirePerm('portcalls.edit') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(updateSchema)) b: z.infer<typeof updateSchema>) {
    return withTx(this.pool, async (c) => {
      const before = await lockCall(c, id); if (!before) throw notFound('Port call not found');
      if (CLOSED_STATUSES.includes(before.status as PortCallStatus)) throw badRequest(`A ${words(before.status)} call is read-only`);
      const patch: Patch = {};
      const set = <K extends keyof Patch>(k: K, v: Patch[K]) => { if (v !== undefined) patch[k] = v; };
      set('eta', b.eta); set('etb', b.etb); set('etd', b.etd); set('agentCode', b.agentCode); set('purpose', b.purpose); set('prevPort', b.prevPort); set('nextPort', b.nextPort);
      set('draftArrival', b.draftArrival); set('draftDeparture', b.draftDeparture); set('crew', b.crew); set('remarks', b.remarks);
      if (b.agentName !== undefined) patch.agentName = b.agentName;
      else if (b.agentCode !== undefined) patch.agentName = (await c.query<{ name: string }>('SELECT name FROM companies WHERE code = $1', [b.agentCode])).rows[0]?.name ?? '';
      if (b.berthId !== undefined && String(b.berthId ?? '') !== String(before.berth_id ?? '')) {
        if (!b.berthId) { patch.berthId = null; patch.berthCode = null; }
        else {
          const from = b.etb ?? before.etb ?? b.eta ?? before.eta;
          const to = b.etd ?? before.etd ?? new Date(from.getTime() + this.env.DEFAULT_STAY_HOURS * HOUR);
          const berth = await assertBerthAvailable(c, b.berthId, from, to, { excludeId: before.id, vessel: { vesselName: before.vessel_name, loa: Number(before.v_loa) || null, draft: b.draftArrival ?? (Number(before.draft_arrival) || Number(before.v_max_draft) || null) } });
          patch.berthId = berth.id; patch.berthCode = berth.code;
        }
      }
      const row = await updateCall(c, before.id, patch);
      await this.audit.record(c, { action: 'UPDATE', entity: 'PortCall', entityId: row.id, entityLabel: row.vcn, before: toApi(before), after: toApi(row) });
      await publishState(c, this.env, row, { event: EVENTS.ports.updated });
      return this.detail(c, row);
    });
  }

  @RequirePerm('portcalls.delete') @Delete(':id')
  async remove(@Param('id') id: string) {
    return withTx(this.pool, async (c) => {
      const row = await lockCall(c, id); if (!row) throw notFound('Port call not found');
      if (!['ANNOUNCED', 'CANCELLED'].includes(row.status)) throw badRequest('Only announced or cancelled calls can be deleted — the rest are operational record');
      await c.query('DELETE FROM port_calls WHERE id = $1', [row.id]);
      await this.audit.record(c, { action: 'DELETE', entity: 'PortCall', entityId: row.id, entityLabel: row.vcn, before: toApi(row) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.readModel.deleted, { kind: 'portCall', id: row.id }, { subject: row.id }));
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.ports.deleted, { portCallId: row.id, vcn: row.vcn, vesselId: row.vessel_id }, { subject: row.id }));
      return { deleted: true };
    });
  }

  /** The one way a call changes state. The table decides what is allowed; the estate decides whether the quay can take her. */
  @RequirePerm('portcalls.transition') @Post(':id/transition')
  async transition(@Param('id') id: string, @Body(zod(transitionSchema)) b: z.infer<typeof transitionSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await lockCall(c, id); if (!before) throw notFound('Port call not found');
      const from = before.status as PortCallStatus; const to = b.to;
      if (!PORTCALL_TRANSITIONS[from]) throw conflict(`Unknown status "${from}" — cannot move`);
      if (!canTransition(PORTCALL_TRANSITIONS, from, to)) throw conflict(`A ${words(from)} call cannot move to ${words(to)}`);
      const when = b.at ?? new Date();
      const patch: Patch = { status: to };
      const ref = b.berthId || b.berth || null;
      let berthLabel = before.berth_code ?? '';
      if (to === 'CONFIRMED' && ref) {
        const start = before.etb ?? before.eta; const end = before.etd ?? new Date(start.getTime() + this.env.DEFAULT_STAY_HOURS * HOUR);
        const berth = await assertBerthAvailable(c, ref, start, end, { excludeId: before.id, vessel: { vesselName: before.vessel_name, loa: Number(before.v_loa) || null, draft: Number(before.draft_arrival) || Number(before.v_max_draft) || null } });
        patch.berthId = berth.id; patch.berthCode = berth.code; berthLabel = berth.code;
      }
      if (to === 'AT_ANCHORAGE') patch.ata = before.ata ?? when;
      if (to === 'BERTHED') {
        const berthRef = ref || before.berth_id; if (!berthRef) throw badRequest('Select a berth before berthing the vessel');
        const end = before.etd && before.etd > when ? before.etd : new Date(when.getTime() + this.env.DEFAULT_STAY_HOURS * HOUR);
        const berth = await assertBerthAvailable(c, String(berthRef), when, end, { excludeId: before.id, vessel: { vesselName: before.vessel_name, loa: Number(before.v_loa) || null, draft: Number(before.draft_arrival) || Number(before.v_max_draft) || null } });
        patch.berthId = berth.id; patch.berthCode = berth.code; patch.ata = before.ata ?? when; patch.atb = when; berthLabel = berth.code;
      }
      if (to === 'SAILED') { if (!before.atb) throw badRequest('Cannot sail a call that never berthed'); patch.atd = when; }
      if (to === 'CANCELLED' && !b.note) throw badRequest('A cancellation note is required');
      const note = b.note ?? '';
      patch.statusHistory = [...(before.status_history ?? []), { from, to, at: when.toISOString(), by: user?.name ?? 'system', note }];
      const row = await updateCall(c, before.id, patch);
      await this.audit.record(c, { action: 'TRANSITION', entity: 'PortCall', entityId: row.id, entityLabel: `${row.vcn}: ${from} → ${to}`, before: { status: from }, after: { status: to, at: when.toISOString(), berthCode: row.berth_code }, note });
      const event = to === 'CONFIRMED' ? EVENTS.ports.confirmed : to === 'AT_ANCHORAGE' ? EVENTS.ports.anchored : to === 'BERTHED' ? EVENTS.ports.berthed : to === 'SAILED' ? EVENTS.ports.sailed : EVENTS.ports.cancelled;
      await publishState(c, this.env, row, { event, data: { from, to, at: when.toISOString(), note, by: user?.name ?? 'system', berthLabel } });
      return this.detail(c, row);
    });
  }

  @RequirePerm('portcalls.edit') @Post(':id/services')
  async addService(@Param('id') id: string, @Body(zod(serviceSchema)) b: z.infer<typeof serviceSchema>) {
    return withTx(this.pool, async (c) => {
      const before = await lockCall(c, id); if (!before) throw notFound('Port call not found');
      if (CLOSED_STATUSES.includes(before.status as PortCallStatus)) throw badRequest(`A ${words(before.status)} call is read-only`);
      const entry: CallService = { id: newId(), type: b.type, tariffCode: b.tariffCode ?? '', description: b.description ?? '', qty: b.qty, unit: b.unit ?? '', at: stamp(b.at ?? new Date()), remarks: b.remarks ?? '', createdAt: new Date().toISOString() };
      const row = await updateCall(c, before.id, { services: [...(before.services ?? []), entry] });
      await this.audit.record(c, { action: 'SERVICE_ADD', entity: 'PortCall', entityId: row.id, entityLabel: `${row.vcn} — ${b.type}`, after: entry });
      await publishState(c, this.env, row, { event: EVENTS.ports.updated, data: { change: 'SERVICE_ADDED', service: entry } });
      return this.detail(c, row);
    });
  }

  @RequirePerm('portcalls.edit') @Delete(':id/services/:serviceId')
  async removeService(@Param('id') id: string, @Param('serviceId') serviceId: string) {
    return withTx(this.pool, async (c) => {
      const before = await lockCall(c, id); if (!before) throw notFound('Port call not found');
      const svc = (before.services ?? []).find((s) => s.id === serviceId); if (!svc) throw notFound('Service entry not found');
      const row = await updateCall(c, before.id, { services: (before.services ?? []).filter((s) => s.id !== serviceId) });
      await this.audit.record(c, { action: 'SERVICE_DELETE', entity: 'PortCall', entityId: row.id, entityLabel: `${row.vcn} — ${svc.type}`, before: svc });
      await publishState(c, this.env, row, { event: EVENTS.ports.updated, data: { change: 'SERVICE_REMOVED', serviceId } });
      return this.detail(c, row);
    });
  }

  @RequirePerm('cargo.manage') @Post(':id/cargo')
  async addCargo(@Param('id') id: string, @Body(zod(cargoSchema)) b: z.infer<typeof cargoSchema>) {
    return withTx(this.pool, async (c) => {
      const before = await lockCall(c, id); if (!before) throw notFound('Port call not found');
      if (CLOSED_STATUSES.includes(before.status as PortCallStatus)) throw badRequest(`A ${words(before.status)} call is read-only`);
      const op: CargoOp = { id: newId(), cargoType: b.cargoType, operation: b.operation, qty: b.qty, unit: b.unit, qtyMT: toMT(b.qty, b.unit), gangs: b.gangs ?? 0, startedAt: stamp(b.startedAt), completedAt: stamp(b.completedAt), remarks: b.remarks ?? '', createdAt: new Date().toISOString() };
      const row = await updateCall(c, before.id, { cargoOps: [...(before.cargo_ops ?? []), op] });
      await this.audit.record(c, { action: 'CARGO_ADD', entity: 'PortCall', entityId: row.id, entityLabel: `${row.vcn} — ${op.cargoType} ${op.qty} ${op.unit}`, after: op });
      await publishState(c, this.env, row, { event: EVENTS.ports.updated, data: { change: 'CARGO_ADDED', cargoOp: op } });
      return this.detail(c, row);
    });
  }

  @RequirePerm('cargo.manage') @Put(':id/cargo/:opId')
  async updateCargo(@Param('id') id: string, @Param('opId') opId: string, @Body(zod(cargoPatchSchema)) b: z.infer<typeof cargoPatchSchema>) {
    return withTx(this.pool, async (c) => {
      const before = await lockCall(c, id); if (!before) throw notFound('Port call not found');
      const ops = before.cargo_ops ?? []; const op = ops.find((o) => o.id === opId); if (!op) throw notFound('Cargo operation not found');
      const next: CargoOp = { ...op,
        cargoType: b.cargoType ?? op.cargoType, operation: b.operation ?? op.operation, qty: b.qty ?? op.qty, unit: b.unit ?? op.unit, gangs: b.gangs ?? op.gangs,
        startedAt: b.startedAt !== undefined ? stamp(b.startedAt) : op.startedAt, completedAt: b.completedAt !== undefined ? stamp(b.completedAt) : op.completedAt, remarks: b.remarks ?? op.remarks };
      next.qtyMT = toMT(next.qty, next.unit);
      const row = await updateCall(c, before.id, { cargoOps: ops.map((o) => (o.id === opId ? next : o)) });
      await this.audit.record(c, { action: 'CARGO_UPDATE', entity: 'PortCall', entityId: row.id, entityLabel: `${row.vcn} — ${next.cargoType}`, before: op, after: next });
      await publishState(c, this.env, row, { event: EVENTS.ports.updated, data: { change: 'CARGO_UPDATED', cargoOp: next } });
      return this.detail(c, row);
    });
  }

  @RequirePerm('cargo.manage') @Delete(':id/cargo/:opId')
  async removeCargo(@Param('id') id: string, @Param('opId') opId: string) {
    return withTx(this.pool, async (c) => {
      const before = await lockCall(c, id); if (!before) throw notFound('Port call not found');
      const op = (before.cargo_ops ?? []).find((o) => o.id === opId); if (!op) throw notFound('Cargo operation not found');
      const row = await updateCall(c, before.id, { cargoOps: (before.cargo_ops ?? []).filter((o) => o.id !== opId) });
      await this.audit.record(c, { action: 'CARGO_DELETE', entity: 'PortCall', entityId: row.id, entityLabel: `${row.vcn} — ${op.cargoType}`, before: op });
      await publishState(c, this.env, row, { event: EVENTS.ports.updated, data: { change: 'CARGO_REMOVED', cargoOpId: opId } });
      return this.detail(c, row);
    });
  }

  /** Statement of Facts — compiled from the call, plus whatever the harbour desk typed in by hand. */
  @RequirePerm('portcalls.view') @Get(':id/sof')
  async sof(@Param('id') id: string) {
    const row = await findCall(this.pool, id); if (!row) throw notFound('Port call not found');
    const call = toApi(row);
    return { call: { id: call.id, vcn: call.vcn, status: call.status, agentCode: call.agentCode, agentName: call.agentName, eta: call.eta, atd: call.atd, vessel: call.vessel, berth: call.berth }, events: sofOf(call), movements: movementsOf(call) };
  }

  @RequirePerm('portcalls.edit') @Post(':id/sof')
  async addSofEntry(@Param('id') id: string, @Body(zod(sofEntrySchema)) b: z.infer<typeof sofEntrySchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await lockCall(c, id); if (!before) throw notFound('Port call not found');
      const entry: SofEntry = { id: newId(), at: b.at.toISOString(), event: b.event, detail: b.detail ?? '', by: b.by ?? user?.name ?? 'system' };
      const row = await updateCall(c, before.id, { sofEntries: [...(before.sof_entries ?? []), entry] });
      await this.audit.record(c, { action: 'SOF_ADD', entity: 'PortCall', entityId: row.id, entityLabel: `${row.vcn} — ${entry.event}`, after: entry });
      await publishState(c, this.env, row, { event: EVENTS.ports.updated, data: { change: 'SOF_ENTRY_ADDED', entry } });
      const call = toApi(row);
      return { call: { id: call.id, vcn: call.vcn, agentCode: call.agentCode, agentName: call.agentName, vessel: call.vessel, berth: call.berth }, events: sofOf(call) };
    });
  }

  @RequirePerm('portcalls.edit') @Delete(':id/sof/:entryId')
  async removeSofEntry(@Param('id') id: string, @Param('entryId') entryId: string) {
    return withTx(this.pool, async (c) => {
      const before = await lockCall(c, id); if (!before) throw notFound('Port call not found');
      const entry = (before.sof_entries ?? []).find((e) => e.id === entryId); if (!entry) throw notFound('Statement entry not found');
      const row = await updateCall(c, before.id, { sofEntries: (before.sof_entries ?? []).filter((e) => e.id !== entryId) });
      await this.audit.record(c, { action: 'SOF_DELETE', entity: 'PortCall', entityId: row.id, entityLabel: `${row.vcn} — ${entry.event}`, before: entry });
      await publishState(c, this.env, row, { event: EVENTS.ports.updated, data: { change: 'SOF_ENTRY_REMOVED', entryId } });
      return { deleted: true };
    });
  }

  /** The estimate carried on the call, and how it reads against the invoice that eventually closed it. */
  @RequirePerm('invoices.view', 'portcalls.view') @Get(':id/pda')
  async getPda(@Param('id') id: string) {
    const row = await findCall(this.pool, id); if (!row) throw notFound('Port call not found');
    const call = toApi(row);
    if (!call.pda) throw notFound('No cost estimate has been generated for this call');
    const inv = await this.pool.query<{ number: string; lines: CallApi['pda'] extends null ? never : { code: string; description: string; unit: string; qty: number; rate: number; amount: number }[]; total: string }>(
      "SELECT number, lines, total FROM invoices WHERE port_call_id = $1 AND status IN ('ISSUED','PAID') ORDER BY issued_at DESC LIMIT 1", [row.id]);
    const i = inv.rows[0];
    return { call: { id: call.id, vcn: call.vcn, vessel: call.vessel, agentName: call.agentName, eta: call.eta }, pda: call.pda, variance: variance(call.pda.lines, i ? { number: i.number, lines: i.lines, total: Number(i.total) } : null, call.pda.total) };
  }

  @RequirePerm('invoices.create', 'portcalls.edit') @Post(':id/pda')
  async generatePda(@Param('id') id: string, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await lockCall(c, id); if (!before) throw notFound('Port call not found');
      const call = toApi(before);
      if (!call.vesselGrt) throw badRequest('The vessel needs a GRT before an estimate can be made');
      const tariffs = await activeTariffs(c);
      const est = buildEstimate(call, tariffs, this.env.JURISDICTION);
      if (!est.lines.length) throw badRequest('No tariff heads matched — check the tariff master');
      const pda = { number: `PDA/${call.vcn}`, lines: est.lines, subtotal: est.subtotal, taxRate: est.taxRate, taxAmount: est.taxAmount, total: est.total, currency: est.currency, basis: est.basis, generatedAt: new Date().toISOString(), generatedBy: user?.name ?? 'system' };
      const row = await updateCall(c, before.id, { pda });
      await this.audit.record(c, { action: 'PDA', entity: 'PortCall', entityId: row.id, entityLabel: `PDA for ${row.vcn}`, after: pda });
      await publishState(c, this.env, row, { event: EVENTS.ports.updated, data: { change: 'PDA_GENERATED', pda } });
      return pda;
    });
  }
}
