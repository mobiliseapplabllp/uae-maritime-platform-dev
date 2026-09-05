import { EVENTS, WILDCARD } from '@maritime/contracts';
import { AuditClient, enqueue, eventFromContext, conflict, forbidden, notFound, type Queryable } from '@maritime/service-kit';
import { isPrivileged } from './users/change-requests';
import { toSafe, UsersRepo, USER_SELECT, type UserRow } from './users/users.repo';
import type { AdminPolicy } from './policy';
import type { Env } from './env';

/*
 * Who still holds what.
 *
 * An access review is a cycle: every active account is listed with its role, scope and last sign-in, and a second person
 * confirms or revokes each one. Revocation deactivates the account then and there. Dormancy is the standing version of
 * the same question: an account nobody has used for longer than the policy allows is flagged, or switched off, by a
 * daily sweep — except the last account holding every permission, which the platform never switches off by itself.
 */
export interface CycleRow { id: string; opened_at: Date; due_at: Date; closed_at: Date | null; opened_by: string; closed_by: string; total: number; note: string; pending?: string; confirmed?: string; revoked?: string }
export interface ItemRow { id: string; cycle_id: string; user_id: string; user_name: string; user_email: string; role_name: string; scope: Record<string, unknown>; last_login_at: Date | null; dormant: boolean; privileged: boolean; decision: 'PENDING' | 'CONFIRMED' | 'REVOKED'; decided_by_id: string | null; decided_by: string; decided_at: Date | null; note: string }
export const cycleApi = (r: CycleRow) => ({ id: r.id, openedAt: r.opened_at, dueAt: r.due_at, closedAt: r.closed_at, openedBy: r.opened_by, closedBy: r.closed_by, total: r.total, note: r.note, pending: Number(r.pending ?? 0), confirmed: Number(r.confirmed ?? 0), revoked: Number(r.revoked ?? 0), status: r.closed_at ? 'CLOSED' : (new Date(r.due_at).getTime() < Date.now() ? 'OVERDUE' : 'OPEN') });
export const itemApi = (r: ItemRow) => ({ id: r.id, cycleId: r.cycle_id, userId: r.user_id, userName: r.user_name, userEmail: r.user_email, roleName: r.role_name, scope: r.scope, lastLoginAt: r.last_login_at, dormant: r.dormant, privileged: r.privileged, decision: r.decision, decidedById: r.decided_by_id, decidedBy: r.decided_by, decidedAt: r.decided_at, note: r.note });
const CYCLE_SELECT = `SELECT c.*, (SELECT count(*) FROM access_review_items i WHERE i.cycle_id = c.id AND i.decision = 'PENDING') AS pending,
  (SELECT count(*) FROM access_review_items i WHERE i.cycle_id = c.id AND i.decision = 'CONFIRMED') AS confirmed,
  (SELECT count(*) FROM access_review_items i WHERE i.cycle_id = c.id AND i.decision = 'REVOKED') AS revoked FROM access_review_cycles c`;
interface Deps { env: Env; audit: AuditClient; users: UsersRepo }
export interface Actor { id: string; name: string; email?: string }
const REVIEW_WINDOW_DAYS = 14;

export async function cycleById(c: Queryable, id: string): Promise<CycleRow> {
  const r = await c.query<CycleRow>(`${CYCLE_SELECT} WHERE c.id::text = $1`, [id]);
  if (!r.rows[0]) throw notFound('Access review not found');
  return r.rows[0];
}
export async function listCycles(c: Queryable): Promise<CycleRow[]> { return (await c.query<CycleRow>(`${CYCLE_SELECT} ORDER BY c.opened_at DESC LIMIT 50`)).rows; }
export async function openCycleRow(c: Queryable): Promise<CycleRow | null> { return (await c.query<CycleRow>(`${CYCLE_SELECT} WHERE c.closed_at IS NULL ORDER BY c.opened_at DESC LIMIT 1`)).rows[0] ?? null; }

/** Opens a cycle over every active account, unless one is already open — the scheduler may fire twice, the review opens once. */
export async function openCycle(c: Queryable, deps: Deps, policy: AdminPolicy, by: Actor, now = new Date()): Promise<{ cycle: CycleRow; created: boolean }> {
  const open = await openCycleRow(c);
  if (open) return { cycle: open, created: false };
  const users = (await c.query<UserRow>(`${USER_SELECT} WHERE u.active AND u.kind = 'user' ORDER BY u.name`)).rows;
  const due = new Date(now.getTime() + REVIEW_WINDOW_DAYS * 86_400_000);
  const cyc = (await c.query<CycleRow>('INSERT INTO access_review_cycles(opened_at, due_at, opened_by, total) VALUES ($1, $2, $3, $4) RETURNING *', [now, due, by.name, users.length])).rows[0];
  const dormantBefore = now.getTime() - policy.dormantAfterDays * 86_400_000;
  for (const u of users) {
    const ref = u.last_login_at ? new Date(u.last_login_at).getTime() : new Date(u.created_at).getTime();
    await c.query('INSERT INTO access_review_items(cycle_id, user_id, user_name, user_email, role_name, scope, last_login_at, dormant, privileged) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [cyc.id, u.id, u.name, u.email, u.role_name ?? '', JSON.stringify(u.scope ?? { level: 'NATIONAL' }), u.last_login_at, ref < dormantBefore, isPrivileged(u.role_permissions, policy)]);
  }
  await deps.audit.record(c, { action: 'ACCESS_REVIEW_OPENED', entity: 'AccessReview', entityId: cyc.id, entityLabel: `${users.length} accounts`, after: { dueAt: due, total: users.length }, actor: { ...by, kind: by.id === 'scheduler' ? 'system' : 'user' } });
  await enqueue(c, eventFromContext(deps.env.SERVICE_NAME, EVENTS.identity.accessReviewOpened, { cycleId: cyc.id, total: users.length, dueAt: due.toISOString(), openedBy: by.name }, { subject: cyc.id }));
  return { cycle: (await cycleById(c, cyc.id)), created: true };
}

export async function listItems(c: Queryable, cycleId: string, q: { decision?: string; q?: string; dormant?: boolean; privileged?: boolean }): Promise<ItemRow[]> {
  const where = ['cycle_id = $1']; const args: unknown[] = [cycleId];
  if (q.decision && ['PENDING', 'CONFIRMED', 'REVOKED'].includes(q.decision)) { args.push(q.decision); where.push(`decision = $${args.length}`); }
  if (q.q) { args.push(`%${q.q}%`); where.push(`(user_name ILIKE $${args.length} OR user_email ILIKE $${args.length} OR role_name ILIKE $${args.length})`); }
  if (q.dormant) where.push('dormant');
  if (q.privileged) where.push('privileged');
  const w = `WHERE ${where.join(' AND ')}`;
  return (await c.query<ItemRow>(`SELECT * FROM access_review_items ${w} ORDER BY decision = 'PENDING' DESC, privileged DESC, dormant DESC, user_name`, args)).rows;
}

/** One attestation. Revoking switches the account off now; a reviewer never attests their own account. */
export async function decideItem(c: Queryable, deps: Deps, cycleId: string, itemId: string, decision: 'CONFIRMED' | 'REVOKED', by: Actor, note = ''): Promise<ItemRow> {
  const cyc = await cycleById(c, cycleId);
  if (cyc.closed_at) throw conflict('This review is closed');
  const item = (await c.query<ItemRow>('SELECT * FROM access_review_items WHERE id::text = $1 AND cycle_id = $2 FOR UPDATE', [itemId, cyc.id])).rows[0];
  if (!item) throw notFound('Review item not found');
  if (item.user_id === by.id) throw forbidden('You cannot attest your own account — another reviewer must');
  if (item.decision !== 'PENDING') throw conflict(`This account was already ${item.decision.toLowerCase()}`);
  if (decision === 'REVOKED') {
    const u = await deps.users.byId(item.user_id, c);
    if (u && (u.role_permissions ?? []).includes(WILDCARD) && u.active && (await deps.users.activeWildcardHolders(c, u.id)) === 0) throw conflict('This is the last active account holding every permission; revoke another administrator first');
    if (u && u.active) {
      await c.query(`UPDATE users SET active = false, deactivated_reason = 'ACCESS_REVIEW', updated_at = now() WHERE id = $1`, [u.id]);
      await deps.users.revokeSessions(u.id, c);
      await deps.audit.record(c, { action: 'ACCESS_REVOKED', entity: 'User', entityId: u.id, entityLabel: u.email, before: toSafe(u), note, actor: { ...by, kind: 'user' } });
      await enqueue(c, eventFromContext(deps.env.SERVICE_NAME, EVENTS.identity.userChanged, { userId: u.id, change: 'deactivated', reason: 'ACCESS_REVIEW' }));
    }
  }
  const r = await c.query<ItemRow>('UPDATE access_review_items SET decision = $1, decided_by_id = $2, decided_by = $3, decided_at = now(), note = $4 WHERE id = $5 RETURNING *', [decision, by.id, by.name, note, item.id]);
  await deps.audit.record(c, { action: `ACCESS_${decision}`, entity: 'AccessReview', entityId: cyc.id, entityLabel: item.user_email, after: itemApi(r.rows[0]), note, actor: { ...by, kind: 'user' } });
  return r.rows[0];
}

export async function closeCycle(c: Queryable, deps: Deps, cycleId: string, by: Actor, note = ''): Promise<CycleRow> {
  const cyc = await cycleById(c, cycleId);
  if (cyc.closed_at) throw conflict('This review is already closed');
  if (Number(cyc.pending ?? 0) > 0) throw conflict(`${cyc.pending} account(s) are still waiting for a decision`);
  await c.query('UPDATE access_review_cycles SET closed_at = now(), closed_by = $1, note = $2 WHERE id = $3', [by.name, note, cyc.id]);
  const after = await cycleById(c, cyc.id);
  await deps.audit.record(c, { action: 'ACCESS_REVIEW_CLOSED', entity: 'AccessReview', entityId: cyc.id, entityLabel: `${after.total} accounts`, after: cycleApi(after), note, actor: { ...by, kind: 'user' } });
  await enqueue(c, eventFromContext(deps.env.SERVICE_NAME, EVENTS.identity.accessReviewClosed, { cycleId: cyc.id, confirmed: Number(after.confirmed ?? 0), revoked: Number(after.revoked ?? 0), closedBy: by.name }, { subject: cyc.id }));
  return after;
}

/** The daily sweep. Never touches the last account holding every permission, nor service and agent identities. */
export async function sweepDormant(c: Queryable, deps: Deps, policy: AdminPolicy, now = new Date()): Promise<{ flagged: number; deactivated: number; examined: number }> {
  const before = new Date(now.getTime() - policy.dormantAfterDays * 86_400_000);
  const rows = (await c.query<UserRow>(`${USER_SELECT} WHERE u.active AND u.kind = 'user' AND coalesce(u.last_login_at, u.created_at) < $1 ORDER BY u.email`, [before])).rows;
  let flagged = 0; let deactivated = 0;
  const holders = await deps.users.activeWildcardHolders(c);
  let holdersLeft = holders;
  for (const u of rows) {
    const holdsAll = (u.role_permissions ?? []).includes(WILDCARD);
    if (holdsAll && holdersLeft <= 1) continue;
    if (policy.dormantAction === 'DEACTIVATE') {
      await c.query(`UPDATE users SET active = false, deactivated_reason = 'DORMANT', dormant_since = coalesce(dormant_since, $2), updated_at = now() WHERE id = $1`, [u.id, now]);
      await deps.users.revokeSessions(u.id, c);
      if (holdsAll) holdersLeft -= 1;
      deactivated += 1;
      await deps.audit.record(c, { action: 'DORMANT_DEACTIVATED', entity: 'User', entityId: u.id, entityLabel: u.email, after: { lastLoginAt: u.last_login_at, dormantAfterDays: policy.dormantAfterDays }, actor: { id: 'scheduler', name: 'Dormant account sweep', kind: 'system' } });
      await enqueue(c, eventFromContext(deps.env.SERVICE_NAME, EVENTS.identity.userChanged, { userId: u.id, change: 'deactivated', reason: 'DORMANT' }));
    } else if (!u.dormant_since) {
      await c.query('UPDATE users SET dormant_since = $2, updated_at = now() WHERE id = $1', [u.id, now]);
      flagged += 1;
      await deps.audit.record(c, { action: 'DORMANT_FLAGGED', entity: 'User', entityId: u.id, entityLabel: u.email, after: { lastLoginAt: u.last_login_at, dormantAfterDays: policy.dormantAfterDays }, actor: { id: 'scheduler', name: 'Dormant account sweep', kind: 'system' } });
    } else continue;
    await enqueue(c, eventFromContext(deps.env.SERVICE_NAME, EVENTS.identity.accountDormant, { userId: u.id, email: u.email, name: u.name, roleName: u.role_name, lastLoginAt: u.last_login_at, action: policy.dormantAction }, { subject: u.id }));
  }
  return { flagged, deactivated, examined: rows.length };
}
