import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { PageQuery } from '@maritime/contracts';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, escapeLike, isNational, lookupOptions, notFound, paged, parsePage, scopeWhere, withTx, zod, type Principal } from '@maritime/service-kit';
import type { Env } from './env';
import { CREW_LIST_SCOPE, FOREIGN_STATUS, LIST_STATUS, MATCHES, MOVEMENTS, crewListApi, crewListDashboard, decideList, foreignApi, linesOf, loadForeign, loadList, receiveCrewList, reconcileForeign, recordEndorsement, runChecks, type CrewListRow, type ForeignRow } from './crewlists';
import { loadScale, onBoardOf, saveScale, scaleApi, vesselOf, type ManningRow } from './manning';
import { SEAFARER_SCOPE, scopedWhere } from './scope';

/* The crew-list desk: FAL-5 lists as they arrive, the safe manning scales they are read against, and the
 * foreign seafarer ledger that grows out of them. */
const text = (max: number) => z.string().trim().max(max);
const blank = (v: unknown) => (v === '' || v === null ? null : v);
const date = z.preprocess(blank, z.string().min(1).nullable().optional());
const rowBody = z.object({
  seq: z.coerce.number().int().min(1).optional(), familyName: text(120).min(1), givenNames: text(160).default(''), rank: text(80).min(1), nationality: text(120).min(1),
  dob: date, pob: text(120).default(''), gender: text(1).default(''), idType: text(60).default('Passport'), idNumber: text(60).min(1), idExpiry: date, cdcNo: text(60).default(''),
});
const listBody = z.object({
  vcn: text(40).optional(), vesselId: text(80).optional(), movement: z.enum(MOVEMENTS).default('ARRIVAL'), date: date, source: text(40).min(1), submittedBy: text(200).optional(),
  declaredCrew: z.coerce.number().int().min(0).max(5000).nullable().optional(), remarks: text(2000).default(''), rows: z.array(rowBody).min(1).max(500),
});
const decisionBody = z.object({ note: text(1000).default('') });
const scaleBody = z.object({
  tradingArea: text(40).min(1), msmdNo: text(80).default(''), issuedOn: date, expiresOn: date, remarks: text(1000).default(''),
  rows: z.array(z.object({ rank: text(80).min(1), count: z.coerce.number().int().min(1).max(99), cocGrade: text(40).optional(), notes: text(300).default('') })).min(1).max(60),
});
const endorsementBody = z.object({ number: text(80).min(1), issuer: text(200).optional(), expiryDate: date, remarks: text(500).default('') });
const reconcileBody = z.object({ seafarerId: text(80).min(1), note: text(500).default('') });

const LIST_SORT: Record<string, string> = { date: 'list_date', number: 'number', vesselName: 'vessel_name', status: 'status', source: 'source', rowCount: 'row_count', flagged: 'flagged', createdAt: 'created_at' };
const LEDGER_SORT: Record<string, string> = { name: 'family_name', nationality: 'nationality', lastSeenAt: 'last_seen_at', firstSeenAt: 'first_seen_at', appearances: 'appearances', status: 'status', lastRank: 'last_rank', idExpiry: 'id_expiry' };
type ListQuery = PageQuery & { status?: string; vesselId?: string; vcn?: string; source?: string; ok?: string; movement?: string };
type LedgerQuery = PageQuery & { status?: string; nationality?: string; rank?: string; officer?: string };

@Controller('seafarers')
export class CrewListsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  /* ------------------------------------------------------------------ crew lists --- */

  @RequirePerm('seafarers.view') @Get('crew-lists/reference')
  async reference() {
    const [sources, areas] = await Promise.all([lookupOptions(this.pool, 'crewListSource'), lookupOptions(this.pool, 'tradingArea')]);
    return { sources, tradingAreas: areas, statuses: LIST_STATUS, movements: MOVEMENTS, matches: MATCHES, ledgerStatuses: FOREIGN_STATUS, strictClearance: this.env.MANNING_STRICT_CLEARANCE, watchAppearances: this.env.FOREIGN_WATCH_APPEARANCES };
  }

  @RequirePerm('seafarers.view') @Get('crew-lists/dashboard')
  async dashboard(@CurrentUser() user: Principal) {
    const sc = scopedWhere(user.scope, CREW_LIST_SCOPE);
    const lists = (await this.pool.query<CrewListRow>(`SELECT * FROM crew_lists ${sc.sql} ORDER BY list_date DESC`, sc.args)).rows;
    const labels = new Map((await lookupOptions(this.pool, 'crewListSource')).map((o) => [o.code, o.label]));
    // the ledger is the administration's: a company reads the lists it lodged, never the persons behind other agents' lists
    const ledger = isNational(user.scope) ? (await this.pool.query<ForeignRow>('SELECT * FROM foreign_seafarers')).rows : [];
    return crewListDashboard(lists.map((l) => crewListApi(l, undefined, { sourceLabel: labels.get(l.source) })), ledger.map((f) => foreignApi(f)));
  }

  @RequirePerm('seafarers.view') @Get('crew-lists')
  async list(@Query() query: ListQuery, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: '-date', sortable: Object.keys(LIST_SORT), maxLimit: 200 });
    const where: string[] = []; const args: unknown[] = [];
    const eq = (col: string, v: string | undefined) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
    eq('status', query.status); eq('vessel_id', query.vesselId); eq('vcn', query.vcn); eq('source', query.source); eq('movement', query.movement);
    if (query.ok === 'true') where.push(`(checks->>'ok')::boolean = true`);
    if (query.ok === 'false') where.push(`(checks->>'ok')::boolean = false`);
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(number ILIKE $${args.length} OR vcn ILIKE $${args.length} OR vessel_name ILIKE $${args.length} OR imo ILIKE $${args.length})`); }
    scopeWhere(user.scope, where, args, CREW_LIST_SCOPE);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM crew_lists ${w}`, args);
    const rows = await this.pool.query<CrewListRow>(`SELECT * FROM crew_lists ${w} ORDER BY ${LIST_SORT[p.sortField]} ${p.sortDir} NULLS LAST, number LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    const labels = new Map((await lookupOptions(this.pool, 'crewListSource')).map((o) => [o.code, o.label]));
    return paged(rows.rows.map((l) => crewListApi(l, undefined, { sourceLabel: labels.get(l.source) })), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  @RequirePerm('seafarers.view', 'seafarers.edit') @Post('crew-lists')
  async receive(@Body(zod(listBody)) body: z.infer<typeof listBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => { const row = await receiveCrewList(c, this.env, this.audit, body, user); return crewListApi(row, await linesOf(c, row.id)); });
  }

  @RequirePerm('seafarers.view') @Get('crew-lists/:id')
  async get(@Param('id') id: string, @CurrentUser() user: Principal) {
    const row = await this.visibleList(id, user);
    const labels = new Map((await lookupOptions(this.pool, 'crewListSource')).map((o) => [o.code, o.label]));
    return crewListApi(row, await linesOf(this.pool, row.id), { sourceLabel: labels.get(row.source) });
  }

  @RequirePerm('seafarers.edit') @Post('crew-lists/:id/check')
  async check(@Param('id') id: string, @CurrentUser() user: Principal) {
    await this.visibleList(id, user);
    return withTx(this.pool, async (c) => { const list = await loadList(c, id, true); if (!list) throw notFound('Crew list not found'); const row = await runChecks(c, this.env, this.audit, list, user); return crewListApi(row, await linesOf(c, row.id)); });
  }

  @RequirePerm('seafarers.edit') @Post('crew-lists/:id/clear')
  async clear(@Param('id') id: string, @Body(zod(decisionBody)) body: z.infer<typeof decisionBody>, @CurrentUser() user: Principal) {
    await this.visibleList(id, user);
    return withTx(this.pool, async (c) => { const row = await decideList(c, this.env, this.audit, id, 'CLEARED', body.note, user); return crewListApi(row, await linesOf(c, row.id)); });
  }

  @RequirePerm('seafarers.edit') @Post('crew-lists/:id/query')
  async query(@Param('id') id: string, @Body(zod(decisionBody)) body: z.infer<typeof decisionBody>, @CurrentUser() user: Principal) {
    await this.visibleList(id, user);
    return withTx(this.pool, async (c) => { const row = await decideList(c, this.env, this.audit, id, 'QUERIED', body.note, user); return crewListApi(row, await linesOf(c, row.id)); });
  }

  /* ------------------------------------------------------------------ safe manning --- */

  /** Every ship's scale, read against who the register has aboard today. */
  @RequirePerm('seafarers.view') @Get('manning')
  async scales(@Query() query: PageQuery & { documented?: string; compliant?: string }, @CurrentUser() user: Principal) {
    if (!isNational(user.scope)) throw notFound('Safe manning scales are the administration\'s');
    const p = parsePage(query, { defaultSort: 'vesselName', sortable: ['vesselName', 'imo', 'tradingArea', 'updatedAt'], maxLimit: 200 });
    const rows = (await this.pool.query<ManningRow>('SELECT * FROM manning_scales ORDER BY vessel_name')).rows;
    const areas = new Map((await lookupOptions(this.pool, 'tradingArea')).map((o) => [o.code, o.label]));
    let out = [] as ReturnType<typeof scaleApi>[];
    for (const r of rows) out.push(scaleApi(r, { tradingAreaLabel: areas.get(r.trading_area), onBoard: await onBoardOf(this.pool, r.vessel_id) }));
    if (p.q) { const q = p.q.toLowerCase(); out = out.filter((s) => s.vesselName.toLowerCase().includes(q) || s.imo.includes(q) || s.msmdNo.toLowerCase().includes(q)); }
    if (query.documented === 'true') out = out.filter((s) => s.documented); if (query.documented === 'false') out = out.filter((s) => !s.documented);
    if (query.compliant === 'false') out = out.filter((s) => s.compliance && !s.compliance.ok); if (query.compliant === 'true') out = out.filter((s) => s.compliance?.ok);
    const key = p.sortField as 'vesselName' | 'imo' | 'tradingArea' | 'updatedAt';
    out.sort((a, b) => String(a[key] ?? '').localeCompare(String(b[key] ?? '')) * (p.sortDir === 'desc' ? -1 : 1));
    return paged(out.slice(p.offset, p.offset + p.limit), { total: out.length, page: p.page, limit: p.limit });
  }

  @RequirePerm('seafarers.view') @Get('manning/:vesselId')
  async scale(@Param('vesselId') vesselId: string, @CurrentUser() user: Principal) {
    if (!isNational(user.scope)) throw notFound('Safe manning scales are the administration\'s');
    const vessel = await vesselOf(this.pool, vesselId);
    if (!vessel) throw notFound('Vessel not on the fleet snapshot');
    const row = await loadScale(this.pool, vessel.id);
    const areas = new Map((await lookupOptions(this.pool, 'tradingArea')).map((o) => [o.code, o.label]));
    const onBoard = await onBoardOf(this.pool, vessel.id);
    if (!row) return { id: null, vesselId: vessel.id, vesselName: vessel.name, imo: vessel.imo, msmdNo: '', instrumentId: null, issuedOn: null, expiresOn: null, tradingArea: '', tradingAreaLabel: '', rows: [], total: 0, officers: 0, recorded: false, documented: false, remarks: '', recordedBy: '', compliance: null, onBoard, createdAt: null, updatedAt: null };
    return { ...scaleApi(row, { tradingAreaLabel: areas.get(row.trading_area), onBoard }), onBoard };
  }

  @RequirePerm('seafarers.edit') @Put('manning/:vesselId')
  async record(@Param('vesselId') vesselId: string, @Body(zod(scaleBody)) body: z.infer<typeof scaleBody>, @CurrentUser() user: Principal) {
    if (!isNational(user.scope)) throw notFound('Safe manning scales are the administration\'s');
    return withTx(this.pool, async (c) => { const row = await saveScale(c, this.env, this.audit, vesselId, body, user); return scaleApi(row, { onBoard: await onBoardOf(c, row.vessel_id) }); });
  }

  /* ---------------------------------------------------------------- foreign ledger --- */

  @RequirePerm('seafarers.view') @Get('foreign')
  async ledger(@Query() query: LedgerQuery, @CurrentUser() user: Principal) {
    if (!isNational(user.scope)) return paged([], { total: 0, page: 1, limit: Number(query.limit ?? 25) || 25 });
    const p = parsePage(query, { defaultSort: '-lastSeenAt', sortable: Object.keys(LEDGER_SORT), maxLimit: 200 });
    const where: string[] = []; const args: unknown[] = [];
    const eq = (col: string, v: string | undefined) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
    eq('status', query.status); eq('nationality', query.nationality);
    if (query.rank) { args.push(query.rank); where.push(`(last_rank = $${args.length} OR last_rank_code = $${args.length})`); }
    if (query.officer === 'true') where.push(`last_rank_code IN (SELECT code FROM lookup_mirror WHERE category = 'seafarerRank' AND (meta->>'officer')::boolean)`);
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(family_name ILIKE $${args.length} OR given_names ILIKE $${args.length} OR id_number ILIKE $${args.length} OR cdc_no ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM foreign_seafarers ${w}`, args);
    const rows = await this.pool.query<ForeignRow>(`SELECT * FROM foreign_seafarers ${w} ORDER BY ${LEDGER_SORT[p.sortField]} ${p.sortDir} NULLS LAST, family_name LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map((f) => foreignApi(f)), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  @RequirePerm('seafarers.view') @Get('foreign/:id')
  async foreign(@Param('id') id: string, @CurrentUser() user: Principal) {
    if (!isNational(user.scope)) throw notFound('Ledger entry not found');
    const f = await loadForeign(this.pool, id);
    if (!f) throw notFound('Ledger entry not found');
    const appearances = await this.pool.query<{ number: string; vcn: string; vessel_name: string; list_date: Date; rank: string; issues: string[]; status: string; crew_list_id: string }>(
      'SELECT l.number, l.vcn, l.vessel_name, l.list_date, r.rank, r.issues, l.status, r.crew_list_id FROM crew_list_rows r JOIN crew_lists l ON l.id = r.crew_list_id WHERE r.foreign_id = $1 ORDER BY l.list_date DESC', [f.id]);
    return { ...foreignApi(f), appearanceList: appearances.rows.map((a) => ({ crewListId: a.crew_list_id, number: a.number, vcn: a.vcn, vesselName: a.vessel_name, date: a.list_date.toISOString(), rank: a.rank, issues: a.issues ?? [], listStatus: a.status })) };
  }

  @RequirePerm('seafarers.edit') @Post('foreign/:id/endorsement')
  async endorse(@Param('id') id: string, @Body(zod(endorsementBody)) body: z.infer<typeof endorsementBody>, @CurrentUser() user: Principal) {
    if (!isNational(user.scope)) throw notFound('Ledger entry not found');
    return withTx(this.pool, async (c) => foreignApi(await recordEndorsement(c, this.env, this.audit, id, body, user)));
  }

  @RequirePerm('seafarers.edit') @Post('foreign/:id/reconcile')
  async reconcile(@Param('id') id: string, @Body(zod(reconcileBody)) body: z.infer<typeof reconcileBody>, @CurrentUser() user: Principal) {
    if (!isNational(user.scope)) throw notFound('Ledger entry not found');
    return withTx(this.pool, async (c) => { const { row, relinked } = await reconcileForeign(c, this.env, this.audit, id, body.seafarerId, body.note, user); return { ...foreignApi(row), relinked }; });
  }

  private async visibleList(ref: string, user: Principal): Promise<CrewListRow> {
    const row = await loadList(this.pool, ref);
    if (!row) throw notFound('Crew list not found');
    const where: string[] = []; const args: unknown[] = [];
    scopeWhere(user.scope, where, args, CREW_LIST_SCOPE);
    if (where.length) {
      args.push(row.id); where.push(`id = $${args.length}`);
      const seen = await this.pool.query(`SELECT 1 FROM crew_lists WHERE ${where.join(' AND ')}`, args);
      if (!seen.rowCount) throw notFound('Crew list not found');
    }
    return row;
  }
}
/* Referenced so the register's own tenancy options stay the single declaration the file imports. */
export const REGISTER_SCOPE = SEAFARER_SCOPE;
