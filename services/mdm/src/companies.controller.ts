import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, type PageQuery } from '@maritime/contracts';
import { KIT_ENV, KIT_POOL, AuditClient, CurrentUser, RequirePerm, ServiceOnly, isNational, keysOf, zod, paged, parsePage, escapeLike, notFound, withTx, enqueue, eventFromContext, type Principal } from '@maritime/service-kit';
import type { Env } from './env';

const CATEGORIES = ['AGENCY', 'TERMINAL_OPERATOR', 'SERVICE_PROVIDER', 'SUPPLIER', 'INSTITUTE'] as const;
const STATUSES = ['ACTIVE', 'SUSPENDED', 'BLACKLISTED', 'INACTIVE'] as const;
const schema = z.object({ code: z.string().min(2).max(20), name: z.string().min(2).max(160), nameAr: z.string().max(160).optional().nullable(), category: z.enum(CATEGORIES), types: z.array(z.string()).optional().default([]),
  contactName: z.string().max(120).optional().default(''), contactEmail: z.string().max(200).optional().default(''), contactPhone: z.string().max(40).optional().default(''), taxId: z.string().max(60).optional().default(''), registrationNo: z.string().max(60).optional().default(''),
  address: z.string().max(300).optional().default(''), status: z.enum(STATUSES).optional().default('ACTIVE'), onboardedAt: z.string().optional().nullable(), rating: z.number().min(0).max(5).optional().default(0) });
interface Row { id: string; code: string; name: string; name_ar: string | null; category: string; types: string[]; contact_name: string; contact_email: string; contact_phone: string; tax_id: string; registration_no: string; address: string; status: string; onboarded_at: string | null; rating: string; real: boolean; record_status: string; created_at: Date; updated_at: Date }
const toApi = (r: Row) => ({ id: r.id, code: r.code, name: r.name, nameAr: r.name_ar, category: r.category, types: r.types, contactName: r.contact_name, contactEmail: r.contact_email, contactPhone: r.contact_phone, taxId: r.tax_id, registrationNo: r.registration_no, address: r.address, status: r.status, onboardedAt: r.onboarded_at, rating: Number(r.rating), real: r.real, recordStatus: r.record_status, createdAt: r.created_at, updatedAt: r.updated_at });

/*
 * The directory and the file are two different things.
 *
 * A port community works because its members can look each other up: an agent nominating a chandler, a
 * terminal checking who represents an inbound ship. So the golden company record is readable across the
 * community — but only the part that is a directory entry. The rest of it is the administration's file on
 * that company: its tax registration, its licence number, and the performance rating the desk assigns it.
 * Handing a company its competitors' tax registration numbers is not a directory, it is a disclosure.
 *
 * A company reads its own record whole. Everyone else's arrives as the directory entry.
 */
type CompanyApi = ReturnType<typeof toApi>;
const WITHHELD = ['taxId', 'registrationNo', 'rating', 'real', 'recordStatus'] as const;
const directoryApi = (r: Row): Omit<CompanyApi, typeof WITHHELD[number]> => {
  const full = toApi(r);
  for (const k of WITHHELD) delete (full as Partial<CompanyApi>)[k];
  return full;
};
/** The view of one company this reader is entitled to. */
const forReader = (user: Principal, r: Row) =>
  (isNational(user.scope) || keysOf(user.scope).includes(r.code) ? toApi(r) : directoryApi(r));
const SORT: Record<string, string> = { name: 'name', code: 'code', category: 'category', status: 'status', rating: 'rating', createdAt: 'created_at', onboardedAt: 'onboarded_at' };

@Controller('companies')
export class CompaniesController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}
  @RequirePerm('facilities.view') @Get()
  async list(@Query() query: PageQuery & { category?: string; status?: string }, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: 'name', sortable: Object.keys(SORT) });
    const where: string[] = []; const args: unknown[] = [];
    if (query.category) { args.push(query.category); where.push(`category = $${args.length}`); }
    if (query.status) { args.push(query.status); where.push(`status = $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(name ILIKE $${args.length} OR code ILIKE $${args.length} OR coalesce(name_ar,'') ILIKE $${args.length} OR contact_name ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM companies ${w}`, args);
    const rows = await this.pool.query<Row>(`SELECT * FROM companies ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, id LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map((r) => forReader(user, r)), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }
  @ServiceOnly() @Get('internal/all')
  async internalAll() { const r = await this.pool.query<Row>('SELECT * FROM companies ORDER BY name'); return r.rows.map(toApi); }
  @RequirePerm('facilities.view') @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: Principal) {
    // `id` is a uuid and `code` is text, so one parameter cannot be compared to both: Postgres refused the
    // whole statement with "operator does not exist: text = uuid" and this route answered 500 to every
    // caller, for either kind of reference. Casting the uuid to text settles the type for both arms.
    const r = await this.pool.query<Row>('SELECT * FROM companies WHERE id::text = $1 OR upper(code) = upper($1)', [id]);
    if (!r.rows[0]) throw notFound('Company not found');
    return forReader(user, r.rows[0]);
  }
  @RequirePerm('facilities.manage') @Post()
  async create(@Body(zod(schema)) b: z.infer<typeof schema>) {
    return withTx(this.pool, async (c) => {
      const r = await c.query<Row>('INSERT INTO companies(code, name, name_ar, category, types, contact_name, contact_email, contact_phone, tax_id, registration_no, address, status, onboarded_at, rating) VALUES (upper($1), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING *',
        [b.code, b.name, b.nameAr ?? null, b.category, b.types, b.contactName, b.contactEmail, b.contactPhone, b.taxId, b.registrationNo, b.address, b.status, b.onboardedAt ?? null, b.rating]);
      await this.audit.record(c, { action: 'CREATE', entity: 'Company', entityId: r.rows[0].id, entityLabel: r.rows[0].name, after: toApi(r.rows[0]) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.mdm.companyUpserted, { companyId: r.rows[0].id, code: r.rows[0].code, name: r.rows[0].name, status: r.rows[0].status }));
      return toApi(r.rows[0]);
    });
  }
  @RequirePerm('facilities.manage') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(schema.partial())) b: Partial<z.infer<typeof schema>>) {
    const before = await this.pool.query<Row>('SELECT * FROM companies WHERE id = $1', [id]); if (!before.rows[0]) throw notFound('Company not found');
    const o = before.rows[0];
    return withTx(this.pool, async (c) => {
      const r = await c.query<Row>('UPDATE companies SET name=$1, name_ar=$2, category=$3, types=$4, contact_name=$5, contact_email=$6, contact_phone=$7, tax_id=$8, registration_no=$9, address=$10, status=$11, onboarded_at=$12, rating=$13, updated_at=now() WHERE id=$14 RETURNING *',
        [b.name ?? o.name, b.nameAr === undefined ? o.name_ar : b.nameAr, b.category ?? o.category, b.types ?? o.types, b.contactName ?? o.contact_name, b.contactEmail ?? o.contact_email, b.contactPhone ?? o.contact_phone, b.taxId ?? o.tax_id, b.registrationNo ?? o.registration_no, b.address ?? o.address, b.status ?? o.status, b.onboardedAt === undefined ? o.onboarded_at : b.onboardedAt, b.rating ?? Number(o.rating), id]);
      await this.audit.record(c, { action: 'UPDATE', entity: 'Company', entityId: id, entityLabel: r.rows[0].name, before: toApi(o), after: toApi(r.rows[0]) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.mdm.companyUpserted, { companyId: id, code: r.rows[0].code, name: r.rows[0].name, status: r.rows[0].status }));
      return toApi(r.rows[0]);
    });
  }
  @RequirePerm('facilities.manage') @Delete(':id')
  async remove(@Param('id') id: string) {
    const before = await this.pool.query<Row>('SELECT * FROM companies WHERE id = $1', [id]); if (!before.rows[0]) throw notFound('Company not found');
    await withTx(this.pool, async (c) => {
      await c.query("UPDATE companies SET status = 'INACTIVE', record_status = 'SUPERSEDED', updated_at = now() WHERE id = $1", [id]);
      await this.audit.record(c, { action: 'DELETE', entity: 'Company', entityId: id, entityLabel: before.rows[0].name, before: toApi(before.rows[0]) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.mdm.companyUpserted, { companyId: id, code: before.rows[0].code, name: before.rows[0].name, status: 'INACTIVE' }));
    });
    return { deleted: true, softDelete: true };
  }
}
