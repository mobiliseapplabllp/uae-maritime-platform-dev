import type { Pool, PoolClient } from 'pg';
import { notFound, scopeWhere } from '@maritime/service-kit';
import { COMPANY_SCOPE, FACILITY_SCOPE } from './scope';
import type { TenancyScope } from '@maritime/contracts';
import type { Env } from './env';
import { cyclesFor, positionOf } from './accreditation';
import { visitsFor } from './visits';
import {
  auditApi, companyApi, facilityApi, instrumentApi, obligationApi, statusEntryApi,
  type AuditApi, type AuditRow, type CompanyApi, type CompanyRow, type FacilityApi, type FacilityRow,
  type InstrumentApi, type InstrumentRow, type ObligationApi, type ObligationRow, type StatusRow,
} from './directory';

/* Reading one regulated subject the way the detail screens want it: the record itself, the instruments
 * it holds (from the local snapshot), the compliance audits carried out against it, what it still owes
 * and — for a company — the line of standing decisions taken against it. */

export type Q = Pool | PoolClient;

/* Every handler that touches one company or one facility comes through here, which is why the tenancy
 * filter is here: the clause is in the query, so a record outside the reader's scope raises the same "not
 * found" a record that never existed would, and a handler added later cannot forget it. */
export async function loadCompany(c: Q, id: string, scope: TenancyScope, lock = false): Promise<CompanyRow> {
  const where = ['(id = $1 OR upper(code) = upper($1))']; const args: unknown[] = [id];
  scopeWhere(scope, where, args, COMPANY_SCOPE);
  const r = await c.query<CompanyRow>(`SELECT * FROM companies WHERE ${where.join(' AND ')}${lock ? ' FOR UPDATE' : ''}`, args);
  if (!r.rows[0]) throw notFound('Company not found');
  return r.rows[0];
}
export async function loadFacility(c: Q, id: string, scope: TenancyScope, lock = false): Promise<FacilityRow> {
  const where = ['(id = $1 OR upper(code) = upper($1))']; const args: unknown[] = [id];
  scopeWhere(scope, where, args, FACILITY_SCOPE);
  const r = await c.query<FacilityRow>(`SELECT * FROM port_facilities WHERE ${where.join(' AND ')}${lock ? ' FOR UPDATE' : ''}`, args);
  if (!r.rows[0]) throw notFound('Port facility not found');
  return r.rows[0];
}

export async function instrumentsFor(c: Q, subjectIds: string[]): Promise<InstrumentApi[]> {
  if (!subjectIds.length) return [];
  const r = await c.query<InstrumentRow>('SELECT * FROM instruments WHERE subject_id = ANY($1::text[]) ORDER BY coalesce(issue_date, applied_date) DESC NULLS LAST, number', [subjectIds]);
  return r.rows.map((x) => instrumentApi(x));
}
export async function auditsFor(c: Q, kind: string, id: string): Promise<AuditApi[]> {
  const r = await c.query<AuditRow>('SELECT * FROM audits WHERE subject_kind = $1 AND subject_id = $2 ORDER BY audited_on DESC, number DESC', [kind, id]);
  return r.rows.map(auditApi);
}
export async function obligationsFor(c: Q, kind: string, id: string): Promise<ObligationApi[]> {
  const r = await c.query<ObligationRow>('SELECT * FROM obligations WHERE subject_kind = $1 AND subject_id = $2 ORDER BY (status = \'OPEN\') DESC, due_at NULLS LAST, raised_at DESC', [kind, id]);
  return r.rows.map((x) => obligationApi(x));
}
export async function historyFor(c: Q, companyId: string) {
  const r = await c.query<StatusRow>('SELECT * FROM company_status_history WHERE company_id = $1 ORDER BY at DESC', [companyId]);
  return r.rows.map(statusEntryApi);
}

/** The whole company record: contacts, addresses, what it holds, how it has audited and what it owes. */
export async function fullCompany(c: Q, row: CompanyRow, env?: Env): Promise<CompanyApi> {
  // sequential rather than concurrent: `c` is often a transaction's own client, which serves one query at a time
  const instruments = await instrumentsFor(c, [row.id]);
  const audits = await auditsFor(c, 'COMPANY', row.id);
  const obligations = await obligationsFor(c, 'COMPANY', row.id);
  const history = await historyFor(c, row.id);
  const facilities = await c.query<FacilityRow>('SELECT * FROM port_facilities WHERE operator_id = $1 ORDER BY code', [row.id]);
  const accreditations = env ? positionOf(await cyclesFor(c, row.id, env)) : [];
  const visits = await visitsFor(c, 'COMPANY', row.id);
  return companyApi(row, { instruments, audits, obligations, history, facilities: facilities.rows.map((f) => facilityApi(f)), accreditations, visits });
}

/** The whole facility record: operator, ISPS standing, capability and capacity, and its inspection and audit history. */
export async function fullFacility(c: Q, row: FacilityRow): Promise<FacilityApi> {
  const instruments = await instrumentsFor(c, [row.id]);
  const audits = await auditsFor(c, 'FACILITY', row.id);
  const obligations = await obligationsFor(c, 'FACILITY', row.id);
  return facilityApi(row, { instruments, audits, obligations });
}
