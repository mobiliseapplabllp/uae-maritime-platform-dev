import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, PASSWORD_MAX, SCOPE_LEVELS, passwordProblems, type PageQuery } from '@maritime/contracts';
import { KIT_ENV, KIT_POOL, AuditClient, CurrentUser, RequirePerm, zod, paged, parsePage, escapeLike, notFound, badRequest, forbidden, conflict, withTx, enqueue, eventFromContext, type Principal, type Queryable } from '@maritime/service-kit';
import { UsersRepo, toSafe, USER_SELECT, type UserRow } from './users.repo';
import { changeApi, decideChange, isPrivileged, requestChange, type ChangeRow } from './change-requests';
import { PolicyService, type AdminPolicy } from '../policy';
import { MfaService } from '../mfa/mfa.service';
import { AuthService } from '../auth/auth.service';
import type { Env } from '../env';

const keys = z.array(z.string().min(1).max(64)).max(50).optional();
const scopeSchema = z.object({ level: z.enum(SCOPE_LEVELS), ports: keys, zones: keys, facilities: keys, companies: keys });
const userSchema = z.object({
  name: z.string().min(1).max(120), email: z.string().email().max(200), password: z.string().max(PASSWORD_MAX).optional(), roleId: z.string().uuid(),
  designation: z.string().max(120).optional().default(''), department: z.string().max(120).optional().default(''), phone: z.string().max(40).optional().default(''), active: z.boolean().optional().default(true),
  scope: scopeSchema.optional(), reason: z.string().max(500).optional(),
});
const resetSchema = z.object({ password: z.string().max(PASSWORD_MAX) });
const noteSchema = z.object({ note: z.string().max(500).optional().default('') });
const SORT: Record<string, string> = { name: 'u.name', email: 'u.email', createdAt: 'u.created_at', lastLoginAt: 'u.last_login_at', designation: 'u.designation', department: 'u.department', active: 'u.active' };
interface RoleLite { id: string; name: string; permissions: string[] }

@Controller('users')
export class UsersController {
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly users: UsersRepo, private readonly audit: AuditClient,
    private readonly policy: PolicyService, private readonly mfa: MfaService, private readonly auth: AuthService,
  ) {}
  private get deps() { return { env: this.env, audit: this.audit }; }
  /** The policy is enforced at every point a password is set, not only where a person types one. */
  private async assertPolicy(password: string, subject: { email?: string | null; name?: string | null }) {
    const policy = await this.policy.get();
    const problems = passwordProblems(password, subject, { minLength: policy.passwordMinLength });
    if (problems.length) throw badRequest(problems.join('; '));
  }
  private async roleById(c: Queryable, id: string): Promise<RoleLite> {
    const r = await c.query<RoleLite>('SELECT id, name, permissions FROM roles WHERE id = $1', [id]);
    if (!r.rows[0]) throw badRequest('Unknown role');
    return r.rows[0];
  }
  /** Scope keys are trimmed, deduplicated and kept to the level's own list plus the containing ports. */
  private cleanScope(scope: z.infer<typeof scopeSchema>) {
    const clean = (a?: string[]) => [...new Set((a ?? []).map((s) => s.trim()).filter(Boolean))];
    const out: Record<string, unknown> = { level: scope.level };
    if (scope.level === 'PORT') out.ports = clean(scope.ports);
    if (scope.level === 'ZONE') { out.zones = clean(scope.zones); out.ports = clean(scope.ports); }
    if (scope.level === 'FACILITY') { out.facilities = clean(scope.facilities); out.ports = clean(scope.ports); }
    if (scope.level === 'COMPANY') out.companies = clean(scope.companies);
    return out;
  }
  private actor(me: Principal) { return { id: me.id, name: me.name, email: me.email }; }

  /* ------------------------------------------------------------------------------- approvals --- */
  /** Declared before `:id` so the path is not read as an account id. */
  @RequirePerm('users.view', 'roles.view') @Get('changes')
  async changes(@Query() query: { status?: string; limit?: string }) {
    const status = ['PENDING', 'APPROVED', 'REJECTED', 'CANCELLED'].includes(String(query.status)) ? String(query.status) : 'PENDING';
    const limit = Math.min(200, Math.max(1, Number(query.limit) || 50));
    const r = await this.pool.query<ChangeRow>('SELECT * FROM change_requests WHERE status = $1 ORDER BY requested_at DESC LIMIT $2', [status, limit]);
    return r.rows.map(changeApi);
  }
  @RequirePerm('users.manage', 'roles.manage') @Post('changes/:id/approve')
  approve(@Param('id') id: string, @Body(zod(noteSchema)) body: z.infer<typeof noteSchema>, @CurrentUser() me: Principal) {
    return withTx(this.pool, async (c) => changeApi(await decideChange(c, this.deps, id, 'APPROVED', { ...this.actor(me), perms: me.perms }, body.note)));
  }
  @RequirePerm('users.manage', 'roles.manage') @Post('changes/:id/reject')
  reject(@Param('id') id: string, @Body(zod(noteSchema)) body: z.infer<typeof noteSchema>, @CurrentUser() me: Principal) {
    return withTx(this.pool, async (c) => changeApi(await decideChange(c, this.deps, id, 'REJECTED', { ...this.actor(me), perms: me.perms }, body.note)));
  }
  @RequirePerm('users.manage', 'roles.manage') @Post('changes/:id/cancel')
  cancel(@Param('id') id: string, @Body(zod(noteSchema)) body: z.infer<typeof noteSchema>, @CurrentUser() me: Principal) {
    return withTx(this.pool, async (c) => changeApi(await decideChange(c, this.deps, id, 'CANCELLED', { ...this.actor(me), perms: me.perms }, body.note)));
  }

  /* -------------------------------------------------------------------------------- accounts --- */
  @RequirePerm('users.view') @Get()
  async list(@Query() query: PageQuery & { role?: string; active?: string; department?: string; level?: string; pending?: string; dormant?: string; mfa?: string }) {
    const p = parsePage(query, { defaultSort: 'name', sortable: Object.keys(SORT) });
    const where: string[] = []; const args: unknown[] = [];
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(u.name ILIKE $${args.length} OR u.email ILIKE $${args.length} OR u.designation ILIKE $${args.length} OR u.department ILIKE $${args.length})`); }
    if (query.role) { args.push(query.role); where.push(`(r.id::text = $${args.length} OR r.name = $${args.length})`); }
    if (query.department) { args.push(query.department); where.push(`u.department = $${args.length}`); }
    if (query.active === 'true' || query.active === 'false') { args.push(query.active === 'true'); where.push(`u.active = $${args.length}`); }
    if (query.level) { args.push(query.level); where.push(`u.scope->>'level' = $${args.length}`); }
    if (query.pending === 'true') where.push(`EXISTS (SELECT 1 FROM change_requests c WHERE c.subject_id = u.id AND c.status = 'PENDING')`);
    if (query.dormant === 'true') where.push('u.dormant_since IS NOT NULL');
    if (query.mfa === 'enrolled' || query.mfa === 'missing') where.push(query.mfa === 'enrolled' ? 'u.mfa_enrolled_at IS NOT NULL' : 'u.mfa_enrolled_at IS NULL');
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM users u JOIN roles r ON r.id = u.role_id ${w}`, args);
    const rows = await this.pool.query<UserRow>(`${USER_SELECT} ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, u.id LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(toSafe), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  @RequirePerm('users.view') @Get(':id')
  async get(@Param('id') id: string) { const u = await this.users.byId(id); if (!u) throw notFound('User not found'); return toSafe(u); }

  @RequirePerm('users.manage') @Post()
  async create(@Body(zod(userSchema)) body: z.infer<typeof userSchema>, @CurrentUser() me: Principal) {
    if (this.env.AUTH_MODE === 'local' && !body.password) throw badRequest('Password is required');
    if (body.password) await this.assertPolicy(body.password, { email: body.email, name: body.name });
    const hash = body.password ? await bcrypt.hash(body.password, this.env.BCRYPT_ROUNDS) : null;
    const policy = await this.policy.get();
    return withTx(this.pool, async (c) => {
      const role = await this.roleById(c, body.roleId);
      // a privileged account starts inactive and is switched on by a second administrator
      const privileged = isPrivileged(role.permissions, policy);
      const needsApproval = privileged && body.active && (await this.users.otherApproverExists('users.manage', me.id, c));
      const r = await c.query<{ id: string }>('INSERT INTO users(name, email, password_hash, role_id, designation, department, phone, active, scope) VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8, $9) RETURNING id',
        [body.name, body.email, hash, body.roleId, body.designation, body.department, body.phone, needsApproval ? false : body.active, JSON.stringify(body.scope ? this.cleanScope(body.scope) : { level: 'NATIONAL' })]);
      const created = (await this.users.byId(r.rows[0].id, c))!;
      await this.audit.record(c, { action: 'CREATE', entity: 'User', entityId: created.id, entityLabel: created.email, after: toSafe(created), note: privileged && !needsApproval && body.active ? 'privileged role applied without a second administrator: none exists' : undefined });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.identity.userChanged, { userId: created.id, change: 'created' }));
      if (needsApproval) {
        const req = await requestChange(c, this.deps, { kind: 'USER_CREATE', subjectId: created.id, subjectLabel: `${created.name} <${created.email}> as ${role.name}`, payload: { roleId: role.id, roleName: role.name }, reason: body.reason, by: this.actor(me) });
        return { ...toSafe((await this.users.byId(created.id, c))!), pendingChange: { id: req.id, kind: req.kind } };
      }
      return toSafe(created);
    });
  }

  @RequirePerm('users.manage') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(userSchema.partial())) body: Partial<z.infer<typeof userSchema>>, @CurrentUser() me: Principal) {
    const before = await this.users.byId(id); if (!before) throw notFound('User not found');
    const policy = await this.policy.get();
    const roleChanges = body.roleId !== undefined && body.roleId !== before.role_id;
    const scopeChanges = body.scope !== undefined && JSON.stringify(this.cleanScope(body.scope!)) !== JSON.stringify(before.scope);
    const deactivates = body.active === false && before.active;
    const reactivates = body.active === true && !before.active;
    // nobody widens or narrows their own reach: role, scope and status are another administrator's to change
    if (id === me.id && (roleChanges || scopeChanges || deactivates)) throw forbidden('Ask another administrator to change your own role, scope or status');
    return withTx(this.pool, async (c) => {
      const holdsAll = (before.role_permissions ?? []).includes('*');
      let newRole: RoleLite | null = null;
      if (roleChanges) newRole = await this.roleById(c, body.roleId!);
      // the platform never loses its last administrator
      if (holdsAll && before.active && (deactivates || (newRole && !newRole.permissions.includes('*'))) && (await this.users.activeWildcardHolders(c, id)) === 0) throw conflict('This is the last active account holding every permission; it cannot be deactivated or demoted');
      const pending: ChangeRow[] = [];
      const sets: string[] = []; const args: unknown[] = [];
      const set = (col: string, val: unknown) => { args.push(val); sets.push(`${col} = $${args.length}`); };
      if (body.name !== undefined) set('name', body.name);
      if (body.email !== undefined) set('email', body.email.toLowerCase());
      if (body.designation !== undefined) set('designation', body.designation);
      if (body.department !== undefined) set('department', body.department);
      if (body.phone !== undefined) set('phone', body.phone);
      if (scopeChanges) set('scope', JSON.stringify(this.cleanScope(body.scope!)));
      if (roleChanges && newRole) {
        if (isPrivileged(newRole.permissions, policy) && (await this.users.otherApproverExists('users.manage', me.id, c))) {
          pending.push(await requestChange(c, this.deps, { kind: 'USER_ROLE', subjectId: id, subjectLabel: `${before.name} <${before.email}> to ${newRole.name}`, payload: { roleId: newRole.id, roleName: newRole.name, fromRoleId: before.role_id, fromRoleName: before.role_name }, reason: body.reason, by: this.actor(me) }));
        } else set('role_id', newRole.id);
      }
      if (deactivates) { set('active', false); set('deactivated_reason', 'ADMIN'); }
      if (reactivates) {
        const privilegedNow = isPrivileged(newRole?.permissions ?? before.role_permissions, policy);
        if (privilegedNow && (await this.users.otherApproverExists('users.manage', me.id, c))) {
          pending.push(await requestChange(c, this.deps, { kind: 'USER_ACTIVATE', subjectId: id, subjectLabel: `${before.name} <${before.email}>`, payload: { roleName: newRole?.name ?? before.role_name }, reason: body.reason, by: this.actor(me) }));
        } else { set('active', true); set('deactivated_reason', ''); set('dormant_since', null); }
      }
      if (body.password) {
        await this.assertPolicy(body.password, { email: body.email ?? before.email, name: body.name ?? before.name });
        set('password_hash', await bcrypt.hash(body.password, this.env.BCRYPT_ROUNDS));
      }
      if (sets.length) {
        args.push(id);
        await c.query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${args.length}`, args);
        if (deactivates) await this.users.revokeSessions(id, c);
      }
      const after = (await this.users.byId(id, c))!;
      if (sets.length) {
        await this.audit.record(c, { action: 'UPDATE', entity: 'User', entityId: id, entityLabel: after.email, before: toSafe(before), after: toSafe(after) });
        await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.identity.userChanged, { userId: id, change: deactivates ? 'deactivated' : 'updated' }));
      }
      return { ...toSafe(after), pendingChange: pending[0] ? { id: pending[0].id, kind: pending[0].kind } : toSafe(after).pendingChange };
    });
  }

  @RequirePerm('users.manage') @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() me: Principal) {
    if (id === me.id) throw forbidden('You cannot delete your own account');
    const before = await this.users.byId(id); if (!before) throw notFound('User not found');
    await withTx(this.pool, async (c) => {
      if ((before.role_permissions ?? []).includes('*') && before.active && (await this.users.activeWildcardHolders(c, id)) === 0) throw conflict('This is the last active account holding every permission; it cannot be deleted');
      await c.query('DELETE FROM users WHERE id = $1', [id]);
      await this.audit.record(c, { action: 'DELETE', entity: 'User', entityId: id, entityLabel: before.email, before: toSafe(before) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.identity.userChanged, { userId: id, change: 'deleted' }));
    });
    return { deleted: true };
  }

  @RequirePerm('users.manage') @Post(':id/reset-password')
  async reset(@Param('id') id: string, @Body(zod(resetSchema)) body: z.infer<typeof resetSchema>) {
    if (this.env.AUTH_MODE !== 'local') throw badRequest('Passwords are managed by the identity provider');
    const u = await this.users.byId(id); if (!u) throw notFound('User not found');
    await this.assertPolicy(body.password, { email: u.email, name: u.name });
    const hash = await bcrypt.hash(body.password, this.env.BCRYPT_ROUNDS);
    await withTx(this.pool, async (c) => {
      await c.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hash, id]);
      await this.users.revokeSessions(id, c);
      await this.audit.record(c, { action: 'PASSWORD_RESET', entity: 'User', entityId: id, entityLabel: u.email });
    });
    return { reset: true };
  }

  /** The person lost their device: the factor is cleared, every session ends, and they enrol again at the next sign-in. */
  @RequirePerm('users.manage') @Post(':id/mfa/reset')
  async mfaReset(@Param('id') id: string, @CurrentUser() me: Principal) {
    if (id === me.id) throw forbidden('Manage your own two-step verification from your profile');
    const u = await this.users.byId(id); if (!u) throw notFound('User not found');
    await this.mfa.reset(u, this.actor(me));
    return { reset: true };
  }

  @RequirePerm('users.manage') @Get(':id/sessions')
  async sessions(@Param('id') id: string) { const u = await this.users.byId(id); if (!u) throw notFound('User not found'); return this.auth.sessions(id); }
  @RequirePerm('users.manage') @Delete(':id/sessions')
  async endSessions(@Param('id') id: string, @CurrentUser() me: Principal) { const u = await this.users.byId(id); if (!u) throw notFound('User not found'); return this.auth.revokeSession(id, { by: this.actor(me) }); }
}
export type { AdminPolicy };
