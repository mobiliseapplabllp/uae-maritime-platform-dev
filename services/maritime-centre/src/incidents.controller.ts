import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, INCIDENT_CATEGORIES, INCIDENT_PRIORITIES, INCIDENT_SEVERITY, INCIDENT_SOURCES, INCIDENT_STATUS, INCIDENT_TYPES, type PageQuery } from '@maritime/contracts';
import {
  AuditClient, CurrentUser, KIT_ENV, KIT_POOL, KIT_SETTINGS, RequirePerm, SettingsClient, badRequest, conflict, escapeLike, notFound, paged, parsePage, withTx, zod,
  type Principal,
} from '@maritime/service-kit';
import type { Env } from './env';
import {
  COMM_DIRECTIONS, DOC_TYPES, LIVE_STATUS, PRIORITY_OF, TASK_STATUS, allowed, buildTimeline, incidentApi, incidentCard, incidentDashboard, incidentRowApi,
  isLive, isReopen, iso, publishIncident, publishIncidentDeleted, riskMatrix, transitionsFor,
  type CaseFile, type CommRow, type DashboardCase, type DocRow, type HistoryRow, type IncidentRow, type LogRow, type MatrixCase, type Row, type TaskRow,
} from './incidents';

/* The incident desk.
 *
 * A case moves only where the declared transition table allows, and each move writes the status history, the
 * operational log and an audit entry together, in one transaction, so the three can never tell different
 * stories. A closed case is read-only until it is reopened — the reopen is itself a transition, so it is on the
 * record like everything else. */

const blank = (v: unknown) => (v === '' || v === null ? null : v);
const text = (max: number) => z.string().trim().max(max);
const locationBody = z.object({ area: text(160).optional(), lat: z.coerce.number().min(-90).max(90).optional(), lon: z.coerce.number().min(-180).max(180).optional() });
const reportBody = z.object({
  title: text(300).min(1), category: z.enum(INCIDENT_CATEGORIES).default('MARINE'), type: z.enum(INCIDENT_TYPES),
  severity: z.enum(INCIDENT_SEVERITY).default('MEDIUM'), priority: z.enum(INCIDENT_PRIORITIES).optional(), source: z.enum(INCIDENT_SOURCES).default('PORTAL'),
  vesselId: z.preprocess(blank, z.string().trim().nullable().optional()), vesselName: text(200).optional(),
  berthId: z.preprocess(blank, z.string().trim().nullable().optional()), location: locationBody.optional(),
  reportedAt: z.preprocess(blank, z.string().nullable().optional()), reportedBy: text(160).optional(), description: text(4000).default(''),
  assignedToId: text(80).optional(), assignedTo: text(160).optional(),
  assets: z.array(text(120)).optional(), injuries: z.coerce.number().int().min(0).max(999).optional(), pollutionTier: z.coerce.number().int().min(0).max(3).optional(),
  weather: z.object({ windKn: z.coerce.number().optional(), seaState: z.coerce.number().optional() }).partial().optional(),
});
const patchBody = reportBody.partial().extend({
  rca: z.object({ rootCause: text(1000).optional(), category: text(120).optional(), correctiveAction: text(2000).optional(), preventiveAction: text(2000).optional() }).partial().optional(),
  outcome: text(2000).optional(),
});
const transitionBody = z.object({ to: z.enum(INCIDENT_STATUS), note: text(2000).default('') });
const assignBody = z.object({ assignedToId: z.preprocess(blank, z.string().trim().nullable().optional()), assignedTo: text(160).min(1), note: text(1000).default('') });
const closeBody = z.object({ note: text(2000).default(''), outcome: text(2000).optional() });
const commBody = z.object({ channel: z.enum(INCIDENT_SOURCES).default('PORTAL'), direction: z.enum(COMM_DIRECTIONS).default('INTERNAL'), message: text(4000).min(1), at: z.preprocess(blank, z.string().nullable().optional()) });
const taskBody = z.object({ title: text(300).min(1), assignee: text(160).default(''), assigneeId: text(80).optional(), due: z.preprocess(blank, z.string().nullable().optional()) });
const taskPatch = z.object({ status: z.enum(TASK_STATUS).optional(), title: text(300).optional(), assignee: text(160).optional(), assigneeId: text(80).optional(), due: z.preprocess(blank, z.string().nullable().optional()) });
const docBody = z.object({ name: text(300).min(1), docType: z.enum(DOC_TYPES).default('OTHER'), sizeKB: z.coerce.number().int().min(0).max(50_000_000).default(0), note: text(1000).default(''), documentId: text(80).optional() });
const logBody = z.object({ entry: text(4000).min(1) });
const resolutionBody = z.object({
  rootCause: text(1000).default(''), category: text(120).default(''), correctiveAction: text(2000).default(''), preventiveAction: text(2000).default(''), outcome: text(2000).optional(),
});

const SORT: Record<string, string> = {
  number: 'number', reportedAt: 'reported_at', severity: 'severity', priority: 'priority', status: 'status', category: 'category', type: 'type',
  title: 'title', vesselName: 'vessel_name', assignedTo: 'assigned_to', closedAt: 'closed_at', updatedAt: 'updated_at',
};
type ListQuery = PageQuery & {
  category?: string; type?: string; severity?: string; priority?: string; status?: string; source?: string;
  vessel?: string; vesselId?: string; assignee?: string; assignedToId?: string; open?: string; from?: string; to?: string; berth?: string;
};

@Controller('incidents')
export class IncidentsController {
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    @Inject(KIT_SETTINGS) private readonly settings: SettingsClient,
    private readonly audit: AuditClient,
  ) {}

  private now() { return new Date(); }
  private async sla() {
    const s = await this.settings.moduleGet('incidents', { mttaTargetMin: this.env.MTTA_TARGET_MIN, mttrTargetHrs: this.env.MTTR_TARGET_HRS });
    return { mttaTargetMin: Number(s.mttaTargetMin) || this.env.MTTA_TARGET_MIN, mttrTargetHrs: Number(s.mttrTargetHrs) || this.env.MTTR_TARGET_HRS };
  }
  private async load(c: Pool | PoolClient, id: string): Promise<IncidentRow> {
    const r = await c.query<IncidentRow>('SELECT * FROM incidents WHERE id::text = $1 OR number = $1', [id]);
    if (!r.rows[0]) throw notFound('Incident not found');
    return r.rows[0];
  }
  private async lockRow(c: PoolClient, id: string): Promise<IncidentRow> {
    const r = await c.query<IncidentRow>('SELECT * FROM incidents WHERE id::text = $1 OR number = $1 FOR UPDATE', [id]);
    if (!r.rows[0]) throw notFound('Incident not found');
    return r.rows[0];
  }
  /* Read sequentially, never in parallel: inside a transaction this runs on one client, and a single client
   * cannot have two statements in flight. */
  private async caseFile(c: Pool | PoolClient, id: string): Promise<CaseFile> {
    const comms = await c.query<CommRow>('SELECT * FROM incident_comms WHERE incident_id = $1 ORDER BY at', [id]);
    const tasks = await c.query<TaskRow>('SELECT * FROM incident_tasks WHERE incident_id = $1 ORDER BY created_at', [id]);
    const documents = await c.query<DocRow>('SELECT * FROM incident_documents WHERE incident_id = $1 ORDER BY at', [id]);
    const log = await c.query<LogRow>('SELECT * FROM incident_log WHERE incident_id = $1 ORDER BY at', [id]);
    const history = await c.query<HistoryRow>('SELECT * FROM incident_status_history WHERE incident_id = $1 ORDER BY at', [id]);
    return { comms: comms.rows, tasks: tasks.rows, documents: documents.rows, log: log.rows, history: history.rows };
  }
  private async publish(c: PoolClient, i: IncidentRow, event: string, data: Row = {}) {
    return publishIncident(c, this.env, i, await this.caseFile(c, i.id), { event, data });
  }
  private async note(c: PoolClient, id: string, user: Principal | undefined, entry: string, at?: Date) {
    await c.query('INSERT INTO incident_log(incident_id, at, by_id, by_name, entry) VALUES ($1, COALESCE($2, now()), $3, $4, $5)', [id, at ?? null, user?.id ?? null, user?.name ?? 'System', entry]);
  }
  /** A case file is evidence: once resolved or closed nothing new is added to it until it is reopened. */
  private requireLive(i: IncidentRow, what: string) {
    if (!isLive(i.status)) throw conflict(`${i.number} is ${i.status.toLowerCase()} — reopen the case before ${what}`);
  }

  /** The incident register: filterable, searchable, paged, without the threads that hang off each case. */
  @RequirePerm('incidents.view') @Get()
  async list(@Query() query: ListQuery) {
    const p = parsePage(query, { defaultSort: '-reportedAt', sortable: Object.keys(SORT), maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    const eq = (col: string, v: string | undefined) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
    eq('category', query.category); eq('type', query.type); eq('severity', query.severity); eq('priority', query.priority); eq('source', query.source);
    eq('status', query.status); eq('berth_id', query.berth);
    const vessel = query.vessel || query.vesselId;
    if (vessel) { args.push(vessel); where.push(`vessel_id::text = $${args.length}`); }
    const assignee = query.assignee || query.assignedToId;
    if (assignee) { args.push(assignee, `%${escapeLike(assignee)}%`); where.push(`(assigned_to_id = $${args.length - 1} OR assigned_to ILIKE $${args.length})`); }
    if (String(query.open) === 'true') { args.push(LIVE_STATUS); where.push(`status = ANY($${args.length})`); }
    if (query.from) { args.push(query.from); where.push(`reported_at >= $${args.length}`); }
    if (query.to) { args.push(query.to); where.push(`reported_at <= $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(number ILIKE $${args.length} OR title ILIKE $${args.length} OR vessel_name ILIKE $${args.length} OR reported_by ILIKE $${args.length} OR description ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM incidents ${w}`, args);
    const rows = await this.pool.query<IncidentRow>(`SELECT * FROM incidents ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, number DESC LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(incidentRowApi), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  /** The desk's landing analytics. Declared before `:id` so the word is not read as an id. */
  @RequirePerm('incidents.view', 'dashboard.view') @Get('dashboard')
  async dashboard() {
    const now = this.now();
    const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
    const cols = 'id, number, title, category, type, severity, priority, status, reported_at, acknowledged_at, resolved_at, closed_at, assigned_to, injuries';
    const [windowed, everOpen, sla] = await Promise.all([
      this.pool.query<DashboardCase>(`SELECT ${cols} FROM incidents WHERE reported_at >= $1`, [from]),
      this.pool.query<DashboardCase>(`SELECT ${cols} FROM incidents WHERE status = ANY($1) ORDER BY reported_at`, [LIVE_STATUS]),
      this.sla(),
    ]);
    return incidentDashboard(windowed.rows, everOpen.rows, sla, now);
  }

  /** The 5×5 likelihood × consequence heatmap, initial next to residual. */
  @RequirePerm('incidents.view') @Get('risk-matrix')
  async matrix(@Query('days') daysQ?: string) {
    const days = Math.min(1095, Math.max(7, Number.parseInt(String(daysQ ?? 180), 10) || 180));
    const since = new Date(Date.now() - days * 86_400_000);
    const rows = await this.pool.query<MatrixCase>('SELECT id, number, title, severity, priority, status FROM incidents WHERE reported_at >= $1 ORDER BY reported_at DESC', [since]);
    return riskMatrix(rows.rows, days);
  }

  /** The full case file: facts, communications, tasks, documents, the log and the status trail. */
  @RequirePerm('incidents.view') @Get(':id')
  async get(@Param('id') id: string) {
    const i = await this.load(this.pool, id);
    const file = await this.caseFile(this.pool, i.id);
    return { ...incidentApi(i, file), timeline: buildTimeline(file) };
  }

  /** The merged timeline on its own — status changes, log entries and attachments, newest first. */
  @RequirePerm('incidents.view') @Get(':id/timeline')
  async timeline(@Param('id') id: string) {
    const i = await this.load(this.pool, id);
    const file = await this.caseFile(this.pool, i.id);
    return { incidentId: i.id, number: i.number, entries: buildTimeline(file), statusHistory: incidentApi(i, file).statusHistory };
  }

  /** The resolution record: how the case ended and what was done about it. */
  @RequirePerm('incidents.view') @Get(':id/resolution')
  async resolution(@Param('id') id: string) {
    const i = await this.load(this.pool, id);
    return { incidentId: i.id, number: i.number, status: i.status, ...incidentApi(i).resolution };
  }

  @RequirePerm('incidents.view') @Get(':id/card')
  async card(@Param('id') id: string) {
    const i = await this.load(this.pool, id);
    const open = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM incident_tasks WHERE incident_id = $1 AND status = 'OPEN'`, [i.id]);
    return incidentCard(i, Number(open.rows[0].n));
  }

  @RequirePerm('incidents.create') @Post()
  async create(@Body(zod(reportBody)) body: z.infer<typeof reportBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      let vessel: Row | null = null;
      if (body.vesselId) {
        const v = await c.query<Row>('SELECT * FROM vessels WHERE id = $1', [body.vesselId]);
        vessel = v.rows[0] ?? null;
        if (!vessel) throw badRequest('Vessel not found on the register');
      }
      let berth: Row | null = null;
      if (body.berthId) {
        const b = await c.query<Row>('SELECT * FROM berths WHERE id = $1 OR code = $1', [body.berthId]);
        berth = b.rows[0] ?? null;
        if (!berth) throw badRequest('Berth not found');
      }
      const reportedAt = body.reportedAt ? new Date(body.reportedAt) : this.now();
      if (Number.isNaN(reportedAt.getTime())) throw badRequest('Reported date is not a valid date');
      const number = await this.nextCaseNumber(c, reportedAt);
      const location = { area: body.location?.area ?? berth?.code ?? '', ...(body.location?.lat != null ? { lat: body.location.lat, lon: body.location.lon } : {}) };
      const r = await c.query<IncidentRow>(
        `INSERT INTO incidents(number, category, type, severity, priority, status, title, description, vessel_id, vessel_name, berth_id, berth_code, berth_terminal,
           location, reported_at, reported_by, source, assigned_to_id, assigned_to, assets, injuries, pollution_tier, weather)
         VALUES ($1,$2,$3,$4,$5,'OPEN',$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
        [number, body.category, body.type, body.severity, body.priority ?? PRIORITY_OF[body.severity] ?? 'P3', body.title, body.description ?? '',
          vessel?.id ?? null, body.vesselName ?? vessel?.name ?? '', berth?.id ?? null, berth?.code ?? '', berth?.terminal ?? '',
          JSON.stringify(location), reportedAt, body.reportedBy ?? user?.name ?? 'Marine control room', body.source,
          body.assignedToId ?? user?.id ?? null, body.assignedTo ?? user?.name ?? '', JSON.stringify(body.assets ?? []),
          body.injuries ?? 0, body.pollutionTier ?? 0, JSON.stringify(body.weather ?? {})]);
      const row = r.rows[0];
      await c.query('INSERT INTO incident_status_history(incident_id, from_status, to_status, at, by_id, by_name, note) VALUES ($1, $2, $3, $4, $5, $6, $7)',
        [row.id, '', 'OPEN', reportedAt, user?.id ?? null, user?.name ?? 'Marine control room', 'Incident logged']);
      await this.note(c, row.id, user, 'Incident logged in the portal; duty officer paged', reportedAt);
      await this.audit.record(c, { action: 'CREATE', entity: 'Incident', entityId: row.id, entityLabel: row.number, after: incidentApi(row) });
      return this.publish(c, row, EVENTS.maritimeCentre.incidentOpened);
    });
  }

  /** `INC-2026-0087` — one atomic series per calendar year, never a count of rows. */
  private async nextCaseNumber(c: PoolClient, reportedAt: Date): Promise<string> {
    const year = reportedAt.getUTCFullYear();
    const r = await c.query<{ last_value: string }>(
      'INSERT INTO numbering_series(series, last_value) VALUES ($1, 1) ON CONFLICT (series) DO UPDATE SET last_value = numbering_series.last_value + 1 RETURNING last_value',
      [`${this.env.INC_PREFIX}-${year}`]);
    return `${this.env.INC_PREFIX}-${year}-${String(r.rows[0].last_value).padStart(4, '0')}`;
  }

  @RequirePerm('incidents.manage') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(patchBody)) body: z.infer<typeof patchBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await this.lockRow(c, id);
      if (before.status === 'CLOSED') throw conflict('A closed incident is read-only — reopen it first');
      const sets: string[] = []; const args: unknown[] = [before.id];
      const set = (col: string, v: unknown) => { args.push(v); sets.push(`${col} = $${args.length}`); };
      for (const [key, col] of [['title', 'title'], ['description', 'description'], ['category', 'category'], ['type', 'type'], ['source', 'source'], ['reportedBy', 'reported_by'], ['outcome', 'outcome']] as const) {
        if ((body as Row)[key] !== undefined) set(col, (body as Row)[key]);
      }
      if (body.severity !== undefined) { set('severity', body.severity); if (body.priority === undefined) set('priority', PRIORITY_OF[body.severity] ?? before.priority); }
      if (body.priority !== undefined) set('priority', body.priority);
      if (body.injuries !== undefined) set('injuries', body.injuries);
      if (body.pollutionTier !== undefined) set('pollution_tier', body.pollutionTier);
      if (body.assets !== undefined) set('assets', JSON.stringify(body.assets));
      if (body.weather !== undefined) set('weather', JSON.stringify({ ...(before.weather ?? {}), ...body.weather }));
      if (body.rca !== undefined) set('rca', JSON.stringify({ ...(before.rca ?? {}), ...body.rca }));
      if (body.location !== undefined) set('location', JSON.stringify({ ...(before.location ?? {}), ...body.location }));
      if (body.vesselName !== undefined) set('vessel_name', body.vesselName);
      if (body.vesselId !== undefined) {
        if (body.vesselId) {
          const v = await c.query<Row>('SELECT * FROM vessels WHERE id = $1', [body.vesselId]);
          if (!v.rows[0]) throw badRequest('Vessel not found on the register');
          set('vessel_id', v.rows[0].id); if (body.vesselName === undefined) set('vessel_name', v.rows[0].name);
        } else set('vessel_id', null);
      }
      if (body.berthId !== undefined) {
        if (body.berthId) {
          const b = await c.query<Row>('SELECT * FROM berths WHERE id = $1 OR code = $1', [body.berthId]);
          if (!b.rows[0]) throw badRequest('Berth not found');
          set('berth_id', b.rows[0].id); set('berth_code', b.rows[0].code); set('berth_terminal', b.rows[0].terminal ?? '');
        } else { set('berth_id', null); set('berth_code', ''); set('berth_terminal', ''); }
      }
      if (!sets.length) throw badRequest('Nothing to update');
      const r = await c.query<IncidentRow>(`UPDATE incidents SET ${sets.concat('updated_at = now()').join(', ')} WHERE id = $1 RETURNING *`, args);
      const row = r.rows[0];
      if (body.rca !== undefined) await this.note(c, row.id, user, 'Root cause record updated');
      await this.audit.record(c, { action: 'UPDATE', entity: 'Incident', entityId: row.id, entityLabel: row.number, before: incidentApi(before), after: incidentApi(row) });
      return this.publish(c, row, EVENTS.maritimeCentre.incidentUpdated);
    });
  }

  /* Transitions.
   *
   * The table in the contracts package is the only thing that decides where a case may go next; the desk cannot
   * talk it into a shortcut. Resolving demands a summary, because a resolution with nothing written against it
   * is not a resolution. Reopening clears the resolution stamps so the clock runs again from the response. */
  @RequirePerm('incidents.manage') @Post(':id/transition')
  async transition(@Param('id') id: string, @Body(zod(transitionBody)) body: z.infer<typeof transitionBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await this.lockRow(c, id);
      const from = before.status;
      if (!allowed(from, body.to)) {
        const next = transitionsFor(from);
        throw conflict(`Cannot move ${before.number} from ${from} to ${body.to}. Allowed: ${next.join(', ') || 'none'}`);
      }
      if (body.to === 'RESOLVED' && !body.note && !before.outcome) throw badRequest('A resolution summary is required');
      const reopen = isReopen(from, body.to);
      const sets = ['status = $2']; const args: unknown[] = [before.id, body.to];
      if (body.to === 'ACKNOWLEDGED') sets.push('acknowledged_at = COALESCE(acknowledged_at, now())');
      if (body.to === 'RESPONDING' && !reopen) sets.push('responding_at = COALESCE(responding_at, now())');
      if (body.to === 'RESOLVED') { sets.push('resolved_at = now()'); if (body.note) { args.push(body.note); sets.push(`outcome = $${args.length}`); } }
      if (body.to === 'CLOSED') sets.push('closed_at = now()');
      if (reopen) sets.push('resolved_at = NULL', 'closed_at = NULL');
      const r = await c.query<IncidentRow>(`UPDATE incidents SET ${sets.concat('updated_at = now()').join(', ')} WHERE id = $1 RETURNING *`, args);
      const row = r.rows[0];
      await c.query('INSERT INTO incident_status_history(incident_id, from_status, to_status, by_id, by_name, note) VALUES ($1,$2,$3,$4,$5,$6)',
        [row.id, from, body.to, user?.id ?? null, user?.name ?? 'System', body.note ?? '']);
      await this.note(c, row.id, user, `Status ${from} → ${body.to}${body.note ? `: ${body.note}` : ''}`);
      await this.audit.record(c, { action: reopen ? 'REOPEN' : 'TRANSITION', entity: 'Incident', entityId: row.id, entityLabel: `${row.number}: ${from} -> ${body.to}`, before: { status: from }, after: { status: body.to, note: body.note ?? '' } });
      const event = body.to === 'RESOLVED' ? EVENTS.maritimeCentre.incidentResolved : body.to === 'CLOSED' ? EVENTS.maritimeCentre.incidentClosed : EVENTS.maritimeCentre.incidentTransitioned;
      return this.publish(c, row, event, { from, to: body.to, note: body.note ?? '', reopened: reopen });
    });
  }

  /** Closing is the last transition, spelled as its own endpoint because that is how the desk thinks about it. */
  @RequirePerm('incidents.close', 'incidents.manage') @Post(':id/close')
  async close(@Param('id') id: string, @Body(zod(closeBody)) body: z.infer<typeof closeBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await this.lockRow(c, id);
      if (before.status === 'CLOSED') throw conflict(`${before.number} is already closed`);
      if (!allowed(before.status, 'CLOSED')) throw conflict(`${before.number} must be resolved before it can be closed — it is ${before.status.toLowerCase()}`);
      const open = await c.query<{ n: string }>(`SELECT count(*) AS n FROM incident_tasks WHERE incident_id = $1 AND status = 'OPEN'`, [before.id]);
      if (Number(open.rows[0].n) > 0) throw badRequest(`${open.rows[0].n} response task(s) are still open — complete them before closing the case`);
      const r = await c.query<IncidentRow>(
        `UPDATE incidents SET status = 'CLOSED', closed_at = now(), outcome = COALESCE($2, outcome), updated_at = now() WHERE id = $1 RETURNING *`,
        [before.id, body.outcome ?? null]);
      const row = r.rows[0];
      await c.query('INSERT INTO incident_status_history(incident_id, from_status, to_status, by_id, by_name, note) VALUES ($1,$2,$3,$4,$5,$6)',
        [row.id, before.status, 'CLOSED', user?.id ?? null, user?.name ?? 'System', body.note ?? 'Case closed']);
      await this.note(c, row.id, user, `Status ${before.status} → CLOSED${body.note ? `: ${body.note}` : ''}`);
      await this.audit.record(c, { action: 'CLOSE', entity: 'Incident', entityId: row.id, entityLabel: row.number, before: { status: before.status }, after: { status: 'CLOSED', outcome: row.outcome } });
      return this.publish(c, row, EVENTS.maritimeCentre.incidentClosed, { from: before.status, to: 'CLOSED', note: body.note ?? '' });
    });
  }

  @RequirePerm('incidents.manage') @Post(':id/assign')
  async assign(@Param('id') id: string, @Body(zod(assignBody)) body: z.infer<typeof assignBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await this.lockRow(c, id);
      this.requireLive(before, 'reassigning it');
      const r = await c.query<IncidentRow>('UPDATE incidents SET assigned_to_id = $2, assigned_to = $3, updated_at = now() WHERE id = $1 RETURNING *', [before.id, body.assignedToId ?? null, body.assignedTo]);
      const row = r.rows[0];
      await this.note(c, row.id, user, `Case reassigned to ${body.assignedTo}${body.note ? `: ${body.note}` : ''}`);
      await this.audit.record(c, { action: 'ASSIGN', entity: 'Incident', entityId: row.id, entityLabel: row.number, before: { assignedTo: before.assigned_to, assignedToId: before.assigned_to_id }, after: { assignedTo: row.assigned_to, assignedToId: row.assigned_to_id } });
      return this.publish(c, row, EVENTS.maritimeCentre.incidentAssigned, { previousAssignee: before.assigned_to, note: body.note ?? '' });
    });
  }

  @RequirePerm('incidents.manage') @Delete(':id')
  async remove(@Param('id') id: string) {
    return withTx(this.pool, async (c) => {
      const i = await this.lockRow(c, id);
      if (i.status !== 'OPEN') throw badRequest('Only an OPEN case logged in error can be deleted — close it instead');
      await this.audit.record(c, { action: 'DELETE', entity: 'Incident', entityId: i.id, entityLabel: i.number, before: incidentApi(i, await this.caseFile(c, i.id)) });
      await c.query('DELETE FROM incidents WHERE id = $1', [i.id]);
      await publishIncidentDeleted(c, this.env, i);
      return { deleted: true, id: i.id };
    });
  }

  /* ----------------------------------------------------------------- the case threads --- */

  @RequirePerm('incidents.manage') @Post(':id/comms')
  async addComm(@Param('id') id: string, @Body(zod(commBody)) body: z.infer<typeof commBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const i = await this.lockRow(c, id);
      const r = await c.query<CommRow>('INSERT INTO incident_comms(incident_id, at, by_id, by_name, channel, direction, message) VALUES ($1, COALESCE($2, now()), $3, $4, $5, $6, $7) RETURNING *',
        [i.id, body.at ?? null, user?.id ?? null, user?.name ?? 'System', body.channel, body.direction, body.message]);
      await this.audit.record(c, { action: 'COMM_ADD', entity: 'Incident', entityId: i.id, entityLabel: i.number, after: { channel: body.channel, direction: body.direction, message: body.message } });
      return this.publish(c, i, EVENTS.maritimeCentre.incidentCommLogged, { commId: r.rows[0].id, channel: body.channel, direction: body.direction });
    });
  }

  @RequirePerm('incidents.manage') @Post(':id/log')
  async addLog(@Param('id') id: string, @Body(zod(logBody)) body: z.infer<typeof logBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const i = await this.lockRow(c, id);
      this.requireLive(i, 'adding to the log');
      await this.note(c, i.id, user, body.entry);
      await this.audit.record(c, { action: 'LOG_ADD', entity: 'Incident', entityId: i.id, entityLabel: i.number, after: { entry: body.entry } });
      return this.publish(c, i, EVENTS.maritimeCentre.incidentNoted, { entry: body.entry });
    });
  }

  @RequirePerm('incidents.manage') @Post(':id/tasks')
  async addTask(@Param('id') id: string, @Body(zod(taskBody)) body: z.infer<typeof taskBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const i = await this.lockRow(c, id);
      this.requireLive(i, 'raising a task on it');
      const r = await c.query<TaskRow>('INSERT INTO incident_tasks(incident_id, title, assignee_id, assignee, due) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [i.id, body.title, body.assigneeId ?? null, body.assignee ?? '', body.due ?? null]);
      const t = r.rows[0];
      await this.note(c, i.id, user, `Response task raised: ${t.title}${t.assignee ? ` — ${t.assignee}` : ''}`);
      await this.audit.record(c, { action: 'TASK_ADD', entity: 'Incident', entityId: i.id, entityLabel: `${i.number} · ${t.title}`, after: { title: t.title, assignee: t.assignee, due: iso(t.due) } });
      return this.publish(c, i, EVENTS.maritimeCentre.incidentTaskAdded, { taskId: t.id, title: t.title, assignee: t.assignee, due: iso(t.due) });
    });
  }

  @RequirePerm('incidents.manage') @Put(':id/tasks/:taskId')
  async setTask(@Param('id') id: string, @Param('taskId') taskId: string, @Body(zod(taskPatch)) body: z.infer<typeof taskPatch>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const i = await this.lockRow(c, id);
      const found = await c.query<TaskRow>('SELECT * FROM incident_tasks WHERE id::text = $1 AND incident_id = $2 FOR UPDATE', [taskId, i.id]);
      const before = found.rows[0];
      if (!before) throw notFound('Task not found');
      const map: Record<string, string> = { title: 'title', assignee: 'assignee', assigneeId: 'assignee_id', due: 'due', status: 'status' };
      const keys = Object.keys(map).filter((k) => (body as Row)[k] !== undefined);
      if (!keys.length) throw badRequest('Nothing to update');
      const sets = keys.map((k, ix) => `${map[k]} = $${ix + 2}`);
      if (body.status === 'DONE') sets.push('done_at = COALESCE(done_at, now())');
      if (body.status === 'OPEN') sets.push('done_at = NULL');
      const r = await c.query<TaskRow>(`UPDATE incident_tasks SET ${sets.concat('updated_at = now()').join(', ')} WHERE id = $1 RETURNING *`, [before.id, ...keys.map((k) => (body as Row)[k])]);
      const t = r.rows[0];
      if (body.status && body.status !== before.status) await this.note(c, i.id, user, `Response task ${body.status === 'DONE' ? 'completed' : 'reopened'}: ${t.title}`);
      await this.audit.record(c, { action: 'TASK_UPDATE', entity: 'Incident', entityId: i.id, entityLabel: `${i.number} · ${t.title}`, before: { status: before.status, assignee: before.assignee }, after: { status: t.status, assignee: t.assignee } });
      return this.publish(c, i, EVENTS.maritimeCentre.incidentTaskUpdated, { taskId: t.id, title: t.title, status: t.status, doneAt: iso(t.done_at) });
    });
  }

  @RequirePerm('incidents.manage') @Post(':id/documents')
  async addDocument(@Param('id') id: string, @Body(zod(docBody)) body: z.infer<typeof docBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const i = await this.lockRow(c, id);
      this.requireLive(i, 'attaching a document');
      const r = await c.query<DocRow>('INSERT INTO incident_documents(incident_id, name, doc_type, size_kb, uploaded_by_id, uploaded_by, note, document_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [i.id, body.name, body.docType, body.sizeKB, user?.id ?? null, user?.name ?? 'System', body.note ?? '', body.documentId ?? null]);
      const d = r.rows[0];
      await this.audit.record(c, { action: 'DOC_ADD', entity: 'Incident', entityId: i.id, entityLabel: `${i.number} · ${d.name}`, after: { name: d.name, docType: d.doc_type, sizeKB: d.size_kb } });
      return this.publish(c, i, EVENTS.maritimeCentre.incidentDocumentAdded, { documentId: d.id, name: d.name, docType: d.doc_type, sizeKB: d.size_kb });
    });
  }

  /** The resolution record, written as one thing rather than four fields on a patch. */
  @RequirePerm('incidents.manage') @Put(':id/resolution')
  async setResolution(@Param('id') id: string, @Body(zod(resolutionBody)) body: z.infer<typeof resolutionBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await this.lockRow(c, id);
      if (before.status === 'CLOSED') throw conflict('A closed incident is read-only — reopen it first');
      const rca = { rootCause: body.rootCause, category: body.category, correctiveAction: body.correctiveAction, preventiveAction: body.preventiveAction };
      const r = await c.query<IncidentRow>('UPDATE incidents SET rca = $2, outcome = COALESCE($3, outcome), updated_at = now() WHERE id = $1 RETURNING *', [before.id, JSON.stringify(rca), body.outcome ?? null]);
      const row = r.rows[0];
      await this.note(c, row.id, user, `Root cause recorded: ${body.rootCause || 'no root cause stated'}`);
      await this.audit.record(c, { action: 'RCA_RECORD', entity: 'Incident', entityId: row.id, entityLabel: row.number, before: { rca: before.rca, outcome: before.outcome }, after: { rca, outcome: row.outcome } });
      return this.publish(c, row, EVENTS.maritimeCentre.incidentUpdated, { rca, outcome: row.outcome });
    });
  }
}
