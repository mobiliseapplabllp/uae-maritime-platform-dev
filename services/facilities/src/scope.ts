import type { TenancyScope } from '@maritime/contracts';
import { scopeWhere, type ScopeOptions } from '@maritime/service-kit';

/* What each register in the industry directory belongs to. A register carrying no company column has to say
 * whether a company-scoped reader may see it; unstated is denied, so each one below says which it is. */

/** A company entry is its own: the operator maintains theirs, the administration reads the register. */
export const COMPANY_SCOPE: ScopeOptions = { columns: ['company'] };

/** A facility belongs to the company that operates it and stands in one port. */
export const FACILITY_SCOPE: ScopeOptions = { columns: ['port', 'company'] };

/** A whole-register read as one reader may see it: the WHERE clause and its arguments, or neither. */
export function scopedWhere(scope: TenancyScope, opts: ScopeOptions, alias = ''): { sql: string; args: unknown[] } {
  const where: string[] = []; const args: unknown[] = [];
  scopeWhere(scope, where, args, { ...opts, alias });
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

/** An obligation or an audit belongs to whoever it was raised against. A record of a company's shortcomings
 *  is that company's to read, and nobody else's. */
export const SUBJECT_SCOPE: ScopeOptions = { columns: ['company'] };
