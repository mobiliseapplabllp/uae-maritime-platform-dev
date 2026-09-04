import type { PoolClient } from 'pg';
import { NATIONAL_SCOPE, EVENTS, type EventEnvelope } from '@maritime/contracts';
import type { Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { findVessel, publishVessel, type Row } from './vessels';

/* Local snapshots of the facts other domains own. The ship record shows her calls, her inspections, the
 * incidents raised against her, the crew on board and her last AIS fix — none of which this service owns.
 * Each is projected from the owning service's read-model events, so the eight-tab record renders from one
 * database rather than five synchronous hops. */

export async function upsertPortCall(c: Queryable, e: Row) {
  await c.query(`INSERT INTO port_calls(id, vcn, vessel_id, status, eta, etb, etd, ata, atb, atd, berth_id, berth_code, berth_name, terminal, prev_port, next_port, purpose, cargo_ops, status_history)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
    ON CONFLICT (id) DO UPDATE SET vcn = EXCLUDED.vcn, vessel_id = EXCLUDED.vessel_id, status = EXCLUDED.status, eta = EXCLUDED.eta, etb = EXCLUDED.etb, etd = EXCLUDED.etd, ata = EXCLUDED.ata, atb = EXCLUDED.atb, atd = EXCLUDED.atd,
      berth_id = EXCLUDED.berth_id, berth_code = EXCLUDED.berth_code, berth_name = EXCLUDED.berth_name, terminal = EXCLUDED.terminal, prev_port = EXCLUDED.prev_port, next_port = EXCLUDED.next_port, purpose = EXCLUDED.purpose,
      cargo_ops = EXCLUDED.cargo_ops, status_history = EXCLUDED.status_history, updated_at = now()`,
    [String(e.id), e.vcn ?? '', String(e.vesselId ?? ''), e.status ?? 'ANNOUNCED', e.eta ?? null, e.etb ?? null, e.etd ?? null, e.ata ?? null, e.atb ?? null, e.atd ?? null,
      e.berthId ?? null, e.berthCode ?? null, e.berthName ?? null, e.terminal ?? null, e.prevPort ?? null, e.nextPort ?? null, e.purpose ?? null,
      JSON.stringify(e.cargoOps ?? []), JSON.stringify(e.statusHistory ?? e.history ?? [])]);
}
export async function upsertInspection(c: Queryable, e: Row) {
  const findings: Row[] = e.findings ?? [];
  await c.query(`INSERT INTO inspections(id, number, vessel_id, type, status, result, detention, open_findings, total_findings, findings, planned_at, closed_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, vessel_id = EXCLUDED.vessel_id, type = EXCLUDED.type, status = EXCLUDED.status, result = EXCLUDED.result, detention = EXCLUDED.detention,
      open_findings = EXCLUDED.open_findings, total_findings = EXCLUDED.total_findings, findings = EXCLUDED.findings, planned_at = EXCLUDED.planned_at, closed_at = EXCLUDED.closed_at, updated_at = now()`,
    [String(e.id), e.number ?? '', String(e.vesselId ?? ''), e.type ?? 'PSC', e.status ?? 'PLANNED', e.result || null, !!e.detention,
      e.openFindings ?? findings.filter((f) => f.status === 'OPEN').length, e.totalFindings ?? findings.length, JSON.stringify(findings), e.plannedAt ?? null, e.closedAt ?? null]);
}
export async function upsertIncident(c: Queryable, e: Row) {
  await c.query(`INSERT INTO incidents(id, number, vessel_id, title, type, severity, status, reported_at, closed_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, vessel_id = EXCLUDED.vessel_id, title = EXCLUDED.title, type = EXCLUDED.type, severity = EXCLUDED.severity, status = EXCLUDED.status,
      reported_at = EXCLUDED.reported_at, closed_at = EXCLUDED.closed_at, updated_at = now()`,
    [String(e.id), e.number ?? '', String(e.vesselId ?? ''), e.title ?? '', e.type ?? '', e.severity ?? 'LOW', e.status ?? 'OPEN', e.reportedAt ?? null, e.closedAt ?? null]);
}
export async function upsertCrew(c: Queryable, e: Row) {
  const certs: Row[] = e.certificates ?? [];
  await c.query(`INSERT INTO crew(id, name, rank, cdc_no, nationality, status, current_vessel_id, cert_alerts) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, rank = EXCLUDED.rank, cdc_no = EXCLUDED.cdc_no, nationality = EXCLUDED.nationality, status = EXCLUDED.status,
      current_vessel_id = EXCLUDED.current_vessel_id, cert_alerts = EXCLUDED.cert_alerts, updated_at = now()`,
    [String(e.id), e.name ?? '', e.rank ?? '', e.cdcNo ?? '', e.nationality ?? '', e.status ?? 'ACTIVE', e.currentVesselId ?? null,
      e.certAlerts ?? certs.filter((x) => x.status && x.status !== 'VALID').length]);
}
export async function upsertPosition(c: Queryable, e: Row) {
  await c.query(`INSERT INTO positions(vessel_id, lat, lon, speed, course, nav_status, received_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (vessel_id) DO UPDATE SET lat = EXCLUDED.lat, lon = EXCLUDED.lon, speed = EXCLUDED.speed, course = EXCLUDED.course, nav_status = EXCLUDED.nav_status, received_at = EXCLUDED.received_at`,
    [String(e.vesselId ?? e.id), Number(e.lat) || 0, Number(e.lon) || 0, Number(e.speed) || 0, Math.round(Number(e.course) || 0), e.navStatus ?? 'UNDER_WAY', e.receivedAt ?? new Date()]);
}
export async function upsertCompany(c: Queryable, o: Row) {
  await c.query('INSERT INTO companies(id, code, name, category, status) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, category = EXCLUDED.category, status = EXCLUDED.status, updated_at = now()',
    [String(o.id), o.code ?? '', o.name ?? '', o.category ?? null, o.status ?? 'ACTIVE']);
}
export async function upsertInvoice(c: Queryable, i: Row) {
  await c.query('INSERT INTO invoices(id, number, vessel_id, port_call_id, status, total, currency) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, vessel_id = EXCLUDED.vessel_id, port_call_id = EXCLUDED.port_call_id, status = EXCLUDED.status, total = EXCLUDED.total, currency = EXCLUDED.currency, updated_at = now()',
    [String(i.id), i.number ?? '', i.vesselId ?? null, i.portCallId ?? null, i.status ?? 'DRAFT', Number(i.total) || 0, i.currency ?? 'AED']);
}

/* A statutory certificate this administration issued arrives from the instrument register as
 * `readmodel.upserted { kind: vesselCertificate }`. It is merged onto the ship's own list keyed on the
 * instrument, so a reissue replaces the entry rather than doubling it, and it is kept read-only here: the
 * register, not the ship's list, is the authority on what it issued. */
export async function mergeInstrumentCertificate(c: Queryable, e: Row): Promise<string | null> {
  const vesselId = String(e.vesselId ?? '');
  if (!vesselId || !e.certType || !e.expiryDate) return null;
  const v = await c.query<{ id: string }>('SELECT id FROM vessels WHERE id::text = $1', [vesselId]);
  if (!v.rowCount) return null;
  const id = String(e.id ?? '');
  const existing = await c.query<{ id: string }>(
    'SELECT id FROM vessel_certificates WHERE (instrument_id IS NOT NULL AND instrument_id = $1) OR id::text = $2 OR (vessel_id = $3 AND cert_type = $4 AND instrument_id IS NOT NULL) LIMIT 1',
    [e.instrumentId ?? null, id || '00000000-0000-0000-0000-000000000000', vesselId, e.certType]);
  const cols = [e.certType, e.number ?? '', e.issuer ?? '', e.issueDate ?? null, e.expiryDate, e.remarks ?? '', e.instrumentId ?? null, e.onRegister !== false, e.inForce ?? null, e.forceReason ?? '', !!e.signed, Number(e.endorsementsOverdue) || 0];
  if (existing.rowCount) {
    await c.query(`UPDATE vessel_certificates SET cert_type = $2, number = $3, issuer = $4, issue_date = $5, expiry_date = $6, remarks = $7, instrument_id = $8, on_register = $9, in_force = $10, force_reason = $11, signed = $12, endorsements_overdue = $13, updated_at = now() WHERE id = $1`,
      [existing.rows[0].id, ...cols]);
    return existing.rows[0].id;
  }
  const ins = await c.query<{ id: string }>(`INSERT INTO vessel_certificates(id, vessel_id, cert_type, number, issuer, issue_date, expiry_date, remarks, instrument_id, on_register, in_force, force_reason, signed, endorsements_overdue)
    VALUES (COALESCE($1::uuid, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
    [/^[0-9a-f-]{36}$/i.test(id) ? id : null, vesselId, ...cols]);
  return ins.rows[0].id;
}

const DELETE_TABLE: Record<string, string> = { portCall: 'port_calls', inspection: 'inspections', incident: 'incidents', seafarer: 'crew', company: 'companies', invoice: 'invoices' };

/** Applies a read-model event to the local snapshots. Returns the vessel ids whose record changed. */
export async function projectSnapshot(c: PoolClient, env: Env, event: EventEnvelope): Promise<string | null> {
  const d = (event.data ?? {}) as Row;
  if (event.type === EVENTS.readModel.upserted) {
    const e: Row = d.entity ?? {};
    switch (d.kind) {
      case 'portCall': if (e.id) await upsertPortCall(c, e); return null;
      case 'inspection': if (e.id) await upsertInspection(c, e); return null;
      case 'incident': if (e.id) await upsertIncident(c, e); return null;
      case 'seafarer': if (e.id) await upsertCrew(c, e); return null;
      case 'company': if (e.id) await upsertCompany(c, e); return null;
      case 'invoice': if (e.id) await upsertInvoice(c, e); return null;
      case 'position': if (e.vesselId) await upsertPosition(c, e); return null;
      case 'vesselCertificate': {
        // events this service published itself come back through the bus; only an instrument-issued certificate is merged
        if (event.source === env.SERVICE_NAME || !e.instrumentId) return null;
        const id = await mergeInstrumentCertificate(c, e);
        return id ? String(e.vesselId) : null;
      }
      default: return null;
    }
  }
  if (event.type === EVENTS.readModel.deleted && DELETE_TABLE[d.kind] && d.id) { await c.query(`DELETE FROM ${DELETE_TABLE[d.kind]} WHERE id = $1`, [String(d.id)]); return null; }
  if (event.type === EVENTS.mdm.companyUpserted && d.company?.id) { await upsertCompany(c, d.company); return null; }
  if (event.type === EVENTS.maritimeCentre.positionUpdated && d.vesselId) { await upsertPosition(c, d); return null; }
  return null;
}

/** Republishes a ship whose record changed because something arrived for it. */
export async function republishVessel(c: PoolClient, env: Env, vesselId: string, cause: EventEnvelope) {
  const v = await findVessel(c, vesselId, NATIONAL_SCOPE);
  if (v) await publishVessel(c, env, v, { cause });
}
