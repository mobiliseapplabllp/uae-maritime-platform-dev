import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, type PageQuery } from '@maritime/contracts';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, badRequest, conflict, escapeLike, paged, parsePage, withTx, zod, type Principal } from '@maritime/service-kit';
import type { Env } from './env';
import {
  AUDIT_RESULTS, COMPANY_CATEGORIES, COMPANY_STATUS, OBLIGATION_KINDS, auditApi, canChangeStatus, companyApi, obligationApi, ratingFrom,
  publishCompany, publishCompanyDeleted, type CompanyRow,
} from './directory';
import { auditsFor, fullCompany, instrumentsFor, loadCompany, obligationsFor } from './read';
import { clearObligation, raiseObligation, recordAudit, renewalWorkList } from './compliance';

/* The regulated-company directory.
 *
 * Master data holds the golden record; this is the administration's view of the same company: what
 * standing it is in, why, what it holds, how it has audited and what it still owes. Standing is never
 * an ordinary edit — it moves through its own endpoint and every step away from good standing carries
 * a reason, because suspending or blacklisting an operator is a decision, not a field change. */

const text = (max: number) => z.string().trim().max(max);
const body = z.object({
  id: text(80).optional(), code: text(20).min(2), name: text(160).min(2), nameAr: text(160).nullish(),
  category: z.enum(COMPANY_CATEGORIES), types: z.array(text(60)).max(20).default([]),
  contactName: text(120).default(''), contactEmail: text(200).default(''), contactPhone: text(40).default(''),
  taxId: text(60).default(''), registrationNo: text(60).default(''), address: text(300).default(''), city: text(120).default(''),
  status: z.enum(COMPANY_STATUS).optional(), rating: z.coerce.number().min(0).max(5).optional(),
  onboardedAt: z.union([text(40), z.null()]).optional(), remarks: text(1000).default(''),
});
const patch = body.partial();
const statusBody = z.object({ status: z.enum(COMPANY_STATUS), reason: text(600).default('') });
const auditBody = z.object({
  date: z.union([text(40), z.null()]).optional(), auditor: text(120).default(''), auditorId: text(80).nullish(),
  result: z.enum(AUDIT_RESULTS), scope: text(200).default(''), remarks: text(2000).default(''), instrumentId: text(80).nullish(), instrumentNo: text(60).default(''),
});
const obligationBody = z.object({ kind: z.enum(OBLIGATION_KINDS), title: text(200).min(3), detail: text(2000).default(''), sourceRef: text(80).default(''), dueAt: z.union([text(40), z.null()]).optional() });
const clearBody = z.object({ note: text(600).default('') });

const SORT: Record<string, string> = { code: 'code', name: 'name', category: 'category', status: 'status', rating: 'rating', onboardedAt: 'onboarded_at', createdAt: 'created_at', updatedAt: 'updated_at' };

@Controller('facilities/companies')
export class CompaniesController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  @RequirePerm('facilities.view') @Get()
  async list(@Query() query: PageQuery & { category?: string; type?: string; status?: string; rating?: string; city?: string }) {
    const p = parsePage(query, { defaultSort: 'name', sortable: Object.keys(SORT), maxLimit: 1000 });
    const where: string[] = []; const args: unknown[] = [];
    const add = (sql: (i: number) => string, value: unknown) => { args.push(value); where.push(sql(args.length)); };
    if (query.category) add((i) => `category = $${i}`, query.category);
    if (query.status) add((i) => `status = $${i}`, query.status);
    if (query.type) add((i) => `types ? $${i}`, query.type);
    if (query.city) add((i) => `lower(city) = lower($${i})`, query.city);
    if (query.rating) add((i) => `rating >= $${i}`, Number(query.rating));
    if (p.q) add((i) => `(name ILIKE $${i} OR code ILIKE $${i} OR coalesce(name_ar,'') ILIKE $${i} OR contact_name ILIKE $${i} OR tax_id ILIKE $${i} OR registration_no ILIKE $${i})`, `%${escapeLike(p.q)}%`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM companies ${w}`, args);
    const rows = await this.pool.query<CompanyRow>(`SELECT * FROM companies ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, code LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map((r) => companyApi(r)), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  @RequirePerm('facilities.view') @Get(':id')
  async get(@Param('id') id: string) { return fullCompany(this.pool, await loadCompany(this.pool, id)); }

  /** What this company holds, from the local snapshot of the instrument register. */
  @RequirePerm('facilities.view') @Get(':id/instruments')
  async instruments(@Param('id') id: string) {
    const c = await loadCompany(this.pool, id);
    return instrumentsFor(this.pool, [c.id]);
  }

  @RequirePerm('facilities.view') @Get(':id/audits')
  async audits(@Param('id') id: string) {
    const c = await loadCompany(this.pool, id);
    const history = await auditsFor(this.pool, 'COMPANY', c.id);
    return { subjectId: c.id, subjectName: c.name, rating: Number(c.rating), computed: ratingFrom(history), audits: history };
  }

  @RequirePerm('facilities.view') @Get(':id/obligations')
  async obligations(@Param('id') id: string) {
    const c = await loadCompany(this.pool, id);
    const list = await obligationsFor(this.pool, 'COMPANY', c.id);
    return { subjectId: c.id, subjectName: c.name, open: list.filter((o) => o.status === 'OPEN').length, overdue: list.filter((o) => o.overdue).length, obligations: list };
  }

  /** The renewals this company owes, from the expiry dates on its snapshot. */
  @RequirePerm('facilities.view') @Get(':id/renewals')
  async renewals(@Param('id') id: string, @Query('window') window?: string) {
    const c = await loadCompany(this.pool, id);
    return renewalWorkList(this.pool, Number(window) || this.env.RENEWAL_WINDOW_DAYS, { subjectId: c.id });
  }

  @RequirePerm('facilities.manage') @Post()
  async create(@Body(zod(body)) b: z.infer<typeof body>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const dupe = await c.query('SELECT id FROM companies WHERE upper(code) = upper($1)', [b.code]);
      if (dupe.rowCount) throw conflict(`A company with code ${b.code.toUpperCase()} is already on the directory`);
      if (b.id) { const clash = await c.query('SELECT id FROM companies WHERE id = $1', [b.id]); if (clash.rowCount) throw conflict('That company is already on the directory'); }
      const r = await c.query<CompanyRow>(
        `INSERT INTO companies(id, code, name, name_ar, category, types, contact_name, contact_email, contact_phone, tax_id, registration_no, address, city, status, rating, onboarded_at, remarks)
         VALUES (COALESCE(NULLIF($1,''), gen_random_uuid()::text), upper($2),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
        [b.id ?? '', b.code, b.name, b.nameAr ?? null, b.category, JSON.stringify(b.types), b.contactName, b.contactEmail, b.contactPhone,
          b.taxId, b.registrationNo, b.address, b.city, b.status ?? 'ACTIVE', b.rating ?? 0, b.onboardedAt || null, b.remarks]);
      const row = r.rows[0];
      await c.query('INSERT INTO company_status_history(company_id, from_status, to_status, reason, by_id, by) VALUES ($1,$2,$3,$4,$5,$6)',
        [row.id, '', row.status, 'Recorded on the directory', user?.id ?? null, user?.name ?? '']);
      await this.audit.record(c, { action: 'CREATE', entity: 'Company', entityId: row.id, entityLabel: row.name, after: companyApi(row) });
      return publishCompany(c, this.env, row, {}, { event: EVENTS.facilities.companyRegistered });
    });
  }

  @RequirePerm('facilities.manage') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(patch)) b: Partial<z.infer<typeof body>>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await loadCompany(c, id, true);
      if (b.status && b.status !== before.status) throw conflict('A company\'s standing is changed through its status endpoint, with the reason it was changed for');
      if (b.code && b.code.toUpperCase() !== before.code.toUpperCase()) {
        const dupe = await c.query('SELECT id FROM companies WHERE upper(code) = upper($1) AND id <> $2', [b.code, before.id]);
        if (dupe.rowCount) throw conflict(`A company with code ${b.code.toUpperCase()} is already on the directory`);
      }
      const keep = <T,>(v: T | undefined, cur: T) => (v === undefined ? cur : v);
      const r = await c.query<CompanyRow>(
        `UPDATE companies SET code=upper($2), name=$3, name_ar=$4, category=$5, types=$6, contact_name=$7, contact_email=$8, contact_phone=$9,
           tax_id=$10, registration_no=$11, address=$12, city=$13, rating=$14, onboarded_at=$15, remarks=$16, updated_at=now() WHERE id=$1 RETURNING *`,
        [before.id, keep(b.code, before.code), keep(b.name, before.name), b.nameAr === undefined ? before.name_ar : b.nameAr, keep(b.category, before.category),
          JSON.stringify(b.types ?? before.types ?? []), keep(b.contactName, before.contact_name), keep(b.contactEmail, before.contact_email), keep(b.contactPhone, before.contact_phone),
          keep(b.taxId, before.tax_id), keep(b.registrationNo, before.registration_no), keep(b.address, before.address), keep(b.city, before.city),
          b.rating === undefined ? Number(before.rating) : b.rating, b.onboardedAt === undefined ? before.onboarded_at : (b.onboardedAt || null), keep(b.remarks, before.remarks)]);
      const row = r.rows[0];
      await this.audit.record(c, { action: 'UPDATE', entity: 'Company', entityId: row.id, entityLabel: row.name, before: companyApi(before), after: companyApi(row) });
      return publishCompany(c, this.env, row, {}, { event: EVENTS.facilities.companyUpdated });
    });
  }

  /* Suspension, blacklisting, restoration and retirement. Every step away from good standing carries a
   * reason, the whole line of them is kept, and a suspension or blacklisting is announced so the desks
   * that let a company work inside port limits hear about it. */
  @RequirePerm('facilities.approve') @Post(':id/status')
  async changeStatus(@Param('id') id: string, @Body(zod(statusBody)) b: z.infer<typeof statusBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await loadCompany(c, id, true);
      const verdict = canChangeStatus(before.status, b.status, b.reason);
      if (!verdict.ok) throw verdict.error.includes('reason') ? badRequest(verdict.error) : conflict(verdict.error);
      const r = await c.query<CompanyRow>(
        'UPDATE companies SET status=$2, status_reason=$3, status_changed_at=now(), status_changed_by_id=$4, status_changed_by=$5, updated_at=now() WHERE id=$1 RETURNING *',
        [before.id, b.status, b.reason, user?.id ?? null, user?.name ?? '']);
      const row = r.rows[0];
      await c.query('INSERT INTO company_status_history(company_id, from_status, to_status, reason, by_id, by) VALUES ($1,$2,$3,$4,$5,$6)',
        [row.id, before.status, row.status, b.reason, user?.id ?? null, user?.name ?? '']);
      await this.audit.record(c, {
        action: b.status === 'SUSPENDED' ? 'SUSPEND' : b.status === 'BLACKLISTED' ? 'BLACKLIST' : b.status === 'ACTIVE' ? 'REINSTATE' : 'DEACTIVATE',
        entity: 'Company', entityId: row.id, entityLabel: row.name, before: { status: before.status }, after: { status: row.status, reason: b.reason }, note: b.reason,
      });
      const extra = { from: before.status, to: row.status, reason: b.reason, by: row.status_changed_by };
      const entity = await publishCompany(c, this.env, row, {}, { event: EVENTS.facilities.companyStatusChanged, data: extra });
      if (b.status === 'SUSPENDED') await publishCompany(c, this.env, row, {}, { event: EVENTS.facilities.companySuspended, data: extra });
      if (b.status === 'BLACKLISTED') await publishCompany(c, this.env, row, {}, { event: EVENTS.facilities.companyBlacklisted, data: extra });
      return entity;
    });
  }

  /* Recording an audit moves the rating: it is the recency-weighted mean of the audit history, so a
   * non-conformity found this month weighs on the register far more than one found four years ago —
   * and the non-conformity itself becomes an obligation the company has to clear. */
  @RequirePerm('facilities.manage') @Post(':id/audits')
  async audit_(@Param('id') id: string, @Body(zod(auditBody)) b: z.infer<typeof auditBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await loadCompany(c, id, true);
      const done = await recordAudit(c, this.env, this.audit, { kind: 'COMPANY', id: before.id, name: before.name }, b, user);
      const after = await loadCompany(c, before.id);
      await publishCompany(c, this.env, after, {}, {
        event: EVENTS.facilities.companyAudited,
        data: { auditNo: done.row.number, result: done.row.result, auditor: done.row.auditor, rating: done.rating, previousRating: Number(before.rating), audits: done.audits },
      });
      return { audit: auditApi(done.row), rating: Number(after.rating), previousRating: Number(before.rating), obligation: done.obligation ? obligationApi(done.obligation) : null, company: await fullCompany(c, after) };
    });
  }

  @RequirePerm('facilities.manage') @Post(':id/obligations')
  async raise(@Param('id') id: string, @Body(zod(obligationBody)) b: z.infer<typeof obligationBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const company = await loadCompany(c, id, true);
      const row = await raiseObligation(c, this.env, this.audit, { kind: 'COMPANY', id: company.id, name: company.name }, b, user);
      return obligationApi(row);
    });
  }

  @RequirePerm('facilities.manage') @Post(':id/obligations/:obligationId/clear')
  async clear(@Param('id') id: string, @Param('obligationId') obligationId: string, @Body(zod(clearBody)) b: z.infer<typeof clearBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const company = await loadCompany(c, id);
      return obligationApi(await clearObligation(c, this.env, this.audit, 'COMPANY', company.id, obligationId, b.note, user));
    });
  }

  /* A company that has held an instrument, been audited or owed anything is never struck off: it is
   * retired to inactive, because that history is part of the record. A row created in error and never
   * used has no history to protect, so it goes. */
  @RequirePerm('facilities.manage') @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await loadCompany(c, id, true);
      const used = await c.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM instruments WHERE subject_id = $1)
              + (SELECT count(*) FROM audits WHERE subject_kind = 'COMPANY' AND subject_id = $1)
              + (SELECT count(*) FROM obligations WHERE subject_kind = 'COMPANY' AND subject_id = $1)
              + (SELECT count(*) FROM port_facilities WHERE operator_id = $1) AS n`, [before.id]);
      if (Number(used.rows[0].n) === 0) {
        await this.audit.record(c, { action: 'DELETE', entity: 'Company', entityId: before.id, entityLabel: before.name, before: companyApi(before) });
        await c.query('DELETE FROM companies WHERE id = $1', [before.id]);
        await publishCompanyDeleted(c, this.env, before);
        return { deleted: true, softDelete: false, id: before.id };
      }
      if (before.status === 'INACTIVE') throw conflict(`${before.name} is already inactive`);
      const r = await c.query<CompanyRow>(
        `UPDATE companies SET status='INACTIVE', status_reason=$2, status_changed_at=now(), status_changed_by_id=$3, status_changed_by=$4, updated_at=now() WHERE id=$1 RETURNING *`,
        [before.id, 'Retired from the directory', user?.id ?? null, user?.name ?? '']);
      const row = r.rows[0];
      await c.query('INSERT INTO company_status_history(company_id, from_status, to_status, reason, by_id, by) VALUES ($1,$2,$3,$4,$5,$6)',
        [row.id, before.status, 'INACTIVE', 'Retired from the directory', user?.id ?? null, user?.name ?? '']);
      await this.audit.record(c, { action: 'DELETE', entity: 'Company', entityId: row.id, entityLabel: row.name, before: companyApi(before), after: companyApi(row) });
      await publishCompany(c, this.env, row, {}, { event: EVENTS.facilities.companyStatusChanged, data: { from: before.status, to: 'INACTIVE', reason: 'Retired from the directory' } });
      return { deleted: true, softDelete: true, id: row.id, status: row.status };
    });
  }
}
