import type { PoolClient } from 'pg';
import { EVENTS } from '@maritime/contracts';
import { AuditClient, badRequest, enqueue, eventFromContext, nextNumber, notFound, type Principal } from '@maritime/service-kit';
import type { Env } from './env';
import { auditApi, obligationApi, ratingFrom, type AuditRow, type ObligationRow, type Row } from './directory';
import { auditsFor } from './read';

/* Compliance, which is the same act whether the subject is a company or a port facility.
 *
 * Recording an audit does three things at once and they belong together in one transaction: the audit
 * is written, the subject's performance rating is recomputed from its whole audit history (a rating is
 * earned, never typed), and a non-conformity raises an obligation the subject has to clear. That is why
 * this lives here rather than being copied into both controllers. */

export interface AuditInput { date?: string | null; auditor?: string; auditorId?: string | null; result: string; scope?: string; remarks?: string; instrumentId?: string | null; instrumentNo?: string }
export interface Subject { kind: 'COMPANY' | 'FACILITY'; id: string; name: string }

/** `AUD-2026-0043` — one atomic series per calendar year. */
export async function nextAuditNumber(c: PoolClient, env: Env, on: Date): Promise<string> {
  const year = on.getUTCFullYear();
  return nextNumber(c, `${env.AUDIT_PREFIX}-${year}`, `${env.AUDIT_PREFIX}-${year}-`, 4);
}

export async function recordAudit(c: PoolClient, env: Env, audit: AuditClient, subject: Subject, body: AuditInput, user?: Principal) {
  const on = body.date ? new Date(body.date) : new Date();
  if (Number.isNaN(on.getTime())) throw badRequest('The audit date is not a date');
  const number = await nextAuditNumber(c, env, on);
  const r = await c.query<AuditRow>(
    `INSERT INTO audits(number, subject_kind, subject_id, subject_name, audited_on, auditor_id, auditor, result, scope, remarks, instrument_id, instrument_no)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [number, subject.kind, subject.id, subject.name, on, body.auditorId ?? user?.id ?? null, body.auditor ?? user?.name ?? '', body.result,
      body.scope ?? '', body.remarks ?? '', body.instrumentId ?? null, body.instrumentNo ?? '']);
  const row = r.rows[0];
  await audit.record(c, { action: 'AUDIT', entity: subject.kind === 'COMPANY' ? 'Company' : 'PortFacility', entityId: subject.id, entityLabel: subject.name, after: auditApi(row), note: body.remarks ?? '' });

  const history = await auditsFor(c, subject.kind, subject.id);
  const rating = ratingFrom(history);
  if (subject.kind === 'COMPANY' && rating != null) await c.query('UPDATE companies SET rating = $2, updated_at = now() WHERE id = $1', [subject.id, rating]);

  let obligation: ObligationRow | null = null;
  if (body.result === 'NON_CONFORMITY') {
    obligation = await raiseObligation(c, env, audit, subject, {
      kind: 'AUDIT_FINDING', title: `Non-conformity raised on audit ${number}`, detail: body.remarks ?? '', sourceRef: number,
      dueAt: new Date(on.getTime() + env.OBLIGATION_DUE_DAYS * 86_400_000).toISOString(),
    }, user);
  }
  return { row, rating, obligation, audits: history.length };
}

export interface ObligationInput { kind: string; title: string; detail?: string; sourceRef?: string; dueAt?: string | null }
export async function raiseObligation(c: PoolClient, env: Env, audit: AuditClient, subject: Subject, body: ObligationInput, user?: Principal): Promise<ObligationRow> {
  const due = body.dueAt ? new Date(body.dueAt) : new Date(Date.now() + env.OBLIGATION_DUE_DAYS * 86_400_000);
  const r = await c.query<ObligationRow>(
    `INSERT INTO obligations(subject_kind, subject_id, subject_name, kind, title, detail, source_ref, due_at, raised_by_id, raised_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (subject_id, kind, source_ref) WHERE source_ref <> '' DO UPDATE SET title = EXCLUDED.title, detail = EXCLUDED.detail, due_at = EXCLUDED.due_at RETURNING *`,
    [subject.kind, subject.id, subject.name, body.kind, body.title, body.detail ?? '', body.sourceRef ?? '', due, user?.id ?? null, user?.name ?? '']);
  const row = r.rows[0];
  await audit.record(c, { action: 'OBLIGATION_RAISED', entity: subject.kind === 'COMPANY' ? 'Company' : 'PortFacility', entityId: subject.id, entityLabel: subject.name, after: obligationApi(row) });
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.facilities.obligationRaised, {
    obligationId: row.id, subjectKind: subject.kind, subjectId: subject.id, subjectName: subject.name, kind: row.kind, title: row.title, dueAt: row.due_at,
  }, { subject: subject.id }));
  return row;
}

export async function clearObligation(c: PoolClient, env: Env, audit: AuditClient, subjectKind: string, subjectId: string, obligationId: string, note: string, user?: Principal): Promise<ObligationRow> {
  const found = await c.query<ObligationRow>('SELECT * FROM obligations WHERE id::text = $1 AND subject_kind = $2 AND subject_id = $3 FOR UPDATE', [obligationId, subjectKind, subjectId]);
  const before = found.rows[0];
  if (!before) throw notFound('Obligation not found against this subject');
  if (before.status === 'CLEARED') throw badRequest('That obligation has already been cleared');
  const r = await c.query<ObligationRow>(
    `UPDATE obligations SET status = 'CLEARED', cleared_at = now(), cleared_by_id = $2, cleared_by = $3, clearance_note = $4 WHERE id = $1 RETURNING *`,
    [before.id, user?.id ?? null, user?.name ?? '', note]);
  const row = r.rows[0];
  await audit.record(c, { action: 'OBLIGATION_CLEARED', entity: subjectKind === 'COMPANY' ? 'Company' : 'PortFacility', entityId: subjectId, entityLabel: before.subject_name, before: obligationApi(before), after: obligationApi(row), note });
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.facilities.obligationCleared, {
    obligationId: row.id, subjectKind, subjectId, kind: row.kind, title: row.title, clearedBy: row.cleared_by,
  }, { subject: subjectId }));
  return row;
}

/** The renewal work list: what is in force now and runs out inside the window, worst first. */
export async function renewalWorkList(c: PoolClient | import('pg').Pool, windowDays: number, filter: Row = {}) {
  const args: unknown[] = [windowDays];
  const where = [`i.status = 'ISSUED'`, `i.expiry_date IS NOT NULL`, `i.expiry_date <= now() + ($1 || ' days')::interval`];
  if (filter.subjectKind) { args.push(filter.subjectKind); where.push(`i.subject_kind = $${args.length}`); }
  if (filter.subjectId) { args.push(filter.subjectId); where.push(`i.subject_id = $${args.length}`); }
  if (filter.overdue === true) where.push('i.expiry_date < now()');
  const r = await c.query<Row>(
    `SELECT i.*, c.name AS company_name, c.status AS company_status, f.name AS facility_name, f.code AS facility_code
       FROM instruments i
       LEFT JOIN companies c ON c.id = i.subject_id
       LEFT JOIN port_facilities f ON f.id = i.subject_id
      WHERE ${where.join(' AND ')}
      ORDER BY i.expiry_date`, args);
  return r.rows.map((x) => ({
    instrumentId: x.id, licenseNo: x.number, subjectKind: x.subject_kind, subjectId: x.subject_id,
    subjectName: x.company_name ?? x.facility_name ?? x.entity_name, subjectStatus: x.company_status ?? null, facilityCode: x.facility_code ?? null,
    entityType: x.entity_type, typeLabel: x.type_label, instrumentClass: x.instrument_class, issueDate: x.issue_date, expiryDate: x.expiry_date,
    daysToExpiry: Math.round((new Date(x.expiry_date).getTime() - Date.now()) / 86_400_000),
    overdue: new Date(x.expiry_date).getTime() < Date.now(), onRegister: !!(x.company_name ?? x.facility_name),
  }));
}
