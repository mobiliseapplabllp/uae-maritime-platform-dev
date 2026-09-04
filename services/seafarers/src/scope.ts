import type { TenancyScope } from '@maritime/contracts';
import { scopeWhere, type ScopeOptions } from '@maritime/service-kit';

/* What the crew register belongs to.
 *
 * It is the administration's register: a seafarer's certificates, medical fitness and discharge record are
 * held by the authority that issued them, and a port officer reads the whole of it.
 *
 * A company reads only the seafarers it placed. The partition is the recruitment and placement service named
 * on the record — the relationship the administration licenses under MLC 2006 Regulation 1.4 — and not the
 * operator of whichever ship the person is aboard this month, which would hand a shipping agent the
 * discharge history of someone they have no standing over.
 *
 * Ownership semantics, so there is no empty escape: a seafarer engaged directly by an owner carries no agent
 * and is the administration's alone. That is the strict reading and it is deliberate — the register holds a
 * person's medical fitness and their certificate history, and an agency browsing crew it never placed is not
 * something to arrive at by leaving a default unexamined. */
export const SEAFARER_SCOPE: ScopeOptions = { columns: ['company'], publicToCompanies: false };

/** A whole-register read as one reader may see it: the WHERE clause and its arguments, or neither. */
export function scopedWhere(scope: TenancyScope, opts: ScopeOptions, alias = ''): { sql: string; args: unknown[] } {
  const where: string[] = []; const args: unknown[] = [];
  scopeWhere(scope, where, args, { ...opts, alias });
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}
