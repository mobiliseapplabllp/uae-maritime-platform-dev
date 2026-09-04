import type { TenancyScope } from '@maritime/contracts';
import { scopeWhere, type ScopeOptions } from '@maritime/service-kit';

/* What each register at the centre belongs to.
 *
 * None of it is company-owned: a case, a track and a restriction are the administration's record, not an
 * operator's, so a company-scoped reader sees none of it. That is stated rather than defaulted, because the
 * alternative reading — a register with no company column is public to companies — is how an operator would
 * come to read the incident file on a competitor's ship. */

/** A case belongs to the port it happened in; a case not yet placed is every desk's business. */
export const INCIDENT_SCOPE: ScopeOptions = { columns: ['port'], publicToCompanies: false };

/** The berth snapshot, carrying the port stamped on it by the service that owns the estate. */
export const BERTH_SCOPE: ScopeOptions = { columns: ['port'], publicToCompanies: false };

/** A whole-register read as one reader may see it: the WHERE clause and its arguments, or neither. */
export function scopedWhere(scope: TenancyScope, opts: ScopeOptions, alias = ''): { sql: string; args: unknown[] } {
  const where: string[] = []; const args: unknown[] = [];
  scopeWhere(scope, where, args, { ...opts, alias });
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}
