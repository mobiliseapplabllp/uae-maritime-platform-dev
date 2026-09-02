import { join } from 'node:path';
import { buildWorld } from '@maritime/world';
import { createDb, runMigrations, withTx } from '@maritime/service-kit';
import { env } from './env';
import { compileDefinition, normaliseDefinition } from './engine';

const SEED_ACTOR = JSON.stringify({ id: 'seed', name: 'seed', kind: 'system' });

/** Seeds every rule set of the shared world as a published v1: the port-call tariff schedules, one fee set per chargeable
 * catalogue service, the eligibility and validation checks and the standard SLA clock. Idempotent: an existing rule set keeps
 * its versions, only its labels are refreshed. */
export async function seedRules(databaseUrl: string, profile?: string) {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });
  const counts = await withTx(pool, async (c) => {
    let created = 0; let versions = 0; let unchanged = 0;
    for (const rs of world.ruleSets) {
      const def = normaliseDefinition(rs.kind, rs.definition);
      const problems = compileDefinition(rs.kind, def, rs.parameters);
      if (problems.length) throw new Error(`Seed rule set ${rs.key} does not compile: ${problems.join('; ')}`);
      const s = await c.query<{ id: string; inserted: boolean }>(
        `INSERT INTO rule_sets(key, name, name_ar, kind, description, description_ar, created_by) VALUES ($1, $2, $3, $4, $5, $6, 'seed')
         ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, name_ar = EXCLUDED.name_ar, description = EXCLUDED.description, description_ar = EXCLUDED.description_ar, updated_at = now()
         RETURNING id, (xmax = 0) AS inserted`,
        [rs.key, rs.name, rs.nameAr ?? null, rs.kind, rs.description, rs.descriptionAr ?? null]);
      const id = s.rows[0].id; if (s.rows[0].inserted) created += 1;
      const existing = await c.query('SELECT 1 FROM rule_set_versions WHERE rule_set_id = $1 LIMIT 1', [id]);
      if (existing.rowCount) { unchanged += 1; continue; }
      await c.query("INSERT INTO rule_set_versions(rule_set_id, version, status, definition, parameters, change_note, created_by, published_by, published_at) VALUES ($1, 1, 'PUBLISHED', $2, $3, $4, 'seed', 'seed', now())", [id, JSON.stringify(def), JSON.stringify(rs.parameters), rs.changeNote]);
      await c.query("INSERT INTO rule_set_history(rule_set_id, version, action, actor, note) VALUES ($1, 1, 'CREATE', $2, $3), ($1, 1, 'PUBLISH', $2, 'Seeded as the published version')", [id, SEED_ACTOR, rs.changeNote]);
      versions += 1;
    }
    const byKind = await c.query<{ kind: string; n: string }>('SELECT kind, count(*) AS n FROM rule_sets GROUP BY kind ORDER BY kind');
    return { ruleSets: created, versions, unchanged, total: world.ruleSets.length, byKind: Object.fromEntries(byKind.rows.map((r) => [r.kind, Number(r.n)])), profile: world.profile };
  });
  await pool.end();
  return counts;
}
if (require.main === module) {
  const e = env();
  seedRules(e.DATABASE_URL).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
