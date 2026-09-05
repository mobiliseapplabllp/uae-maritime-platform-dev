import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, type PageQuery } from '@maritime/contracts';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, assertLookup, assertLookups, conflict, escapeLike, nextNumber, notFound, paged, parsePage, withTx, zod, type Principal, scopeWhere, IntegrationClient, badGateway } from '@maritime/service-kit';
import { FACILITY_SCOPE } from './scope';
import type { Env } from './env';
import {
  AUDIT_RESULTS, FACILITY_STATUS, ISPS_STATUS, applyIcpOutcome, auditApi, cycleApi, facilityApi, obligationApi, visitApi,
  publishFacility, ratingFrom, type FacilityRow, type IcpReview,
} from './directory';
import { auditsFor, fullFacility, loadFacility } from './read';
import { clearObligation, raiseObligation, recordAudit, renewalWorkList } from './compliance';
import { completeVisit, scheduleVisit, visitsFor } from './visits';
import { ratingFor } from './rating';
import { completeSchema } from './accreditation.controller';

/* The port-facility register — berthing and terminal facilities as regulated subjects.
 *
 * The physical particulars of a berth belong to the harbour estate and are projected in from its
 * events; what the register owns is the regulatory overlay on the same identifier: who operates the
 * facility, where it stands under the ISPS Code and until when, what it is approved to handle, and the
 * inspections and audits carried out on it. ISPS standing moves through its own endpoint because a
 * Statement of Compliance is issued, expires and can be withdrawn — it is not a field to be typed over. */

const text = (max: number) => z.string().trim().max(max);
const icpBody = z.object({ reason: text(500).min(3) });
const body = z.object({
  id: text(80).optional(), code: text(30).optional(), name: text(160).min(2), nameAr: text(160).nullish(),
  facilityType: text(40).default('BERTH'), terminal: text(160).default(''), berthType: text(40).default(''),
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
const obligationBody = z.object({ kind: text(40).min(1), title: text(200).min(3), detail: text(2000).default(''), sourceRef: text(80).default(''), dueAt: z.union([text(40), z.null()]).optional() });
const clearBody = z.object({ note: text(600).default('') });
const visitBody = z.object({ visitType: text(40).min(1), scheduledOn: z.union([text(40), z.null()]).optional(), inspector: text(120).optional(), inspectorId: text(80).nullish(), remarks: text(2000).default(''), complete: completeSchema.optional() });

const SORT: Record<string, string> = { code: 'code', name: 'name', facilityType: 'facility_type', terminal: 'terminal', operatorName: 'operator_name', ispsStatus: 'isps_status', status: 'status', createdAt: 'created_at', updatedAt: 'updated_at' };

@Controller('facilities/port-facilities')
export class PortFacilitiesController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient, private readonly hub: IntegrationClient) {}

  @RequirePerm('facilities.view') @Get()
  async list(@Query() query: PageQuery & { facilityType?: string; operator?: string; ispsStatus?: string; status?: string; terminal?: string }, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: 'code', sortable: Object.keys(SORT), maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    const add = (sql: (i: number) => string, value: unknown) => { args.push(value); where.push(sql(args.length)); };
    if (query.facilityType) add((i) => `facility_type = $${i}`, query.facilityType);
    if (query.operator) add((i) => `(operator_id = $${i} OR lower(operator_name) = lower($${i}))`, query.operator);
    if (query.ispsStatus) add((i) => `isps_status = $${i}`, query.ispsStatus);
    if (query.status) add((i) => `status = $${i}`, query.status);
    if (query.terminal) add((i) => `lower(terminal) = lower($${i})`, query.terminal);
    if (p.q) add((i) => `(name ILIKE $${i} OR code ILIKE $${i} OR terminal ILIKE $${i} OR operator_name ILIKE $${i} OR soc_no ILIKE $${i})`, `%${escapeLike(p.q)}%`);
    scopeWhere(user.scope, where, args, FACILITY_SCOPE);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM port_facilities ${w}`, args);
    const rows = await this.pool.query<FacilityRow>(`SELECT * FROM port_facilities ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, code LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map((r) => facilityApi(r)), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  @RequirePerm('facilities.view') @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: Principal) { return fullFacility(this.pool, await loadFacility(this.pool, id, user.scope)); }

  @RequirePerm('facilities.view') @Get(':id/audits')
  async audits(@Param('id') id: string, @CurrentUser() user: Principal) {
    const f = await loadFacility(this.pool, id, user.scope);
    const history = await auditsFor(this.pool, 'FACILITY', f.id);
    return { subjectId: f.id, subjectName: f.name, computed: ratingFrom(history), audits: history };
  }

  @RequirePerm('facilities.view') @Get(':id/renewals')
  async renewals(@Param('id') id: string, @CurrentUser() user: Principal, @Query('window') window?: string) {
    const f = await loadFacility(this.pool, id, user.scope);
    return renewalWorkList(this.pool, Number(window) || this.env.RENEWAL_WINDOW_DAYS, { subjectId: f.id });
  }

  @RequirePerm('facilities.view') @Get(':id/visits')
  async visits(@Param('id') id: string, @CurrentUser() user: Principal) {
    const f = await loadFacility(this.pool, id, user.scope);
    const list = await visitsFor(this.pool, 'FACILITY', f.id);
    return { subjectId: f.id, subjectName: f.name, scheduled: list.filter((v) => v.status === 'SCHEDULED').length, overdue: list.filter((v) => v.overdue).length, visits: list };
  }
  @RequirePerm('facilities.manage') @Post(':id/visits')
  async visit(@Param('id') id: string, @Body(zod(visitBody)) b: z.infer<typeof visitBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const f = await loadFacility(c, id, user.scope, true);
      const row = await scheduleVisit(c, this.env, this.audit, { kind: 'FACILITY', id: f.id, name: f.name }, { ...b, scheduledOn: b.scheduledOn ?? b.complete?.visitedOn ?? null }, user);
      if (!b.complete) return { visit: visitApi(row), rating: null, obligations: [], cycle: null };
      const done = await completeVisit(c, this.env, this.audit, row.id, b.complete, user);
      return { visit: visitApi(done.row), rating: done.rating, obligations: done.obligations, cycle: done.cycle ? cycleApi(done.cycle) : null };
    });
  }
  @RequirePerm('facilities.view') @Get(':id/rating')
  async rating(@Param('id') id: string, @CurrentUser() user: Principal) {
    const f = await loadFacility(this.pool, id, user.scope);
    return { subjectId: f.id, subjectName: f.name, ...(await ratingFor(this.pool, 'FACILITY', f.id)) };
  }

  @RequirePerm('facilities.manage') @Post()
  async create(@Body(zod(body)) b: z.infer<typeof body>) {
    return withTx(this.pool, async (c) => {
      await assertLookup(c, 'facilityType', b.facilityType, 'Facility type');
      await assertLookups(c, 'facilityCapability', b.capabilities, 'Capability');
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
  async update(@Param('id') id: string, @Body(zod(patch)) b: Partial<z.infer<typeof body>>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      if (b.facilityType !== undefined) await assertLookup(c, 'facilityType', b.facilityType, 'Facility type');
      if (b.capabilities !== undefined) await assertLookups(c, 'facilityCapability', b.capabilities, 'Capability');
      const before = await loadFacility(c, id, user.scope, true);
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
  async isps(@Param('id') id: string, @Body(zod(ispsBody)) b: z.infer<typeof ispsBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await loadFacility(c, id, user.scope, true);
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

  /** Submit the facility for the federal authority's security review; the reference comes back at once, the outcome later. */
  @RequirePerm('facilities.manage') @Post(':id/icp-review')
  async icpReview(@Param('id') id: string, @Body(zod(icpBody)) b: z.infer<typeof icpBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await loadFacility(c, id, user.scope, true);
      if (before.icp_review && !['CLEARED', 'REJECTED', 'WITHDRAWN', 'CLOSED'].includes(before.icp_review.status)) throw conflict(`${before.name} is already under review (${before.icp_review.reference}, ${before.icp_review.status.toLowerCase()})`);
      const day = new Date().toISOString().slice(0, 10);
      const out = await this.hub.tryCall<{ reference?: string; status?: string; expectedBy?: string }>('icp', 'requestReview', { facilityId: before.code, reason: b.reason }, { idempotencyKey: `icp:${before.code}:${day}`, correlationId: `facility:${before.id}` });
      if (out.status !== 'ok') throw badGateway(`federal authority: ${out.error ?? out.status}`);
      const now = new Date().toISOString();
      const review: IcpReview = { reference: String(out.data?.reference ?? ''), status: String(out.data?.status ?? 'SUBMITTED'), reason: b.reason, requestedAt: now, requestedBy: user.name, expectedBy: out.data?.expectedBy ?? null, decidedAt: null, conditions: [], checkedAt: now, mode: out.mode, callId: out.callId };
      if (!review.reference) throw badGateway('federal authority answered without a reference');
      const r = await c.query<FacilityRow>('UPDATE port_facilities SET icp_review = $2, updated_at = now() WHERE id = $1 RETURNING *', [before.id, JSON.stringify(review)]);
      await this.audit.record(c, { action: 'ICP_REVIEW', entity: 'PortFacility', entityId: before.id, entityLabel: before.name, after: { reference: review.reference, status: review.status, mode: review.mode }, note: b.reason });
      return fullFacility(c, r.rows[0]);
    });
  }

  /** Ask the authority what became of the review. */
  @RequirePerm('facilities.manage') @Post(':id/icp-review/refresh')
  async icpReviewRefresh(@Param('id') id: string, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await loadFacility(c, id, user.scope, true);
      if (!before.icp_review?.reference) throw conflict(`${before.name} has not been submitted for review`);
      const out = await this.hub.tryCall<{ status?: string; decidedAt?: string | null; conditions?: unknown[] }>('icp', 'reviewStatus', { reference: before.icp_review.reference }, { correlationId: `facility:${before.id}` });
      if (out.status !== 'ok') throw badGateway(`federal authority: ${out.error ?? out.status}`);
      const row = await applyIcpOutcome(c, before, { status: String(out.data?.status ?? before.icp_review.status), decidedAt: out.data?.decidedAt ?? null, conditions: out.data?.conditions ?? [], mode: out.mode });
      await this.audit.record(c, { action: 'ICP_REVIEW', entity: 'PortFacility', entityId: before.id, entityLabel: before.name, after: { reference: row.icp_review?.reference, status: row.icp_review?.status } });
      return fullFacility(c, row);
    });
  }

  @RequirePerm('facilities.manage') @Post(':id/audits')
  async audit_(@Param('id') id: string, @Body(zod(auditBody)) b: z.infer<typeof auditBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const facility = await loadFacility(c, id, user.scope, true);
      const done = await recordAudit(c, this.env, this.audit, { kind: 'FACILITY', id: facility.id, name: facility.name }, b, user);
      await publishFacility(c, this.env, facility, {}, EVENTS.facilities.facilityAudited, { auditNo: done.row.number, result: done.row.result, auditor: done.row.auditor, rating: done.rating });
      return { audit: auditApi(done.row), rating: done.rating, obligation: done.obligation ? obligationApi(done.obligation) : null, facility: await fullFacility(c, facility) };
    });
  }

  @RequirePerm('facilities.manage') @Post(':id/obligations')
  async raise(@Param('id') id: string, @Body(zod(obligationBody)) b: z.infer<typeof obligationBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const facility = await loadFacility(c, id, user.scope, true);
      await assertLookup(c, 'obligationKind', b.kind, 'Obligation kind');
      return obligationApi(await raiseObligation(c, this.env, this.audit, { kind: 'FACILITY', id: facility.id, name: facility.name }, b, user));
    });
  }

  @RequirePerm('facilities.manage') @Post(':id/obligations/:obligationId/clear')
  async clear(@Param('id') id: string, @Param('obligationId') obligationId: string, @Body(zod(clearBody)) b: z.infer<typeof clearBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const facility = await loadFacility(c, id, user.scope);
      return obligationApi(await clearObligation(c, this.env, this.audit, 'FACILITY', facility.id, obligationId, b.note, user));
    });
  }

  /** A facility that has been audited or has held an instrument is closed, not deleted. */
  @RequirePerm('facilities.manage') @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await loadFacility(c, id, user.scope, true);
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
