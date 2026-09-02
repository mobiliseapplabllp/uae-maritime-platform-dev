/* In-process copy of the rules service engine (services/rules/src/engine.ts); see expr.ts for the same note. */
/* Rule-set evaluation on top of the expression language: fee schedules produce lines and a subtotal, eligibility and
 * validation sets produce pass/fail results, SLA sets produce a number of days. Money is rounded per line to two
 * decimals and summed in integer minor units, as the reference invoice maths does. */
import { z } from 'zod';
import type { RuleSetKind } from '@maritime/contracts';
import { compile, evaluate, truthy, type Expr, type ExprOptions } from './expr';

const expr = z.unknown();
export const feeLineSchema = z.object({
  code: z.string().min(1).max(40), description: z.string().min(1).max(200), descriptionAr: z.string().max(200).optional().nullable(),
  when: expr.optional(), qty: expr.optional(), rate: expr.optional(), amount: expr.optional(), unit: z.string().max(40).optional().nullable(), taxable: z.boolean().optional().default(true),
});
export const checkSchema = z.object({
  code: z.string().min(1).max(60), message: z.string().min(1).max(400), messageAr: z.string().max(400).optional().nullable(), severity: z.enum(['ERROR', 'WARN']).optional().default('ERROR'), when: expr,
});
export const feeDefinitionSchema = z.object({ lines: z.array(feeLineSchema).min(1) });
export const checksDefinitionSchema = z.object({ checks: z.array(checkSchema).min(1) });
export const slaDefinitionSchema = z.object({ days: expr.refine((d) => d !== undefined, 'days is required') });
export type FeeLineDef = z.infer<typeof feeLineSchema>;
export type CheckDef = z.infer<typeof checkSchema>;
export type RuleDefinition = { lines: FeeLineDef[] } | { checks: CheckDef[] } | { days: Expr };

/** Accepts a bare list (fee lines or checks) or the wrapped object, and validates it for the kind. Throws ZodError. */
export function normaliseDefinition(kind: RuleSetKind, input: unknown): RuleDefinition {
  if (kind === 'FEE') return feeDefinitionSchema.parse(Array.isArray(input) ? { lines: input } : input);
  if (kind === 'SLA') return slaDefinitionSchema.parse(typeof input === 'object' && input !== null && 'days' in (input as object) ? input : { days: input }) as { days: Expr };
  return checksDefinitionSchema.parse(Array.isArray(input) ? { checks: input } : input);
}
/** Every expression of a definition compiles; returns the list of problems (empty when clean). */
export function compileDefinition(kind: RuleSetKind, def: RuleDefinition, parameters: Record<string, unknown> = {}): string[] {
  const problems: string[] = [];
  const check = (e: Expr | undefined, at: string) => { if (e === undefined) return; const r = compile(e, { tables: parameters }); for (const err of r.errors) problems.push(`${at}: ${err}`); };
  if (kind === 'FEE') { const d = def as { lines: FeeLineDef[] }; d.lines.forEach((l, i) => { check(l.when, `lines[${i}].when`); check(l.qty, `lines[${i}].qty`); check(l.rate, `lines[${i}].rate`); check(l.amount, `lines[${i}].amount`); if (l.amount === undefined && l.rate === undefined) problems.push(`lines[${i}]: needs an amount or a rate`); }); }
  else if (kind === 'SLA') check((def as { days: Expr }).days, 'days');
  else (def as { checks: CheckDef[] }).checks.forEach((c, i) => check(c.when, `checks[${i}].when`));
  return problems;
}

export interface FeeLineResult { code: string; description: string; descriptionAr: string | null; unit: string | null; qty: number; rate: number; amount: number; taxable: boolean }
export interface FeeResult { kind: 'FEE'; lines: FeeLineResult[]; subtotal: number; taxableSubtotal: number; currency: string | null }
export interface CheckResult { kind: 'ELIGIBILITY' | 'VALIDATION'; passed: boolean; results: { code: string; message: string; messageAr: string | null; severity: 'ERROR' | 'WARN'; failed: boolean }[]; failed: string[]; warnings: string[] }
export interface SlaResult { kind: 'SLA'; days: number }
export type RuleResult = FeeResult | CheckResult | SlaResult;

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const minor = (n: number) => Math.round(n * 100);

/** Evaluate a rule set for a context. Parameters are exposed as `params.*` and as lookup tables; `now` is fixed by the caller. */
export function evaluateRuleSet(kind: RuleSetKind, definition: RuleDefinition, parameters: Record<string, unknown>, context: Record<string, unknown>, options: ExprOptions = {}): RuleResult {
  const now = options.now ?? (typeof context.now === 'string' ? new Date(context.now) : new Date());
  const data = { ...context, params: parameters, now: now.toISOString() };
  const opts: ExprOptions = { ...options, now, tables: { ...parameters, ...(options.tables ?? {}) } };
  const ev = (e: Expr) => evaluate(e, data, opts);
  if (kind === 'FEE') {
    const lines: FeeLineResult[] = [];
    for (const l of (definition as { lines: FeeLineDef[] }).lines) {
      if (l.when !== undefined && !truthy(ev(l.when))) continue;
      const qty = l.qty === undefined ? 1 : Number(ev(l.qty));
      if (!Number.isFinite(qty)) throw new Error(`Fee line ${l.code}: quantity is not a number`);
      let rate = l.rate === undefined ? 0 : Number(ev(l.rate));
      let amount: number;
      if (l.amount !== undefined) { amount = round2(Number(ev(l.amount))); if (l.rate === undefined) rate = qty ? round2(amount / qty) : amount; }
      else amount = round2(qty * rate);
      if (!Number.isFinite(amount) || !Number.isFinite(rate)) throw new Error(`Fee line ${l.code}: amount is not a number`);
      if (qty === 0 || amount === 0) continue;
      lines.push({ code: l.code, description: l.description, descriptionAr: l.descriptionAr ?? null, unit: l.unit ?? null, qty, rate, amount, taxable: l.taxable !== false });
    }
    const subtotalM = lines.reduce((s, l) => s + minor(l.amount), 0);
    const taxableM = lines.filter((l) => l.taxable).reduce((s, l) => s + minor(l.amount), 0);
    return { kind: 'FEE', lines, subtotal: subtotalM / 100, taxableSubtotal: taxableM / 100, currency: typeof parameters.currency === 'string' ? parameters.currency : null };
  }
  if (kind === 'SLA') {
    const days = Number(ev((definition as { days: Expr }).days));
    if (!Number.isFinite(days) || days < 0) throw new Error('SLA rule did not produce a number of days');
    return { kind: 'SLA', days: Math.ceil(days) };
  }
  const results = (definition as { checks: CheckDef[] }).checks.map((c) => ({ code: c.code, message: c.message, messageAr: c.messageAr ?? null, severity: c.severity ?? 'ERROR', failed: truthy(ev(c.when)) }));
  const failed = results.filter((r) => r.failed && r.severity === 'ERROR').map((r) => r.code);
  const warnings = results.filter((r) => r.failed && r.severity === 'WARN').map((r) => r.code);
  return { kind, passed: failed.length === 0, results, failed, warnings };
}
