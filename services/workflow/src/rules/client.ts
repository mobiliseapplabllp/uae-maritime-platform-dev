/* How the engine reaches the rules service. `http` posts to the service-only evaluate endpoint with the service token;
 * `inline` runs the in-process evaluator over the published rule sets mirrored in `rule_set_cache` (seeded, then kept
 * current by rules.ruleset.published events). The http client falls back to inline when the service is unreachable. */
import type { Pool } from 'pg';
import type { RuleSetKind } from '@maritime/contracts';
import { unprocessable, type AppLogger } from '@maritime/service-kit';
import { compile, evaluate, ExprError, type CompileResult, type Expr, type ExprOptions } from './expr';
import { evaluateRuleSet, type RuleDefinition, type RuleResult } from './engine';

export interface CachedRuleSet { key: string; kind: RuleSetKind; version: number; definition: RuleDefinition; parameters: Record<string, unknown> }
export interface RuleSetSource { load(key: string): Promise<CachedRuleSet | null> }
export type SetResult = RuleResult & { key: string; version: number };
export interface RulesClient {
  evaluateExpr(expr: Expr, context: Record<string, unknown>, now?: Date): Promise<unknown>;
  evaluateSet(key: string, context: Record<string, unknown>, now?: Date): Promise<SetResult>;
  compile(expr: Expr, tables?: Record<string, unknown>): CompileResult;
}

export class PgRuleSetSource implements RuleSetSource {
  constructor(private readonly pool: Pool) {}
  async load(key: string) { const r = await this.pool.query<CachedRuleSet>('SELECT key, kind, version, definition, parameters FROM rule_set_cache WHERE key = $1', [key]); return r.rows[0] ?? null; }
}
export class MapRuleSetSource implements RuleSetSource {
  constructor(private readonly sets: Record<string, CachedRuleSet>) {}
  async load(key: string) { return this.sets[key] ?? null; }
}

export class InlineRulesClient implements RulesClient {
  constructor(private readonly source: RuleSetSource, private readonly opts: { maxDepth?: number; timeoutMs?: number } = {}) {}
  private options(now?: Date): ExprOptions { return { maxDepth: this.opts.maxDepth, timeoutMs: this.opts.timeoutMs, now }; }
  async evaluateExpr(expr: Expr, context: Record<string, unknown>, now?: Date) {
    try { return evaluate(expr, context, this.options(now)); } catch (e) { if (e instanceof ExprError) throw unprocessable(`Expression failed: ${e.message}`); throw e; }
  }
  async evaluateSet(key: string, context: Record<string, unknown>, now?: Date): Promise<SetResult> {
    const set = await this.source.load(key);
    if (!set) throw unprocessable(`Rule set ${key} is not published`);
    try { return { key, version: set.version, ...evaluateRuleSet(set.kind, set.definition, set.parameters, context, this.options(now)) }; }
    catch (e) { throw unprocessable(`Rule set ${key} v${set.version} failed: ${(e as Error).message}`); }
  }
  compile(expr: Expr, tables?: Record<string, unknown>) { return compile(expr, { maxDepth: this.opts.maxDepth, tables }); }
}

export class HttpRulesClient implements RulesClient {
  constructor(private readonly url: string, private readonly token: string, private readonly fallback: InlineRulesClient, private readonly log?: AppLogger) {}
  private async call<T>(body: Record<string, unknown>, onDown: () => Promise<T>): Promise<T> {
    let res: Response;
    try { res = await fetch(`${this.url}/internal/rules/evaluate`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': this.token }, body: JSON.stringify(body) }); }
    catch (e) { this.log?.warn({ err: e }, 'rules service unreachable; evaluating inline'); return onDown(); }
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; message?: string };
    if (!res.ok || !json.success) throw unprocessable(json.message ?? `Rules service answered ${res.status}`);
    return json.data as T;
  }
  async evaluateExpr(expr: Expr, context: Record<string, unknown>, now?: Date) {
    const r = await this.call<{ value: unknown }>({ expr, context, now: now?.toISOString() }, async () => ({ value: await this.fallback.evaluateExpr(expr, context, now) }));
    return r.value;
  }
  async evaluateSet(key: string, context: Record<string, unknown>, now?: Date) { return this.call<SetResult>({ key, context, now: now?.toISOString() }, () => this.fallback.evaluateSet(key, context, now)); }
  compile(expr: Expr, tables?: Record<string, unknown>) { return this.fallback.compile(expr, tables); }
}

export function createRulesClient(env: { RULES_MODE: 'inline' | 'http'; RULES_URL: string; SERVICE_TOKEN: string; EXPR_MAX_DEPTH: number; EXPR_TIMEOUT_MS: number }, pool: Pool, log?: AppLogger): RulesClient {
  const inline = new InlineRulesClient(new PgRuleSetSource(pool), { maxDepth: env.EXPR_MAX_DEPTH, timeoutMs: env.EXPR_TIMEOUT_MS });
  return env.RULES_MODE === 'http' ? new HttpRulesClient(env.RULES_URL, env.SERVICE_TOKEN, inline, log) : inline;
}
