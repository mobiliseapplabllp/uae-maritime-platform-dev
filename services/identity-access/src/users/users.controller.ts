import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, PASSWORD_MAX, passwordProblems, type PageQuery } from '@maritime/contracts';
import { KIT_ENV, KIT_POOL, AuditClient, CurrentUser, RequirePerm, zod, paged, parsePage, escapeLike, notFound, badRequest, forbidden, withTx, enqueue, eventFromContext, type Principal } from '@maritime/service-kit';
import { UsersRepo, toSafe, type UserRow } from './users.repo';
import type { Env } from '../env';

const userSchema = z.object({
  name: z.string().min(1).max(120), email: z.string().email().max(200), password: z.string().max(PASSWORD_MAX).optional(), roleId: z.string().uuid(),
  designation: z.string().max(120).optional().default(''), department: z.string().max(120).optional().default(''), phone: z.string().max(40).optional().default(''), active: z.boolean().optional().default(true),
  scope: z.object({ level: z.enum(['NATIONAL', 'PORT', 'ZONE', 'FACILITY', 'COMPANY']), ports: z.array(z.string()).optional(), companies: z.array(z.string()).optional() }).optional(),
});
const resetSchema = z.object({ password: z.string().max(PASSWORD_MAX) });

/** The policy is enforced at every point a password is set, not only where a person types one. */
const assertPolicy = (password: string, subject: { email?: string | null; name?: string | null }) => {
  const problems = passwordProblems(password, subject);
  if (problems.length) throw badRequest(problems.join('; '));
};
const SORT: Record<string, string> = { name: 'u.name', email: 'u.email', createdAt: 'u.created_at', lastLoginAt: 'u.last_login_at', designation: 'u.designation', department: 'u.department', active: 'u.active' };

@Controller('users')
export class UsersController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly users: UsersRepo, private readonly audit: AuditClient) {}

  @RequirePerm('users.view') @Get()
  async list(@Query() query: PageQuery & { role?: string; active?: string; department?: string }) {
    const p = parsePage(query, { defaultSort: 'name', sortable: Object.keys(SORT) });
    const where: string[] = []; const args: unknown[] = [];
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(u.name ILIKE $${args.length} OR u.email ILIKE $${args.length} OR u.designation ILIKE $${args.length} OR u.department ILIKE $${args.length})`); }
    if (query.role) { args.push(query.role); where.push(`(r.id::text = $${args.length} OR r.name = $${args.length})`); }
    if (query.department) { args.push(query.department); where.push(`u.department = $${args.length}`); }
    if (query.active === 'true' || query.active === 'false') { args.push(query.active === 'true'); where.push(`u.active = $${args.length}`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM users u JOIN roles r ON r.id = u.role_id ${w}`, args);
    const rows = await this.pool.query<UserRow>(`SELECT u.*, r.name AS role_name, r.permissions AS role_permissions FROM users u JOIN roles r ON r.id = u.role_id ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, u.id LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(toSafe), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  @RequirePerm('users.view') @Get(':id')
  async get(@Param('id') id: string) { const u = await this.users.byId(id); if (!u) throw notFound('User not found'); return toSafe(u); }

  @RequirePerm('users.manage') @Post()
  async create(@Body(zod(userSchema)) body: z.infer<typeof userSchema>) {
    if (this.env.AUTH_MODE === 'local' && !body.password) throw badRequest('Password is required');
    if (body.password) assertPolicy(body.password, { email: body.email, name: body.name });
    const hash = body.password ? await bcrypt.hash(body.password, this.env.BCRYPT_ROUNDS) : null;
    return withTx(this.pool, async (c) => {
      const r = await c.query<{ id: string }>('INSERT INTO users(name, email, password_hash, role_id, designation, department, phone, active, scope) VALUES ($1, lower($2), $3, $4, $5, $6, $7, $8, $9) RETURNING id',
        [body.name, body.email, hash, body.roleId, body.designation, body.department, body.phone, body.active, JSON.stringify(body.scope ?? { level: 'NATIONAL' })]);
      const created = (await this.users.byId(r.rows[0].id, c))!;
      await this.audit.record(c, { action: 'CREATE', entity: 'User', entityId: created.id, entityLabel: created.email, after: toSafe(created) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.identity.userChanged, { userId: created.id, change: 'created' }));
      return toSafe(created);
    });
  }

  @RequirePerm('users.manage') @Put(':id')
  async update(@Param('id') id: string, @Body(zod(userSchema.partial())) body: Partial<z.infer<typeof userSchema>>, @CurrentUser() me: Principal) {
    const before = await this.users.byId(id); if (!before) throw notFound('User not found');
    if (id === me.id && body.active === false) throw forbidden('You cannot deactivate your own account');
    const sets: string[] = []; const args: unknown[] = [];
    const set = (col: string, val: unknown) => { args.push(val); sets.push(`${col} = $${args.length}`); };
    if (body.name !== undefined) set('name', body.name);
    if (body.email !== undefined) set('email', body.email.toLowerCase());
    if (body.roleId !== undefined) set('role_id', body.roleId);
    if (body.designation !== undefined) set('designation', body.designation);
    if (body.department !== undefined) set('department', body.department);
    if (body.phone !== undefined) set('phone', body.phone);
    if (body.active !== undefined) set('active', body.active);
    if (body.scope !== undefined) set('scope', JSON.stringify(body.scope));
    if (body.password) {
      assertPolicy(body.password, { email: body.email ?? before.email, name: body.name ?? before.name });
      set('password_hash', await bcrypt.hash(body.password, this.env.BCRYPT_ROUNDS));
    }
    if (!sets.length) return toSafe(before);
    return withTx(this.pool, async (c) => {
      args.push(id);
      await c.query(`UPDATE users SET ${sets.join(', ')}, updated_at = now() WHERE id = $${args.length}`, args);
      const after = (await this.users.byId(id, c))!;
      await this.audit.record(c, { action: 'UPDATE', entity: 'User', entityId: id, entityLabel: after.email, before: toSafe(before), after: toSafe(after) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.identity.userChanged, { userId: id, change: 'updated' }));
      return toSafe(after);
    });
  }

  @RequirePerm('users.manage') @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() me: Principal) {
    if (id === me.id) throw forbidden('You cannot delete your own account');
    const before = await this.users.byId(id); if (!before) throw notFound('User not found');
    await withTx(this.pool, async (c) => {
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
    assertPolicy(body.password, { email: u.email, name: u.name });
    const hash = await bcrypt.hash(body.password, this.env.BCRYPT_ROUNDS);
    await withTx(this.pool, async (c) => {
      await c.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hash, id]);
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [id]);
      await this.audit.record(c, { action: 'PASSWORD_RESET', entity: 'User', entityId: id, entityLabel: u.email });
    });
    return { reset: true };
  }
}
