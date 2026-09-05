import type { PoolClient } from 'pg';
import { EVENTS } from '@maritime/contracts';
import { AuditClient, badRequest, conflict, enqueue, eventFromContext, lookupByCode, nextNumber, notFound, type Principal, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { visitApi, type CycleRow, type VisitFinding, type VisitRow } from './directory';
import { recomputeRating } from './rating';
import { raiseObligation, type Subject } from './compliance';
import { latestCycle, nextVisitDue } from './accreditation';

/* Inspection visits.
 *
 * A visit is planned against a company or a port facility, then completed with a result, a checklist score
 * and findings — or cancelled with a reason. An unannounced spot check is a visit created already complete.
 * A completed visit moves the subject's performance rating (with the weight its visit type carries in the
 * master), counts towards the accreditation cycle it was paid under, and turns each finding into an
 * obligation the subject has to clear. None of that is a second step a clerk could forget: it is one
 * transaction with recording the visit. */

export interface ScheduleVisitInput { visitType: string; category?: string | null; scheduledOn?: string | null; inspector?: string; inspectorId?: string | null; remarks?: string }
export interface CompleteVisitInput { visitedOn?: string | null; result: string; score?: number | null; findings?: VisitFinding[]; remarks?: string; reportDocumentId?: string | null; inspector?: string; inspectorId?: string | null }
const entityOf = (kind: string) => (kind === 'COMPANY' ? 'Company' : 'PortFacility');

export async function nextVisitNumber(c: PoolClient, env: Env, on: Date): Promise<string> {
  const year = on.getUTCFullYear();
  return nextNumber(c, `${env.VISIT_PREFIX}-${year}`, `${env.VISIT_PREFIX}-${year}-`, 4);
}
export async function loadVisit(c: Queryable, id: string, lock = false): Promise<VisitRow> {
  const r = await c.query<VisitRow>(`SELECT * FROM visits WHERE id::text = $1 OR number = upper($1)${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!r.rows[0]) throw notFound('Visit not found');
  return r.rows[0];
}
export async function visitsFor(c: Queryable, kind: string, id: string) {
  const r = await c.query<VisitRow>('SELECT * FROM visits WHERE subject_kind = $1 AND subject_id = $2 ORDER BY coalesce(visited_on, scheduled_on::timestamptz) DESC NULLS LAST, number DESC', [kind, id]);
  return r.rows.map((v) => visitApi(v));
}

export async function scheduleVisit(c: PoolClient, env: Env, audit: AuditClient, subject: Subject, body: ScheduleVisitInput, user?: Principal): Promise<VisitRow> {
  const type = await lookupByCode(c, 'visitType', body.visitType);
  if (!type?.active) throw badRequest(`Visit type: "${body.visitType}" is not an active entry of the visitType master`, { category: 'visitType' });
  const scheduledOn = body.scheduledOn ? new Date(body.scheduledOn) : new Date();
  if (Number.isNaN(scheduledOn.getTime())) throw badRequest('The visit date is not a date');
  let cycle: CycleRow | null = null;
  if (body.category) {
    if (subject.kind !== 'COMPANY') throw badRequest('An accreditation category applies to a company visit');
    cycle = await latestCycle(c, subject.id, body.category);
    if (cycle && cycle.status !== 'CURRENT' && cycle.status !== 'DUE') cycle = null;
  }
  const number = await nextVisitNumber(c, env, scheduledOn);
  const r = await c.query<VisitRow>(
    `INSERT INTO visits(number, subject_kind, subject_id, subject_name, category, cycle_id, visit_type, status, scheduled_on, inspector_id, inspector, remarks, created_by_id, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'SCHEDULED',$8,$9,$10,$11,$12,$13) RETURNING *`,
    [number, subject.kind, subject.id, subject.name, body.category ?? '', cycle?.id ?? null, body.visitType, scheduledOn, body.inspectorId ?? user?.id ?? null, body.inspector ?? user?.name ?? '', body.remarks ?? '', user?.id ?? null, user?.name ?? '']);
  const row = r.rows[0];
  await audit.record(c, { action: 'VISIT_SCHEDULED', entity: entityOf(subject.kind), entityId: subject.id, entityLabel: subject.name, after: visitApi(row) });
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.facilities.visitScheduled, { visitId: row.id, number: row.number, subjectKind: subject.kind, subjectId: subject.id, subjectName: subject.name, visitType: row.visit_type, category: row.category || null, scheduledOn: row.scheduled_on, inspector: row.inspector }, { subject: subject.id }));
  return row;
}

export async function completeVisit(c: PoolClient, env: Env, audit: AuditClient, visitId: string, body: CompleteVisitInput, user?: Principal, now = new Date()) {
  const before = await loadVisit(c, visitId, true);
  if (before.status === 'COMPLETED') throw conflict(`Visit ${before.number} has already been completed`);
  if (before.status === 'CANCELLED') throw conflict(`Visit ${before.number} was cancelled`);
  const visitedOn = body.visitedOn ? new Date(body.visitedOn) : now;
  if (Number.isNaN(visitedOn.getTime())) throw badRequest('The visit date is not a date');
  if (visitedOn.getTime() > now.getTime() + 60_000) throw badRequest('A visit cannot be completed at a future date');
  if (body.score != null && (body.score < 0 || body.score > 100)) throw badRequest('The score is a percentage between 0 and 100');
  const findings = body.findings ?? [];
  const r = await c.query<VisitRow>(
    `UPDATE visits SET status = 'COMPLETED', visited_on = $2, result = $3, score = $4, findings = $5, remarks = $6, report_document_id = $7,
       inspector_id = COALESCE($8, inspector_id), inspector = CASE WHEN $9 <> '' THEN $9 ELSE inspector END, updated_at = now() WHERE id = $1 RETURNING *`,
    [before.id, visitedOn, body.result, body.score ?? null, JSON.stringify(findings), body.remarks ?? before.remarks, body.reportDocumentId ?? null, body.inspectorId ?? user?.id ?? null, body.inspector ?? (before.inspector ? '' : user?.name ?? '')]);
  const row = r.rows[0];
  const subject: Subject = { kind: row.subject_kind as Subject['kind'], id: row.subject_id, name: row.subject_name };
  await audit.record(c, { action: 'VISIT_COMPLETED', entity: entityOf(row.subject_kind), entityId: row.subject_id, entityLabel: row.subject_name, before: visitApi(before), after: visitApi(row), note: body.remarks ?? '' });

  // every finding is something the subject now owes; a non-conformity with no finding written up still is
  const kind = await lookupByCode(c, 'obligationKind', 'VISIT_FINDING');
  const defaultDays = Number(kind?.meta.defaultDueDays) || env.OBLIGATION_DUE_DAYS;
  const obligations: string[] = [];
  const dueIn = (days: number) => new Date(visitedOn.getTime() + days * 86_400_000).toISOString();
  for (const [i, f] of findings.entries()) {
    const o = await raiseObligation(c, env, audit, subject, { kind: 'VISIT_FINDING', title: `${f.code ? `${f.code} — ` : ''}${f.title}`, detail: `${f.severity ? `${f.severity}: ` : ''}raised on visit ${row.number}${row.category ? ` (${row.category})` : ''}`, sourceRef: `${row.number}:${i + 1}`, dueAt: dueIn(f.dueDays ?? defaultDays) }, user);
    obligations.push(o.id);
  }
  if (body.result === 'NON_CONFORMITY' && !findings.length) {
    const o = await raiseObligation(c, env, audit, subject, { kind: 'VISIT_FINDING', title: `Non-conformity found on visit ${row.number}`, detail: body.remarks ?? '', sourceRef: `${row.number}:nc`, dueAt: dueIn(defaultDays) }, user);
    obligations.push(o.id);
  }

  const rating = await recomputeRating(c, row.subject_kind, row.subject_id, now);
  let cycle: CycleRow | null = null;
  if (row.cycle_id) {
    const cur = await c.query<CycleRow>('SELECT * FROM accreditation_cycles WHERE id = $1 FOR UPDATE', [row.cycle_id]);
    if (cur.rows[0]) {
      const cy = cur.rows[0]; const done = cy.visits_done + 1;
      const upd = await c.query<CycleRow>(
        `UPDATE accreditation_cycles SET visits_done = $2, last_visit_at = $3, last_visit_result = $4, next_visit_due = $5, rating = $6, updated_at = now() WHERE id = $1 RETURNING *`,
        [cy.id, done, visitedOn, body.result, nextVisitDue(new Date(cy.starts_on), new Date(cy.ends_on), cy.visits_required, done), rating]);
      cycle = upd.rows[0];
    }
  }
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.facilities.visitCompleted, {
    visitId: row.id, number: row.number, subjectKind: row.subject_kind, subjectId: row.subject_id, subjectName: row.subject_name, visitType: row.visit_type, category: row.category || null,
    visitedOn: row.visited_on, result: row.result, score: row.score == null ? null : Number(row.score), findings: findings.length, obligations: obligations.length, rating, inspector: row.inspector, cycleId: cycle?.id ?? null,
  }, { subject: row.subject_id }));
  return { row, rating, obligations, cycle };
}

export async function cancelVisit(c: PoolClient, env: Env, audit: AuditClient, visitId: string, reason: string, user?: Principal): Promise<VisitRow> {
  const before = await loadVisit(c, visitId, true);
  if (before.status !== 'SCHEDULED') throw conflict(`Only a scheduled visit can be cancelled; ${before.number} is ${before.status.toLowerCase()}`);
  if (!reason.trim()) throw badRequest('A visit is not cancelled without a reason on the record');
  const r = await c.query<VisitRow>(`UPDATE visits SET status = 'CANCELLED', cancel_reason = $2, updated_at = now() WHERE id = $1 RETURNING *`, [before.id, reason]);
  const row = r.rows[0];
  await audit.record(c, { action: 'VISIT_CANCELLED', entity: entityOf(row.subject_kind), entityId: row.subject_id, entityLabel: row.subject_name, before: visitApi(before), after: visitApi(row), note: reason });
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.facilities.visitCancelled, { visitId: row.id, number: row.number, subjectKind: row.subject_kind, subjectId: row.subject_id, subjectName: row.subject_name, reason, by: user?.name ?? '' }, { subject: row.subject_id }));
  return row;
}
