import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { Pool } from 'pg';
import { KIT_ENV, KIT_LOGGER, KIT_POOL, badRequest, notFound, type AppLogger } from '@maritime/service-kit';
import type { Env } from './env';
import { ADAPTERS, adapterByKey, operationOf } from './adapters/registry';
import type { AdapterDefinition, CallOutcome, CallRequest } from './adapters/types';
import { loadFixture, materialise } from './stubs';

interface AdapterRow { key: string; mode: 'stub' | 'live'; base_url: string | null; enabled: boolean; timeout_ms: number; max_attempts: number }

@Injectable()
export class HubClient implements OnModuleInit {
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    @Inject(KIT_LOGGER) private readonly log: AppLogger,
  ) {}

  async onModuleInit() { await this.registerAll(); }

  /** The registry is code; this row carries only what an operator may change at runtime. */
  async registerAll() {
    for (const a of ADAPTERS) {
      await this.pool.query(
        `INSERT INTO adapters(key, name, name_ar, counterpart, base_url)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, name_ar = EXCLUDED.name_ar,
           counterpart = EXCLUDED.counterpart, updated_at = now()`,
        [a.key, a.name, a.nameAr, a.counterpart, process.env[a.baseUrlEnv] || a.defaultBaseUrl],
      );
    }
  }

  private async row(key: string): Promise<AdapterRow> {
    const r = await this.pool.query<AdapterRow>('SELECT key, mode, base_url, enabled, timeout_ms, max_attempts FROM adapters WHERE key = $1', [key]);
    if (!r.rows[0]) throw notFound(`unknown adapter ${key}`);
    return r.rows[0];
  }

  /** Exponential backoff with jitter. Jitter matters: without it every service retrying the same
   *  failed counterpart re-converges on the same instant and the recovery is what knocks it over. */
  private backoff(attempt: number): number {
    const base = Math.min(this.env.HUB_RETRY_MAX_MS, this.env.HUB_RETRY_BASE_MS * 2 ** (attempt - 1));
    return Math.round(base / 2 + Math.random() * (base / 2));
  }

  async call(req: CallRequest): Promise<CallOutcome> {
    const def = adapterByKey(req.adapter);
    if (!def) throw notFound(`unknown adapter ${req.adapter}`);
    const op = operationOf(def, req.operation);
    if (!op) throw notFound(`unknown operation ${req.adapter}.${req.operation}`);
    const payload = req.payload ?? {};
    const missing = op.required.filter((f) => payload[f] === undefined || payload[f] === null || payload[f] === '');
    // Refuse a malformed request here rather than let the counterpart reject it: their error text is
    // not ours to interpret, and a 400 from us names the field.
    if (missing.length) throw badRequest(`missing required field(s): ${missing.join(', ')}`);

    const row = await this.row(def.key);
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
          ? await this.stubCall(def, op.key, payload)
          : await this.liveCall(def, op.key, payload, row);
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
      this.log.warn({ adapter: def.key, operation: op.key, attempts, error: lastError }, 'call dead-lettered');
    }
    return { callId, adapter: def.key, operation: op.key, status, mode, httpStatus, attempts, durationMs, data, error: lastError || undefined };
  }

  private async stubCall(def: AdapterDefinition, operation: string, payload: Record<string, unknown>) {
    const fx = loadFixture(def.key, operation);
    if (!fx) throw new Error(`no recorded fixture for ${def.key}.${operation}`);
    return { status: fx.status, body: materialise(fx.body, payload) };
  }

  private async liveCall(def: AdapterDefinition, operation: string, payload: Record<string, unknown>, row: AdapterRow) {
    const op = operationOf(def, operation)!;
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
    const headers: Record<string, string> = { accept: 'application/json', 'user-agent': 'maritime-integration-hub' };
    let body: string | undefined;
    if (op.method !== 'GET') {
      // SOAP counterparts get an envelope; the RFP permits SOAP only where one is mandated.
      if (def.protocol === 'soap') { headers['content-type'] = 'text/xml; charset=utf-8'; body = soapEnvelope(operation, rest); }
      else { headers['content-type'] = 'application/json'; body = JSON.stringify(rest); }
    }
    const res = await fetch(url, { method: op.method, headers, body, signal: AbortSignal.timeout(row.timeout_ms) });
    const text = await res.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* a SOAP or plain-text answer is returned as given */ }
    return { status: res.status, body: parsed };
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
