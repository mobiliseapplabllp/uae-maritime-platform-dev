import { join } from 'node:path';
import { buildWorld } from '@maritime/world';
import { createDb, runMigrations, withTx } from '@maritime/service-kit';
import { env } from './env';

/** Seeds reference data, settings, companies and golden vessels from the shared world. Idempotent upserts. */
export async function seedMdm(databaseUrl: string, profile?: string) {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });
  const counts = await withTx(pool, async (c) => {
    for (const l of world.lookups) await c.query('INSERT INTO lookups(category, code, label, label_ar, meta, active) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (category, code) DO UPDATE SET label = EXCLUDED.label, label_ar = EXCLUDED.label_ar, meta = EXCLUDED.meta, active = EXCLUDED.active, updated_at = now()', [l.category, l.code, l.label, l.labelAr ?? null, JSON.stringify(l.meta), l.active]);
    /* A setting the operator has changed stands; a key the world has since learned is added under it. `||` keeps the stored
     * object's values and takes the world's only for keys the stored object does not have, so a re-seed never undoes a
     * choice made in Settings and never leaves a new setting unset either. */
    for (const s of world.settings) await c.query('INSERT INTO settings(key, value, updated_by) VALUES ($1, $2, $3) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value || settings.value', [s.key, JSON.stringify(s.value), 'seed']);
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
