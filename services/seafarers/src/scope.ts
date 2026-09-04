import type { TenancyScope } from '@maritime/contracts';
import { scopeWhere, type ScopeOptions } from '@maritime/service-kit';

/* What the crew register belongs to.
 *
 * It is national: a seafarer's certificates and sea service are held by the administration that issued
 * them, not by whoever is employing them this month, so a port officer reads the whole register and no
 * partition applies.
 *
 * It is not readable by a company at all. That is stated rather than defaulted, and it is the strict
 * reading on purpose: the register holds a person's medical fitness, their discharge record and their
 * certificate history, and a manning agent browsing another agent's crew — or their own former crew — is
 * not something to arrive at by leaving a default unexamined.
 *
 * Known gap: a manning agent cannot see their own crew either, because a seafarer row names no employer.
 * Giving them that view means adding one to the register, which is a change to what the domain records and
 * not something a tenancy pass should invent. */
export const SEAFARER_SCOPE: ScopeOptions = { columns: [], publicToCompanies: false };

/** A whole-register read as one reader may see it: the WHERE clause and its arguments, or neither. */
export function scopedWhere(scope: TenancyScope, opts: ScopeOptions, alias = ''): { sql: string; args: unknown[] } {
  const where: string[] = []; const args: unknown[] = [];
  scopeWhere(scope, where, args, { ...opts, alias });
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}
