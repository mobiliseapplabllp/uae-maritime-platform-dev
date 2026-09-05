import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { EVENTS } from '@maritime/contracts';
import { KIT_ENV, KIT_LOGGER, KIT_POOL, SecretBox, badRequest, enqueue, eventFromContext, notFound, type AppLogger } from '@maritime/service-kit';
import type { Env } from './env';
import { ADAPTERS, operationOf } from './adapters/registry';
import type { AdapterDefinition, AdapterOperation, CallOutcome, CallRequest } from './adapters/types';
import { loadAdapter, type AdapterRow } from './catalogue';
import { loadFixture, materialise } from './stubs';

export interface TestOutcome { key: string; mode: 'stub' | 'live'; ok: boolean; httpStatus: number | null; durationMs: number; detail: string; target: string | null }

@Injectable()
export class HubClient implements OnModuleInit {
  readonly box: SecretBox;
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    @Inject(KIT_LOGGER) private readonly log: AppLogger,
  ) { this.box = new SecretBox(env.HUB_KEY ?? env.JWT_SECRET, 'hub'); }

  async onModuleInit() { await this.registerAll(); }

  /** The registry is code; the row carries what an operator may change at runtime and is never overwritten by a restart. */
  async registerAll() {
    for (const a of ADAPTERS) {
      await this.pool.query(
        `INSERT INTO adapters(key, name, name_ar, counterpart, base_url, kind, protocol, reference)
         VALUES ($1,$2,$3,$4,$5,'system',$6,$7)
         ON CONFLICT (key) DO UPDATE SET name = CASE WHEN adapters.updated_by = '' THEN EXCLUDED.name ELSE adapters.name END,
           name_ar = EXCLUDED.name_ar, counterpart = EXCLUDED.counterpart, kind = 'system', protocol = EXCLUDED.protocol, reference = EXCLUDED.reference,
           base_url = CASE WHEN adapters.updated_by = '' THEN EXCLUDED.base_url ELSE adapters.base_url END, updated_at = now()`,
        [a.key, a.name, a.nameAr, a.counterpart, process.env[a.baseUrlEnv] || a.defaultBaseUrl, a.protocol, a.reference],
      );
    }
  }

  /** Exponential backoff with jitter. Jitter matters: without it every service retrying the same
   *  failed counterpart re-converges on the same instant and the recovery is what knocks it over. */
  private backoff(attempt: number): number {
    const base = Math.min(this.env.HUB_RETRY_MAX_MS, this.env.HUB_RETRY_BASE_MS * 2 ** (attempt - 1));
    return Math.round(base / 2 + Math.random() * (base / 2));
  }

  async call(req: CallRequest): Promise<CallOutcome> {
    const { row, def } = await loadAdapter(this.pool, req.adapter);
    const op = operationOf(def, req.operation);
    if (!op) throw notFound(`unknown operation ${def.key}.${req.operation}`);
    const payload = req.payload ?? {};
    const missing = op.required.filter((f) => payload[f] === undefined || payload[f] === null || payload[f] === '');
    // Refuse a malformed request here rather than let the counterpart reject it: their error text is
    // not ours to interpret, and a 400 from us names the field.
    if (missing.length) throw badRequest(`missing required field(s): ${missing.join(', ')}`);
    if (!row.enabled) throw badRequest(`adapter ${def.key} is disabled`);

    // An idempotent operation replayed with the same key returns the recorded result. This is what
    // makes a caller's own retry safe across a restart — the counterpart is not asked twice.
    if (req.idempotencyKey && op.idempotent) {
      const prior = await this.pool.query<{ id: string; response: unknown; status: string; http_status: number | null; attempts: number; duration_ms: number | null; mode: string }>(
        `SELECT id::text, response, status, http_status, attempts, duration_ms, mode FROM calls
          WHERE adapter = $1 AND operation = $2 AND idempotency_key = $3 AND status = 'ok'`,
        [def.key, op.key, req.idempotencyKey],
      );
      const p = prior.rows[0];
      if (p) {
        return { callId: p.id, adapter: def.key, operation: op.key, status: 'ok', mode: p.mode as 'stub' | 'live',
          httpStatus: p.http_status, attempts: p.attempts, durationMs: p.duration_ms ?? 0, data: p.response, replayed: true };
      }
    }

    const mode: 'stub' | 'live' = this.env.HUB_FORCE_STUB ? 'stub' : row.mode;
    const started = Date.now();
    const ins = await this.pool.query<{ id: string }>(
      `INSERT INTO calls(adapter, operation, idempotency_key, request, status, mode, correlation_id)
       VALUES ($1,$2,$3,$4,'pending',$5,$6) RETURNING id::text`,
      [def.key, op.key, op.idempotent ? req.idempotencyKey ?? null : null, JSON.stringify(payload), mode, req.correlationId ?? null],
    );
    const callId = ins.rows[0].id;

    let attempts = 0; let lastError = ''; let httpStatus: number | null = null; let data: unknown = null;
    while (attempts < row.max_attempts) {
      attempts += 1;
      try {
        const res = mode === 'stub'
          ? await this.stubCall(def, row, op, payload)
          : await this.liveCall(def, op, payload, row);
        httpStatus = res.status;
        if (res.status >= 200 && res.status < 300) { data = res.body; lastError = ''; break; }
        lastError = `HTTP ${res.status}`;
        // 4xx is the counterpart telling us the request is wrong. Retrying an argument does not win it.
        if (res.status >= 400 && res.status < 500 && res.status !== 429) break;
      } catch (e) {
        lastError = (e as Error).message;
      }
      if (attempts < row.max_attempts) await new Promise((r) => setTimeout(r, this.backoff(attempts)));
    }

    const durationMs = Date.now() - started;
    const ok = !lastError;
    const status: CallOutcome['status'] = ok ? 'ok' : attempts >= row.max_attempts ? 'dead' : 'failed';
    await this.pool.query(
      `UPDATE calls SET response = $2, status = $3, http_status = $4, attempts = $5, duration_ms = $6,
              error = $7, finished_at = now() WHERE id = $1`,
      [callId, data === null ? null : JSON.stringify(data), status, httpStatus, attempts, durationMs, lastError || null],
    );
    if (status === 'dead') {
      await this.pool.query(
        'INSERT INTO dead_letters(call_id, adapter, operation, request, error, attempts) VALUES ($1,$2,$3,$4,$5,$6)',
        [callId, def.key, op.key, JSON.stringify(payload), lastError, attempts],
      );
      await enqueue(this.pool, eventFromContext(this.env.SERVICE_NAME, EVENTS.integration.callDead, { adapter: def.key, adapterName: row.name, operation: op.key, callId, attempts, error: lastError, mode }));
      this.log.warn({ adapter: def.key, operation: op.key, attempts, error: lastError }, 'call dead-lettered');
    }
    return { callId, adapter: def.key, operation: op.key, status, mode, httpStatus, attempts, durationMs, data, error: lastError || undefined };
  }

  /** Stub mode answers from the recorded contract: a fixture file for a system adapter, the operation's own sample for a custom one. */
  private async stubCall(def: AdapterDefinition, row: AdapterRow, op: AdapterOperation, payload: Record<string, unknown>) {
    const fx = row.kind === 'custom' ? (op.sample ? { status: op.sample.status, body: op.sample.body } : null) : loadFixture(def.key, op.key);
    if (!fx) throw new Error(`no recorded answer for ${def.key}.${op.key}`);
    return { status: fx.status, body: materialise(fx.body, payload) };
  }

  /** The headers a live counterpart is spoken to with: the operator's own, then the credentials for the declared authentication. */
  private liveHeaders(row: AdapterRow): Record<string, string> {
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'maritime-integration-hub' };
    for (const [k, v] of Object.entries(row.headers ?? {})) headers[k.toLowerCase()] = String(v);
    const type = row.auth?.type ?? 'none';
    if (type === 'none') return headers;
    const s = this.box.openAll(row.secrets ?? {});
    if (type === 'apiKey' && s.apiKey) headers[(row.auth.header || 'x-api-key').toLowerCase()] = s.apiKey;
    if (type === 'bearer' && s.token) headers.authorization = `Bearer ${s.token}`;
    if (type === 'basic' && (s.username || s.password)) headers.authorization = `Basic ${Buffer.from(`${s.username ?? ''}:${s.password ?? ''}`).toString('base64')}`;
    return headers;
  }

  private async liveCall(def: AdapterDefinition, op: AdapterOperation, payload: Record<string, unknown>, row: AdapterRow) {
    // Path parameters are substituted and then removed, so they are not also sent in the body.
    const rest: Record<string, unknown> = { ...payload };
    const path = op.path.replace(/\{([a-zA-Z0-9_]+)\}/g, (m, k: string) => {
      if (!(k in rest)) return m;
      const v = String(rest[k]); delete rest[k];
      return encodeURIComponent(v);
    });
    const base = (row.base_url || def.defaultBaseUrl).replace(/\/+$/, '');
    const url = new URL(base + path);
    if (op.method === 'GET') for (const [k, v] of Object.entries(rest)) url.searchParams.set(k, String(v));
    const headers = this.liveHeaders(row);
    let body: string | undefined;
    if (op.method !== 'GET') {
      // SOAP counterparts get an envelope; the RFP permits SOAP only where one is mandated.
      if (def.protocol === 'soap') { headers['content-type'] = 'text/xml; charset=utf-8'; body = soapEnvelope(op.key, rest); }
      else { headers['content-type'] = 'application/json'; body = JSON.stringify(rest); }
    }
    const res = await fetch(url, { method: op.method, headers, body, signal: AbortSignal.timeout(row.timeout_ms) });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* a SOAP or plain-text answer is returned as given */ }
    return { status: res.status, body: parsed };
  }

  /** "Does it answer?" — the recorded contract in stub mode, the counterpart's health address in live mode. Recorded as a call so the history shows it. */
  async testConnection(key: string, correlationId?: string): Promise<TestOutcome> {
    const { row, def } = await loadAdapter(this.pool, key);
    const mode: 'stub' | 'live' = this.env.HUB_FORCE_STUB ? 'stub' : row.mode;
    const started = Date.now();
    if (mode === 'stub') {
      const recorded = def.operations.filter((o) => (row.kind === 'custom' ? !!o.sample : !!loadFixture(def.key, o.key))).length;
      const ok = def.operations.length > 0 && recorded === def.operations.length;
      return { key, mode, ok, httpStatus: null, durationMs: Date.now() - started, target: null, detail: ok ? `answers from the recorded contract — ${recorded} of ${def.operations.length} operations recorded` : `${def.operations.length - recorded} of ${def.operations.length} operations have no recorded answer` };
    }
    const base = (row.base_url || def.defaultBaseUrl).replace(/\/+$/, '');
    const target = base + (row.health_path || def.healthPath || '/');
    const ins = await this.pool.query<{ id: string }>(`INSERT INTO calls(adapter, operation, request, status, mode, correlation_id) VALUES ($1,'test-connection','{}','pending','live',$2) RETURNING id::text`, [key, correlationId ?? null]);
    let httpStatus: number | null = null; let error = '';
    try {
      const res = await fetch(target, { method: 'GET', headers: this.liveHeaders(row), signal: AbortSignal.timeout(row.timeout_ms) });
      httpStatus = res.status; await res.text().catch(() => '');
      if (res.status >= 400) error = `HTTP ${res.status}`;
    } catch (e) { error = (e as Error).message; }
    const durationMs = Date.now() - started;
    await this.pool.query(`UPDATE calls SET status = $2, http_status = $3, attempts = 1, duration_ms = $4, error = $5, finished_at = now() WHERE id = $1`, [ins.rows[0].id, error ? 'failed' : 'ok', httpStatus, durationMs, error || null]);
    return { key, mode, ok: !error, httpStatus, durationMs, target, detail: error ? `${target} — ${error}` : `${target} answered ${httpStatus} in ${durationMs} ms` };
  }
}

/** Minimal SOAP 1.1 envelope. Only the counterparts that mandate SOAP receive one. */
function soapEnvelope(operation: string, payload: Record<string, unknown>): string {
  const esc = (s: string) => s.replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' }[c] as string));
  const fields = Object.entries(payload).map(([k, v]) => `<${k}>${esc(String(v))}</${k}>`).join('');
  return `<?xml version="1.0" encoding="utf-8"?>`
    + `<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Body>`
    + `<${operation}>${fields}</${operation}></soap:Body></soap:Envelope>`;
}
