import { badRequest, lookupOptions, type LookupOption, type Queryable } from '@maritime/service-kit';

/* The crew desk's vocabularies, read from this service's mirror of the Data Studio masters.
 *
 * A rank or a document type arrives from a form as either the master's code (`MASTER`) or its label
 * (`Master`); both are accepted, because the register printed labels for years and the crew lists that
 * arrive from agents carry words rather than codes. Whichever arrives, the row stores both: the code is
 * what a check compares, the label is what the record prints. A value the master does not know is refused
 * with the master named, so the fix is a row in Data Studio and not a release. */

export interface Vocab {
  /** Resolves a code or a label to the master entry; null when the master does not know it. */
  find(value: unknown): LookupOption | null;
  /** Resolves or refuses, naming the master and the field. */
  resolve(value: unknown, what: string): LookupOption;
  readonly options: LookupOption[];
  readonly category: string;
}

const norm = (v: unknown) => String(v ?? '').trim().toLowerCase();

export function vocabOf(category: string, options: LookupOption[]): Vocab {
  const active = options.filter((o) => o.active);
  const byKey = new Map<string, LookupOption>();
  for (const o of active) { byKey.set(norm(o.code), o); byKey.set(norm(o.label), o); if (o.labelAr) byKey.set(norm(o.labelAr), o); }
  return {
    category, options: active,
    find: (value) => byKey.get(norm(value)) ?? null,
    resolve: (value, what) => {
      const key = norm(value);
      if (!key) throw badRequest(`${what} is required`, { category });
      const found = byKey.get(key);
      if (found) return found;
      if (!active.length) throw badRequest(`The ${category} master has no active entries, so ${what} cannot be validated`, { category });
      throw badRequest(`${what}: "${String(value)}" is not an active entry of the ${category} master`, { category, code: String(value), allowed: active.map((o) => o.code) });
    },
  };
}
export async function loadVocab(c: Queryable, category: string): Promise<Vocab> { return vocabOf(category, await lookupOptions(c, category, { activeOnly: false })); }

export const rankVocab = (c: Queryable) => loadVocab(c, 'seafarerRank');
export const certVocab = (c: Queryable) => loadVocab(c, 'seafarerCertType');

/** What the seafarerCertType master says about one kind of document — read by the sign-on gate and the crew-list check. */
export interface CertRule { code: string; label: string; labelAr: string | null; kind: string; mandatory: boolean; validityMonths: number | null }
export const certRule = (o: LookupOption): CertRule => ({ code: o.code, label: o.label, labelAr: o.labelAr, kind: String(o.meta.kind ?? ''), mandatory: o.meta.mandatory === true || o.meta.mandatory === 'true', validityMonths: o.meta.validityMonths == null ? null : Number(o.meta.validityMonths) });
export const certRules = (v: Vocab): CertRule[] => v.options.map(certRule);

/* Rows written before the codes existed, or under a label the master learned later, are given their code
 * from the label when the mirror changes. Idempotent; runs at seed and on every lookup event of these two
 * masters, which is what makes the code column safe to rely on. */
export async function backfillVocabulary(c: Queryable): Promise<{ seafarers: number; service: number; certificates: number }> {
  const s = await c.query(`UPDATE seafarers s SET rank_code = m.code FROM lookup_mirror m WHERE m.category = 'seafarerRank' AND lower(m.label) = lower(s.rank) AND s.rank_code IS DISTINCT FROM m.code`);
  const v = await c.query(`UPDATE sea_service s SET rank_code = m.code FROM lookup_mirror m WHERE m.category = 'seafarerRank' AND lower(m.label) = lower(s.rank) AND s.rank_code IS DISTINCT FROM m.code`);
  const x = await c.query(`UPDATE seafarer_certificates s SET cert_code = m.code FROM lookup_mirror m WHERE m.category = 'seafarerCertType' AND lower(m.label) = lower(s.cert_type) AND s.cert_code IS DISTINCT FROM m.code`);
  return { seafarers: s.rowCount ?? 0, service: v.rowCount ?? 0, certificates: x.rowCount ?? 0 };
}
