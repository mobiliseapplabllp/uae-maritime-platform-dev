import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { Request } from 'express';
import { EVENTS } from '@maritime/contracts';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, Public, RequirePerm, ServiceOnly, badRequest, conflict, enqueue, eventFromContext, forbidden, notFound, paged, parsePage, randomSecret, unauthorized, withTx, zod, type Principal } from '@maritime/service-kit';
import type { Env } from './env';
import { HubClient } from './client';
import { ADAPTERS, TOTAL_OPERATIONS, adapterByKey } from './adapters/registry';
import { loadFixture } from './stubs';
import { endpointProblem } from './endpoint';
import { SECRET_KEYS, adapterApi, listAdapters, loadAdapter, readAdapter, type AdapterRow } from './catalogue';
import { INBOUND_HEADERS, inboundProblem } from './inbound';

const NAME = /^[a-zA-Z][a-zA-Z0-9_]{0,40}$/;
const HEADER = /^[A-Za-z0-9-]{1,60}$/;
const RESERVED_HEADERS = new Set(['host', 'content-length', 'authorization', 'x-service-token', 'x-api-key', 'cookie']);

const callBody = z.object({
  operation: z.string().min(1).max(64),
  payload: z.record(z.unknown()).optional(),
  idempotencyKey: z.string().min(1).max(120).optional(),
  correlationId: z.string().max(120).optional(),
});
const modeBody = z.object({ mode: z.enum(['stub', 'live']), baseUrl: z.string().max(300).optional() });
const authSchema = z.object({ type: z.enum(['none', 'apiKey', 'bearer', 'basic']), header: z.string().regex(HEADER).optional() });
const headersSchema = z.record(z.string().regex(HEADER), z.string().max(500))
  .refine((h) => Object.keys(h).length <= 20, 'at most twenty headers')
  .refine((h) => !Object.keys(h).some((k) => RESERVED_HEADERS.has(k.toLowerCase())), 'a reserved header cannot be set; credentials go under authentication');
const operationSchema = z.object({
  key: z.string().regex(NAME), summary: z.string().min(1).max(160), method: z.enum(['GET', 'POST', 'PUT', 'PATCH']),
  path: z.string().regex(/^\/[^\s?#]{0,200}$/, 'a path starts with / and carries no query string'),
  required: z.array(z.string().regex(NAME)).max(20).default([]), idempotent: z.boolean().default(false),
  sample: z.object({ status: z.number().int().min(100).max(599), body: z.unknown() }).optional(),
});
const secretsSchema = z.record(z.enum(['apiKey', 'token', 'username', 'password']), z.string().max(2000));
const configSchema = z.object({
  name: z.string().min(1).max(120).optional(), nameAr: z.string().max(120).nullable().optional(), counterpart: z.string().min(1).max(200).optional(),
  description: z.string().max(500).optional(), mode: z.enum(['stub', 'live']).optional(), baseUrl: z.string().max(300).nullable().optional(),
  auth: authSchema.optional(), secrets: secretsSchema.optional(), headers: headersSchema.optional(),
  timeoutMs: z.number().int().min(1000).max(60_000).optional(), maxAttempts: z.number().int().min(1).max(10).optional(), enabled: z.boolean().optional(),
  healthPath: z.string().regex(/^(\/[^\s?#]{0,200})?$/).optional(), schedule: z.object({ pollMinutes: z.number().int().min(1).max(1440).nullable().optional() }).optional(),
  operations: z.array(operationSchema).max(40).optional(), inboundEnabled: z.boolean().optional(),
});
const createSchema = configSchema.extend({
  key: z.string().regex(/^[a-z][a-z0-9-]{2,39}$/, 'a key is lower-case letters, digits and dashes'), name: z.string().min(1).max(120), counterpart: z.string().min(1).max(200),
  protocol: z.enum(['rest', 'soap']).default('rest'), operations: z.array(operationSchema).min(1).max(40),
});
const invokeBody = z.object({ operation: z.string().min(1).max(64), payload: z.record(z.unknown()).optional().default({}) });

@Controller()
export class HubController {
  private readonly started = Date.now();
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    private readonly hub: HubClient,
    private readonly audit: AuditClient,
  ) {}
  private actor(me: Principal) { return `${me.name} <${me.email}>`; }
  private inboundUrl(key: string) { return `${this.env.PUBLIC_API_URL.replace(/\/+$/, '')}/integrations/inbound/${encodeURIComponent(key)}`; }

  @Public() @Get('health')
  health() {
    return { status: 'ok', service: this.env.SERVICE_NAME, uptimeSec: Math.round((Date.now() - this.started) / 1000), time: new Date().toISOString(), adapters: ADAPTERS.length, operations: TOTAL_OPERATIONS };
  }

  /* ------------------------------------------------------------------------------ the registry --- */
  /** Every adapter — declared or added — with its configuration and recent health. */
  @RequirePerm('platform.view', 'settings.view') @Get('integrations')
  async list() {
    const all = await listAdapters(this.pool);
    const stats = await this.pool.query<{ adapter: string; total: string; failed: string; dead: string; p95: number | null; last_at: Date | null }>(
      `SELECT adapter, count(*)::text AS total,
              count(*) FILTER (WHERE status = 'failed')::text AS failed,
              count(*) FILTER (WHERE status = 'dead')::text AS dead,
              percentile_disc(0.95) WITHIN GROUP (ORDER BY duration_ms)::int AS p95,
              max(started_at) AS last_at
         FROM calls WHERE started_at > now() - interval '24 hours' GROUP BY adapter`);
    const open = await this.pool.query<{ adapter: string; n: string }>('SELECT adapter, count(*)::text AS n FROM dead_letters WHERE replayed_at IS NULL GROUP BY adapter');
    const inbound = await this.pool.query<{ adapter: string; n: string; last_at: Date | null }>(`SELECT adapter, count(*)::text AS n, max(received_at) AS last_at FROM inbound_events WHERE received_at > now() - interval '24 hours' GROUP BY adapter`);
    const cert = await this.pool.query<{ adapter: string; passed: number; operations: number; certified_at: Date }>('SELECT DISTINCT ON (adapter) adapter, passed, operations, certified_at FROM certifications ORDER BY adapter, certified_at DESC');
    const by = new Map(stats.rows.map((s) => [s.adapter, s])); const openBy = new Map(open.rows.map((r) => [r.adapter, Number(r.n)]));
    const inBy = new Map(inbound.rows.map((r) => [r.adapter, r])); const certBy = new Map(cert.rows.map((r) => [r.adapter, r]));
    return all.map((a) => {
      const s = by.get(a.row.key); const c = certBy.get(a.row.key); const i = inBy.get(a.row.key);
      return {
        ...adapterApi(a),
        last24h: { calls: Number(s?.total ?? 0), failed: Number(s?.failed ?? 0), dead: Number(s?.dead ?? 0), latencyP95: s?.p95 ?? null, lastCallAt: s?.last_at?.toISOString() ?? null, inbound: Number(i?.n ?? 0), lastInboundAt: i?.last_at?.toISOString() ?? null },
        openDeadLetters: openBy.get(a.row.key) ?? 0,
        certification: c ? { passed: c.passed, operations: c.operations, certifiedAt: c.certified_at.toISOString() } : null,
      };
    });
  }

  @RequirePerm('platform.view') @Get('integrations/calls')
  async calls(@Query() q: { page?: string; limit?: string; adapter?: string; status?: string }) {
    const p = parsePage(q, { defaultSort: 'startedAt', sortable: ['startedAt'] });
    const where: string[] = []; const args: unknown[] = [];
    if (q.adapter) { args.push(q.adapter); where.push(`adapter = $${args.length}`); }
    if (q.status) { args.push(q.status); where.push(`status = $${args.length}`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM calls ${w}`, args);
    const rows = await this.pool.query(`SELECT id::text, adapter, operation, status, mode, http_status, attempts, duration_ms, error, correlation_id, started_at, finished_at FROM calls ${w} ORDER BY started_at DESC LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map((r: Record<string, unknown>) => ({
      id: r.id, adapter: r.adapter, operation: r.operation, status: r.status, mode: r.mode,
      httpStatus: r.http_status, attempts: r.attempts, durationMs: r.duration_ms, error: r.error, correlationId: r.correlation_id,
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
  async replay(@Param('id') id: string, @CurrentUser() me: Principal) {
    if (!/^\d+$/.test(id)) throw badRequest('bad id');
    const r = await this.pool.query<{ adapter: string; operation: string; request: Record<string, unknown>; replayed_at: Date | null }>(
      'SELECT adapter, operation, request, replayed_at FROM dead_letters WHERE id = $1', [id]);
    const dl = r.rows[0];
    if (!dl) throw notFound('no such dead letter');
    if (dl.replayed_at) throw badRequest('already replayed');
    const out = await this.hub.call({ adapter: dl.adapter, operation: dl.operation, payload: dl.request, correlationId: `replay:${id}` });
    await this.pool.query('UPDATE dead_letters SET replayed_at = now(), replayed_by = $2 WHERE id = $1', [id, this.actor(me)]);
    await this.audit.record(this.pool, { action: 'REPLAY', entity: 'DeadLetter', entityId: id, entityLabel: `${dl.adapter}.${dl.operation}`, after: { status: out.status, attempts: out.attempts } });
    return out;
  }

  /** A counterpart nobody declared: an administrator adds it with its operations, and it behaves like any other. */
  @RequirePerm('settings.manage') @Post('integrations')
  async create(@Body(zod(createSchema)) body: z.infer<typeof createSchema>, @CurrentUser() me: Principal) {
    if (adapterByKey(body.key) || (await readAdapter(this.pool, body.key))) throw conflict(`an adapter with key ${body.key} already exists`);
    if (new Set(body.operations.map((o) => o.key)).size !== body.operations.length) throw badRequest('operation keys must be unique');
    const baseUrl = body.baseUrl ?? null;
    if (baseUrl) { const problem = endpointProblem(baseUrl, { allowLocal: this.env.NODE_ENV !== 'production' }); if (problem) throw badRequest(problem); }
    if ((body.mode ?? 'stub') === 'live' && !baseUrl) throw badRequest('a live adapter needs its counterpart\'s address');
    const auth = body.auth ?? { type: 'none' };
    const secrets = this.hub.box.sealAll(this.pickSecrets(auth.type, body.secrets ?? {}));
    return withTx(this.pool, async (c) => {
      await c.query(
        `INSERT INTO adapters(key, name, name_ar, counterpart, kind, protocol, description, reference, mode, base_url, enabled, timeout_ms, max_attempts, auth, secrets, headers, operations, health_path, schedule, inbound_enabled, updated_by)
         VALUES ($1,$2,$3,$4,'custom',$5,$6,'',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [body.key, body.name, body.nameAr ?? null, body.counterpart, body.protocol, body.description ?? '', body.mode ?? 'stub', baseUrl, body.enabled ?? true,
          body.timeoutMs ?? 8000, body.maxAttempts ?? 3, JSON.stringify(auth), JSON.stringify(secrets), JSON.stringify(body.headers ?? {}), JSON.stringify(body.operations),
          body.healthPath ?? '', JSON.stringify(body.schedule ?? {}), body.inboundEnabled ?? false, this.actor(me)]);
      const made = await loadAdapter(c, body.key);
      await this.audit.record(c, { action: 'CREATE', entity: 'Adapter', entityId: body.key, entityLabel: body.name, after: adapterApi(made) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.integration.adapterChanged, { key: body.key, name: body.name, kind: 'custom', change: 'created', mode: made.row.mode, enabled: made.row.enabled, by: this.actor(me) }));
      return adapterApi(made);
    });
  }

  @RequirePerm('platform.view', 'settings.view') @Get('integrations/:key')
  async detail(@Param('key') key: string) {
    const a = await loadAdapter(this.pool, key);
    const calls = await this.pool.query(`SELECT id::text, operation, status, mode, http_status, attempts, duration_ms, error, correlation_id, started_at FROM calls WHERE adapter = $1 ORDER BY started_at DESC LIMIT 20`, [key]);
    const certs = await this.pool.query<{ contract_ver: string; operations: number; passed: number; certified_at: Date }>('SELECT contract_ver, operations, passed, certified_at FROM certifications WHERE adapter = $1 ORDER BY certified_at DESC LIMIT 5', [key]);
    const dead = await this.pool.query<{ n: string }>('SELECT count(*)::text AS n FROM dead_letters WHERE adapter = $1 AND replayed_at IS NULL', [key]);
    const inbound = await this.pool.query<{ id: string; delivery_id: string; event_type: string; payload: unknown; received_at: Date }>('SELECT id::text, delivery_id, event_type, payload, received_at FROM inbound_events WHERE adapter = $1 ORDER BY received_at DESC LIMIT 20', [key]);
    return {
      ...adapterApi(a),
      inboundUrl: this.inboundUrl(key), openDeadLetters: Number(dead.rows[0].n),
      recentCalls: calls.rows.map((r: Record<string, unknown>) => ({ id: r.id, operation: r.operation, status: r.status, mode: r.mode, httpStatus: r.http_status, attempts: r.attempts, durationMs: r.duration_ms, error: r.error, correlationId: r.correlation_id, startedAt: (r.started_at as Date).toISOString() })),
      certifications: certs.rows.map((r) => ({ contractVersion: r.contract_ver, operations: r.operations, passed: r.passed, certifiedAt: r.certified_at.toISOString() })),
      recentInbound: inbound.rows.map((r) => ({ id: r.id, deliveryId: r.delivery_id, eventType: r.event_type, payload: r.payload, receivedAt: r.received_at.toISOString() })),
    };
  }

  /** The credentials the declared authentication needs; a blank clears one, an absent key leaves it as it is. */
  private pickSecrets(type: 'none' | 'apiKey' | 'bearer' | 'basic', offered: Record<string, string>, current: Record<string, string> = {}): Record<string, string> {
    const wanted = SECRET_KEYS[type];
    const stray = Object.keys(offered).filter((k) => !wanted.includes(k));
    if (stray.length) throw badRequest(`${stray.join(', ')} does not belong to ${type} authentication`);
    const out: Record<string, string> = {};
    for (const k of wanted) {
      if (k in offered) { if (offered[k]) out[k] = offered[k]; }
      else if (current[k]) out[k] = this.hub.box.open(current[k]);
    }
    return out;
  }

  /** Configure an adapter: where it points, how it authenticates, how patient it is. Audited with the credentials masked, because pointing a government integration somewhere is a consequential act. */
  @RequirePerm('settings.manage') @Put('integrations/:key')
  async configure(@Param('key') key: string, @Body(zod(configSchema)) body: z.infer<typeof configSchema>, @CurrentUser() me: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await loadAdapter(c, key);
      const row = before.row;
      if (row.kind === 'system' && body.operations) throw badRequest('a declared adapter\'s operations are code, not configuration');
      if (body.operations && new Set(body.operations.map((o) => o.key)).size !== body.operations.length) throw badRequest('operation keys must be unique');
      const baseUrl = body.baseUrl === undefined ? row.base_url : body.baseUrl;
      const mode = body.mode ?? row.mode;
      if (body.baseUrl && body.baseUrl !== row.base_url) { const problem = endpointProblem(body.baseUrl, { allowLocal: this.env.NODE_ENV !== 'production' }); if (problem) throw badRequest(problem); }
      if (mode === 'live') {
        if (!baseUrl) throw badRequest('a live adapter needs its counterpart\'s address');
        const problem = endpointProblem(baseUrl, { allowLocal: this.env.NODE_ENV !== 'production' });
        if (problem) throw badRequest(`the stored address cannot be used live: ${problem}`);
      }
      const auth = body.auth ?? row.auth ?? { type: 'none' };
      const secrets = this.hub.box.sealAll(this.pickSecrets(auth.type, body.secrets ?? {}, auth.type === (row.auth?.type ?? 'none') ? row.secrets ?? {} : {}));
      await c.query(
        `UPDATE adapters SET name = $2, name_ar = $3, counterpart = $4, description = $5, mode = $6, base_url = $7, enabled = $8, timeout_ms = $9, max_attempts = $10,
                auth = $11, secrets = $12, headers = $13, operations = $14, health_path = $15, schedule = $16, inbound_enabled = $17, updated_at = now(), updated_by = $18
          WHERE key = $1`,
        [key, body.name ?? row.name, body.nameAr === undefined ? row.name_ar : body.nameAr, body.counterpart ?? row.counterpart, body.description ?? row.description, mode, baseUrl,
          body.enabled ?? row.enabled, body.timeoutMs ?? row.timeout_ms, body.maxAttempts ?? row.max_attempts, JSON.stringify(auth), JSON.stringify(secrets),
          JSON.stringify(body.headers ?? row.headers ?? {}), JSON.stringify(row.kind === 'custom' ? body.operations ?? row.operations : []), body.healthPath ?? row.health_path,
          JSON.stringify(body.schedule ? { ...row.schedule, ...body.schedule } : row.schedule ?? {}), body.inboundEnabled ?? row.inbound_enabled, this.actor(me)]);
      const after = await loadAdapter(c, key);
      await this.audit.record(c, { action: 'CONFIGURE', entity: 'Adapter', entityId: key, entityLabel: after.row.name, before: adapterApi(before), after: adapterApi(after) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.integration.adapterChanged, { key, name: after.row.name, kind: after.row.kind, change: mode !== row.mode ? `mode:${mode}` : 'configured', mode: after.row.mode, enabled: after.row.enabled, by: this.actor(me) }));
      return adapterApi(after);
    });
  }

  @RequirePerm('settings.manage') @Delete('integrations/:key')
  async remove(@Param('key') key: string, @CurrentUser() me: Principal) {
    return withTx(this.pool, async (c) => {
      const a = await loadAdapter(c, key);
      if (a.row.kind !== 'custom') throw forbidden('a declared adapter cannot be removed; disable it instead');
      await c.query('DELETE FROM adapters WHERE key = $1', [key]);
      await this.audit.record(c, { action: 'DELETE', entity: 'Adapter', entityId: key, entityLabel: a.row.name, before: adapterApi(a) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.integration.adapterChanged, { key, name: a.row.name, kind: 'custom', change: 'removed', mode: a.row.mode, enabled: false, by: this.actor(me) }));
      return { key, removed: true };
    });
  }

  /** Switch one adapter between its recorded contract and the live counterpart. Kept for callers that only need the switch. */
  @RequirePerm('settings.manage') @Post('integrations/:key/mode')
  async setMode(@Param('key') key: string, @Body(zod(modeBody)) body: z.infer<typeof modeBody>, @CurrentUser() me: Principal) {
    const out = await this.configure(key, { mode: body.mode, baseUrl: body.baseUrl }, me);
    return { key, mode: out.mode };
  }

  /** Does it answer? The recorded contract in stub mode; the counterpart's health address, with the credentials, in live mode. */
  @RequirePerm('settings.manage') @Post('integrations/:key/test')
  async test(@Param('key') key: string, @CurrentUser() me: Principal) {
    const out = await this.hub.testConnection(key, `test:${me.id}`);
    await this.audit.record(this.pool, { action: 'TEST', entity: 'Adapter', entityId: key, entityLabel: key, after: { mode: out.mode, ok: out.ok, httpStatus: out.httpStatus, target: out.target } });
    return out;
  }

  /** An administrator's own call, from the console: the same path a service takes, so what is seen here is what a service would get. */
  @RequirePerm('settings.manage') @Post('integrations/:key/invoke')
  async invoke(@Param('key') key: string, @Body(zod(invokeBody)) body: z.infer<typeof invokeBody>, @CurrentUser() me: Principal) {
    const out = await this.hub.call({ adapter: key, operation: body.operation, payload: body.payload, correlationId: `console:${me.id}` });
    await this.audit.record(this.pool, { action: 'INVOKE', entity: 'Adapter', entityId: key, entityLabel: `${key}.${body.operation}`, after: { status: out.status, mode: out.mode, attempts: out.attempts, callId: out.callId } });
    return out;
  }

  /** The certification pack: every operation exercised against its recorded contract, with the
   *  result stored as evidence a counterpart can be shown. */
  @RequirePerm('settings.manage') @Post('integrations/:key/certify')
  async certify(@Param('key') key: string) {
    const { row, def } = await loadAdapter(this.pool, key);
    const results = def.operations.map((op) => {
      const fx = row.kind === 'custom' ? op.sample ?? null : loadFixture(def.key, op.key);
      const ok = !!fx && typeof fx.status === 'number' && fx.body !== undefined;
      return { operation: op.key, recorded: !!fx, status: fx?.status ?? null, passed: ok };
    });
    const passed = results.filter((r) => r.passed).length;
    await this.pool.query('INSERT INTO certifications(adapter, contract_ver, operations, passed, evidence) VALUES ($1,$2,$3,$4,$5)',
      [def.key, row.contract_ver, results.length, passed, JSON.stringify({ results })]);
    return { adapter: def.key, contractVersion: row.contract_ver, operations: results.length, passed, results };
  }

  /* ------------------------------------------------------------------------- inbound deliveries --- */
  /** A fresh signing key for the counterpart, shown once. The old key stops working the moment this answers. */
  @RequirePerm('settings.manage') @Post('integrations/:key/inbound/rotate')
  async rotateInbound(@Param('key') key: string, @CurrentUser() me: Principal) {
    const a = await loadAdapter(this.pool, key);
    const secret = randomSecret();
    await this.pool.query('UPDATE adapters SET inbound_secret = $2, inbound_enabled = true, updated_at = now(), updated_by = $3 WHERE key = $1', [key, this.hub.box.seal(secret), this.actor(me)]);
    await this.audit.record(this.pool, { action: 'ROTATE_INBOUND_KEY', entity: 'Adapter', entityId: key, entityLabel: a.row.name });
    return { key, secret, url: this.inboundUrl(key), headers: INBOUND_HEADERS, signing: 'sha256=HMAC-SHA256(secret, "<timestamp>." + body) with the timestamp in unix seconds' };
  }

  @RequirePerm('platform.view') @Get('integrations/:key/inbound')
  async inboundList(@Param('key') key: string, @Query('limit') limit?: string) {
    await loadAdapter(this.pool, key);
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    const rows = await this.pool.query<{ id: string; delivery_id: string; event_type: string; payload: unknown; received_at: Date }>('SELECT id::text, delivery_id, event_type, payload, received_at FROM inbound_events WHERE adapter = $1 ORDER BY received_at DESC LIMIT $2', [key, n]);
    return rows.rows.map((r) => ({ id: r.id, deliveryId: r.delivery_id, eventType: r.event_type, payload: r.payload, receivedAt: r.received_at.toISOString() }));
  }

  /** What a counterpart pushes to us. Public by necessity, signed by requirement: an unsigned or stale delivery is refused, a repeated one is acknowledged once. */
  @Public() @Post('integrations/inbound/:key')
  async inbound(@Param('key') key: string, @Req() req: Request & { rawBody?: Buffer }) {
    const row: AdapterRow | null = await readAdapter(this.pool, key);
    if (!row || !row.inbound_enabled || !row.inbound_secret) throw notFound('no inbound endpoint for that adapter');
    if (!row.enabled) throw forbidden('adapter is disabled');
    const h = { signature: header(req, INBOUND_HEADERS.signature), timestamp: header(req, INBOUND_HEADERS.timestamp), delivery: header(req, INBOUND_HEADERS.delivery), event: header(req, INBOUND_HEADERS.event) };
    const problem = inboundProblem(req.rawBody, h, this.hub.box.open(row.inbound_secret), { skewSec: this.env.HUB_INBOUND_SKEW_SEC });
    if (problem) throw unauthorized(problem);
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const eventType = String(h.event || body.type || body.event || '').slice(0, 120);
    return withTx(this.pool, async (c) => {
      const ins = await c.query<{ id: string }>('INSERT INTO inbound_events(adapter, delivery_id, event_type, payload) VALUES ($1,$2,$3,$4) ON CONFLICT (adapter, delivery_id) DO NOTHING RETURNING id::text', [key, h.delivery, eventType, JSON.stringify(body)]);
      if (!ins.rows[0]) return { accepted: true, duplicate: true, deliveryId: h.delivery };
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.integration.inboundReceived, { adapter: key, adapterName: row.name, deliveryId: h.delivery, eventType, payload: body, inboundId: ins.rows[0].id }, { subject: `${key}:${h.delivery}` }));
      return { accepted: true, duplicate: false, deliveryId: h.delivery, id: ins.rows[0].id };
    });
  }

  /** The only way another service reaches an external system. Service-to-service, never a user. */
  @ServiceOnly() @Post('internal/call/:adapter')
  async internalCall(@Param('adapter') adapter: string, @Body(zod(callBody)) body: z.infer<typeof callBody>) {
    return this.hub.call({ adapter, operation: body.operation, payload: body.payload, idempotencyKey: body.idempotencyKey, correlationId: body.correlationId });
  }
}

const header = (req: Request, name: string): string | undefined => { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; };
