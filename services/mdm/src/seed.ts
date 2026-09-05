import { join } from 'node:path';
import { buildWorld } from '@maritime/world';
import { PASSWORD_MIN } from '@maritime/contracts';
import { createDb, runMigrations, withTx } from '@maritime/service-kit';
import { env } from './env';

/** Seeds reference data, settings, companies and golden vessels from the shared world. Idempotent upserts. */
export async function seedMdm(databaseUrl: string, profile?: string) {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });
  const counts = await withTx(pool, async (c) => {
    for (const l of world.lookups) await c.query('INSERT INTO lookups(category, code, label, label_ar, meta, active) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (category, code) DO UPDATE SET label = EXCLUDED.label, label_ar = EXCLUDED.label_ar, meta = EXCLUDED.meta, active = EXCLUDED.active, updated_at = now()', [l.category, l.code, l.label, l.labelAr ?? null, JSON.stringify(l.meta), l.active]);
    /* A setting the operator has changed stands; a key the world has since learned is added under it; a key the world has
     * since retired leaves. `||` takes the world's values only for keys the stored object does not have, and the stored
     * object is first cut down to the keys the world still knows, so a re-seed never undoes a choice made in Settings, never
     * leaves a new setting unset, and never lets a retired one linger on the Settings screen. */
    for (const s of world.settings) await c.query(
      `INSERT INTO settings(key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value || (SELECT coalesce(jsonb_object_agg(e.key, e.value), '{}'::jsonb) FROM jsonb_each(settings.value) e WHERE EXCLUDED.value ? e.key)`,
      [s.key, JSON.stringify(s.value), 'seed']);
    /* The password floor is a platform constant. A stored minimum below it never applied (the policy clamps), so it is raised
     * rather than left to mislead the Settings screen. */
    await c.query(`UPDATE settings SET value = value || jsonb_build_object('passwordMinLength', $1::int) WHERE key = 'module:admin' AND coalesce((value->>'passwordMinLength')::int, 0) < $1::int`, [PASSWORD_MIN]);
    for (const co of world.companies) await c.query('INSERT INTO companies(id, code, name, category, types, contact_name, contact_email, contact_phone, tax_id, registration_no, address, status, onboarded_at, rating, real) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name, category = EXCLUDED.category, types = EXCLUDED.types, status = EXCLUDED.status, updated_at = now()',
      [co.id, co.code, co.name, co.category, co.types, co.contactName, co.contactEmail, co.contactPhone, co.taxId, co.registrationNo, co.address, co.status, co.onboardedAt, co.rating, co.real]);
    for (const v of world.vessels) await c.query('INSERT INTO vessels_golden(id, imo, name, mmsi, call_sign, flag, type, built, dwt, grt, loa, beam, max_draft, owner, operator, manager, agent_code, class_society, teu_capacity, liner, real, status) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22) ON CONFLICT (imo) DO UPDATE SET name = EXCLUDED.name, flag = EXCLUDED.flag, type = EXCLUDED.type, updated_at = now()',
      [v.id, v.imo, v.name, v.mmsi, v.callSign, v.flag, v.type, v.built, v.dwt, v.grt, v.loa, v.beam, v.maxDraft, v.owner, v.operator, v.manager, v.agentCode, v.classSociety, v.teuCapacity, v.liner, v.real, v.status]);
    return { lookups: world.lookups.length, settings: world.settings.length, companies: world.companies.length, vessels: world.vessels.length, profile: world.profile };
  });
  await pool.end();
  return counts;
}
if (require.main === module) {
  const e = env();
  seedMdm(e.DATABASE_URL).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
