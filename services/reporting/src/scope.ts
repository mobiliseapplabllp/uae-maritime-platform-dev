import { hasPerm } from '@maritime/contracts';
import { scopeWhere, type Principal, type ScopeOptions } from '@maritime/service-kit';

/**
 * What each read model may show whom.
 *
 * Reporting is a projection layer, so its policy has to be the same policy as the register it projects — a
 * boundary enforced in `ports` and dropped in `reporting` is not enforced at all. Each entry below therefore
 * mirrors the source register's own declaration, and the ones with no partition columns have to say what a
 * company-scoped reader gets, because neither answer is right for both kinds of table.
 */

/** Ships belong to their agent. A company reader sees the ships it is agent for, nobody else's. */
export const VESSEL_SCOPE: ScopeOptions = { columns: ['company'] };
/** A certificate is the ship's, and carries the ship's owner. */
export const CERTIFICATE_SCOPE: ScopeOptions = { columns: ['company'] };
/** A call is both the agent's and the port's. */
export const CALL_SCOPE: ScopeOptions = { columns: ['company', 'port'] };
/** An invoice is the billed party's. */
export const INVOICE_SCOPE: ScopeOptions = { columns: ['company'] };
/** A licence or accreditation is its holder's. */
export const INSTRUMENT_SCOPE: ScopeOptions = { columns: ['company'] };
/** A registration file is the applicant company's. */
export const REGISTRATION_SCOPE: ScopeOptions = { columns: ['company'] };
/** The company directory: an agent sees its own entry. */
export const COMPANY_SCOPE: ScopeOptions = { columns: ['company'] };
/** Berths and marine craft are port infrastructure — published to whoever calls at the port. */
export const BERTH_SCOPE: ScopeOptions = { columns: ['port'], publicToCompanies: true };
export const RESOURCE_SCOPE: ScopeOptions = { columns: ['port'], publicToCompanies: true };
/** Incident case files are the administration's; an agent has no standing to read them. */
export const INCIDENT_SCOPE: ScopeOptions = { columns: ['port'], publicToCompanies: false };
/** Survey and audit records likewise. */
export const INSPECTION_SCOPE: ScopeOptions = { columns: ['port'], publicToCompanies: false };
/** Crew: a manning agency reads the seafarers it placed, and no other agency's — the same partition the
 *  register applies, on the same recruitment-and-placement relationship. */
export const SEAFARER_SCOPE: ScopeOptions = { columns: ['company'] };
/** A training provider reads its own row on the MET register; the administration reads the sector. */
export const MET_SCOPE: ScopeOptions = { columns: ['company'] };
/** A crew list belongs to the agent who lodged the call it is attached to. */
export const CREW_LIST_SCOPE: ScopeOptions = { columns: ['company'] };
/** The foreign seafarer ledger is the administration's: a company sees none of it. */
export const FOREIGN_SCOPE: ScopeOptions = { columns: [], publicToCompanies: false };
/** Staff directory: internal. */
export const USER_SCOPE: ScopeOptions = { columns: [], publicToCompanies: false };
/** Tariffs and checklist templates are published reference data. */
export const TARIFF_SCOPE: ScopeOptions = { columns: [], publicToCompanies: true };
export const CHECKLIST_SCOPE: ScopeOptions = { columns: [], publicToCompanies: false };
/** Agent decisions are the administration's own audit surface. */
export const DECISION_SCOPE: ScopeOptions = { columns: [], publicToCompanies: false };
/**
 * Legislation is gated by publication, not by ownership: a draft or withdrawn instrument is not law and must
 * not reach the industry, while everything in force is public to all of it.
 */
export const LEGISLATION_SCOPE: ScopeOptions = { columns: [], publicToCompanies: true };
export const PUBLISHED_STATUSES = ['IN_FORCE', 'SUPERSEDED'] as const;
/** Only the legislation team sees an instrument before it is in force. */
export const seesUnpublished = (user: Principal): boolean => hasPerm(user.perms, 'legislation.manage');

/**
 * The visibility predicate for one read model, as a self-contained SQL boolean.
 *
 * It carries no parameters. Reporting's queries are hand-written aggregates with their own placeholders in
 * their own order, and a clause that appended `$n` could only be dropped in at the end of one of them — which
 * is precisely the position where a forgotten filter hides. Parameter-free, the same predicate goes anywhere:
 * into a WHERE list, into a sub-select standing in for a table name, into a FILTER clause.
 *
 * The values are scope keys from the caller's signed token — port and company codes like `AEAUH` or `GSS` —
 * and every one is checked against a strict character class before it is quoted. A key that fails is not
 * skipped, it throws: a predicate that quietly drops a term is a predicate that quietly widens.
 */
const KEY = /^[A-Za-z0-9_.:-]{1,64}$/;
const quote = (key: string): string => {
  if (!KEY.test(key)) throw new Error(`Refusing to build a visibility clause from an unrecognised scope key: ${JSON.stringify(key)}`);
  return `'${key}'`;
};

export function visible(user: Principal, opts: ScopeOptions, alias?: string): string {
  const where: string[] = []; const args: unknown[] = [];
  scopeWhere(user.scope, where, args, alias ? { ...opts, alias } : opts);
  if (!where.length) return 'TRUE';
  // scopeWhere emits at most one clause, with at most one array parameter: the scope keys.
  const keys = (args[0] as string[] | undefined) ?? [];
  const list = keys.map(quote).join(', ');
  return where.join(' AND ').replace(/= ANY\(\$\d+\)/, list.length ? `IN (${list})` : 'IN (NULL)');
}

/**
 * A read model in FROM position, restricted to what the caller may see.
 *
 * The sub-select is aliased back to the table's own name so a query that already refers to its columns —
 * or joins it, or filters it — needs no other change: `FROM rm_port_calls` becomes
 * `FROM (SELECT * FROM rm_port_calls WHERE ...) rm_port_calls`, and everything downstream still reads.
 */
export const from = (user: Principal, table: string, opts: ScopeOptions, alias = table): string =>
  `(SELECT * FROM ${table} WHERE ${visible(user, opts)}) ${alias}`;
