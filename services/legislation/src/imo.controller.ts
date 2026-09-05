import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { PageQuery } from '@maritime/contracts';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, escapeLike, notFound, paged, parsePage, withTx, zod, type Principal } from '@maritime/service-kit';
import type { Env } from './env';
import { IMO_FEED } from './feed.token';
import { ITEM_STATUS, assessItem, itemApi, pollApi, pollSources, pollStates, sources, watchDashboard, type ItemRow, type SourceFeed } from './imo';

/* The IMO watch's API: the monitored sources and their health, the documents they produced, and the desk's decisions. */
const text = (max: number) => z.string().trim().max(max);
const pollBody = z.object({ source: text(40).optional(), force: z.coerce.boolean().default(false) });
const assessBody = z.object({ status: z.enum(ITEM_STATUS), assessment: text(4000).default(''), dueOn: z.union([z.string().trim(), z.null()]).optional(), instrumentRef: text(80).nullish() });
const SORT: Record<string, string> = { publishedOn: 'published_on', reference: 'reference', title: 'title', source: 'source', status: 'status', firstSeenAt: 'first_seen_at', dueOn: 'due_on', updatedAt: 'updated_at' };
type ListQuery = PageQuery & { status?: string; source?: string; subject?: string; overdue?: string };

@Controller('legislation/imo')
export class ImoWatchController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, @Inject(IMO_FEED) private readonly feed: SourceFeed, private readonly audit: AuditClient) {}

  private async labels() { const all = await sources(this.pool); return new Map(all.map((s) => [s.code, s])); }

  /** The sources the master names, each with its poll state. */
  @RequirePerm('legislation.view') @Get('sources')
  async listSources() {
    const [all, states] = await Promise.all([sources(this.pool), pollStates(this.pool)]);
    return all.map((s) => pollApi(states.get(s.code), s));
  }

  /** Reads the sources now — all that are due, every one when forced, or the one named. */
  @RequirePerm('legislation.manage') @Post('poll')
  async poll(@Body(zod(pollBody)) body: z.infer<typeof pollBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, (c) => pollSources(c, this.env, this.audit, this.feed, { force: body.force, only: body.source, actor: { id: user.id, name: user.name, kind: 'user' } }));
  }

  @RequirePerm('legislation.view') @Get('dashboard')
  async dashboard() {
    const [all, states, labels] = await Promise.all([sources(this.pool), pollStates(this.pool), this.labels()]);
    const rows = (await this.pool.query<ItemRow>('SELECT * FROM imo_watch_items ORDER BY published_on DESC NULLS LAST')).rows;
    const now = new Date();
    return watchDashboard(rows.map((r) => itemApi(r, { sourceLabel: labels.get(r.source)?.label, sourceLabelAr: labels.get(r.source)?.labelAr, assessDays: this.env.IMO_ASSESS_DAYS, now })), all.map((s) => pollApi(states.get(s.code), s)), now);
  }

  @RequirePerm('legislation.view') @Get('items')
  async list(@Query() query: ListQuery) {
    const p = parsePage(query, { defaultSort: '-publishedOn', sortable: Object.keys(SORT), maxLimit: 200 });
    const where: string[] = []; const args: unknown[] = [];
    const eq = (col: string, v: string | undefined) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
    eq('status', query.status); eq('source', query.source); eq('subject', query.subject);
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(reference ILIKE $${args.length} OR title ILIKE $${args.length} OR subject ILIKE $${args.length} OR instrument_ref ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM imo_watch_items ${w}`, args);
    const rows = await this.pool.query<ItemRow>(`SELECT * FROM imo_watch_items ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, reference LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    const labels = await this.labels(); const now = new Date();
    let out = rows.rows.map((r) => itemApi(r, { sourceLabel: labels.get(r.source)?.label, sourceLabelAr: labels.get(r.source)?.labelAr, assessDays: this.env.IMO_ASSESS_DAYS, now }));
    if (String(query.overdue) === 'true') { out = out.filter((i) => i.overdue); return paged(out, { total: out.length, page: p.page, limit: p.limit }); }
    return paged(out, { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  @RequirePerm('legislation.view') @Get('items/:id')
  async get(@Param('id') id: string) {
    const r = await this.pool.query<ItemRow>('SELECT * FROM imo_watch_items WHERE id::text = $1', [id]);
    if (!r.rows[0]) throw notFound('Watch item not found');
    const labels = await this.labels();
    return itemApi(r.rows[0], { sourceLabel: labels.get(r.rows[0].source)?.label, sourceLabelAr: labels.get(r.rows[0].source)?.labelAr, assessDays: this.env.IMO_ASSESS_DAYS });
  }

  @RequirePerm('legislation.manage') @Post('items/:id/assess')
  async assess(@Param('id') id: string, @Body(zod(assessBody)) body: z.infer<typeof assessBody>, @CurrentUser() user: Principal) {
    const row = await withTx(this.pool, (c) => assessItem(c, this.env, this.audit, id, body, user));
    const labels = await this.labels();
    return itemApi(row, { sourceLabel: labels.get(row.source)?.label, sourceLabelAr: labels.get(row.source)?.labelAr, assessDays: this.env.IMO_ASSESS_DAYS });
  }
}
