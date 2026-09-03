import type { PoolClient } from 'pg';
import { EVENTS, type EventEnvelope } from '@maritime/contracts';
import type { Queryable } from '@maritime/service-kit';
import { corpusFromLegalInstrument, upsertCorpusDoc, reindex } from './corpus';

/* Local snapshots of the records the assistant reads on a user's behalf.
 *
 * The tool surface queries these and never another service's database, so the assistant's reach is exactly the
 * read models the platform already publishes — and a record it has never been told about is simply one it
 * cannot answer from, which is the right failure. */

export type Row = Record<string, any>;
const d = (v: unknown) => (v === undefined || v === '' ? null : v);
const json = (v: unknown) => JSON.stringify(v ?? {});

export async function upsertVessel(c: Queryable, e: Row) {
  await c.query(`INSERT INTO vessels(id, imo, name, type, flag, built, status, risk_score, risk_band, real, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (id) DO UPDATE SET imo = EXCLUDED.imo, name = EXCLUDED.name, type = EXCLUDED.type, flag = EXCLUDED.flag, built = EXCLUDED.built,
      status = EXCLUDED.status, risk_score = EXCLUDED.risk_score, risk_band = EXCLUDED.risk_band, real = EXCLUDED.real, payload = EXCLUDED.payload, updated_at = now()`,
    [String(e.id), e.imo ?? '', e.name ?? '', e.type ?? '', e.flag ?? '', Number(e.built) || 0, e.status ?? 'ACTIVE',
      e.riskScore ?? e.registry?.riskScore ?? null, e.riskBand ?? e.registry?.riskBand ?? '', !!e.real, json(e)]);
}
export async function upsertCertificate(c: Queryable, e: Row) {
  await c.query(`INSERT INTO vessel_certificates(id, vessel_id, vessel_name, cert_type, expiry_date, state) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (id) DO UPDATE SET vessel_id = EXCLUDED.vessel_id, vessel_name = EXCLUDED.vessel_name, cert_type = EXCLUDED.cert_type,
      expiry_date = EXCLUDED.expiry_date, state = EXCLUDED.state, updated_at = now()`,
    [String(e.id), String(e.vesselId ?? ''), e.vesselName ?? '', e.certType ?? '', d(e.expiryDate), e.state ?? (e.inForce === false ? 'EXPIRED' : 'VALID')]);
}
export async function upsertPortCall(c: Queryable, e: Row) {
  await c.query(`INSERT INTO port_calls(id, vcn, vessel_id, vessel_name, status, berth_code, agent_name, eta, atb, atd, cargo)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (id) DO UPDATE SET vcn = EXCLUDED.vcn, vessel_id = EXCLUDED.vessel_id, vessel_name = EXCLUDED.vessel_name, status = EXCLUDED.status,
      berth_code = EXCLUDED.berth_code, agent_name = EXCLUDED.agent_name, eta = EXCLUDED.eta, atb = EXCLUDED.atb, atd = EXCLUDED.atd,
      cargo = EXCLUDED.cargo, updated_at = now()`,
    [String(e.id), e.vcn ?? '', String(e.vesselId ?? ''), e.vesselName ?? '', e.status ?? '', e.berthCode ?? '', e.agentName ?? '',
      d(e.eta), d(e.atb), d(e.atd), JSON.stringify(e.cargoOps ?? [])]);
}
export async function upsertInvoice(c: Queryable, e: Row) {
  await c.query(`INSERT INTO invoices(id, number, party, vessel_name, total, currency, status, issued_at, paid_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, party = EXCLUDED.party, vessel_name = EXCLUDED.vessel_name, total = EXCLUDED.total,
      currency = EXCLUDED.currency, status = EXCLUDED.status, issued_at = EXCLUDED.issued_at, paid_at = EXCLUDED.paid_at, updated_at = now()`,
    [String(e.id), e.number ?? '', e.billTo?.name ?? e.billToName ?? e.party ?? '', e.vesselName ?? '', Math.round(Number(e.total) || 0),
      e.currency ?? 'AED', e.status ?? '', d(e.issuedAt), d(e.paidAt)]);
}
export async function upsertInspection(c: Queryable, e: Row) {
  const findings: Row[] = e.findings ?? [];
  await c.query(`INSERT INTO inspections(id, number, vessel_id, vessel_name, type, status, result, detention, open_findings, total_findings, closed_at, planned_at, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, vessel_id = EXCLUDED.vessel_id, vessel_name = EXCLUDED.vessel_name, type = EXCLUDED.type,
      status = EXCLUDED.status, result = EXCLUDED.result, detention = EXCLUDED.detention, open_findings = EXCLUDED.open_findings,
      total_findings = EXCLUDED.total_findings, closed_at = EXCLUDED.closed_at, planned_at = EXCLUDED.planned_at, payload = EXCLUDED.payload, updated_at = now()`,
    [String(e.id), e.number ?? '', String(e.vesselId ?? ''), e.vesselName ?? '', e.type ?? '', e.status ?? '', e.result ?? '', !!e.detention,
      e.openFindings ?? findings.filter((f) => f.status === 'OPEN').length, e.totalFindings ?? findings.length, d(e.closedAt), d(e.plannedAt), json(e)]);
}
export async function upsertIncident(c: Queryable, e: Row) {
  await c.query(`INSERT INTO incidents(id, number, title, type, severity, status, vessel_name, reported_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, title = EXCLUDED.title, type = EXCLUDED.type, severity = EXCLUDED.severity,
      status = EXCLUDED.status, vessel_name = EXCLUDED.vessel_name, reported_at = EXCLUDED.reported_at, updated_at = now()`,
    [String(e.id), e.number ?? '', e.title ?? '', e.type ?? '', e.severity ?? '', e.status ?? '', e.vesselName ?? '', d(e.reportedAt)]);
}
export async function upsertInstrument(c: Queryable, e: Row) {
  await c.query(`INSERT INTO instruments(id, number, entity_name, entity_type, subject_kind, subject_id, status, issue_date, expiry_date, in_force)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, entity_name = EXCLUDED.entity_name, entity_type = EXCLUDED.entity_type,
      subject_kind = EXCLUDED.subject_kind, subject_id = EXCLUDED.subject_id, status = EXCLUDED.status, issue_date = EXCLUDED.issue_date,
      expiry_date = EXCLUDED.expiry_date, in_force = EXCLUDED.in_force, updated_at = now()`,
    [String(e.id), e.number ?? e.licenseNo ?? '', e.entityName ?? '', e.entityType ?? '', e.subjectKind ?? '', String(e.subjectId ?? ''),
      e.status ?? '', d(e.issueDate), d(e.expiryDate), e.inForce ?? true]);
}

const UPSERTS: Record<string, (c: Queryable, e: Row) => Promise<void>> = {
  vessel: upsertVessel, vesselCertificate: upsertCertificate, portCall: upsertPortCall, invoice: upsertInvoice,
  inspection: upsertInspection, incident: upsertIncident, instrument: upsertInstrument,
};
const DELETE_TABLE: Record<string, string> = {
  vessel: 'vessels', vesselCertificate: 'vessel_certificates', portCall: 'port_calls', invoice: 'invoices',
  inspection: 'inspections', incident: 'incidents', instrument: 'instruments',
};

/**
 * Applies a read-model event to the snapshots, and folds a published legal instrument into the retrieval corpus
 * so an answer can cite a notice the day it is published rather than the next time the service is seeded.
 */
export async function projectSnapshot(c: PoolClient, event: EventEnvelope): Promise<string | null> {
  const data = (event.data ?? {}) as Row;
  if (event.type === EVENTS.readModel.upserted) {
    const e: Row = data.entity ?? {};
    if (!e.id) return null;
    if (data.kind === 'legalInstrument') {
      await upsertCorpusDoc(c, corpusFromLegalInstrument(e));
      await reindex(c);
      return 'legalInstrument';
    }
    const fn = UPSERTS[data.kind];
    if (!fn) return null;
    await fn(c, e);
    return data.kind;
  }
  if (event.type === EVENTS.readModel.deleted && DELETE_TABLE[data.kind] && data.id) {
    await c.query(`DELETE FROM ${DELETE_TABLE[data.kind]} WHERE id = $1`, [String(data.id)]);
    return null;
  }
  if (event.type === EVENTS.readModel.deleted && data.kind === 'legalInstrument' && data.id) {
    await c.query('DELETE FROM corpus WHERE id = $1', [`legislation:${data.id}`]);
    await reindex(c);
    return null;
  }
  return null;
}
