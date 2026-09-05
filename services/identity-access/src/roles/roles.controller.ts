import { Body, Controller, Delete, Get, Inject, Param, Post, Put } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, isKnownPermission, WILDCARD } from '@maritime/contracts';
import { KIT_ENV, KIT_POOL, AuditClient, CurrentUser, RequirePerm, zod, notFound, badRequest, forbidden, conflict, withTx, enqueue, eventFromContext, type Principal } from '@maritime/service-kit';
import { isPrivileged, requestChange } from '../users/change-requests';
import { UsersRepo } from '../users/users.repo';
import { PolicyService } from '../policy';
import type { Env } from '../env';

const roleSchema = z.object({ name: z.string().min(2).max(80), description: z.string().max(300).optional().default(''), permissions: z.array(z.string()).max(200), mfaRequired: z.boolean().optional(), reason: z.string().max(500).optional() });
interface RoleRow { id: string; code: string | null; name: string; description: string; permissions: string[]; system: boolean; mfa_required: boolean; created_at: Date; updated_at: Date; users_count?: string; pending_change_id?: string | null }
const toApi = (r: RoleRow) => ({ id: r.id, code: r.code, name: r.name, description: r.description, permissions: r.permissions, system: r.system, mfaRequired: r.mfa_required, usersCount: Number(r.users_count ?? 0), pendingChange: r.pending_change_id ? { id: r.pending_change_id, kind: 'ROLE_MATRIX' } : null, createdAt: r.created_at, updatedAt: r.updated_at });
const SELECT = `SELECT r.*, (SELECT count(*) FROM users u WHERE u.role_id = r.id) AS users_count,
  (SELECT id FROM change_requests c WHERE c.subject_id = r.id AND c.status = 'PENDING' ORDER BY requested_at DESC LIMIT 1) AS pending_change_id FROM roles r`;

@Controller('roles')
export class RolesController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient, private readonly users: UsersRepo, private readonly policy: PolicyService) {}
  private validPerms(perms: string[]) {
    const bad = perms.filter((p) => !isKnownPermission(p));
    if (bad.length) throw badRequest(`Unknown permissions: ${bad.join(', ')}`);
    return Array.from(new Set(perms));
  }
  private async byId(id: string): Promise<RoleRow | null> {
    const r = await this.pool.query<RoleRow>(`${SELECT} WHERE r.id = $1`, [id]);
    return r.rows[0] ?? null;
  }

  @RequirePerm('roles.view') @Get()
  async list() {
    const r = await this.pool.query<RoleRow>(`${SELECT} ORDER BY r.system DESC, r.name`);
    return r.rows.map(toApi);
  }
  @RequirePerm('roles.manage') @Post()
  async create(@Body(zod(roleSchema)) body: z.infer<typeof roleSchema>) {
    const perms = this.validPerms(body.permissions);
    if (perms.includes(WILDCARD)) throw forbidden('Only the Super Admin role may hold every permission');
    return withTx(this.pool, async (c) => {
      const r = await c.query<RoleRow>('INSERT INTO roles(name, description, permissions, mfa_required) VALUES ($1, $2, $3, $4) RETURNING *', [body.name, body.description, perms, body.mfaRequired !== false]);
      await this.audit.record(c, { action: 'CREATE', entity: 'Role', entityId: r.rows[0].id, entityLabel: r.rows[0].name, after: toApi(r.rows[0]) });
      return toApi(r.rows[0]);
    });
  }
  /**
   * Editing a privileged role is itself a privileged act: what the wildcard, users.manage or roles.manage can do is
   * decided by two administrators, not one. Everything else applies immediately.
   */
  @RequirePerm('roles.manage') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(roleSchema.partial())) body: Partial<z.infer<typeof roleSchema>>, @CurrentUser() me: Principal) {
    const before = await this.byId(id); if (!before) throw notFound('Role not found');
    if (before.permissions.includes(WILDCARD)) throw forbidden('The Super Admin role cannot be modified');
    if (before.system && body.name && body.name !== before.name) throw forbidden('System roles cannot be renamed');
    const perms = body.permissions ? this.validPerms(body.permissions) : before.permissions;
    if (perms.includes(WILDCARD)) throw forbidden('Only the Super Admin role may hold every permission');
    const next = { name: body.name ?? before.name, description: body.description ?? before.description, permissions: perms, mfaRequired: body.mfaRequired ?? before.mfa_required };
    const policy = await this.policy.get();
    return withTx(this.pool, async (c) => {
      const privileged = isPrivileged(before.permissions, policy) || isPrivileged(perms, policy);
      if (privileged && (await this.users.otherApproverExists('roles.manage', me.id, c))) {
        const req = await requestChange(c, { env: this.env, audit: this.audit }, { kind: 'ROLE_MATRIX', subjectId: id, subjectLabel: before.name, payload: { ...next, fromPermissions: before.permissions }, reason: body.reason, by: { id: me.id, name: me.name, email: me.email } });
        return { ...toApi(before), pendingChange: { id: req.id, kind: req.kind } };
      }
      const r = await c.query<RoleRow>('UPDATE roles SET name = $1, description = $2, permissions = $3, mfa_required = $4, updated_at = now() WHERE id = $5 RETURNING *', [next.name, next.description, next.permissions, next.mfaRequired, id]);
      await this.audit.record(c, { action: 'UPDATE', entity: 'Role', entityId: id, entityLabel: r.rows[0].name, before: toApi(before), after: toApi(r.rows[0]), note: privileged ? 'privileged role edited without a second administrator: none exists' : undefined });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.identity.roleChanged, { roleId: id, name: r.rows[0].name }));
      return toApi({ ...r.rows[0], users_count: before.users_count });
    });
  }
  @RequirePerm('roles.manage') @Delete(':id')
  async remove(@Param('id') id: string) {
    const before = await this.byId(id); if (!before) throw notFound('Role not found');
    if (before.system) throw forbidden('System roles cannot be deleted');
    if (Number(before.users_count ?? 0) > 0) throw conflict('Role is assigned to users and cannot be deleted');
    await withTx(this.pool, async (c) => {
      await c.query('DELETE FROM roles WHERE id = $1', [id]);
      await this.audit.record(c, { action: 'DELETE', entity: 'Role', entityId: id, entityLabel: before.name, before: toApi(before) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.identity.roleChanged, { roleId: id, name: before.name, deleted: true }));
    });
    return { deleted: true };
  }
}
