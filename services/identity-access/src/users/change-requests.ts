import { EVENTS, WILDCARD } from '@maritime/contracts';
import { AuditClient, enqueue, eventFromContext, conflict, forbidden, notFound, type Queryable } from '@maritime/service-kit';
import type { AdminPolicy } from '../policy';
import type { Env } from '../env';

/*
 * Four eyes on a privileged grant.
 *
 * A role that holds the wildcard, or the right to manage users or roles, is the platform's own keys. Handing those to
 * an account — or editing what such a role may do — is not applied by the administrator who asks for it; it waits here
 * until a different administrator approves it, and the request records both names. The list of permissions that make a
 * role privileged is a setting, so an administration can widen it (settings, model deployment) without a release.
 */
export type ChangeKind = 'USER_CREATE' | 'USER_ROLE' | 'USER_ACTIVATE' | 'ROLE_MATRIX';
export interface ChangeRow {
  id: string; kind: ChangeKind; subject_id: string; subject_label: string; payload: Record<string, unknown>; reason: string;
  requested_by_id: string | null; requested_by: string; requested_at: Date; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'CANCELLED';
  decided_by_id: string | null; decided_by: string; decided_at: Date | null; decision_note: string;
}
export const changeApi = (r: ChangeRow) => ({
  id: r.id, kind: r.kind, subjectId: r.subject_id, subjectLabel: r.subject_label, payload: r.payload, reason: r.reason,
  requestedById: r.requested_by_id, requestedBy: r.requested_by, requestedAt: r.requested_at, status: r.status,
  decidedById: r.decided_by_id, decidedBy: r.decided_by, decidedAt: r.decided_at, decisionNote: r.decision_note,
  /** Which permission approves it: an account change is an account matter, a role edit is a roles matter. */
  approvalPerm: approvalPerm(r.kind),
});
export const approvalPerm = (kind: ChangeKind): string => (kind === 'ROLE_MATRIX' ? 'roles.manage' : 'users.manage');

/** A role is privileged when it holds every permission, or any of the permissions the policy names. */
export const isPrivileged = (permissions: readonly string[] | null | undefined, policy: AdminPolicy): boolean => {
  const perms = permissions ?? [];
  if (perms.includes(WILDCARD)) return true;
  return policy.fourEyesPermissions.some((p) => p === WILDCARD ? false : perms.includes(p));
};

export interface Actor { id: string; name: string; email?: string }
interface Deps { env: Env; audit: AuditClient }

export async function findChange(c: Queryable, id: string): Promise<ChangeRow> {
  const r = await c.query<ChangeRow>('SELECT * FROM change_requests WHERE id::text = $1', [id]);
  if (!r.rows[0]) throw notFound('Change request not found');
  return r.rows[0];
}
export async function pendingFor(c: Queryable, subjectId: string, kind?: ChangeKind): Promise<ChangeRow | null> {
  const r = await c.query<ChangeRow>(`SELECT * FROM change_requests WHERE subject_id = $1 AND status = 'PENDING' AND ($2::text IS NULL OR kind = $2) ORDER BY requested_at DESC LIMIT 1`, [subjectId, kind ?? null]);
  return r.rows[0] ?? null;
}

/** Files the request and tells the administrators who can act on it. */
export async function requestChange(c: Queryable, deps: Deps, input: { kind: ChangeKind; subjectId: string; subjectLabel: string; payload: Record<string, unknown>; reason?: string; by: Actor }): Promise<ChangeRow> {
  const open = await pendingFor(c, input.subjectId, input.kind);
  if (open) throw conflict(`A ${input.kind.toLowerCase().replace('_', ' ')} request for ${input.subjectLabel} is already waiting for approval`);
  const r = await c.query<ChangeRow>(
    `INSERT INTO change_requests(kind, subject_id, subject_label, payload, reason, requested_by_id, requested_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [input.kind, input.subjectId, input.subjectLabel, JSON.stringify(input.payload), input.reason ?? '', input.by.id, input.by.name]);
  const row = r.rows[0];
  await deps.audit.record(c, { action: 'CHANGE_REQUESTED', entity: 'ChangeRequest', entityId: row.id, entityLabel: `${row.kind} — ${row.subject_label}`, after: changeApi(row), note: input.reason });
  await enqueue(c, eventFromContext(deps.env.SERVICE_NAME, EVENTS.identity.changeRequested, { ...changeApi(row) }, { subject: row.id }));
  return row;
}

/** The change itself, applied exactly as it was requested — the approver approves what was asked, not something else. */
export async function applyChange(c: Queryable, deps: Deps, row: ChangeRow, by: Actor): Promise<void> {
  const p = row.payload as Record<string, unknown>;
  if (row.kind === 'USER_CREATE' || row.kind === 'USER_ACTIVATE') {
    await c.query(`UPDATE users SET active = true, deactivated_reason = '', dormant_since = NULL, updated_at = now() WHERE id = $1`, [row.subject_id]);
  } else if (row.kind === 'USER_ROLE') {
    await c.query('UPDATE users SET role_id = $1, updated_at = now() WHERE id = $2', [String(p.roleId), row.subject_id]);
  } else if (row.kind === 'ROLE_MATRIX') {
    await c.query('UPDATE roles SET name = $1, description = $2, permissions = $3, mfa_required = $4, updated_at = now() WHERE id = $5',
      [String(p.name), String(p.description ?? ''), (p.permissions as string[]) ?? [], p.mfaRequired !== false, row.subject_id]);
  }
  const entity = row.kind === 'ROLE_MATRIX' ? 'Role' : 'User';
  await deps.audit.record(c, { action: `${row.kind}_APPLIED`, entity, entityId: row.subject_id, entityLabel: row.subject_label, after: { requestedBy: row.requested_by, approvedBy: by.name, ...p } });
  if (row.kind === 'ROLE_MATRIX') await enqueue(c, eventFromContext(deps.env.SERVICE_NAME, EVENTS.identity.roleChanged, { roleId: row.subject_id, name: p.name }));
  else await enqueue(c, eventFromContext(deps.env.SERVICE_NAME, EVENTS.identity.userChanged, { userId: row.subject_id, change: row.kind.toLowerCase() }));
}

export async function decideChange(c: Queryable, deps: Deps, id: string, decision: 'APPROVED' | 'REJECTED' | 'CANCELLED', by: Actor & { perms: string[] }, note = ''): Promise<ChangeRow> {
  const row = await findChange(c, id);
  if (row.status !== 'PENDING') throw conflict(`This request was already ${row.status.toLowerCase()}`);
  const holds = (perm: string) => by.perms.includes(WILDCARD) || by.perms.includes(perm);
  if (decision === 'CANCELLED') {
    if (row.requested_by_id !== by.id && !holds('users.manage')) throw forbidden('Only the requester or an administrator can cancel a request');
  } else {
    if (!holds(approvalPerm(row.kind))) throw forbidden(`Deciding this request needs ${approvalPerm(row.kind)}`);
    // the point of the control: the person who asked is never the person who approves
    if (row.requested_by_id === by.id) throw forbidden('You cannot approve or reject your own request — a second administrator must');
  }
  if (decision === 'APPROVED') await applyChange(c, deps, row, by);
  const r = await c.query<ChangeRow>('UPDATE change_requests SET status = $1, decided_by_id = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $5 RETURNING *', [decision, by.id, by.name, note, row.id]);
  const after = r.rows[0];
  await deps.audit.record(c, { action: `CHANGE_${decision}`, entity: 'ChangeRequest', entityId: after.id, entityLabel: `${after.kind} — ${after.subject_label}`, before: changeApi(row), after: changeApi(after), note });
  await enqueue(c, eventFromContext(deps.env.SERVICE_NAME, EVENTS.identity.changeDecided, { ...changeApi(after), decision }, { subject: after.id }));
  return after;
}
