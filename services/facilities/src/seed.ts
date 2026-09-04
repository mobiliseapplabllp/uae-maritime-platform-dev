import { join } from 'node:path';
import { STATUTORY_TYPES, buildWorld, stableId, type WorldBerth, type WorldCompany, type WorldLicence } from '@maritime/world';
import { createDb, runMigrations, withTx, type Queryable } from '@maritime/service-kit';
import { env } from './env';
import { classLabel, type Row } from './directory';
import { upsertInstrument } from './subjects';

/* Seeds the port-companies desk from the shared world.
 *
 * The company rows are the regulatory overlay on master data's golden record and carry the same stable
 * identifiers, so the two agree without either owning the other. The berths of the harbour estate are
 * seeded as regulated port facilities under their own identifiers, with the operator and the ISPS
 * standing this desk keeps on them. The instrument register is not duplicated: what is written is the
 * local read-model snapshot of the instruments held by these subjects, exactly as the consumer would
 * have projected it, so the directory and the renewal work list are usable before any event arrives.
 *
 * Idempotent: every write is an upsert on a stable id, and the audit-number series is advanced past
 * the seeded numbers so the next audit recorded can never collide with one of them. */

const D = 86_400_000;
const REGULATED = new Set(['COMPANY', 'PORT_FACILITY', 'MET_INSTITUTION']);
const STATUTORY = new Set<string>(STATUTORY_TYPES);
const CAPABILITY: Record<string, string[]> = {
  CONTAINER: ['CONTAINER', 'REEFER_PLUGS', 'SHIP_TO_SHORE_CRANES'], BULK: ['DRY_BULK', 'GRAB_DISCHARGE', 'CONVEYOR'],
  LIQUID: ['LIQUID_BULK', 'PIPELINE', 'VAPOUR_RECOVERY'], RORO: ['RORO', 'VEHICLES', 'LINKSPAN'],
  MULTIPURPOSE: ['BREAK_BULK', 'PROJECT_CARGO', 'MOBILE_HARBOUR_CRANE'], SPM: ['CRUDE_OIL', 'SINGLE_POINT_MOORING'],
};
const CAPACITY: Record<string, [number, string]> = {
  CONTAINER: [250_000, 'TEU/yr'], BULK: [4_000_000, 'MT/yr'], LIQUID: [3_000_000, 'MT/yr'],
  RORO: [60_000, 'units/yr'], MULTIPURPOSE: [1_200_000, 'MT/yr'], SPM: [12_000_000, 'MT/yr'],
};

async function advance(c: Queryable, series: string, value: number) {
  await c.query('INSERT INTO numbering_series(series, last_value) VALUES ($1,$2) ON CONFLICT (series) DO UPDATE SET last_value = GREATEST(numbering_series.last_value, EXCLUDED.last_value)', [series, value]);
}
/** The terminal operator a berth answers to, by the terminal it sits in. */
export const operatorFor = (companies: WorldCompany[], b: WorldBerth) =>
  companies.find((c) => c.category === 'TERMINAL_OPERATOR' && (/Container/.test(b.terminal) ? c.code === 'CTO' : /Liquid|SPM/.test(b.terminal) ? c.code === 'LTO' : c.code === 'BTO')) ?? null;
/** Where a facility stands under the ISPS Code, read off the Statement of Compliance held against it. */
export function ispsOf(soc: WorldLicence | undefined, now: Date) {
  if (!soc) return { status: 'NOT_APPLICABLE', socNo: '', expiry: null as string | null };
  if (soc.status === 'ISSUED') {
    const live = !soc.expiryDate || new Date(soc.expiryDate).getTime() > now.getTime();
    return { status: live ? 'COMPLIANT' : 'EXPIRED', socNo: soc.licenseNo, expiry: soc.expiryDate };
  }
  if (soc.status === 'SUSPENDED' || soc.status === 'REVOKED') return { status: 'SUSPENDED', socNo: soc.licenseNo, expiry: soc.expiryDate };
  return { status: 'PROVISIONAL', socNo: soc.licenseNo, expiry: soc.expiryDate };
}

export async function seedFacilities(databaseUrl: string, profile = 'AE', prefix = { audit: 'AUD', facility: 'PF' }) {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });
  const now = new Date(world.now);
  const held = world.licences.filter((l) => REGULATED.has(l.subjectKind));
  const socByBerth = new Map(world.licences.filter((l) => l.subjectKind === 'PORT_FACILITY' && l.subjectId).map((l) => [l.subjectId as string, l]));
  const security = world.users.filter((u) => u.roleName === 'Security Officer' && u.active);

  const counts = await withTx(pool, async (c) => {
    /* The overlay carries master data's identity fields so the directory renders from one database; the
     * rating is the standing the administration recorded, and moves from here on when an audit is taken. */
    for (const co of world.companies) {
      await c.query(
        `INSERT INTO companies(id, code, name, name_ar, category, types, contact_name, contact_email, contact_phone, tax_id, registration_no, address, city, status, status_reason, status_changed_at, rating, onboarded_at, real, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
         ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, name_ar = EXCLUDED.name_ar, category = EXCLUDED.category, types = EXCLUDED.types,
           contact_name = EXCLUDED.contact_name, contact_email = EXCLUDED.contact_email, contact_phone = EXCLUDED.contact_phone, tax_id = EXCLUDED.tax_id,
           registration_no = EXCLUDED.registration_no, address = EXCLUDED.address, city = EXCLUDED.city, status = EXCLUDED.status, status_reason = EXCLUDED.status_reason,
           status_changed_at = EXCLUDED.status_changed_at, rating = EXCLUDED.rating, onboarded_at = EXCLUDED.onboarded_at, real = EXCLUDED.real, updated_at = now()`,
        [co.id, co.code, co.name, co.nameAr ?? null, co.category, JSON.stringify(co.types), co.contactName, co.contactEmail, co.contactPhone, co.taxId, co.registrationNo,
          co.address, co.address.split(',').pop()?.trim() ?? '', co.status,
          co.status === 'SUSPENDED' ? 'Suspended pending the close-out of an audit non-conformity' : co.status === 'BLACKLISTED' ? 'Blacklisted following repeated non-conformities' : co.status === 'INACTIVE' ? 'Retired from the directory' : '',
          co.status === 'ACTIVE' ? null : new Date(now.getTime() - 45 * D), co.rating, co.onboardedAt, co.real, co.onboardedAt]);
      await c.query(
        `INSERT INTO company_status_history(id, company_id, from_status, to_status, reason, at, by) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (id) DO UPDATE SET to_status = EXCLUDED.to_status, reason = EXCLUDED.reason, at = EXCLUDED.at`,
        [stableId('status', `${co.code}:onboarded`), co.id, '', 'ACTIVE', 'Recorded on the directory', co.onboardedAt, 'Registry']);
      if (co.status !== 'ACTIVE') {
        await c.query(
          `INSERT INTO company_status_history(id, company_id, from_status, to_status, reason, at, by) VALUES ($1,$2,$3,$4,$5,$6,$7)
           ON CONFLICT (id) DO UPDATE SET to_status = EXCLUDED.to_status, reason = EXCLUDED.reason, at = EXCLUDED.at`,
          [stableId('status', `${co.code}:${co.status}`), co.id, 'ACTIVE', co.status,
            co.status === 'SUSPENDED' ? 'Suspended pending the close-out of an audit non-conformity' : co.status === 'BLACKLISTED' ? 'Blacklisted following repeated non-conformities' : 'Retired from the directory',
            new Date(now.getTime() - 45 * D), 'Registry']);
      }
    }

    for (const [i, b] of world.berths.entries()) {
      const op = operatorFor(world.companies, b);
      const isps = ispsOf(socByBerth.get(b.id), now);
      const psso = security[i % Math.max(1, security.length)];
      const [capacity, unit] = CAPACITY[b.berthType] ?? [0, ''];
      await c.query(
        `INSERT INTO port_facilities(id, code, name, name_ar, facility_type, terminal, berth_type, operator_id, operator_name, isps_status, isps_level, soc_no, soc_expiry,
           psso_name, psso_phone, capabilities, loa_max, draft_max, capacity_value, capacity_unit, status, remarks)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
         ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, name_ar = EXCLUDED.name_ar, facility_type = EXCLUDED.facility_type, terminal = EXCLUDED.terminal,
           berth_type = EXCLUDED.berth_type, operator_id = EXCLUDED.operator_id, operator_name = EXCLUDED.operator_name, isps_status = EXCLUDED.isps_status,
           isps_level = EXCLUDED.isps_level, soc_no = EXCLUDED.soc_no, soc_expiry = EXCLUDED.soc_expiry, psso_name = EXCLUDED.psso_name, psso_phone = EXCLUDED.psso_phone,
           capabilities = EXCLUDED.capabilities, loa_max = EXCLUDED.loa_max, draft_max = EXCLUDED.draft_max, capacity_value = EXCLUDED.capacity_value,
           capacity_unit = EXCLUDED.capacity_unit, status = EXCLUDED.status, updated_at = now()`,
        [b.id, b.code, b.name, b.nameAr, b.berthType === 'SPM' ? 'SPM' : 'BERTH', b.terminal, b.berthType, op?.id ?? null, op?.name ?? '',
          isps.status, 1, isps.socNo, isps.expiry, psso?.name ?? '', psso?.phone ?? '', JSON.stringify(CAPABILITY[b.berthType] ?? []),
          b.loaMax, b.draftMax, capacity, unit, b.status === 'MAINTENANCE' ? 'MAINTENANCE' : 'OPERATIONAL',
          isps.status === 'COMPLIANT' ? 'Facility security plan approved; annual verification current.' : '']);
    }

    // the local snapshot of the instrument register — the register itself stays in the instruments service
    for (const l of held) {
      await upsertInstrument(c, {
        id: l.id, number: l.licenseNo, subjectKind: l.subjectKind, subjectId: l.subjectId, entityName: l.entityName, entityType: l.entityType,
        typeLabel: l.typeLabel, instrumentClass: l.instrumentClass, classLabel: classLabel(l.instrumentClass),
        status: l.status, appliedDate: l.appliedDate, issueDate: l.issueDate, expiryDate: l.expiryDate,
        statutory: STATUTORY.has(l.entityType), inForce: l.status === 'ISSUED' && (!l.expiryDate || new Date(l.expiryDate).getTime() > now.getTime()),
        signed: l.status === 'ISSUED', performanceRating: l.performanceRating || null, auditsCount: l.audits.length, conditions: l.conditions,
      } as Row);
    }

    /* Compliance audits: the audits recorded against the instruments these subjects hold are the desk's
     * own record of how each subject has performed, so they are kept here against the subject rather
     * than only inside the instrument. Numbered per calendar year, chronologically, as they were taken. */
    const flat = held.flatMap((l) => l.audits.map((a, ix) => ({ licence: l, audit: a, ix })))
      .filter((x) => x.licence.subjectId)
      .sort((a, b) => a.audit.date.localeCompare(b.audit.date));
    const series = new Map<string, number>();
    let audits = 0; let obligations = 0;
    for (const { licence, audit, ix } of flat) {
      const year = new Date(audit.date).getUTCFullYear();
      const key = `${prefix.audit}-${year}`;
      const n = (series.get(key) ?? 0) + 1; series.set(key, n);
      const number = `${key}-${String(n).padStart(4, '0')}`;
      const kind = licence.subjectKind === 'PORT_FACILITY' ? 'FACILITY' : 'COMPANY';
      // The number is positional within its year, so a world that gains a subject renumbers the series from
      // that point on. Upserting by id then walks a number onto a row that another id still holds, and the
      // unique index refuses it — which is how a reseed against a changed world used to fail. Free the
      // number first; the row that held it is about to be given its own.
      await c.query('DELETE FROM audits WHERE number = $1 AND id <> $2', [number, stableId('facaudit', `${licence.licenseNo}:${ix}`)]);
      await c.query(
        `INSERT INTO audits(id, number, subject_kind, subject_id, subject_name, audited_on, auditor_id, auditor, result, scope, remarks, instrument_id, instrument_no, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
         ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, subject_kind = EXCLUDED.subject_kind, subject_id = EXCLUDED.subject_id, subject_name = EXCLUDED.subject_name,
           audited_on = EXCLUDED.audited_on, auditor_id = EXCLUDED.auditor_id, auditor = EXCLUDED.auditor, result = EXCLUDED.result, scope = EXCLUDED.scope,
           remarks = EXCLUDED.remarks, instrument_id = EXCLUDED.instrument_id, instrument_no = EXCLUDED.instrument_no`,
        [stableId('facaudit', `${licence.licenseNo}:${ix}`), number, kind, licence.subjectId, licence.entityName, audit.date, audit.auditorId, audit.auditor,
          audit.result, `${licence.typeLabel} — periodic compliance audit`, audit.remarks, licence.id, licence.licenseNo, audit.date]);
      audits += 1;

      if (audit.result === 'NON_CONFORMITY') {
        await c.query(
          `INSERT INTO obligations(id, subject_kind, subject_id, subject_name, kind, title, detail, source_ref, due_at, status, raised_at, raised_by)
           VALUES ($1,$2,$3,$4,'AUDIT_FINDING',$5,$6,$7,$8,'OPEN',$9,'Registry')
           ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, detail = EXCLUDED.detail, due_at = EXCLUDED.due_at`,
          [stableId('obligation', `${licence.licenseNo}:${ix}`), kind, licence.subjectId, licence.entityName,
            `Non-conformity raised on audit ${number}`, audit.remarks, number, new Date(new Date(audit.date).getTime() + 30 * D), audit.date]);
        obligations += 1;
      }
    }
    // a suspended instrument is something its holder has to answer for, exactly as the consumer records it
    for (const l of held.filter((x) => x.status === 'SUSPENDED' && x.subjectId)) {
      await c.query(
        `INSERT INTO obligations(id, subject_kind, subject_id, subject_name, kind, title, detail, source_ref, due_at, status, raised_at, raised_by)
         VALUES ($1,$2,$3,$4,'CONDITION',$5,$6,$7,$8,'OPEN',$9,'Registry')
         ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, detail = EXCLUDED.detail`,
        [stableId('obligation', `${l.licenseNo}:suspension`), l.subjectKind === 'PORT_FACILITY' ? 'FACILITY' : 'COMPANY', l.subjectId, l.entityName,
          `${l.typeLabel} ${l.licenseNo} suspended`, 'The suspension is to be answered before the instrument can be reinstated.',
          l.licenseNo, new Date(now.getTime() + 30 * D), new Date(now.getTime() - 20 * D)]);
      obligations += 1;
    }
    for (const [key, n] of series) await advance(c, key, n);
    await advance(c, `${prefix.facility}-code`, world.berths.length);

    const isps = await c.query<{ n: string }>(`SELECT count(*) AS n FROM port_facilities WHERE isps_status = 'COMPLIANT'`);
    const rated = await c.query<{ n: string }>('SELECT count(*) AS n FROM companies WHERE rating > 0');
    return {
      profile: world.profile, companies: world.companies.length, facilities: world.berths.length, instruments: held.length,
      audits, obligations, series: series.size, ispsCompliant: Number(isps.rows[0].n), rated: Number(rated.rows[0].n),
      operators: new Set(world.berths.map((b) => operatorFor(world.companies, b)?.code).filter(Boolean)).size,
    };
  });
  await pool.end();
  return counts;
}

if (require.main === module) {
  const e = env();
  seedFacilities(e.DATABASE_URL, e.JURISDICTION, { audit: e.AUDIT_PREFIX, facility: e.FACILITY_PREFIX }).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
