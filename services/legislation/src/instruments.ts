import { EVENTS, INSTRUMENT_STATUS, INSTRUMENT_TRANSITIONS, INSTRUMENT_TYPES, makeEvent, type Actor, type EventEnvelope } from '@maritime/contracts';
import { createHash } from 'node:crypto';
import { enqueue, eventFromContext, lookupByCode, nextNumber, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';

/* The legal-instrument register and the governance that moves an instrument through it.
 *
 * Two rules are the whole point of this module and are kept as pure functions so they can be tested
 * without a database and cannot be sidestepped by a different caller:
 *
 *   1. an instrument's life runs one way — a draft is put in force, an in-force instrument is
 *      superseded or withdrawn, and neither of those two is ever anything again;
 *   2. the person who drafted an instrument may not be the person who puts it in force. That is a
 *      rule about people rather than about permissions, so holding `legislation.approve` is
 *      necessary but not sufficient — which is exactly the separation being asked for.
 *
 * Review and legal clearance sit between drafting and approval. Neither is a status of its own: an
 * instrument in review is still a draft, and the register would be lying if it said otherwise. They
 * are recorded on the instrument and reported as a chain so the desk can see where a draft stands.
 */

export type Row = Record<string, any>;
export const D = 86_400_000;
export const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());
export const dateOnly = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString().slice(0, 10));

export const LEGAL_INSTRUMENT_TYPES = INSTRUMENT_TYPES;
export const LEGAL_INSTRUMENT_STATUS = INSTRUMENT_STATUS;
export const ACK_CLASSES = ['ALL_STAFF', 'ROLE', 'DEPARTMENT'] as const;
export type AckClass = (typeof ACK_CLASSES)[number];
/** Link kinds, each with the name the other side of the link is read back under. */
export const LINK_KINDS = ['AMENDS', 'SUPERSEDES', 'REFERS_TO', 'IMPLEMENTS', 'REVOKES'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
export const INVERSE_LINK: Record<string, string> = { AMENDS: 'AMENDED_BY', SUPERSEDES: 'SUPERSEDED_BY', REFERS_TO: 'REFERRED_TO_BY', IMPLEMENTS: 'IMPLEMENTED_BY', REVOKES: 'REVOKED_BY', CONSOLIDATES: 'CONSOLIDATED_BY' };
/** The name a link reads under from the receiving end. Kinds the master adds later get the regular form. */
export const inverseLink = (kind: string) => INVERSE_LINK[kind] ?? `${kind}_BY`;
/** Reference-number prefixes the register allocates when a drafter does not bring one of their own. */
export const REF_PREFIX: Record<string, string> = { ACT: 'ACT', RULES: 'RULES', CIRCULAR: 'CIRC', NOTICE: 'NOTICE', ORDER: 'ORD', CONVENTION: 'CONV' };

export interface InstrumentRow {
  id: string; ref_no: string; title: string; title_ar: string | null; type: string; category: string; status: string; issued_by: string;
  issued_date: Date; effective_date: Date | null; expiry_date: Date | null; summary: string; body: string; tags: string[]; attachments: Attachment[];
  supersedes: string; superseded_by: string; ack_required: boolean; ack_class: string; ack_class_value: string; ack_due_days: number | null;
  drafted_by_id: string | null; drafted_by: string; reviewed_by_id: string | null; reviewed_by: string; reviewed_at: Date | null; review_note: string;
  cleared_by_id: string | null; cleared_by: string; cleared_at: Date | null; clearance_note: string;
  approved_by_id: string | null; approved_by: string; approved_at: Date | null;
  withdrawn_by_id: string | null; withdrawn_by: string; withdrawn_at: Date | null; withdrawal_reason: string;
  source_note: string; public_slug: string | null; content_hash: string; published_at: Date | null; public: boolean; created_at: Date; updated_at: Date;
}
export interface AckRow { id: string; instrument_id: string; user_id: string; name: string; role_name: string; note: string; at: Date }
export interface LinkRow { id: string; from_id: string; to_id: string | null; from_ref: string; to_ref: string; kind: string; note: string; by_id: string | null; by: string; at: Date }
export interface Attachment { id: string; name: string; kind: string; documentId?: string | null; url?: string | null; sizeBytes?: number | null; addedAt: string; addedBy?: string }

/* -------------------------------------------------------------------------- API shapes --- */

export const ackApi = (a: AckRow) => ({ userId: a.user_id, name: a.name, roleName: a.role_name, note: a.note, at: iso(a.at)! });
export type AckApi = ReturnType<typeof ackApi>;
/** A link as the instrument that owns it sees it; `direction` says whether this instrument made the link or is on the receiving end. */
export const linkApi = (l: LinkRow, selfId: string) => {
  const outgoing = l.from_id === selfId;
  return {
    id: l.id, kind: outgoing ? l.kind : inverseLink(l.kind), direction: outgoing ? 'OUTGOING' : 'INCOMING',
    instrumentId: outgoing ? l.to_id : l.from_id, refNo: outgoing ? l.to_ref : l.from_ref, note: l.note, by: l.by, at: iso(l.at)!,
  };
};
export type LinkApi = ReturnType<typeof linkApi>;

export interface InstrumentExtras { acknowledgedBy?: AckApi[]; links?: LinkApi[]; outstanding?: number | null; recipients?: number | null }
/** The instrument as every screen, every export and every read-model event sees it. */
export function instrumentApi(i: InstrumentRow, extra: InstrumentExtras = {}) {
  const acknowledgedBy = extra.acknowledgedBy ?? [];
  const links = extra.links ?? [];
  return {
    id: i.id, refNo: i.ref_no, title: i.title, titleAr: i.title_ar, type: i.type, category: i.category, status: i.status,
    issuedBy: i.issued_by, issuedDate: iso(i.issued_date)!, effectiveDate: iso(i.effective_date), expiryDate: iso(i.expiry_date),
    summary: i.summary, body: i.body, tags: i.tags ?? [], attachments: i.attachments ?? [],
    supersedes: i.supersedes, supersededBy: i.superseded_by,
    ackRequired: i.ack_required, ackClass: i.ack_class, ackClassValue: i.ack_class_value, ackClassLabel: ackClassLabel(i.ack_class, i.ack_class_value),
    ackDueDays: i.ack_due_days, acknowledgedBy, acknowledgements: acknowledgedBy.length,
    recipients: extra.recipients ?? null, outstanding: extra.outstanding ?? null,
    draftedById: i.drafted_by_id, draftedBy: i.drafted_by,
    reviewedById: i.reviewed_by_id, reviewedBy: i.reviewed_by, reviewedAt: iso(i.reviewed_at), reviewNote: i.review_note,
    clearedById: i.cleared_by_id, clearedBy: i.cleared_by, clearedAt: iso(i.cleared_at), clearanceNote: i.clearance_note,
    approvedById: i.approved_by_id, approvedBy: i.approved_by, approvedAt: iso(i.approved_at),
    withdrawnById: i.withdrawn_by_id, withdrawnBy: i.withdrawn_by, withdrawnAt: iso(i.withdrawn_at), withdrawalReason: i.withdrawal_reason,
    sourceNote: i.source_note, links, year: new Date(i.issued_date).getUTCFullYear(), public: i.public !== false, publishedAt: iso(i.published_at), contentHash: i.content_hash || '', slug: i.public_slug || '',
    inForce: i.status === 'IN_FORCE' && !expired(i), expired: expired(i), governance: governanceOf(i),
    createdAt: iso(i.created_at), updatedAt: iso(i.updated_at),
  };
}
export type InstrumentApi = ReturnType<typeof instrumentApi>;

export const ackClassLabel = (cls: string, value: string) => (cls === 'ROLE' ? `Role: ${value}` : cls === 'DEPARTMENT' ? `Department: ${value}` : 'All staff');
/** An in-force instrument with an expiry date behind it has lapsed on its own terms; it is not withdrawn, it simply no longer bites. */
export const expired = (i: Pick<InstrumentRow, 'expiry_date'>, now = new Date()) => !!i.expiry_date && new Date(i.expiry_date).getTime() < now.getTime();

/** Where a draft stands on the way to being put in force, as the register reports it. */
export function governanceOf(i: InstrumentRow) {
  const steps = [
    { step: 'DRAFTED', done: !!i.drafted_by_id, by: i.drafted_by, at: iso(i.created_at) },
    { step: 'REVIEWED', done: !!i.reviewed_at, by: i.reviewed_by, at: iso(i.reviewed_at), note: i.review_note },
    { step: 'CLEARED', done: !!i.cleared_at, by: i.cleared_by, at: iso(i.cleared_at), note: i.clearance_note },
    { step: 'IN_FORCE', done: !!i.approved_at, by: i.approved_by, at: iso(i.approved_at) },
  ];
  const stage = i.status !== 'DRAFT' ? 'COMPLETE' : (steps.find((s) => !s.done)?.step ?? 'IN_FORCE');
  return { stage, steps, reviewed: !!i.reviewed_at, cleared: !!i.cleared_at, approved: !!i.approved_at };
}

/* -------------------------------------------------------------------------- governance --- */

export type Verdict = { ok: true } | { ok: false; error: string };
const label = (s: string) => String(s || '').replace(/_/g, ' ').toLowerCase();

/** Whether an instrument may move from one status to another, per the declared transition table. */
export function canTransition(from: string, to: string): Verdict {
  const allowed = (INSTRUMENT_TRANSITIONS as Record<string, string[]>)[from];
  if (!allowed) return { ok: false, error: `Unknown instrument status "${from}"` };
  if (from === to) return { ok: false, error: `The instrument is already ${label(to)}` };
  if (!allowed.includes(to)) {
    return allowed.length
      ? { ok: false, error: `A ${label(from)} instrument cannot become ${label(to)}` }
      : { ok: false, error: `A ${label(from)} instrument is final and cannot be changed` };
  }
  return { ok: true };
}

/** Whether this person may put this instrument in force: the lifecycle allows it, a drafter is on record, and it is not them. */
export function canApprove(i: Pick<InstrumentRow, 'status' | 'drafted_by_id'>, approverId: string | null | undefined): Verdict {
  const move = canTransition(i.status, 'IN_FORCE');
  if (!move.ok) return move;
  const drafter = String(i.drafted_by_id ?? '');
  if (!drafter) return { ok: false, error: 'The instrument records no drafter, so separation of duties cannot be established' };
  if (drafter === String(approverId ?? '')) return { ok: false, error: 'An instrument cannot be approved by the person who drafted it' };
  return { ok: true };
}

/** Whether an acknowledgement may be recorded against this instrument at all. */
export function canAcknowledge(i: Pick<InstrumentRow, 'status' | 'ack_required'>): Verdict {
  if (!i.ack_required) return { ok: false, error: 'This instrument does not require acknowledgement' };
  if (i.status !== 'IN_FORCE') return { ok: false, error: 'Only an instrument in force can be acknowledged' };
  return { ok: true };
}

/** Supersession replaces one instrument with another: the successor must be in force, and never itself. */
export function canSupersede(target: Pick<InstrumentRow, 'id' | 'status'>, successor: Pick<InstrumentRow, 'id' | 'status' | 'ref_no'>): Verdict {
  if (target.id === successor.id) return { ok: false, error: 'An instrument cannot supersede itself' };
  const move = canTransition(target.status, 'SUPERSEDED');
  if (!move.ok) return move;
  if (successor.status === 'WITHDRAWN' || successor.status === 'SUPERSEDED') return { ok: false, error: `${successor.ref_no} is ${label(successor.status)} and cannot supersede another instrument` };
  return { ok: true };
}

/** The SQL predicate matching the recipient class of an instrument against the local staff roll. */
export function recipientWhere(cls: string, value: string): { sql: string; args: unknown[] } {
  if (cls === 'ROLE') return { sql: 'active AND lower(role_name) = lower($1)', args: [value] };
  if (cls === 'DEPARTMENT') return { sql: 'active AND lower(department) = lower($1)', args: [value] };
  return { sql: 'active', args: [] };
}

/** `CIRC-14/2026` — one atomic series per type per calendar year, so two drafters never collide. */
/** The series a type is numbered in: the legalInstrumentType master's prefix, with the register's own table behind it for a master that carries none. */
export async function refPrefixOf(c: Queryable, type: string): Promise<string> {
  const entry = await lookupByCode(c, 'legalInstrumentType', type);
  const fromMaster = String(entry?.meta?.refPrefix ?? '').trim();
  return fromMaster || REF_PREFIX[type] || 'INST';
}
export async function allocateRefNo(c: Queryable, type: string, year: number, pad = 2): Promise<string> {
  const prefix = await refPrefixOf(c, type);
  return `${prefix}-${await nextNumber(c, `${prefix}-${year}`, '', pad)}/${year}`;
}

/** Keeps the portal's columns current on every write: the slug is the reference, the hash names the text, the publication date is the first day the instrument stopped being a draft. */
export async function stampPublic(c: Queryable, i: InstrumentRow): Promise<InstrumentRow> {
  const attachments = (i.attachments ?? []).filter((a) => a.url).map((a) => `${a.name}|${a.url}`);
  const payload = JSON.stringify([i.ref_no, i.title, i.title_ar ?? '', i.type, i.category, i.status, dateOnly(i.issued_date), dateOnly(i.effective_date), dateOnly(i.expiry_date), i.summary, i.body, i.supersedes, i.superseded_by, attachments]);
  const hash = createHash('sha256').update(payload).digest('hex').slice(0, 32);
  const slug = i.ref_no.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  const r = await c.query<InstrumentRow>(`UPDATE legal_instruments SET public_slug = $2, content_hash = $3, published_at = CASE WHEN status <> 'DRAFT' THEN COALESCE(published_at, approved_at, effective_date, issued_date) ELSE NULL END WHERE id = $1 RETURNING *`, [i.id, slug, hash]);
  return r.rows[0] ?? i;
}

/* -------------------------------------------------------------------------- publishing --- */

/** The read-model shape reporting projects under the `legalInstrument` kind. */
export const readModelOf = (entity: InstrumentApi) => ({
  id: entity.id, refNo: entity.refNo, title: entity.title, titleAr: entity.titleAr, type: entity.type, status: entity.status,
  issuedDate: entity.issuedDate, ackRequired: entity.ackRequired, acknowledgedBy: entity.acknowledgedBy,
});

export interface PublishOptions { event?: string; data?: Row; cause?: EventEnvelope; actor?: Actor }
/** Every write publishes the read-model snapshot first, then the business event that explains it. */
export async function publishInstrument(c: Queryable, env: Env, i: InstrumentRow, extra: InstrumentExtras, opts: PublishOptions = {}): Promise<InstrumentApi> {
  const entity = instrumentApi(i, extra);
  const mk = <T,>(type: string, data: T) => (opts.cause
    ? makeEvent({ type, source: env.SERVICE_NAME, data, subject: i.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor })
    : eventFromContext(env.SERVICE_NAME, type, data, { subject: i.id, actor: opts.actor }));
  await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'legalInstrument', entity: readModelOf(entity) }));
  if (opts.event) {
    await enqueue(c, mk(opts.event, {
      instrumentId: i.id, refNo: i.ref_no, title: i.title, type: i.type, category: i.category, status: i.status,
      issuedDate: iso(i.issued_date), effectiveDate: iso(i.effective_date), ackRequired: i.ack_required,
      instrument: entity, ...(opts.data ?? {}),
    }));
  }
  return entity;
}
export async function publishInstrumentDeleted(c: Queryable, env: Env, i: InstrumentRow) {
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.deleted, { kind: 'legalInstrument', id: i.id }, { subject: i.id }));
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.legislation.instrumentDeleted, { instrumentId: i.id, refNo: i.ref_no, title: i.title, type: i.type }, { subject: i.id }));
}

/* --------------------------------------------------------------------------- dashboard --- */

export interface DashboardRow {
  id: string; ref_no: string; title: string; type: string; category: string; status: string; issued_date: Date;
  effective_date: Date | null; expiry_date: Date | null; ack_required: boolean; acks: number; recipients: number;
  reviewed_at: Date | null; cleared_at: Date | null; drafted_by: string;
}
/** The register dashboard: the shape of the library, where the drafts have got to, and what is still owed. */
export function registerDashboard(rows: DashboardRow[], now = new Date(), horizonDays = 60) {
  const horizon = now.getTime() + horizonDays * D;
  const inForce = rows.filter((r) => r.status === 'IN_FORCE');
  const drafts = rows.filter((r) => r.status === 'DRAFT');
  const ack = inForce.filter((r) => r.ack_required);
  const outstandingOf = (r: DashboardRow) => Math.max(0, Number(r.recipients ?? 0) - Number(r.acks ?? 0));
  const byKey = <T extends string>(list: DashboardRow[], key: (r: DashboardRow) => T) => {
    const m = new Map<T, DashboardRow[]>();
    for (const r of list) { const k = key(r); const cur = m.get(k); if (cur) cur.push(r); else m.set(k, [r]); }
    return m;
  };
  const types = [...byKey(rows, (r) => r.type as string)].map(([type, list]) => ({
    type, total: list.length, inForce: list.filter((r) => r.status === 'IN_FORCE').length, drafts: list.filter((r) => r.status === 'DRAFT').length,
  })).sort((a, b) => b.total - a.total || a.type.localeCompare(b.type));
  const subjects = [...byKey(rows, (r) => r.category as string)].map(([subject, list]) => ({
    subject, total: list.length, inForce: list.filter((r) => r.status === 'IN_FORCE').length,
  })).sort((a, b) => b.total - a.total || a.subject.localeCompare(b.subject));
  const years = [...byKey(rows, (r) => String(new Date(r.issued_date).getUTCFullYear()))].map(([year, list]) => ({ year: Number(year), issued: list.length }))
    .sort((a, b) => a.year - b.year).slice(-8);
  const totalRecipients = ack.reduce((s, r) => s + Number(r.recipients ?? 0), 0);
  const totalAcks = ack.reduce((s, r) => s + Number(r.acks ?? 0), 0);
  const summary = (r: DashboardRow) => ({ id: r.id, refNo: r.ref_no, title: r.title, type: r.type, category: r.category, status: r.status, issuedDate: iso(r.issued_date), effectiveDate: iso(r.effective_date), expiryDate: iso(r.expiry_date) });
  return {
    kpis: {
      total: rows.length, inForce: inForce.length, drafts: drafts.length,
      superseded: rows.filter((r) => r.status === 'SUPERSEDED').length, withdrawn: rows.filter((r) => r.status === 'WITHDRAWN').length,
      conventions: rows.filter((r) => r.type === 'CONVENTION').length,
      ackRequired: ack.length, ackOutstanding: ack.reduce((s, r) => s + outstandingOf(r), 0),
      ackCompliancePct: totalRecipients ? Math.round((totalAcks / totalRecipients) * 100) : 100,
      awaitingApproval: drafts.filter((r) => !!r.reviewed_at && !!r.cleared_at).length,
      awaitingReview: drafts.filter((r) => !r.reviewed_at).length,
      comingIntoForce: rows.filter((r) => r.effective_date && new Date(r.effective_date).getTime() > now.getTime() && new Date(r.effective_date).getTime() <= horizon).length,
      lapsingSoon: inForce.filter((r) => r.expiry_date && new Date(r.expiry_date).getTime() > now.getTime() && new Date(r.expiry_date).getTime() <= horizon).length,
    },
    byType: types,
    bySubject: subjects.slice(0, 12),
    byYear: years,
    drafts: drafts.sort((a, b) => new Date(b.issued_date).getTime() - new Date(a.issued_date).getTime()).slice(0, 10)
      .map((r) => ({ ...summary(r), draftedBy: r.drafted_by, reviewed: !!r.reviewed_at, cleared: !!r.cleared_at })),
    recent: inForce.sort((a, b) => new Date(b.issued_date).getTime() - new Date(a.issued_date).getTime()).slice(0, 10).map(summary),
    outstanding: ack.filter((r) => outstandingOf(r) > 0).sort((a, b) => outstandingOf(b) - outstandingOf(a)).slice(0, 10)
      .map((r) => ({ ...summary(r), recipients: Number(r.recipients ?? 0), acknowledgements: Number(r.acks ?? 0), outstanding: outstandingOf(r) })),
    lapsing: inForce.filter((r) => r.expiry_date && new Date(r.expiry_date).getTime() > now.getTime() && new Date(r.expiry_date).getTime() <= horizon)
      .sort((a, b) => new Date(a.expiry_date!).getTime() - new Date(b.expiry_date!).getTime()).slice(0, 10).map(summary),
  };
}
export type RegisterDashboard = ReturnType<typeof registerDashboard>;
