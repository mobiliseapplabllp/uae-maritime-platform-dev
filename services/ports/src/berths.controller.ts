import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, type PageQuery } from '@maritime/contracts';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, badRequest, conflict, escapeLike, notFound, paged, parsePage, withTx, zod, type Principal } from '@maritime/service-kit';
import type { Env } from './env';
import { BERTH_STATUS, BERTH_TYPES, OUTAGE_KINDS, findBerth, outageReport, outagesOf, publishBerth, publishBerthDeleted, toApi, type BerthRow } from './berths';
import { ACTIVE_STATUSES } from './calls';
import { availability, clampMonths, daysBetween, iso, monthWindow, num, overlapDays, round1, DAY } from './history';

/* The berth estate and its downtime record. Allocation checks run against the limits kept here, so a berth carrying
 * active or planned calls cannot be deleted and a berth taken out of service refuses new allocations. */
const text = (max: number) => z.string().trim().max(max);
const createSchema = z.object({
  code: text(30).min(1), name: text(160).min(1), terminal: text(120).min(1), berthType: z.enum(BERTH_TYPES).default('MULTIPURPOSE'),
  loaMax: z.coerce.number().min(0).max(1000).default(0), draftMax: z.coerce.number().min(0).max(60).default(0),
  status: z.enum(BERTH_STATUS).default('OPERATIONAL'), remarks: text(2000).default(''),
});
const updateSchema = createSchema.partial();
const outageSchema = z.object({
  from: z.string().min(1), to: z.string().min(1), kind: z.enum(OUTAGE_KINDS).default('PLANNED'), reason: text(500).default(''), by: text(120).optional(),
});
const SORT: Record<string, string> = { code: 'code', name: 'name', terminal: 'terminal', berthType: 'berth_type', status: 'status', loaMax: 'loa_max', draftMax: 'draft_max', createdAt: 'created_at' };
type ListQuery = PageQuery & { terminal?: string; berthType?: string; status?: string };

@Controller('berths')
export class BerthsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  @RequirePerm('masters.view', 'portcalls.view') @Get()
  async list(@Query() query: ListQuery) {
    const p = parsePage(query, { defaultSort: 'code', sortable: Object.keys(SORT), maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    const eq = (col: string, v: string | undefined) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
    eq('terminal', query.terminal); eq('berth_type', query.berthType); eq('status', query.status);
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(code ILIKE $${args.length} OR name ILIKE $${args.length} OR terminal ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM berths ${w}`, args);
    const rows = await this.pool.query<BerthRow>(`SELECT * FROM berths ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, code LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    const outs = await this.pool.query<{ berth_id: string; from_at: Date; kind: string; days: string }>('SELECT berth_id, from_at, kind, days FROM berth_outages WHERE berth_id = ANY($1) ORDER BY from_at DESC', [rows.rows.map((r) => r.id)]);
    const byBerth = new Map<string, { from: string; kind: string; days: number }[]>();
    for (const o of outs.rows) { const l = byBerth.get(o.berth_id) ?? []; l.push({ from: iso(o.from_at)!, kind: o.kind, days: Number(o.days) || 0 }); byBerth.set(o.berth_id, l); }
    return paged(rows.rows.map((b) => ({ ...toApi(b), outages: byBerth.get(b.id) ?? [] })), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  /** Estate-wide downtime — which berths, which causes, how availability trends. Declared before `:id` so the word is not read as an id. */
  @RequirePerm('masters.view', 'portcalls.view') @Get('downtime')
  async downtime(@Query('months') monthsQ?: string) {
    const months = clampMonths(monthsQ, 12);
    const { bounds, from, to } = monthWindow(months);
    const rows = (await this.pool.query<BerthRow>('SELECT * FROM berths ORDER BY code')).rows;
    const outs = (await this.pool.query<{ berth_id: string; from_at: Date; to_at: Date; days: string; kind: string; reason: string }>('SELECT berth_id, from_at, to_at, days, kind, reason FROM berth_outages')).rows;
    const byBerth = new Map<string, { from: Date; to: Date; days: number; kind: string; reason: string }[]>();
    for (const o of outs) { const l = byBerth.get(o.berth_id) ?? []; l.push({ from: o.from_at, to: o.to_at, days: Number(o.days) || 0, kind: o.kind, reason: o.reason }); byBerth.set(o.berth_id, l); }
    const spanDays = (to.getTime() - from.getTime()) / DAY;
    const series = bounds.map((b) => ({ month: b.key, label: b.label, days: 0, outages: 0 }));
    const kinds = new Map<string, { kind: string; outages: number; days: number }>();
    const terminals = new Map<string, { terminal: string; berths: number; outages: number; days: number }>();
    const berths: { id: string; code: string; name: string; terminal: string; berthType: string; status: string; outages: number; days: number; availabilityPct: number; lifetimeOutages: number; lifetimeDays: number }[] = [];
    let lostDays = 0; let windowOutages = 0;
    for (const b of rows) {
      const outages = byBerth.get(b.id) ?? [];
      const av = availability(outages, from, to);
      let count = 0;
      for (const o of outages) {
        if (o.from < to && o.to > from) {
          count += 1;
          const k = o.kind || 'OTHER'; const e = kinds.get(k) ?? { kind: k, outages: 0, days: 0 };
          e.outages += 1; e.days += overlapDays(o.from, o.to, from, to); kinds.set(k, e);
        }
        bounds.forEach((bd, i) => { const d = overlapDays(o.from, o.to, bd.from, bd.to); if (d > 0) { series[i].days += d; series[i].outages += 1; } });
      }
      lostDays += av.days; windowOutages += count;
      const tb = terminals.get(b.terminal) ?? { terminal: b.terminal, berths: 0, outages: 0, days: 0 };
      tb.berths += 1; tb.outages += count; tb.days += av.days; terminals.set(b.terminal, tb);
      berths.push({ id: b.id, code: b.code, name: b.name, terminal: b.terminal, berthType: b.berth_type, status: b.status, outages: count, days: av.days, availabilityPct: av.availabilityPct, lifetimeOutages: outages.length, lifetimeDays: round1(outages.reduce((s, o) => s + o.days, 0)) });
    }
    berths.sort((a, b) => b.days - a.days || a.code.localeCompare(b.code));
    return {
      window: { from: iso(from)!, to: iso(to)!, months },
      estate: {
        berths: rows.length, outages: windowOutages, days: round1(lostDays), berthDays: Math.round(rows.length * spanDays),
        availabilityPct: rows.length ? round1(Math.max(0, 100 - (lostDays / (rows.length * spanDays)) * 100)) : 100,
        underMaintenanceNow: rows.filter((b) => b.status !== 'OPERATIONAL').length, worst: berths[0] ?? null,
      },
      byKind: [...kinds.values()].sort((a, b) => b.days - a.days).map((k) => ({ ...k, days: round1(k.days), sharePct: lostDays ? round1((k.days / lostDays) * 100) : 0 })),
      byTerminal: [...terminals.values()].map((t) => ({ ...t, days: round1(t.days), availabilityPct: t.berths ? round1(Math.max(0, 100 - (t.days / (t.berths * spanDays)) * 100)) : 100 })).sort((a, b) => b.days - a.days),
      series: series.map((s) => ({ ...s, days: round1(s.days) })),
      berths,
    };
  }

  /** The berth board: every berth with who holds it now, who is next and whether it is out of service. */
  @RequirePerm('masters.view', 'portcalls.view') @Get('board')
  async board() {
    const berths = (await this.pool.query<BerthRow>('SELECT * FROM berths ORDER BY terminal, code')).rows;
    const calls = (await this.pool.query<{ id: string; vcn: string; berth_id: string | null; status: string; vessel_id: string; vessel_name: string; eta: Date; etb: Date | null; etd: Date | null; ata: Date | null; atb: Date | null; loa: string | null; v_type: string | null }>(
      `SELECT pc.id, pc.vcn, pc.berth_id, pc.status, pc.vessel_id, pc.vessel_name, pc.eta, pc.etb, pc.etd, pc.ata, pc.atb, v.loa, v.type AS v_type FROM port_calls pc LEFT JOIN vessels v ON v.id = pc.vessel_id WHERE pc.status = ANY($1) ORDER BY pc.eta`, [['ANNOUNCED', ...ACTIVE_STATUSES]])).rows;
    const now = new Date();
    const live = (await this.pool.query<{ berth_id: string; from_at: Date; to_at: Date; kind: string; reason: string }>('SELECT berth_id, from_at, to_at, kind, reason FROM berth_outages WHERE to_at > now() ORDER BY from_at')).rows;
    return {
      at: now.toISOString(),
      berths: berths.map((b) => {
        const occ = calls.find((c) => c.status === 'BERTHED' && c.berth_id === b.id);
        const next = calls.filter((c) => c.berth_id === b.id && c.status !== 'BERTHED').sort((a, x) => (a.etb ?? a.eta).getTime() - (x.etb ?? x.eta).getTime())[0];
        const outage = live.find((o) => o.berth_id === b.id);
        return {
          ...toApi(b),
          occupiedBy: occ ? { callId: occ.id, vcn: occ.vcn, vesselId: occ.vessel_id, vessel: occ.vessel_name, type: occ.v_type, loa: num(occ.loa), atb: iso(occ.atb), etd: iso(occ.etd), hoursAlongside: occ.atb ? round1((now.getTime() - occ.atb.getTime()) / 3600000) : null } : null,
          nextArrival: next ? { callId: next.id, vcn: next.vcn, vesselId: next.vessel_id, vessel: next.vessel_name, status: next.status, eta: iso(next.eta), etb: iso(next.etb) } : null,
          outage: outage ? { from: iso(outage.from_at), to: iso(outage.to_at), kind: outage.kind, reason: outage.reason, active: outage.from_at <= now } : null,
        };
      }),
      occupancy: (() => { const total = berths.length; const held = berths.filter((b) => calls.some((c) => c.status === 'BERTHED' && c.berth_id === b.id)).length; return { berths: total, occupied: held, free: total - held, occupancyPct: total ? round1((held / total) * 100) : 0 }; })(),
    };
  }

  @RequirePerm('masters.view', 'portcalls.view') @Get(':id')
  async get(@Param('id') id: string) {
    const b = await findBerth(this.pool, id); if (!b) throw notFound('Berth not found');
    return toApi(b, await outagesOf(this.pool, b.id));
  }

  @RequirePerm('masters.view', 'portcalls.view') @Get(':id/outages')
  async outages(@Param('id') id: string, @Query('months') monthsQ?: string) {
    const b = await findBerth(this.pool, id); if (!b) throw notFound('Berth not found');
    return outageReport(b, await outagesOf(this.pool, b.id), clampMonths(monthsQ, 12));
  }

  @RequirePerm('masters.manage') @Post()
  async create(@Body(zod(createSchema)) b: z.infer<typeof createSchema>) {
    return withTx(this.pool, async (c) => {
      const dup = await c.query('SELECT id FROM berths WHERE code = $1', [b.code]); if (dup.rowCount) throw conflict(`Berth ${b.code} already exists`);
      const r = await c.query<BerthRow>('INSERT INTO berths(code, name, terminal, berth_type, loa_max, draft_max, status, remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [b.code, b.name, b.terminal, b.berthType, b.loaMax, b.draftMax, b.status, b.remarks]);
      const row = r.rows[0];
      await this.audit.record(c, { action: 'CREATE', entity: 'Berth', entityId: row.id, entityLabel: row.code, after: toApi(row) });
      await publishBerth(c, this.env, row, { event: EVENTS.ports.berthChanged, data: { change: 'CREATED' } });
      return toApi(row);
    });
  }

  @RequirePerm('masters.manage') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(updateSchema)) b: z.infer<typeof updateSchema>) {
    return withTx(this.pool, async (c) => {
      const before = await findBerth(c, id); if (!before) throw notFound('Berth not found');
      const cols: Record<string, unknown> = { code: b.code, name: b.name, terminal: b.terminal, berth_type: b.berthType, loa_max: b.loaMax, draft_max: b.draftMax, status: b.status, remarks: b.remarks };
      const keys = Object.keys(cols).filter((k) => cols[k] !== undefined);
      if (keys.length) await c.query(`UPDATE berths SET ${keys.map((k, i) => `${k} = $${i + 2}`).concat('updated_at = now()').join(', ')} WHERE id = $1`, [before.id, ...keys.map((k) => cols[k])]);
      const row = (await findBerth(c, before.id))!;
      await this.audit.record(c, { action: 'UPDATE', entity: 'Berth', entityId: row.id, entityLabel: row.code, before: toApi(before), after: toApi(row) });
      await publishBerth(c, this.env, row, { event: EVENTS.ports.berthChanged, data: { change: 'UPDATED' } });
      return toApi(row, await outagesOf(c, row.id));
    });
  }

  @RequirePerm('masters.manage') @Delete(':id')
  async remove(@Param('id') id: string) {
    return withTx(this.pool, async (c) => {
      const row = await findBerth(c, id); if (!row) throw notFound('Berth not found');
      const inUse = await c.query<{ n: string }>('SELECT count(*) AS n FROM port_calls WHERE berth_id = $1 AND status = ANY($2)', [row.id, ACTIVE_STATUSES]);
      if (Number(inUse.rows[0].n) > 0) throw badRequest('This berth has active or planned port calls — free it first');
      await c.query('DELETE FROM berths WHERE id = $1', [row.id]);
      await this.audit.record(c, { action: 'DELETE', entity: 'Berth', entityId: row.id, entityLabel: row.code, before: toApi(row) });
      await publishBerthDeleted(c, this.env, row);
      return { deleted: true };
    });
  }

  /** Take a berth out of service for a window. Overlapping windows on one berth are refused — one record per stand-down. */
  @RequirePerm('masters.manage') @Post(':id/outages')
  async addOutage(@Param('id') id: string, @Body(zod(outageSchema)) b: z.infer<typeof outageSchema>, @CurrentUser() user: Principal) {
    const from = new Date(b.from); const to = new Date(b.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw badRequest('An outage needs a valid from and to');
    if (to <= from) throw badRequest('An outage must end after it starts');
    return withTx(this.pool, async (c) => {
      const berth = await findBerth(c, id); if (!berth) throw notFound('Berth not found');
      const clash = await c.query<{ from_at: Date; to_at: Date }>('SELECT from_at, to_at FROM berth_outages WHERE berth_id = $1 AND from_at < $3 AND to_at > $2 LIMIT 1', [berth.id, from, to]);
      if (clash.rowCount) throw conflict(`Berth ${berth.code} already has an outage recorded across that window`);
      const r = await c.query<{ id: string }>('INSERT INTO berth_outages(berth_id, from_at, to_at, days, kind, reason, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id', [berth.id, from, to, daysBetween(from, to), b.kind, b.reason, b.by ?? user?.name ?? '']);
      await this.audit.record(c, { action: 'OUTAGE_ADD', entity: 'Berth', entityId: berth.id, entityLabel: `${berth.code} — ${b.kind}`, after: { id: r.rows[0].id, from: from.toISOString(), to: to.toISOString(), kind: b.kind, reason: b.reason } });
      await publishBerth(c, this.env, berth, { event: EVENTS.ports.berthOutageRecorded, data: { outageId: r.rows[0].id, from: from.toISOString(), to: to.toISOString(), days: daysBetween(from, to), kind: b.kind, reason: b.reason } });
      return outageReport(berth, await outagesOf(c, berth.id), 12);
    });
  }

  @RequirePerm('masters.manage') @Delete(':id/outages/:outageId')
  async removeOutage(@Param('id') id: string, @Param('outageId') outageId: string) {
    return withTx(this.pool, async (c) => {
      const berth = await findBerth(c, id); if (!berth) throw notFound('Berth not found');
      const r = await c.query<{ id: string; kind: string; from_at: Date; to_at: Date }>('DELETE FROM berth_outages WHERE id = $1 AND berth_id = $2 RETURNING id, kind, from_at, to_at', [outageId, berth.id]);
      if (!r.rowCount) throw notFound('Outage not found');
      await this.audit.record(c, { action: 'OUTAGE_DELETE', entity: 'Berth', entityId: berth.id, entityLabel: `${berth.code} — ${r.rows[0].kind}`, before: { id: r.rows[0].id, from: iso(r.rows[0].from_at), to: iso(r.rows[0].to_at), kind: r.rows[0].kind } });
      await publishBerth(c, this.env, berth, { event: EVENTS.ports.berthChanged, data: { change: 'OUTAGE_REMOVED' } });
      return { deleted: true };
    });
  }
}
