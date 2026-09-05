import { join } from 'node:path';
import { buildWorld, certStatus, stableId, type WorldRegistration, type WorldVessel } from '@maritime/world';
import { createDb, runMigrations, withTx, type Queryable, seedLookupMirror } from '@maritime/service-kit';
import { env } from './env';
import { upsertCompany, upsertCrew, upsertIncident, upsertInspection, upsertInvoice, upsertPortCall, upsertPosition } from './subjects';
import type { Row } from './vessels';

/* Seeds the ship register from the shared world: the fleet with its particulars, the certificate list each
 * ship carries, every transaction on the national register and the registry entries those transactions
 * produced. The snapshots other domains own (calls, inspections, incidents, crew, agents, invoices, AIS)
 * are seeded here too so the eight-tab record and the risk model are usable before any event arrives.
 * Idempotent — every write is an upsert on the world's stable id, and the numbering series are advanced
 * past the seeded numbers. */

/** Advances a numbering series so the next issued number never collides with a seeded one. */
async function advance(c: Queryable, series: string, value: number) {
  await c.query('INSERT INTO numbering_series(series, last_value) VALUES ($1,$2) ON CONFLICT (series) DO UPDATE SET last_value = GREATEST(numbering_series.last_value, EXCLUDED.last_value)', [series, value]);
}
/** Evidence and charges are addressable on the API, so the seeded ones carry stable ids of their own. */
const evidenceOf = (r: WorldRegistration) => r.evidence.map((e) => ({ id: stableId('regevidence', `${r.id}:${e.key}`), ...e, createdAt: e.issuedOn }));
const encumbrancesOf = (r: WorldRegistration) => r.encumbrances.map((e) => ({ id: stableId('regcharge', `${r.id}:${e.reference}`), ...e }));
/** `REG-2019-00042` → the series `REG-2019` at 42; `AUH/CR/2019/0007` → the series `AUH/CR/2019` at 7. */
function noteSeries(series: Map<string, number>, value: string, sep = '/') {
  const at = value.lastIndexOf(sep);
  if (at < 0) return;
  const key = value.slice(0, at); const n = Number(value.slice(at + 1));
  if (Number.isFinite(n)) series.set(key, Math.max(series.get(key) ?? 0, n));
}

export async function seedShips(databaseUrl: string, profile = 'AE', prefix = { transaction: 'RTX' }) {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });
  const now = new Date(world.now);
  const counts = await withTx(pool, async (c) => {
    const registryByVessel = new Map(world.registry.map((r) => [r.vesselId, r]));
    const agentByCode = new Map(world.companies.map((o) => [o.code, o]));

    for (const v of world.vessels as WorldVessel[]) {
      const reg = registryByVessel.get(v.id);
      await c.query(`INSERT INTO vessels(id, name, imo, mmsi, call_sign, flag, type, built, dwt, grt, loa, beam, max_draft, owner, operator, manager, agent_code, class_society, pi_club, port_of_registry, yard, engine, service_speed_kn, teu_capacity, last_dry_dock, next_dry_dock, liner, real, status, remarks,
          registry_state, official_number, registry_port, certificate_no, registered_on, certificate_expires_on, closed_on, closure_reason)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,'',$30,$31,$32,$33,$34,$35,$36,$37)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, imo = EXCLUDED.imo, mmsi = EXCLUDED.mmsi, call_sign = EXCLUDED.call_sign, flag = EXCLUDED.flag, type = EXCLUDED.type, built = EXCLUDED.built, dwt = EXCLUDED.dwt, grt = EXCLUDED.grt,
          loa = EXCLUDED.loa, beam = EXCLUDED.beam, max_draft = EXCLUDED.max_draft, owner = EXCLUDED.owner, operator = EXCLUDED.operator, manager = EXCLUDED.manager, agent_code = EXCLUDED.agent_code, class_society = EXCLUDED.class_society,
          pi_club = EXCLUDED.pi_club, port_of_registry = EXCLUDED.port_of_registry, yard = EXCLUDED.yard, engine = EXCLUDED.engine, service_speed_kn = EXCLUDED.service_speed_kn, teu_capacity = EXCLUDED.teu_capacity,
          last_dry_dock = EXCLUDED.last_dry_dock, next_dry_dock = EXCLUDED.next_dry_dock, liner = EXCLUDED.liner, real = EXCLUDED.real, status = EXCLUDED.status,
          registry_state = EXCLUDED.registry_state, official_number = EXCLUDED.official_number, registry_port = EXCLUDED.registry_port, certificate_no = EXCLUDED.certificate_no, registered_on = EXCLUDED.registered_on,
          certificate_expires_on = EXCLUDED.certificate_expires_on, closed_on = EXCLUDED.closed_on, closure_reason = EXCLUDED.closure_reason, updated_at = now()`,
        [v.id, v.name, v.imo, v.mmsi, v.callSign, v.flag, v.type, v.built, v.dwt, v.grt, v.loa, v.beam, v.maxDraft, v.owner, v.operator, v.manager, v.agentCode, v.classSociety,
          v.real ? '' : `${v.name.split(' ')[0]} P&I Association`, reg?.portOfRegistryName ?? '', v.real ? '' : `${v.classSociety} approved yard`,
          JSON.stringify(v.real ? {} : { maker: v.type === 'CONT' ? 'MAN B&W' : 'Wärtsilä', model: `${v.type}-${v.built}`, powerKW: Math.round(v.grt * 0.35) }),
          v.real ? null : Math.round((v.type === 'CONT' ? 20 : 13) + (v.loa % 5)), v.teuCapacity,
          v.real ? null : new Date(Date.UTC(v.built + 3, (v.grt % 12), 12)), v.real ? null : new Date(Date.UTC(v.built + 8, (v.grt % 12), 12)),
          v.liner, v.real, v.status,
          reg?.state ?? 'UNREGISTERED', reg?.officialNumber ?? '', reg?.portOfRegistry ?? '', reg?.certificateNo ?? '',
          reg?.registeredOn ?? null, reg?.certificateExpiresOn ?? null, reg?.closedOn ?? null, reg?.closureReason ?? '']);
    }

    for (const vc of world.vesselCertificates) {
      await c.query(`INSERT INTO vessel_certificates(id, vessel_id, cert_type, number, issuer, issue_date, expiry_date, remarks, instrument_id, on_register, in_force, force_reason, signed)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (id) DO UPDATE SET vessel_id = EXCLUDED.vessel_id, cert_type = EXCLUDED.cert_type, number = EXCLUDED.number, issuer = EXCLUDED.issuer, issue_date = EXCLUDED.issue_date, expiry_date = EXCLUDED.expiry_date,
          remarks = EXCLUDED.remarks, instrument_id = EXCLUDED.instrument_id, on_register = EXCLUDED.on_register, in_force = EXCLUDED.in_force, force_reason = EXCLUDED.force_reason, signed = EXCLUDED.signed, updated_at = now()`,
        [vc.id, vc.vesselId, vc.certType, vc.number, vc.issuer, vc.issueDate, vc.expiryDate, vc.remarks, vc.instrumentId,
          !!vc.instrumentId, vc.instrumentId ? certStatus(vc.expiryDate, now) !== 'EXPIRED' : null,
          vc.instrumentId ? (certStatus(vc.expiryDate, now) === 'EXPIRED' ? 'Certificate has expired' : 'In force') : '', !!vc.instrumentId]);
    }

    const series = new Map<string, number>();
    for (const r of world.registrations) {
      await c.query(`INSERT INTO registrations(id, application_no, kind, vessel_id, vessel_name, imo, port_of_registry, applicant, owners, tonnage, previous_flag, previous_registry, previous_official_number,
          evidence, encumbrances, carving_note, amendment, deletion, status, checks, assigned_to_id, assigned_to, official_number, certificate_no, granted_on, granted_by, certificate_expires_on, fee, decision, submitted_at, due_at, closed_at, history, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)
        ON CONFLICT (id) DO UPDATE SET application_no = EXCLUDED.application_no, kind = EXCLUDED.kind, vessel_id = EXCLUDED.vessel_id, vessel_name = EXCLUDED.vessel_name, imo = EXCLUDED.imo, port_of_registry = EXCLUDED.port_of_registry,
          applicant = EXCLUDED.applicant, owners = EXCLUDED.owners, tonnage = EXCLUDED.tonnage, previous_flag = EXCLUDED.previous_flag, previous_registry = EXCLUDED.previous_registry, previous_official_number = EXCLUDED.previous_official_number,
          evidence = EXCLUDED.evidence, encumbrances = EXCLUDED.encumbrances, carving_note = EXCLUDED.carving_note, amendment = EXCLUDED.amendment, deletion = EXCLUDED.deletion, status = EXCLUDED.status, checks = EXCLUDED.checks,
          assigned_to_id = EXCLUDED.assigned_to_id, assigned_to = EXCLUDED.assigned_to, official_number = EXCLUDED.official_number, certificate_no = EXCLUDED.certificate_no, granted_on = EXCLUDED.granted_on, granted_by = EXCLUDED.granted_by,
          certificate_expires_on = EXCLUDED.certificate_expires_on, fee = EXCLUDED.fee, decision = EXCLUDED.decision, submitted_at = EXCLUDED.submitted_at, due_at = EXCLUDED.due_at, closed_at = EXCLUDED.closed_at,
          history = EXCLUDED.history, created_at = EXCLUDED.created_at, updated_at = now()`,
        [r.id, r.applicationNo, r.kind, r.vesselId, r.vesselName, r.imo, r.portOfRegistry, JSON.stringify(r.applicant), JSON.stringify(r.owners), JSON.stringify(r.tonnage),
          r.previousFlag, r.previousRegistry, r.previousOfficialNumber, JSON.stringify(evidenceOf(r)), JSON.stringify(encumbrancesOf(r)),
          r.carvingNote ? JSON.stringify(r.carvingNote) : null, r.amendment ? JSON.stringify(r.amendment) : null, r.deletion ? JSON.stringify(r.deletion) : null,
          r.status, JSON.stringify(r.checks), r.assignedToId, r.assignedTo, r.officialNumber, r.certificateNo, r.grantedOn, r.grantedBy, r.certificateExpiresOn,
          JSON.stringify(r.fee), r.decision ? JSON.stringify(r.decision) : null, r.submittedAt, r.dueAt, r.closedAt, JSON.stringify(r.history), r.submittedAt]);
      noteSeries(series, r.applicationNo, '-');
      if (r.carvingNote?.number) noteSeries(series, r.carvingNote.number);
      if (r.certificateNo) noteSeries(series, r.certificateNo);
    }
    for (const [key, n] of series) await advance(c, key, n);

    /* The registry ledger, from the grants the world records: one transaction per grant (typed by the variant's
     * master entry, or by each amendment type), the charges those files carried onto the entry, and the masters
     * the registrar validates against — all as the runtime would have written them. Numbered chronologically. */
    const lookups = await seedLookupMirror(c, world.lookups);
    const kindMeta = new Map(world.lookups.filter((l) => l.category === 'registrationKind').map((l) => [l.code, l.meta as Row]));
    const amendMeta = new Map(world.lookups.filter((l) => l.category === 'amendmentType').map((l) => [l.code, l.meta as Row]));
    const vesselById = new Map(world.vessels.map((v) => [v.id, v]));
    type Tx = { id: string; vesselId: string; type: string; registrationId: string; applicationNo: string; particulars: Row; at: Date; encumbrance?: Row };
    const txs: Tx[] = [];
    for (const r of world.registrations.filter((x) => x.status === 'GRANTED' && x.grantedOn)) {
      const at = new Date(r.grantedOn as string); const meta = kindMeta.get(r.kind) ?? {};
      const types: string[] = r.kind === 'AMENDMENT' ? (r.amendment?.types ?? []).map((t) => String(amendMeta.get(t)?.transactionType ?? 'ALTERATION')) : [String(meta.transactionType ?? 'REGISTRATION')];
      types.filter((t) => t !== 'MORTGAGE_REGISTRATION').forEach((type, i) => txs.push({ id: stableId('rtx', `${r.applicationNo}:${i}`), vesselId: r.vesselId, type, registrationId: r.id, applicationNo: r.applicationNo, at,
        particulars: r.kind === 'AMENDMENT' ? { alteration: r.amendment?.types?.[i] ?? '', before: r.amendment?.before ?? {}, after: r.amendment?.after ?? {}, approvalReference: r.amendment?.approvalReference ?? '', certificateNo: r.certificateNo }
          : r.kind === 'DELETION' ? { reason: r.deletion?.reason, newFlag: r.deletion?.newFlag ?? '', certificateNo: r.certificateNo, effectiveOn: r.deletion?.effectiveOn ?? null }
          : { certificateNo: r.certificateNo, officialNumber: r.officialNumber, portOfRegistry: r.portOfRegistry, owners: r.owners.map((o) => ({ name: o.name, shares: o.shares })), expiresOn: r.certificateExpiresOn } }));
    }
    // a charge recorded on any file stands against the entry whatever the file's own state: a closure held up by a mortgage is held up by a mortgage on the register
    for (const r of world.registrations) {
      r.encumbrances.forEach((e, i) => txs.push({ id: stableId('rtx', `${r.applicationNo}:enc:${i}`), vesselId: r.vesselId, type: 'MORTGAGE_REGISTRATION', registrationId: r.id, applicationNo: r.applicationNo, at: new Date(e.registeredOn),
        particulars: { kind: e.kind, holder: e.holder, amount: e.amount, currency: e.currency, reference: e.reference }, encumbrance: { ...e, id: stableId('renc', `${r.applicationNo}:${i}`) } }));
    }
    txs.sort((a, b) => a.at.getTime() - b.at.getTime());
    const txSeries = new Map<string, number>();
    for (const t of txs) {
      const v = vesselById.get(t.vesselId); if (!v) continue;
      const key = `${prefix.transaction}-${t.at.getUTCFullYear()}`; const n = (txSeries.get(key) ?? 0) + 1; txSeries.set(key, n);
      const number = `${key}-${String(n).padStart(5, '0')}`;
      await c.query('DELETE FROM registry_transactions WHERE number = $1 AND id <> $2', [number, t.id]);
      await c.query(`INSERT INTO registry_transactions(id, number, vessel_id, vessel_name, official_number, type, registration_id, application_no, particulars, recorded_on, recorded_by, notes, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'Registry','',$10)
        ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, type = EXCLUDED.type, particulars = EXCLUDED.particulars, recorded_on = EXCLUDED.recorded_on`,
        [t.id, number, t.vesselId, v.name, world.registry.find((x) => x.vesselId === t.vesselId)?.officialNumber ?? '', t.type, t.registrationId, t.applicationNo, JSON.stringify(t.particulars), t.at]);
      if (t.encumbrance) {
        const e = t.encumbrance;
        await c.query(`INSERT INTO registry_encumbrances(id, vessel_id, kind, holder, amount, currency, registered_on, discharged_on, reference, registration_id, transaction_id)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (id) DO UPDATE SET holder = EXCLUDED.holder, amount = EXCLUDED.amount, discharged_on = EXCLUDED.discharged_on, transaction_id = EXCLUDED.transaction_id, updated_at = now()`,
          [e.id, t.vesselId, e.kind, e.holder, e.amount, e.currency, e.registeredOn, e.dischargedOn, e.reference, t.registrationId, t.id]);
      }
    }
    for (const [key, n] of txSeries) await advance(c, key, n);

    // the snapshots other domains own, so the ship record and the risk model read from one database from the first request
    const berthByCode = new Map(world.berths.map((b) => [b.code, b]));
    for (const o of world.companies) await upsertCompany(c, o as unknown as Row);
    for (const call of world.portCalls) {
      const b = call.berthCode ? berthByCode.get(call.berthCode) : undefined;
      await upsertPortCall(c, {
        id: call.id, vcn: call.vcn, vesselId: call.vesselId, status: call.status, eta: call.eta, etb: call.etb, etd: call.etd, ata: call.ata, atb: call.atb, atd: call.atd,
        berthId: b?.id ?? null, berthCode: call.berthCode, berthName: b?.name ?? null, terminal: b?.terminal ?? null, prevPort: call.prevPort, nextPort: call.nextPort,
        cargoOps: call.cargoOps, statusHistory: statusTrail(call),
      });
    }
    for (const i of world.inspections) await upsertInspection(c, { id: i.id, number: i.number, vesselId: i.vesselId, type: i.type, status: i.status, result: i.result, detention: i.detention, findings: i.findings, plannedAt: i.plannedAt, closedAt: i.closedAt });
    for (const i of world.incidents) if (i.vesselId) await upsertIncident(c, { id: i.id, number: i.number, vesselId: i.vesselId, title: i.title, type: i.type, severity: i.severity, status: i.status, reportedAt: i.reportedAt, closedAt: i.closedAt });
    for (const s of world.seafarers) await upsertCrew(c, { id: s.id, name: s.name, rank: s.rank, cdcNo: s.cdcNo, nationality: s.nationality, status: s.status, currentVesselId: s.currentVesselId, certAlerts: s.certificates.filter((cert) => certStatus(cert.expiryDate, now) !== 'VALID').length });
    for (const p of world.positions) await upsertPosition(c, { vesselId: p.vesselId, lat: p.lat, lon: p.lon, speed: p.sog, course: p.cog, navStatus: p.navStatus, receivedAt: p.timestamp });
    for (const inv of world.invoices) await upsertInvoice(c, { id: inv.id, number: inv.number, vesselId: inv.vesselId, portCallId: inv.portCallId, status: inv.status, total: inv.total, currency: inv.currency });

    return {
      profile: world.profile, vessels: world.vessels.length, certificates: world.vesselCertificates.length, registrations: world.registrations.length, lookups, transactions: txs.length,
      registryEntries: world.registry.filter((r) => r.state !== 'UNREGISTERED').length, series: series.size,
      portCalls: world.portCalls.length, inspections: world.inspections.length, incidents: world.incidents.filter((i) => i.vesselId).length,
      crew: world.seafarers.length, companies: world.companies.length, positions: world.positions.length, invoices: world.invoices.length,
      agents: [...agentByCode.keys()].length,
    };
  });
  await pool.end();
  return counts;
}

const ORDER = ['ANNOUNCED', 'CONFIRMED', 'AT_ANCHORAGE', 'BERTHED', 'SAILED'];
/** The status trail a call would have accumulated, timed off the stamps it carries — the movement tab reads it. */
function statusTrail(call: { status: string; eta: string; etb: string | null; ata: string | null; atb: string | null; atd: string | null }) {
  const path = call.status === 'CANCELLED' ? ['ANNOUNCED', 'CANCELLED'] : ORDER.slice(0, Math.max(1, ORDER.indexOf(call.status) + 1));
  const stamps: Record<string, string | null> = { ANNOUNCED: call.eta, CONFIRMED: call.etb ?? call.eta, AT_ANCHORAGE: call.ata, BERTHED: call.atb, SAILED: call.atd, CANCELLED: call.eta };
  const notes: Record<string, string> = { ANNOUNCED: 'Call announced', CONFIRMED: 'Berth allocated and call confirmed', AT_ANCHORAGE: 'Reported at the anchorage', BERTHED: 'All fast alongside', SAILED: 'Sailed', CANCELLED: 'Call withdrawn by the agent' };
  let prev = '';
  return path.map((s) => { const e = { from: prev, to: s, at: new Date(stamps[s] ?? call.eta).toISOString(), by: 'Harbour Master Control', note: notes[s] ?? '' }; prev = s; return e; });
}

if (require.main === module) {
  const e = env();
  seedShips(e.DATABASE_URL, e.JURISDICTION, { transaction: e.TRANSACTION_PREFIX }).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
