import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { KIT_POOL, type Queryable } from '@maritime/service-kit';
import type { Principal } from '@maritime/service-kit';

export interface UserRow { id: string; name: string; email: string; password_hash: string | null; role_id: string; designation: string; department: string; phone: string; active: boolean; subject: string | null; kind: string; scope: Record<string, unknown>; last_login_at: Date | null; created_at: Date; updated_at: Date; role_name?: string; role_permissions?: string[] }

export const toSafe = (u: UserRow) => ({
  id: u.id, name: u.name, email: u.email, designation: u.designation, department: u.department, phone: u.phone, active: u.active, kind: u.kind, scope: u.scope,
  role: { id: u.role_id, name: u.role_name ?? '', permissions: u.role_permissions ?? [] }, perms: u.role_permissions ?? [],
  lastLoginAt: u.last_login_at, createdAt: u.created_at, updatedAt: u.updated_at,
});
export const toPrincipal = (u: UserRow): Principal => ({
  id: u.id, sub: u.subject ?? u.id, name: u.name, email: u.email, roleName: u.role_name, perms: u.role_permissions ?? [], scope: (u.scope as never) ?? { level: 'NATIONAL' }, kind: (u.kind as Principal['kind']) ?? 'user', active: u.active,
});
const SELECT = 'SELECT u.*, r.name AS role_name, r.permissions AS role_permissions FROM users u JOIN roles r ON r.id = u.role_id';

@Injectable()
export class UsersRepo {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool) {}
  q(): Queryable { return this.pool; }
  async byId(id: string, c: Queryable = this.pool): Promise<UserRow | null> { const r = await c.query<UserRow>(`${SELECT} WHERE u.id = $1`, [id]); return r.rows[0] ?? null; }
  async byEmail(email: string, c: Queryable = this.pool): Promise<UserRow | null> { const r = await c.query<UserRow>(`${SELECT} WHERE lower(u.email) = lower($1)`, [email]); return r.rows[0] ?? null; }
  async bySubject(sub: string, c: Queryable = this.pool): Promise<UserRow | null> { const r = await c.query<UserRow>(`${SELECT} WHERE u.subject = $1 OR u.id::text = $1`, [sub]); return r.rows[0] ?? null; }
}
