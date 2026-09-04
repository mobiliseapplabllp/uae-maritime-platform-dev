import { join } from 'node:path';
import { buildWorld } from '@maritime/world';
import { createDb, runMigrations, withTx } from '@maritime/service-kit';
import { env } from './env';
import { materialFromEnv, registerKey, signFacts, type SigningMaterial } from './signing';
import { upsertSubject, type SubjectCert } from './subjects';
import { issuerFor } from './licences';

/** Seeds the subject projection and the instrument register from the shared world. Issued instruments are signed with the configured key, numbering series continue past the seeded numbers. Idempotent. */
export async function seedInstruments(databaseUrl: string, profile = 'AE', signing?: SigningMaterial) {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile }); const m = signing ?? materialFromEnv(process.env as Record<string, string>); const issuer = issuerFor(profile);
  const counts = await withTx(pool, async (c) => {
    await registerKey(c, m);
    const certs = new Map<string, SubjectCert[]>();
    for (const vc of world.vesselCertificates) { const l = certs.get(vc.vesselId) ?? []; l.push({ type: vc.certType, expiryDate: vc.expiryDate }); certs.set(vc.vesselId, l); }
    for (const v of world.vessels) await upsertSubject(c, { model: 'Vessel', id: v.id, label: v.name, status: v.status, facts: { name: v.name, imo: v.imo, real: v.real, certificates: certs.get(v.id) ?? [], nextDryDock: null } });
    for (const s of world.seafarers) await upsertSubject(c, { model: 'Seafarer', id: s.id, label: s.name, status: s.status, facts: { name: s.name, cdcNo: s.cdcNo, certificates: s.certificates.map((x) => ({ type: x.certType, expiryDate: x.expiryDate })) } });
    for (const co of world.companies) await upsertSubject(c, { model: 'Company', id: co.id, label: co.name, status: co.status, facts: { name: co.name, code: co.code, real: co.real } });
    for (const b of world.berths) await upsertSubject(c, { model: 'Berth', id: b.id, label: b.name, status: b.status, facts: { name: b.name, code: b.code, terminal: b.terminal } });
    const series = new Map<string, number>();
    for (const l of world.licences) {
      const signature = l.status === 'ISSUED' ? signFacts(m, { licenseNo: l.licenseNo, entityType: l.entityType, subjectKind: l.subjectKind, subjectId: l.subjectId, entityName: l.entityName, issueDate: l.issueDate, expiryDate: l.expiryDate }) : null;
      await c.query(`INSERT INTO licences(id, license_no, holder_code, subject_kind, subject_id, subject_model, instrument_class, entity_name, entity_type, status, issue_checks, contact_person, phone, email, address, tax_id, applied_date, issue_date, expiry_date, conditions, performance_rating, audits, endorsements, signature, history, issuer)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
        ON CONFLICT (license_no) DO UPDATE SET holder_code = EXCLUDED.holder_code, subject_kind = EXCLUDED.subject_kind, subject_id = EXCLUDED.subject_id, subject_model = EXCLUDED.subject_model, instrument_class = EXCLUDED.instrument_class, entity_name = EXCLUDED.entity_name, entity_type = EXCLUDED.entity_type, status = EXCLUDED.status, issue_checks = EXCLUDED.issue_checks,
          contact_person = EXCLUDED.contact_person, phone = EXCLUDED.phone, email = EXCLUDED.email, address = EXCLUDED.address, tax_id = EXCLUDED.tax_id, applied_date = EXCLUDED.applied_date, issue_date = EXCLUDED.issue_date, expiry_date = EXCLUDED.expiry_date, conditions = EXCLUDED.conditions,
          performance_rating = EXCLUDED.performance_rating, audits = EXCLUDED.audits, endorsements = EXCLUDED.endorsements, signature = EXCLUDED.signature, history = EXCLUDED.history, issuer = EXCLUDED.issuer, updated_at = now()`,
        [l.id, l.licenseNo, l.holderCode ?? '', l.subjectKind, l.subjectId, l.subjectModel, l.instrumentClass, l.entityName, l.entityType, l.status, JSON.stringify(l.issueChecks), l.contactPerson, l.phone, l.email, l.address, l.taxId, l.appliedDate, l.issueDate, l.expiryDate, l.conditions, l.performanceRating, JSON.stringify(l.audits), JSON.stringify(l.endorsements), signature ? JSON.stringify(signature) : null, JSON.stringify(l.history), issuer]);
      const at = l.licenseNo.lastIndexOf('-'); const key = l.licenseNo.slice(0, at); const n = Number(l.licenseNo.slice(at + 1)); if (Number.isFinite(n)) series.set(key, Math.max(series.get(key) ?? 0, n));
    }
    for (const [key, n] of series) await c.query('INSERT INTO numbering_series(series, last_value) VALUES ($1, $2) ON CONFLICT (series) DO UPDATE SET last_value = GREATEST(numbering_series.last_value, EXCLUDED.last_value)', [key, n]);
    return { subjects: world.vessels.length + world.seafarers.length + world.companies.length + world.berths.length, licences: world.licences.length, signed: world.licences.filter((l) => l.status === 'ISSUED').length, series: series.size, keyId: m.keyId, profile: world.profile };
  });
  await pool.end();
  return counts;
}
if (require.main === module) {
  const e = env();
  seedInstruments(e.DATABASE_URL, e.JURISDICTION, materialFromEnv(e)).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
