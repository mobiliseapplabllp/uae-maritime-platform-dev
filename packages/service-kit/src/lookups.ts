import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import type { Queryable } from './db';
import { badRequest } from './http/envelope';

/* Every service keeps its own copy of the masters it reads.
 *
 * Data Studio (the mdm service) owns the vocabularies — company categories, visit types, ranks, areas of
 * operation. A service that validated a form by asking mdm over HTTP would have made every write depend on
 * another service being up, which is the coupling a microservice architecture exists to remove. So each
 * service carries a mirror table, filled from the shared world at seed time and kept current by
 * `mdm.lookup.changed` events, and validates against that. The mirror is eventually consistent by a few
 * hundred milliseconds and never by a request-time call.
 *
 * The table is created by `KIT_SQL` in every service database, the same way the outbox and inbox are, so no
 * service has to remember to migrate it. Rows are keyed `category:code`, which is what mdm's uniqueness
 * constraint already guarantees is one entry. */

export interface LookupRow { id: string; category: string; code: string; label: string; label_ar: string | null; meta: Record<string, unknown>; active: boolean; updated_at: Date }
export interface LookupEntry { category: string; code: string; label: string; labelAr?: string | null; meta?: Record<string, unknown>; active?: boolean }
export interface LookupOption { code: string; label: string; labelAr: string | null; meta: Record<string, unknown>; active: boolean }

export const LOOKUP_MIRROR_SQL = `
CREATE TABLE IF NOT EXISTS lookup_mirror (
  id text PRIMARY KEY,
  category text NOT NULL,
  code text NOT NULL,
  label text NOT NULL DEFAULT '',
  label_ar text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lookup_mirror_category_idx ON lookup_mirror(category, active, code);
`;

export const lookupId = (category: string, code: string) => `${category}:${code}`;
export const lookupOption = (r: LookupRow): LookupOption => ({ code: r.code, label: r.label, labelAr: r.label_ar, meta: r.meta ?? {}, active: r.active });

export async function upsertLookup(c: Queryable, l: LookupEntry): Promise<void> {
  await c.query(
    `INSERT INTO lookup_mirror(id, category, code, label, label_ar, meta, active) VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (id) DO UPDATE SET label = EXCLUDED.label, label_ar = EXCLUDED.label_ar, meta = EXCLUDED.meta, active = EXCLUDED.active, updated_at = now()`,
    [lookupId(l.category, l.code), l.category, l.code, l.label, l.labelAr ?? null, JSON.stringify(l.meta ?? {}), l.active ?? true]);
}
/** Fills the mirror from the shared world (or any list) — the seed's way of being usable before the first event arrives. */
export async function seedLookupMirror(c: Queryable, entries: LookupEntry[], categories?: string[]): Promise<number> {
  let n = 0;
  for (const l of entries) { if (categories && !categories.includes(l.category)) continue; await upsertLookup(c, l); n += 1; }
  return n;
}

export const LOOKUP_SUBJECTS = [subjectFor(EVENTS.mdm.lookupChanged)];
/** Applies one `mdm.lookup.changed` event; answers whether it touched the mirror. Events without the entry (older producers) are ignored. */
export async function applyLookupEvent(c: Queryable, event: EventEnvelope): Promise<boolean> {
  if (event.type !== EVENTS.mdm.lookupChanged) return false;
  const d = (event.data ?? {}) as { category?: string; code?: string; change?: string; lookup?: LookupEntry & { active?: boolean } };
  if (!d.category || !d.code) return false;
  if (d.change === 'deleted') { await c.query('DELETE FROM lookup_mirror WHERE id = $1', [lookupId(d.category, d.code)]); return true; }
  if (!d.lookup) return false;
  await upsertLookup(c, { ...d.lookup, category: d.category, code: d.code, active: d.change === 'deactivated' ? false : d.lookup.active ?? true });
  return true;
}

/** The active entries of one master, in code order (or every entry when `activeOnly` is false). */
export async function lookupOptions(c: Queryable, category: string, opts: { activeOnly?: boolean } = {}): Promise<LookupOption[]> {
  const r = await c.query<LookupRow>(`SELECT * FROM lookup_mirror WHERE category = $1${opts.activeOnly === false ? '' : ' AND active'} ORDER BY (meta->>'order')::numeric NULLS LAST, code`, [category]);
  return r.rows.map(lookupOption);
}
export async function lookupByCode(c: Queryable, category: string, code: string): Promise<LookupOption | null> {
  const r = await c.query<LookupRow>('SELECT * FROM lookup_mirror WHERE id = $1', [lookupId(category, code)]);
  return r.rows[0] ? lookupOption(r.rows[0]) : null;
}
/** Every active code of a master — what a validator compares a submitted value against. */
export async function lookupCodes(c: Queryable, category: string): Promise<string[]> {
  const r = await c.query<{ code: string }>('SELECT code FROM lookup_mirror WHERE category = $1 AND active ORDER BY code', [category]);
  return r.rows.map((x) => x.code);
}
/** The label a code prints as, in the language asked for; the code itself when the master does not know it. */
export async function lookupLabel(c: Queryable, category: string, code: string, lang = 'en'): Promise<string> {
  const o = await lookupByCode(c, category, code);
  return o ? (lang === 'ar' && o.labelAr ? o.labelAr : o.label) : code;
}

/* Validation. A submitted value must be an active code of the named master, and the refusal names the master
 * so a clerk knows where to add the value if it is genuinely missing. An empty master is refused too rather
 * than waved through: a mirror that never received its seed is a deployment fault, not a licence to accept
 * anything. */
export async function assertLookup(c: Queryable, category: string, code: unknown, what = category): Promise<LookupOption> {
  const value = String(code ?? '').trim();
  if (!value) throw badRequest(`${what} is required`, { category });
  const found = await lookupByCode(c, category, value);
  if (found?.active) return found;
  const codes = await lookupCodes(c, category);
  if (!codes.length) throw badRequest(`The ${category} master has no active entries, so ${what} cannot be validated`, { category });
  throw badRequest(`${what}: "${value}" is not an active entry of the ${category} master`, { category, code: value, allowed: codes });
}
export async function assertLookups(c: Queryable, category: string, codes: unknown, what = category): Promise<LookupOption[]> {
  const list = Array.isArray(codes) ? codes : [];
  const out: LookupOption[] = [];
  for (const code of list) out.push(await assertLookup(c, category, code, what));
  return out;
}
