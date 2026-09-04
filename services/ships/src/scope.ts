import type { TenancyScope } from '@maritime/contracts';
import { scopeWhere, type ScopeOptions } from '@maritime/service-kit';

/* What each register in the ship service belongs to.
 *
 * Nothing here is port-partitioned: a ship is entered on the flag's register, not a port's, so a port
 * officer reads all of it. What applies is ownership by the appointed agent. */

/** The fleet: an agent sees the ships they act for. */
export const VESSEL_SCOPE: ScopeOptions = { columns: ['company'] };

/** A registration application, and the certificates that follow it: the ship's, so the ship's agent's. */
export const REGISTRATION_SCOPE: ScopeOptions = { columns: ['company'] };

/**
 * The risk register scores the fleet on the administration's own weightings — detentions, deficiencies,
 * agent performance. It is how the administration ranks who it distrusts, and handing an operator their own
 * score, let alone anyone else's, is a decision for the administration and not a default.
 */
export const RISK_SCOPE: ScopeOptions = { columns: [], publicToCompanies: false };

/** A whole-register read as one reader may see it: the WHERE clause and its arguments, or neither. */
export function scopedWhere(scope: TenancyScope, opts: ScopeOptions, alias = ''): { sql: string; args: unknown[] } {
  const where: string[] = []; const args: unknown[] = [];
  scopeWhere(scope, where, args, { ...opts, alias });
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}
