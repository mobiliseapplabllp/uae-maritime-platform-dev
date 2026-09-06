import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { EVENTS, serviceByName, urlOf } from '@maritime/contracts';
import {
  AuditClient, KIT_ENV, KIT_POOL, KIT_SETTINGS, PRINCIPAL_RESOLVER, TOKEN_VERIFIER, enqueue, eventFromContext, getContext, signHS256, withTx,
  type Principal, type PrincipalResolver, type SettingsClient, type TokenVerifier,
} from '@maritime/service-kit';
import type { Env } from './env';
import { TOOLS, toolByName, type ToolDef } from './registry';
import {
  argsHash, checkCaller, classifyInjection, estimateTokens, fingerprint, isTier, mayUse, redactArgs, redactPii, tierRank, validateArgs,
  type Block, type CallerPolicy, type RefusalCode, type Tier,
} from './policy';
import { buildPrompt, callProvider, selectProvider, type AiProviderSettings, type ChatRequest, type FetchLike } from './providers';

/* The gateway's engine. Two verbs: run a tool, and complete a prompt. Both go through the same order —
 * who is calling, what they may call, as whom it runs, what leaves — and both leave a row behind whatever
 * happened. The controllers parse and return; everything that decides is here or in policy.ts. */

export const GATEWAY_FETCH = 'GATEWAY_FETCH';
export const defaultFetch: FetchLike = (url, init) => fetch(url, init);

export type Outcome = 'OK' | 'REFUSED' | 'FAILED' | 'DRY_RUN';
export interface RunOptions { userToken?: string; dryRun?: boolean; decisionId?: string; cause?: string }
export interface RunResult {
  callId: string; outcome: Outcome; tool: string; tier: Tier; module: string; latencyMs: number;
  code?: RefusalCode; reason?: string; status?: number; data?: unknown; principal?: { id: string; name: string; kind: string }; request?: { method: string; url: string; body?: unknown };
}
export interface CompleteInput extends ChatRequest { purpose?: string }
export interface CompleteResult {
  outcome: 'OK' | 'REFUSED' | 'FAILED' | 'LOCAL'; provider: string; profile: string; residency: string; latencyMs: number;
  text?: string; code?: RefusalCode; reason?: string; redactions: number; redactionKinds: Record<string, number>; injection: { score: number; flags: string[] }; fingerprint?: string; tokensIn?: number; tokensOut?: number;
}

interface ToolRow { name: string; enabled: boolean }
interface CallerRow { caller_id: string; label: string; kind: 'ASSISTANT' | 'AGENT' | 'SERVICE'; allowed_tools: string[]; max_tier: Tier; hourly_quota: number; daily_quota: number; enabled: boolean; note: string }
const callerPolicy = (r: CallerRow): CallerPolicy => ({ callerId: r.caller_id, kind: r.kind, allowedTools: r.allowed_tools ?? ['*'], maxTier: r.max_tier, hourlyQuota: r.hourly_quota, dailyQuota: r.daily_quota, enabled: r.enabled });
const INFER_TOOL = { name: 'infer.complete', tier: 'INFER' as Tier, enabled: true, exposure: 'BOTH' as const };

@Injectable()
export class GatewayService implements OnModuleInit {
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, @Inject(KIT_SETTINGS) private readonly settings: SettingsClient,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier, @Inject(PRINCIPAL_RESOLVER) private readonly resolver: PrincipalResolver,
    @Inject(GATEWAY_FETCH) private readonly fetchFn: FetchLike, private readonly audit: AuditClient,
  ) {}

  /** The registry is the catalogue; the table is the policy. On start every registered tool exists in the table, and an administrator's `enabled` survives a restart. */
  async onModuleInit() { await syncRegistry(this.pool); }

  /* ------------------------------------------------------------------------------ catalogue --- */

  async catalogue(callerId?: string): Promise<(ToolDef & { enabled: boolean; allowed: boolean })[]> {
    const rows = await this.pool.query<ToolRow>('SELECT name, enabled FROM tools');
    const enabled = new Map(rows.rows.map((r) => [r.name, r.enabled]));
    const caller = callerId ? await this.caller(callerId) : null;
    return TOOLS.map((t) => {
      const on = enabled.get(t.name) ?? true;
      const allowed = !callerId || (!!caller && checkCaller(callerPolicy(caller), { name: t.name, tier: t.tier, enabled: on, exposure: t.exposure }, { hour: 0, day: 0 }).ok);
      return { ...t, enabled: on, allowed };
    });
  }

  async caller(callerId: string): Promise<CallerRow | null> {
    const r = await this.pool.query<CallerRow>('SELECT * FROM callers WHERE caller_id = $1', [callerId]);
    return r.rows[0] ?? null;
  }

  /** Calls made in the trailing hour and day, refusals excluded: a refusal costs nothing, so it cannot be used to spend a quota. */
  async usage(callerId: string): Promise<{ hour: number; day: number }> {
    const r = await this.pool.query<{ hour: string; day: string }>(
      `SELECT count(*) FILTER (WHERE at > now() - interval '1 hour') AS hour, count(*) AS day FROM (
         SELECT at FROM tool_calls WHERE caller_id = $1 AND at > now() - interval '1 day' AND outcome <> 'REFUSED'
         UNION ALL SELECT at FROM inferences WHERE caller_id = $1 AND at > now() - interval '1 day' AND outcome <> 'REFUSED') u`, [callerId]);
    return { hour: Number(r.rows[0]?.hour ?? 0), day: Number(r.rows[0]?.day ?? 0) };
  }

  /* ------------------------------------------------------------------------------------ run --- */

  async run(callerId: string, toolName: string, rawArgs: unknown, opts: RunOptions = {}): Promise<RunResult> {
    const started = Date.now();
    const def = toolByName(toolName);
    const callerRow = await this.caller(callerId);
    const enabledRow = def ? await this.pool.query<ToolRow>('SELECT name, enabled FROM tools WHERE name = $1', [def.name]) : null;
    const tool = def ? { name: def.name, tier: def.tier, enabled: enabledRow?.rows[0]?.enabled ?? true, exposure: def.exposure } : null;
    const base = { tool: toolName, tier: (def?.tier ?? 'READ') as Tier, module: def?.module ?? '' };
    const refuse = async (code: RefusalCode, reason: string, principal?: Principal, args?: Record<string, unknown>) => {
      const callId = await this.logCall({ callerId, principal, tool: base.tool, tier: base.tier, module: base.module, args: args ?? {}, outcome: 'REFUSED', code, reason, upstream: def ? `${def.upstream.service} ${def.upstream.path}` : '', latencyMs: Date.now() - started, decisionId: opts.decisionId, cause: opts.cause });
      if (code === 'PERMISSION' || code === 'TIER_CEILING' || code === 'TOOL_NOT_ALLOWED' || code === 'CALLER_UNKNOWN') await this.recordRefusal(callerId, base.tool, code, reason, principal);
      return { callId, outcome: 'REFUSED' as const, ...base, code, reason, latencyMs: Date.now() - started, ...(principal ? { principal: { id: principal.id, name: principal.name, kind: principal.kind } } : {}) };
    };

    const verdict = checkCaller(callerRow ? callerPolicy(callerRow) : null, tool, await this.usage(callerId));
    if (!verdict.ok) return refuse(verdict.code!, verdict.reason!);
    const d = def!; const caller = callerRow!;

    // As whom it runs: the person whose token was forwarded, or the agent the caller is.
    let principal: Principal | null = null; let bearer = '';
    if (opts.userToken) {
      try { const claims = await this.verifier.verify(opts.userToken); if (claims.typ === 'refresh' || claims.typ === 'mfa') throw new Error('not an access token'); principal = await this.resolver.resolve(claims, opts.userToken); bearer = opts.userToken; }
      catch (err) { return refuse('PRINCIPAL_UNKNOWN', `The forwarded token is not a live session: ${(err as Error).message}`); }
      if (!principal || !principal.active) return refuse('PRINCIPAL_UNKNOWN', 'The forwarded token does not resolve to an active account');
    } else if (caller.kind === 'AGENT') {
      const minted = this.mintAgentToken(caller.caller_id, caller.label);
      try { principal = await this.resolver.resolve(await this.verifier.verify(minted), minted); } catch { principal = null; }
      if (!principal || !principal.active) return refuse('PRINCIPAL_UNKNOWN', `${caller.caller_id} has no active identity; the identity service must know the agent before it may act`);
      bearer = minted;
    } else {
      return refuse('NO_PRINCIPAL', 'A service caller must forward the token of the person it acts for');
    }
    if (!mayUse(d.permission, principal.perms)) return refuse('PERMISSION', `${principal.name} does not hold ${d.permission}`, principal);

    const checked = validate(d, rawArgs);
    if (!checked.ok) return refuse('BAD_ARGS', checked.reason, principal);
    const args = checked.args;
    const req = buildRequest(d, args, process.env);
    if (opts.dryRun) {
      const callId = await this.logCall({ callerId, principal, tool: d.name, tier: d.tier, module: d.module, args, outcome: 'DRY_RUN', upstream: `${d.upstream.service} ${d.upstream.path}`, latencyMs: Date.now() - started, decisionId: opts.decisionId, cause: opts.cause });
      return { callId, outcome: 'DRY_RUN', ...base, latencyMs: Date.now() - started, principal: { id: principal.id, name: principal.name, kind: principal.kind }, request: { method: req.method, url: req.url, body: req.body } };
    }

    const ctx = getContext();
    const headers: Record<string, string> = { authorization: `Bearer ${bearer}`, accept: 'application/json', 'x-ai-caller': callerId, ...(ctx?.correlationId ? { 'x-correlation-id': ctx.correlationId } : {}), ...(opts.decisionId ? { 'x-ai-decision': opts.decisionId } : {}) };
    if (req.body !== undefined) headers['content-type'] = 'application/json';
    let status = 0; let payload: { success?: boolean; data?: unknown; message?: string; meta?: unknown } = {};
    try {
      const res = await this.fetchFn(req.url, { method: req.method, headers, body: req.body === undefined ? undefined : JSON.stringify(req.body), signal: AbortSignal.timeout(this.env.TOOL_TIMEOUT_MS) });
      status = res.status;
      const text = await res.text();
      try { payload = text ? (JSON.parse(text) as typeof payload) : {}; } catch { payload = { success: false, message: text.slice(0, 200) }; }
    } catch (err) {
      const callId = await this.logCall({ callerId, principal, tool: d.name, tier: d.tier, module: d.module, args, outcome: 'FAILED', reason: (err as Error).message, upstream: `${d.upstream.service} ${d.upstream.path}`, latencyMs: Date.now() - started, decisionId: opts.decisionId, cause: opts.cause });
      return { callId, outcome: 'FAILED', ...base, reason: `${d.upstream.service} did not answer: ${(err as Error).message}`, latencyMs: Date.now() - started, principal: { id: principal.id, name: principal.name, kind: principal.kind } };
    }
    const ok = status >= 200 && status < 300 && payload.success !== false;
    const latencyMs = Date.now() - started;
    const callId = await this.logCall({ callerId, principal, tool: d.name, tier: d.tier, module: d.module, args, outcome: ok ? 'OK' : 'FAILED', reason: ok ? '' : String(payload.message ?? `HTTP ${status}`), status, upstream: `${d.upstream.service} ${d.upstream.path}`, latencyMs, decisionId: opts.decisionId, cause: opts.cause });
    if (ok && tierRank(d.tier) >= tierRank('ACT')) await this.recordAction(callerId, d, args, principal, callId, opts.decisionId);
    return { callId, outcome: ok ? 'OK' : 'FAILED', ...base, status, latencyMs, principal: { id: principal.id, name: principal.name, kind: principal.kind }, ...(ok ? { data: payload.meta ? { items: payload.data, meta: payload.meta } : payload.data } : { reason: String(payload.message ?? `HTTP ${status}`) }) };
  }

  /** A short-lived token for an agent: the identity service holds the agent as a principal, so the upstream sees an agent, checks its permissions and records it as the actor. */
  mintAgentToken(callerId: string, name: string): string {
    return signHS256({ sub: callerId, name, typ: 'access', kind: 'agent' }, this.env.JWT_SECRET, { expiresInSec: this.env.AGENT_TOKEN_SEC, issuer: this.env.JWT_ISSUER });
  }

  /* ------------------------------------------------------------------------------- complete --- */

  async complete(callerId: string, input: CompleteInput, opts: { userToken?: string } = {}): Promise<CompleteResult> {
    const started = Date.now();
    const callerRow = await this.caller(callerId);
    // the allow-list names tools; whether a caller may reach a model is its ceiling alone
    const verdict = checkCaller(callerRow ? { ...callerPolicy(callerRow), allowedTools: ['*'] } : null, INFER_TOOL, await this.usage(callerId));
    let principal: Principal | null = null;
    if (opts.userToken) { try { principal = await this.resolver.resolve(await this.verifier.verify(opts.userToken), opts.userToken); } catch { principal = null; } }
    const settings = await this.settings.get<AiProviderSettings>('ai', {});
    const cfg = selectProvider(settings, { timeoutMs: this.env.INFERENCE_TIMEOUT_MS, maxOutputTokens: this.env.MAX_OUTPUT_TOKENS, anthropicVersion: this.env.ANTHROPIC_VERSION, anthropicBaseUrl: this.env.ANTHROPIC_BASE_URL });
    const empty = { redactions: 0, redactionKinds: {}, injection: { score: 0, flags: [] as string[] } };
    const base = { provider: cfg.provider, profile: cfg.profile, residency: cfg.residency };
    if (!verdict.ok) {
      await this.logInference({ callerId, principal, purpose: input.purpose, cfg, promptFingerprint: '', promptChars: 0, blocks: 0, ...empty, outcome: 'REFUSED', reason: verdict.reason!, latencyMs: Date.now() - started });
      return { outcome: 'REFUSED', ...base, code: verdict.code, reason: verdict.reason, latencyMs: Date.now() - started, ...empty };
    }

    // What leaves: every text with personal data masked, every record fenced, the whole classified for the shapes an attack takes.
    let redactions = 0; const redactionKinds: Record<string, number> = {};
    const mask = (s: string) => { const r = redactPii(s); redactions += r.redactions; for (const [k, v] of Object.entries(r.kinds)) redactionKinds[k] = (redactionKinds[k] ?? 0) + v; return r.text; };
    const grounding: Block[] = input.grounding.map((b) => ({ ...b, label: mask(b.label), text: mask(b.text) }));
    const req: ChatRequest = { ...input, question: mask(input.question), grounding, findings: input.findings.map(mask), refusals: input.refusals.map(mask), history: input.history.map((h) => ({ ...h, text: mask(h.text) })) };
    const scored = classifyInjection([req.question, ...req.history.map((h) => h.text), ...grounding.map((b) => b.text)].join('\n'));
    for (const b of grounding) if (classifyInjection(b.text).score > 0) b.untrusted = true;
    const prompt = buildPrompt(req);
    const promptChars = prompt.system.length + prompt.user.length;
    const fp = fingerprint(cfg.provider, cfg.profile, prompt.system, prompt.user);
    const common = { callerId, principal, purpose: input.purpose, cfg, promptFingerprint: fp, promptChars, blocks: grounding.length, redactions, redactionKinds, injection: scored };
    if (scored.score >= this.env.INJECTION_BLOCK_SCORE) {
      const reason = `Refused before any model saw it: adversarial score ${scored.score} (${scored.flags.join(', ')})`;
      await this.logInference({ ...common, outcome: 'REFUSED', reason, latencyMs: Date.now() - started });
      await this.recordRefusal(callerId, 'infer.complete', 'INJECTION', reason, principal ?? undefined);
      return { outcome: 'REFUSED', ...base, code: 'INJECTION', reason, latencyMs: Date.now() - started, redactions, redactionKinds, injection: scored, fingerprint: fp };
    }
    if (cfg.provider === 'local') {
      await this.logInference({ ...common, outcome: 'LOCAL', reason: 'No hosted provider is configured; the caller composes locally', latencyMs: Date.now() - started });
      return { outcome: 'LOCAL', ...base, code: 'NO_PROVIDER', reason: 'No hosted provider is configured in Settings → AI', latencyMs: Date.now() - started, redactions, redactionKinds, injection: scored, fingerprint: fp, tokensIn: estimateTokens(prompt.user) };
    }
    try {
      const r = await callProvider(cfg, prompt, input.temperature ?? (typeof settings.temperature === 'number' ? settings.temperature : undefined), this.fetchFn);
      const latencyMs = Date.now() - started;
      await this.logInference({ ...common, outcome: 'OK', reason: '', latencyMs, tokensIn: r.tokensIn, tokensOut: r.tokensOut, replyChars: r.text.length });
      return { outcome: 'OK', ...base, text: r.text, latencyMs, redactions, redactionKinds, injection: scored, fingerprint: fp, tokensIn: r.tokensIn, tokensOut: r.tokensOut };
    } catch (err) {
      const reason = (err as Error).message;
      await this.logInference({ ...common, outcome: 'FAILED', reason, latencyMs: Date.now() - started });
      return { outcome: 'FAILED', ...base, reason, latencyMs: Date.now() - started, redactions, redactionKinds, injection: scored, fingerprint: fp };
    }
  }

  /* ------------------------------------------------------------------------------ evidence --- */

  private async logCall(e: { callerId: string; principal?: Principal | null; tool: string; tier: Tier; module: string; args: Record<string, unknown>; outcome: Outcome; code?: RefusalCode; reason?: string; status?: number; upstream: string; latencyMs: number; decisionId?: string; cause?: string }): Promise<string> {
    const red = redactArgs(e.args);
    const r = await this.pool.query<{ id: string }>(
      `INSERT INTO tool_calls(caller_id, principal_id, principal_name, principal_kind, tool, tier, module, args_hash, args_redacted, outcome, refusal_code, reason, http_status, upstream, latency_ms, redactions, cause, decision_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) RETURNING id`,
      [e.callerId, e.principal?.id ?? '', e.principal?.name ?? '', e.principal?.kind ?? (e.principal ? 'user' : 'none'), e.tool, e.tier, e.module, argsHash(e.args), JSON.stringify(red.args), e.outcome, e.code ?? '', (e.reason ?? '').slice(0, 500), e.status ?? null, e.upstream, e.latencyMs, red.redactions, (e.cause ?? '').slice(0, 200), e.decisionId ?? null]);
    return r.rows[0].id;
  }

  private async logInference(e: { callerId: string; principal?: Principal | null; purpose?: string; cfg: { provider: string; profile: string; residency: string }; promptFingerprint: string; promptChars: number; blocks: number; redactions: number; redactionKinds: Record<string, number>; injection: { score: number; flags: string[] }; outcome: CompleteResult['outcome']; reason: string; latencyMs: number; tokensIn?: number; tokensOut?: number; replyChars?: number }) {
    await this.pool.query(
      `INSERT INTO inferences(caller_id, principal_id, principal_name, purpose, provider, profile, residency, prompt_fingerprint, prompt_chars, grounding_blocks, redactions, redaction_kinds, injection_score, injection_flags, outcome, reason, latency_ms, tokens_in, tokens_out, reply_chars)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)`,
      [e.callerId, e.principal?.id ?? '', e.principal?.name ?? '', e.purpose ?? 'answer', e.cfg.provider, e.cfg.profile, e.cfg.residency, e.promptFingerprint, e.promptChars, e.blocks, e.redactions, JSON.stringify(e.redactionKinds), e.injection.score, e.injection.flags, e.outcome, e.reason.slice(0, 500), e.latencyMs, e.tokensIn ?? 0, e.tokensOut ?? 0, e.replyChars ?? 0]);
  }

  /** An action that changed a record is on the ledger twice: once by the upstream as the agent's act, once here as the gateway's admission of it. */
  private async recordAction(callerId: string, d: ToolDef, args: Record<string, unknown>, principal: Principal, callId: string, decisionId?: string) {
    const red = redactArgs(args).args;
    await withTx(this.pool, async (c) => {
      await this.audit.record(c, { action: 'AI_TOOL_ACTED', entity: 'AiToolCall', entityId: callId, entityLabel: d.name, after: { caller: callerId, tool: d.name, tier: d.tier, module: d.module, args: red, decisionId: decisionId ?? null }, actor: { id: principal.id, name: principal.name, kind: principal.kind } });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.ai.toolActed, { callId, caller: callerId, tool: d.name, tier: d.tier, module: d.module, principalId: principal.id, decisionId: decisionId ?? null }, { subject: callId, actor: { id: principal.id, name: principal.name, kind: principal.kind === 'agent' ? 'agent' : 'user' } }));
    });
  }

  private async recordRefusal(callerId: string, tool: string, code: RefusalCode, reason: string, principal?: Principal) {
    await withTx(this.pool, async (c) => {
      await this.audit.record(c, { action: 'AI_TOOL_REFUSED', entity: 'AiToolCall', entityLabel: tool, after: { caller: callerId, tool, code, reason }, actor: principal ? { id: principal.id, name: principal.name, kind: principal.kind } : { id: callerId, name: callerId, kind: 'agent' } });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.ai.toolRefused, { caller: callerId, tool, code, reason }, { subject: callerId }));
    });
  }

  /* ---------------------------------------------------------------------------- governance --- */

  async calls(f: { caller?: string; outcome?: string; tool?: string; module?: string; tier?: string; sinceHours?: number; limit?: number }) {
    const where: string[] = []; const args: unknown[] = [];
    const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
    if (f.caller) add('caller_id = ?', f.caller);
    if (f.outcome) add('outcome = ?', f.outcome);
    if (f.tool) add('tool = ?', f.tool);
    if (f.module) add('module = ?', f.module);
    if (f.tier && isTier(f.tier)) add('tier = ?', f.tier);
    add('at > now() - (?::int * interval \'1 hour\')', Math.min(24 * 90, Math.max(1, f.sinceHours ?? 24 * 7)));
    args.push(Math.min(500, Math.max(1, f.limit ?? 100)));
    const r = await this.pool.query(`SELECT * FROM tool_calls WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT $${args.length}`, args);
    return r.rows.map(callApi);
  }

  async inferences(f: { caller?: string; outcome?: string; sinceHours?: number; limit?: number }) {
    const where: string[] = []; const args: unknown[] = [];
    const add = (sql: string, v: unknown) => { args.push(v); where.push(sql.replace('?', `$${args.length}`)); };
    if (f.caller) add('caller_id = ?', f.caller);
    if (f.outcome) add('outcome = ?', f.outcome);
    add('at > now() - (?::int * interval \'1 hour\')', Math.min(24 * 90, Math.max(1, f.sinceHours ?? 24 * 7)));
    args.push(Math.min(500, Math.max(1, f.limit ?? 100)));
    const r = await this.pool.query(`SELECT * FROM inferences WHERE ${where.join(' AND ')} ORDER BY at DESC LIMIT $${args.length}`, args);
    return r.rows.map(inferenceApi);
  }

  async stats() {
    const [calls, byOutcome, byCaller, byTier, byModule, byTool, refusals, infer, byDay, callers] = await Promise.all([
      this.pool.query<{ h24: string; d7: string; d30: string; failed24: string; refused24: string; p50: string | null; p95: string | null }>(
        `SELECT count(*) FILTER (WHERE at > now() - interval '24 hours') AS h24, count(*) FILTER (WHERE at > now() - interval '7 days') AS d7, count(*) AS d30,
                count(*) FILTER (WHERE at > now() - interval '24 hours' AND outcome = 'FAILED') AS failed24, count(*) FILTER (WHERE at > now() - interval '24 hours' AND outcome = 'REFUSED') AS refused24,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE outcome = 'OK' AND at > now() - interval '7 days') AS p50,
                percentile_cont(0.95) WITHIN GROUP (ORDER BY latency_ms) FILTER (WHERE outcome = 'OK' AND at > now() - interval '7 days') AS p95
         FROM tool_calls WHERE at > now() - interval '30 days'`),
      this.pool.query<{ outcome: string; n: string }>(`SELECT outcome, count(*) AS n FROM tool_calls WHERE at > now() - interval '7 days' GROUP BY outcome`),
      this.pool.query<{ caller_id: string; n: string; refused: string; failed: string; acted: string }>(`SELECT caller_id, count(*) AS n, count(*) FILTER (WHERE outcome = 'REFUSED') AS refused, count(*) FILTER (WHERE outcome = 'FAILED') AS failed, count(*) FILTER (WHERE outcome = 'OK' AND tier IN ('ACT', 'PROPOSE')) AS acted FROM tool_calls WHERE at > now() - interval '7 days' GROUP BY caller_id ORDER BY n DESC`),
      this.pool.query<{ tier: string; n: string }>(`SELECT tier, count(*) AS n FROM tool_calls WHERE at > now() - interval '7 days' AND outcome = 'OK' GROUP BY tier`),
      this.pool.query<{ module: string; n: string }>(`SELECT module, count(*) AS n FROM tool_calls WHERE at > now() - interval '7 days' AND outcome = 'OK' GROUP BY module ORDER BY n DESC`),
      this.pool.query<{ tool: string; n: string; p50: string | null }>(`SELECT tool, count(*) AS n, percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50 FROM tool_calls WHERE at > now() - interval '7 days' AND outcome = 'OK' GROUP BY tool ORDER BY n DESC LIMIT 12`),
      this.pool.query<{ refusal_code: string; n: string }>(`SELECT refusal_code, count(*) AS n FROM tool_calls WHERE at > now() - interval '7 days' AND outcome = 'REFUSED' GROUP BY refusal_code ORDER BY n DESC`),
      this.pool.query<{ provider: string; outcome: string; n: string; tokens_in: string; tokens_out: string; redactions: string; flagged: string; p50: string | null }>(
        `SELECT provider, outcome, count(*) AS n, coalesce(sum(tokens_in), 0) AS tokens_in, coalesce(sum(tokens_out), 0) AS tokens_out, coalesce(sum(redactions), 0) AS redactions, count(*) FILTER (WHERE injection_score > 0) AS flagged,
                percentile_cont(0.5) WITHIN GROUP (ORDER BY latency_ms) AS p50 FROM inferences WHERE at > now() - interval '7 days' GROUP BY provider, outcome ORDER BY n DESC`),
      this.pool.query<{ day: string; ok: string; refused: string; failed: string; inferences: string }>(
        `SELECT d::date::text AS day,
                (SELECT count(*) FROM tool_calls t WHERE t.at::date = d::date AND t.outcome = 'OK') AS ok,
                (SELECT count(*) FROM tool_calls t WHERE t.at::date = d::date AND t.outcome = 'REFUSED') AS refused,
                (SELECT count(*) FROM tool_calls t WHERE t.at::date = d::date AND t.outcome = 'FAILED') AS failed,
                (SELECT count(*) FROM inferences i WHERE i.at::date = d::date) AS inferences
         FROM generate_series(now()::date - 13, now()::date, interval '1 day') d ORDER BY d`),
      this.pool.query<CallerRow>('SELECT * FROM callers ORDER BY kind, caller_id'),
    ]);
    const c = calls.rows[0];
    const usage = await Promise.all(callers.rows.map(async (r) => ({ ...callerApi(r), usage: await this.usage(r.caller_id) })));
    return {
      calls: { last24h: Number(c.h24), last7d: Number(c.d7), last30d: Number(c.d30), failed24h: Number(c.failed24), refused24h: Number(c.refused24), p50Ms: c.p50 == null ? null : Math.round(Number(c.p50)), p95Ms: c.p95 == null ? null : Math.round(Number(c.p95)) },
      byOutcome: Object.fromEntries(byOutcome.rows.map((r) => [r.outcome, Number(r.n)])),
      byCaller: byCaller.rows.map((r) => ({ callerId: r.caller_id, calls: Number(r.n), refused: Number(r.refused), failed: Number(r.failed), acted: Number(r.acted) })),
      byTier: Object.fromEntries(byTier.rows.map((r) => [r.tier, Number(r.n)])),
      byModule: byModule.rows.map((r) => ({ module: r.module, calls: Number(r.n) })),
      byTool: byTool.rows.map((r) => ({ tool: r.tool, calls: Number(r.n), p50Ms: r.p50 == null ? null : Math.round(Number(r.p50)) })),
      refusals: refusals.rows.map((r) => ({ code: r.refusal_code, count: Number(r.n) })),
      inferences: infer.rows.map((r) => ({ provider: r.provider, outcome: r.outcome, count: Number(r.n), tokensIn: Number(r.tokens_in), tokensOut: Number(r.tokens_out), redactions: Number(r.redactions), flagged: Number(r.flagged), p50Ms: r.p50 == null ? null : Math.round(Number(r.p50)) })),
      byDay: byDay.rows.map((r) => ({ day: r.day, ok: Number(r.ok), refused: Number(r.refused), failed: Number(r.failed), inferences: Number(r.inferences) })),
      callers: usage,
      tools: { registered: TOOLS.length, byTier: Object.fromEntries((['READ', 'PROPOSE', 'ACT', 'INFER'] as Tier[]).map((t) => [t, TOOLS.filter((x) => x.tier === t).length])) },
      generatedAt: new Date().toISOString(),
    };
  }

  async listCallers() {
    const r = await this.pool.query<CallerRow>('SELECT * FROM callers ORDER BY kind, caller_id');
    return Promise.all(r.rows.map(async (row) => ({ ...callerApi(row), usage: await this.usage(row.caller_id) })));
  }

  async updateCaller(callerId: string, patch: { allowedTools?: string[]; maxTier?: Tier; hourlyQuota?: number; dailyQuota?: number; enabled?: boolean; note?: string }, by: Principal) {
    const before = await this.caller(callerId);
    if (!before) return null;
    const next = {
      allowed_tools: patch.allowedTools ?? before.allowed_tools, max_tier: patch.maxTier ?? before.max_tier, hourly_quota: patch.hourlyQuota ?? before.hourly_quota,
      daily_quota: patch.dailyQuota ?? before.daily_quota, enabled: patch.enabled ?? before.enabled, note: patch.note ?? before.note,
    };
    const row = await withTx(this.pool, async (c) => {
      const r = await c.query<CallerRow>('UPDATE callers SET allowed_tools = $2, max_tier = $3, hourly_quota = $4, daily_quota = $5, enabled = $6, note = $7, updated_by = $8, updated_at = now() WHERE caller_id = $1 RETURNING *',
        [callerId, next.allowed_tools, next.max_tier, next.hourly_quota, next.daily_quota, next.enabled, next.note, by.name]);
      await this.audit.record(c, { action: 'AI_CALLER_CONFIGURED', entity: 'AiCaller', entityId: callerId, entityLabel: before.label, before: callerApi(before), after: callerApi(r.rows[0]) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.ai.callerConfigured, callerApi(r.rows[0]), { subject: callerId }));
      return r.rows[0];
    });
    return { ...callerApi(row), usage: await this.usage(callerId) };
  }

  async setToolEnabled(name: string, enabled: boolean, by: Principal) {
    const def = toolByName(name);
    if (!def) return null;
    await withTx(this.pool, async (c) => {
      await c.query('UPDATE tools SET enabled = $2, updated_at = now() WHERE name = $1', [name, enabled]);
      await this.audit.record(c, { action: enabled ? 'AI_TOOL_ENABLED' : 'AI_TOOL_DISABLED', entity: 'AiTool', entityId: name, entityLabel: def.label, after: { enabled, by: by.name } });
    });
    return { ...def, enabled };
  }
}

/* ----------------------------------------------------------------------------------- helpers --- */

export async function syncRegistry(pool: Pool) {
  for (const t of TOOLS) {
    await pool.query(
      `INSERT INTO tools(name, module, label, label_ar, description, tier, permission, exposure, upstream, input_schema, triggers)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       ON CONFLICT (name) DO UPDATE SET module = EXCLUDED.module, label = EXCLUDED.label, label_ar = EXCLUDED.label_ar, description = EXCLUDED.description, tier = EXCLUDED.tier, permission = EXCLUDED.permission, exposure = EXCLUDED.exposure, upstream = EXCLUDED.upstream, input_schema = EXCLUDED.input_schema, triggers = EXCLUDED.triggers, updated_at = now()`,
      [t.name, t.module, t.label, t.labelAr, t.description, t.tier, t.permission, t.exposure, JSON.stringify(t.upstream), JSON.stringify(t.input), t.triggers]);
  }
}

/** The registry's argument specs are the policy's shapes plus a description. */
const validate = (d: ToolDef, raw: unknown) => validateArgs(d.input, raw);

/** The HTTP call a tool call becomes. Path placeholders come from the arguments; the rest travel as the query or the body. */
export function buildRequest(d: ToolDef, args: Record<string, unknown>, env: Record<string, string | undefined>): { method: string; url: string; body?: unknown } {
  const svc = serviceByName(d.upstream.service);
  if (!svc) throw new Error(`Unknown upstream service ${d.upstream.service}`);
  const used = new Set<string>();
  const path = d.upstream.path.replace(/\{(\w+)\}/g, (_m, k: string) => { used.add(k); return encodeURIComponent(String(args[k] ?? '')); });
  const rest: Record<string, unknown> = { ...(d.upstream.constants ?? {}) };
  for (const [k, v] of Object.entries(args)) if (!used.has(k)) rest[k] = v;
  const base = urlOf(svc, env);
  if (d.upstream.method === 'GET') {
    const qs = new URLSearchParams(); for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const s = qs.toString();
    return { method: 'GET', url: `${base}${path}${s ? `?${s}` : ''}` };
  }
  return { method: d.upstream.method, url: `${base}${path}`, body: rest };
}

export const callApi = (r: Record<string, unknown>) => ({
  id: r.id, at: r.at, callerId: r.caller_id, principalId: r.principal_id, principalName: r.principal_name, principalKind: r.principal_kind, tool: r.tool, tier: r.tier, module: r.module,
  argsHash: r.args_hash, args: r.args_redacted, outcome: r.outcome, refusalCode: r.refusal_code, reason: r.reason, httpStatus: r.http_status, upstream: r.upstream, latencyMs: r.latency_ms, redactions: r.redactions, cause: r.cause, decisionId: r.decision_id,
});
export const inferenceApi = (r: Record<string, unknown>) => ({
  id: r.id, at: r.at, callerId: r.caller_id, principalId: r.principal_id, principalName: r.principal_name, purpose: r.purpose, provider: r.provider, profile: r.profile, residency: r.residency,
  promptFingerprint: r.prompt_fingerprint, promptChars: r.prompt_chars, groundingBlocks: r.grounding_blocks, redactions: r.redactions, redactionKinds: r.redaction_kinds, injectionScore: Number(r.injection_score), injectionFlags: r.injection_flags,
  outcome: r.outcome, reason: r.reason, latencyMs: r.latency_ms, tokensIn: r.tokens_in, tokensOut: r.tokens_out, replyChars: r.reply_chars,
});
export const callerApi = (r: CallerRow) => ({ callerId: r.caller_id, label: r.label, kind: r.kind, allowedTools: r.allowed_tools, maxTier: r.max_tier, hourlyQuota: r.hourly_quota, dailyQuota: r.daily_quota, enabled: r.enabled, note: r.note });
