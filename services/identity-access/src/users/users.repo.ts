import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { KIT_POOL, type Queryable } from '@maritime/service-kit';
import type { Principal } from '@maritime/service-kit';

export interface UserRow {
  id: string; name: string; email: string; password_hash: string | null; role_id: string; designation: string; department: string; phone: string; active: boolean; subject: string | null; kind: string; scope: Record<string, unknown>; last_login_at: Date | null; created_at: Date; updated_at: Date;
  mfa_secret: string | null; mfa_pending_secret: string | null; mfa_enrolled_at: Date | null; mfa_last_step: string | number | null; mfa_recovery: string[]; mfa_due_at: Date | null;
  dormant_since: Date | null; deactivated_reason: string;
  role_name?: string; role_permissions?: string[]; role_mfa_required?: boolean;
  pending_change_id?: string | null; pending_change_kind?: string | null;
}

/** The account as the screens see it: no hash, no secret, and the second-factor state as facts rather than material. */
export const toSafe = (u: UserRow) => ({
  id: u.id, name: u.name, email: u.email, designation: u.designation, department: u.department, phone: u.phone, active: u.active, kind: u.kind, scope: u.scope,
  role: { id: u.role_id, name: u.role_name ?? '', permissions: u.role_permissions ?? [], mfaRequired: u.role_mfa_required ?? true }, perms: u.role_permissions ?? [],
  mfa: { enrolled: !!u.mfa_enrolled_at, enrolledAt: u.mfa_enrolled_at, required: u.role_mfa_required ?? true, dueAt: u.mfa_due_at, recoveryCodesLeft: (u.mfa_recovery ?? []).length },
  dormantSince: u.dormant_since, deactivatedReason: u.deactivated_reason ?? '',
  pendingChange: u.pending_change_id ? { id: u.pending_change_id, kind: u.pending_change_kind } : null,
  lastLoginAt: u.last_login_at, createdAt: u.created_at, updatedAt: u.updated_at,
});
export const toPrincipal = (u: UserRow): Principal => ({
  id: u.id, sub: u.subject ?? u.id, name: u.name, email: u.email, roleName: u.role_name, perms: u.role_permissions ?? [], scope: (u.scope as never) ?? { level: 'NATIONAL' }, kind: (u.kind as Principal['kind']) ?? 'user', active: u.active,
});
const SELECT = `SELECT u.*, r.name AS role_name, r.permissions AS role_permissions, r.mfa_required AS role_mfa_required,
  p.id AS pending_change_id, p.kind AS pending_change_kind
  FROM users u JOIN roles r ON r.id = u.role_id
  LEFT JOIN LATERAL (SELECT id, kind FROM change_requests c WHERE c.subject_id = u.id AND c.status = 'PENDING' ORDER BY requested_at DESC LIMIT 1) p ON true`;
export const USER_SELECT = SELECT;

@Injectable()
export class UsersRepo {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool) {}
  q(): Queryable { return this.pool; }
  async byId(id: string, c: Queryable = this.pool): Promise<UserRow | null> { const r = await c.query<UserRow>(`${SELECT} WHERE u.id = $1`, [id]); return r.rows[0] ?? null; }
  async byEmail(email: string, c: Queryable = this.pool): Promise<UserRow | null> { const r = await c.query<UserRow>(`${SELECT} WHERE lower(u.email) = lower($1)`, [email]); return r.rows[0] ?? null; }
  async bySubject(sub: string, c: Queryable = this.pool): Promise<UserRow | null> { const r = await c.query<UserRow>(`${SELECT} WHERE u.subject = $1 OR u.id::text = $1`, [sub]); return r.rows[0] ?? null; }
  /** How many active accounts hold every permission — the platform must never lose its last one. */
  async activeWildcardHolders(c: Queryable = this.pool, exceptUserId?: string): Promise<number> {
    const r = await c.query<{ n: string }>(`SELECT count(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE u.active AND '*' = ANY(r.permissions) AND ($1::uuid IS NULL OR u.id <> $1)`, [exceptUserId ?? null]);
    return Number(r.rows[0].n);
  }
  /** Whether someone other than `userId` could approve — holds the permission and is active. */
  async otherApproverExists(perm: string, userId: string, c: Queryable = this.pool): Promise<boolean> {
    const r = await c.query<{ n: string }>(`SELECT count(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE u.active AND u.id <> $1 AND ('*' = ANY(r.permissions) OR $2 = ANY(r.permissions))`, [userId, perm]);
    return Number(r.rows[0].n) > 0;
  }
  async revokeSessions(userId: string, c: Queryable = this.pool): Promise<void> {
    await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  }
}
