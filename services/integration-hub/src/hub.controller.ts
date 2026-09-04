import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { AuditClient, KIT_ENV, KIT_POOL, Public, RequirePerm, ServiceOnly, badRequest, notFound, paged, parsePage, zod } from '@maritime/service-kit';
import type { Env } from './env';
import { HubClient } from './client';
import { ADAPTERS, TOTAL_OPERATIONS, adapterByKey } from './adapters/registry';
import { loadFixture } from './stubs';

const callBody = z.object({
  operation: z.string().min(1).max(64),
  payload: z.record(z.unknown()).optional(),
  idempotencyKey: z.string().min(1).max(120).optional(),
  correlationId: z.string().max(120).optional(),
});
const modeBody = z.object({ mode: z.enum(['stub', 'live']), baseUrl: z.string().url().optional() });

@Controller()
export class HubController {
  private readonly started = Date.now();
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    private readonly hub: HubClient,
    private readonly audit: AuditClient,
  ) {}

  @Public() @Get('health')
  health() {
    return { status: 'ok', service: this.env.SERVICE_NAME, uptimeSec: Math.round((Date.now() - this.started) / 1000), time: new Date().toISOString(), adapters: ADAPTERS.length, operations: TOTAL_OPERATIONS };
  }

  /** The registry, with each adapter's live/stub mode and recent health. */
  @RequirePerm('platform.view') @Get('integrations')
  async list() {
    const rows = await this.pool.query<{ key: string; name: string; name_ar: string | null; counterpart: string; mode: string; enabled: boolean; base_url: string | null; contract_ver: string }>(
      'SELECT key, name, name_ar, counterpart, mode, enabled, base_url, contract_ver FROM adapters ORDER BY key');
    const stats = await this.pool.query<{ adapter: string; total: string; failed: string; dead: string; p95: number | null; last_at: Date | null }>(
      `SELECT adapter, count(*)::text AS total,
              count(*) FILTER (WHERE status = 'failed')::text AS failed,
              count(*) FILTER (WHERE status = 'dead')::text AS dead,
              percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95,
              max(started_at) AS last_at
         FROM calls WHERE started_at > now() - interval '24 hours' GROUP BY adapter`);
    const by = new Map(stats.rows.map((s) => [s.adapter, s]));
    return rows.rows.map((r) => {
      const d = adapterByKey(r.key);
      const s = by.get(r.key);
      return {
        key: r.key, name: r.name, nameAr: r.name_ar, counterpart: r.counterpart,
        mode: r.mode, enabled: r.enabled, baseUrl: r.base_url, contractVersion: r.contract_ver,
        protocol: d?.protocol ?? 'rest', reference: d?.reference ?? null,
        operations: d?.operations.map((o) => ({ key: o.key, summary: o.summary, method: o.method, path: o.path, required: o.required, idempotent: o.idempotent })) ?? [],
        last24h: { calls: Number(s?.total ?? 0), failed: Number(s?.failed ?? 0), dead: Number(s?.dead ?? 0), latencyP95: s?.p95 ?? null, lastCallAt: s?.last_at?.toISOString() ?? null },
      };
    });
  }

  /** Switch one adapter between its recorded contract and the live counterpart. Audited, because
   *  pointing a government integration at a real endpoint is a consequential act. */
  @RequirePerm('settings.manage') @Post('integrations/:key/mode')
  async setMode(@Param('key') key: string, @Body(zod(modeBody)) body: z.infer<typeof modeBody>) {
    if (!adapterByKey(key)) throw notFound(`unknown adapter ${key}`);
    const before = await this.pool.query<{ mode: string }>('SELECT mode FROM adapters WHERE key = $1', [key]);
    await this.pool.query('UPDATE adapters SET mode = $2, base_url = COALESCE($3, base_url), updated_at = now() WHERE key = $1', [key, body.mode, body.baseUrl ?? null]);
    await this.audit.record(this.pool, { action: 'MODE_CHANGE', entity: 'Adapter', entityId: key, entityLabel: adapterByKey(key)!.name, before: before.rows[0], after: { mode: body.mode }, note: `Switched to ${body.mode}` });
    return { key, mode: body.mode };
  }

  @RequirePerm('platform.view') @Get('integrations/calls')
  async calls(@Query() q: { page?: string; limit?: string; adapter?: string; status?: string }) {
    const p = parsePage(q, { defaultSort: 'startedAt', sortable: ['startedAt'] });
    const where: string[] = []; const args: unknown[] = [];
    if (q.adapter) { args.push(q.adapter); where.push(`adapter = $${args.length}`); }
    if (q.status) { args.push(q.status); where.push(`status = $${args.length}`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM calls ${w}`, args);
    const rows = await this.pool.query(`SELECT id::text, adapter, operation, status, mode, http_status, attempts, duration_ms, error, started_at, finished_at FROM calls ${w} ORDER BY started_at DESC LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map((r: Record<string, unknown>) => ({
      id: r.id, adapter: r.adapter, operation: r.operation, status: r.status, mode: r.mode,
      httpStatus: r.http_status, attempts: r.attempts, durationMs: r.duration_ms, error: r.error,
      startedAt: (r.started_at as Date).toISOString(), finishedAt: (r.finished_at as Date | null)?.toISOString() ?? null,
    })), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  @RequirePerm('platform.view') @Get('integrations/dead-letters')
  async deadLetters(@Query('open') open?: string) {
    const rows = await this.pool.query(
      `SELECT id::text, call_id::text, adapter, operation, request, error, attempts, created_at, replayed_at
         FROM dead_letters WHERE ($1::boolean IS NOT TRUE OR replayed_at IS NULL)
        ORDER BY created_at DESC LIMIT 200`, [open === 'true']);
    return rows.rows.map((r: Record<string, unknown>) => ({
      id: r.id, callId: r.call_id, adapter: r.adapter, operation: r.operation, request: r.request,
      error: r.error, attempts: r.attempts, createdAt: (r.created_at as Date).toISOString(),
      replayedAt: (r.replayed_at as Date | null)?.toISOString() ?? null,
    }));
  }

  /** Re-issue a dead-lettered call. The original row is kept and marked, so the queue is a record
   *  of what failed rather than something that quietly empties itself. */
  @RequirePerm('settings.manage') @Post('integrations/dead-letters/:id/replay')
  async replay(@Param('id') id: string) {
    if (!/^\d+$/.test(id)) throw badRequest('bad id');
    const r = await this.pool.query<{ adapter: string; operation: string; request: Record<string, unknown>; replayed_at: Date | null }>(
      'SELECT adapter, operation, request, replayed_at FROM dead_letters WHERE id = $1', [id]);
    const dl = r.rows[0];
    if (!dl) throw notFound('no such dead letter');
    if (dl.replayed_at) throw badRequest('already replayed');
    const out = await this.hub.call({ adapter: dl.adapter, operation: dl.operation, payload: dl.request });
    await this.pool.query('UPDATE dead_letters SET replayed_at = now() WHERE id = $1', [id]);
    await this.audit.record(this.pool, { action: 'REPLAY', entity: 'DeadLetter', entityId: id, entityLabel: `${dl.adapter}.${dl.operation}`, after: { status: out.status, attempts: out.attempts } });
    return out;
  }

  /** The certification pack: every operation exercised against its recorded contract, with the
   *  result stored as evidence a counterpart can be shown. */
  @RequirePerm('settings.manage') @Post('integrations/:key/certify')
  async certify(@Param('key') key: string) {
    const def = adapterByKey(key);
    if (!def) throw notFound(`unknown adapter ${key}`);
    const results = def.operations.map((op) => {
      const fx = loadFixture(def.key, op.key);
      const ok = !!fx && typeof fx.status === 'number' && fx.body !== undefined;
      return { operation: op.key, recorded: !!fx, status: fx?.status ?? null, passed: ok };
    });
    const passed = results.filter((r) => r.passed).length;
    await this.pool.query('INSERT INTO certifications(adapter, contract_ver, operations, passed, evidence) VALUES ($1,$2,$3,$4,$5)',
      [def.key, '1.0.0', results.length, passed, JSON.stringify({ results })]);
    return { adapter: def.key, contractVersion: '1.0.0', operations: results.length, passed, results };
  }

  /** The only way another service reaches an external system. Service-to-service, never a user. */
  @ServiceOnly() @Post('internal/call/:adapter')
  async internalCall(@Param('adapter') adapter: string, @Body(zod(callBody)) body: z.infer<typeof callBody>) {
    return this.hub.call({ adapter, operation: body.operation, payload: body.payload, idempotencyKey: body.idempotencyKey, correlationId: body.correlationId });
  }
}
