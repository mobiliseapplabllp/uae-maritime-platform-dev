import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, LOOKUP_CATEGORIES, type PageQuery } from '@maritime/contracts';
import { KIT_ENV, KIT_POOL, KIT_SETTINGS, AuditClient, RequirePerm, ServiceOnly, zod, paged, parsePage, escapeLike, notFound, badRequest, withTx, enqueue, eventFromContext, SettingsClient } from '@maritime/service-kit';
import type { Env } from './env';

const schema = z.object({ category: z.string().min(1).max(60), code: z.string().min(1).max(60), label: z.string().min(1).max(200), labelAr: z.string().max(200).optional().nullable(), meta: z.record(z.unknown()).optional().default({}), active: z.boolean().optional().default(true) });
interface Row { id: string; category: string; code: string; label: string; label_ar: string | null; meta: Record<string, unknown>; active: boolean; created_at: Date; updated_at: Date }
const toApi = (r: Row) => ({ id: r.id, category: r.category, code: r.code, label: r.label, labelAr: r.label_ar, meta: r.meta, active: r.active, createdAt: r.created_at, updatedAt: r.updated_at });
const SORT: Record<string, string> = { code: 'code', label: 'label', category: 'category', createdAt: 'created_at', active: 'active' };

@Controller('lookups')
export class LookupsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, @Inject(KIT_SETTINGS) private readonly settings: SettingsClient, private readonly audit: AuditClient) {}

  @RequirePerm('masters.view') @Get('categories')
  async categories() {
    const counts = await this.pool.query<{ category: string; n: string }>('SELECT category, count(*) AS n FROM lookups GROUP BY category');
    const byCat = Object.fromEntries(counts.rows.map((r) => [r.category, Number(r.n)]));
    return LOOKUP_CATEGORIES.map((c) => ({ ...c, count: byCat[c.key] ?? 0 }));
  }
  @RequirePerm('masters.view') @Get()
  async list(@Query() query: PageQuery & { category?: string; active?: string }) {
    const p = parsePage(query, { defaultSort: 'code', sortable: Object.keys(SORT), maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    if (query.category) { args.push(query.category); where.push(`category = $${args.length}`); }
    if (query.active === 'true' || query.active === 'false') { args.push(query.active === 'true'); where.push(`active = $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(code ILIKE $${args.length} OR label ILIKE $${args.length} OR coalesce(label_ar, '') ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM lookups ${w}`, args);
    const rows = await this.pool.query<Row>(`SELECT * FROM lookups ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir}, id LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(toApi), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }
  @ServiceOnly() @Get('internal/:category')
  async internal(@Param('category') category: string) { const r = await this.pool.query<Row>('SELECT * FROM lookups WHERE category = $1 AND active ORDER BY code', [category]); return r.rows.map(toApi); }
  @RequirePerm('masters.view') @Get(':id')
  async get(@Param('id') id: string) { const r = await this.pool.query<Row>('SELECT * FROM lookups WHERE id = $1', [id]); if (!r.rows[0]) throw notFound('Lookup not found'); return toApi(r.rows[0]); }
  @RequirePerm('masters.manage') @Post()
  async create(@Body(zod(schema)) body: z.infer<typeof schema>) {
    return withTx(this.pool, async (c) => {
      const r = await c.query<Row>('INSERT INTO lookups(category, code, label, label_ar, meta, active) VALUES ($1, upper($2), $3, $4, $5, $6) RETURNING *', [body.category, body.code, body.label, body.labelAr ?? null, JSON.stringify(body.meta ?? {}), body.active]);
      await this.audit.record(c, { action: 'CREATE', entity: 'Lookup', entityId: r.rows[0].id, entityLabel: `${body.category}/${r.rows[0].code}`, after: toApi(r.rows[0]) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.mdm.lookupChanged, { category: body.category, code: r.rows[0].code, change: 'created' }));
      return toApi(r.rows[0]);
    });
  }
  @RequirePerm('masters.manage') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(schema.partial())) body: Partial<z.infer<typeof schema>>) {
    const before = await this.pool.query<Row>('SELECT * FROM lookups WHERE id = $1', [id]); if (!before.rows[0]) throw notFound('Lookup not found');
    const b = before.rows[0];
    return withTx(this.pool, async (c) => {
      const r = await c.query<Row>('UPDATE lookups SET label = $1, label_ar = $2, meta = $3, active = $4, code = upper($5), updated_at = now() WHERE id = $6 RETURNING *',
        [body.label ?? b.label, body.labelAr === undefined ? b.label_ar : body.labelAr, JSON.stringify(body.meta ?? b.meta), body.active ?? b.active, body.code ?? b.code, id]);
      await this.audit.record(c, { action: 'UPDATE', entity: 'Lookup', entityId: id, entityLabel: `${b.category}/${r.rows[0].code}`, before: toApi(b), after: toApi(r.rows[0]) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.mdm.lookupChanged, { category: b.category, code: r.rows[0].code, change: 'updated' }));
      return toApi(r.rows[0]);
    });
  }
  @RequirePerm('masters.manage') @Delete(':id')
  async remove(@Param('id') id: string) {
    const before = await this.pool.query<Row>('SELECT * FROM lookups WHERE id = $1', [id]); if (!before.rows[0]) throw notFound('Lookup not found');
    const masters = await this.settings.moduleGet<{ allowHardDelete: boolean }>('masters', { allowHardDelete: false });
    return withTx(this.pool, async (c) => {
      if (masters.allowHardDelete) await c.query('DELETE FROM lookups WHERE id = $1', [id]);
      else await c.query('UPDATE lookups SET active = false, updated_at = now() WHERE id = $1', [id]);
      await this.audit.record(c, { action: masters.allowHardDelete ? 'DELETE' : 'DEACTIVATE', entity: 'Lookup', entityId: id, entityLabel: `${before.rows[0].category}/${before.rows[0].code}`, before: toApi(before.rows[0]) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.mdm.lookupChanged, { category: before.rows[0].category, code: before.rows[0].code, change: masters.allowHardDelete ? 'deleted' : 'deactivated' }));
      return { deleted: true, softDelete: !masters.allowHardDelete };
    });
  }
}
export { badRequest };
