import { join } from 'node:path';
import { buildWorld, stableId, type WorldCrewList } from '@maritime/world';
import { getJurisdiction } from '@maritime/contracts';
import { createDb, runMigrations, seedLookupMirror, withTx, type Queryable } from '@maritime/service-kit';
import { env } from './env';
import { upsertPortCall, upsertVessel } from './subjects';
import { backfillVocabulary, certRules, loadVocab, vocabOf } from './vocab';
import { checkLines, matchLine, registerIndex, type CheckContext, type CrewListLine, type ForeignRow } from './crewlists';
import { certsOf, type CertApi } from './crew';
import type { ScaleRow } from './manning';

/* Seeds the crew register from the shared world: the seafarers with their identity documents, the
 * competency and proficiency certificates each holds, and the service book walked back through their
 * tours. The fleet snapshot is seeded here too so a sign-on can name a ship before any event arrives.
 *
 * Phase 3 adds the MET register and its programme approvals, a safe manning scale for every active ship,
 * the port calls a crew list attaches to, and the FAL-5 crew lists themselves — each one matched and
 * checked by the same functions the desk runs, so the seed and the live path cannot disagree about what a
 * list says. The foreign ledger is built from the lists, the way it is in life.
 *
 * Idempotent — every write is an upsert on the world's stable id. */

type Row = Record<string, any>;
export async function seedSeafarers(databaseUrl: string, profile = 'AE', prefix = { crewList: 'CL' }) {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });
  const j = getJurisdiction(profile);
  const counts = await withTx(pool, async (c) => {
    const lookups = await seedLookupMirror(c, world.lookups);
    const rankByLabel = new Map(world.lookups.filter((l) => l.category === 'seafarerRank').map((l) => [l.label, l.code]));
    const certByLabel = new Map(world.lookups.filter((l) => l.category === 'seafarerCertType').map((l) => [l.label, l.code]));
    for (const v of world.vessels) await upsertVessel(c, { id: v.id, imo: v.imo, name: v.name, type: v.type, flag: v.flag, status: v.status, real: v.real });

    let certificates = 0; let service = 0;
    for (const s of world.seafarers) {
      await c.query(`INSERT INTO seafarers(id, cdc_no, seafarer_id, seafarer_id_label, national_id, national_id_label, name, dob, nationality, rank, rank_code, phone, email, status, current_vessel_id, current_vessel_name, signed_on_at, remarks, manning_agent_code, manning_agent_name)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)
        ON CONFLICT (id) DO UPDATE SET cdc_no = EXCLUDED.cdc_no, seafarer_id = EXCLUDED.seafarer_id, seafarer_id_label = EXCLUDED.seafarer_id_label, national_id = EXCLUDED.national_id, national_id_label = EXCLUDED.national_id_label,
          name = EXCLUDED.name, dob = EXCLUDED.dob, nationality = EXCLUDED.nationality, rank = EXCLUDED.rank, rank_code = EXCLUDED.rank_code, phone = EXCLUDED.phone, email = EXCLUDED.email, status = EXCLUDED.status,
          current_vessel_id = EXCLUDED.current_vessel_id, current_vessel_name = EXCLUDED.current_vessel_name, signed_on_at = EXCLUDED.signed_on_at, remarks = EXCLUDED.remarks,
          manning_agent_code = EXCLUDED.manning_agent_code, manning_agent_name = EXCLUDED.manning_agent_name, updated_at = now()`,
        [s.id, s.cdcNo, s.seafarerId, s.seafarerIdLabel, s.nationalId, s.nationalIdLabel, s.name, s.dob.slice(0, 10), s.nationality, s.rank, rankByLabel.get(s.rank) ?? '', s.phone, s.email, s.status, s.currentVesselId, s.currentVesselName, s.signedOnAt, s.remarks, s.manningAgentCode, s.manningAgentName]);

      for (const cert of s.certificates) {
        await c.query(`INSERT INTO seafarer_certificates(id, seafarer_id, cert_type, cert_code, grade, number, issuer, issue_date, expiry_date, remarks)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
          ON CONFLICT (id) DO UPDATE SET seafarer_id = EXCLUDED.seafarer_id, cert_type = EXCLUDED.cert_type, cert_code = EXCLUDED.cert_code, grade = EXCLUDED.grade, number = EXCLUDED.number, issuer = EXCLUDED.issuer,
            issue_date = EXCLUDED.issue_date, expiry_date = EXCLUDED.expiry_date, remarks = EXCLUDED.remarks, updated_at = now()`,
          [stableId('scert', `${s.id}:${cert.certType}`), s.id, cert.certType, certByLabel.get(cert.certType) ?? '', cert.grade, cert.number, cert.issuer, cert.issueDate, cert.expiryDate, cert.remarks]);
        certificates += 1;
      }
      /* A tour carries no id of its own in the world, and its dates move with the clock the world was built
       * on, so the row is keyed on its position in the seafarer's service book — which is deterministic. */
      for (const [i, sv] of s.seaService.entries()) {
        await c.query(`INSERT INTO sea_service(id, seafarer_id, vessel_id, vessel_name, imo, rank, rank_code, from_at, to_at, verified, verified_by, verified_at, remarks)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (id) DO UPDATE SET seafarer_id = EXCLUDED.seafarer_id, vessel_id = EXCLUDED.vessel_id, vessel_name = EXCLUDED.vessel_name, imo = EXCLUDED.imo, rank = EXCLUDED.rank, rank_code = EXCLUDED.rank_code,
            from_at = EXCLUDED.from_at, to_at = EXCLUDED.to_at, verified = EXCLUDED.verified, verified_by = EXCLUDED.verified_by, verified_at = EXCLUDED.verified_at, remarks = EXCLUDED.remarks, updated_at = now()`,
          [stableId('seaservice', `${s.id}:${i}`), s.id, sv.vesselId, sv.vesselName, sv.imo, sv.rank, rankByLabel.get(sv.rank) ?? '', sv.from, sv.to,
            sv.verified, sv.verified ? 'Crew desk' : '', sv.verified ? sv.to : null, sv.remarks]);
        service += 1;
      }
    }
    await backfillVocabulary(c);

    /* ------------------------------------------------------------- the MET register --- */
    for (const m of world.metInstitutions) {
      await c.query(`INSERT INTO met_institutions(id, company_id, code, name, name_ar, institution_type, city, address, contact_name, contact_email, contact_phone, status, accreditation_instrument_id, accreditation_instrument_no, instructors, capacity, simulators, quality_system, established_on, remarks, scope_company, created_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$3,'Registry')
        ON CONFLICT (id) DO UPDATE SET company_id = EXCLUDED.company_id, code = EXCLUDED.code, name = EXCLUDED.name, name_ar = EXCLUDED.name_ar, institution_type = EXCLUDED.institution_type, city = EXCLUDED.city, address = EXCLUDED.address,
          contact_name = EXCLUDED.contact_name, contact_email = EXCLUDED.contact_email, contact_phone = EXCLUDED.contact_phone, status = EXCLUDED.status, accreditation_instrument_id = EXCLUDED.accreditation_instrument_id, accreditation_instrument_no = EXCLUDED.accreditation_instrument_no,
          instructors = EXCLUDED.instructors, capacity = EXCLUDED.capacity, simulators = EXCLUDED.simulators, quality_system = EXCLUDED.quality_system, established_on = EXCLUDED.established_on, remarks = EXCLUDED.remarks, scope_company = EXCLUDED.scope_company, updated_at = now()`,
        [m.id, m.companyId, m.code, m.name, m.nameAr, m.institutionType, m.city, m.address, m.contactName, m.contactEmail, m.contactPhone, m.status, m.accreditationInstrumentId, m.accreditationInstrumentNo, m.instructors, m.capacity, JSON.stringify(m.simulators), m.qualitySystem, m.establishedOn, m.remarks]);
      /* The accreditation's standing is mirrored from the facilities service's cycle in life; the world reads
       * it from the same instrument the facilities seed opened the cycle from, so the two start in agreement. */
      const accreditation = world.licences.find((l) => l.id === m.accreditationInstrumentId);
      await c.query(`UPDATE met_institutions SET accreditation_status = $2, accreditation_reason = $3, accredited_from = $4, accredited_until = $5, accreditation_cycle_no = $6, accreditation_cycle_id = $7 WHERE id = $1`,
        [m.id, m.accreditationStatus, accreditation ? `${accreditation.licenseNo} ${accreditation.status.toLowerCase()} on the instrument register` : 'No accreditation instrument held', m.accreditedFrom, m.accreditedUntil,
          m.accreditationCycleNo, accreditation ? stableId('cycle', `${accreditation.licenseNo}:${m.accreditationCycleNo}`) : null]);
    }
    for (const p of world.metProgrammes) {
      await c.query(`INSERT INTO met_programmes(id, institution_id, programme, title, regulation, seats_per_intake, intakes_per_year, status, status_reason, approval_no, instrument_id, approved_on, expires_on, remarks)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT (id) DO UPDATE SET programme = EXCLUDED.programme, title = EXCLUDED.title, regulation = EXCLUDED.regulation, seats_per_intake = EXCLUDED.seats_per_intake, intakes_per_year = EXCLUDED.intakes_per_year, status = EXCLUDED.status,
          status_reason = EXCLUDED.status_reason, approval_no = EXCLUDED.approval_no, instrument_id = EXCLUDED.instrument_id, approved_on = EXCLUDED.approved_on, expires_on = EXCLUDED.expires_on, remarks = EXCLUDED.remarks, updated_at = now()`,
        [p.id, p.institutionId, p.programme, p.title, p.regulation, p.seatsPerIntake, p.intakesPerYear, p.status, p.status === 'SUSPENDED' || p.status === 'WITHDRAWN' ? p.remarks : '', p.approvalNo, p.instrumentId, p.approvedOn, p.expiresOn, p.remarks]);
    }

    /* ----------------------------------------------------------- safe manning scales --- */
    const grades = vocabOf('cocGrade', (await loadVocab(c, 'cocGrade')).options);
    for (const s of world.manningScales) {
      const rows: ScaleRow[] = s.rows.map((r) => ({ rankCode: r.rankCode, rank: r.rank, count: r.count, cocGrade: r.cocGrade, cocGradeLabel: grades.find(r.cocGrade)?.label ?? '', notes: r.notes }));
      await c.query(`INSERT INTO manning_scales(id, vessel_id, vessel_name, imo, msmd_no, instrument_id, issued_on, trading_area, rows, remarks, recorded_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Registry')
        ON CONFLICT (vessel_id) DO UPDATE SET vessel_name = EXCLUDED.vessel_name, imo = EXCLUDED.imo, msmd_no = EXCLUDED.msmd_no, instrument_id = EXCLUDED.instrument_id, issued_on = EXCLUDED.issued_on, trading_area = EXCLUDED.trading_area, rows = EXCLUDED.rows, remarks = EXCLUDED.remarks, updated_at = now()`,
        [s.id, s.vesselId, s.vesselName, s.imo, s.msmdNo, s.instrumentId, s.issuedOn, s.tradingArea, JSON.stringify(rows), s.remarks]);
    }

    /* ------------------------------------------------- port calls and the crew lists --- */
    const byVessel = new Map(world.vessels.map((v) => [v.id, v]));
    const agentName = new Map(world.companies.map((x) => [x.code, x.name]));
    const listed = new Map(world.crewLists.map((l) => [l.portCallId, l]));
    for (const p of world.portCalls) {
      const v = byVessel.get(p.vesselId);
      await upsertPortCall(c, { id: p.id, vcn: p.vcn, vesselId: p.vesselId, vesselName: p.vesselName, vesselImo: v?.imo ?? '', agentCode: p.agentCode, agentName: agentName.get(p.agentCode) ?? '', status: p.status, port: profile === 'AE' ? 'MAR' : 'REF', berthCode: p.berthCode, eta: p.eta, ata: p.ata, atd: p.atd, crew: listed.has(p.id) ? { count: listed.get(p.id)!.declaredCrew } : null });
    }
    const crewLists = await seedCrewLists(c, world.crewLists, { profile, jurisdictionName: j.name, flag: j.code, prefix: prefix.crewList, agentName, byVessel: new Map(world.vessels.map((v) => [v.id, v.flag])) });

    const ledger = await c.query<{ n: string; watch: string }>(`SELECT count(*) AS n, count(*) FILTER (WHERE status = 'WATCH') AS watch FROM foreign_seafarers`);
    return {
      profile: world.profile, lookups, seafarers: world.seafarers.length, certificates, seaService: service,
      onboard: world.seafarers.filter((s) => s.currentVesselId).length, vessels: world.vessels.length,
      metInstitutions: world.metInstitutions.length, metProgrammes: world.metProgrammes.length, manningScales: world.manningScales.length, portCalls: world.portCalls.length,
      crewLists: crewLists.lists, crewListLines: crewLists.lines, foreignLedger: Number(ledger.rows[0].n), onWatch: Number(ledger.rows[0].watch),
    };
  });
  await pool.end();
  return counts;
}

interface SeedListOpts { profile: string; jurisdictionName: string; flag: string; prefix: string; agentName: Map<string, string>; byVessel: Map<string, string> }
/** Writes the world's crew lists the way the desk would have received them: matched line by line, the ledger grown from them, and checked. */
async function seedCrewLists(c: Queryable, lists: WorldCrewList[], o: SeedListOpts): Promise<{ lists: number; lines: number }> {
  const e = env();
  const index = await registerIndex(c);
  const ranks = await loadVocab(c, 'seafarerRank');
  const rules = certRules(await loadVocab(c, 'seafarerCertType'));
  const now = new Date();
  const ordered = [...lists].sort((a, b) => a.date.localeCompare(b.date));
  const series = new Map<number, number>();
  let lines = 0;
  const certCache = new Map<string, CertApi[]>();
  for (const l of ordered) {
    const year = new Date(l.date).getUTCFullYear(); const n = (series.get(year) ?? 0) + 1; series.set(year, n);
    // the world's number, under whatever prefix this deployment gives the series
    const number = l.number.replace(/^CL-/, `${o.prefix}-`);
    const nationalFlag = (o.byVessel.get(l.vesselId) ?? '').toUpperCase() === o.flag.toUpperCase();
    await c.query('DELETE FROM crew_lists WHERE number = $1 AND id <> $2', [number, l.id]);
    await c.query(`INSERT INTO crew_lists(id, number, vcn, port_call_id, vessel_id, vessel_name, imo, port, movement, list_date, source, agent_code, agent_name, submitted_by, declared_crew, row_count, remarks, scope_company, created_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$12,$10)
      ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, vcn = EXCLUDED.vcn, port_call_id = EXCLUDED.port_call_id, vessel_id = EXCLUDED.vessel_id, vessel_name = EXCLUDED.vessel_name, imo = EXCLUDED.imo, movement = EXCLUDED.movement,
        list_date = EXCLUDED.list_date, source = EXCLUDED.source, agent_code = EXCLUDED.agent_code, agent_name = EXCLUDED.agent_name, submitted_by = EXCLUDED.submitted_by, declared_crew = EXCLUDED.declared_crew, row_count = EXCLUDED.row_count, scope_company = EXCLUDED.scope_company, updated_at = now()`,
      [l.id, number, l.vcn, l.portCallId, l.vesselId, l.vesselName, l.imo, o.profile === 'AE' ? 'MAR' : 'REF', l.movement, l.date, l.source, l.agentCode, o.agentName.get(l.agentCode) ?? '', l.submittedBy, l.declaredCrew, l.rows.length, l.remarks]);
    await c.query('DELETE FROM crew_list_rows WHERE crew_list_id = $1', [l.id]);
    let matched = 0; let foreign = 0;
    const stored: CrewListLine[] = [];
    for (const r of l.rows) {
      const { match, seafarer } = matchLine({ idNumber: r.idNumber, cdcNo: r.cdcNo, nationality: r.nationality }, index, o.jurisdictionName);
      let foreignId: string | null = null;
      if (match === 'FOREIGN') {
        foreignId = await seedAppearance(c, r, { id: l.id, vesselId: l.vesselId, vesselName: l.vesselName, vcn: l.vcn, date: new Date(l.date), nationalFlag }, ranks.find(r.rankCode)?.meta.officer === true, e.FOREIGN_WATCH_APPEARANCES);
        foreign += 1;
      } else if (match === 'REGISTER') matched += 1;
      const row = await c.query<CrewListLine>(
        `INSERT INTO crew_list_rows(id, crew_list_id, seq, family_name, given_names, rank, rank_code, nationality, dob, pob, gender, id_type, id_number, id_expiry, cdc_no, match, seafarer_id, foreign_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [stableId('crewrow', `${l.id}:${r.seq}`), l.id, r.seq, r.familyName, r.givenNames, r.rank, r.rankCode, r.nationality, r.dob || null, r.pob, r.gender, r.idType, r.idNumber, r.idExpiry ? r.idExpiry.slice(0, 10) : null, r.cdcNo, match, seafarer?.id ?? null, foreignId]);
      stored.push(row.rows[0]); lines += 1;
    }
    // the same checks the desk runs, over the same functions
    const scale = (await c.query<{ rows: ScaleRow[]; msmd_no: string }>('SELECT rows, msmd_no FROM manning_scales WHERE vessel_id = $1', [l.vesselId])).rows[0];
    const certs = new Map<string, CertApi[]>();
    for (const s of stored) if (s.seafarer_id) { if (!certCache.has(s.seafarer_id)) certCache.set(s.seafarer_id, await certsOf(c, s.seafarer_id, now, e.CERT_EXPIRING_DAYS, rules)); certs.set(s.seafarer_id, certCache.get(s.seafarer_id)!); }
    const ids = stored.map((s) => s.foreign_id).filter(Boolean) as string[];
    const ledger = new Map<string, ForeignRow>();
    if (ids.length) for (const f of (await c.query<ForeignRow>('SELECT * FROM foreign_seafarers WHERE id = ANY($1)', [ids])).rows) ledger.set(f.id, f);
    const ctx: CheckContext = { env: e, now, rules, ranks, scale: scale?.rows?.length ? scale.rows : null, msmdNo: scale?.msmd_no ?? '', nationalFlag, declaredCrew: l.declaredCrew, certs, ledger };
    const checks = checkLines(stored, ctx);
    const issues = new Map<number, string[]>();
    const add = (seq: number, i: string) => issues.set(seq, [...(issues.get(seq) ?? []), i]);
    for (const d of checks.documents) for (const f of d.failures) add(d.seq, f);
    for (const i of checks.identity) add(i.seq, i.issue);
    for (const x of checks.endorsements) add(x.seq, x.issue);
    for (const u of checks.unregisteredNationals) add(u.seq, 'National of the flag not on the seafarer register');
    for (const u of checks.unknownRanks) add(u.seq, `Rank "${u.rank}" is not an entry of the seafarerRank master`);
    for (const [seq, list] of issues) await c.query('UPDATE crew_list_rows SET issues = $3 WHERE crew_list_id = $1 AND seq = $2', [l.id, seq, JSON.stringify(list)]);
    // where the world says the desk left it: older lists decided, the recent ones waiting, the defective ones queried
    const status = l.status;
    await c.query(`UPDATE crew_lists SET matched = $2, foreign_count = $3, flagged = $4, checks = $5, status = $6, checked_at = $7, checked_by = 'Crew desk', decided_at = $8, decided_by = $9, decision_note = $10 WHERE id = $1`,
      [l.id, matched, foreign, issues.size, JSON.stringify(checks), status, new Date(new Date(l.date).getTime() + 2 * 3600_000), status === 'CHECKED' ? null : new Date(new Date(l.date).getTime() + 5 * 3600_000), status === 'CHECKED' ? '' : 'Crew desk',
        status === 'QUERIED' ? `Returned to the agent: ${checks.summary[0]}` : status === 'CLEARED' && !checks.ok ? `OVERRIDE: master's declaration accepted pending the next call — ${checks.summary.join('; ')}` : '']);
  }
  // the desk's numbering carries on after the seed's, rather than colliding with it
  for (const [year, n] of series) await c.query('INSERT INTO numbering_series(series, last_value) VALUES ($1, $2) ON CONFLICT (series) DO UPDATE SET last_value = GREATEST(numbering_series.last_value, EXCLUDED.last_value)', [`crew-list:${year}`, n]);
  return { lists: ordered.length, lines };
}

/** The ledger as the world's lists build it: keyed on the document, one appearance per list, the watch rule applied the way the desk applies it. */
async function seedAppearance(c: Queryable, r: Row, list: { id: string; vesselId: string; vesselName: string; vcn: string; date: Date; nationalFlag: boolean }, officer: boolean, watchAt: number): Promise<string> {
  const found = (await c.query<ForeignRow>('SELECT * FROM foreign_seafarers WHERE upper(id_number) = upper($1) AND upper(nationality) = upper($2)', [r.idNumber, r.nationality])).rows[0];
  const appearance = { vesselId: list.vesselId, vesselName: list.vesselName, vcn: list.vcn, date: list.date.toISOString(), rank: r.rank, nationalFlag: list.nationalFlag, listId: list.id };
  if (!found) {
    const id = stableId('foreign', `${r.nationality}:${r.idNumber}`);
    await c.query(`INSERT INTO foreign_seafarers(id, id_type, id_number, family_name, given_names, nationality, dob, id_expiry, cdc_no, last_rank, last_rank_code, first_seen_at, last_seen_at, appearances, vessels, status, status_reason)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$12,1,$13,'LEDGER','First seen on a crew list')
      ON CONFLICT (id) DO UPDATE SET family_name = EXCLUDED.family_name, given_names = EXCLUDED.given_names, dob = EXCLUDED.dob, id_expiry = EXCLUDED.id_expiry, cdc_no = EXCLUDED.cdc_no, last_rank = EXCLUDED.last_rank, last_rank_code = EXCLUDED.last_rank_code,
        first_seen_at = EXCLUDED.first_seen_at, last_seen_at = EXCLUDED.last_seen_at, appearances = 1, vessels = EXCLUDED.vessels, status = 'LEDGER', status_reason = EXCLUDED.status_reason, updated_at = now()`,
      [id, r.idType, r.idNumber, r.familyName, r.givenNames, r.nationality, r.dob || null, r.idExpiry ? r.idExpiry.slice(0, 10) : null, r.cdcNo, r.rank, r.rankCode, list.date, JSON.stringify([appearance])]);
    return id;
  }
  const vessels = (found.vessels ?? []).filter((v) => (v as { listId?: string }).listId !== list.id); vessels.push(appearance); vessels.sort((a, b) => b.date.localeCompare(a.date));
  const nationalCalls = vessels.filter((v) => (v as { nationalFlag?: boolean }).nationalFlag).length;
  const watch = found.status === 'LEDGER' && officer && !found.endorsement_no && nationalCalls >= watchAt;
  await c.query(`UPDATE foreign_seafarers SET last_rank = $2, last_rank_code = $3, last_seen_at = GREATEST(last_seen_at, $4), first_seen_at = LEAST(first_seen_at, $4), appearances = $5, vessels = $6, status = $7, status_reason = $8, updated_at = now() WHERE id = $1`,
    [found.id, r.rank, r.rankCode, list.date, vessels.length, JSON.stringify(vessels), watch ? 'WATCH' : found.status, watch ? `Officer seen on ${nationalCalls} national-flag calls with no flag state endorsement recorded` : found.status_reason]);
  return found.id;
}

if (require.main === module) {
  const e = env();
  seedSeafarers(e.DATABASE_URL, e.JURISDICTION, { crewList: e.CREW_LIST_PREFIX }).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
