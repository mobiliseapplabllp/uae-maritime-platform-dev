import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { PageQuery } from '@maritime/contracts';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, escapeLike, lookupOptions, notFound, paged, parsePage, scopeWhere, withTx, zod, type Principal } from '@maritime/service-kit';
import type { Env } from './env';
import { ACCREDITATION_STATUS, INSTITUTION_STATUS, MET_SCOPE, PROGRAMME_STATUS, addProgramme, institutionApi, institutionEntity, loadInstitution, metDashboard, metSchemeCodes, programmeApi, programmesOf, registerInstitution, setInstitutionStatus, updateInstitution, updateProgramme, type InstitutionRow, type ProgrammeRow } from './met';

/* The MET register's API: the providers, what each is approved to teach, and the desk's picture of the sector. */
const text = (max: number) => z.string().trim().max(max);
const blank = (v: unknown) => (v === '' || v === null ? null : v);
const date = z.preprocess(blank, z.string().min(1).nullable().optional());
const institutionBody = z.object({
  companyId: text(80).min(1), code: text(20).min(2), name: text(200).min(1), nameAr: text(200).default(''), institutionType: text(40).min(1),
  city: text(120).default(''), address: text(400).default(''), contactName: text(160).default(''), contactEmail: text(200).default(''), contactPhone: text(60).default(''),
  instructors: z.coerce.number().int().min(0).max(5000).default(0), capacity: z.coerce.number().int().min(0).max(100000).default(0), simulators: z.array(text(120)).max(40).default([]),
  qualitySystem: text(400).default(''), establishedOn: date, remarks: text(2000).default(''),
});
const institutionPatch = institutionBody.partial();
const statusBody = z.object({ status: z.enum(INSTITUTION_STATUS), reason: text(500).default('') });
const programmeBody = z.object({
  programme: text(40).min(1), seatsPerIntake: z.coerce.number().int().min(0).max(5000).default(0), intakesPerYear: z.coerce.number().int().min(0).max(365).default(1),
  approvalNo: text(80).default(''), approvedOn: date, expiresOn: date, status: z.enum(PROGRAMME_STATUS).optional(), remarks: text(2000).default(''),
});
const programmePatch = programmeBody.omit({ programme: true }).partial().extend({ statusReason: text(500).optional() });
const withdrawBody = z.object({ reason: text(500).min(1) });

const SORT: Record<string, string> = { name: 'name', code: 'code', institutionType: 'institution_type', status: 'status', accreditationStatus: 'accreditation_status', accreditedUntil: 'accredited_until', city: 'city', updatedAt: 'updated_at' };
type ListQuery = PageQuery & { institutionType?: string; status?: string; accreditationStatus?: string; programme?: string };

@Controller('seafarers/met')
export class MetController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  /** The vocabularies the MET screens draw from, and which accreditation schemes accredit a provider. */
  @RequirePerm('seafarers.view') @Get('reference')
  async reference() {
    const [types, programmes, schemes] = await Promise.all([lookupOptions(this.pool, 'metInstitutionType'), lookupOptions(this.pool, 'metProgramme'), metSchemeCodes(this.pool)]);
    return { institutionTypes: types, programmes: programmes.map((p) => ({ code: p.code, label: p.label, labelAr: p.labelAr, regulation: p.meta.regulation ?? '', hours: p.meta.hours ?? null, simulator: p.meta.simulator === true })), schemes, institutionStatuses: INSTITUTION_STATUS, accreditationStatuses: ACCREDITATION_STATUS, programmeStatuses: PROGRAMME_STATUS };
  }

  @RequirePerm('seafarers.view') @Get('dashboard')
  async dashboard(@CurrentUser() user: Principal) {
    const where: string[] = []; const args: unknown[] = [];
    scopeWhere(user.scope, where, args, MET_SCOPE);
    const rows = (await this.pool.query<InstitutionRow>(`SELECT * FROM met_institutions ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name`, args)).rows;
    const programmes = rows.length ? (await this.pool.query<ProgrammeRow>('SELECT * FROM met_programmes WHERE institution_id = ANY($1)', [rows.map((r) => r.id)])).rows : [];
    const now = new Date();
    const institutions = rows.map((r) => institutionApi(r, programmes.filter((p) => p.institution_id === r.id), now));
    return metDashboard(institutions, await lookupOptions(this.pool, 'metProgramme'), now);
  }

  /** The programme catalogue: every programme the master knows, with who is approved to deliver it. */
  @RequirePerm('seafarers.view') @Get('programmes')
  async programmes(@CurrentUser() user: Principal) {
    const where: string[] = []; const args: unknown[] = [];
    scopeWhere(user.scope, where, args, { ...MET_SCOPE, alias: 'i' });
    const rows = (await this.pool.query<ProgrammeRow & { institution_name: string; institution_code: string }>(`SELECT p.*, i.name AS institution_name, i.code AS institution_code FROM met_programmes p JOIN met_institutions i ON i.id = p.institution_id ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.programme, i.name`, args)).rows;
    const master = await lookupOptions(this.pool, 'metProgramme');
    return master.map((m) => {
      const ps = rows.filter((p) => p.programme === m.code);
      return { programme: m.code, title: m.label, titleAr: m.labelAr, regulation: m.meta.regulation ?? '', hours: m.meta.hours ?? null, simulator: m.meta.simulator === true,
        providers: ps.map((p) => ({ ...programmeApi(p), institutionName: p.institution_name, institutionCode: p.institution_code })), approved: ps.filter((p) => p.status === 'APPROVED').length, seatsPerYear: ps.filter((p) => p.status === 'APPROVED').reduce((t, p) => t + p.seats_per_intake * p.intakes_per_year, 0) };
    });
  }

  @RequirePerm('seafarers.view') @Get('institutions')
  async list(@Query() query: ListQuery, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: 'name', sortable: Object.keys(SORT), maxLimit: 200 });
    const where: string[] = []; const args: unknown[] = [];
    const eq = (col: string, v: string | undefined) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
    eq('institution_type', query.institutionType); eq('status', query.status); eq('accreditation_status', query.accreditationStatus);
    if (query.programme) { args.push(query.programme); where.push(`EXISTS (SELECT 1 FROM met_programmes mp WHERE mp.institution_id = met_institutions.id AND mp.programme = $${args.length} AND mp.status = 'APPROVED')`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(name ILIKE $${args.length} OR name_ar ILIKE $${args.length} OR code ILIKE $${args.length} OR city ILIKE $${args.length})`); }
    scopeWhere(user.scope, where, args, MET_SCOPE);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM met_institutions ${w}`, args);
    const rows = await this.pool.query<InstitutionRow>(`SELECT * FROM met_institutions ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, name LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    const ids = rows.rows.map((r) => r.id);
    const programmes = ids.length ? (await this.pool.query<ProgrammeRow>('SELECT * FROM met_programmes WHERE institution_id = ANY($1)', [ids])).rows : [];
    const now = new Date();
    return paged(rows.rows.map((r) => institutionApi(r, programmes.filter((x) => x.institution_id === r.id), now)), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  @RequirePerm('seafarers.create') @Post('institutions')
  async register(@Body(zod(institutionBody)) body: z.infer<typeof institutionBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => institutionEntity(c, await registerInstitution(c, this.env, this.audit, body, user)));
  }

  @RequirePerm('seafarers.view') @Get('institutions/:id')
  async get(@Param('id') id: string, @CurrentUser() user: Principal) {
    const row = await this.visible(id, user);
    return institutionEntity(this.pool, row);
  }

  @RequirePerm('seafarers.edit') @Put('institutions/:id')
  async update(@Param('id') id: string, @Body(zod(institutionPatch)) body: z.infer<typeof institutionPatch>, @CurrentUser() user: Principal) {
    await this.visible(id, user);
    return withTx(this.pool, async (c) => institutionEntity(c, await updateInstitution(c, this.env, this.audit, id, body)));
  }

  @RequirePerm('seafarers.edit') @Post('institutions/:id/status')
  async status(@Param('id') id: string, @Body(zod(statusBody)) body: z.infer<typeof statusBody>, @CurrentUser() user: Principal) {
    await this.visible(id, user);
    return withTx(this.pool, async (c) => institutionEntity(c, await setInstitutionStatus(c, this.env, this.audit, id, body.status, body.reason)));
  }

  @RequirePerm('seafarers.view') @Get('institutions/:id/programmes')
  async listProgrammes(@Param('id') id: string, @CurrentUser() user: Principal) {
    const row = await this.visible(id, user);
    return (await programmesOf(this.pool, row.id)).map(programmeApi);
  }

  @RequirePerm('seafarers.edit') @Post('institutions/:id/programmes')
  async approve(@Param('id') id: string, @Body(zod(programmeBody)) body: z.infer<typeof programmeBody>, @CurrentUser() user: Principal) {
    await this.visible(id, user);
    return withTx(this.pool, async (c) => { const { institution, programme } = await addProgramme(c, this.env, this.audit, id, body, user); return { programme: programmeApi(programme), institution: await institutionEntity(c, institution) }; });
  }

  @RequirePerm('seafarers.edit') @Put('institutions/:id/programmes/:pid')
  async amend(@Param('id') id: string, @Param('pid') pid: string, @Body(zod(programmePatch)) body: z.infer<typeof programmePatch>, @CurrentUser() user: Principal) {
    await this.visible(id, user);
    return withTx(this.pool, async (c) => programmeApi(await updateProgramme(c, this.env, this.audit, id, pid, body)));
  }

  @RequirePerm('seafarers.edit') @Post('institutions/:id/programmes/:pid/withdraw')
  async withdraw(@Param('id') id: string, @Param('pid') pid: string, @Body(zod(withdrawBody)) body: z.infer<typeof withdrawBody>, @CurrentUser() user: Principal) {
    await this.visible(id, user);
    return withTx(this.pool, async (c) => programmeApi(await updateProgramme(c, this.env, this.audit, id, pid, { status: 'WITHDRAWN', statusReason: body.reason })));
  }

  /* An institution reads its own row; the administration reads them all. A reader outside the row is answered "not found". */
  private async visible(ref: string, user: Principal): Promise<InstitutionRow> {
    const row = await loadInstitution(this.pool, ref);
    if (!row) throw notFound('MET institution not found');
    const where: string[] = []; const args: unknown[] = [];
    scopeWhere(user.scope, where, args, MET_SCOPE);
    if (where.length) {
      args.push(row.id); where.push(`id = $${args.length}`);
      const seen = await this.pool.query(`SELECT 1 FROM met_institutions WHERE ${where.join(' AND ')}`, args);
      if (!seen.rowCount) throw notFound('MET institution not found');
    }
    return row;
  }
}
