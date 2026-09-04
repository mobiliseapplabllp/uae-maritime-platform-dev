import type { TenancyScope } from '@maritime/contracts';
import { scopeWhere, type ScopeOptions } from '@maritime/service-kit';

/* What the instrument register belongs to.
 *
 * A licence is held by one party, and that party reads their own and nobody else's. It is not
 * port-partitioned: an instrument is issued by the administration under the flag, not by a port.
 *
 * The public verification endpoint is deliberately outside this. A certificate is meant to be checkable by
 * whoever is handed it — a port state officer abroad, a charterer, an insurer — so verification takes a
 * number and a signature and answers without a session at all. That is not a hole in the tenancy model; it
 * is a different surface, and it returns only what a certificate already prints on its face. */
export const LICENCE_SCOPE: ScopeOptions = { columns: ['company'] };

/** A whole-register read as one reader may see it: the WHERE clause and its arguments, or neither. */
export function scopedWhere(scope: TenancyScope, opts: ScopeOptions, alias = ''): { sql: string; args: unknown[] } {
  const where: string[] = []; const args: unknown[] = [];
  scopeWhere(scope, where, args, { ...opts, alias });
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}
