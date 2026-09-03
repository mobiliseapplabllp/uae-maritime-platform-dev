import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, RESOURCE_TYPES } from '@maritime/contracts';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, badRequest, conflict, notFound, paged, withTx, zod, type Principal } from '@maritime/service-kit';
import type { Env } from './env';
import { OPEN_STATUSES } from './calls';
import { toApi as berthApi, type BerthRow } from './berths';
import { JOB_KINDS, RESOURCE_STATUS, bucketJobs, core, findResource, historyReport, jobsOf, publishResource, publishResourceDeleted, resourceOutagesOf, serviceDigest, toApi as resourceApi, type JobApi, type JobRow, type OutageApi, type ResourceOutageRow, type ResourceRow } from './resources';
import { DAY, availability, clampMonths, dayKey, dayStart, daysBetween, iso, monthWindow, num, round1 } from './history';

/* Harbour operations: the quay twin, the day programme, the berth window planner and the marine craft board.
 * Everything here is read-only over the call register and the estate, except the craft board, which the duty officer works. */
const text = (max: number) => z.string().trim().max(max);
const statusSchema = z.object({ status: z.enum(RESOURCE_STATUS).optional(), currentTask: text(300).optional(), remarks: text(1000).optional(), master: text(120).optional(), contact: text(80).optional(), spec: text(200).optional(), name: text(160).optional() });
const createResourceSchema = z.object({ code: text(30).min(1), name: text(160).min(1), type: z.enum(RESOURCE_TYPES), spec: text(200).default(''), status: z.enum(RESOURCE_STATUS).default('AVAILABLE'), master: text(120).default(''), contact: text(80).default(''), remarks: text(1000).default('') });
const jobSchema = z.object({
  kind: z.enum(JOB_KINDS), at: z.string().optional(), endedAt: z.string().optional().nullable(), hours: z.coerce.number().min(0).max(240).optional(),
  portCallId: text(80).optional().nullable(), vcn: text(40).optional(), vesselName: text(200).optional(), berth: text(30).optional(), remarks: text(1000).optional(), task: text(300).optional(),
});
const resourceOutageSchema = z.object({ from: z.string().min(1), to: z.string().min(1), reason: text(500).default('') });
type TwinCall = { id: string; vcn: string; status: string; vessel_id: string; vessel_name: string; berth_id: string | null; berth_code: string | null; agent_name: string; eta: Date; etb: Date | null; etd: Date | null; ata: Date | null; atb: Date | null; atd: Date | null; cargo_ops: { operation: string; qty: number; unit: string; cargoType: string }[]; v_type: string | null; v_loa: string | null };
const CALL_SQL = 'SELECT pc.id, pc.vcn, pc.status, pc.vessel_id, pc.vessel_name, pc.berth_id, pc.berth_code, pc.agent_name, pc.eta, pc.etb, pc.etd, pc.ata, pc.atb, pc.atd, pc.cargo_ops, v.type AS v_type, v.loa AS v_loa FROM port_calls pc LEFT JOIN vessels v ON v.id = pc.vessel_id';
const fmtQty = (n: number) => new Intl.NumberFormat('en-AE').format(n);

@Controller('ops')
export class OpsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  /** Everything the quay view needs in one call: the estate with its occupants, who is at anchor and who is inbound. */
  @RequirePerm('portcalls.view') @Get('twin')
  async twin() {
    const berths = (await this.pool.query<BerthRow>('SELECT * FROM berths ORDER BY terminal, code')).rows;
    const active = (await this.pool.query<TwinCall>(`${CALL_SQL} WHERE pc.status = ANY($1) ORDER BY pc.eta`, [OPEN_STATUSES])).rows;
    const byBerth = new Map(active.filter((c) => c.status === 'BERTHED' && c.berth_id).map((c) => [String(c.berth_id), c]));
    const brief = (c: TwinCall) => ({ callId: c.id, vcn: c.vcn, vesselId: c.vessel_id, vessel: c.vessel_name, type: c.v_type, loa: num(c.v_loa) });
    return {
      berths: berths.map((b) => {
        const c = byBerth.get(b.id); const a = berthApi(b);
        return { id: a.id, code: a.code, name: a.name, terminal: a.terminal, berthType: a.berthType, loaMax: a.loaMax, draftMax: a.draftMax, status: a.status,
          occupiedBy: c ? { ...brief(c), atb: iso(c.atb), etd: iso(c.etd), cargo: (c.cargo_ops ?? []).map((o) => `${String(o.operation).toLowerCase()} ${fmtQty(Number(o.qty))} ${o.unit} ${o.cargoType}`).join('; ') } : null };
      }),
      anchorage: active.filter((c) => c.status === 'AT_ANCHORAGE').map((c) => ({ ...brief(c), since: iso(c.ata), etb: iso(c.etb) })),
      inbound: active.filter((c) => c.status === 'ANNOUNCED' || c.status === 'CONFIRMED').map((c) => ({ ...brief(c), eta: iso(c.eta)!, status: c.status })).sort((a, b) => a.eta.localeCompare(b.eta)),
    };
  }

  /** The day programme: expected arrivals, planned berthings, planned sailings and what actually sailed, grouped by day. */
  @RequirePerm('portcalls.view') @Get('schedule')
  async schedule(@Query('days') daysQ?: string) {
    const days = Math.min(14, Math.max(1, Number.parseInt(String(daysQ ?? ''), 10) || 5));
    const start = dayStart(); const from = new Date(start.getTime() - DAY); const to = new Date(start.getTime() + days * DAY);
    const rows = (await this.pool.query<TwinCall>(`${CALL_SQL} WHERE pc.status <> 'CANCELLED' AND ((pc.eta BETWEEN $1 AND $2) OR (pc.etd BETWEEN $1 AND $2) OR (pc.atd BETWEEN $1 AND $2) OR pc.status = 'BERTHED')`, [from, to])).rows;
    const events: { callId: string; vcn: string; vesselId: string; vessel: string; type: string | null; berth: string; agent: string; status: string; kind: string; at: string; planned: boolean }[] = [];
    for (const c of rows) {
      const base = { callId: c.id, vcn: c.vcn, vesselId: c.vessel_id, vessel: c.vessel_name, type: c.v_type, berth: c.berth_code || '—', agent: c.agent_name, status: c.status };
      if ((c.status === 'ANNOUNCED' || c.status === 'CONFIRMED') && c.eta) events.push({ ...base, kind: 'ARRIVAL', at: iso(c.eta)!, planned: true });
      if (c.status === 'AT_ANCHORAGE' && c.etb) events.push({ ...base, kind: 'BERTHING', at: iso(c.etb)!, planned: true });
      if (c.status === 'BERTHED' && c.etd) events.push({ ...base, kind: 'SAILING', at: iso(c.etd)!, planned: true });
      if (c.status === 'SAILED' && c.atd && c.atd >= from && c.atd <= to) events.push({ ...base, kind: 'SAILED', at: iso(c.atd)!, planned: false });
    }
    events.sort((a, b) => a.at.localeCompare(b.at));
    const byDay = new Map<string, typeof events>();
    for (const e of events) { const k = dayKey(e.at); const l = byDay.get(k) ?? []; l.push(e); byDay.set(k, l); }
    return { from: from.toISOString(), to: to.toISOString(), days, events, byDay: [...byDay.entries()].map(([date, list]) => ({ date, arrivals: list.filter((e) => e.kind === 'ARRIVAL').length, berthings: list.filter((e) => e.kind === 'BERTHING').length, sailings: list.filter((e) => e.kind === 'SAILING' || e.kind === 'SAILED').length, events: list })) };
  }

  /** Berth window planner: every berth a lane, calls as planned or actual blocks, overlaps computed here. */
  @RequirePerm('portcalls.view') @Get('berth-plan')
  async berthPlan(@Query('from') fromQ?: string, @Query('days') daysQ?: string) {
    const winDays = Math.min(30, Math.max(1, Number.parseInt(String(daysQ ?? ''), 10) || 5));
    const from = fromQ && !Number.isNaN(new Date(fromQ).getTime()) ? new Date(fromQ) : new Date(Date.now() - DAY);
    const to = new Date(from.getTime() + (winDays + 1) * DAY);
    const berths = (await this.pool.query<BerthRow>('SELECT * FROM berths ORDER BY terminal, code')).rows;
    const held = (await this.pool.query<TwinCall>(`${CALL_SQL} WHERE pc.berth_id IS NOT NULL AND pc.status = ANY($1) AND ((pc.atb IS NOT NULL AND pc.atb < $3 AND (pc.atd IS NULL OR pc.atd > $2)) OR (pc.atb IS NULL AND pc.etb IS NOT NULL AND pc.etb < $3 AND pc.etd > $2))`,
      [['CONFIRMED', 'AT_ANCHORAGE', 'BERTHED', 'SAILED'], from, to])).rows;
    const inbound = (await this.pool.query<TwinCall>(`${CALL_SQL} WHERE pc.status = ANY($1) AND (pc.berth_id IS NULL OR pc.etb IS NULL) AND pc.eta < $2 ORDER BY pc.eta LIMIT 20`, [['ANNOUNCED', 'CONFIRMED', 'AT_ANCHORAGE'], to])).rows;
    const blocks = held.map((c) => ({ id: c.id, vcn: c.vcn, berthId: String(c.berth_id), berthCode: c.berth_code, status: c.status, vessel: { name: c.vessel_name, loa: num(c.v_loa), type: c.v_type }, start: iso(c.atb ?? c.etb)!, end: iso(c.atd ?? c.etd), actual: !!c.atb }));
    const byBerth = new Map<string, typeof blocks>();
    for (const b of blocks) { const l = byBerth.get(b.berthId) ?? []; l.push(b); byBerth.set(b.berthId, l); }
    const conflicts: { a: string; b: string; berthId: string }[] = [];
    for (const list of byBerth.values()) {
      list.sort((x, y) => x.start.localeCompare(y.start));
      for (let i = 1; i < list.length; i += 1) {
        const prevEnd = list[i - 1].end ? new Date(list[i - 1].end!).getTime() : 8640000000000000;
        if (new Date(list[i].start).getTime() < prevEnd) conflicts.push({ a: list[i - 1].vcn, b: list[i].vcn, berthId: list[i].berthId });
      }
    }
    return {
      window: { from: from.toISOString(), to: to.toISOString(), days: winDays },
      berths: berths.map((b) => { const a = berthApi(b); return { id: a.id, code: a.code, name: a.name, terminal: a.terminal, berthType: a.berthType, status: a.status, loaMax: a.loaMax, draftMax: a.draftMax }; }),
      blocks, conflicts,
      unallocated: inbound.map((c) => ({ id: c.id, vcn: c.vcn, eta: iso(c.eta)!, status: c.status, vessel: { name: c.vessel_name, loa: num(c.v_loa), type: c.v_type } })),
    };
  }

  /** The craft board — one digest per craft; the jobs array never leaves the server. */
  @RequirePerm('portcalls.view') @Get('resources')
  async resources(@Query('months') monthsQ?: string, @Query('type') type?: string, @Query('status') status?: string) {
    const months = clampMonths(monthsQ, 12); const { from, to } = monthWindow(months);
    const where: string[] = []; const args: unknown[] = [];
    if (type) { args.push(type); where.push(`type = $${args.length}`); }
    if (status) { args.push(status); where.push(`status = $${args.length}`); }
    const rows = (await this.pool.query<ResourceRow>(`SELECT * FROM resources ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY type, code`, args)).rows;
    const { jobsBy, outagesBy } = await this.loadRecords(rows.map((r) => r.id));
    const data = rows.map((r) => ({ ...core(r), service: serviceDigest(jobsBy.get(r.id) ?? [], outagesBy.get(r.id) ?? [], { from, to }) }));
    return paged(data, { total: data.length, page: 1, limit: data.length || 1 });
  }

  /** Fleet-level utilisation — jobs and assist hours per month across every craft, the busiest units and fleet availability. */
  @RequirePerm('portcalls.view') @Get('resources/utilisation')
  async utilisation(@Query('months') monthsQ?: string) {
    const months = clampMonths(monthsQ, 12); const { bounds, from, to } = monthWindow(months); const win = { from, to };
    const rows = (await this.pool.query<ResourceRow>('SELECT * FROM resources ORDER BY type, code')).rows;
    const { jobsBy, outagesBy } = await this.loadRecords(rows.map((r) => r.id));
    const buckets = new Map(bounds.map((b) => [b.key, { month: b.key, label: b.label, jobs: 0, hours: 0 }]));
    const kinds = new Map<string, { kind: string; jobs: number; hours: number }>();
    const types = new Map<string, { type: string; craft: number; jobs: number; hours: number }>();
    const craft: { id: string; code: string; name: string; type: string; spec: string; status: string; jobs: number; hours: number; jobsAllTime: number; hoursAllTime: number; outageDays: number; availabilityPct: number; lastJobAt: string | null }[] = [];
    let allJobs = 0; let allHours = 0; let winJobs = 0; let winHours = 0; let lostDays = 0;
    for (const r of rows) {
      const jobs = jobsBy.get(r.id) ?? []; const outages = outagesBy.get(r.id) ?? [];
      const av = availability(outages, from, to);
      const b = bucketJobs(jobs, bounds, win);
      for (const s of b.series) { const acc = buckets.get(s.month)!; acc.jobs += s.jobs; acc.hours += s.hours; }
      for (const k of b.byKind) { const acc = kinds.get(k.kind) ?? { kind: k.kind, jobs: 0, hours: 0 }; acc.jobs += k.jobs; acc.hours += k.hours; kinds.set(k.kind, acc); }
      const tb = types.get(r.type) ?? { type: r.type, craft: 0, jobs: 0, hours: 0 };
      tb.craft += 1; tb.jobs += b.windowJobs; tb.hours += b.windowHours; types.set(r.type, tb);
      const hoursAllTime = round1(jobs.reduce((s, j) => s + j.hours, 0));
      allJobs += jobs.length; allHours += hoursAllTime; winJobs += b.windowJobs; winHours += b.windowHours; lostDays += av.days;
      craft.push({ ...core(r), jobs: b.windowJobs, hours: b.windowHours, jobsAllTime: jobs.length, hoursAllTime, outageDays: av.days, availabilityPct: av.availabilityPct, lastJobAt: jobs.length ? jobs[0].at : null });
    }
    const spanDays = (to.getTime() - from.getTime()) / DAY;
    craft.sort((a, b) => b.jobs - a.jobs || a.code.localeCompare(b.code));
    return {
      window: { from: iso(from)!, to: iso(to)!, months },
      totals: { craft: rows.length, jobs: winJobs, hours: round1(winHours), jobsAllTime: allJobs, hoursAllTime: round1(allHours), avgJobsPerMonth: round1(winJobs / months), avgHoursPerJob: winJobs ? round1(winHours / winJobs) : 0, outageDays: round1(lostDays), availabilityPct: rows.length ? round1(Math.max(0, 100 - (lostDays / (rows.length * spanDays)) * 100)) : 100 },
      series: [...buckets.values()].map((b) => ({ ...b, hours: round1(b.hours) })),
      byKind: [...kinds.values()].sort((a, b) => b.jobs - a.jobs).map((k) => ({ ...k, hours: round1(k.hours) })),
      byType: [...types.values()].map((t) => ({ ...t, hours: round1(t.hours) })),
      craft,
    };
  }

  /** One craft's service record — the utilisation reading plus a page of its jobs. */
  @RequirePerm('portcalls.view') @Get('resources/:id/history')
  async history(@Param('id') id: string, @Query('months') monthsQ?: string, @Query('page') pageQ?: string, @Query('limit') limitQ?: string, @Query('kind') kind?: string) {
    const r = await findResource(this.pool, id); if (!r) throw notFound('Resource not found');
    const jobs = await jobsOf(this.pool, r.id); const outages = await resourceOutagesOf(this.pool, r.id);
    const report = historyReport(r, jobs, outages, clampMonths(monthsQ, 12));
    const page = Math.max(1, Number.parseInt(String(pageQ ?? ''), 10) || 1);
    const limit = Math.min(200, Math.max(1, Number.parseInt(String(limitQ ?? ''), 10) || 25));
    const kinds = [...new Set(jobs.map((j) => j.kind).filter(Boolean))].sort();
    const filtered = kind ? jobs.filter((j) => j.kind === kind) : jobs;
    return { success: true, data: { ...report, jobs: filtered.slice((page - 1) * limit, page * limit) }, meta: { total: filtered.length, page, limit, kinds } };
  }

  @RequirePerm('portcalls.view') @Get('resources/:id')
  async resource(@Param('id') id: string, @Query('months') monthsQ?: string) {
    const r = await findResource(this.pool, id); if (!r) throw notFound('Resource not found');
    const months = clampMonths(monthsQ, 12); const { from, to } = monthWindow(months);
    const jobs = await jobsOf(this.pool, r.id); const outages = await resourceOutagesOf(this.pool, r.id);
    return { ...core(r), service: serviceDigest(jobs, outages, { from, to }), outages };
  }

  @RequirePerm('masters.manage', 'portcalls.edit') @Post('resources')
  async createResource(@Body(zod(createResourceSchema)) b: z.infer<typeof createResourceSchema>) {
    return withTx(this.pool, async (c) => {
      const dup = await c.query('SELECT id FROM resources WHERE code = $1', [b.code]); if (dup.rowCount) throw conflict(`Craft ${b.code} already exists`);
      const r = (await c.query<ResourceRow>('INSERT INTO resources(code, name, type, spec, status, master, contact, remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [b.code, b.name, b.type, b.spec, b.status, b.master, b.contact, b.remarks])).rows[0];
      await this.audit.record(c, { action: 'CREATE', entity: 'Resource', entityId: r.id, entityLabel: `${r.code} — ${r.name}`, after: core(r) });
      await publishResource(c, this.env, r, { event: EVENTS.ports.resourceChanged, data: { change: 'CREATED' } });
      return resourceApi(r);
    });
  }

  /** The duty officer's board: mark a craft tasked, back on station, under maintenance or off duty. */
  @RequirePerm('portcalls.edit', 'masters.manage') @Put('resources/:id')
  async setStatus(@Param('id') id: string, @Body(zod(statusSchema)) b: z.infer<typeof statusSchema>) {
    return withTx(this.pool, async (c) => {
      const before = await findResource(c, id); if (!before) throw notFound('Resource not found');
      const status = b.status ?? before.status;
      const cols: Record<string, unknown> = { status, current_task: status === 'TASKED' ? (b.currentTask ?? before.current_task) : '', remarks: b.remarks, master: b.master, contact: b.contact, spec: b.spec, name: b.name };
      const keys = Object.keys(cols).filter((k) => cols[k] !== undefined);
      await c.query(`UPDATE resources SET ${keys.map((k, i) => `${k} = $${i + 2}`).concat('updated_at = now()').join(', ')} WHERE id = $1`, [before.id, ...keys.map((k) => cols[k])]);
      const r = (await findResource(c, before.id))!;
      await this.audit.record(c, { action: 'UPDATE', entity: 'Resource', entityId: r.id, entityLabel: `${r.code} — ${r.name}`, before: core(before), after: core(r) });
      await publishResource(c, this.env, r, { event: EVENTS.ports.resourceChanged, data: { change: 'STATUS', from: before.status, to: r.status } });
      const { from, to } = monthWindow(12);
      return { ...core(r), service: serviceDigest(await jobsOf(c, r.id), await resourceOutagesOf(c, r.id), { from, to }) };
    });
  }

  @RequirePerm('masters.manage') @Delete('resources/:id')
  async removeResource(@Param('id') id: string) {
    return withTx(this.pool, async (c) => {
      const r = await findResource(c, id); if (!r) throw notFound('Resource not found');
      if (r.status === 'TASKED') throw badRequest('This craft is on a job — stand her down first');
      await c.query('DELETE FROM resources WHERE id = $1', [r.id]);
      await this.audit.record(c, { action: 'DELETE', entity: 'Resource', entityId: r.id, entityLabel: `${r.code} — ${r.name}`, before: core(r) });
      await publishResourceDeleted(c, this.env, r);
      return { deleted: true };
    });
  }

  /** Assign a craft to a call. The job joins her service record and, while it is open, she reads as tasked. */
  @RequirePerm('portcalls.edit') @Post('resources/:id/jobs')
  async assign(@Param('id') id: string, @Body(zod(jobSchema)) b: z.infer<typeof jobSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const r = await findResource(c, id); if (!r) throw notFound('Resource not found');
      if (r.status === 'MAINTENANCE' || r.status === 'OFF_DUTY') throw conflict(`${r.code} is ${r.status.toLowerCase().replace('_', ' ')} and cannot be tasked`);
      const at = b.at ? new Date(b.at) : new Date();
      if (Number.isNaN(at.getTime())) throw badRequest('A job needs a valid time');
      const endedAt = b.endedAt ? new Date(b.endedAt) : null;
      let vcn = b.vcn ?? ''; let vesselName = b.vesselName ?? ''; let berth = b.berth ?? '';
      if (b.portCallId) {
        const call = (await c.query<{ id: string; vcn: string; vessel_name: string; berth_code: string | null }>('SELECT id, vcn, vessel_name, berth_code FROM port_calls WHERE id::text = $1 OR vcn = $1', [b.portCallId])).rows[0];
        if (!call) throw badRequest('Port call not found');
        vcn = call.vcn; vesselName = call.vessel_name; berth = call.berth_code ?? berth;
      }
      const hours = b.hours ?? (endedAt ? round1((endedAt.getTime() - at.getTime()) / 3600000) : 0);
      const job = (await c.query<JobRow>('INSERT INTO resource_jobs(resource_id, at, ended_at, kind, vcn, port_call_id, vessel_name, berth, hours, remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *',
        [r.id, at, endedAt, b.kind, vcn, b.portCallId ?? null, vesselName, berth, hours, b.remarks ?? ''])).rows[0];
      const task = b.task ?? (vcn ? `${vcn} — ${b.kind.toLowerCase().replace(/_/g, ' ')}` : b.kind.toLowerCase().replace(/_/g, ' '));
      if (!endedAt) await c.query("UPDATE resources SET status = 'TASKED', current_task = $2, updated_at = now() WHERE id = $1", [r.id, task]);
      const fresh = (await findResource(c, r.id))!;
      await this.audit.record(c, { action: 'JOB_ASSIGN', entity: 'Resource', entityId: r.id, entityLabel: `${r.code} — ${b.kind}${vcn ? ` (${vcn})` : ''}`, after: { jobId: job.id, kind: b.kind, at: at.toISOString(), vcn, hours }, actor: user ? undefined : { id: 'system', name: 'system', kind: 'system' } });
      await publishResource(c, this.env, fresh, { event: EVENTS.ports.resourceChanged, data: { change: 'JOB_ASSIGNED', jobId: job.id, kind: b.kind, vcn, portCallId: b.portCallId ?? null, at: at.toISOString(), hours } });
      const { from, to } = monthWindow(12);
      return { ...core(fresh), job: { id: job.id, at: iso(job.at)!, endedAt: iso(job.ended_at), kind: job.kind, vcn: job.vcn, portCallId: job.port_call_id, vesselName: job.vessel_name, berth: job.berth, hours: Number(job.hours), remarks: job.remarks }, service: serviceDigest(await jobsOf(c, fresh.id), await resourceOutagesOf(c, fresh.id), { from, to }) };
    });
  }

  /** Close an open job: the craft goes back on station and the hours join her record. */
  @RequirePerm('portcalls.edit') @Put('resources/:id/jobs/:jobId')
  async closeJob(@Param('id') id: string, @Param('jobId') jobId: string, @Body(zod(z.object({ endedAt: z.string().optional(), hours: z.coerce.number().min(0).max(240).optional(), remarks: text(1000).optional() }))) b: { endedAt?: string; hours?: number; remarks?: string }) {
    return withTx(this.pool, async (c) => {
      const r = await findResource(c, id); if (!r) throw notFound('Resource not found');
      const job = (await c.query<JobRow>('SELECT * FROM resource_jobs WHERE id = $1 AND resource_id = $2', [jobId, r.id])).rows[0];
      if (!job) throw notFound('Job not found');
      const endedAt = b.endedAt ? new Date(b.endedAt) : new Date();
      const hours = b.hours ?? round1((endedAt.getTime() - job.at.getTime()) / 3600000);
      await c.query('UPDATE resource_jobs SET ended_at = $2, hours = $3, remarks = COALESCE($4, remarks) WHERE id = $1', [jobId, endedAt, hours, b.remarks ?? null]);
      const stillOpen = await c.query<{ n: string }>('SELECT count(*) AS n FROM resource_jobs WHERE resource_id = $1 AND ended_at IS NULL', [r.id]);
      if (Number(stillOpen.rows[0].n) === 0 && r.status === 'TASKED') await c.query("UPDATE resources SET status = 'AVAILABLE', current_task = '', updated_at = now() WHERE id = $1", [r.id]);
      const fresh = (await findResource(c, r.id))!;
      await this.audit.record(c, { action: 'JOB_CLOSE', entity: 'Resource', entityId: r.id, entityLabel: `${r.code} — ${job.kind}`, before: { jobId, endedAt: null }, after: { jobId, endedAt: endedAt.toISOString(), hours } });
      await publishResource(c, this.env, fresh, { event: EVENTS.ports.resourceChanged, data: { change: 'JOB_CLOSED', jobId, hours } });
      const { from, to } = monthWindow(12);
      return { ...core(fresh), service: serviceDigest(await jobsOf(c, fresh.id), await resourceOutagesOf(c, fresh.id), { from, to }) };
    });
  }

  /** A craft off the water: docking, survey or leave. */
  @RequirePerm('masters.manage', 'portcalls.edit') @Post('resources/:id/outages')
  async addResourceOutage(@Param('id') id: string, @Body(zod(resourceOutageSchema)) b: z.infer<typeof resourceOutageSchema>) {
    const from = new Date(b.from); const to = new Date(b.to);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) throw badRequest('An outage needs a valid from and to');
    if (to <= from) throw badRequest('An outage must end after it starts');
    return withTx(this.pool, async (c) => {
      const r = await findResource(c, id); if (!r) throw notFound('Resource not found');
      const clash = await c.query('SELECT id FROM resource_outages WHERE resource_id = $1 AND from_at < $3 AND to_at > $2 LIMIT 1', [r.id, from, to]);
      if (clash.rowCount) throw conflict(`${r.code} already has an out-of-service window across those dates`);
      const row = (await c.query<ResourceOutageRow>('INSERT INTO resource_outages(resource_id, from_at, to_at, days, reason) VALUES ($1,$2,$3,$4,$5) RETURNING *', [r.id, from, to, daysBetween(from, to), b.reason])).rows[0];
      if (from <= new Date() && to > new Date()) await c.query("UPDATE resources SET status = 'MAINTENANCE', current_task = '', updated_at = now() WHERE id = $1", [r.id]);
      const fresh = (await findResource(c, r.id))!;
      await this.audit.record(c, { action: 'OUTAGE_ADD', entity: 'Resource', entityId: r.id, entityLabel: `${r.code} — ${b.reason || 'out of service'}`, after: { id: row.id, from: from.toISOString(), to: to.toISOString(), reason: b.reason } });
      await publishResource(c, this.env, fresh, { event: EVENTS.ports.resourceChanged, data: { change: 'OUTAGE_ADDED', outageId: row.id, from: from.toISOString(), to: to.toISOString(), reason: b.reason } });
      return historyReport(fresh, await jobsOf(c, fresh.id), await resourceOutagesOf(c, fresh.id), 12);
    });
  }

  private async loadRecords(ids: string[]): Promise<{ jobsBy: Map<string, JobApi[]>; outagesBy: Map<string, OutageApi[]> }> {
    const jobsBy = new Map<string, JobApi[]>(); const outagesBy = new Map<string, OutageApi[]>();
    if (!ids.length) return { jobsBy, outagesBy };
    const jobs = (await this.pool.query<JobRow>('SELECT * FROM resource_jobs WHERE resource_id = ANY($1) ORDER BY at DESC', [ids])).rows;
    for (const j of jobs) { const l = jobsBy.get(j.resource_id) ?? []; l.push({ id: j.id, at: iso(j.at)!, endedAt: iso(j.ended_at), kind: j.kind, vcn: j.vcn, portCallId: j.port_call_id, vesselName: j.vessel_name, berth: j.berth, hours: Number(j.hours) || 0, remarks: j.remarks }); jobsBy.set(j.resource_id, l); }
    const outs = (await this.pool.query<ResourceOutageRow>('SELECT * FROM resource_outages WHERE resource_id = ANY($1) ORDER BY from_at DESC', [ids])).rows;
    for (const o of outs) { const l = outagesBy.get(o.resource_id) ?? []; l.push({ id: o.id, from: iso(o.from_at)!, to: iso(o.to_at)!, days: Number(o.days) || 0, reason: o.reason }); outagesBy.set(o.resource_id, l); }
    return { jobsBy, outagesBy };
  }
}
