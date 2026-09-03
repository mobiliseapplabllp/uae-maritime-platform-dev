import { EVENTS, INSPECTION_RESULTS, makeEvent, type Actor, type EventEnvelope } from '@maritime/contracts';
import { enqueue, eventFromContext, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';

/* A survey and everything that hangs off it.
 *
 * The checklist is a copy, not a reference: the questions are taken from the template at the moment the survey
 * is planned and stay on the survey, so raising a template version can never rewrite an answered sheet. The
 * weighted score is computed from that copy against the weights the copy carries, which is why the score a
 * closed survey shows never drifts. Findings are rows of their own rather than a JSON blob on the survey,
 * because the deficiency register, the rectification clock and the detention grounds all read them directly. */

export type Row = Record<string, any>;
export const H = 3_600_000;
export const D = 24 * H;
export const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());
export const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));

export const ANSWERS = ['YES', 'NO', 'NA', ''] as const;
export const ANSWER_TYPES = ['YES_NO', 'YES_NO_NA', 'TEXT', 'NUMBER'] as const;
export const FINDING_STATUS = ['OPEN', 'CLOSED'] as const;
export const FINDING_SEVERITY = ['MINOR', 'MAJOR', 'DETAINABLE'] as const;
/** Checklists cover more than ship surveys — the HSE walkabout and the terminal audit run on the same builder. */
export const CHECKLIST_TYPES = ['PSC', 'FSI', 'ISM', 'ISPS', 'MLC', 'HSE', 'TERMINAL'] as const;
/** Riyadh MoU action code 30 is the detainable one; a finding carrying it is a detention ground. */
export const DETAINABLE_ACTION = '30';

export interface TemplateItem { seq: number; text: string; category: string; answerType: string; weight: number; critical: boolean; guidance: string }
export interface ChecklistAnswer { seq: number; text: string; category: string; answer: string; note: string; weight: number; critical: boolean; answerType: string }

export interface InspectionRow {
  id: string; number: string; vessel_id: string | null; vessel_name: string; vessel_imo: string; vessel_flag: string; vessel_type: string;
  port_call_id: string | null; vcn: string; type: string; template_id: string | null; template_version: number | null;
  inspector_id: string | null; inspector: string; planned_at: Date; started_at: Date | null; closed_at: Date | null;
  status: string; result: string; score_pct: number | null; pass_score_pct: number | null; critical_fail: boolean; detention: boolean;
  checklist: ChecklistAnswer[]; remarks: string; created_at: Date; updated_at: Date;
}
export interface FindingRow {
  id: string; inspection_id: string; seq: number; deficiency_code: string; deficiency_label: string; category: string; severity: string;
  description: string; action_code: string; due_date: Date | null; status: string; closed_at: Date | null; rectification_note: string;
  created_at: Date; updated_at: Date;
}
export interface DetentionRow {
  id: string; inspection_id: string; vessel_id: string | null; vessel_name: string; ordered_at: Date; ordered_by_id: string | null; ordered_by: string;
  grounds: string; detainable_codes: string[]; released_at: Date | null; released_by_id: string | null; released_by: string; release_note: string; status: string;
}
export interface TemplateRow {
  id: string; name: string; inspection_type: string; description: string; items: TemplateItem[]; active: boolean; version: number; pass_score_pct: number;
  created_at: Date; updated_at: Date;
}

/* -------------------------------------------------------------------------- API shapes --- */

export const findingApi = (f: FindingRow) => ({
  id: f.id, seq: f.seq, deficiencyCode: f.deficiency_code, deficiencyLabel: f.deficiency_label, category: f.category, severity: f.severity,
  description: f.description, actionCode: f.action_code, dueDate: iso(f.due_date), status: f.status, closedAt: iso(f.closed_at),
  rectificationNote: f.rectification_note, detainable: f.action_code === DETAINABLE_ACTION || f.severity === 'DETAINABLE',
  overdue: f.status === 'OPEN' && !!f.due_date && new Date(f.due_date).getTime() < Date.now(),
});
export type FindingApi = ReturnType<typeof findingApi>;

export const detentionApi = (d: DetentionRow) => ({
  id: d.id, inspectionId: d.inspection_id, vesselId: d.vessel_id, vesselName: d.vessel_name, orderedAt: iso(d.ordered_at)!, orderedById: d.ordered_by_id,
  orderedBy: d.ordered_by, grounds: d.grounds, detainableCodes: d.detainable_codes ?? [], releasedAt: iso(d.released_at), releasedById: d.released_by_id,
  releasedBy: d.released_by, releaseNote: d.release_note, status: d.status,
  heldHours: d.released_at ? Math.round(((new Date(d.released_at).getTime() - new Date(d.ordered_at).getTime()) / H) * 10) / 10 : null,
});
export type DetentionApi = ReturnType<typeof detentionApi>;

/** The checklist as the survey screen answers it — the copied questions with their weights carried alongside. */
export const answerApi = (a: ChecklistAnswer) => ({
  seq: a.seq, text: a.text, category: a.category, answer: a.answer ?? '', note: a.note ?? '',
  weight: a.weight ?? 1, critical: !!a.critical, answerType: a.answerType ?? 'YES_NO_NA',
});

export interface InspectionExtras { findings?: FindingApi[]; detention?: DetentionApi | null }
/** The survey as every screen and every read-model event sees her. */
export function inspectionApi(i: InspectionRow, extra: InspectionExtras = {}) {
  const findings = extra.findings ?? [];
  const checklist = (i.checklist ?? []).map(answerApi);
  return {
    id: i.id, number: i.number, vesselId: i.vessel_id, vesselName: i.vessel_name, vesselImo: i.vessel_imo, vesselFlag: i.vessel_flag, vesselType: i.vessel_type,
    portCallId: i.port_call_id, vcn: i.vcn, type: i.type, templateId: i.template_id, templateVersion: i.template_version,
    inspectorId: i.inspector_id, inspector: i.inspector,
    plannedAt: iso(i.planned_at)!, startedAt: iso(i.started_at), closedAt: iso(i.closed_at),
    status: i.status, result: i.result, scorePct: i.score_pct, passScorePct: i.pass_score_pct, criticalFail: i.critical_fail, detention: i.detention,
    checklist, findings, findingsCount: findings.length,
    openFindings: findings.filter((f) => f.status === 'OPEN').length, totalFindings: findings.length,
    answered: checklist.filter((c) => c.answer).length, questions: checklist.length,
    detentionRecord: extra.detention ?? null,
    remarks: i.remarks, createdAt: iso(i.created_at), updatedAt: iso(i.updated_at),
  };
}
export type InspectionApi = ReturnType<typeof inspectionApi>;

export const templateApi = (t: TemplateRow) => ({
  id: t.id, name: t.name, inspectionType: t.inspection_type, description: t.description,
  items: (t.items ?? []).map((x, ix) => ({ seq: x.seq ?? ix + 1, text: x.text, category: x.category ?? 'General', answerType: x.answerType ?? 'YES_NO_NA', weight: Number(x.weight) || 1, critical: !!x.critical, guidance: x.guidance ?? '' })),
  active: t.active, version: t.version, passScorePct: t.pass_score_pct,
  itemCount: (t.items ?? []).length, totalWeight: (t.items ?? []).reduce((s, x) => s + (Number(x.weight) || 1), 0),
  criticalCount: (t.items ?? []).filter((x) => x.critical).length,
  sections: [...new Set((t.items ?? []).map((x) => x.category ?? 'General'))],
  createdAt: iso(t.created_at), updatedAt: iso(t.updated_at),
});
export type TemplateApi = ReturnType<typeof templateApi>;

/* ---------------------------------------------------------------------------- scoring --- */

export interface Score { pct: number | null; got: number; max: number; criticalFail: boolean; suggested: string }
/** Weighted compliance: N/A and unanswered questions are left out of both sides of the ratio, so a partly worked
 *  sheet scores on what was actually asked; a NO on a critical question fails the survey outright. */
export function scoreChecklist(checklist: ChecklistAnswer[], passScorePct: number): Score {
  let got = 0; let max = 0; let criticalFail = false;
  for (const c of checklist ?? []) {
    if (!c.answer || c.answer === 'NA') continue;
    const w = Number(c.weight) || 1;
    max += w;
    if (c.answer === 'YES') got += w;
    else if (c.critical) criticalFail = true;
  }
  const pct = max > 0 ? Math.round((got / max) * 100) : null;
  const suggested = criticalFail ? 'DETAINED' : pct !== null && pct < passScorePct ? 'DEFICIENCIES' : 'SATISFACTORY';
  return { pct, got, max, criticalFail, suggested };
}

/** Questions copied off a template onto a survey; the weights travel with the copy so the score cannot drift. */
export const answersFromTemplate = (t: TemplateRow | null | undefined): ChecklistAnswer[] =>
  (t?.items ?? []).map((i, ix) => ({ seq: i.seq ?? ix + 1, text: i.text, category: i.category ?? 'General', answer: '', note: '', weight: Number(i.weight) || 1, critical: !!i.critical, answerType: i.answerType ?? 'YES_NO_NA' }));

/** An inbound checklist keeps the weights the survey already holds — the sheet is answered, never re-weighted. */
export function mergeAnswers(current: ChecklistAnswer[], incoming: Row[]): ChecklistAnswer[] {
  const byText = new Map((current ?? []).map((c) => [c.text, c]));
  return (incoming ?? []).map((i, ix) => {
    const held = byText.get(String(i.text));
    const answer = ANSWERS.includes(String(i.answer ?? '') as never) ? String(i.answer ?? '') : '';
    return {
      seq: Number(i.seq) || ix + 1, text: String(i.text ?? ''), category: String(i.category ?? held?.category ?? 'General'), answer, note: String(i.note ?? ''),
      weight: held ? held.weight : Number(i.weight) || 1, critical: held ? held.critical : !!i.critical, answerType: held?.answerType ?? String(i.answerType ?? 'YES_NO_NA'),
    };
  });
}

export const isResult = (v: unknown): v is (typeof INSPECTION_RESULTS)[number] => INSPECTION_RESULTS.includes(v as never);

/* ------------------------------------------------------------------------- publishing --- */

/** Every survey write publishes the API-shaped snapshot first, then the business event. */
export async function publishInspection(c: Queryable, env: Env, i: InspectionRow, extra: InspectionExtras, opts: { event?: string; data?: Row; cause?: EventEnvelope; actor?: Actor } = {}) {
  const entity = inspectionApi(i, extra);
  const mk = <T,>(type: string, data: T) => (opts.cause
    ? makeEvent({ type, source: env.SERVICE_NAME, data, subject: i.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor })
    : eventFromContext(env.SERVICE_NAME, type, data, { subject: i.id, actor: opts.actor }));
  await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'inspection', entity }));
  if (opts.event) {
    await enqueue(c, mk(opts.event, {
      inspectionId: i.id, number: i.number, vesselId: i.vessel_id, vesselName: i.vessel_name, imo: i.vessel_imo, type: i.type,
      status: i.status, result: i.result, detention: i.detention, scorePct: i.score_pct,
      openFindings: entity.openFindings, totalFindings: entity.totalFindings, inspection: entity, ...(opts.data ?? {}),
    }));
  }
  return entity;
}
export async function publishInspectionDeleted(c: Queryable, env: Env, i: InspectionRow) {
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.deleted, { kind: 'inspection', id: i.id }, { subject: i.id }));
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.inspection.deleted, { inspectionId: i.id, number: i.number, vesselId: i.vessel_id, vesselName: i.vessel_name }, { subject: i.id }));
}
export async function publishTemplate(c: Queryable, env: Env, t: TemplateRow, event: string, data: Row = {}) {
  const entity = templateApi(t);
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.upserted, { kind: 'checklistTemplate', entity }, { subject: t.id }));
  await enqueue(c, eventFromContext(env.SERVICE_NAME, event, { templateId: t.id, name: t.name, inspectionType: t.inspection_type, version: t.version, active: t.active, itemCount: entity.itemCount, template: entity, ...data }, { subject: t.id }));
  return entity;
}
export async function publishTemplateDeleted(c: Queryable, env: Env, t: TemplateRow) {
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.deleted, { kind: 'checklistTemplate', id: t.id }, { subject: t.id }));
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.inspection.templateDeleted, { templateId: t.id, name: t.name, inspectionType: t.inspection_type }, { subject: t.id }));
}

/* The inspection history a ship's risk score is built from.
 *
 * Vessel risk is scored by the ships service, which owns the model. What that model cannot see for itself is
 * this service's record of the ship: how she inspected, what is still open against her and whether she has been
 * detained. That record is published as `inspection.risk.scored` on every close and every detention so the
 * score is refreshed from the survey that changed it rather than on a timer. */
export interface RiskSignal { vesselId: string; vesselName: string; imo: string; inspections: number; detentions: number; deficiencies: number; openDeficiencies: number; lastInspectionAt: string | null; lastDetentionAt: string | null; satisfactoryPct: number }
export async function riskSignalFor(c: Queryable, vesselId: string): Promise<RiskSignal | null> {
  const r = await c.query<Row>(
    `SELECT i.vessel_id, max(i.vessel_name) AS vessel_name, max(i.vessel_imo) AS vessel_imo,
            count(*) FILTER (WHERE i.status = 'CLOSED') AS closed,
            count(*) FILTER (WHERE i.detention) AS detentions,
            count(*) FILTER (WHERE i.result = 'SATISFACTORY') AS satisfactory,
            max(i.closed_at) AS last_closed,
            max(i.closed_at) FILTER (WHERE i.detention) AS last_detention
       FROM inspections i WHERE i.vessel_id::text = $1 GROUP BY i.vessel_id`, [vesselId]);
  const row = r.rows[0];
  if (!row) return null;
  const f = await c.query<{ total: string; open: string }>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE f.status = 'OPEN') AS open FROM findings f JOIN inspections i ON i.id = f.inspection_id WHERE i.vessel_id::text = $1`, [vesselId]);
  const closed = Number(row.closed) || 0;
  return {
    vesselId, vesselName: row.vessel_name ?? '', imo: row.vessel_imo ?? '',
    inspections: closed, detentions: Number(row.detentions) || 0,
    deficiencies: Number(f.rows[0]?.total) || 0, openDeficiencies: Number(f.rows[0]?.open) || 0,
    lastInspectionAt: iso(row.last_closed), lastDetentionAt: iso(row.last_detention),
    satisfactoryPct: closed ? Math.round((Number(row.satisfactory) / closed) * 100) : 0,
  };
}
/** Publishes the ship's inspection history so the ships service can factor it into her risk score. */
export async function publishRiskSignal(c: Queryable, env: Env, vesselId: string | null, cause: { subject?: string } = {}) {
  if (!vesselId) return null;
  const signal = await riskSignalFor(c, vesselId);
  if (!signal) return null;
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.inspection.riskScored, signal, { subject: cause.subject ?? vesselId }));
  return signal;
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

export interface DashboardInput { type: string; status: string; result: string; detention: boolean; planned_at: Date; closed_at: Date | null; checklist: ChecklistAnswer[]; findings_total: number; findings_open: number }
/* The survey history runs back to 2023, so lifetime averages would bury the recent signal. Workload mix windows
 * on when a survey was planned; the outcome KPIs window on when it closed — the same field the trend chart bins
 * on, so the cards reconcile with the chart beside them. Open findings stay a lifetime worklist count, because a
 * deficiency raised two years ago and still outstanding is exactly what the desk needs to see. */
export function inspectionDashboard(all: DashboardInput[], now = new Date()) {
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 11, 1));
  const yearStart = new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
  const closed = all.filter((i) => i.status === 'CLOSED');
  const recent = all.filter((i) => i.planned_at && new Date(i.planned_at) >= from);
  const recentClosed = closed.filter((i) => i.closed_at && new Date(i.closed_at) >= from);
  const months = monthsBack(now, 12).map((m) => ({ ...m, SATISFACTORY: 0, DEFICIENCIES: 0, DETAINED: 0 }));
  const byType = new Map<string, { type: string; total: number; closed: number; detained: number }>();
  let findingsTotal = 0; let findingsOpen = 0; let checklistYes = 0; let checklistItems = 0;
  for (const i of recent) {
    const t = byType.get(i.type) ?? { type: i.type, total: 0, closed: 0, detained: 0 };
    t.total += 1;
    if (i.status === 'CLOSED') t.closed += 1;
    if (i.detention) t.detained += 1;
    byType.set(i.type, t);
    for (const c of i.checklist ?? []) { if (c.answer) checklistItems += 1; if (c.answer === 'YES') checklistYes += 1; }
  }
  for (const i of recentClosed) findingsTotal += i.findings_total;
  for (const i of all) findingsOpen += i.findings_open;
  for (const i of closed) {
    if (!i.closed_at || !i.result) continue;
    const row = months.find((m) => m.key === monthKey(new Date(i.closed_at!)));
    if (row && (row as Row)[i.result] !== undefined) (row as Row)[i.result] += 1;
  }
  return {
    kpis: {
      open: all.filter((i) => i.status !== 'CLOSED').length,
      closedYtd: closed.filter((i) => i.closed_at && new Date(i.closed_at) >= yearStart).length,
      satisfactionPct: recentClosed.length ? Math.round((recentClosed.filter((i) => i.result === 'SATISFACTORY').length / recentClosed.length) * 100) : 0,
      detentionRatePct: recentClosed.length ? Math.round((recentClosed.filter((i) => i.detention).length / recentClosed.length) * 1000) / 10 : 0,
      avgFindings: recentClosed.length ? Math.round((findingsTotal / recentClosed.length) * 10) / 10 : 0,
      openFindings: findingsOpen,
      checklistCompliancePct: checklistItems ? Math.round((checklistYes / checklistItems) * 100) : 0,
    },
    byMonth: months.map(({ key, ...m }) => m),
    byType: [...byType.values()].sort((a, b) => b.total - a.total),
  };
}

/** What the entity hover card shows for a survey — the four facts that answer "which survey is this?". */
export function inspectionCard(i: InspectionRow, findings: FindingApi[]) {
  const open = findings.filter((f) => f.status === 'OPEN').length;
  return {
    kind: 'inspection', title: i.number, subtitle: `${i.type} · ${i.vessel_name || 'Unassigned vessel'}`, link: `/inspections/${i.id}`,
    chips: [
      { label: i.status === 'CLOSED' ? 'Closed' : i.status === 'IN_PROGRESS' ? 'In progress' : 'Planned', tone: i.status === 'CLOSED' ? 'success' : i.status === 'IN_PROGRESS' ? 'info' : 'default' },
      ...(i.result ? [{ label: i.result === 'SATISFACTORY' ? 'Satisfactory' : i.result === 'DETAINED' ? 'Detained' : 'Deficiencies', tone: i.result === 'SATISFACTORY' ? 'success' : i.result === 'DETAINED' ? 'error' : 'warning' }] : []),
      ...(open ? [{ label: `${open} open finding${open > 1 ? 's' : ''}`, tone: 'warning' }] : []),
    ],
    lines: [
      { label: 'Inspector', value: i.inspector || null },
      { label: 'Planned', value: iso(i.planned_at) },
      { label: 'Compliance', value: i.score_pct == null ? null : `${i.score_pct}%` },
      { label: 'Call', value: i.vcn || null },
    ],
  };
}
