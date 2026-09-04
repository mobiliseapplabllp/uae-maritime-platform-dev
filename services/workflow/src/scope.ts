import type { ScopeOptions } from '@maritime/service-kit';

/* What the request register belongs to.
 *
 * An application belongs to the company that lodged it. It is not port-partitioned: a licence application
 * is made to the administration, not to a port, so a port officer assessing one reads all of them.
 *
 * This composes with the register's own rule that a non-staff reader sees only what they personally lodged.
 * The two narrow from different directions — one by who you are scoped to, one by who keyed it in — and
 * both apply, so neither can widen the other. */
export const REQUEST_SCOPE: ScopeOptions = { columns: ['company'] };

/**
 * The catalogue of services on offer is published: an applicant cannot lodge against a definition they
 * cannot read. This adds no clause for anyone, which is why the catalogue handlers carry no predicate.
 */
export const DEFINITION_SCOPE: ScopeOptions = { columns: [], publicToCompanies: true };
