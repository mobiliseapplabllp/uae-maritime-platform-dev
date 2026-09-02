import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { PageQuery } from '@maritime/contracts';
import { KIT_ENV, KIT_POOL, AuditClient, Public, RequirePerm, ServiceOnly, zod, paged, parsePage, escapeLike, badRequest, notFound, withTx } from '@maritime/service-kit';
import type { Env } from './env';
import { CronError, isValidTimeZone, parseCron } from './cron';
import { Ticker } from './ticker';
import { fireJob, jobToApi, runToApi, upsertJob, type JobRow, type RunRow } from './jobs';

const KEY = /^[a-z][a-z0-9-]{1,79}$/;
const cronField = z.string().min(9).max(120).refine((s) => { try { parseCron(s); return true; } catch { return false; } }, 'cron must be five fields: minute hour day-of-month month day-of-week');
const timezoneField = z.string().max(64).refine(isValidTimeZone, 'unknown time zone');
const eventTypeField = z.string().regex(/^[a-z][a-z0-9-]*(\.[a-z0-9-]+)+$/, 'eventType must look like scheduler.sweep.sla');
const jobPatch = z.object({ name: z.string().min(2).max(120).optional(), nameAr: z.string().max(120).optional().nullable(), cron: cronField.optional(), timezone: timezoneField.optional(), eventType: eventTypeField.optional(), payload: z.record(z.unknown()).optional(), enabled: z.boolean().optional(), owner: z.string().max(40).optional() });
const jobRegistration = z.object({ key: z.string().regex(KEY), name: z.string().min(2).max(120), nameAr: z.string().max(120).optional().nullable(), cron: cronField, timezone: timezoneField.optional(), eventType: eventTypeField, payload: z.record(z.unknown()).optional(), enabled: z.boolean().optional(), owner: z.string().max(40).optional() });
const SORT: Record<string, string> = { key: 'key', name: 'name', nextRunAt: 'next_run_at', lastRunAt: 'last_run_at', runs: 'runs', owner: 'owner' };

@Controller()
export class JobsController {
  private readonly started = Date.now();
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly ticker: Ticker, private readonly audit: AuditClient) {}

  /** Health carries the loop's heartbeat: a stale lastTickAt on the lock holder means the loop is stuck. */
  @Public() @Get('health')
  health() { return { status: 'ok', service: this.env.SERVICE_NAME, uptimeSec: Math.round((Date.now() - this.started) / 1000), time: new Date().toISOString(), lastTickAt: this.ticker.lastTickAt, lastTickFired: this.ticker.lastTickFired, tickMs: this.env.SCHEDULER_TICK_MS, lockHeld: this.ticker.lockHeld }; }

  @RequirePerm('settings.view') @Get('jobs')
  async list(@Query() query: PageQuery & { enabled?: string; owner?: string }) {
    const p = parsePage(query, { defaultSort: 'key', sortable: Object.keys(SORT) });
    const where: string[] = []; const args: unknown[] = [];
    if (query.enabled === 'true' || query.enabled === 'false') { args.push(query.enabled === 'true'); where.push(`enabled = $${args.length}`); }
    if (query.owner) { args.push(query.owner); where.push(`owner = $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(key ILIKE $${args.length} OR name ILIKE $${args.length} OR event_type ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM jobs ${w}`, args);
    const rows = await this.pool.query<JobRow>(`SELECT * FROM jobs ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, key LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(jobToApi), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  @RequirePerm('settings.view') @Get('jobs/:key')
  async get(@Param('key') key: string) { return jobToApi(await this.find(key)); }

  /** Creates or updates a job; a changed schedule recomputes the next run, a disabled job keeps its place. */
  @RequirePerm('settings.manage') @Put('jobs/:key')
  async put(@Param('key') key: string, @Body(zod(jobPatch)) b: z.infer<typeof jobPatch>) {
    if (!KEY.test(key)) throw badRequest('key must be lower-case letters, digits and dashes');
    const before = (await this.pool.query<JobRow>('SELECT * FROM jobs WHERE key = $1', [key])).rows[0];
    if (!before && (!b.name || !b.cron || !b.eventType)) throw badRequest('name, cron and eventType are required to create a job');
    return withTx(this.pool, async (c) => {
      const row = await this.tryUpsert(c, { key, name: b.name ?? before.name, nameAr: b.nameAr === undefined ? before?.name_ar : b.nameAr, cron: b.cron ?? before.cron, timezone: b.timezone ?? before?.timezone, eventType: b.eventType ?? before.event_type, payload: b.payload ?? before?.payload ?? {}, enabled: b.enabled, owner: b.owner ?? before?.owner });
      await this.audit.record(c, { action: before ? 'UPDATE' : 'CREATE', entity: 'Job', entityId: key, entityLabel: row.name, before: before ? jobToApi(before) : null, after: jobToApi(row) });
      return jobToApi(row);
    });
  }

  /** Fires the job now without touching its schedule. */
  @RequirePerm('settings.manage') @Post('jobs/:key/run')
  async run(@Param('key') key: string) {
    const job = await this.find(key);
    return withTx(this.pool, async (c) => {
      const locked = (await c.query<JobRow>('SELECT * FROM jobs WHERE key = $1 FOR UPDATE', [key])).rows[0];
      const fired = await fireJob(c, this.env.SERVICE_NAME, locked ?? job, { trigger: 'MANUAL', now: new Date(), scheduledFor: null });
      await this.audit.record(c, { action: 'RUN', entity: 'Job', entityId: key, entityLabel: job.name, after: { eventId: fired.eventId, eventType: job.event_type } });
      return { run: runToApi(fired.run), eventId: fired.eventId, nextRunAt: fired.nextRunAt };
    });
  }

  @RequirePerm('settings.view') @Get('jobs/:key/runs')
  async runs(@Param('key') key: string, @Query() query: PageQuery) {
    await this.find(key);
    const p = parsePage(query, { defaultSort: '-firedAt', sortable: ['firedAt'] });
    const total = await this.pool.query<{ n: string }>('SELECT count(*) AS n FROM job_runs WHERE job_key = $1', [key]);
    const rows = await this.pool.query<RunRow>(`SELECT * FROM job_runs WHERE job_key = $1 ORDER BY fired_at ${p.sortDir}, id ${p.sortDir} LIMIT ${p.limit} OFFSET ${p.offset}`, [key]);
    return paged(rows.rows.map(runToApi), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  /** Services register the jobs they own at start-up; idempotent by key. */
  @ServiceOnly() @Post('internal/jobs')
  async register(@Body(zod(jobRegistration)) b: z.infer<typeof jobRegistration>) {
    return withTx(this.pool, async (c) => {
      const before = (await c.query<JobRow>('SELECT * FROM jobs WHERE key = $1', [b.key])).rows[0];
      const row = await this.tryUpsert(c, { key: b.key, name: b.name, nameAr: b.nameAr, cron: b.cron, timezone: b.timezone, eventType: b.eventType, payload: b.payload, enabled: b.enabled, owner: b.owner });
      await this.audit.record(c, { action: before ? 'REGISTER_UPDATE' : 'REGISTER', entity: 'Job', entityId: b.key, entityLabel: row.name, before: before ? jobToApi(before) : null, after: jobToApi(row) });
      return jobToApi(row);
    });
  }

  private async find(key: string): Promise<JobRow> { const r = await this.pool.query<JobRow>('SELECT * FROM jobs WHERE key = $1', [key]); if (!r.rows[0]) throw notFound('Job not found'); return r.rows[0]; }
  private async tryUpsert(c: Parameters<typeof upsertJob>[0], def: Parameters<typeof upsertJob>[1]): Promise<JobRow> {
    try { return await upsertJob(c, def, this.env.SCHEDULER_TIMEZONE); }
    catch (e) { if (e instanceof CronError) throw badRequest(e.message); throw e; }
  }
}
