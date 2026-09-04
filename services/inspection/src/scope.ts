import type { TenancyScope } from '@maritime/contracts';
import { scopeWhere, type ScopeOptions } from '@maritime/service-kit';

/* What each register in the cell belongs to.
 *
 * None of it is company-readable. An inspection report is the administration's finding, not the operator's
 * copy of it, and a checklist template is the method it works to. Both say so rather than relying on a
 * default, because the other reading of "no company column" is that a register is public to every company. */

/** An inspection belongs to the port it was carried out in; one not tied to a call is shared. */
export const INSPECTION_SCOPE: ScopeOptions = { columns: ['port'], publicToCompanies: false };

/** The method the cell works to: national, and not an operator's business. */
export const TEMPLATE_SCOPE: ScopeOptions = { columns: [], publicToCompanies: false };

/** A whole-register read as one reader may see it: the WHERE clause and its arguments, or neither. */
export function scopedWhere(scope: TenancyScope, opts: ScopeOptions, alias = ''): { sql: string; args: unknown[] } {
  const where: string[] = []; const args: unknown[] = [];
  scopeWhere(scope, where, args, { ...opts, alias });
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}
