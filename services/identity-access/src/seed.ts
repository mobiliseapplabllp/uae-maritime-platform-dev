import bcrypt from 'bcryptjs';
import { join } from 'node:path';
import { buildWorld, DEMO_PASSWORD } from '@maritime/world';
import { createDb, generateTotpSecret, runMigrations, withTx } from '@maritime/service-kit';
import { env } from './env';
import { SecretBox } from './mfa/secrets';

/** Seeds the roles and the fictional staff directory. Idempotent: rows are upserted by name/email. */
export async function seedIdentity(databaseUrl: string, profile?: string) {
  const e = env();
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });
  const hash = await bcrypt.hash(DEMO_PASSWORD, 10);
  const counts = await withTx(pool, async (c) => {
    const roleIds = new Map<string, string>();
    for (const r of world.roles) {
      const row = await c.query<{ id: string }>(
        `INSERT INTO roles(code, name, description, permissions, system, mfa_required) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (name) DO UPDATE SET code = EXCLUDED.code, description = EXCLUDED.description, permissions = EXCLUDED.permissions, system = EXCLUDED.system, mfa_required = EXCLUDED.mfa_required RETURNING id`,
        [r.code, r.name, r.description, r.permissions, r.system, r.mfaRequired !== false]);
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
    /* The fictional staff directory as an administration's really is: accounts opened over the years rather than all on
     * seed day; most of the staff in a role that requires a second factor already enrolled, with a working secret nobody
     * knows; a handful dormant against the ninety-day rule. The demo logins are left exactly as documented: no second
     * factor, signed in recently. Only rows the seed itself created are touched, never one an administrator has since
     * changed, and a re-seed leaves an enrolled account enrolled. */
    const box = new SecretBox(e.MFA_KEY ?? e.JWT_SECRET);
    const staff = world.users.filter((u) => !u.login);
    for (let i = 0; i < staff.length; i += 1) {
      const u = staff[i];
      // an account that has been used was opened well before its last sign-in; one never used yet was opened recently,
      // so the dormant sweep finds only the accounts the seed means it to find
      const openedDays = 45 + ((i * 37) % 1100); const freshDays = 4 + ((i * 11) % 85);
      await c.query(`UPDATE users SET created_at = CASE WHEN last_login_at IS NULL THEN now() - ($3::int * interval '1 day') ELSE LEAST(last_login_at - interval '1 day', now() - ($2::int * interval '1 day')) END
                       WHERE lower(email) = lower($1)`, [u.email, openedDays, freshDays]);
      if (u.active && i % 5 !== 0) {
        await c.query(`UPDATE users u SET mfa_secret = $2, mfa_enrolled_at = GREATEST(u.created_at + interval '1 day', now() - ($3::int * interval '1 day'))
                         FROM roles r WHERE r.id = u.role_id AND r.mfa_required AND lower(u.email) = lower($1) AND u.mfa_enrolled_at IS NULL AND u.mfa_secret IS NULL AND u.mfa_pending_secret IS NULL`,
          [u.email, box.seal(generateTotpSecret()), 3 + ((i * 13) % 170)]);
      }
      if (u.active && i % 23 === 7) {
        await c.query(`UPDATE users SET last_login_at = now() - ($2::int * interval '1 day'), dormant_since = now() - (($2::int - 90) * interval '1 day') WHERE lower(email) = lower($1) AND dormant_since IS NULL`, [u.email, 100 + ((i * 7) % 120)]);
        await c.query(`UPDATE users SET created_at = LEAST(created_at, last_login_at - interval '30 days') WHERE lower(email) = lower($1) AND dormant_since IS NOT NULL AND last_login_at IS NOT NULL`, [u.email]);
      }
    }
    // whatever earlier seeds left behind, no account was used or enrolled before it existed
    await c.query(`UPDATE users SET mfa_enrolled_at = GREATEST(mfa_enrolled_at, created_at + interval '1 day') WHERE mfa_enrolled_at < created_at`);
    await c.query(`UPDATE users SET created_at = last_login_at - interval '1 day' WHERE last_login_at < created_at`);
    return { roles: roleIds.size, users: world.users.length, profile: world.profile };
  });
  await pool.end();
  return counts;
}
if (require.main === module) {
  const e = env();
  seedIdentity(e.DATABASE_URL).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
