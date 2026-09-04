import { EVENTS, INCIDENT_PRIORITIES, INCIDENT_SEVERITY, INCIDENT_STATUS, INCIDENT_TRANSITIONS, canTransition, makeEvent, type Actor, type EventEnvelope, type IncidentStatus } from '@maritime/contracts';
import { enqueue, eventFromContext, type Queryable, recordScope } from '@maritime/service-kit';
import type { Env } from './env';

/* The case file.
 *
 * A case moves only along the declared transition table, and every move is a row in its status history — the
 * timeline the duty officer reads is that history merged with the operational log and the documents, not a
 * separate narrative that could disagree with it. The threads (communications, tasks, documents, log) are
 * append-only: a case file is evidence, so nothing already written into it is edited away. */

export type Row = Record<string, any>;
export const H = 3_600_000;
export const D = 24 * H;
export const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());
export const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));

export const COMM_DIRECTIONS = ['IN', 'OUT', 'INTERNAL'] as const;
export const TASK_STATUS = ['OPEN', 'DONE'] as const;
/* The document-type master, mirrored from the `documentType` lookup the case screen fills its dropdown from.
 * A code the master offers and this service refuses would be a dead option on the screen, so the two lists move
 * together. */
export const DOC_TYPES = ['REPORT', 'PHOTO', 'STATEMENT', 'SAMPLE', 'PERMIT', 'CCTV', 'MANIFEST', 'SURVEY', 'NOTICE', 'CERT', 'OTHER'] as const;
/** A case is live until it is resolved or closed; the threads stay open while it is live. */
export const LIVE_STATUS: readonly IncidentStatus[] = ['OPEN', 'ACKNOWLEDGED', 'RESPONDING', 'MONITORING'];
export const isLive = (status: string) => LIVE_STATUS.includes(status as IncidentStatus);
/** Severity sets the default priority; the desk may raise or lower it afterwards. */
export const PRIORITY_OF: Record<string, string> = { LOW: 'P4', MEDIUM: 'P3', HIGH: 'P2', CRITICAL: 'P1' };
export const transitionsFor = (status: string): IncidentStatus[] => INCIDENT_TRANSITIONS[status as IncidentStatus] ?? [];
export const allowed = (from: string, to: string) => canTransition(INCIDENT_TRANSITIONS, from as IncidentStatus, to as IncidentStatus);
/** RESPONDING out of a resolved or closed case is a reopen, not a fresh response. */
export const isReopen = (from: string, to: string) => (from === 'RESOLVED' || from === 'CLOSED') && to === 'RESPONDING';

export interface IncidentRow {
  /** Tenancy partition, projected into the read models so reporting enforces the same predicate. */ scope_port: string;
  id: string; number: string; category: string; type: string; severity: string; priority: string; status: string; title: string; description: string;
  vessel_id: string | null; vessel_name: string; berth_id: string | null; berth_code: string; berth_terminal: string; location: Row;
  reported_at: Date; reported_by: string; source: string; assigned_to_id: string | null; assigned_to: string;
  assets: string[]; injuries: number; pollution_tier: number; weather: Row; rca: Row;
  acknowledged_at: Date | null; responding_at: Date | null; resolved_at: Date | null; closed_at: Date | null; outcome: string;
  created_at: Date; updated_at: Date;
}
export interface CommRow { id: string; incident_id: string; at: Date; by_id: string | null; by_name: string; channel: string; direction: string; message: string }
export interface TaskRow { id: string; incident_id: string; title: string; assignee_id: string | null; assignee: string; due: Date | null; status: string; done_at: Date | null }
export interface DocRow { id: string; incident_id: string; name: string; doc_type: string; size_kb: number; uploaded_by_id: string | null; uploaded_by: string; at: Date; note: string; document_id: string | null }
export interface LogRow { id: string; incident_id: string; at: Date; by_id: string | null; by_name: string; entry: string }
export interface HistoryRow { id: string; incident_id: string; from_status: string; to_status: string; at: Date; by_id: string | null; by_name: string; note: string }

/* -------------------------------------------------------------------------- API shapes --- */

export const commApi = (c: CommRow) => ({ id: c.id, at: iso(c.at)!, by: c.by_name, byId: c.by_id, channel: c.channel, direction: c.direction, message: c.message });
export const taskApi = (t: TaskRow) => ({
  id: t.id, title: t.title, assignee: t.assignee, assigneeId: t.assignee_id, due: iso(t.due), status: t.status, doneAt: iso(t.done_at),
  overdue: t.status === 'OPEN' && !!t.due && new Date(t.due).getTime() < Date.now(),
});
export const documentApi = (d: DocRow) => ({ id: d.id, name: d.name, docType: d.doc_type, sizeKB: d.size_kb, uploadedBy: d.uploaded_by, uploadedById: d.uploaded_by_id, at: iso(d.at)!, note: d.note, documentId: d.document_id });
export const logApi = (l: LogRow) => ({ id: l.id, at: iso(l.at)!, by: l.by_name, byId: l.by_id, entry: l.entry });
export const historyApi = (h: HistoryRow) => ({ from: h.from_status, to: h.to_status, at: iso(h.at)!, by: h.by_name, byId: h.by_id, note: h.note });

/** The register row: the facts of the case, without the threads that hang off it. */
export function incidentRowApi(i: IncidentRow) {
  return {
    id: i.id, number: i.number, category: i.category, type: i.type, severity: i.severity, priority: i.priority, status: i.status, title: i.title,
    vesselId: i.vessel_id, vesselName: i.vessel_name, berthId: i.berth_id, berthCode: i.berth_code, berthTerminal: i.berth_terminal,
    location: { area: i.location?.area ?? '', lat: num(i.location?.lat), lon: num(i.location?.lon) },
    position: i.location?.lat == null ? null : { lat: Number(i.location.lat), lon: Number(i.location.lon) },
    reportedAt: iso(i.reported_at)!, reportedBy: i.reported_by, source: i.source, assignedToId: i.assigned_to_id, assignedTo: i.assigned_to,
    injuries: i.injuries, pollutionTier: i.pollution_tier,
    acknowledgedAt: iso(i.acknowledged_at), resolvedAt: iso(i.resolved_at), closedAt: iso(i.closed_at),
    live: isLive(i.status), allowedTransitions: transitionsFor(i.status),
    createdAt: iso(i.created_at), updatedAt: iso(i.updated_at),
  };
}
export interface CaseFile { comms?: CommRow[]; tasks?: TaskRow[]; documents?: DocRow[]; log?: LogRow[]; history?: HistoryRow[] }
/** The full case file the incident screen renders from. */
export function incidentApi(i: IncidentRow, file: CaseFile = {}) {
  const tasks = (file.tasks ?? []).map(taskApi);
  return {
    ...incidentRowApi(i),
    description: i.description, assets: i.assets ?? [], weather: { windKn: num(i.weather?.windKn), seaState: num(i.weather?.seaState) },
    rca: { rootCause: i.rca?.rootCause ?? '', category: i.rca?.category ?? '', correctiveAction: i.rca?.correctiveAction ?? '', preventiveAction: i.rca?.preventiveAction ?? '' },
    resolution: {
      resolvedAt: iso(i.resolved_at), closedAt: iso(i.closed_at), outcome: i.outcome,
      rootCause: i.rca?.rootCause ?? '', rcaCategory: i.rca?.category ?? '', correctiveAction: i.rca?.correctiveAction ?? '', preventiveAction: i.rca?.preventiveAction ?? '',
      responseHours: i.resolved_at ? Math.round(((new Date(i.resolved_at).getTime() - new Date(i.reported_at).getTime()) / H) * 10) / 10 : null,
      acknowledgeMinutes: i.acknowledged_at ? Math.round((new Date(i.acknowledged_at).getTime() - new Date(i.reported_at).getTime()) / 60000) : null,
    },
    comms: (file.comms ?? []).map(commApi), tasks, documents: (file.documents ?? []).map(documentApi),
    log: (file.log ?? []).map(logApi), statusHistory: (file.history ?? []).map(historyApi),
    openTasks: tasks.filter((t) => t.status === 'OPEN').length, outcome: i.outcome,
  };
}
export type IncidentApi = ReturnType<typeof incidentApi>;

/** Status changes, log entries and attachments merged into one thread, newest first — the timeline tab. */
export function buildTimeline(file: CaseFile) {
  const rows = [
    ...(file.history ?? []).map((h) => ({ at: iso(h.at)!, kind: 'STATUS' as const, who: h.by_name, text: `${h.from_status || 'New'} → ${h.to_status}${h.note ? ` — ${h.note}` : ''}` })),
    ...(file.log ?? []).map((l) => ({ at: iso(l.at)!, kind: 'LOG' as const, who: l.by_name, text: l.entry })),
    ...(file.documents ?? []).map((d) => ({ at: iso(d.at)!, kind: 'DOC' as const, who: d.uploaded_by, text: `Attached ${d.name}` })),
  ];
  return rows.sort((a, b) => b.at.localeCompare(a.at));
}

/* ------------------------------------------------------------------------- publishing --- */

/** Every case write publishes the API-shaped snapshot first, then the business event. */
export async function publishIncident(c: Queryable, env: Env, i: IncidentRow, file: CaseFile, opts: { event?: string; data?: Row; cause?: EventEnvelope; actor?: Actor } = {}) {
  const entity = incidentApi(i, file);
  const mk = <T,>(type: string, data: T) => (opts.cause
    ? makeEvent({ type, source: env.SERVICE_NAME, data, subject: i.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor })
    : eventFromContext(env.SERVICE_NAME, type, data, { subject: i.id, actor: opts.actor }));
  await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'incident', entity: { ...entity, scope: recordScope(i) } }));
  if (opts.event) {
    await enqueue(c, mk(opts.event, {
      incidentId: i.id, number: i.number, title: i.title, category: i.category, type: i.type, severity: i.severity, priority: i.priority, status: i.status,
      vesselId: i.vessel_id, vesselName: i.vessel_name, berthCode: i.berth_code, assignedTo: i.assigned_to, assignedToId: i.assigned_to_id,
      reportedAt: iso(i.reported_at), incident: entity, ...(opts.data ?? {}),
    }));
  }
  return entity;
}
export async function publishIncidentDeleted(c: Queryable, env: Env, i: IncidentRow) {
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.deleted, { kind: 'incident', id: i.id }, { subject: i.id }));
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.maritimeCentre.incidentDeleted, { incidentId: i.id, number: i.number, title: i.title }, { subject: i.id }));
}

/* -------------------------------------------------------------------------- dashboard --- */

const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const monthLabel = (d: Date) => `${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${String(d.getUTCFullYear()).slice(2)}`;
export function monthsBack(now: Date, n = 12) {
  const out: { key: string; month: string }[] = [];
  for (let k = n - 1; k >= 0; k -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1));
    out.push({ key: monthKey(d), month: monthLabel(d) });
  }
  return out;
}

export interface DashboardCase { id: string; number: string; title: string; category: string; type: string; severity: string; priority: string; status: string; reported_at: Date; acknowledged_at: Date | null; resolved_at: Date | null; closed_at: Date | null; assigned_to: string; injuries: number }
/* Response posture across the desk. The trend and the mix window on the trailing twelve months, because a desk
 * that has been running since 2023 would otherwise show an average that no longer describes it. The open list
 * and its ageing do not window at all: a case still open from last year is precisely what has to stay visible. */
export function incidentDashboard(windowed: DashboardCase[], everOpen: DashboardCase[], sla: { mttaTargetMin: number; mttrTargetHrs: number }, now = new Date()) {
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const months = monthsBack(now, 12).map((m) => ({ ...m, LOW: 0, MEDIUM: 0, HIGH: 0, CRITICAL: 0, total: 0 }));
  const byType = new Map<string, number>(); const byCategory = new Map<string, number>(); const byStatus = new Map<string, number>();
  let resolvedN = 0; let resolveSum = 0; let ackN = 0; let ackSum = 0; let injuries = 0;
  for (const i of windowed) {
    const row = months.find((m) => m.key === monthKey(new Date(i.reported_at)));
    if (row && (row as Row)[i.severity] !== undefined) { (row as Row)[i.severity] += 1; row.total += 1; }
    byType.set(i.type, (byType.get(i.type) ?? 0) + 1);
    byCategory.set(i.category, (byCategory.get(i.category) ?? 0) + 1);
    byStatus.set(i.status, (byStatus.get(i.status) ?? 0) + 1);
    injuries += i.injuries || 0;
    const end = i.resolved_at ?? i.closed_at;
    if (end) { resolvedN += 1; resolveSum += (new Date(end).getTime() - new Date(i.reported_at).getTime()) / H; }
    if (i.acknowledged_at) { ackN += 1; ackSum += (new Date(i.acknowledged_at).getTime() - new Date(i.reported_at).getTime()) / H; }
  }
  const aging: Record<string, number> = { '0-24h': 0, '1-3d': 0, '3-7d': 0, '>7d': 0 };
  for (const i of everOpen) {
    const ageH = (now.getTime() - new Date(i.reported_at).getTime()) / H;
    if (ageH <= 24) aging['0-24h'] += 1; else if (ageH <= 72) aging['1-3d'] += 1; else if (ageH <= 168) aging['3-7d'] += 1; else aging['>7d'] += 1;
  }
  return {
    sla,
    kpis: {
      open: everOpen.length,
      highOpen: everOpen.filter((i) => i.severity === 'HIGH' || i.severity === 'CRITICAL').length,
      loggedYtd: windowed.filter((i) => new Date(i.reported_at) >= yearStart).length,
      closedYtd: windowed.filter((i) => i.closed_at && new Date(i.closed_at) >= yearStart).length,
      mttrHrs: resolvedN ? Math.round((resolveSum / resolvedN) * 10) / 10 : 0,
      mttaMin: ackN ? Math.round((ackSum / ackN) * 60) : 0,
      injuriesYtd: injuries,
    },
    byMonth: months.map(({ key, ...m }) => m),
    byType: [...byType.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count),
    byCategory: [...byCategory.entries()].map(([category, count]) => ({ category, count })).sort((a, b) => b.count - a.count),
    byStatus: [...byStatus.entries()].map(([status, count]) => ({ status, count })),
    aging: Object.entries(aging).map(([bucket, count]) => ({ bucket, count })),
    openList: everOpen.slice(0, 12).map((i) => ({ id: i.id, number: i.number, title: i.title, severity: i.severity, status: i.status, reportedAt: iso(i.reported_at)!, priority: i.priority, assignedTo: i.assigned_to })),
  };
}

/* ------------------------------------------------------------------------ risk matrix --- */

const LIKELIHOOD: Record<string, number> = { P1: 5, P2: 4, P3: 3, P4: 2 };
const CONSEQUENCE: Record<string, number> = { CRITICAL: 5, HIGH: 4, MEDIUM: 3, LOW: 2 };
export interface MatrixCase { id: string; number: string; title: string; severity: string; priority: string; status: string }
/* The classic 5×5 heatmap. Likelihood comes off the priority — a P1 is the case most likely to recur if nothing
 * is done — and consequence off the severity. Residual risk drops one band on each axis once the case has been
 * resolved or closed, which is the before-and-after picture an HSE committee actually argues about. */
export function riskMatrix(cases: MatrixCase[], days: number) {
  const initial = new Map<string, MatrixCase[]>(); const residual = new Map<string, MatrixCase[]>();
  const push = (m: Map<string, MatrixCase[]>, k: string, i: MatrixCase) => m.set(k, [...(m.get(k) ?? []), i]);
  for (const i of cases) {
    const l = LIKELIHOOD[i.priority] ?? 3; const c = CONSEQUENCE[i.severity] ?? 3;
    push(initial, `${l}:${c}`, i);
    const done = i.status === 'RESOLVED' || i.status === 'CLOSED';
    push(residual, `${done ? Math.max(1, l - 1) : l}:${done ? Math.max(1, c - 1) : c}`, i);
  }
  const pack = (m: Map<string, MatrixCase[]>) => [...m.entries()].map(([k, list]) => {
    const [likelihood, consequence] = k.split(':').map(Number);
    return { likelihood, consequence, count: list.length, sample: list.slice(0, 6).map((i) => ({ id: i.id, number: i.number, title: i.title, status: i.status })) };
  }).sort((a, b) => b.likelihood - a.likelihood || b.consequence - a.consequence);
  return { days, total: cases.length, initial: pack(initial), residual: pack(residual) };
}

/** What the entity hover card shows for a case — the four facts that answer "which case is this?". */
export function incidentCard(i: IncidentRow, openTasks: number) {
  return {
    kind: 'incident', title: i.number, subtitle: i.title, link: `/incidents/${i.id}`,
    chips: [
      { label: i.severity.charAt(0) + i.severity.slice(1).toLowerCase(), tone: i.severity === 'CRITICAL' || i.severity === 'HIGH' ? 'error' : i.severity === 'MEDIUM' ? 'warning' : 'info' },
      { label: i.status.charAt(0) + i.status.slice(1).toLowerCase().replace(/_/g, ' '), tone: isLive(i.status) ? 'warning' : 'success' },
      ...(openTasks ? [{ label: `${openTasks} open task${openTasks > 1 ? 's' : ''}`, tone: 'default' }] : []),
    ],
    lines: [
      { label: 'Category', value: `${i.category} · ${i.type}` },
      { label: 'Reported', value: iso(i.reported_at) },
      { label: 'Case officer', value: i.assigned_to || null },
      { label: 'Location', value: i.berth_code || i.location?.area || null },
    ],
  };
}

export const SEVERITIES = INCIDENT_SEVERITY;
export const PRIORITIES = INCIDENT_PRIORITIES;
export const STATUSES = INCIDENT_STATUS;
