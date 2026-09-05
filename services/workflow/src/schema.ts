/* The definition JSON one runtime interprets: form, document checklist, fees, SLA, workflow and outputs. Zod is the schema,
 * `validateContent` is the semantic check the studio runs before review, `diffContent` powers the version comparison. */
import { z } from 'zod';
import { REQUEST_STATUS, WORKFLOW_EFFECT_TYPES, WORKFLOW_STATE_KINDS } from '@maritime/contracts';
import { compile } from './rules/expr';

export const FIELD_TYPES = ['text', 'number', 'date', 'select', 'multiselect', 'boolean', 'file', 'entity'] as const;
export type FieldType = (typeof FIELD_TYPES)[number];
export const NOTIFY_AUDIENCES = ['applicant', 'staff', 'assignee'] as const;
const expr = z.unknown();
const ar = z.string().max(400).optional().nullable();
const IDENT = /^[A-Za-z][A-Za-z0-9_]*$/;

export const optionSchema = z.union([z.string().max(200), z.object({ value: z.string().max(200), label: z.string().max(200), labelAr: ar })]);
export const fieldSchema = z.object({
  key: z.string().regex(IDENT, 'field keys are identifiers'), label: z.string().min(1).max(200), labelAr: ar,
  type: z.enum(FIELD_TYPES).default('text'), required: z.boolean().default(false), options: z.array(optionSchema).default([]),
  /** A select's options come from a Data Studio master rather than an inline list: the category key. The runtime validates against its mirror and the catalogue resolves the labels. */
  lookup: z.string().regex(/^[a-z][A-Za-z0-9]*$/, 'lookup names a master category').max(60).optional().nullable(),
  validation: z.object({ min: z.number().optional(), max: z.number().optional(), minLength: z.number().int().optional(), maxLength: z.number().int().optional(), pattern: z.string().max(200).optional() }).default({}),
  visibleWhen: expr.optional(), section: z.string().max(80).default('Application'), help: z.string().max(500).default(''), helpAr: ar, multiline: z.boolean().default(false), entityKind: z.string().max(40).optional().nullable(),
});
export const formSchema = z.object({ fields: z.array(fieldSchema).default([]), sections: z.array(z.object({ key: z.string().max(80), label: z.string().max(200), labelAr: ar })).default([]) });
export const documentSchema = z.object({ code: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]*$/), label: z.string().min(1).max(200), labelAr: ar, required: z.boolean().default(true), docType: z.string().max(40).default('PDF'), acceptedFormats: z.string().max(80).default('PDF, JPG, PNG'), whenExpr: expr.optional() });
export const feeLineSchema = z.object({ code: z.string().min(1).max(40), description: z.string().min(1).max(200), descriptionAr: ar, amount: z.number().min(0), taxable: z.boolean().default(true) });
export const feesSchema = z.object({ ruleSetKey: z.string().max(120).optional().nullable(), lines: z.array(feeLineSchema).default([]), currency: z.string().max(3).optional().nullable() });
export const slaSchema = z.object({ days: z.number().min(0).default(10), ruleSetKey: z.string().max(120).optional().nullable() });
export const stateSchema = z.object({ key: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'state keys are UPPER_SNAKE'), label: z.string().min(1).max(120), labelAr: ar, kind: z.enum(WORKFLOW_STATE_KINDS), assignRole: z.string().max(60).optional().nullable(), slaDays: z.number().min(0).optional().nullable(), outcome: z.enum(REQUEST_STATUS).optional().nullable(), status: z.enum(REQUEST_STATUS).optional().nullable() });
export const effectSchema = z.object({ type: z.enum(WORKFLOW_EFFECT_TYPES), params: z.record(z.unknown()).default({}) });
export const transitionSchema = z.object({ from: z.string().max(60), to: z.string().max(60), action: z.string().regex(/^[a-z][a-z0-9_]*$/, 'actions are snake_case'), label: z.string().min(1).max(120), labelAr: ar, roles: z.array(z.string().max(60)).default(['*']), guard: expr.optional(), effects: z.array(effectSchema).default([]), requireNote: z.boolean().default(false) });
export const workflowSchema = z.object({ states: z.array(stateSchema).default([]), transitions: z.array(transitionSchema).default([]) });
export const outputsSchema = z.object({ instrumentType: z.string().max(60).optional().nullable(), instrumentClass: z.string().max(30).optional().nullable(), validityMonths: z.number().int().positive().optional().nullable(), notifications: z.array(z.object({ on: z.string().max(60), audience: z.enum(NOTIFY_AUDIENCES), template: z.string().max(120) })).default([]), templates: z.array(z.string().max(120)).default([]) });
export const contentSchema = z.object({ form: formSchema.default({}), documents: z.array(documentSchema).default([]), fees: feesSchema.default({}), sla: slaSchema.default({}), workflow: workflowSchema.default({}), outputs: outputsSchema.default({}) });

export type FormField = z.infer<typeof fieldSchema>;
export type DocumentDef = z.infer<typeof documentSchema>;
export type FeesDef = z.infer<typeof feesSchema>;
export type SlaDef = z.infer<typeof slaSchema>;
export type State = z.infer<typeof stateSchema>;
export type Effect = z.infer<typeof effectSchema>;
export type Transition = z.infer<typeof transitionSchema>;
export type Workflow = z.infer<typeof workflowSchema>;
export type Outputs = z.infer<typeof outputsSchema>;
export type DefinitionContent = z.infer<typeof contentSchema>;
export const SECTIONS = ['form', 'documents', 'fees', 'sla', 'workflow', 'outputs'] as const;

/** Parses raw JSON into the canonical content shape (defaults filled). Throws ZodError, which the envelope maps to 400. */
export const parseContent = (input: unknown): DefinitionContent => contentSchema.parse(input ?? {});

export interface Problem { path: string; message: string; severity: 'ERROR' | 'WARN' }
/** Semantic validation beyond the schema: unique keys, one START, reachable states, no dead ends, every path ends, guards and expressions compile, effects have what they need. */
export function validateContent(c: DefinitionContent, opts: { maxDepth?: number } = {}): Problem[] {
  const out: Problem[] = [];
  const err = (path: string, message: string) => out.push({ path, message, severity: 'ERROR' });
  const warn = (path: string, message: string) => out.push({ path, message, severity: 'WARN' });
  const checkExpr = (e: unknown, path: string) => { if (e === undefined) return; for (const m of compile(e, { maxDepth: opts.maxDepth }).errors) err(path, m); };
  const fieldKeys = new Set<string>();
  c.form.fields.forEach((f, i) => {
    const at = `form.fields[${i}]`;
    if (fieldKeys.has(f.key)) err(at, `duplicate field key "${f.key}"`); fieldKeys.add(f.key);
    if ((f.type === 'select' || f.type === 'multiselect') && !f.options.length && !f.lookup) err(at, `field "${f.key}" needs options or a lookup`);
    if (f.lookup && f.type !== 'select' && f.type !== 'multiselect') warn(at, `field "${f.key}": lookup is only read by select and multiselect fields`);
    if (f.lookup && f.options.length) warn(at, `field "${f.key}": both a lookup and inline options are declared; the lookup is used`);
    if (f.type === 'entity' && !f.entityKind) warn(at, `field "${f.key}" has no entityKind`);
    checkExpr(f.visibleWhen, `${at}.visibleWhen`);
  });
  const docCodes = new Set<string>();
  c.documents.forEach((d, i) => { const at = `documents[${i}]`; if (docCodes.has(d.code)) err(at, `duplicate document code "${d.code}"`); docCodes.add(d.code); checkExpr(d.whenExpr, `${at}.whenExpr`); });
  if (c.fees.ruleSetKey && c.fees.lines.length) warn('fees', 'both a fee rule set and inline lines are declared; the rule set is used');
  if (!(c.sla.days > 0) && !c.sla.ruleSetKey) err('sla.days', 'the SLA must be a positive number of days or come from a rule set');
  const w = c.workflow; const states = new Map<string, State>();
  w.states.forEach((s, i) => {
    const at = `workflow.states[${i}]`;
    if (states.has(s.key)) err(at, `duplicate state "${s.key}"`); states.set(s.key, s);
    if (s.kind === 'END' && !s.outcome) err(at, `END state "${s.key}" needs an outcome`);
    if (s.kind !== 'END' && s.outcome) warn(at, `state "${s.key}": outcome is only used by END states`);
    if (s.kind === 'START' && s.slaDays) warn(at, `state "${s.key}": a START state carries no SLA clock`);
  });
  const starts = w.states.filter((s) => s.kind === 'START');
  if (starts.length !== 1) err('workflow.states', `exactly one START state is required (found ${starts.length})`);
  if (!w.states.some((s) => s.kind === 'END')) err('workflow.states', 'at least one END state is required');
  const seenActions = new Set<string>();
  w.transitions.forEach((t, i) => {
    const at = `workflow.transitions[${i}]`;
    if (!states.has(t.from)) err(at, `unknown source state "${t.from}"`);
    if (!states.has(t.to)) err(at, `unknown target state "${t.to}"`);
    if (states.get(t.from)?.kind === 'END') err(at, `END state "${t.from}" cannot have outgoing transitions`);
    const k = `${t.from}:${t.action}`; if (seenActions.has(k)) err(at, `duplicate action "${t.action}" from "${t.from}"`); seenActions.add(k);
    if (!t.roles.length) err(at, 'at least one role (or "*") is required');
    checkExpr(t.guard, `${at}.guard`);
    t.effects.forEach((e, j) => {
      const ea = `${at}.effects[${j}]`; const p = e.params;
      if (e.type === 'computeFee' && !c.fees.ruleSetKey && !c.fees.lines.length && typeof p.ruleSetKey !== 'string') warn(ea, 'computeFee has neither a fee rule set nor inline lines; fees will be zero');
      if (e.type === 'issueInstrument' && !c.outputs.instrumentType && typeof p.instrumentType !== 'string') err(ea, 'issueInstrument needs outputs.instrumentType or params.instrumentType');
      if (e.type === 'setField') { if (typeof p.field !== 'string' || !IDENT.test(p.field)) err(ea, 'setField needs params.field (an identifier)'); checkExpr(p.value, `${ea}.params.value`); }
      if (e.type === 'callService') { if (p.service !== undefined && p.service !== 'rules') err(ea, `callService: unknown service "${String(p.service)}"`); if (typeof p.ruleSetKey !== 'string') err(ea, 'callService needs params.ruleSetKey'); }
      if (e.type === 'notify' && p.audience !== undefined && !(NOTIFY_AUDIENCES as readonly string[]).includes(String(p.audience))) err(ea, `notify: audience must be one of ${NOTIFY_AUDIENCES.join(', ')}`);
      if (e.type === 'requireDocuments' && p.mode !== undefined && p.mode !== 'attached' && p.mode !== 'verified') err(ea, 'requireDocuments: mode must be attached or verified');
    });
  });
  if (starts.length === 1) {
    const reach = new Set<string>([starts[0].key]); const queue = [starts[0].key];
    while (queue.length) { const s = queue.shift()!; for (const t of w.transitions) if (t.from === s && !reach.has(t.to)) { reach.add(t.to); queue.push(t.to); } }
    for (const s of w.states) if (!reach.has(s.key)) err('workflow.states', `state "${s.key}" is unreachable from START`);
  }
  const ends = new Set(w.states.filter((s) => s.kind === 'END').map((s) => s.key)); const queue = [...ends];
  while (queue.length) { const s = queue.shift()!; for (const t of w.transitions) if (t.to === s && !ends.has(t.from)) { ends.add(t.from); queue.push(t.from); } }
  for (const s of w.states) {
    if (s.kind !== 'END' && !w.transitions.some((t) => t.from === s.key)) err('workflow.states', `state "${s.key}" is a dead end (no outgoing transition)`);
    else if (s.kind !== 'END' && !ends.has(s.key)) err('workflow.states', `no END state is reachable from "${s.key}"`);
  }
  return out;
}

export interface Change { path: string; kind: 'added' | 'removed' | 'changed'; before?: unknown; after?: unknown }
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const keyOf = (x: unknown, i: number): string => { if (!isObj(x)) return String(i); const k = x.key ?? x.code ?? (x.from !== undefined && x.action !== undefined ? `${x.from}:${x.action}` : undefined); return k === undefined ? String(i) : String(k); };
/** Structural diff of two definition contents; list items are matched by key / code / from:action so a reordering does not read as a rewrite. */
export function diffContent(a: unknown, b: unknown, path = '$'): Change[] {
  if (same(a, b)) return [];
  if (Array.isArray(a) && Array.isArray(b)) {
    const am = new Map(a.map((x, i) => [keyOf(x, i), x])); const bm = new Map(b.map((x, i) => [keyOf(x, i), x]));
    const out: Change[] = [];
    for (const [k, v] of am) { if (!bm.has(k)) out.push({ path: `${path}[${k}]`, kind: 'removed', before: v }); else out.push(...diffContent(v, bm.get(k), `${path}[${k}]`)); }
    for (const [k, v] of bm) if (!am.has(k)) out.push({ path: `${path}[${k}]`, kind: 'added', after: v });
    return out;
  }
  if (isObj(a) && isObj(b)) {
    const out: Change[] = [];
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const p = `${path}.${k}`;
      if (!(k in b)) out.push({ path: p, kind: 'removed', before: a[k] });
      else if (!(k in a)) out.push({ path: p, kind: 'added', after: b[k] });
      else out.push(...diffContent(a[k], b[k], p));
    }
    return out;
  }
  return [{ path, kind: 'changed', before: a, after: b }];
}
