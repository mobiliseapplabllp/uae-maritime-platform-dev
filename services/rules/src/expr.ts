/* A JSON-logic style expression language, implemented here so no code is ever evaluated: an expression is
 * `{ "<operator>": [args] }`; arrays evaluate element-wise; everything else is a literal. Evaluation is deterministic
 * (`now` comes from the options), depth-limited and budgeted by node count and wall-clock time. */
export type Expr = unknown;
export interface ExprOptions { maxDepth?: number; maxNodes?: number; timeoutMs?: number; now?: Date; tables?: Record<string, unknown> }
export class ExprError extends Error { constructor(message: string) { super(message); this.name = 'ExprError'; } }

export const OPERATORS = ['var', 'missing', '==', '===', '!=', '!==', '>', '>=', '<', '<=', 'and', 'or', '!', '!!', 'in', 'if', '+', '-', '*', '/', '%',
  'min', 'max', 'round', 'floor', 'ceil', 'abs', 'cat', 'upper', 'lower', 'daysBetween', 'now', 'year', 'some', 'all', 'none', 'sum', 'count', 'lookup'] as const;
export type Operator = (typeof OPERATORS)[number];
const OPS = new Set<string>(OPERATORS);
const D = 86_400_000;

/** json-logic truthiness: empty arrays are false, empty objects are true. */
export const truthy = (v: unknown): boolean => (Array.isArray(v) ? v.length > 0 : !!v);
const isNumeric = (v: unknown): boolean => typeof v === 'number' || (typeof v === 'string' && v.trim() !== '' && !Number.isNaN(Number(v)));
const num = (v: unknown, op: string): number => {
  if (typeof v === 'number') { if (!Number.isFinite(v)) throw new ExprError(`${op}: non-finite number`); return v; }
  if (v == null) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'string' && isNumeric(v)) return Number(v);
  throw new ExprError(`${op}: not a number (${JSON.stringify(v)})`);
};
const str = (v: unknown): string => (v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v));
const toTime = (v: unknown, op: string): number => {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && v.trim() !== '') { const t = Date.parse(v); if (!Number.isNaN(t)) return t; }
  throw new ExprError(`${op}: not a date (${JSON.stringify(v)})`);
};
/** Loose equality across the JSON scalar types: numbers and numeric strings agree, null and undefined agree. */
export function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === typeof b) return typeof a === 'object' ? JSON.stringify(a) === JSON.stringify(b) : false;
  if (isNumeric(a) && isNumeric(b)) return Number(a) === Number(b);
  if (typeof a === 'boolean' || typeof b === 'boolean') return (a === true ? 1 : a === false ? 0 : a) == (b === true ? 1 : b === false ? 0 : b); // eslint-disable-line eqeqeq
  return String(a) === String(b);
}
function compare(a: unknown, b: unknown, op: string): number | null {
  if (a == null || b == null) return null;
  if (isNumeric(a) && isNumeric(b)) return Number(a) - Number(b);
  if (typeof a === 'string' && typeof b === 'string') return a < b ? -1 : a > b ? 1 : 0;
  if (a instanceof Date || b instanceof Date) return toTime(a, op) - toTime(b, op);
  if (typeof a === 'boolean' && typeof b === 'boolean') return Number(a) - Number(b);
  return null;
}
const ordered = (args: unknown[], op: string, test: (c: number) => boolean): boolean => {
  for (let i = 0; i + 1 < args.length; i++) { const c = compare(args[i], args[i + 1], op); if (c == null || !test(c)) return false; }
  return args.length >= 2;
};
export function resolvePath(data: unknown, path: string): unknown {
  if (path === '' || path == null) return data;
  let cur: unknown = data;
  for (const seg of String(path).split('.')) {
    if (cur == null) return undefined;
    if (Array.isArray(cur)) { const i = Number(seg); cur = Number.isInteger(i) ? cur[i] : undefined; continue; }
    if (typeof cur === 'object') { cur = (cur as Record<string, unknown>)[seg]; continue; }
    return undefined;
  }
  return cur;
}
const bandLookup = (rows: unknown[], key: unknown, table: string): unknown => {
  const k = num(key, `lookup ${table}`);
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const row = r as { from?: unknown; to?: unknown; value?: unknown };
    const lo = row.from == null ? -Infinity : num(row.from, 'lookup'); const hi = row.to == null ? Infinity : num(row.to, 'lookup');
    if (k >= lo && k < hi) return row.value;
  }
  return undefined;
};

interface Budget { start: number; nodes: number; maxNodes: number; maxDepth: number; timeoutMs: number; now: Date; tables: Record<string, unknown> }

/** Evaluate `expr` against `data`. Throws ExprError on unknown operators, type errors, division by zero or an exhausted budget. */
export function evaluate(expr: Expr, data: unknown, options: ExprOptions = {}): unknown {
  const b: Budget = { start: Date.now(), nodes: 0, maxNodes: options.maxNodes ?? 200_000, maxDepth: options.maxDepth ?? 64, timeoutMs: options.timeoutMs ?? 250, now: options.now ?? new Date(), tables: options.tables ?? {} };
  return ev(expr, data, 0, b);
}

function ev(node: Expr, data: unknown, depth: number, b: Budget): unknown {
  if (depth > b.maxDepth) throw new ExprError(`Expression too deep (limit ${b.maxDepth})`);
  if (++b.nodes > b.maxNodes) throw new ExprError(`Expression budget exceeded (${b.maxNodes} nodes)`);
  if ((b.nodes & 255) === 0 && Date.now() - b.start > b.timeoutMs) throw new ExprError(`Expression timed out after ${b.timeoutMs}ms`);
  if (Array.isArray(node)) return node.map((n) => ev(n, data, depth + 1, b));
  if (node === null || typeof node !== 'object') return node;
  const keys = Object.keys(node as object);
  if (keys.length !== 1) return node; // a literal object
  const op = keys[0];
  if (!OPS.has(op)) throw new ExprError(`Unknown operator "${op}"`);
  const raw = (node as Record<string, unknown>)[op];
  const args: unknown[] = Array.isArray(raw) ? raw : [raw];
  const e = (n: Expr) => ev(n, data, depth + 1, b);
  const all = () => args.map(e);
  switch (op as Operator) {
    case 'var': {
      const path = e(args[0]); const v = resolvePath(data, path == null ? '' : String(path));
      return v === undefined || v === null ? (args.length > 1 ? e(args[1]) : null) : v;
    }
    case 'missing': {
      const paths = (args.length === 1 && Array.isArray(args[0]) ? (e(args[0]) as unknown[]) : all()).map(String);
      return paths.filter((p) => { const v = resolvePath(data, p); return v === undefined || v === null || v === ''; });
    }
    case '==': { const [x, y] = all(); return looseEquals(x, y); }
    case '!=': { const [x, y] = all(); return !looseEquals(x, y); }
    case '===': { const [x, y] = all(); return x === y; }
    case '!==': { const [x, y] = all(); return x !== y; }
    case '>': return ordered(all(), op, (c) => c > 0);
    case '>=': return ordered(all(), op, (c) => c >= 0);
    case '<': return ordered(all(), op, (c) => c < 0);
    case '<=': return ordered(all(), op, (c) => c <= 0);
    case 'and': { let last: unknown = true; for (const a of args) { last = e(a); if (!truthy(last)) return last; } return last; }
    case 'or': { let last: unknown = false; for (const a of args) { last = e(a); if (truthy(last)) return last; } return last; }
    case '!': return !truthy(e(args[0]));
    case '!!': return truthy(e(args[0]));
    case 'in': {
      const [needle, hay] = all();
      if (Array.isArray(hay)) return hay.some((h) => looseEquals(h, needle));
      if (typeof hay === 'string') return hay.includes(str(needle));
      return false;
    }
    case 'if': {
      let i = 0;
      for (; i + 1 < args.length; i += 2) if (truthy(e(args[i]))) return e(args[i + 1]);
      return i < args.length ? e(args[i]) : null;
    }
    case '+': return all().reduce<number>((s, v) => s + num(v, op), 0);
    case '-': { const v = all(); return v.length === 1 ? -num(v[0], op) : v.slice(1).reduce<number>((s, x) => s - num(x, op), num(v[0], op)); }
    case '*': return all().reduce<number>((s, v) => s * num(v, op), 1);
    case '/': { const [x, y] = all(); const d = num(y, op); if (d === 0) throw new ExprError('Division by zero'); return num(x, op) / d; }
    case '%': { const [x, y] = all(); const d = num(y, op); if (d === 0) throw new ExprError('Division by zero'); return num(x, op) % d; }
    case 'min': case 'max': {
      const v = all(); const flat = v.length === 1 && Array.isArray(v[0]) ? (v[0] as unknown[]) : v;
      if (!flat.length) return null;
      return flat.map((x) => num(x, op)).reduce((a, c) => (op === 'min' ? Math.min(a, c) : Math.max(a, c)));
    }
    case 'round': { const [v, d] = all(); const f = 10 ** Math.max(0, Math.min(10, Math.trunc(num(d ?? 0, op)))); return Math.round((num(v, op) + Number.EPSILON) * f) / f; }
    case 'floor': return Math.floor(num(e(args[0]), op));
    case 'ceil': return Math.ceil(num(e(args[0]), op));
    case 'abs': return Math.abs(num(e(args[0]), op));
    case 'cat': return all().map(str).join('');
    case 'upper': return str(e(args[0])).toUpperCase();
    case 'lower': return str(e(args[0])).toLowerCase();
    case 'daysBetween': { const [from, to] = all(); return Math.floor((toTime(to, op) - toTime(from, op)) / D); }
    case 'now': return b.now.toISOString();
    case 'year': return new Date(toTime(e(args[0]), op)).getUTCFullYear();
    case 'some': case 'all': case 'none': {
      const arr = e(args[0]);
      if (!Array.isArray(arr)) return op === 'none';
      if (op === 'some') return arr.some((item) => truthy(ev(args[1], item, depth + 1, b)));
      if (op === 'all') return arr.length > 0 && arr.every((item) => truthy(ev(args[1], item, depth + 1, b)));
      return !arr.some((item) => truthy(ev(args[1], item, depth + 1, b)));
    }
    case 'sum': { const arr = e(args[0]); if (!Array.isArray(arr)) return 0; return arr.reduce<number>((s, item) => s + num(args.length > 1 ? ev(args[1], item, depth + 1, b) : item, op), 0); }
    case 'count': { const arr = e(args[0]); if (!Array.isArray(arr)) return 0; return args.length > 1 ? arr.filter((item) => truthy(ev(args[1], item, depth + 1, b))).length : arr.length; }
    case 'lookup': {
      const [table, key, dflt] = [e(args[0]), e(args[1]), args.length > 2 ? e(args[2]) : undefined];
      const name = str(table); const t = resolvePath(b.tables, name);
      if (t == null) throw new ExprError(`Unknown table "${name}"`);
      const v = Array.isArray(t) ? bandLookup(t, key, name) : typeof t === 'object' ? (t as Record<string, unknown>)[str(key)] : undefined;
      return v === undefined ? (dflt === undefined ? null : dflt) : v;
    }
  }
  throw new ExprError(`Unknown operator "${op}"`);
}

const ARITY: Partial<Record<Operator, [number, number]>> = {
  var: [1, 2], '==': [2, 2], '!=': [2, 2], '===': [2, 2], '!==': [2, 2], '>': [2, 3], '>=': [2, 3], '<': [2, 3], '<=': [2, 3], '!': [1, 1], '!!': [1, 1], in: [2, 2], if: [2, Infinity],
  '/': [2, 2], '%': [2, 2], round: [1, 2], floor: [1, 1], ceil: [1, 1], abs: [1, 1], upper: [1, 1], lower: [1, 1], daysBetween: [2, 2], now: [0, 0], year: [1, 1], some: [2, 2], all: [2, 2], none: [2, 2], sum: [1, 2], count: [1, 2], lookup: [2, 3], and: [1, Infinity], or: [1, Infinity], '+': [1, Infinity], '-': [1, Infinity], '*': [1, Infinity],
};
export interface CompileResult { ok: boolean; errors: string[]; operators: string[]; depth: number }
/** Static check without evaluation: operators exist, arities hold, nesting is within the limit. Used by editors and the workflow validator. */
export function compile(expr: Expr, options: { maxDepth?: number; tables?: Record<string, unknown> } = {}): CompileResult {
  const errors: string[] = []; const operators = new Set<string>(); let maxDepth = 0; const limit = options.maxDepth ?? 64;
  const walk = (node: Expr, path: string, depth: number) => {
    maxDepth = Math.max(maxDepth, depth);
    if (depth > limit) { errors.push(`${path}: nesting deeper than ${limit}`); return; }
    if (Array.isArray(node)) { node.forEach((n, i) => walk(n, `${path}[${i}]`, depth + 1)); return; }
    if (node === null || typeof node !== 'object') return;
    const keys = Object.keys(node as object);
    if (keys.length !== 1) return;
    const op = keys[0];
    if (!OPS.has(op)) { errors.push(`${path}: unknown operator "${op}"`); return; }
    operators.add(op);
    const raw = (node as Record<string, unknown>)[op]; const args = Array.isArray(raw) ? raw : [raw];
    const ar = ARITY[op as Operator];
    if (ar && (args.length < ar[0] || args.length > ar[1])) errors.push(`${path}: "${op}" expects ${ar[0] === ar[1] ? ar[0] : `${ar[0]}-${ar[1] === Infinity ? 'n' : ar[1]}`} argument(s), got ${args.length}`);
    if (op === 'lookup' && options.tables && typeof args[0] === 'string' && resolvePath(options.tables, args[0]) == null) errors.push(`${path}: unknown table "${args[0]}"`);
    args.forEach((a, i) => walk(a, `${path}.${op}[${i}]`, depth + 1));
  };
  walk(expr, '$', 0);
  return { ok: errors.length === 0, errors, operators: [...operators], depth: maxDepth };
}
