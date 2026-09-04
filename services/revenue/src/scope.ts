import type { TenancyScope } from '@maritime/contracts';
import { scopeWhere, type ScopeOptions } from '@maritime/service-kit';

/* What each ledger register belongs to. The administration is national and reads all of it; a company reads
 * what is theirs, and a register with no company column has to say whether they may read it at all. */

/** An invoice belongs to the party billed. Nobody else's is any of their business. */
export const INVOICE_SCOPE: ScopeOptions = { columns: ['company'] };

/**
 * The rate card is published — it is what an estimate is quoted from, so a payer must be able to read it.
 *
 * This policy adds no clause for anyone, which is why the tariff handlers do not carry it: threading a
 * predicate that provably matches everything through four handlers is noise, not enforcement. The decision
 * is recorded here and pinned by a test, so changing the policy is a change to this line and not a hunt.
 */
export const TARIFF_SCOPE: ScopeOptions = { columns: [], publicToCompanies: true };

/** The company directory: a company sees its own entry, the administration sees the register. */
export const COMPANY_SCOPE: ScopeOptions = { columns: ['company'] };

/** A whole-register read as one reader may see it: the WHERE clause and its arguments, or neither. */
export function scopedWhere(scope: TenancyScope, opts: ScopeOptions, alias = ''): { sql: string; args: unknown[] } {
  const where: string[] = []; const args: unknown[] = [];
  scopeWhere(scope, where, args, { ...opts, alias });
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}
