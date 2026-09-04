import type { TenancyScope } from '@maritime/contracts';
import { scopeWhere, visibleTo, type ScopeOptions } from '@maritime/service-kit';

/* What each register here belongs to.
 *
 * The rules themselves are published — that is the whole point of publishing them — so an operator reads the
 * register in full, and a port officer reads it in full too, because a circular from the administration
 * applies everywhere. Neither is partitioned, so neither policy adds a clause for anyone.
 *
 * The acknowledgement roll is a different thing wearing the same skin. It is not the rule; it is the record
 * of who inside the administration has read it, and which of them have not. That is an internal compliance
 * record and it is nobody outside's business, so it says so rather than inheriting the register's openness. */

/** A published instrument: national, and readable by everyone the platform admits. */
export const INSTRUMENT_SCOPE: ScopeOptions = { columns: [], publicToCompanies: true };

/** Who has acknowledged what: the administration's own compliance record. */
export const ACKNOWLEDGEMENT_SCOPE: ScopeOptions = { columns: [], publicToCompanies: false };

/** A whole-register read as one reader may see it: the WHERE clause and its arguments, or neither. */
export function scopedWhere(scope: TenancyScope, opts: ScopeOptions, alias = ''): { sql: string; args: unknown[] } {
  const where: string[] = []; const args: unknown[] = [];
  scopeWhere(scope, where, args, { ...opts, alias });
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
}

/**
 * Whether this reader may be shown the acknowledgement roll.
 *
 * The roll is not a separate register with its own row — it travels on the instrument, in `acknowledgedBy`
 * and the counts derived from it — so it cannot be filtered out in a WHERE clause. It is withheld here
 * instead, on the same policy the endpoint that serves it in full is guarded by.
 */
export const maySeeAcknowledgements = (scope: TenancyScope): boolean => visibleTo(scope, {}, ACKNOWLEDGEMENT_SCOPE);
