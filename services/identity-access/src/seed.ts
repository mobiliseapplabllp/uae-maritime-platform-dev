import bcrypt from 'bcryptjs';
import { join } from 'node:path';
import { buildWorld, DEMO_PASSWORD } from '@maritime/world';
import { createDb, runMigrations, withTx } from '@maritime/service-kit';
import { env } from './env';

/** Seeds the fifteen roles and the fictional staff directory. Idempotent: rows are upserted by name/email. */
export async function seedIdentity(databaseUrl: string, profile?: string) {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const counts = await withTx(pool, async (c) => {
    const roleIds = new Map<string, string>();
    for (const r of world.roles) {
      const row = await c.query<{ id: string }>(
        'INSERT INTO roles(code, name, description, permissions, system) VALUES ($1, $2, $3, $4, $5) ON CONFLICT (name) DO UPDATE SET code = EXCLUDED.code, description = EXCLUDED.description, permissions = EXCLUDED.permissions, system = EXCLUDED.system, updated_at = now() RETURNING id',
        [r.code, r.name, r.description, r.permissions, r.system]);
      roleIds.set(r.name, row.rows[0].id);
    }
    for (const u of world.users) {
      await c.query(
        `INSERT INTO users(id, name, email, password_hash, role_id, designation, department, phone, active, scope, last_login_at)
         VALUES ($1, $2, lower($3), $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (email) DO UPDATE SET name = EXCLUDED.name, role_id = EXCLUDED.role_id, designation = EXCLUDED.designation, department = EXCLUDED.department, phone = EXCLUDED.phone, active = EXCLUDED.active, scope = EXCLUDED.scope, updated_at = now()`,
        [u.id, u.name, u.email, hash, roleIds.get(u.roleName), u.designation, u.department, u.phone, u.active,
         JSON.stringify(u.scope ?? { level: 'NATIONAL' }), u.lastLoginAt]);
    }
    return { roles: roleIds.size, users: world.users.length, profile: world.profile };
  });
  await pool.end();
  return counts;
}
if (require.main === module) {
  const e = env();
  seedIdentity(e.DATABASE_URL).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
