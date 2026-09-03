import type { PoolClient } from 'pg';
import { EVENTS, type EventEnvelope } from '@maritime/contracts';
import type { Queryable } from '@maritime/service-kit';

/* Local snapshots of the facts other domains own.
 *
 * An agent that scores a ship must read the same ship the register shows, and it must do it without a privileged
 * path into another service's database. So every record an agent reasons over arrives here as a read-model event
 * and is kept in a snapshot table: the typed columns the runtime filters on, and the API-shaped record itself in
 * `payload` so the judgement sees the whole fact rather than the handful of columns someone remembered to add. */

export type Row = Record<string, any>;
const json = (v: unknown) => JSON.stringify(v ?? {});
const d = (v: unknown) => (v === undefined || v === '' ? null : v);

export async function upsertVessel(c: Queryable, e: Row) {
  await c.query(`INSERT INTO vessels(id, imo, name, type, flag, built, grt, class_society, status, real, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (id) DO UPDATE SET imo = EXCLUDED.imo, name = EXCLUDED.name, type = EXCLUDED.type, flag = EXCLUDED.flag, built = EXCLUDED.built,
      grt = EXCLUDED.grt, class_society = EXCLUDED.class_society, status = EXCLUDED.status, real = EXCLUDED.real, payload = EXCLUDED.payload, updated_at = now()`,
    [String(e.id), e.imo ?? '', e.name ?? '', e.type ?? '', e.flag ?? '', Number(e.built) || 0, Number(e.grt) || 0, e.classSociety ?? '', e.status ?? 'ACTIVE', !!e.real, json(e)]);
}
export async function upsertCertificate(c: Queryable, e: Row) {
  await c.query(`INSERT INTO vessel_certificates(id, vessel_id, cert_type, issue_date, expiry_date, state, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7)
    ON CONFLICT (id) DO UPDATE SET vessel_id = EXCLUDED.vessel_id, cert_type = EXCLUDED.cert_type, issue_date = EXCLUDED.issue_date,
      expiry_date = EXCLUDED.expiry_date, state = EXCLUDED.state, payload = EXCLUDED.payload, updated_at = now()`,
    [String(e.id), String(e.vesselId ?? ''), e.certType ?? '', d(e.issueDate), d(e.expiryDate), e.state ?? (e.inForce === false ? 'EXPIRED' : 'VALID'), json(e)]);
}
export async function upsertInspection(c: Queryable, e: Row) {
  await c.query(`INSERT INTO inspections(id, number, vessel_id, type, status, result, detention, planned_at, started_at, closed_at, findings, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
    ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, vessel_id = EXCLUDED.vessel_id, type = EXCLUDED.type, status = EXCLUDED.status,
      result = EXCLUDED.result, detention = EXCLUDED.detention, planned_at = EXCLUDED.planned_at, started_at = EXCLUDED.started_at,
      closed_at = EXCLUDED.closed_at, findings = EXCLUDED.findings, payload = EXCLUDED.payload, updated_at = now()`,
    [String(e.id), e.number ?? '', String(e.vesselId ?? ''), e.type ?? '', e.status ?? '', e.result ?? '', !!e.detention,
      d(e.plannedAt), d(e.startedAt), d(e.closedAt), JSON.stringify(e.findings ?? []), json(e)]);
}
export async function upsertInstrument(c: Queryable, e: Row) {
  await c.query(`INSERT INTO instruments(id, licence_no, entity_type, subject_kind, subject_id, subject_label, status, issue_date, expiry_date, in_force, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (id) DO UPDATE SET licence_no = EXCLUDED.licence_no, entity_type = EXCLUDED.entity_type, subject_kind = EXCLUDED.subject_kind,
      subject_id = EXCLUDED.subject_id, subject_label = EXCLUDED.subject_label, status = EXCLUDED.status, issue_date = EXCLUDED.issue_date,
      expiry_date = EXCLUDED.expiry_date, in_force = EXCLUDED.in_force, payload = EXCLUDED.payload, updated_at = now()`,
    [String(e.id), e.number ?? e.licenseNo ?? '', e.entityType ?? '', e.subjectKind ?? '', String(e.subjectId ?? ''), e.entityName ?? e.subjectLabel ?? '',
      e.status ?? '', d(e.issueDate), d(e.expiryDate), e.inForce ?? true, json(e)]);
}
export async function upsertIncident(c: Queryable, e: Row) {
  await c.query(`INSERT INTO incidents(id, number, title, type, severity, status, vessel_id, reported_at, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, title = EXCLUDED.title, type = EXCLUDED.type, severity = EXCLUDED.severity,
      status = EXCLUDED.status, vessel_id = EXCLUDED.vessel_id, reported_at = EXCLUDED.reported_at, payload = EXCLUDED.payload, updated_at = now()`,
    [String(e.id), e.number ?? '', e.title ?? '', e.type ?? '', e.severity ?? '', e.status ?? '', e.vesselId ? String(e.vesselId) : null, d(e.reportedAt), json(e)]);
}
export async function upsertInvoice(c: Queryable, e: Row) {
  await c.query(`INSERT INTO invoices(id, number, party, vessel_id, total, status, issued_at, due_at, paid_at, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, party = EXCLUDED.party, vessel_id = EXCLUDED.vessel_id, total = EXCLUDED.total,
      status = EXCLUDED.status, issued_at = EXCLUDED.issued_at, due_at = EXCLUDED.due_at, paid_at = EXCLUDED.paid_at, payload = EXCLUDED.payload, updated_at = now()`,
    [String(e.id), e.number ?? '', e.billTo?.name ?? e.billToName ?? e.party ?? '', e.vesselId ? String(e.vesselId) : null, Math.round(Number(e.total) || 0),
      e.status ?? '', d(e.issuedAt), d(e.dueAt ?? e.dueDate), d(e.paidAt), json(e)]);
}
export async function upsertPortCall(c: Queryable, e: Row) {
  await c.query(`INSERT INTO port_calls(id, vcn, vessel_id, vessel_name, status, berth_code, eta, atb, atd, payload)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    ON CONFLICT (id) DO UPDATE SET vcn = EXCLUDED.vcn, vessel_id = EXCLUDED.vessel_id, vessel_name = EXCLUDED.vessel_name, status = EXCLUDED.status,
      berth_code = EXCLUDED.berth_code, eta = EXCLUDED.eta, atb = EXCLUDED.atb, atd = EXCLUDED.atd, payload = EXCLUDED.payload, updated_at = now()`,
    [String(e.id), e.vcn ?? '', String(e.vesselId ?? ''), e.vesselName ?? '', e.status ?? '', e.berthCode ?? '', d(e.eta), d(e.atb), d(e.atd), json(e)]);
}
export async function upsertServiceRequest(c: Queryable, e: Row) {
  await c.query(`INSERT INTO service_requests(id, request_no, service_id, service_code, service_name, applicant, subject_kind, subject_id, subject_label, status, current_stage, payload, submitted_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
    ON CONFLICT (id) DO UPDATE SET request_no = EXCLUDED.request_no, service_id = EXCLUDED.service_id, service_code = EXCLUDED.service_code,
      service_name = EXCLUDED.service_name, applicant = EXCLUDED.applicant, subject_kind = EXCLUDED.subject_kind, subject_id = EXCLUDED.subject_id,
      subject_label = EXCLUDED.subject_label, status = EXCLUDED.status, current_stage = EXCLUDED.current_stage, payload = EXCLUDED.payload,
      submitted_at = EXCLUDED.submitted_at, updated_at = now()`,
    [String(e.id), e.requestNo ?? '', String(e.serviceId ?? ''), e.serviceCode ?? '', e.serviceName ?? '', e.applicant?.name ?? e.applicantName ?? '',
      e.subjectKind ?? '', e.subjectId ? String(e.subjectId) : null, e.subjectLabel ?? '', e.status ?? '', e.currentStage ?? '', json(e), d(e.submittedAt)]);
}
export async function upsertServiceDefinition(c: Queryable, e: Row) {
  await c.query(`INSERT INTO service_definitions(id, code, name, payload) VALUES ($1,$2,$3,$4)
    ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, payload = EXCLUDED.payload, updated_at = now()`,
    [String(e.id), e.code ?? '', e.name ?? '', json(e)]);
}
export async function upsertLegalInstrument(c: Queryable, e: Row) {
  await c.query(`INSERT INTO legal_instruments(id, ref_no, title, type, status, payload) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (id) DO UPDATE SET ref_no = EXCLUDED.ref_no, title = EXCLUDED.title, type = EXCLUDED.type, status = EXCLUDED.status, payload = EXCLUDED.payload, updated_at = now()`,
    [String(e.id), e.refNo ?? '', e.title ?? '', e.type ?? '', e.status ?? '', json(e)]);
}

const UPSERTS: Record<string, (c: Queryable, e: Row) => Promise<void>> = {
  vessel: upsertVessel, vesselCertificate: upsertCertificate, inspection: upsertInspection, instrument: upsertInstrument,
  incident: upsertIncident, invoice: upsertInvoice, portCall: upsertPortCall,
  serviceRequest: upsertServiceRequest, serviceDefinition: upsertServiceDefinition, legalInstrument: upsertLegalInstrument,
};
const DELETE_TABLE: Record<string, string> = {
  vessel: 'vessels', vesselCertificate: 'vessel_certificates', inspection: 'inspections', instrument: 'instruments',
  incident: 'incidents', invoice: 'invoices', portCall: 'port_calls', serviceRequest: 'service_requests', legalInstrument: 'legal_instruments',
};

/** Applies a read-model event to the snapshots. Returns the kind it recognised, or null. */
export async function projectSnapshot(c: PoolClient, event: EventEnvelope): Promise<string | null> {
  const data = (event.data ?? {}) as Row;
  if (event.type === EVENTS.readModel.upserted) {
    const e: Row = data.entity ?? {};
    const fn = UPSERTS[data.kind];
    if (!fn || !e.id) return null;
    await fn(c, e);
    return data.kind;
  }
  if (event.type === EVENTS.readModel.deleted && DELETE_TABLE[data.kind] && data.id) {
    await c.query(`DELETE FROM ${DELETE_TABLE[data.kind]} WHERE id = $1`, [String(data.id)]);
    return null;
  }
  /* A submitted application never travels as a read model — the service engine owns it — so the request that
   * comes with the workflow event is folded into the snapshot the document and eligibility agents read. */
  if ((event.type === EVENTS.workflow.requestSubmitted || event.type === EVENTS.workflow.requestTransitioned || event.type === EVENTS.workflow.requestDocument) && (data.request ?? data.requestId)) {
    const e: Row = data.request ?? { id: data.requestId, requestNo: data.requestNo, status: data.status, currentStage: data.stage };
    if (!e.id) return null;
    await upsertServiceRequest(c, e);
    return 'serviceRequest';
  }
  return null;
}
