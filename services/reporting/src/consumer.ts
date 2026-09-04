import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, STREAM_PREFIX, type EventEnvelope } from '@maritime/contracts';
import { KIT_BUS, KIT_POOL, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';
import { certStatus } from './queries';

/** Read-model kinds and the upsert that projects each API-shaped entity into its table. */
type Row = Record<string, any>;
/** Upsert by id; when a natural key (vcn, number, code…) is given, a stale row holding that key under another id is replaced so re-seeds and renumbering never collide. */
const up = async (c: PoolClient, table: string, cols: Record<string, unknown>, natural?: string) => {
  if (natural && cols[natural] != null) await c.query(`DELETE FROM ${table} WHERE ${natural} = $1 AND id <> $2`, [cols[natural], cols.id]);
  const keys = Object.keys(cols); const vals = keys.map((k) => { const v = cols[k]; return v !== null && typeof v === 'object' && !(v instanceof Date) ? JSON.stringify(v) : v; });
  // nosemgrep: maritime-sql-template-interpolation — table and column names come from the projection map in this file
  await c.query(`INSERT INTO ${table}(${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) ON CONFLICT (id) DO UPDATE SET ${keys.filter((k) => k !== 'id').map((k) => `${k} = EXCLUDED.${k}`).join(', ')}, updated_at = now()`, vals);
};
/** The partition keys the publisher attached, as read-model columns. Absent means unpartitioned. */
const sc = (e: Row): Record<string, string> => ({ scope_company: String(e.scope?.company ?? '') });
const sp = (e: Row): Record<string, string> => ({ scope_port: String(e.scope?.port ?? '') });
const scp = (e: Row): Record<string, string> => ({ ...sc(e), ...sp(e) });

export const PROJECTIONS: Record<string, (c: PoolClient, e: Row) => Promise<void>> = {
  user: (c, e) => up(c, 'rm_users', { id: e.id, name: e.name, email: e.email, role_name: e.role?.name ?? e.roleName ?? null, designation: e.designation ?? null, department: e.department ?? null, phone: e.phone ?? null, active: e.active ?? true, last_login_at: e.lastLoginAt ?? null }),
  berth: (c, e) => up(c, 'rm_berths', { id: e.id, code: e.code, name: e.name, terminal: e.terminal, berth_type: e.berthType, loa_max: e.loaMax ?? null, draft_max: e.draftMax ?? null, status: e.status ?? 'OPERATIONAL', outages: e.outages ?? [], ...sp(e) }, 'code'),
  vessel: (c, e) => up(c, 'rm_vessels', { id: e.id, imo: e.imo, name: e.name, mmsi: e.mmsi ?? null, call_sign: e.callSign ?? null, flag: e.flag ?? null, type: e.type, built: e.built ?? null, dwt: e.dwt ?? null, grt: e.grt ?? null, loa: e.loa ?? null, beam: e.beam ?? null, max_draft: e.maxDraft ?? null, owner: e.owner ?? null, operator: e.operator ?? null, manager: e.manager ?? null, agent_code: e.agentCode ?? e.agent ?? null, agent_name: e.agentName ?? null, class_society: e.classSociety ?? null, teu_capacity: e.teuCapacity ?? null, liner: !!e.liner, real: !!e.real, status: e.status ?? 'ACTIVE', next_dry_dock: e.nextDryDock ?? null, registry_state: e.registry?.state ?? e.registryState ?? 'UNREGISTERED', registry: { ...(e.registry ?? {}), riskScore: e.riskScore ?? e.registry?.riskScore, riskBand: e.riskBand ?? e.registry?.riskBand }, ...sc(e) }, 'imo'),
  vesselCertificate: (c, e) => up(c, 'rm_vessel_certificates', { id: e.id, vessel_id: e.vesselId, cert_type: e.certType, number: e.number ?? null, issuer: e.issuer ?? null, issue_date: e.issueDate ?? null, expiry_date: e.expiryDate, on_register: !!e.onRegister, in_force: e.inForce ?? true, force_reason: e.forceReason ?? null, signed: !!e.signed, ...sc(e) }),
  portCall: (c, e) => { const ops: Row[] = e.cargoOps ?? []; return up(c, 'rm_port_calls', { id: e.id, vcn: e.vcn, vessel_id: e.vesselId, vessel_name: e.vesselName, vessel_type: e.vesselType ?? null, agent_code: e.agentCode ?? null, agent_name: e.agentName ?? null, status: e.status, eta: e.eta, etb: e.etb ?? null, etd: e.etd ?? null, ata: e.ata ?? null, atb: e.atb ?? null, atd: e.atd ?? null, berth_id: e.berthId ?? null, berth_code: e.berthCode ?? null, prev_port: e.prevPort ?? null, next_port: e.nextPort ?? null, cargo_ops: ops, cargo_mt: ops.reduce((s, o) => s + Number(o.qtyMT || 0), 0), teu: ops.filter((o) => o.unit === 'TEU').reduce((s, o) => s + Number(o.qty || 0), 0), ...scp(e) }, 'vcn'); },
  invoice: (c, e) => up(c, 'rm_invoices', { id: e.id, number: e.number, port_call_id: e.portCallId ?? null, vessel_id: e.vesselId ?? null, vessel_name: e.vesselName ?? null, bill_to_name: e.billTo?.name ?? e.billToName ?? null, subtotal: e.subtotal ?? 0, tax_amount: e.taxAmount ?? 0, total: e.total ?? 0, currency: e.currency ?? 'AED', status: e.status, issued_at: e.issuedAt ?? null, paid_at: e.paidAt ?? null, created_at: e.createdAt ?? new Date(), ...sc(e) }, 'number'),
  inspection: (c, e) => { const f: Row[] = e.findings ?? []; return up(c, 'rm_inspections', { id: e.id, number: e.number, vessel_id: e.vesselId ?? null, vessel_name: e.vesselName ?? null, type: e.type, inspector: e.inspector ?? null, status: e.status, result: e.result || null, detention: !!e.detention, planned_at: e.plannedAt ?? null, started_at: e.startedAt ?? null, closed_at: e.closedAt ?? null, open_findings: e.openFindings ?? f.filter((x) => x.status === 'OPEN').length, total_findings: e.totalFindings ?? f.length, score_pct: e.scorePct ?? null, ...sp(e) }, 'number'); },
  incident: (c, e) => up(c, 'rm_incidents', { id: e.id, number: e.number, title: e.title, category: e.category ?? null, type: e.type, severity: e.severity, priority: e.priority ?? null, status: e.status, vessel_id: e.vesselId ?? null, vessel_name: e.vesselName ?? null, assigned_to_name: (typeof e.assignedTo === 'string' ? e.assignedTo : e.assignedTo?.name) ?? e.assignedToName ?? null, reported_at: e.reportedAt, acknowledged_at: e.acknowledgedAt ?? null, resolved_at: e.resolvedAt ?? null, closed_at: e.closedAt ?? null, ...sp(e) }, 'number'),
  seafarer: (c, e) => { const certs: Row[] = e.certificates ?? []; const svc: Row[] = e.seaService ?? []; return up(c, 'rm_seafarers', { id: e.id, name: e.name, rank: e.rank, cdc_no: e.cdcNo, seafarer_id_no: e.seafarerIdNo ?? e.seafarerId ?? e.indosNo ?? null, nationality: e.nationality ?? null, phone: e.phone ?? null, status: e.status ?? 'ACTIVE', current_vessel_id: e.currentVesselId ?? null, current_vessel_name: e.currentVesselName ?? null, cert_alerts: e.certAlerts ?? certs.filter((x) => certStatus(x.expiryDate) !== 'VALID').length, sea_service_days: e.seaServiceDays ?? Math.round(svc.reduce((s, x) => s + (new Date(x.to).getTime() - new Date(x.from).getTime()) / 86400000, 0)), service_records: e.serviceRecords ?? svc.length }); },
  company: (c, e) => up(c, 'rm_companies', { id: e.id, code: e.code, name: e.name, category: e.category ?? null, status: e.status ?? 'ACTIVE', address: e.address ?? null, tax_id: e.taxId ?? e.gstin ?? null, ...sc(e) }, 'code'),
  instrument: (c, e) => up(c, 'rm_instruments', { id: e.id, number: e.number ?? e.licenseNo, subject_kind: e.subjectKind ?? 'COMPANY', subject_id: e.subjectId ?? null, entity_name: e.entityName, entity_type: e.entityType, instrument_class: e.instrumentClass ?? 'LICENCE', status: e.status, applied_date: e.appliedDate ?? null, issue_date: e.issueDate ?? null, expiry_date: e.expiryDate ?? null, statutory: !!e.statutory, in_force: e.inForce ?? true, signed: !!(e.signed ?? e.signature?.value), performance_rating: e.performanceRating ?? null, audits: e.audits?.length ?? e.auditsCount ?? 0, ...sc(e) }, 'number'),
  legalInstrument: (c, e) => up(c, 'rm_legal_instruments', { id: e.id, ref_no: e.refNo, title: e.title, type: e.type, status: e.status, issued_date: e.issuedDate ?? null, ack_required: !!e.ackRequired, acknowledged_by: e.acknowledgedBy ?? [] }, 'ref_no'),
  registration: (c, e) => up(c, 'rm_registrations', { id: e.id, number: e.number ?? e.applicationNo, vessel_id: e.vesselId ?? null, vessel_name: e.vesselName ?? null, kind: e.kind, status: e.status, submitted_at: e.submittedAt ?? null, closed_at: e.closedAt ?? null, due_at: e.dueAt ?? null, ...sc(e) }, 'number'),
  tariff: (c, e) => up(c, 'rm_tariffs', { id: e.id, code: e.code, name: e.name, category: e.category ?? 'MARINE', unit: e.unit, rate: e.rate, active: e.active ?? true, revisions: e.revisions ?? [] }, 'code'),
  resource: (c, e) => up(c, 'rm_resources', { id: e.id, code: e.code, name: e.name, type: e.type, status: e.status ?? 'AVAILABLE', jobs: e.jobs ?? [], outages: e.outages ?? [], ...sp(e) }, 'code'),
  checklistTemplate: (c, e) => up(c, 'rm_checklists', { id: e.id, name: e.name, inspection_type: e.inspectionType, items: e.items?.length ?? e.itemCount ?? 0, active: e.active ?? true }),
  agentDecision: (c, e) => up(c, 'rm_agent_decisions', { id: e.id, agent_id: e.agentId, disposition: e.disposition, confidence: e.confidence ?? null, review_status: e.reviewStatus ?? e.review?.status ?? (e.reviewedAt ? 'REVIEWED' : e.disposition === 'ESCALATED' ? 'PENDING' : 'AUTO'), at: e.at ?? e.createdAt ?? new Date(), entity_type: e.entityType ?? null, entity_id: e.entityId ?? null }),
};
const TABLES: Record<string, string> = { user: 'rm_users', berth: 'rm_berths', vessel: 'rm_vessels', vesselCertificate: 'rm_vessel_certificates', portCall: 'rm_port_calls', invoice: 'rm_invoices', inspection: 'rm_inspections', incident: 'rm_incidents', seafarer: 'rm_seafarers', company: 'rm_companies', instrument: 'rm_instruments', legalInstrument: 'rm_legal_instruments', registration: 'rm_registrations', tariff: 'rm_tariffs', resource: 'rm_resources', checklistTemplate: 'rm_checklists', agentDecision: 'rm_agent_decisions' };

/** Applies one event to the read models. Exported so the seed and the tests can drive it without a bus. */
export async function project(c: PoolClient, event: EventEnvelope): Promise<void> {
  const d = (event.data ?? {}) as Row;
  if (event.type === EVENTS.readModel.upserted && PROJECTIONS[d.kind]) { await PROJECTIONS[d.kind](c, d.entity ?? {}); return; }
  if (event.type === EVENTS.readModel.deleted && TABLES[d.kind]) { await c.query(`DELETE FROM ${TABLES[d.kind]} WHERE id = $1`, [d.id]); return; }
  if (event.type === EVENTS.audit.recorded) {
    await c.query('INSERT INTO rm_audit_activity(id, at, actor_id, actor_name, action, entity, entity_label, service) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO NOTHING', [event.id, d.at ?? event.time, d.actor?.id ?? null, d.actor?.name ?? null, d.action, d.entity, d.entityLabel ?? null, d.service ?? event.source]);
    return;
  }
  if (event.type === EVENTS.identity.userChanged && d.user) { await PROJECTIONS.user(c, d.user); return; }
  if (event.type === EVENTS.mdm.companyUpserted && d.company) { await PROJECTIONS.company(c, d.company); return; }
  if (event.type === EVENTS.mdm.lookupChanged && d.category) { await c.query('INSERT INTO rm_lookup_counts(category, entries) VALUES ($1, $2) ON CONFLICT (category) DO UPDATE SET entries = EXCLUDED.entries, updated_at = now()', [d.category, d.count ?? 0]); }
}

@Injectable()
export class ReadModelConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('reporting-readmodels', [`${STREAM_PREFIX}.>`], (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) { await withInbox(this.pool, event, (c) => project(c, event)); }
}
