import type { ScopeLevel, TenancyScope } from '@maritime/contracts';
import { notFound } from './http/envelope';

/* Tenancy: which records a principal may see, enforced in the query rather than after it.
 *
 * The platform is federal and it is also open to the industry, so there are two different things a record
 * can belong to and they do not behave alike.
 *
 * Containment — a port, a zone, a facility. A record inside one is seen by whoever is scoped to it, and a
 * record that names none is above them all: a federal circular applies to every port, so every port sees it.
 * Empty means shared.
 *
 * Ownership — a company. An agent sees their own company's invoices and nobody else's, and a record with no
 * company is not shared with every company, it is internal to the administration. Empty means nobody's.
 *
 * Reading the two the same way is how a register leaks: it is the difference between "this circular is not
 * port-specific, so show it" and "this invoice has no company on it, so show it to every agent". So they are
 * separate columns with separate rules, and a register declares which ones it has.
 *
 * A register with no company column has to say what a company-scoped reader may see: a berth list and the
 * published legislation are public to them, an internal register is not. There is no default that is right
 * for both, so `publicToCompanies` has to be stated. Unstated means denied, because a clause that quietly
 * matches everything is the failure that empties a tenancy model without anyone noticing.
 *
 * The predicate goes into the WHERE clause, never into a filter over results: a record the reader may not
 * see must not be counted, paged, aggregated, or revealed by the shape of what came back. */

/** The partitions a record can carry. `port`, `zone` and `facility` contain; `company` owns. */
export type ScopePartition = 'port' | 'zone' | 'facility' | 'company';
export const CONTAINMENT: ScopePartition[] = ['port', 'zone', 'facility'];

/** The column a partition is stored in, and the DDL a migration adds. Kept here so the two cannot drift. */
export const scopeColumn = (p: ScopePartition): string => `scope_${p}`;
export const scopeDdl = (...partitions: ScopePartition[]): string =>
  partitions.map((p) => `${scopeColumn(p)} text NOT NULL DEFAULT ''`).join(', ');

/** Which partition a scope level restricts on. NATIONAL restricts on nothing. */
const PARTITION_OF: Record<ScopeLevel, ScopePartition | null> = {
  NATIONAL: null, PORT: 'port', ZONE: 'zone', FACILITY: 'facility', COMPANY: 'company',
};

export interface ScopeOptions {
  /** The partition columns this table actually carries. */
  columns: readonly ScopePartition[];
  /**
   * Whether a company-scoped reader may see this register in full. Public infrastructure and published rules
   * are; anything the administration keeps to itself is not. Only consulted when the table has no company
   * column, and required rather than defaulted because neither answer is safe for both kinds of register.
   */
  publicToCompanies?: boolean;
  /** Qualifies the columns when the query joins. */
  alias?: string;
}

/** The keys a scope holds at its own level. A scope is a claim about one level; its other lists do not widen it. */
export function keysOf(scope: TenancyScope | undefined): string[] {
  if (!scope) return [];
  const lists: Record<ScopeLevel, readonly string[] | undefined> = {
    NATIONAL: undefined, PORT: scope.ports, ZONE: scope.zones, FACILITY: scope.facilities, COMPANY: scope.companies,
  };
  return [...new Set((lists[scope.level] ?? []).map((k) => String(k)).filter(Boolean))];
}

/** True when this principal is unrestricted. An absent or unrecognised scope is never treated as national. */
export const isNational = (scope: TenancyScope | undefined): boolean => scope?.level === 'NATIONAL';

/**
 * Appends the visibility clause to a where/args pair built the way the services build them.
 *
 * Returns whether a clause was added, so a caller that must prove it is enforcing something can assert on
 * that rather than assume it.
 */
export function scopeWhere(scope: TenancyScope | undefined, where: string[], args: unknown[], opts: ScopeOptions): boolean {
  if (isNational(scope)) return false;
  const p = opts.alias ? `${opts.alias}.` : '';
  const partition = scope ? PARTITION_OF[scope.level] : undefined;
  // A scope naming no level this platform knows about cannot be matched against anything.
  if (!partition) { where.push('false'); return true; }

  const has = opts.columns.includes(partition);
  const keys = keysOf(scope);

  if (partition === 'company') {
    // Ownership: no empty escape, and a company reader with no company is nobody.
    if (!has) { if (opts.publicToCompanies) return false; where.push('false'); return true; }
    if (!keys.length) { where.push('false'); return true; }
    args.push(keys);
    where.push(`${p}${scopeColumn(partition)} = ANY($${args.length})`);
    return true;
  }

  // Containment: a register that is not partitioned this way is not restricted this way either — a port
  // officer sees the whole ship register, because the ship register belongs to the administration, not to
  // a port.
  if (!has) return false;
  const col = `${p}${scopeColumn(partition)}`;
  if (!keys.length) { where.push(`${col} = ''`); return true; }
  args.push(keys);
  where.push(`(${col} = '' OR ${col} = ANY($${args.length}))`);
  return true;
}

/** A record's partition keys, in either column style, for a row already in hand. */
export type ScopeRef = Partial<Record<ScopePartition, string>> | Record<string, unknown>;

const keyOn = (record: ScopeRef, partition: ScopePartition): string => {
  const r = record as Record<string, unknown>;
  const v = r[partition] ?? r[scopeColumn(partition)];
  return v == null ? '' : String(v);
};

/** The same rule, for a record already read: an event being projected, a row fetched by id. */
export function visibleTo(scope: TenancyScope | undefined, record: ScopeRef | undefined, opts: ScopeOptions): boolean {
  if (isNational(scope)) return true;
  if (!record) return false;
  const partition = scope ? PARTITION_OF[scope.level] : undefined;
  if (!partition) return false;
  const has = opts.columns.includes(partition);
  const keys = keysOf(scope);
  if (partition === 'company') {
    if (!has) return opts.publicToCompanies === true;
    const owner = keyOn(record, partition);
    return owner !== '' && keys.includes(owner);
  }
  if (!has) return true;
  const key = keyOn(record, partition);
  return key === '' || keys.includes(key);
}

/**
 * Guards a single record read by id.
 *
 * It raises "not found", not "forbidden": a reader outside the scope should not be able to learn that the
 * record exists from the difference between the two answers.
 */
export function assertInScope(scope: TenancyScope | undefined, record: ScopeRef | undefined, opts: ScopeOptions, what = 'Record'): void {
  if (!visibleTo(scope, record, opts)) throw notFound(`${what} not found`);
}

/** The partition keys to stamp on a record its author is creating, from the author's own scope. */
export function scopeOfRecord(scope: TenancyScope | undefined): Partial<Record<ScopePartition, string>> {
  const partition = scope ? PARTITION_OF[scope.level] : null;
  if (!partition) return {};
  const keys = keysOf(scope);
  // An author scoped to several keys has no single one to stamp, so the record is left unpartitioned rather
  // than assigned to whichever key happened to come first.
  return keys.length === 1 ? { [partition]: keys[0] } : {};
}
