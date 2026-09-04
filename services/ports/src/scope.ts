import type { TenancyScope } from '@maritime/contracts';
import { scopeWhere, type ScopeOptions } from '@maritime/service-kit';

/* What each harbour register belongs to, declared once so every query asks the same question.
 *
 * A register that carries no company column has to say whether a company-scoped reader — an agent, not an
 * officer — may see it at all. There is no safe default, so each one below says which it is and why. */

/** Calls belong to a port and to the agent who lodged them: an agent sees their own and no others. */
export const CALL_SCOPE: ScopeOptions = { columns: ['port', 'company'] };

/** The berth estate is published: an agent has to know where their ship is going, so they read all of it. */
export const BERTH_SCOPE: ScopeOptions = { columns: ['port'], publicToCompanies: true };

/** Marine craft are a service an agent orders, so the roster is theirs to read; the jobs on it are not. */
export const RESOURCE_SCOPE: ScopeOptions = { columns: ['port'], publicToCompanies: true };

/** An invoice belongs to the party billed. Nobody else's is any of their business. */
export const INVOICE_SCOPE: ScopeOptions = { columns: ['port', 'company'] };

/** The company directory: an agent sees their own entry, an officer sees the register. */
export const COMPANY_SCOPE: ScopeOptions = { columns: ['company'] };

/** A whole-register read as one reader may see it: the WHERE clause and its arguments, or neither. */
export function scopedWhere(scope: TenancyScope, opts: ScopeOptions, alias = ''): { sql: string; args: unknown[] } {
  const where: string[] = []; const args: unknown[] = [];
  scopeWhere(scope, where, args, { ...opts, alias });
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}
