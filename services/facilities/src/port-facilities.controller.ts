import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, type PageQuery } from '@maritime/contracts';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, conflict, escapeLike, nextNumber, notFound, paged, parsePage, withTx, zod, type Principal } from '@maritime/service-kit';
import type { Env } from './env';
import {
  AUDIT_RESULTS, FACILITY_STATUS, FACILITY_TYPES, ISPS_STATUS, OBLIGATION_KINDS, auditApi, facilityApi, obligationApi,
  publishFacility, ratingFrom, type FacilityRow,
} from './directory';
import { auditsFor, fullFacility, loadFacility } from './read';
import { clearObligation, raiseObligation, recordAudit, renewalWorkList } from './compliance';

/* The port-facility register — berthing and terminal facilities as regulated subjects.
 *
 * The physical particulars of a berth belong to the harbour estate and are projected in from its
 * events; what the register owns is the regulatory overlay on the same identifier: who operates the
 * facility, where it stands under the ISPS Code and until when, what it is approved to handle, and the
 * inspections and audits carried out on it. ISPS standing moves through its own endpoint because a
 * Statement of Compliance is issued, expires and can be withdrawn — it is not a field to be typed over. */

const text = (max: number) => z.string().trim().max(max);
const body = z.object({
  id: text(80).optional(), code: text(30).optional(), name: text(160).min(2), nameAr: text(160).nullish(),
  facilityType: z.enum(FACILITY_TYPES).default('BERTH'), terminal: text(160).default(''), berthType: text(40).default(''),
  operatorId: text(80).nullish(), operatorName: text(160).default(''),
  capabilities: z.array(text(60)).max(30).default([]), loaMax: z.coerce.number().min(0).max(1000).nullish(), draftMax: z.coerce.number().min(0).max(100).nullish(),
  capacity: z.coerce.number().min(0).nullish(), capacityUnit: text(20).default(''),
  pssoName: text(120).default(''), pssoPhone: text(40).default(''),
  status: z.enum(FACILITY_STATUS).optional(), remarks: text(1000).default(''),
});
const patch = body.partial();
const ispsBody = z.object({
  ispsStatus: z.enum(ISPS_STATUS), ispsLevel: z.coerce.number().int().min(1).max(3).optional(),
  socNo: text(60).default(''), socExpiry: z.union([text(40), z.null()]).optional(), reason: text(600).default(''),
});
const auditBody = z.object({
  date: z.union([text(40), z.null()]).optional(), auditor: text(120).default(''), auditorId: text(80).nullish(),
  result: z.enum(AUDIT_RESULTS), scope: text(200).default(''), remarks: text(2000).default(''), instrumentId: text(80).nullish(), instrumentNo: text(60).default(''),
});
const obligationBody = z.object({ kind: z.enum(OBLIGATION_KINDS), title: text(200).min(3), detail: text(2000).default(''), sourceRef: text(80).default(''), dueAt: z.union([text(40), z.null()]).optional() });
const clearBody = z.object({ note: text(600).default('') });

const SORT: Record<string, string> = { code: 'code', name: 'name', facilityType: 'facility_type', terminal: 'terminal', operatorName: 'operator_name', ispsStatus: 'isps_status', status: 'status', createdAt: 'created_at', updatedAt: 'updated_at' };

@Controller('facilities/port-facilities')
export class PortFacilitiesController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  @RequirePerm('facilities.view') @Get()
  async list(@Query() query: PageQuery & { facilityType?: string; operator?: string; ispsStatus?: string; status?: string; terminal?: string }) {
    const p = parsePage(query, { defaultSort: 'code', sortable: Object.keys(SORT), maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    const add = (sql: (i: number) => string, value: unknown) => { args.push(value); where.push(sql(args.length)); };
    if (query.facilityType) add((i) => `facility_type = $${i}`, query.facilityType);
    if (query.operator) add((i) => `(operator_id = $${i} OR lower(operator_name) = lower($${i}))`, query.operator);
    if (query.ispsStatus) add((i) => `isps_status = $${i}`, query.ispsStatus);
    if (query.status) add((i) => `status = $${i}`, query.status);
    if (query.terminal) add((i) => `lower(terminal) = lower($${i})`, query.terminal);
    if (p.q) add((i) => `(name ILIKE $${i} OR code ILIKE $${i} OR terminal ILIKE $${i} OR operator_name ILIKE $${i} OR soc_no ILIKE $${i})`, `%${escapeLike(p.q)}%`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM port_facilities ${w}`, args);
    const rows = await this.pool.query<FacilityRow>(`SELECT * FROM port_facilities ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, code LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map((r) => facilityApi(r)), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  @RequirePerm('facilities.view') @Get(':id')
  async get(@Param('id') id: string) { return fullFacility(this.pool, await loadFacility(this.pool, id)); }

  @RequirePerm('facilities.view') @Get(':id/audits')
  async audits(@Param('id') id: string) {
    const f = await loadFacility(this.pool, id);
    const history = await auditsFor(this.pool, 'FACILITY', f.id);
    return { subjectId: f.id, subjectName: f.name, computed: ratingFrom(history), audits: history };
  }

  @RequirePerm('facilities.view') @Get(':id/renewals')
  async renewals(@Param('id') id: string, @Query('window') window?: string) {
    const f = await loadFacility(this.pool, id);
    return renewalWorkList(this.pool, Number(window) || this.env.RENEWAL_WINDOW_DAYS, { subjectId: f.id });
  }

  @RequirePerm('facilities.manage') @Post()
  async create(@Body(zod(body)) b: z.infer<typeof body>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const code = b.code?.trim() || await nextNumber(c, `${this.env.FACILITY_PREFIX}-code`, `${this.env.FACILITY_PREFIX}-`, 4);
      const dupe = await c.query('SELECT id FROM port_facilities WHERE upper(code) = upper($1)', [code]);
      if (dupe.rowCount) throw conflict(`A facility with code ${code.toUpperCase()} is already on the register`);
      const operator = await this.operatorOf(c, b.operatorId ?? null, b.operatorName);
      const r = await c.query<FacilityRow>(
        `INSERT INTO port_facilities(id, code, name, name_ar, facility_type, terminal, berth_type, operator_id, operator_name, capabilities,
           loa_max, draft_max, capacity_value, capacity_unit, psso_name, psso_phone, status, remarks)
         VALUES (COALESCE(NULLIF($1,''), gen_random_uuid()::text), upper($2),$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [b.id ?? '', code, b.name, b.nameAr ?? null, b.facilityType, b.terminal, b.berthType, operator.id, operator.name, JSON.stringify(b.capabilities),
          b.loaMax ?? null, b.draftMax ?? null, b.capacity ?? null, b.capacityUnit, b.pssoName, b.pssoPhone, b.status ?? 'OPERATIONAL', b.remarks]);
      const row = r.rows[0];
      await this.audit.record(c, { action: 'CREATE', entity: 'PortFacility', entityId: row.id, entityLabel: row.name, after: facilityApi(row) });
      return publishFacility(c, this.env, row, {}, EVENTS.facilities.facilityRegistered);
    });
  }

  @RequirePerm('facilities.manage') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(patch)) b: Partial<z.infer<typeof body>>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await loadFacility(c, id, true);
      if (b.code && b.code.toUpperCase() !== before.code.toUpperCase()) {
        const dupe = await c.query('SELECT id FROM port_facilities WHERE upper(code) = upper($1) AND id <> $2', [b.code, before.id]);
        if (dupe.rowCount) throw conflict(`A facility with code ${b.code.toUpperCase()} is already on the register`);
      }
      const operator = b.operatorId === undefined && b.operatorName === undefined
        ? { id: before.operator_id, name: before.operator_name }
        : await this.operatorOf(c, b.operatorId === undefined ? before.operator_id : b.operatorId, b.operatorName ?? '');
      const keep = <T,>(v: T | undefined, cur: T) => (v === undefined ? cur : v);
      const r = await c.query<FacilityRow>(
        `UPDATE port_facilities SET code=upper($2), name=$3, name_ar=$4, facility_type=$5, terminal=$6, berth_type=$7, operator_id=$8, operator_name=$9,
           capabilities=$10, loa_max=$11, draft_max=$12, capacity_value=$13, capacity_unit=$14, psso_name=$15, psso_phone=$16, status=$17, remarks=$18, updated_at=now()
         WHERE id=$1 RETURNING *`,
        [before.id, keep(b.code, before.code), keep(b.name, before.name), b.nameAr === undefined ? before.name_ar : b.nameAr, keep(b.facilityType, before.facility_type),
          keep(b.terminal, before.terminal), keep(b.berthType, before.berth_type), operator.id, operator.name, JSON.stringify(b.capabilities ?? before.capabilities ?? []),
          b.loaMax === undefined ? before.loa_max : b.loaMax, b.draftMax === undefined ? before.draft_max : b.draftMax,
          b.capacity === undefined ? before.capacity_value : b.capacity, keep(b.capacityUnit, before.capacity_unit),
          keep(b.pssoName, before.psso_name), keep(b.pssoPhone, before.psso_phone), keep(b.status, before.status), keep(b.remarks, before.remarks)]);
      const row = r.rows[0];
      await this.audit.record(c, { action: 'UPDATE', entity: 'PortFacility', entityId: row.id, entityLabel: row.name, before: facilityApi(before), after: facilityApi(row) });
      return publishFacility(c, this.env, row, {}, EVENTS.facilities.facilityUpdated);
    });
  }

  /** Where the facility stands under the ISPS Code, and until when. */
  @RequirePerm('facilities.manage') @Post(':id/isps')
  async isps(@Param('id') id: string, @Body(zod(ispsBody)) b: z.infer<typeof ispsBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await loadFacility(c, id, true);
      if (before.isps_status === b.ispsStatus && !b.socNo && b.ispsLevel === undefined) throw conflict(`${before.name} is already recorded as ${b.ispsStatus.toLowerCase().replace(/_/g, ' ')}`);
      const r = await c.query<FacilityRow>(
        'UPDATE port_facilities SET isps_status=$2, isps_level=$3, soc_no=$4, soc_expiry=$5, updated_at=now() WHERE id=$1 RETURNING *',
        [before.id, b.ispsStatus, b.ispsLevel ?? before.isps_level, b.socNo || before.soc_no, b.socExpiry === undefined ? before.soc_expiry : (b.socExpiry ? new Date(b.socExpiry) : null)]);
      const row = r.rows[0];
      await this.audit.record(c, {
        action: 'ISPS', entity: 'PortFacility', entityId: row.id, entityLabel: row.name,
        before: { ispsStatus: before.isps_status, ispsLevel: before.isps_level, socNo: before.soc_no },
        after: { ispsStatus: row.isps_status, ispsLevel: row.isps_level, socNo: row.soc_no }, note: b.reason,
      });
      return publishFacility(c, this.env, row, {}, EVENTS.facilities.facilityIspsChanged, { from: before.isps_status, to: row.isps_status, level: row.isps_level, socNo: row.soc_no, reason: b.reason });
    });
  }

  @RequirePerm('facilities.manage') @Post(':id/audits')
  async audit_(@Param('id') id: string, @Body(zod(auditBody)) b: z.infer<typeof auditBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const facility = await loadFacility(c, id, true);
      const done = await recordAudit(c, this.env, this.audit, { kind: 'FACILITY', id: facility.id, name: facility.name }, b, user);
      await publishFacility(c, this.env, facility, {}, EVENTS.facilities.facilityAudited, { auditNo: done.row.number, result: done.row.result, auditor: done.row.auditor, rating: done.rating });
      return { audit: auditApi(done.row), rating: done.rating, obligation: done.obligation ? obligationApi(done.obligation) : null, facility: await fullFacility(c, facility) };
    });
  }

  @RequirePerm('facilities.manage') @Post(':id/obligations')
  async raise(@Param('id') id: string, @Body(zod(obligationBody)) b: z.infer<typeof obligationBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const facility = await loadFacility(c, id, true);
      return obligationApi(await raiseObligation(c, this.env, this.audit, { kind: 'FACILITY', id: facility.id, name: facility.name }, b, user));
    });
  }

  @RequirePerm('facilities.manage') @Post(':id/obligations/:obligationId/clear')
  async clear(@Param('id') id: string, @Param('obligationId') obligationId: string, @Body(zod(clearBody)) b: z.infer<typeof clearBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const facility = await loadFacility(c, id);
      return obligationApi(await clearObligation(c, this.env, this.audit, 'FACILITY', facility.id, obligationId, b.note, user));
    });
  }

  /** A facility that has been audited or has held an instrument is closed, not deleted. */
  @RequirePerm('facilities.manage') @Delete(':id')
  async remove(@Param('id') id: string) {
    return withTx(this.pool, async (c) => {
      const before = await loadFacility(c, id, true);
      const used = await c.query<{ n: string }>(
        `SELECT (SELECT count(*) FROM instruments WHERE subject_id = $1)
              + (SELECT count(*) FROM audits WHERE subject_kind = 'FACILITY' AND subject_id = $1) AS n`, [before.id]);
      if (Number(used.rows[0].n) > 0) {
        if (before.status === 'CLOSED') throw conflict(`${before.name} is already closed`);
        const r = await c.query<FacilityRow>("UPDATE port_facilities SET status='CLOSED', updated_at=now() WHERE id=$1 RETURNING *", [before.id]);
        await this.audit.record(c, { action: 'CLOSE', entity: 'PortFacility', entityId: before.id, entityLabel: before.name, before: facilityApi(before), after: facilityApi(r.rows[0]) });
        await publishFacility(c, this.env, r.rows[0], {}, EVENTS.facilities.facilityUpdated, { closed: true });
        return { deleted: true, softDelete: true, id: before.id, status: 'CLOSED' };
      }
      await this.audit.record(c, { action: 'DELETE', entity: 'PortFacility', entityId: before.id, entityLabel: before.name, before: facilityApi(before) });
      await c.query('DELETE FROM port_facilities WHERE id = $1', [before.id]);
      await publishFacility(c, this.env, before, {}, EVENTS.facilities.facilityDeleted);
      return { deleted: true, softDelete: false, id: before.id };
    });
  }

  /** A facility is operated by a company on the directory, or by a named operator not on it. */
  private async operatorOf(c: import('pg').PoolClient, operatorId: string | null, operatorName: string) {
    if (!operatorId) return { id: null, name: operatorName };
    const r = await c.query<{ id: string; name: string }>('SELECT id, name FROM companies WHERE id = $1 OR upper(code) = upper($1)', [operatorId]);
    if (!r.rows[0]) throw notFound('The operating company is not on the directory');
    return { id: r.rows[0].id, name: operatorName || r.rows[0].name };
  }
}
