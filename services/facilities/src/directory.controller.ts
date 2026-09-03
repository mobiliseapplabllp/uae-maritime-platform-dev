import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Pool } from 'pg';
import { type PageQuery } from '@maritime/contracts';
import { KIT_ENV, KIT_POOL, RequirePerm, escapeLike, paged, parsePage } from '@maritime/service-kit';
import type { Env } from './env';
import {
  AUDIT_RESULTS, COMPANY_CATEGORIES, COMPANY_STATUS, COMPANY_STATUS_TRANSITIONS, FACILITY_STATUS, FACILITY_TYPES, ISPS_STATUS,
  OBLIGATION_KINDS, OBLIGATION_STATUS, SUBJECT_KINDS, auditApi, directoryDashboard, obligationApi,
  type AuditRow, type ObligationRow, type Row,
} from './directory';
import { renewalWorkList } from './compliance';

/* The desk's own views across the register: what the directory looks like as a whole, what work is
 * coming up, and the two cross-subject lists — every audit and every outstanding obligation — that a
 * compliance officer works from rather than opening one company at a time. */

@Controller('facilities')
export class DirectoryController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env) {}

  /** The directory dashboard: who is on the register, in what standing, and what is coming up. */
  @RequirePerm('facilities.view', 'dashboard.view') @Get('dashboard')
  async dashboard() {
    const [companies, facilities, instruments, audits] = await Promise.all([
      this.pool.query<Row>(`SELECT c.status, c.category, c.rating,
          (SELECT count(*) FROM obligations o WHERE o.subject_kind = 'COMPANY' AND o.subject_id = c.id AND o.status = 'OPEN') AS open_obligations
        FROM companies c`),
      this.pool.query<Row>('SELECT isps_status, status, facility_type FROM port_facilities'),
      this.pool.query<Row>('SELECT status, expiry_date, subject_kind FROM instruments'),
      this.pool.query<Row>('SELECT audited_on, result FROM audits'),
    ]);
    const dash = directoryDashboard({
      companies: companies.rows.map((c) => ({ status: c.status, category: c.category, rating: Number(c.rating), openObligations: Number(c.open_obligations) })),
      facilities: facilities.rows.map((f) => ({ ispsStatus: f.isps_status, status: f.status, facilityType: f.facility_type })),
      instruments: instruments.rows.map((i) => ({ status: i.status, expiryDate: i.expiry_date ? new Date(i.expiry_date).toISOString() : null, subjectKind: i.subject_kind })),
      audits: audits.rows.map((a) => ({ date: new Date(a.audited_on).toISOString(), result: a.result })),
    }, new Date(), this.env.RENEWAL_WINDOW_DAYS);
    const worst = await this.pool.query<Row>(
      `SELECT id, code, name, category, status, rating FROM companies WHERE rating > 0 ORDER BY rating LIMIT 5`);
    return {
      ...dash,
      watchlist: worst.rows.map((c) => ({ id: c.id, code: c.code, name: c.name, category: c.category, status: c.status, rating: Number(c.rating) })),
      renewals: (await renewalWorkList(this.pool, this.env.RENEWAL_WINDOW_DAYS)).slice(0, 10),
      generatedAt: new Date().toISOString(),
    };
  }

  /** The vocabularies the directory screens are built from, and the standing transitions it enforces. */
  @RequirePerm('facilities.view') @Get('meta')
  async meta() {
    const types = await this.pool.query<{ type: string; n: string }>('SELECT jsonb_array_elements_text(types) AS type, count(*) AS n FROM companies GROUP BY 1 ORDER BY count(*) DESC, 1');
    const terminals = await this.pool.query<{ terminal: string; n: string }>("SELECT terminal, count(*) AS n FROM port_facilities WHERE terminal <> '' GROUP BY 1 ORDER BY 1");
    return {
      categories: [...COMPANY_CATEGORIES], statuses: [...COMPANY_STATUS], statusTransitions: COMPANY_STATUS_TRANSITIONS,
      auditResults: [...AUDIT_RESULTS], subjectKinds: [...SUBJECT_KINDS],
      facilityTypes: [...FACILITY_TYPES], facilityStatuses: [...FACILITY_STATUS], ispsStatuses: [...ISPS_STATUS],
      obligationKinds: [...OBLIGATION_KINDS], obligationStatuses: [...OBLIGATION_STATUS],
      licensedTypes: types.rows.map((r) => ({ type: r.type, count: Number(r.n) })),
      terminals: terminals.rows.map((r) => ({ terminal: r.terminal, count: Number(r.n) })),
      renewalWindowDays: this.env.RENEWAL_WINDOW_DAYS,
    };
  }

  /* The renewal work list, built from the expiry dates on the local snapshot of the instrument register.
   * Nothing is asked of the instruments service to produce it. */
  @RequirePerm('facilities.view') @Get('renewals')
  async renewals(@Query() query: { window?: string; subjectKind?: string; overdue?: string }) {
    const rows = await renewalWorkList(this.pool, Number(query.window) || this.env.RENEWAL_WINDOW_DAYS, {
      subjectKind: query.subjectKind, overdue: query.overdue === 'true',
    });
    return paged(rows, { total: rows.length, page: 1, limit: rows.length, overdue: rows.filter((r) => r.overdue).length, windowDays: Number(query.window) || this.env.RENEWAL_WINDOW_DAYS });
  }

  @RequirePerm('facilities.view') @Get('obligations')
  async obligations(@Query() query: PageQuery & { status?: string; kind?: string; subjectKind?: string; overdue?: string }) {
    const p = parsePage(query, { defaultSort: 'dueAt', sortable: ['dueAt', 'raisedAt', 'subjectName', 'kind', 'status'], maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    const add = (sql: (i: number) => string, value: unknown) => { args.push(value); where.push(sql(args.length)); };
    if (query.status) add((i) => `status = $${i}`, query.status);
    if (query.kind) add((i) => `kind = $${i}`, query.kind);
    if (query.subjectKind) add((i) => `subject_kind = $${i}`, query.subjectKind);
    if (query.overdue === 'true') where.push(`status = 'OPEN' AND due_at IS NOT NULL AND due_at < now()`);
    if (p.q) add((i) => `(title ILIKE $${i} OR detail ILIKE $${i} OR subject_name ILIKE $${i} OR source_ref ILIKE $${i})`, `%${escapeLike(p.q)}%`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const col: Record<string, string> = { dueAt: 'due_at', raisedAt: 'raised_at', subjectName: 'subject_name', kind: 'kind', status: 'status' };
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM obligations ${w}`, args);
    const rows = await this.pool.query<ObligationRow>(`SELECT * FROM obligations ${w} ORDER BY ${col[p.sortField]} ${p.sortDir} NULLS LAST, raised_at DESC LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map((o) => obligationApi(o)), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  @RequirePerm('facilities.view') @Get('audits')
  async audits(@Query() query: PageQuery & { result?: string; subjectKind?: string; subjectId?: string; from?: string; to?: string }) {
    const p = parsePage(query, { defaultSort: '-date', sortable: ['date', 'number', 'subjectName', 'result'], maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    const add = (sql: (i: number) => string, value: unknown) => { args.push(value); where.push(sql(args.length)); };
    if (query.result) add((i) => `result = $${i}`, query.result);
    if (query.subjectKind) add((i) => `subject_kind = $${i}`, query.subjectKind);
    if (query.subjectId) add((i) => `subject_id = $${i}`, query.subjectId);
    if (query.from) add((i) => `audited_on >= $${i}`, new Date(query.from));
    if (query.to) add((i) => `audited_on <= $${i}`, new Date(`${query.to}T23:59:59Z`));
    if (p.q) add((i) => `(number ILIKE $${i} OR subject_name ILIKE $${i} OR auditor ILIKE $${i} OR remarks ILIKE $${i} OR scope ILIKE $${i})`, `%${escapeLike(p.q)}%`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const col: Record<string, string> = { date: 'audited_on', number: 'number', subjectName: 'subject_name', result: 'result' };
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM audits ${w}`, args);
    const rows = await this.pool.query<AuditRow>(`SELECT * FROM audits ${w} ORDER BY ${col[p.sortField]} ${p.sortDir}, number DESC LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(auditApi), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }
}
