import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, getJurisdiction, makeEvent, type Actor, type EventEnvelope, type PageQuery } from '@maritime/contracts';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, badRequest, conflict, enqueue, escapeLike, eventFromContext, notFound, paged, parsePage, withTx, zod, type Principal, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { iso, newId, num, round2 } from './invoicing';

/* The published rate card. A rate only ever changes by publishing a revision — the trail that led to today's figure is kept
 * on the head itself, so a rate can be read back as at any date and the invoice screens can show what changed and when. */
export const TARIFF_CATEGORIES = ['MARINE', 'CARGO', 'MISC'] as const;
const text = (max: number) => z.string().trim().max(max);
const createSchema = z.object({
  code: text(30).min(1), name: text(160).min(1), nameAr: text(160).optional().nullable(), category: z.enum(TARIFF_CATEGORIES).default('MARINE'),
  unit: text(60).default(''), rate: z.coerce.number().min(0).max(1e9), currency: text(8).optional(), active: z.coerce.boolean().default(true),
});
const updateSchema = createSchema.partial().extend({ effectiveFrom: z.string().optional(), circular: text(80).optional(), note: text(500).optional() });
const revisionSchema = z.object({ rate: z.coerce.number().min(0).max(1e9), effectiveFrom: z.string().optional(), circular: text(80).optional(), note: text(500).optional() });

export interface Revision { id: string; effectiveFrom: string; rate: number; previousRate: number; changePct: number; circular: string; note: string }
export interface TariffRow { id: string; code: string; name: string; name_ar: string | null; category: string; unit: string; rate: string | number; currency: string; active: boolean; revisions: Revision[]; created_at: Date; updated_at: Date }
export const toApi = (t: TariffRow) => ({ id: t.id, code: t.code, name: t.name, nameAr: t.name_ar, category: t.category, unit: t.unit, rate: num(t.rate), currency: t.currency, active: t.active, revisions: t.revisions ?? [], createdAt: iso(t.created_at), updatedAt: iso(t.updated_at) });

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const round1 = (n: number) => Math.round(n * 10) / 10;
const YEAR = 365.25 * 24 * 3600_000;
/** The published trail for one head, the step series a chart needs and the readings that summarise it. */
export function history(t: TariffRow) {
  const item = toApi(t);
  const revisions = [...(t.revisions ?? [])].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  const first = revisions[0]; const last = revisions[revisions.length - 1];
  const baseRate = first ? (first.previousRate ?? first.rate) : item.rate;
  const series: { label: string; rate: number; effectiveFrom: string | null; changePct: number | null; circular: string }[] = [{ label: 'Base', rate: baseRate, effectiveFrom: null, changePct: null, circular: '' }];
  for (const r of revisions) { const d = new Date(r.effectiveFrom); series.push({ label: `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`, rate: r.rate, effectiveFrom: r.effectiveFrom, changePct: r.changePct, circular: r.circular ?? '' }); }
  if (revisions.length && item.rate !== last.rate) series.push({ label: 'Current', rate: item.rate, effectiveFrom: null, changePct: null, circular: '' });
  const spanYears = first && last ? Math.max(1, (new Date(last.effectiveFrom).getTime() - new Date(first.effectiveFrom).getTime()) / YEAR + 1) : 0;
  return {
    item, revisions, series,
    summary: {
      revisions: revisions.length, baseRate, currentRate: item.rate,
      firstEffectiveFrom: first ? first.effectiveFrom : null, lastEffectiveFrom: last ? last.effectiveFrom : null,
      lastChangePct: last ? last.changePct : null, lastCircular: last ? last.circular ?? '' : '',
      totalChangePct: round1(baseRate ? ((item.rate - baseRate) / baseRate) * 100 : 0),
      avgChangePct: revisions.length ? round1(revisions.reduce((s, r) => s + (r.changePct || 0), 0) / revisions.length) : 0,
      cagrPct: baseRate > 0 && spanYears > 0 ? round1((((item.rate / baseRate) ** (1 / spanYears)) - 1) * 100) : 0,
    },
  };
}
/** The rate in force on a given date, from the published trail. */
export function rateAsAt(revisions: Revision[], baseRate: number, when: Date): { rate: number; revision: Revision | null } {
  let rate = baseRate; let revision: Revision | null = null;
  for (const r of [...revisions].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom))) if (new Date(r.effectiveFrom).getTime() <= when.getTime()) { rate = r.rate; revision = r; }
  return { rate, revision };
}
export async function publishTariff(c: Queryable, env: Env, t: TariffRow, opts: { data?: Record<string, unknown>; cause?: EventEnvelope; actor?: Actor } = {}) {
  const entity = toApi(t);
  const mk = <T,>(type: string, data: T) => (opts.cause ? makeEvent({ type, source: env.SERVICE_NAME, data, subject: t.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor }) : eventFromContext(env.SERVICE_NAME, type, data, { subject: t.id, actor: opts.actor }));
  await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'tariff', entity }));
  await enqueue(c, mk(EVENTS.revenue.tariffChanged, { tariffId: t.id, code: t.code, name: t.name, rate: entity.rate, currency: t.currency, active: t.active, tariff: entity, ...(opts.data ?? {}) }));
}

const SORT: Record<string, string> = { code: 'code', name: 'name', category: 'category', rate: 'rate', unit: 'unit', active: 'active', createdAt: 'created_at' };
type ListQuery = PageQuery & { category?: string; active?: string };

@Controller('tariffs')
export class TariffsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  @RequirePerm('tariffs.view', 'invoices.view') @Get()
  async list(@Query() query: ListQuery) {
    const p = parsePage(query, { defaultSort: 'code', sortable: Object.keys(SORT), maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    if (query.category) { args.push(query.category); where.push(`category = $${args.length}`); }
    if (query.active === 'true' || query.active === 'false') { args.push(query.active === 'true'); where.push(`active = $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(code ILIKE $${args.length} OR name ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM tariffs ${w}`, args);
    const rows = await this.pool.query<TariffRow>(`SELECT * FROM tariffs ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, code LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(toApi), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  @RequirePerm('tariffs.view', 'invoices.view') @Get('meta')
  meta() { const j = getJurisdiction(this.env.JURISDICTION); return { categories: TARIFF_CATEGORIES, currency: j.currency, tax: j.tax }; }

  @RequirePerm('tariffs.view', 'invoices.view') @Get(':id')
  async get(@Param('id') id: string) {
    const t = await this.find(id); return toApi(t);
  }

  /** The published rate history: the trail, the step series and the reading as at any date. */
  @RequirePerm('tariffs.view', 'invoices.view') @Get(':id/history')
  async historyOf(@Param('id') id: string, @Query('asAt') asAt?: string) {
    const t = await this.find(id); const h = history(t);
    const when = asAt && !Number.isNaN(new Date(asAt).getTime()) ? new Date(asAt) : new Date();
    return { ...h, asAt: { at: when.toISOString(), ...rateAsAt(h.revisions, h.summary.baseRate, when) } };
  }

  @RequirePerm('tariffs.manage') @Post()
  async create(@Body(zod(createSchema)) b: z.infer<typeof createSchema>) {
    const j = getJurisdiction(this.env.JURISDICTION);
    return withTx(this.pool, async (c) => {
      const dup = await c.query('SELECT id FROM tariffs WHERE code = $1', [b.code]); if (dup.rowCount) throw conflict(`Tariff head ${b.code} already exists`);
      const r = await c.query<TariffRow>('INSERT INTO tariffs(code, name, name_ar, category, unit, rate, currency, active) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *', [b.code, b.name, b.nameAr ?? null, b.category, b.unit, b.rate, b.currency ?? j.currency.code, b.active]);
      const row = r.rows[0];
      await this.audit.record(c, { action: 'CREATE', entity: 'TariffItem', entityId: row.id, entityLabel: row.code, after: toApi(row) });
      await publishTariff(c, this.env, row, { data: { change: 'CREATED' } });
      return toApi(row);
    });
  }

  /** Editing the rate publishes a revision — the trail is how a rate changes, never a silent overwrite. */
  @RequirePerm('tariffs.manage') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(updateSchema)) b: z.infer<typeof updateSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await this.find(id, c);
      const cols: Record<string, unknown> = { code: b.code, name: b.name, name_ar: b.nameAr, category: b.category, unit: b.unit, currency: b.currency, active: b.active };
      let revision: Revision | null = null;
      if (b.rate !== undefined && round2(b.rate) !== round2(num(before.rate))) {
        revision = this.makeRevision(before, b.rate, b.effectiveFrom, b.circular, b.note, user);
        cols.rate = b.rate; cols.revisions = JSON.stringify([...(before.revisions ?? []), revision]);
      }
      const keys = Object.keys(cols).filter((k) => cols[k] !== undefined);
      // nosemgrep: maritime-sql-template-interpolation — keys are this function's own literal field set; every value is a parameter
      if (keys.length) await c.query(`UPDATE tariffs SET ${keys.map((k, i) => `${k} = $${i + 2}`).concat('updated_at = now()').join(', ')} WHERE id = $1`, [before.id, ...keys.map((k) => cols[k])]);
      const row = await this.find(before.id, c);
      await this.audit.record(c, { action: revision ? 'REVISE' : 'UPDATE', entity: 'TariffItem', entityId: row.id, entityLabel: row.code, before: toApi(before), after: toApi(row), note: revision ? `${revision.changePct >= 0 ? '+' : ''}${revision.changePct}% from ${revision.effectiveFrom.slice(0, 10)}` : '' });
      await publishTariff(c, this.env, row, { data: { change: revision ? 'REVISED' : 'UPDATED', revision } });
      return toApi(row);
    });
  }

  /** Publish a new rate with its effective date and circular reference. */
  @RequirePerm('tariffs.manage') @Post(':id/revisions')
  async revise(@Param('id') id: string, @Body(zod(revisionSchema)) b: z.infer<typeof revisionSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await this.find(id, c);
      if (round2(b.rate) === round2(num(before.rate))) throw badRequest('The published rate is already that figure');
      const revision = this.makeRevision(before, b.rate, b.effectiveFrom, b.circular, b.note, user);
      await c.query('UPDATE tariffs SET rate = $2, revisions = $3, updated_at = now() WHERE id = $1', [before.id, b.rate, JSON.stringify([...(before.revisions ?? []), revision])]);
      const row = await this.find(before.id, c);
      await this.audit.record(c, { action: 'REVISE', entity: 'TariffItem', entityId: row.id, entityLabel: row.code, before: { rate: num(before.rate) }, after: { rate: num(row.rate) }, note: revision.circular });
      await publishTariff(c, this.env, row, { data: { change: 'REVISED', revision } });
      return history(row);
    });
  }

  @RequirePerm('tariffs.manage') @Delete(':id')
  async remove(@Param('id') id: string) {
    return withTx(this.pool, async (c) => {
      const row = await this.find(id, c);
      const used = await c.query<{ n: string }>("SELECT count(*) AS n FROM invoices WHERE status <> 'CANCELLED' AND lines @> $1::jsonb", [JSON.stringify([{ code: row.code }])]);
      if (Number(used.rows[0].n) > 0) throw conflict(`${row.code} appears on ${used.rows[0].n} invoice(s) — retire it instead of deleting it`);
      await c.query('DELETE FROM tariffs WHERE id = $1', [row.id]);
      await this.audit.record(c, { action: 'DELETE', entity: 'TariffItem', entityId: row.id, entityLabel: row.code, before: toApi(row) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.readModel.deleted, { kind: 'tariff', id: row.id }, { subject: row.id }));
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.revenue.tariffChanged, { tariffId: row.id, code: row.code, deleted: true }, { subject: row.id }));
      return { deleted: true };
    });
  }

  private makeRevision(before: TariffRow, rate: number, effectiveFrom: string | undefined, circular: string | undefined, note: string | undefined, user?: Principal): Revision {
    const previousRate = round2(num(before.rate));
    const when = effectiveFrom && !Number.isNaN(new Date(effectiveFrom).getTime()) ? new Date(effectiveFrom) : new Date();
    return { id: newId(), effectiveFrom: when.toISOString(), rate: round2(rate), previousRate, changePct: previousRate ? Math.round(((rate - previousRate) / previousRate) * 1000) / 10 : 0, circular: circular ?? '', note: note ?? `Rate revised by ${user?.name ?? 'the tariff desk'}` };
  }
  private async find(ref: string, c: Queryable = this.pool): Promise<TariffRow> {
    const r = await c.query<TariffRow>('SELECT * FROM tariffs WHERE id::text = $1 OR code = $1', [ref]);
    if (!r.rows[0]) throw notFound('Tariff head not found');
    return r.rows[0];
  }
}
