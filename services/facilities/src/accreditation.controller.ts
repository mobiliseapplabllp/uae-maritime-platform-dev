import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { PageQuery } from '@maritime/contracts';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, escapeLike, notFound, paged, parsePage, scopeWhere, visibleTo, withTx, zod, type Principal } from '@maritime/service-kit';
import { SUBJECT_SCOPE } from './scope';
import type { Env } from './env';
import { AUDIT_RESULTS, CYCLE_STATUS, VISIT_STATUS, cycleApi, visitApi, type CycleRow, type VisitRow } from './directory';
import { accreditationDashboard, parseDays, schemes, sweepAccreditations } from './accreditation';
import { cancelVisit, completeVisit, loadVisit } from './visits';

/* The accreditation desk: every company under every scheme, where each cycle stands today, the visits
 * planned and paid, and the renewals coming up. A cycle is read against the calendar on the way out, so the
 * list is right on the day even before the daily sweep has written the change. */

const text = (max: number) => z.string().trim().max(max);
export const findingSchema = z.object({ code: text(40).default(''), title: text(200).min(2), severity: z.enum(['MINOR', 'MAJOR', 'CRITICAL']).default('MINOR'), dueDays: z.coerce.number().int().min(1).max(365).optional().nullable() });
export const completeSchema = z.object({
  visitedOn: z.union([text(40), z.null()]).optional(), result: z.enum(AUDIT_RESULTS), score: z.coerce.number().min(0).max(100).optional().nullable(),
  findings: z.array(findingSchema).max(50).default([]), remarks: text(4000).default(''), reportDocumentId: text(80).nullish(), inspector: text(120).optional(), inspectorId: text(80).nullish(),
});
const cancelSchema = z.object({ reason: text(600).min(1) });
const sweepSchema = z.object({ now: text(40).optional() });

@Controller('facilities')
export class AccreditationController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}
  private reminderDays(all: Awaited<ReturnType<typeof schemes>>) { return (cat: string) => all.find((s) => s.category === cat)?.reminderDays ?? parseDays(this.env.ACCREDITATION_REMINDER_DAYS, [90, 30, 7]); }

  /** The desk at a glance, per scheme. */
  @RequirePerm('facilities.view', 'dashboard.view') @Get('accreditations/dashboard')
  async dashboard(@CurrentUser() user: Principal) {
    const all = await schemes(this.pool, this.env); const days = this.reminderDays(all); const now = new Date();
    const cw: string[] = []; const ca: unknown[] = []; scopeWhere(user.scope, cw, ca, SUBJECT_SCOPE);
    const w = cw.length ? `WHERE ${cw.join(' AND ')}` : '';
    // the latest cycle under each scheme for each company is the position; earlier cycles are history
    const cycles = await this.pool.query<CycleRow>(`SELECT DISTINCT ON (company_id, category) * FROM accreditation_cycles ${w} ORDER BY company_id, category, cycle_no DESC`, ca);
    const visits = await this.pool.query<VisitRow>(`SELECT * FROM visits ${w} ORDER BY coalesce(visited_on, scheduled_on::timestamptz) DESC NULLS LAST`, ca);
    return accreditationDashboard(cycles.rows.map((r) => cycleApi(r, now, days(r.category))), visits.rows.map((v) => visitApi(v, now)), all, now);
  }

  /** The schemes as the master declares them, with their cycles — what a screen offers and what the desk validates against. */
  @RequirePerm('facilities.view') @Get('accreditations/schemes')
  async schemes() { return schemes(this.pool, this.env); }

  /** The work list: cycles by scheme and standing, worst first. */
  @RequirePerm('facilities.view') @Get('accreditations')
  async list(@Query() query: PageQuery & { category?: string; status?: string; companyId?: string; dueWithin?: string; history?: string }, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: 'endsOn', sortable: ['endsOn', 'startsOn', 'companyName', 'category', 'cycleNo', 'rating'], maxLimit: 500 });
    const all = await schemes(this.pool, this.env); const days = this.reminderDays(all); const now = new Date();
    const where: string[] = []; const args: unknown[] = [];
    const add = (sql: (i: number) => string, value: unknown) => { args.push(value); where.push(sql(args.length)); };
    if (query.category) add((i) => `category = $${i}`, query.category);
    if (query.companyId) add((i) => `company_id = $${i}`, query.companyId);
    if (p.q) add((i) => `(company_name ILIKE $${i} OR instrument_no ILIKE $${i} OR category ILIKE $${i})`, `%${escapeLike(p.q)}%`);
    scopeWhere(user.scope, where, args, SUBJECT_SCOPE);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const r = await this.pool.query<CycleRow>(query.history === 'true' ? `SELECT * FROM accreditation_cycles ${w}` : `SELECT DISTINCT ON (company_id, category) * FROM accreditation_cycles ${w} ORDER BY company_id, category, cycle_no DESC`, args);
    let rows = r.rows.map((x) => cycleApi(x, now, days(x.category)));
    if (query.status) rows = rows.filter((x) => x.status === query.status);
    const within = Number(query.dueWithin); if (Number.isFinite(within) && within > 0) rows = rows.filter((x) => (x.status === 'CURRENT' || x.status === 'DUE') && x.daysLeft <= within);
    const key = p.sortField as keyof (typeof rows)[number];
    rows.sort((a, b) => { const av = a[key] ?? ''; const bv = b[key] ?? ''; const cmp = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv)); return String(p.sortDir).toLowerCase() === 'desc' ? -cmp : cmp; });
    return paged(rows.slice(p.offset, p.offset + p.limit), { total: rows.length, page: p.page, limit: p.limit, statuses: [...CYCLE_STATUS] });
  }

  @RequirePerm('facilities.view') @Get('accreditations/:id')
  async get(@Param('id') id: string, @CurrentUser() user: Principal) {
    const r = await this.pool.query<CycleRow>('SELECT * FROM accreditation_cycles WHERE id::text = $1', [id]);
    const row = r.rows[0];
    if (!row || !visibleTo(user.scope, { company: row.scope_company }, SUBJECT_SCOPE)) throw notFound('Accreditation cycle not found');
    const all = await schemes(this.pool, this.env);
    const visits = await this.pool.query<VisitRow>('SELECT * FROM visits WHERE cycle_id = $1 ORDER BY coalesce(visited_on, scheduled_on::timestamptz) DESC NULLS LAST', [row.id]);
    const history = await this.pool.query<CycleRow>('SELECT * FROM accreditation_cycles WHERE company_id = $1 AND category = $2 ORDER BY cycle_no DESC', [row.company_id, row.category]);
    const days = this.reminderDays(all);
    return { ...cycleApi(row, new Date(), days(row.category)), scheme: all.find((s) => s.category === row.category) ?? null, visits: visits.rows.map((v) => visitApi(v)), history: history.rows.map((h) => cycleApi(h, new Date(), days(h.category))) };
  }

  /* The sweep the scheduler fires daily can also be run by hand — after a master's reminder window is
   * changed, say — and answers with what it did. The clock can be set for a dry run in the past or future. */
  @RequirePerm('facilities.approve') @Post('accreditations/sweep')
  async sweep(@Body(zod(sweepSchema)) b: z.infer<typeof sweepSchema>) {
    const now = b.now ? new Date(b.now) : new Date();
    return withTx(this.pool, (c) => sweepAccreditations(c, this.env, this.audit, Number.isNaN(now.getTime()) ? new Date() : now));
  }

  /* Visits across the register: what is planned, what is overdue, what was found. */
  @RequirePerm('facilities.view') @Get('visits')
  async visits(@Query() query: PageQuery & { status?: string; visitType?: string; subjectKind?: string; subjectId?: string; category?: string; result?: string; overdue?: string; from?: string; to?: string }, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: '-date', sortable: ['date', 'number', 'subjectName', 'visitType', 'status', 'result', 'score'], maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    const add = (sql: (i: number) => string, value: unknown) => { args.push(value); where.push(sql(args.length)); };
    if (query.status) add((i) => `status = $${i}`, query.status);
    if (query.visitType) add((i) => `visit_type = $${i}`, query.visitType);
    if (query.subjectKind) add((i) => `subject_kind = $${i}`, query.subjectKind);
    if (query.subjectId) add((i) => `subject_id = $${i}`, query.subjectId);
    if (query.category) add((i) => `category = $${i}`, query.category);
    if (query.result) add((i) => `result = $${i}`, query.result);
    if (query.overdue === 'true') where.push(`status = 'SCHEDULED' AND scheduled_on < current_date`);
    if (query.from) add((i) => `coalesce(visited_on, scheduled_on::timestamptz) >= $${i}`, new Date(query.from));
    if (query.to) add((i) => `coalesce(visited_on, scheduled_on::timestamptz) <= $${i}`, new Date(`${query.to}T23:59:59Z`));
    if (p.q) add((i) => `(number ILIKE $${i} OR subject_name ILIKE $${i} OR inspector ILIKE $${i} OR remarks ILIKE $${i})`, `%${escapeLike(p.q)}%`);
    scopeWhere(user.scope, where, args, SUBJECT_SCOPE);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const col: Record<string, string> = { date: 'coalesce(visited_on, scheduled_on::timestamptz)', number: 'number', subjectName: 'subject_name', visitType: 'visit_type', status: 'status', result: 'result', score: 'score' };
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM visits ${w}`, args);
    const rows = await this.pool.query<VisitRow>(`SELECT * FROM visits ${w} ORDER BY ${col[p.sortField]} ${p.sortDir} NULLS LAST, number DESC LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map((v) => visitApi(v)), { total: Number(total.rows[0].n), page: p.page, limit: p.limit, statuses: [...VISIT_STATUS] });
  }
  @RequirePerm('facilities.view') @Get('visits/:id')
  async visit(@Param('id') id: string, @CurrentUser() user: Principal) {
    const row = await loadVisit(this.pool, id);
    if (!visibleTo(user.scope, { company: row.scope_company }, SUBJECT_SCOPE)) throw notFound('Visit not found');
    return visitApi(row);
  }
  /** Recording what a visit found is the write that moves the rating and raises the obligations, in one transaction. */
  @RequirePerm('facilities.manage') @Post('visits/:id/complete')
  async complete(@Param('id') id: string, @Body(zod(completeSchema)) b: z.infer<typeof completeSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await loadVisit(c, id);
      if (!visibleTo(user.scope, { company: before.scope_company }, SUBJECT_SCOPE)) throw notFound('Visit not found');
      const done = await completeVisit(c, this.env, this.audit, before.id, b, user);
      return { visit: visitApi(done.row), rating: done.rating, obligations: done.obligations, cycle: done.cycle ? cycleApi(done.cycle) : null };
    });
  }
  @RequirePerm('facilities.manage') @Post('visits/:id/cancel')
  async cancel(@Param('id') id: string, @Body(zod(cancelSchema)) b: z.infer<typeof cancelSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await loadVisit(c, id);
      if (!visibleTo(user.scope, { company: before.scope_company }, SUBJECT_SCOPE)) throw notFound('Visit not found');
      return visitApi(await cancelVisit(c, this.env, this.audit, before.id, b.reason, user));
    });
  }
}
