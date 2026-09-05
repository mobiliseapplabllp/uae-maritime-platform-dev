import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, INSPECTION_RESULTS, kpiTargetsFrom, type PageQuery, type TenancyScope } from '@maritime/contracts';
import {
  AuditClient, KIT_ENV, KIT_POOL, KIT_SETTINGS, RequirePerm, CurrentUser, SettingsClient, badRequest, conflict, enqueue, escapeLike, eventFromContext, notFound, paged, parsePage, withTx, zod,
  type Principal, scopeWhere } from '@maritime/service-kit';
import { INSPECTION_SCOPE, scopedWhere } from './scope';
import type { Env } from './env';
import {
  DETAINABLE_ACTION, FINDING_SEVERITY, FINDING_STATUS, answersFromTemplate, detentionApi, findingApi, inspectionApi, inspectionCard, inspectionDashboard,
  isResult, iso, mergeAnswers, publishInspection, publishInspectionDeleted, publishRiskSignal, scoreChecklist,
  type ChecklistAnswer, type DashboardInput, type DetentionRow, type FindingApi, type FindingRow, type InspectionRow, type Row, type TemplateRow,
} from './inspections';
import { deficiencyMaster } from './subjects';
import {
  DECISIONS, NOTICE_KINDS, RECOMMENDATION_KINDS, SUBJECT_KINDS, classify, draftNotice, draftReport, findSubject, issueNotice, issueReport, kpiReport, kpiRows, mark, noticeApi,
  predictionApi, prepareDossier, recommendRestriction, recommendationApi, recordPrediction, regimeOf, reportApi, scorePrediction, searchSubjects, subjectApi, timelineApi, timelineOf,
  type NoticeRow, type PredictionRow, type RecommendationRow, type ReportRow, type SubjectKind,
} from './smart';

/* The survey register: the list the register screen pages through, the module's landing analytics, the one-survey
 * record with its checklist, findings and detention, and every step of the survey's life — planned, started,
 * answered, closed with a result. A closed survey is read-only: it is the record of what was found on the day. */

const blank = (v: unknown) => (v === '' || v === null ? null : v);
const text = (max: number) => z.string().trim().max(max);
const date = z.preprocess(blank, z.string().min(1).nullable().optional());
const answerBody = z.object({ seq: z.coerce.number().int().optional(), text: text(400).min(1), category: text(120).optional(), answer: z.enum(['YES', 'NO', 'NA', '']).optional(), note: text(1000).optional(), weight: z.coerce.number().optional(), critical: z.boolean().optional(), answerType: text(20).optional() });
/* A survey is planned under a regime the `inspectionRegime` master defines, against the kind of subject the regime applies to:
 * a ship (the default, named by `vesselId`), or a company, a port facility or a training institution named by `subjectId`. */
const planBody = z.object({
  vesselId: z.preprocess(blank, z.string().trim().min(1).nullable().optional()), type: text(40).min(1), plannedAt: z.string().trim().min(1),
  subjectKind: z.enum(SUBJECT_KINDS).optional(), subjectId: z.preprocess(blank, z.string().trim().min(1).nullable().optional()),
  inspector: text(160).min(1), inspectorId: text(80).optional(), templateId: z.preprocess(blank, z.string().trim().nullable().optional()),
  portCallId: z.preprocess(blank, z.string().trim().nullable().optional()), remarks: text(2000).default(''),
});
const patchBody = z.object({
  inspector: text(160).optional(), inspectorId: text(80).optional(), plannedAt: date, remarks: text(2000).optional(),
  type: text(40).optional(), portCallId: z.preprocess(blank, z.string().trim().nullable().optional()),
  checklist: z.array(answerBody).optional(),
});
const reportBody = z.object({ title: text(300).optional(), summary: text(2000).optional(), body: text(20000).min(1) });
const noticeBody = z.object({ kind: z.enum(NOTICE_KINDS).default('DEFICIENCY'), subject: text(300).optional(), body: text(20000).min(1), addressedTo: text(300).optional(), findingIds: z.array(text(80)).optional() });
const recommendBody = z.object({ kind: z.enum(RECOMMENDATION_KINDS), grounds: text(2000).min(1), codes: z.array(text(40)).optional() });
const decideBody = z.object({ decision: z.enum(DECISIONS), note: text(2000).default('') });
const findingBody = z.object({
  deficiencyCode: text(40).min(1), description: text(2000).min(1), deficiencyLabel: text(300).optional(), category: text(160).optional(),
  severity: z.enum(FINDING_SEVERITY).optional(), actionCode: text(10).default(''), dueDate: date, status: z.enum(FINDING_STATUS).optional(), rectificationNote: text(1000).optional(),
});
const findingPatch = findingBody.partial();
const closeBody = z.object({ result: z.enum(INSPECTION_RESULTS), remarks: text(2000).optional() });
const detainBody = z.object({ grounds: text(2000).min(1), detainableCodes: z.array(text(40)).optional() });
const releaseBody = z.object({ note: text(2000).default('') });

const SORT: Record<string, string> = {
  number: 'number', plannedAt: 'planned_at', startedAt: 'started_at', closedAt: 'closed_at', type: 'type', status: 'status', result: 'result',
  vesselName: 'vessel_name', subjectName: 'subject_name', inspector: 'inspector', scorePct: 'score_pct', createdAt: 'created_at', updatedAt: 'updated_at',
};
type ListQuery = PageQuery & {
  type?: string; regime?: string; status?: string; result?: string; vessel?: string; vesselId?: string; subjectKind?: string; subjectId?: string; inspector?: string; detention?: string;
  from?: string; to?: string; open?: string; templateId?: string;
};

@Controller('inspections')
export class InspectionsController {
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    @Inject(KIT_SETTINGS) private readonly settings: SettingsClient,
    private readonly audit: AuditClient,
  ) {}

  private now() { return new Date(); }
  /** The pass mark is policy: the module setting wins, the environment default stands in when MDM is unreachable. */
  private async passMark(): Promise<number> {
    const s = await this.settings.moduleGet('inspect', { passScorePct: this.env.PASS_SCORE_PCT, findingDueDays: this.env.FINDING_DUE_DAYS });
    return Number(s.passScorePct) || this.env.PASS_SCORE_PCT;
  }
  private async dueDays(): Promise<number> {
    const s = await this.settings.moduleGet('inspect', { passScorePct: this.env.PASS_SCORE_PCT, findingDueDays: this.env.FINDING_DUE_DAYS });
    return Number(s.findingDueDays) || this.env.FINDING_DUE_DAYS;
  }
  private async findingsOf(c: Pool | PoolClient, inspectionId: string): Promise<FindingApi[]> {
    const r = await c.query<FindingRow>('SELECT * FROM findings WHERE inspection_id = $1 ORDER BY seq, created_at', [inspectionId]);
    return r.rows.map(findingApi);
  }
  private async findingsByInspection(ids: string[]): Promise<Map<string, FindingApi[]>> {
    const out = new Map<string, FindingApi[]>();
    if (!ids.length) return out;
    const r = await this.pool.query<FindingRow>('SELECT * FROM findings WHERE inspection_id = ANY($1) ORDER BY seq, created_at', [ids]);
    for (const f of r.rows) { const list = out.get(f.inspection_id) ?? []; list.push(findingApi(f)); out.set(f.inspection_id, list); }
    return out;
  }
  private async detentionOf(c: Pool | PoolClient, inspectionId: string) {
    const r = await c.query<DetentionRow>('SELECT * FROM detentions WHERE inspection_id = $1 ORDER BY ordered_at DESC LIMIT 1', [inspectionId]);
    return r.rows[0] ? detentionApi(r.rows[0]) : null;
  }
  /* Every handler that touches one inspection comes through these two, so the tenancy filter lives here: an
   * inspection in another port is not found rather than found and refused. */
  private async load(c: Pool | PoolClient, id: string, scope: TenancyScope): Promise<InspectionRow> {
    const where = ['(id::text = $1 OR number = $1)']; const args: unknown[] = [id];
    scopeWhere(scope, where, args, INSPECTION_SCOPE);
    const r = await c.query<InspectionRow>(`SELECT * FROM inspections WHERE ${where.join(' AND ')}`, args);
    if (!r.rows[0]) throw notFound('Inspection not found');
    return r.rows[0];
  }
  private async lockRow(c: PoolClient, id: string, scope: TenancyScope): Promise<InspectionRow> {
    const where = ['(id::text = $1 OR number = $1)']; const args: unknown[] = [id];
    scopeWhere(scope, where, args, INSPECTION_SCOPE);
    const r = await c.query<InspectionRow>(`SELECT * FROM inspections WHERE ${where.join(' AND ')} FOR UPDATE`, args);
    if (!r.rows[0]) throw notFound('Inspection not found');
    return r.rows[0];
  }
  private async publish(c: PoolClient, i: InspectionRow, event: string, data: Row = {}) {
    return publishInspection(c, this.env, i, { findings: await this.findingsOf(c, i.id), detention: await this.detentionOf(c, i.id) }, { event, data });
  }
  private async settingsOf() { return this.settings.moduleGet<Record<string, unknown>>('inspect', { passScorePct: this.env.PASS_SCORE_PCT, findingDueDays: this.env.FINDING_DUE_DAYS }); }
  /** The Smart Inspection records on one survey, for the screen and for the read model. */
  private async smartOf(c: Pool | PoolClient, id: string) {
    const [reports, notices, recommendations, prediction, timeline] = await Promise.all([
      c.query<ReportRow>('SELECT * FROM inspection_reports WHERE inspection_id = $1 ORDER BY version', [id]),
      c.query<NoticeRow>('SELECT * FROM inspection_notices WHERE inspection_id = $1 ORDER BY drafted_at', [id]),
      c.query<RecommendationRow>('SELECT * FROM restriction_recommendations WHERE inspection_id = $1 ORDER BY recommended_at', [id]),
      c.query<PredictionRow>('SELECT * FROM inspection_predictions WHERE inspection_id = $1', [id]),
      timelineOf(c, id),
    ]);
    return { reports: reports.rows.map(reportApi), notices: notices.rows.map(noticeApi), recommendations: recommendations.rows.map(recommendationApi), prediction: prediction.rows[0] ? predictionApi(prediction.rows[0]) : null, timeline: timeline.map(timelineApi) };
  }
  /** A survey moving from planned to in progress is a boarding: the timeline says when, and the dossier is made if nobody made it. */
  private async boarded(c: PoolClient, before: InspectionRow, row: InspectionRow, user: Principal): Promise<InspectionRow> {
    if (before.status !== 'PLANNED' || row.status !== 'IN_PROGRESS') return row;
    let out = row;
    if (!out.dossier_prepared_at) out = (await prepareDossier(c, this.env, out, 'AUTO', { actor: { id: user.id, name: user.name, kind: 'user' }, now: new Date(new Date(out.started_at ?? Date.now()).getTime() - 1) })).row;
    await mark(c, out, 'STARTED', out.started_at ?? new Date(), 'DESK');
    // whichever action boarded her — the start button, a first answer, a first finding — the read model hears the same fact once
    await this.publish(c, out, EVENTS.inspection.started, { startedAt: iso(out.started_at), dossier: !!out.dossier_prepared_at });
    return out;
  }
  /** A survey the inspector has begun answering is in progress, whatever the button said. */
  private startedNow(i: InspectionRow, checklist: ChecklistAnswer[]) {
    if (i.status !== 'PLANNED' || !checklist.some((c) => c.answer)) return null;
    return { status: 'IN_PROGRESS', started_at: i.started_at ?? this.now() };
  }

  /** The survey register: filterable, searchable, paged, each row carrying its findings. */
  @RequirePerm('inspections.view') @Get()
  async list(@Query() query: ListQuery, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: '-plannedAt', sortable: Object.keys(SORT), maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    const eq = (col: string, v: string | undefined) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
    eq('type', query.type || query.regime); eq('status', query.status); eq('result', query.result); eq('template_id', query.templateId);
    eq('subject_kind', query.subjectKind); eq('subject_id', query.subjectId);
    const vessel = query.vessel || query.vesselId;
    if (vessel) { args.push(vessel); where.push(`vessel_id::text = $${args.length}`); }
    if (query.inspector) { args.push(`%${escapeLike(query.inspector)}%`, query.inspector); where.push(`(inspector ILIKE $${args.length - 1} OR inspector_id = $${args.length})`); }
    if (String(query.detention) === 'true') where.push('detention');
    if (String(query.open) === 'true') where.push(`status <> 'CLOSED'`);
    if (query.from) { args.push(query.from); where.push(`planned_at >= $${args.length}`); }
    if (query.to) { args.push(query.to); where.push(`planned_at <= $${args.length}`); }
    scopeWhere(user.scope, where, args, INSPECTION_SCOPE);
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(number ILIKE $${args.length} OR inspector ILIKE $${args.length} OR vessel_name ILIKE $${args.length} OR subject_name ILIKE $${args.length} OR vessel_imo ILIKE $${args.length} OR vcn ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM inspections ${w}`, args);
    const rows = await this.pool.query<InspectionRow>(`SELECT * FROM inspections ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, number DESC LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    const findings = await this.findingsByInspection(rows.rows.map((r) => r.id));
    return paged(rows.rows.map((r) => inspectionApi(r, { findings: findings.get(r.id) ?? [] })), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  /** The survey and audit cell's landing analytics. Declared before `:id` so the word is not read as an id. */
  @RequirePerm('inspections.view', 'dashboard.view') @Get('dashboard')
  async dashboard(@CurrentUser() user: Principal) {
    /* The analytics are a read of every survey they count, so they are narrowed exactly as the register is. */
    const sc = scopedWhere(user.scope, INSPECTION_SCOPE, 'i');
    const rows = await this.pool.query<DashboardInput>(
      `SELECT i.type, i.status, i.result, i.detention, i.planned_at, i.closed_at, i.checklist,
              (SELECT count(*) FROM findings f WHERE f.inspection_id = i.id)::int AS findings_total,
              (SELECT count(*) FROM findings f WHERE f.inspection_id = i.id AND f.status = 'OPEN')::int AS findings_open
         FROM inspections i ${sc.sql}`, sc.args);
    return inspectionDashboard(rows.rows, this.now());
  }

  /* The deficiency register across the fleet.
   *
   * The register is worked from the deficiency, not from the survey it was raised on: a rectification deadline
   * belongs to the finding, and an overdue one is the same problem whichever survey found it. */
  @RequirePerm('inspections.view') @Get('deficiencies')
  async deficiencies(@Query() query: PageQuery & { status?: string; code?: string; severity?: string; vessel?: string; overdue?: string; detainable?: string }, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: '-dueDate', maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    const eq = (col: string, v: string | undefined) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
    eq('f.status', query.status); eq('f.deficiency_code', query.code); eq('f.severity', query.severity);
    if (query.vessel) { args.push(query.vessel); where.push(`i.vessel_id::text = $${args.length}`); }
    if (String(query.overdue) === 'true') where.push(`f.status = 'OPEN' AND f.due_date IS NOT NULL AND f.due_date < now()`);
    if (String(query.detainable) === 'true') { args.push(DETAINABLE_ACTION); where.push(`(f.action_code = $${args.length} OR f.severity = 'DETAINABLE')`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(f.deficiency_code ILIKE $${args.length} OR f.description ILIKE $${args.length} OR f.deficiency_label ILIKE $${args.length} OR i.vessel_name ILIKE $${args.length} OR i.number ILIKE $${args.length})`); }
    scopeWhere(user.scope, where, args, { ...INSPECTION_SCOPE, alias: 'i' });
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const order = p.sortField === 'dueDate' ? 'f.due_date' : p.sortField === 'code' ? 'f.deficiency_code' : p.sortField === 'status' ? 'f.status' : 'f.due_date';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM findings f JOIN inspections i ON i.id = f.inspection_id ${w}`, args);
    const rows = await this.pool.query<FindingRow & { number: string; vessel_id: string | null; vessel_name: string; vessel_imo: string; inspection_type: string; inspection_status: string }>(
      `SELECT f.*, i.number, i.vessel_id, i.vessel_name, i.vessel_imo, i.type AS inspection_type, i.status AS inspection_status
         FROM findings f JOIN inspections i ON i.id = f.inspection_id ${w} ORDER BY ${order} ${p.sortDir} NULLS LAST, f.created_at DESC LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    const out = rows.rows.map((f) => ({
      ...findingApi(f), inspectionId: f.inspection_id, inspectionNumber: f.number, inspectionType: f.inspection_type, inspectionStatus: f.inspection_status,
      vesselId: f.vessel_id, vesselName: f.vessel_name, vesselImo: f.vessel_imo,
    }));
    return paged(out, { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  /** Detentions ordered by this administration, open ones first — the flag-state register of ships held. */
  @RequirePerm('inspections.view') @Get('detentions')
  async detentions(@Query() query: PageQuery & { status?: string; vessel?: string }, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: '-orderedAt', maxLimit: 200 });
    const where: string[] = []; const args: unknown[] = [];
    if (query.status) { args.push(query.status); where.push(`d.status = $${args.length}`); }
    if (query.vessel) { args.push(query.vessel); where.push(`d.vessel_id::text = $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(d.vessel_name ILIKE $${args.length} OR i.number ILIKE $${args.length})`); }
    scopeWhere(user.scope, where, args, { ...INSPECTION_SCOPE, alias: 'i' });
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM detentions d JOIN inspections i ON i.id = d.inspection_id ${w}`, args);
    const rows = await this.pool.query<DetentionRow & { number: string; inspection_type: string }>(
      `SELECT d.*, i.number, i.type AS inspection_type FROM detentions d JOIN inspections i ON i.id = d.inspection_id ${w}
         ORDER BY (d.status = 'ORDERED') DESC, d.ordered_at ${p.sortDir} LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map((d) => ({ ...detentionApi(d), inspectionNumber: d.number, inspectionType: d.inspection_type })), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  /* The six Smart Inspection KPIs, measured from this desk's timeline of dated facts against the targets the module's
   * settings hold, and narrowed exactly as the register is: a port cell sees the programme as it stands at its port. */
  @RequirePerm('inspections.view') @Get('kpis')
  async kpis(@Query('programmeStart') programmeStart: string | undefined, @CurrentUser() user: Principal) {
    const rows = await kpiRows(this.pool, scopedWhere(user.scope, INSPECTION_SCOPE, 'i'));
    const settings = await this.settingsOf();
    // an analyst may ask what the programme looks like from another start date; the module setting is what the dashboard shows
    if (programmeStart !== undefined) {
      if (Number.isNaN(new Date(programmeStart).getTime())) throw badRequest('programmeStart is not a valid date');
      settings.kpiProgrammeStart = programmeStart;
    }
    // the targets as they apply — the module's settings with the programme defaults under them — so the screen never shows a blank target
    return { ...kpiReport(rows, settings, this.now()), targets: kpiTargetsFrom(settings) };
  }

  /** The subjects a survey can be planned against, by kind — ships from the fleet snapshot, the rest as their registers published them. */
  @RequirePerm('inspections.view') @Get('subjects')
  async subjects(@Query('kind') kind: string | undefined, @Query('q') q: string | undefined, @Query('limit') limit: string | undefined) {
    const k = (kind ?? 'VESSEL').toUpperCase();
    if (!SUBJECT_KINDS.includes(k as SubjectKind)) throw badRequest(`Subject kind must be one of ${SUBJECT_KINDS.join(', ')}`);
    const rows = await searchSubjects(this.pool, k as SubjectKind, (q ?? '').trim(), Number(limit) || 20);
    return rows.map(subjectApi);
  }

  /** The restrictions the rules have recommended and nobody has yet decided — the deciding officer's worklist. */
  @RequirePerm('inspections.view') @Get('recommendations')
  async recommendations(@Query() query: PageQuery & { status?: string; kind?: string }, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: '-recommendedAt', maxLimit: 200 });
    const where: string[] = []; const args: unknown[] = [];
    if (query.status) { args.push(query.status); where.push(`r.status = $${args.length}`); }
    if (query.kind) { args.push(query.kind); where.push(`r.kind = $${args.length}`); }
    scopeWhere(user.scope, where, args, { ...INSPECTION_SCOPE, alias: 'i' });
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM restriction_recommendations r JOIN inspections i ON i.id = r.inspection_id ${w}`, args);
    const rows = await this.pool.query<RecommendationRow & { number: string; subject_name: string; subject_kind: string }>(
      `SELECT r.*, i.number, i.subject_name, i.subject_kind FROM restriction_recommendations r JOIN inspections i ON i.id = r.inspection_id ${w} ORDER BY (r.status = 'PENDING') DESC, r.recommended_at ${p.sortDir} LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map((r) => ({ ...recommendationApi(r), number: r.number, subjectName: r.subject_name, subjectKind: r.subject_kind })), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  /** The full survey record: particulars, the answered checklist, the findings, the detention order and the Smart Inspection records. */
  @RequirePerm('inspections.view') @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: Principal) {
    const i = await this.load(this.pool, id, user.scope);
    const [findings, detention, call, smart] = await Promise.all([
      this.findingsOf(this.pool, i.id), this.detentionOf(this.pool, i.id),
      i.port_call_id ? this.pool.query<Row>('SELECT * FROM port_calls WHERE id = $1', [i.port_call_id]) : Promise.resolve({ rows: [] as Row[] }),
      this.smartOf(this.pool, i.id),
    ]);
    const c = call.rows[0];
    const passMark = i.pass_score_pct ?? (await this.passMark());
    const live = scoreChecklist(i.checklist ?? [], passMark);
    return {
      ...inspectionApi(i, { findings, detention }),
      passScorePct: passMark,
      liveScore: { pct: live.pct, criticalFail: live.criticalFail, suggested: live.suggested, answeredWeight: live.max },
      portCall: c ? { id: c.id, vcn: c.vcn, status: c.status, berthCode: c.berth_code, eta: iso(c.eta), atb: iso(c.atb), atd: iso(c.atd) } : null,
      dossier: i.dossier ?? null, ...smart,
    };
  }

  /** The dossier the boarding party holds, on its own. */
  @RequirePerm('inspections.view') @Get(':id/dossier')
  async dossier(@Param('id') id: string, @CurrentUser() user: Principal) {
    const i = await this.load(this.pool, id, user.scope);
    return { inspectionId: i.id, number: i.number, preparedAt: iso(i.dossier_prepared_at), source: i.dossier_source, dossier: i.dossier ?? null };
  }

  /** The survey's timeline: every dated fact the KPIs are measured from, in order. */
  @RequirePerm('inspections.view') @Get(':id/timeline')
  async timeline(@Param('id') id: string, @CurrentUser() user: Principal) {
    const i = await this.load(this.pool, id, user.scope);
    return (await timelineOf(this.pool, i.id)).map(timelineApi);
  }

  /** The four facts that answer "which survey is this?" for a hover card. */
  @RequirePerm('inspections.view') @Get(':id/card')
  async card(@Param('id') id: string, @CurrentUser() user: Principal) {
    const i = await this.load(this.pool, id, user.scope);
    return inspectionCard(i, await this.findingsOf(this.pool, i.id));
  }

  /** The checklist on its own, for a client that wants the sheet without the rest of the file. */
  @RequirePerm('inspections.view') @Get(':id/checklist')
  async checklist(@Param('id') id: string, @CurrentUser() user: Principal) {
    const i = await this.load(this.pool, id, user.scope);
    const passMark = i.pass_score_pct ?? (await this.passMark());
    const live = scoreChecklist(i.checklist ?? [], passMark);
    return { inspectionId: i.id, number: i.number, templateId: i.template_id, templateVersion: i.template_version, passScorePct: passMark, status: i.status, scorePct: i.score_pct, ...live, items: (i.checklist ?? []) };
  }

  @RequirePerm('inspections.create') @Post()
  async create(@Body(zod(planBody)) body: z.infer<typeof planBody>, @CurrentUser() user: Principal) {
    const passMark = await this.passMark();
    return withTx(this.pool, async (c) => {
      // the regime comes from the master, and says what kind of subject it applies to
      const regime = await regimeOf(c, body.type);
      if (!regime) throw badRequest(`${body.type} is not an active regime in the inspection regime master`);
      const kind: SubjectKind = body.subjectKind ?? regime.subjectKind;
      if (kind !== regime.subjectKind) throw badRequest(`The ${regime.label} regime applies to a ${regime.subjectKind.toLowerCase().replace('_', ' ')}, not a ${kind.toLowerCase().replace('_', ' ')}`);
      const subjectId = kind === 'VESSEL' ? body.vesselId ?? body.subjectId : body.subjectId ?? body.vesselId;
      if (!subjectId) throw badRequest(kind === 'VESSEL' ? 'Name the vessel the survey is planned against' : `Name the ${kind.toLowerCase().replace('_', ' ')} the survey is planned against`);
      const subject = await findSubject(c, kind, subjectId);
      if (!subject) throw badRequest(kind === 'VESSEL' ? 'Vessel not found on the register' : `${kind.charAt(0)}${kind.slice(1).toLowerCase().replace('_', ' ')} not found on the register`);
      const vessel: Row | null = kind === 'VESSEL' ? (await c.query<Row>('SELECT * FROM vessels WHERE id = $1', [subjectId])).rows[0] ?? null : null;
      let template: TemplateRow | null = null;
      if (body.templateId) {
        const t = await c.query<TemplateRow>('SELECT * FROM checklist_templates WHERE id::text = $1', [body.templateId]);
        template = t.rows[0] ?? null;
        if (!template) throw badRequest('Checklist template not found');
      }
      let call: Row | null = null;
      if (body.portCallId) {
        if (!vessel) throw badRequest('Only a ship survey is attached to a port call');
        const pc = await c.query<Row>('SELECT * FROM port_calls WHERE id = $1', [body.portCallId]);
        call = pc.rows[0] ?? null;
        if (!call) throw badRequest('Port call not found');
        if (call.vessel_id && String(call.vessel_id) !== String(vessel.id)) throw badRequest('That port call belongs to a different vessel');
      }
      const planned = new Date(body.plannedAt);
      if (Number.isNaN(planned.getTime())) throw badRequest('Planned date is not a valid date');
      const number = await this.nextInspectionNumber(c, planned);
      const r = await c.query<InspectionRow>(
        `INSERT INTO inspections(number, vessel_id, vessel_name, vessel_imo, vessel_flag, vessel_type, port_call_id, vcn, type, template_id, template_version,
            inspector_id, inspector, planned_at, checklist, remarks, pass_score_pct, subject_kind, subject_id, subject_name)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
        [number, vessel?.id ?? null, vessel?.name ?? '', vessel?.imo ?? '', vessel?.flag ?? '', vessel?.type ?? '', call?.id ?? null, call?.vcn ?? '', regime.code,
          template?.id ?? null, template?.version ?? null, body.inspectorId ?? user?.id ?? null, body.inspector,
          planned, JSON.stringify(answersFromTemplate(template)), body.remarks ?? '', template?.pass_score_pct ?? passMark, kind, String(subject.id), subject.name]);
      let row = r.rows[0];
      await mark(c, row, 'PLANNED', new Date(), 'DESK', { regime: regime.code, subjectKind: kind });
      /* Smart Inspection at planning time: the dossier is assembled at once, so the party never boards without one, and the
       * prediction is recorded before anyone has looked — that is what makes scoring it against the findings honest. */
      const actor = { id: user.id, name: user.name, kind: 'user' as const };
      row = (await prepareDossier(c, this.env, row, 'AUTO', { actor })).row;
      await recordPrediction(c, this.env, row, { freshDays: this.env.PREDICTION_FRESH_DAYS, actor });
      await this.audit.record(c, { action: 'CREATE', entity: 'Inspection', entityId: row.id, entityLabel: row.number, after: inspectionApi(row) });
      return this.publish(c, row, EVENTS.inspection.planned, { regime: regime.code, subjectKind: kind });
    });
  }

  /** The dossier assembled again on request — after the register changed, or before a boarding the desk wants a fresh view for. */
  @RequirePerm('inspections.edit') @Post(':id/dossier')
  async refreshDossier(@Param('id') id: string, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await this.lockRow(c, id, user.scope);
      if (before.status === 'CLOSED') throw conflict('A closed inspection is read-only');
      const { row, dossier } = await prepareDossier(c, this.env, before, 'DESK', { actor: { id: user.id, name: user.name, kind: 'user' } });
      await this.audit.record(c, { action: 'DOSSIER_PREPARED', entity: 'Inspection', entityId: row.id, entityLabel: row.number, after: { preparedAt: iso(row.dossier_prepared_at), source: 'DESK', openFindings: dossier.history.openFindings.length } });
      return { inspectionId: row.id, number: row.number, preparedAt: iso(row.dossier_prepared_at), source: row.dossier_source, dossier };
    });
  }

  /** `INS-2026-014` — one atomic series per calendar year, never a count of rows. */
  private async nextInspectionNumber(c: PoolClient, planned: Date): Promise<string> {
    const year = planned.getUTCFullYear();
    const r = await c.query<{ last_value: string }>(
      'INSERT INTO numbering_series(series, last_value) VALUES ($1, 1) ON CONFLICT (series) DO UPDATE SET last_value = numbering_series.last_value + 1 RETURNING last_value',
      [`${this.env.INS_PREFIX}-${year}`]);
    return `${this.env.INS_PREFIX}-${year}-${String(r.rows[0].last_value).padStart(3, '0')}`;
  }

  @RequirePerm('inspections.edit') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(patchBody)) body: z.infer<typeof patchBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await this.lockRow(c, id, user.scope);
      if (before.status === 'CLOSED') throw conflict('A closed inspection is read-only');
      const sets: string[] = []; const args: unknown[] = [before.id];
      const set = (col: string, v: unknown) => { args.push(v); sets.push(`${col} = $${args.length}`); };
      if (body.inspector !== undefined) set('inspector', body.inspector);
      if (body.inspectorId !== undefined) set('inspector_id', body.inspectorId || null);
      if (body.plannedAt !== undefined && body.plannedAt !== null) set('planned_at', body.plannedAt);
      if (body.remarks !== undefined) set('remarks', body.remarks);
      if (body.type !== undefined) {
        const regime = await regimeOf(c, body.type);
        if (!regime) throw badRequest(`${body.type} is not an active regime in the inspection regime master`);
        if (regime.subjectKind !== (before.subject_kind || 'VESSEL')) throw badRequest(`The ${regime.label} regime applies to a ${regime.subjectKind.toLowerCase().replace('_', ' ')}; this survey is against a ${String(before.subject_kind || 'VESSEL').toLowerCase().replace('_', ' ')}`);
        set('type', regime.code);
      }
      if (body.portCallId !== undefined) {
        if (body.portCallId) {
          const pc = await c.query<Row>('SELECT * FROM port_calls WHERE id = $1', [body.portCallId]);
          if (!pc.rows[0]) throw badRequest('Port call not found');
          set('port_call_id', pc.rows[0].id); set('vcn', pc.rows[0].vcn ?? '');
        } else { set('port_call_id', null); set('vcn', ''); }
      }
      let checklist = before.checklist ?? [];
      if (body.checklist !== undefined) {
        checklist = mergeAnswers(before.checklist ?? [], body.checklist as Row[]);
        set('checklist', JSON.stringify(checklist));
        const started = this.startedNow(before, checklist);
        if (started) { set('status', started.status); set('started_at', started.started_at); }
      }
      if (!sets.length) throw badRequest('Nothing to update');
      const r = await c.query<InspectionRow>(`UPDATE inspections SET ${sets.concat('updated_at = now()').join(', ')} WHERE id = $1 RETURNING *`, args);
      const row = await this.boarded(c, before, r.rows[0], user);
      await this.audit.record(c, { action: body.checklist !== undefined ? 'CHECKLIST_SAVE' : 'UPDATE', entity: 'Inspection', entityId: row.id, entityLabel: row.number, before: inspectionApi(before), after: inspectionApi(row) });
      if (body.checklist !== undefined) {
        const live = scoreChecklist(checklist, row.pass_score_pct ?? this.env.PASS_SCORE_PCT);
        await this.publish(c, row, EVENTS.inspection.checklistScored, { scorePct: live.pct, criticalFail: live.criticalFail, answered: checklist.filter((x) => x.answer).length, questions: checklist.length });
        return inspectionApi(row, { findings: await this.findingsOf(c, row.id), detention: await this.detentionOf(c, row.id) });
      }
      return this.publish(c, row, EVENTS.inspection.updated);
    });
  }

  @RequirePerm('inspections.edit') @Post(':id/start')
  async start(@Param('id') id: string, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await this.lockRow(c, id, user.scope);
      if (before.status !== 'PLANNED') throw conflict('Only a planned inspection can be started');
      const r = await c.query<InspectionRow>(`UPDATE inspections SET status = 'IN_PROGRESS', started_at = now(), updated_at = now() WHERE id = $1 RETURNING *`, [before.id]);
      const row = await this.boarded(c, before, r.rows[0], user);
      await this.audit.record(c, { action: 'START', entity: 'Inspection', entityId: row.id, entityLabel: row.number, before: { status: before.status }, after: { status: row.status, startedAt: iso(row.started_at), dossier: !!row.dossier_prepared_at } });
      return inspectionApi(row, { findings: await this.findingsOf(c, row.id), detention: await this.detentionOf(c, row.id) });
    });
  }

  /* Closing a survey.
   *
   * The result is the inspector's, not the checklist's — the sheet only suggests. What the service does enforce is
   * that a survey cannot be closed as satisfactory while a deficiency is still open against it, and that closing
   * as detained puts a detention order on the record rather than a flag on a row. The weighted score is written
   * here from the answers as they stand, so the number a closed survey shows never moves again. */
  @RequirePerm('inspections.close') @Post(':id/close')
  async close(@Param('id') id: string, @Body(zod(closeBody)) body: z.infer<typeof closeBody>, @CurrentUser() user: Principal) {
    if (!isResult(body.result)) throw badRequest('Select a result before closing the inspection');
    return withTx(this.pool, async (c) => {
      const before = await this.lockRow(c, id, user.scope);
      if (before.status === 'CLOSED') throw conflict('Inspection is already closed');
      const findings = await this.findingsOf(c, before.id);
      const open = findings.filter((f) => f.status === 'OPEN');
      if (body.result === 'SATISFACTORY' && open.length) throw badRequest('Cannot close as satisfactory with open findings — close or reclassify them first');
      const passMark = before.pass_score_pct ?? (await this.passMark());
      const score = scoreChecklist(before.checklist ?? [], passMark);
      const detained = body.result === 'DETAINED';
      const r = await c.query<InspectionRow>(
        `UPDATE inspections SET status = 'CLOSED', result = $2, detention = $3, closed_at = now(), score_pct = $4, critical_fail = $5, pass_score_pct = $6,
           remarks = COALESCE($7, remarks), updated_at = now() WHERE id = $1 RETURNING *`,
        [before.id, body.result, detained, score.pct, score.criticalFail, passMark, body.remarks ?? null]);
      let row = r.rows[0];
      const detention = detained ? await this.orderDetention(c, row, { grounds: `Inspection ${row.number} closed as detained`, detainableCodes: open.filter((f) => f.detainable).map((f) => f.deficiencyCode) }, user) : null;
      /* Smart Inspection at close-out: the survey is classified, the rules say what they recommend, and the prediction made
       * before boarding is scored against what was found. A survey closed as detained is a restriction the closing officer
       * decided on the spot; anything short of that goes to the deciding officer as a recommendation. */
      const cls = classify(findings, score, body.result);
      row = (await c.query<InspectionRow>('UPDATE inspections SET severity = $2, recommendation = $3 WHERE id = $1 RETURNING *', [row.id, cls.severity, cls.recommendation])).rows[0];
      const actor = { id: user.id, name: user.name, kind: 'user' as const };
      await mark(c, row, 'CLOSED', row.closed_at ?? new Date(), 'DESK', { findings: findings.length, open: open.length, result: body.result, severity: cls.severity, recommendation: cls.recommendation });
      if (cls.recommendation === 'DETAIN' || cls.recommendation === 'RESTRICT') {
        await recommendRestriction(c, this.env, row, { kind: cls.recommendation === 'DETAIN' ? 'DETENTION' : 'RESTRICTION', grounds: cls.grounds, codes: cls.codes },
          { actor, decidedNow: detained ? { decision: 'APPROVED', detentionId: detention?.id ?? null, by: { id: user.id, name: user.name } } : undefined });
      }
      await scorePrediction(c, this.env, row, findings, { actor });
      await this.audit.record(c, { action: 'CLOSE', entity: 'Inspection', entityId: row.id, entityLabel: `${row.number} — ${body.result}`, before: inspectionApi(before, { findings }), after: inspectionApi(row, { findings }) });
      const entity = await this.publish(c, row, EVENTS.inspection.closed, { scorePct: score.pct, criticalFail: score.criticalFail, openFindings: open.length, result: body.result, severity: cls.severity, recommendation: cls.recommendation, findingCodes: findings.map((f) => f.deficiencyCode) });
      await publishRiskSignal(c, this.env, row.vessel_id, { subject: row.id });
      return { ...entity, ...(await this.smartOf(c, row.id)) };
    });
  }

  /* Detention.
   *
   * A detention is its own record: the grounds it was ordered on, the detainable deficiencies behind it and the
   * release that ends it. A ship stays detained until she is released explicitly, which is why closing a survey
   * as detained cannot silently clear an order already standing against her. */
  private async orderDetention(c: PoolClient, i: InspectionRow, body: { grounds: string; detainableCodes?: string[] }, user?: Principal) {
    const standing = await c.query<DetentionRow>(`SELECT * FROM detentions WHERE inspection_id = $1 AND status = 'ORDERED'`, [i.id]);
    if (standing.rows[0]) return standing.rows[0];
    const r = await c.query<DetentionRow>(
      `INSERT INTO detentions(inspection_id, vessel_id, vessel_name, ordered_by_id, ordered_by, grounds, detainable_codes) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [i.id, i.vessel_id, i.vessel_name, user?.id ?? null, user?.name ?? 'System', body.grounds, JSON.stringify(body.detainableCodes ?? [])]);
    const d = r.rows[0];
    await this.audit.record(c, { action: 'DETENTION_ORDER', entity: 'Inspection', entityId: i.id, entityLabel: `${i.number} — ${i.vessel_name}`, after: detentionApi(d) });
    return d;
  }

  @RequirePerm('inspections.close') @Post(':id/detention')
  async detain(@Param('id') id: string, @Body(zod(detainBody)) body: z.infer<typeof detainBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await this.lockRow(c, id, user.scope);
      const standing = await c.query<{ id: string }>(`SELECT id FROM detentions WHERE inspection_id = $1 AND status = 'ORDERED'`, [before.id]);
      if (standing.rowCount) throw conflict(`${before.vessel_name || 'This ship'} is already under a detention order on ${before.number}`);
      const d = await this.orderDetention(c, before, body, user);
      const r = await c.query<InspectionRow>('UPDATE inspections SET detention = true, updated_at = now() WHERE id = $1 RETURNING *', [before.id]);
      const row = r.rows[0];
      const entity = await this.publish(c, row, EVENTS.inspection.detention, { detentionId: d.id, grounds: d.grounds, detainableCodes: d.detainable_codes ?? [], orderedAt: iso(d.ordered_at), orderedBy: d.ordered_by });
      await publishRiskSignal(c, this.env, row.vessel_id, { subject: row.id });
      return { ...entity, detentionRecord: detentionApi(d) };
    });
  }

  @RequirePerm('inspections.close') @Post(':id/detention/release')
  async release(@Param('id') id: string, @Body(zod(releaseBody)) body: z.infer<typeof releaseBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const i = await this.lockRow(c, id, user.scope);
      const found = await c.query<DetentionRow>(`SELECT * FROM detentions WHERE inspection_id = $1 AND status = 'ORDERED' FOR UPDATE`, [i.id]);
      const before = found.rows[0];
      if (!before) throw notFound('No detention order is standing on this inspection');
      const open = await c.query<{ n: string }>(`SELECT count(*) AS n FROM findings f WHERE f.inspection_id = $1 AND f.status = 'OPEN' AND (f.action_code = $2 OR f.severity = 'DETAINABLE')`, [i.id, DETAINABLE_ACTION]);
      if (Number(open.rows[0].n) > 0) throw badRequest('Detainable deficiencies are still open — rectify and close them before releasing the ship');
      const r = await c.query<DetentionRow>(
        `UPDATE detentions SET status = 'RELEASED', released_at = now(), released_by_id = $2, released_by = $3, release_note = $4, updated_at = now() WHERE id = $1 RETURNING *`,
        [before.id, user?.id ?? null, user?.name ?? 'System', body.note ?? '']);
      const d = r.rows[0];
      await this.audit.record(c, { action: 'DETENTION_RELEASE', entity: 'Inspection', entityId: i.id, entityLabel: `${i.number} — ${i.vessel_name}`, before: detentionApi(before), after: detentionApi(d) });
      const entity = await this.publish(c, i, EVENTS.inspection.detentionReleased, { detentionId: d.id, releasedAt: iso(d.released_at), releasedBy: d.released_by, releaseNote: d.release_note, heldHours: detentionApi(d).heldHours });
      await publishRiskSignal(c, this.env, i.vessel_id, { subject: i.id });
      return { ...entity, detentionRecord: detentionApi(d) };
    });
  }

  @RequirePerm('inspections.delete') @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const i = await this.lockRow(c, id, user.scope);
      if (i.status !== 'PLANNED') throw badRequest('Only a planned inspection can be deleted — close it instead');
      await this.audit.record(c, { action: 'DELETE', entity: 'Inspection', entityId: i.id, entityLabel: i.number, before: inspectionApi(i, { findings: await this.findingsOf(c, i.id) }) });
      await c.query('DELETE FROM inspections WHERE id = $1', [i.id]);
      await publishInspectionDeleted(c, this.env, i);
      return { deleted: true, id: i.id };
    });
  }

  /* --------------------------------------------------------------- reports and notices --- */

  /** An officer's own report on the survey. The assistant's drafts arrive by event; this is the manual path, and the KPI counts it as such. */
  @RequirePerm('inspections.edit') @Post(':id/report')
  async writeReport(@Param('id') id: string, @Body(zod(reportBody)) body: z.infer<typeof reportBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const i = await this.lockRow(c, id, user.scope);
      const report = await draftReport(c, this.env, i, { source: 'MANUAL', title: body.title, summary: body.summary, body: body.body, by: { id: user.id, name: user.name } }, { actor: { id: user.id, name: user.name, kind: 'user' } });
      await this.audit.record(c, { action: 'REPORT_DRAFT', entity: 'Inspection', entityId: i.id, entityLabel: `${i.number} — report v${report.version}`, after: { source: 'MANUAL', version: report.version } });
      return reportApi(report);
    });
  }
  @RequirePerm('inspections.close') @Post(':id/report/:reportId/issue')
  async issueReport(@Param('id') id: string, @Param('reportId') reportId: string, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const i = await this.lockRow(c, id, user.scope);
      if (i.status !== 'CLOSED') throw conflict('The report is issued once the inspection is closed');
      const report = await issueReport(c, this.env, i, reportId, { id: user.id, name: user.name }, { actor: { id: user.id, name: user.name, kind: 'user' } });
      if (!report) throw notFound('No draft report with that id is waiting to be issued on this inspection');
      await this.audit.record(c, { action: 'REPORT_ISSUE', entity: 'Inspection', entityId: i.id, entityLabel: `${i.number} — report v${report.version}`, after: reportApi(report) });
      return reportApi(report);
    });
  }
  @RequirePerm('inspections.edit') @Post(':id/notices')
  async writeNotice(@Param('id') id: string, @Body(zod(noticeBody)) body: z.infer<typeof noticeBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const i = await this.lockRow(c, id, user.scope);
      if (body.findingIds?.length) {
        const known = await c.query<{ id: string }>('SELECT id FROM findings WHERE inspection_id = $1 AND id::text = ANY($2)', [i.id, body.findingIds]);
        if (known.rowCount !== body.findingIds.length) throw badRequest('A finding named on the notice is not on this inspection');
      }
      const notice = await draftNotice(c, this.env, i, { kind: body.kind, source: 'MANUAL', subject: body.subject, body: body.body, addressedTo: body.addressedTo, findingIds: body.findingIds, by: { id: user.id, name: user.name } }, { actor: { id: user.id, name: user.name, kind: 'user' } });
      await this.audit.record(c, { action: 'NOTICE_DRAFT', entity: 'Inspection', entityId: i.id, entityLabel: `${i.number} — ${notice.number}`, after: { kind: notice.kind, source: 'MANUAL' } });
      return noticeApi(notice);
    });
  }
  @RequirePerm('inspections.close') @Post(':id/notices/:noticeId/issue')
  async issueNotice(@Param('id') id: string, @Param('noticeId') noticeId: string, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const i = await this.lockRow(c, id, user.scope);
      const notice = await issueNotice(c, this.env, i, noticeId, { id: user.id, name: user.name }, { actor: { id: user.id, name: user.name, kind: 'user' } });
      if (!notice) throw notFound('No draft notice with that id is waiting to be issued on this inspection');
      await this.audit.record(c, { action: 'NOTICE_ISSUE', entity: 'Inspection', entityId: i.id, entityLabel: `${i.number} — ${notice.number}`, after: noticeApi(notice) });
      return noticeApi(notice);
    });
  }

  /* ---------------------------------------------------------- restriction recommendations --- */

  /** An officer's own recommendation, outside the rules — the same record, routed and decided the same way. */
  @RequirePerm('inspections.edit') @Post(':id/recommendations')
  async recommend(@Param('id') id: string, @Body(zod(recommendBody)) body: z.infer<typeof recommendBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const i = await this.lockRow(c, id, user.scope);
      const rec = await recommendRestriction(c, this.env, i, { kind: body.kind, source: 'MANUAL', grounds: body.grounds, codes: body.codes ?? [] }, { actor: { id: user.id, name: user.name, kind: 'user' } });
      await this.audit.record(c, { action: 'RESTRICTION_RECOMMEND', entity: 'Inspection', entityId: i.id, entityLabel: `${i.number} — ${rec.kind}`, after: recommendationApi(rec) });
      return recommendationApi(rec);
    });
  }
  /* The decision on a recommendation belongs to an officer who may order a detention. Approving a detention orders it;
   * anything else records the officer's answer and the time it took, which is what the programme measures. */
  @RequirePerm('inspections.close') @Post(':id/recommendations/:recId/decide')
  async decide(@Param('id') id: string, @Param('recId') recId: string, @Body(zod(decideBody)) body: z.infer<typeof decideBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const i = await this.lockRow(c, id, user.scope);
      const found = await c.query<RecommendationRow>('SELECT * FROM restriction_recommendations WHERE id::text = $1 AND inspection_id = $2 FOR UPDATE', [recId, i.id]);
      const before = found.rows[0];
      if (!before) throw notFound('Recommendation not found on this inspection');
      if (before.status !== 'PENDING' && before.status !== 'DEFERRED') throw conflict(`This recommendation was already ${before.status.toLowerCase()}`);
      let detentionId: string | null = before.detention_id;
      let row = i;
      if (body.decision === 'APPROVED' && before.kind === 'DETENTION') {
        const d = await this.orderDetention(c, i, { grounds: before.grounds, detainableCodes: before.finding_codes ?? [] }, user);
        detentionId = d.id;
        row = (await c.query<InspectionRow>('UPDATE inspections SET detention = true, updated_at = now() WHERE id = $1 RETURNING *', [i.id])).rows[0];
      }
      const now = this.now();
      const r = await c.query<RecommendationRow>(
        `UPDATE restriction_recommendations SET status = $2, decision = $2, decision_note = $3, decided_at = $4, decided_by_id = $5, decided_by = $6, detention_id = $7, routed_at = COALESCE(routed_at, $4), updated_at = now() WHERE id = $1 RETURNING *`,
        [before.id, body.decision, body.note, now, user.id, user.name, detentionId]);
      const rec = r.rows[0];
      // decided before the bus routed it: the officer plainly reached it, so the routing is stamped at the decision and the KPI sees it
      if (!before.routed_at) await mark(c, row, 'RESTRICTION_ROUTED', now, 'DESK', { recommendationId: rec.id, via: 'decision' });
      await mark(c, row, 'RESTRICTION_DECIDED', now, 'DESK', { recommendationId: rec.id, decision: rec.decision, kind: rec.kind });
      await this.audit.record(c, { action: `RESTRICTION_${body.decision}`, entity: 'Inspection', entityId: row.id, entityLabel: `${row.number} — ${rec.kind}`, before: recommendationApi(before), after: recommendationApi(rec), note: body.note });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.inspection.restrictionDecided, { recommendationId: rec.id, inspectionId: row.id, number: row.number, subjectName: row.subject_name, vesselName: row.vessel_name, kind: rec.kind, decision: rec.decision, decidedAt: now.toISOString(), decidedBy: rec.decided_by, minutesToDecide: Math.round((now.getTime() - new Date(rec.recommended_at).getTime()) / 60_000), detentionId, scope: { port: row.scope_port || undefined } }, { subject: rec.id, actor: { id: user.id, name: user.name, kind: 'user' } }));
      if (body.decision === 'APPROVED' && before.kind === 'DETENTION') {
        await this.publish(c, row, EVENTS.inspection.detention, { detentionId, grounds: before.grounds, detainableCodes: before.finding_codes ?? [], orderedAt: now.toISOString(), orderedBy: user.name, recommendationId: rec.id });
        await publishRiskSignal(c, this.env, row.vessel_id, { subject: row.id });
      }
      return recommendationApi(rec);
    });
  }

  /* ------------------------------------------------------------------------ findings --- */

  @RequirePerm('inspections.edit') @Post(':id/findings')
  async addFinding(@Param('id') id: string, @Body(zod(findingBody)) body: z.infer<typeof findingBody>, @CurrentUser() user: Principal) {
    const dueDays = await this.dueDays();
    return withTx(this.pool, async (c) => {
      const before = await this.lockRow(c, id, user.scope);
      if (before.status === 'CLOSED') throw conflict('A closed inspection is read-only');
      const master = body.deficiencyLabel ? null : await deficiencyMaster(c, body.deficiencyCode);
      const seq = await c.query<{ n: string }>('SELECT COALESCE(max(seq), 0) + 1 AS n FROM findings WHERE inspection_id = $1', [before.id]);
      const severity = body.severity ?? (body.actionCode === DETAINABLE_ACTION ? 'DETAINABLE' : 'MINOR');
      const due = body.dueDate ?? new Date(Date.now() + dueDays * 86_400_000).toISOString();
      const r = await c.query<FindingRow>(
        `INSERT INTO findings(inspection_id, seq, deficiency_code, deficiency_label, category, severity, description, action_code, due_date, status, rectification_note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [before.id, Number(seq.rows[0].n), body.deficiencyCode, body.deficiencyLabel ?? master?.label ?? '', body.category ?? master?.category ?? '', severity,
          body.description, body.actionCode ?? '', due, body.status ?? 'OPEN', body.rectificationNote ?? '']);
      const f = r.rows[0];
      const started = this.startedNow(before, before.checklist ?? []);
      const row = before.status === 'PLANNED'
        ? await this.boarded(c, before, (await c.query<InspectionRow>(`UPDATE inspections SET status = 'IN_PROGRESS', started_at = COALESCE(started_at, now()), updated_at = now() WHERE id = $1 RETURNING *`, [before.id])).rows[0], user)
        : (started ? (await c.query<InspectionRow>('UPDATE inspections SET updated_at = now() WHERE id = $1 RETURNING *', [before.id])).rows[0] : before);
      await this.audit.record(c, { action: 'FINDING_ADD', entity: 'Inspection', entityId: row.id, entityLabel: `${row.number} — ${f.deficiency_code}`, after: findingApi(f) });
      return this.publish(c, row, EVENTS.inspection.deficiency, { findingId: f.id, deficiencyCode: f.deficiency_code, deficiencyLabel: f.deficiency_label, severity: f.severity, actionCode: f.action_code, dueDate: iso(f.due_date), finding: findingApi(f) });
    });
  }

  @RequirePerm('inspections.edit') @Put(':id/findings/:findingId')
  async updateFinding(@Param('id') id: string, @Param('findingId') findingId: string, @Body(zod(findingPatch)) body: z.infer<typeof findingPatch>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const i = await this.lockRow(c, id, user.scope);
      const found = await c.query<FindingRow>('SELECT * FROM findings WHERE id::text = $1 AND inspection_id = $2 FOR UPDATE', [findingId, i.id]);
      const before = found.rows[0];
      if (!before) throw notFound('Finding not found');
      if (i.status === 'CLOSED' && body.status === undefined) throw conflict('A closed inspection is read-only — only a finding\'s rectification may still be recorded');
      const map: Record<string, string> = { deficiencyCode: 'deficiency_code', deficiencyLabel: 'deficiency_label', category: 'category', severity: 'severity', description: 'description', actionCode: 'action_code', dueDate: 'due_date', status: 'status', rectificationNote: 'rectification_note' };
      const keys = Object.keys(map).filter((k) => (body as Row)[k] !== undefined);
      if (!keys.length) throw badRequest('Nothing to update');
      const sets = keys.map((k, ix) => `${map[k]} = $${ix + 2}`);
      const args: unknown[] = [before.id, ...keys.map((k) => (body as Row)[k])];
      if (body.status === 'CLOSED') sets.push('closed_at = COALESCE(closed_at, now())');
      if (body.status === 'OPEN') sets.push('closed_at = NULL');
      const r = await c.query<FindingRow>(`UPDATE findings SET ${sets.concat('updated_at = now()').join(', ')} WHERE id = $1 RETURNING *`, args);
      const f = r.rows[0];
      await this.audit.record(c, { action: 'FINDING_UPDATE', entity: 'Inspection', entityId: i.id, entityLabel: `${i.number} — ${f.deficiency_code}`, before: findingApi(before), after: findingApi(f) });
      const event = body.status === 'CLOSED' && before.status !== 'CLOSED' ? EVENTS.inspection.deficiencyRectified : EVENTS.inspection.deficiencyUpdated;
      return this.publish(c, i, event, { findingId: f.id, deficiencyCode: f.deficiency_code, status: f.status, closedAt: iso(f.closed_at), finding: findingApi(f) });
    });
  }

  @RequirePerm('inspections.edit') @Delete(':id/findings/:findingId')
  async removeFinding(@Param('id') id: string, @Param('findingId') findingId: string, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const i = await this.lockRow(c, id, user.scope);
      if (i.status === 'CLOSED') throw conflict('A closed inspection is read-only');
      const found = await c.query<FindingRow>('SELECT * FROM findings WHERE id::text = $1 AND inspection_id = $2 FOR UPDATE', [findingId, i.id]);
      const f = found.rows[0];
      if (!f) throw notFound('Finding not found');
      await this.audit.record(c, { action: 'FINDING_DELETE', entity: 'Inspection', entityId: i.id, entityLabel: `${i.number} — ${f.deficiency_code}`, before: findingApi(f) });
      await c.query('DELETE FROM findings WHERE id = $1', [f.id]);
      return this.publish(c, i, EVENTS.inspection.deficiencyWithdrawn, { findingId: f.id, deficiencyCode: f.deficiency_code });
    });
  }
}
