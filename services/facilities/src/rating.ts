import { lookupOptions, type Queryable } from '@maritime/service-kit';
import { ratingBreakdown, ratingFrom, type RatingEntry } from './directory';

/* The performance rating, earned from everything the desk has learned about a subject: the compliance audits
 * taken and the inspection visits completed, each visit weighted by the type it was (from the `visitType`
 * master). Audits and visits both call in here after they are written, so the two can never disagree about
 * what the rating is. */

export async function ratingEntriesFor(c: Queryable, kind: string, id: string): Promise<RatingEntry[]> {
  const weights = new Map((await lookupOptions(c, 'visitType', { activeOnly: false })).map((o) => [o.code, Number(o.meta.ratingWeight) || 1]));
  const audits = await c.query<{ number: string; audited_on: Date; result: string }>('SELECT number, audited_on, result FROM audits WHERE subject_kind = $1 AND subject_id = $2', [kind, id]);
  const visits = await c.query<{ number: string; visited_on: Date; result: string; score: string | null; visit_type: string }>("SELECT number, visited_on, result, score, visit_type FROM visits WHERE subject_kind = $1 AND subject_id = $2 AND status = 'COMPLETED' AND visited_on IS NOT NULL", [kind, id]);
  return [
    ...audits.rows.map((a): RatingEntry => ({ source: 'AUDIT', number: a.number, date: a.audited_on, result: a.result })),
    ...visits.rows.map((v): RatingEntry => ({ source: 'VISIT', number: v.number, date: v.visited_on, result: v.result, score: v.score == null ? null : Number(v.score), weight: weights.get(v.visit_type) ?? 1 })),
  ];
}
/** Recomputes a subject's rating from its whole history and, for a company, writes it on the directory. */
export async function recomputeRating(c: Queryable, kind: string, id: string, now = new Date()): Promise<number | null> {
  const rating = ratingFrom(await ratingEntriesFor(c, kind, id), now);
  if (kind === 'COMPANY' && rating != null) await c.query('UPDATE companies SET rating = $2, updated_at = now() WHERE id = $1', [id, rating]);
  return rating;
}
export async function ratingFor(c: Queryable, kind: string, id: string, now = new Date()) { return ratingBreakdown(await ratingEntriesFor(c, kind, id), now); }
