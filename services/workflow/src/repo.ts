/* Rows, API shapes and the few loaders every controller shares. */
import type { PoolClient } from 'pg';
import type { DefinitionEnvironment, DefinitionVersionStatus, RequestStatus } from '@maritime/contracts';
import { notFound, type Queryable } from '@maritime/service-kit';
import { parseContent, type DefinitionContent } from './schema';
import type { Applicant, Assignee, Fees, Payment, RequestDocument, RequestState, TimelineEntry } from './engine';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const ENV_ORDER: DefinitionEnvironment[] = ['DEV', 'UAT', 'PROD'];
export const nextEnvironment = (e: DefinitionEnvironment): DefinitionEnvironment | null => ENV_ORDER[ENV_ORDER.indexOf(e) + 1] ?? null;
export const previousEnvironment = (e: DefinitionEnvironment): DefinitionEnvironment | null => ENV_ORDER[ENV_ORDER.indexOf(e) - 1] ?? null;

export interface DefinitionRow { id: string; key: string; code: string; name: string; name_ar: string | null; category: string; category_ar: string | null; domain: number; subject_kind: string; description: string; description_ar: string | null; owner_module: string; issues_instrument: string | null; auto_approvable: boolean; current_version: number | null; status: string; created_by: string | null; created_at: Date; updated_at: Date }
export interface VersionRow { id: string; definition_id: string; version: number; environment: DefinitionEnvironment; status: DefinitionVersionStatus; form: DefinitionContent['form']; documents: DefinitionContent['documents']; fees: DefinitionContent['fees']; sla: DefinitionContent['sla']; workflow: DefinitionContent['workflow']; outputs: DefinitionContent['outputs']; change_note: string; created_by: string | null; submitted_by: string | null; approved_by: string | null; published_by: string | null; published_at: Date | null; retired_at: Date | null; promoted_from: string | null; created_at: Date; updated_at: Date }
export interface RequestRow { id: string; number: string; definition_id: string; definition_key: string; definition_name: string; definition_name_ar: string | null; definition_version: number; environment: string; category: string; domain: number; subject_kind: string; subject_id: string | null; subject_name: string; subject: Record<string, unknown>; applicant: Applicant; scope_company: string; status: RequestStatus; current_state: string; form_data: Record<string, unknown>; documents: RequestDocument[]; fees: Fees | Record<string, never>; payment: Payment | Record<string, never>; assignee: Assignee | null; checks: unknown[]; sla_due_at: Date | null; sla_breached: boolean; sla_breached_at: Date | null; submitted_at: Date | null; decided_at: Date | null; closed_at: Date | null; issued_instrument: Record<string, unknown> | null; timeline: TimelineEntry[]; created_by: string | null; created_at: Date; updated_at: Date }
export interface NoteRow { id: string; request_id: string; author: { id: string | null; name: string }; body: string; internal: boolean; created_at: Date }

export const definitionToApi = (r: DefinitionRow) => ({ id: r.id, key: r.key, code: r.code, name: r.name, nameAr: r.name_ar, category: r.category, categoryAr: r.category_ar, domain: r.domain, subjectKind: r.subject_kind, description: r.description, descriptionAr: r.description_ar, ownerModule: r.owner_module, issuesInstrument: r.issues_instrument, autoApprovable: r.auto_approvable, currentVersion: r.current_version, status: r.status, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at });
export const contentOf = (v: VersionRow): DefinitionContent => parseContent({ form: v.form, documents: v.documents, fees: v.fees, sla: v.sla, workflow: v.workflow, outputs: v.outputs });
export const versionToApi = (v: VersionRow, full = true) => ({ id: v.id, definitionId: v.definition_id, version: v.version, environment: v.environment, status: v.status, ...(full ? { form: v.form, documents: v.documents, fees: v.fees, sla: v.sla, workflow: v.workflow, outputs: v.outputs } : {}), changeNote: v.change_note, createdBy: v.created_by, submittedBy: v.submitted_by, approvedBy: v.approved_by, publishedBy: v.published_by, publishedAt: v.published_at, retiredAt: v.retired_at, promotedFrom: v.promoted_from, createdAt: v.created_at, updatedAt: v.updated_at });
export const noteToApi = (n: NoteRow) => ({ id: n.id, requestId: n.request_id, author: n.author, body: n.body, internal: n.internal, createdAt: n.created_at });
const iso = (d: Date | string | null | undefined) => (d == null ? null : new Date(d).toISOString());
const isOpen = (status: RequestStatus) => status === 'SUBMITTED' || status === 'UNDER_ASSESSMENT' || status === 'INFO_REQUESTED';

/** The engine's mutable view of a request; the API shape is the same object plus derived facts. */
export function requestFromRow(r: RequestRow): RequestState {
  return {
    id: r.id, number: r.number, definitionId: r.definition_id, definitionKey: r.definition_key, definitionName: r.definition_name, definitionNameAr: r.definition_name_ar, definitionVersion: r.definition_version, environment: r.environment, category: r.category, domain: r.domain,
    subjectKind: r.subject_kind, subjectId: r.subject_id, subjectName: r.subject_name, subject: r.subject ?? {}, applicant: r.applicant, status: r.status, currentState: r.current_state, formData: r.form_data ?? {}, documents: r.documents ?? [],
    fees: r.fees && 'lines' in r.fees ? (r.fees as Fees) : null, payment: r.payment && 'status' in r.payment ? (r.payment as Payment) : null, assignee: r.assignee, checks: r.checks ?? [],
    slaDueAt: iso(r.sla_due_at), slaBreached: r.sla_breached || (isOpen(r.status) && !!r.sla_due_at && r.sla_due_at.getTime() < Date.now()), slaBreachedAt: iso(r.sla_breached_at), submittedAt: iso(r.submitted_at), decidedAt: iso(r.decided_at), closedAt: iso(r.closed_at),
    issuedInstrument: r.issued_instrument, timeline: r.timeline ?? [], createdBy: r.created_by, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  };
}
export const requestToApi = (r: RequestRow) => requestFromRow(r);

export async function loadDefinition(q: Queryable, idOrKey: string): Promise<DefinitionRow> {
  const r = UUID_RE.test(idOrKey) ? await q.query<DefinitionRow>('SELECT * FROM service_definitions WHERE id = $1', [idOrKey]) : await q.query<DefinitionRow>('SELECT * FROM service_definitions WHERE key = $1 OR code = upper($1)', [idOrKey]);
  if (!r.rows[0]) throw notFound(`Service definition ${idOrKey} not found`);
  return r.rows[0];
}
/** A version in one environment; without an explicit environment the highest environment that holds the version wins. */
export async function loadVersion(q: Queryable, definitionId: string, version: number, environment?: DefinitionEnvironment | null, lock = false): Promise<VersionRow> {
  const forUpdate = lock ? ' FOR UPDATE' : '';
  const r = environment
    ? await q.query<VersionRow>(`SELECT * FROM service_definition_versions WHERE definition_id = $1 AND version = $2 AND environment = $3${forUpdate}`, [definitionId, version, environment])
    : await q.query<VersionRow>(`SELECT * FROM service_definition_versions WHERE definition_id = $1 AND version = $2 ORDER BY array_position(ARRAY['PROD','UAT','DEV'], environment)${forUpdate}`, [definitionId, version]);
  if (!r.rows[0]) throw notFound(`Version ${version}${environment ? ` (${environment})` : ''} not found`);
  return r.rows[0];
}
export async function loadPublished(q: Queryable, definitionId: string, environment: DefinitionEnvironment): Promise<VersionRow | null> {
  const r = await q.query<VersionRow>("SELECT * FROM service_definition_versions WHERE definition_id = $1 AND environment = $2 AND status = 'PUBLISHED' ORDER BY version DESC LIMIT 1", [definitionId, environment]);
  return r.rows[0] ?? null;
}
export async function loadRequest(q: Queryable, idOrNumber: string, lock = false): Promise<RequestRow> {
  const r = await q.query<RequestRow>(`SELECT * FROM service_requests WHERE ${UUID_RE.test(idOrNumber) ? 'id = $1' : 'number = upper($1)'}${lock ? ' FOR UPDATE' : ''}`, [idOrNumber]);
  if (!r.rows[0]) throw notFound('Request not found');
  return r.rows[0];
}
/** Writes back everything the engine may have changed. */
export async function saveRequest(c: PoolClient, s: RequestState): Promise<RequestRow> {
  const r = await c.query<RequestRow>(
    `UPDATE service_requests SET status = $2, current_state = $3, form_data = $4, documents = $5, fees = $6, payment = $7, assignee = $8, checks = $9, subject = $10, sla_due_at = $11, sla_breached = $12, sla_breached_at = $13,
       submitted_at = $14, decided_at = $15, closed_at = $16, issued_instrument = $17, timeline = $18, updated_at = now() WHERE id = $1 RETURNING *`,
    [s.id, s.status, s.currentState, JSON.stringify(s.formData), JSON.stringify(s.documents), JSON.stringify(s.fees ?? {}), JSON.stringify(s.payment ?? {}), s.assignee ? JSON.stringify(s.assignee) : null, JSON.stringify(s.checks), JSON.stringify(s.subject),
      s.slaDueAt, s.slaBreached, s.slaBreachedAt, s.submittedAt, s.decidedAt, s.closedAt, s.issuedInstrument ? JSON.stringify(s.issuedInstrument) : null, JSON.stringify(s.timeline)]);
  return r.rows[0];
}
