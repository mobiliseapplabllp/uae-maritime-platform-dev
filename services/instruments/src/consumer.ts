import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, SUBJECT_KINDS, instrumentClassOf, makeEvent, subjectFor, typeAllowedFor, type EventEnvelope, type SubjectKind } from '@maritime/contracts';
import { KIT_BUS, KIT_ENV, KIT_POOL, AuditClient, badRequest, enqueue, withInbox, type EventBus, type Subscription, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { SigningService } from './signing';
import { issue, insertLicence, nextLicenceNumber, publishState, toApi, issuerFor, type Row } from './licences';
import { projectSubjectEvent, resolveSubject, labelFor, MODEL_BY_KIND } from './subjects';
import { typeLabel } from './statutory';

export interface Deps { env: Env; signing: SigningService; audit: AuditClient }
/** What the workflow engine sends when an approved application is granted (workflow.request.issued), or what a service posts to /internal/instruments/issue. */
export interface ApplicationIssue {
  requestId?: string | null; requestNo?: string | null; definitionKey?: string; instrumentType: string; instrumentClass?: string | null; validityMonths?: number | null;
  subjectKind?: string | null; subjectId?: string | null; subjectName?: string | null; applicant?: { userId?: string | null; name?: string; email?: string; phone?: string; organisation?: string } | null;
  formData?: Record<string, unknown> | null; checks?: unknown; issuedBy?: { id?: string | null; name?: string } | null; submittedAt?: string | null;
}
const str = (v: unknown, fallback = '') => (typeof v === 'string' ? v : fallback);

/* An application granted by the service engine and an officer moving a register entry to ISSUED produce the same artefact: the same numbering series, the same checks recorded, the same signature. Idempotent on the request id, so a redelivered event cannot issue twice. */
export async function issueFromApplication(c: Queryable, deps: Deps, d: ApplicationIssue): Promise<{ row: Row; created: boolean }> {
  if (d.requestId) { const dup = await c.query<Row>('SELECT * FROM licences WHERE request_id = $1', [String(d.requestId)]); if (dup.rows[0]) return { row: dup.rows[0], created: false }; }
  const kind = (SUBJECT_KINDS as readonly string[]).includes(String(d.subjectKind)) ? (d.subjectKind as SubjectKind) : 'COMPANY';
  const type = String(d.instrumentType ?? '').toUpperCase(); if (!type || !typeAllowedFor(kind, type)) throw badRequest(`${type || 'The requested instrument'} is not an instrument type issued to a ${kind.toLowerCase().replace('_', ' ')}`);
  const subject = await resolveSubject(c, kind, d.subjectId ?? null); const form = d.formData ?? {}; const applicant = d.applicant ?? {};
  const entityName = labelFor(kind, subject) || str(d.subjectName) || str(form.entityName) || str(applicant.organisation) || str(applicant.name);
  if (!entityName) throw badRequest('Either a subject on the register or an applicant name is required to issue');
  const now = new Date(); const by = str(d.issuedBy?.name, 'Service engine'); const applied = d.submittedAt ? new Date(d.submittedAt) : now; const ref = d.requestNo ? `application ${d.requestNo}` : 'an approved application';
  const row = await insertLicence(c, { licenseNo: await nextLicenceNumber(c, type, now), subjectKind: kind, subjectId: d.subjectId ? String(d.subjectId) : null, subjectModel: d.subjectId ? MODEL_BY_KIND[kind] : null, instrumentClass: (d.instrumentClass as never) || instrumentClassOf(type), entityName, entityType: type, status: 'UNDER_REVIEW',
    contactPerson: str(form.contactPerson, str(applicant.name)), phone: str(form.phone, str(applicant.phone)), email: str(form.email, str(applicant.email)), address: str(form.address), taxId: str(form.taxId, str(form.gstin)), conditions: str(form.conditions), appliedDate: applied, issuer: issuerFor(deps.env.JURISDICTION), requestId: d.requestId ? String(d.requestId) : null, requestNo: d.requestNo ? String(d.requestNo) : null,
    history: [{ from: '', to: 'APPLIED', at: applied.toISOString(), by: str(applicant.name, 'Applicant'), note: `${ref[0].toUpperCase()}${ref.slice(1)} received` }, { from: 'APPLIED', to: 'UNDER_REVIEW', at: now.toISOString(), by: 'Service engine', note: 'Assessed under the service workflow' }] });
  const { row: issued } = await issue(c, deps, row, { now, by, note: `Issued under ${ref}`, authority: 'APPLICATION', applicationRef: ref, validityMonths: d.validityMonths ?? null });
  await deps.audit.record(c, { action: 'ISSUE', entity: 'License', entityId: issued.id, entityLabel: issued.license_no, after: toApi(issued), note: `Issued under ${ref}`, actor: { id: str(d.issuedBy?.id, 'workflow'), name: by, kind: d.issuedBy?.id ? 'user' : 'system' } });
  return { row: issued, created: true };
}

/** Expiry reminders: the scheduler's sweep asks once a day; each issued instrument inside the window is announced once a week until it is renewed. */
export async function remindExpiring(c: Queryable, env: Env, cause: EventEnvelope, days: number): Promise<number> {
  const rows = await c.query<Row>(`SELECT * FROM licences WHERE status = 'ISSUED' AND expiry_date IS NOT NULL AND expiry_date BETWEEN now() AND now() + ($1 || ' days')::interval AND (reminded_at IS NULL OR reminded_at < now() - interval '7 days') ORDER BY expiry_date LIMIT 500`, [String(days)]);
  const now = Date.now();
  for (const r of rows.rows) {
    await enqueue(c, makeEvent({ type: EVENTS.instruments.expiring, source: env.SERVICE_NAME, subject: r.id, correlationId: cause.correlationid, causationId: cause.id, data: { instrumentId: r.id, number: r.license_no, entityName: r.entity_name, entityType: r.entity_type, typeLabel: typeLabel(r.entity_type), subjectKind: r.subject_kind, subjectId: r.subject_id, expiryDate: r.expiry_date, daysLeft: Math.ceil((r.expiry_date!.getTime() - now) / 86400000), contactEmail: r.email } }));
    await c.query('UPDATE licences SET reminded_at = now() WHERE id = $1', [r.id]);
  }
  return rows.rowCount ?? 0;
}

export async function applyEvent(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<void> {
  const d = (event.data ?? {}) as Record<string, any>;
  if (event.type === EVENTS.workflow.requestIssued) {
    const { row, created } = await issueFromApplication(c, deps, d as ApplicationIssue);
    if (created) await publishState(c, deps.env, row, { event: EVENTS.instruments.issued, cause: event, data: { by: d.issuedBy ?? null } });
    return;
  }
  if (event.type === EVENTS.scheduler.remindersLicences) { await remindExpiring(c, deps.env, event, Number(d.days) > 0 ? Number(d.days) : deps.env.EXPIRY_REMINDER_DAYS); return; }
  await projectSubjectEvent(c, event);
}
export const SUBJECTS = [subjectFor(EVENTS.readModel.upserted), subjectFor(EVENTS.readModel.deleted), subjectFor(EVENTS.mdm.companyUpserted), subjectFor(EVENTS.mdm.vesselUpserted), subjectFor(EVENTS.workflow.requestIssued), subjectFor(EVENTS.scheduler.remindersLicences)];

@Injectable()
export class InstrumentsConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly signing: SigningService, private readonly audit: AuditClient) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('instruments-consumer', SUBJECTS, (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) { await withInbox(this.pool, event, (c) => applyEvent(c, { env: this.env, signing: this.signing, audit: this.audit }, event)); }
}
