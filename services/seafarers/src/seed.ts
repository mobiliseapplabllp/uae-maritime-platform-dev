import { join } from 'node:path';
import { buildWorld, stableId } from '@maritime/world';
import { createDb, runMigrations, withTx } from '@maritime/service-kit';
import { env } from './env';
import { upsertVessel } from './subjects';

/* Seeds the crew register from the shared world: the seafarers with their identity documents, the
 * competency and proficiency certificates each holds, and the service book walked back through their
 * tours. The fleet snapshot is seeded here too so a sign-on can name a ship before any event arrives.
 * Idempotent — every write is an upsert on the world's stable id. */

export async function seedSeafarers(databaseUrl: string, profile = 'AE') {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });
  const counts = await withTx(pool, async (c) => {
    for (const v of world.vessels) await upsertVessel(c, { id: v.id, imo: v.imo, name: v.name, type: v.type, flag: v.flag, status: v.status, real: v.real });

    let certificates = 0; let service = 0;
    for (const s of world.seafarers) {
      await c.query(`INSERT INTO seafarers(id, cdc_no, seafarer_id, seafarer_id_label, national_id, national_id_label, name, dob, nationality, rank, phone, email, status, current_vessel_id, current_vessel_name, signed_on_at, remarks, manning_agent_code, manning_agent_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
        ON CONFLICT (id) DO UPDATE SET cdc_no = EXCLUDED.cdc_no, seafarer_id = EXCLUDED.seafarer_id, seafarer_id_label = EXCLUDED.seafarer_id_label, national_id = EXCLUDED.national_id, national_id_label = EXCLUDED.national_id_label,
          name = EXCLUDED.name, dob = EXCLUDED.dob, nationality = EXCLUDED.nationality, rank = EXCLUDED.rank, phone = EXCLUDED.phone, email = EXCLUDED.email, status = EXCLUDED.status,
          current_vessel_id = EXCLUDED.current_vessel_id, current_vessel_name = EXCLUDED.current_vessel_name, signed_on_at = EXCLUDED.signed_on_at, remarks = EXCLUDED.remarks,
          manning_agent_code = EXCLUDED.manning_agent_code, manning_agent_name = EXCLUDED.manning_agent_name, updated_at = now()`,
        [s.id, s.cdcNo, s.seafarerId, s.seafarerIdLabel, s.nationalId, s.nationalIdLabel, s.name, s.dob.slice(0, 10), s.nationality, s.rank, s.phone, s.email, s.status, s.currentVesselId, s.currentVesselName, s.signedOnAt, s.remarks, s.manningAgentCode, s.manningAgentName]);

      for (const cert of s.certificates) {
        await c.query(`INSERT INTO seafarer_certificates(id, seafarer_id, cert_type, grade, number, issuer, issue_date, expiry_date, remarks)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          ON CONFLICT (id) DO UPDATE SET seafarer_id = EXCLUDED.seafarer_id, cert_type = EXCLUDED.cert_type, grade = EXCLUDED.grade, number = EXCLUDED.number, issuer = EXCLUDED.issuer,
            issue_date = EXCLUDED.issue_date, expiry_date = EXCLUDED.expiry_date, remarks = EXCLUDED.remarks, updated_at = now()`,
          [stableId('scert', `${s.id}:${cert.certType}`), s.id, cert.certType, cert.grade, cert.number, cert.issuer, cert.issueDate, cert.expiryDate, cert.remarks]);
        certificates += 1;
      }
      /* A tour carries no id of its own in the world, and its dates move with the clock the world was built
       * on, so the row is keyed on its position in the seafarer's service book — which is deterministic. */
      for (const [i, sv] of s.seaService.entries()) {
        await c.query(`INSERT INTO sea_service(id, seafarer_id, vessel_id, vessel_name, imo, rank, from_at, to_at, verified, verified_by, verified_at, remarks)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
          ON CONFLICT (id) DO UPDATE SET seafarer_id = EXCLUDED.seafarer_id, vessel_id = EXCLUDED.vessel_id, vessel_name = EXCLUDED.vessel_name, imo = EXCLUDED.imo, rank = EXCLUDED.rank,
            from_at = EXCLUDED.from_at, to_at = EXCLUDED.to_at, verified = EXCLUDED.verified, verified_by = EXCLUDED.verified_by, verified_at = EXCLUDED.verified_at, remarks = EXCLUDED.remarks, updated_at = now()`,
          [stableId('seaservice', `${s.id}:${i}`), s.id, sv.vesselId, sv.vesselName, sv.imo, sv.rank, sv.from, sv.to,
            sv.verified, sv.verified ? 'Crew desk' : '', sv.verified ? sv.to : null, sv.remarks]);
        service += 1;
      }
    }
    return {
      profile: world.profile, seafarers: world.seafarers.length, certificates, seaService: service,
      onboard: world.seafarers.filter((s) => s.currentVesselId).length, vessels: world.vessels.length,
    };
  });
  await pool.end();
  return counts;
}

if (require.main === module) {
  const e = env();
  seedSeafarers(e.DATABASE_URL, e.JURISDICTION).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
