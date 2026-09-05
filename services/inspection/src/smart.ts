import { EVENTS, evaluateInspectionKpis, kpiTargetsFrom, makeEvent, type Actor, type EventEnvelope, type KpiTimelineRow, type TimelineKind } from '@maritime/contracts';
import { enqueue, eventFromContext, lookupByCode, recordScope, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { DETAINABLE_ACTION, H, iso, num, type FindingApi, type InspectionRow, type Row } from './inspections';

/* Smart Inspection.
 *
 * What the survey desk does around a boarding, as records with dates on them: the dossier the party holds before
 * it boards, the prediction made before the boarding and scored after it, the classification the close-out gives
 * the survey and the restriction the rules recommend on it, the report and the notices drafted on the survey.
 * Every one of those writes a fact on the survey's timeline in the same transaction as the event that announces
 * it, and the six programme KPIs are computed from that timeline by the evaluator the contracts package holds —
 * so reporting, reading the same events, arrives at the same figure. */

export const SUBJECT_KINDS = ['VESSEL', 'COMPANY', 'PORT_FACILITY', 'MET_INSTITUTION'] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
export const REPORT_SOURCES = ['AI', 'MANUAL'] as const;
export const NOTICE_KINDS = ['DEFICIENCY', 'DETENTION', 'WARNING', 'RECTIFICATION'] as const;
export const RECOMMENDATION_KINDS = ['DETENTION', 'RESTRICTION', 'BAN'] as const;
export const DECISIONS = ['APPROVED', 'REJECTED', 'DEFERRED'] as const;
export const SEVERITIES = ['NONE', 'MINOR', 'MAJOR', 'CRITICAL'] as const;
export const RECOMMENDATIONS = ['NONE', 'RECTIFY', 'RESTRICT', 'DETAIN'] as const;

export interface SubjectRow { kind: string; id: string; code: string; name: string; status: string; detail: Row; updated_at: Date }
export interface ReportRow { id: string; inspection_id: string; version: number; source: string; status: string; draft_id: string | null; title: string; summary: string; body: string; severity: string; recommendation: string; drafted_at: Date; drafted_by_id: string | null; drafted_by: string; issued_at: Date | null; issued_by_id: string | null; issued_by: string; created_at: Date; updated_at: Date }
export interface NoticeRow { id: string; inspection_id: string; number: string; kind: string; source: string; status: string; draft_id: string | null; addressed_to: string; subject: string; body: string; finding_ids: string[]; drafted_at: Date; drafted_by_id: string | null; drafted_by: string; issued_at: Date | null; issued_by_id: string | null; issued_by: string; created_at: Date; updated_at: Date }
export interface RecommendationRow { id: string; inspection_id: string; kind: string; source: string; grounds: string; finding_codes: string[]; recommended_at: Date; recommended_by_id: string | null; recommended_by: string; routed_at: Date | null; routed_to: string; decided_at: Date | null; decided_by_id: string | null; decided_by: string; decision: string; decision_note: string; detention_id: string | null; status: string; created_at: Date; updated_at: Date }
export interface PredictionRow { id: string; inspection_id: string; source: string; decision_id: string | null; predicted_at: Date; risk_score: string | number | null; band: string; predicted_codes: string[]; basis: Row; scored_at: Date | null; outcome: Row | null; correlated: boolean | null; created_at: Date; updated_at: Date }
export interface VesselPredictionRow { vessel_id: string; decision_id: string | null; agent_id: string; predicted_at: Date; risk_score: string | number | null; band: string; predicted_codes: string[]; dossier: Row | null; updated_at: Date }
export interface TimelineRow { id: string; inspection_id: string; number: string; kind: string; at: Date; source: string; meta: Row; event_id: string | null; created_at: Date }

/* -------------------------------------------------------------------------- API shapes --- */
export const subjectApi = (s: SubjectRow) => ({ kind: s.kind, id: s.id, code: s.code, name: s.name, status: s.status, detail: s.detail ?? {} });
export const reportApi = (r: ReportRow) => ({ id: r.id, inspectionId: r.inspection_id, version: r.version, source: r.source, status: r.status, draftId: r.draft_id, title: r.title, summary: r.summary, body: r.body, severity: r.severity, recommendation: r.recommendation, draftedAt: iso(r.drafted_at)!, draftedById: r.drafted_by_id, draftedBy: r.drafted_by, issuedAt: iso(r.issued_at), issuedById: r.issued_by_id, issuedBy: r.issued_by, aiDrafted: r.source === 'AI' });
export const noticeApi = (n: NoticeRow) => ({ id: n.id, inspectionId: n.inspection_id, number: n.number, kind: n.kind, source: n.source, status: n.status, draftId: n.draft_id, addressedTo: n.addressed_to, subject: n.subject, body: n.body, findingIds: n.finding_ids ?? [], draftedAt: iso(n.drafted_at)!, draftedById: n.drafted_by_id, draftedBy: n.drafted_by, issuedAt: iso(n.issued_at), issuedById: n.issued_by_id, issuedBy: n.issued_by, aiDrafted: n.source === 'AI' });
export const recommendationApi = (r: RecommendationRow) => ({
  id: r.id, inspectionId: r.inspection_id, kind: r.kind, source: r.source, grounds: r.grounds, findingCodes: r.finding_codes ?? [], recommendedAt: iso(r.recommended_at)!, recommendedById: r.recommended_by_id, recommendedBy: r.recommended_by,
  routedAt: iso(r.routed_at), routedTo: r.routed_to, decidedAt: iso(r.decided_at), decidedById: r.decided_by_id, decidedBy: r.decided_by, decision: r.decision, decisionNote: r.decision_note, detentionId: r.detention_id, status: r.status,
  routedMinutes: r.routed_at ? Math.round((new Date(r.routed_at).getTime() - new Date(r.recommended_at).getTime()) / 60_000) : null,
  decidedMinutes: r.decided_at ? Math.round((new Date(r.decided_at).getTime() - new Date(r.recommended_at).getTime()) / 60_000) : null,
});
export const predictionApi = (p: PredictionRow) => ({ id: p.id, inspectionId: p.inspection_id, source: p.source, decisionId: p.decision_id, predictedAt: iso(p.predicted_at)!, riskScore: num(p.risk_score), band: p.band, predictedCodes: p.predicted_codes ?? [], basis: p.basis ?? {}, scoredAt: iso(p.scored_at), outcome: p.outcome ?? null, correlated: p.correlated });
export const timelineApi = (t: TimelineRow) => ({ id: String(t.id), kind: t.kind, at: iso(t.at)!, source: t.source, meta: t.meta ?? {} });

/* ---------------------------------------------------------------------------- timeline --- */
/** Writes one dated fact about a survey. The KPI evaluator reads nothing else, so what is not marked here is not measured. */
export async function mark(c: Queryable, i: Pick<InspectionRow, 'id' | 'number'>, kind: TimelineKind, at: Date | string, source = '', meta: Row = {}, eventId?: string) {
  await c.query('INSERT INTO inspection_timeline(inspection_id, number, kind, at, source, meta, event_id) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING', [i.id, i.number, kind, at, source, JSON.stringify(meta), eventId ?? null]);
}
export async function timelineOf(c: Queryable, inspectionId: string): Promise<TimelineRow[]> {
  return (await c.query<TimelineRow>('SELECT * FROM inspection_timeline WHERE inspection_id = $1 ORDER BY at, id', [inspectionId])).rows;
}
/** The whole timeline one reader may see, in the evaluator's shape. */
export async function kpiRows(c: Queryable, scoped: { sql: string; args: unknown[] }): Promise<KpiTimelineRow[]> {
  const r = await c.query<{ inspection_id: string; number: string; kind: string; at: Date; source: string; meta: Row }>(
    `SELECT t.inspection_id, t.number, t.kind, t.at, t.source, t.meta FROM inspection_timeline t JOIN inspections i ON i.id = t.inspection_id ${scoped.sql} ORDER BY t.at, t.id`, scoped.args);
  return r.rows.map((x) => ({ inspectionId: x.inspection_id, number: x.number, kind: x.kind, at: x.at, source: x.source, meta: x.meta ?? {} }));
}
export const kpiReport = (rows: KpiTimelineRow[], settings: Row | null | undefined, now = new Date()) => evaluateInspectionKpis(rows, kpiTargetsFrom(settings), now);

/* ------------------------------------------------------------------------- the regime --- */
export interface Regime { code: string; label: string; subjectKind: SubjectKind; intervalMonths: number | null; convention: string }
/** The regime as the master defines it; null when the master does not know the code or has retired it. */
export async function regimeOf(c: Queryable, code: string): Promise<Regime | null> {
  const row = await lookupByCode(c, 'inspectionRegime', code);
  if (!row || row.active === false) return null;
  const kind = String(row.meta?.subjectKind ?? 'VESSEL');
  return { code: row.code, label: row.label, subjectKind: (SUBJECT_KINDS.includes(kind as SubjectKind) ? kind : 'VESSEL') as SubjectKind, intervalMonths: row.meta?.intervalMonths == null ? null : Number(row.meta.intervalMonths), convention: String(row.meta?.convention ?? '') };
}

/* ------------------------------------------------------------------------- the subject --- */
export async function upsertSubject(c: Queryable, kind: SubjectKind, s: { id: string; code?: string; name?: string; status?: string; detail?: Row }) {
  await c.query(`INSERT INTO subjects(kind, id, code, name, status, detail) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (kind, id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, status = EXCLUDED.status, detail = EXCLUDED.detail, updated_at = now()`,
    [kind, String(s.id), s.code ?? '', s.name ?? '', s.status ?? 'ACTIVE', JSON.stringify(s.detail ?? {})]);
}
/** A subject by kind and id; a ship comes from the fleet snapshot, everything else from the subjects table. */
export async function findSubject(c: Queryable, kind: SubjectKind, id: string): Promise<SubjectRow | null> {
  if (kind === 'VESSEL') {
    const r = await c.query<Row>('SELECT * FROM vessels WHERE id = $1', [id]);
    const v = r.rows[0];
    return v ? { kind, id: String(v.id), code: v.imo ?? '', name: v.name ?? '', status: v.status ?? 'ACTIVE', detail: { imo: v.imo, flag: v.flag, type: v.type, built: v.built, grt: v.grt, agentCode: v.agent_code }, updated_at: v.updated_at } : null;
  }
  const r = await c.query<SubjectRow>('SELECT * FROM subjects WHERE kind = $1 AND id = $2', [kind, id]);
  return r.rows[0] ?? null;
}
export async function searchSubjects(c: Queryable, kind: SubjectKind, q: string, limit = 20): Promise<SubjectRow[]> {
  const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
  if (kind === 'VESSEL') {
    const r = await c.query<Row>(`SELECT * FROM vessels WHERE ($1 = '' OR name ILIKE $2 OR imo ILIKE $2) ORDER BY name LIMIT ${Math.min(100, limit)}`, [q, like]);
    return r.rows.map((v) => ({ kind, id: String(v.id), code: v.imo ?? '', name: v.name ?? '', status: v.status ?? 'ACTIVE', detail: { imo: v.imo, flag: v.flag, type: v.type }, updated_at: v.updated_at }));
  }
  return (await c.query<SubjectRow>(`SELECT * FROM subjects WHERE kind = $1 AND ($2 = '' OR name ILIKE $3 OR code ILIKE $3) ORDER BY name LIMIT ${Math.min(100, limit)}`, [kind, q, like])).rows;
}

/* ------------------------------------------------------------------------- the dossier --- */
export interface Dossier {
  subject: Row; portCall: Row | null;
  history: { inspections: number; lastInspectionAt: string | null; lastResult: string; detentions: number; lastDetentionAt: string | null; openFindings: { code: string; label: string; number: string; dueDate: string | null }[]; recurringCodes: { code: string; label: string; times: number }[] };
  prediction: Row | null; agentDossier: Row | null; checklist: { templateId: string | null; questions: number; critical: number };
  preparedAt: string; source: string;
}
/** What the boarding party holds before it boards: the subject as the register knows it, its history on this desk, what the model expects to find, and the sheet it will work. */
export async function assembleDossier(c: Queryable, i: InspectionRow, source: 'AUTO' | 'DESK', now = new Date()): Promise<Dossier> {
  const subject = (await findSubject(c, i.subject_kind as SubjectKind, i.subject_id ?? '')) ?? { kind: i.subject_kind, id: i.subject_id, code: '', name: i.subject_name, status: '', detail: {} };
  const call = i.port_call_id ? (await c.query<Row>('SELECT * FROM port_calls WHERE id = $1', [i.port_call_id])).rows[0] : null;
  const hist = await c.query<Row>(
    `SELECT count(*) FILTER (WHERE status = 'CLOSED') AS closed, count(*) FILTER (WHERE detention) AS detentions, max(closed_at) AS last_closed, max(closed_at) FILTER (WHERE detention) AS last_detention,
            (SELECT result FROM inspections x WHERE x.subject_kind = $2 AND x.subject_id = $3 AND x.status = 'CLOSED' AND x.id <> $1 ORDER BY closed_at DESC LIMIT 1) AS last_result
       FROM inspections i WHERE i.subject_kind = $2 AND i.subject_id = $3 AND i.id <> $1`, [i.id, i.subject_kind, i.subject_id]);
  const open = await c.query<Row>(
    `SELECT f.deficiency_code, f.deficiency_label, i.number, f.due_date FROM findings f JOIN inspections i ON i.id = f.inspection_id
      WHERE i.subject_kind = $1 AND i.subject_id = $2 AND f.status = 'OPEN' AND i.id <> $3 ORDER BY f.due_date NULLS LAST LIMIT 20`, [i.subject_kind, i.subject_id, i.id]);
  const recurring = await c.query<Row>(
    `SELECT f.deficiency_code, max(f.deficiency_label) AS label, count(*) AS n FROM findings f JOIN inspections i ON i.id = f.inspection_id
      WHERE i.subject_kind = $1 AND i.subject_id = $2 AND i.id <> $3 AND i.closed_at >= $4 GROUP BY f.deficiency_code HAVING count(*) >= 2 ORDER BY count(*) DESC LIMIT 8`, [i.subject_kind, i.subject_id, i.id, new Date(now.getTime() - 730 * 24 * H)]);
  const prediction = (await c.query<PredictionRow>('SELECT * FROM inspection_predictions WHERE inspection_id = $1', [i.id])).rows[0];
  const agent = i.vessel_id ? (await c.query<VesselPredictionRow>('SELECT * FROM vessel_predictions WHERE vessel_id = $1', [String(i.vessel_id)])).rows[0] : null;
  const h = hist.rows[0] ?? {};
  return {
    subject: { kind: subject.kind, id: subject.id, code: subject.code, name: subject.name, status: subject.status, ...(subject.detail ?? {}) },
    portCall: call ? { id: call.id, vcn: call.vcn, status: call.status, berthCode: call.berth_code, eta: iso(call.eta), atb: iso(call.atb) } : null,
    history: {
      inspections: Number(h.closed) || 0, lastInspectionAt: iso(h.last_closed), lastResult: String(h.last_result ?? ''), detentions: Number(h.detentions) || 0, lastDetentionAt: iso(h.last_detention),
      openFindings: open.rows.map((f) => ({ code: f.deficiency_code, label: f.deficiency_label, number: f.number, dueDate: iso(f.due_date) })),
      recurringCodes: recurring.rows.map((r) => ({ code: r.deficiency_code, label: r.label, times: Number(r.n) })),
    },
    prediction: prediction ? predictionApi(prediction) : null, agentDossier: agent?.dossier ?? null,
    checklist: { templateId: i.template_id, questions: (i.checklist ?? []).length, critical: (i.checklist ?? []).filter((x) => x.critical).length },
    preparedAt: now.toISOString(), source,
  };
}
export async function prepareDossier(c: Queryable, env: Env, i: InspectionRow, source: 'AUTO' | 'DESK', opts: { actor?: Actor; now?: Date } = {}): Promise<{ row: InspectionRow; dossier: Dossier }> {
  const now = opts.now ?? new Date();
  const dossier = await assembleDossier(c, i, source, now);
  const r = await c.query<InspectionRow>('UPDATE inspections SET dossier = $2, dossier_prepared_at = $3, dossier_source = $4, updated_at = now() WHERE id = $1 RETURNING *', [i.id, JSON.stringify(dossier), now, source]);
  const row = r.rows[0];
  await mark(c, row, 'DOSSIER_PREPARED', now, source, { openFindings: dossier.history.openFindings.length, prior: dossier.history.inspections });
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.inspection.dossierPrepared, { inspectionId: row.id, number: row.number, subjectKind: row.subject_kind, subjectName: row.subject_name, vesselName: row.vessel_name, source, preparedAt: now.toISOString(), priorInspections: dossier.history.inspections, openFindings: dossier.history.openFindings.length, scope: recordScope(row) }, { subject: row.id, actor: opts.actor }));
  return { row, dossier };
}

/* ---------------------------------------------------------------------- the prediction --- */
/** The prediction a survey carries before boarding: the Smart Inspection agent's latest judgement of the ship when it is fresh, this desk's own history rules otherwise. */
export async function recordPrediction(c: Queryable, env: Env, i: InspectionRow, opts: { now?: Date; freshDays?: number; actor?: Actor } = {}): Promise<PredictionRow> {
  const existing = (await c.query<PredictionRow>('SELECT * FROM inspection_predictions WHERE inspection_id = $1', [i.id])).rows[0];
  if (existing) return existing;
  const now = opts.now ?? new Date(); const fresh = (opts.freshDays ?? 45) * 24 * H;
  const agent = i.vessel_id ? (await c.query<VesselPredictionRow>('SELECT * FROM vessel_predictions WHERE vessel_id = $1', [String(i.vessel_id)])).rows[0] : null;
  let source = 'RULES'; let decisionId: string | null = null; let score: number; let band: string; let codes: string[]; let basis: Row;
  if (agent && now.getTime() - new Date(agent.predicted_at).getTime() <= fresh) {
    source = 'A5'; decisionId = agent.decision_id; score = Number(agent.risk_score) || 0; band = agent.band || bandOf(score); codes = agent.predicted_codes ?? []; basis = { agentId: agent.agent_id, predictedAt: iso(agent.predicted_at) };
  } else {
    const h = (await c.query<Row>(
      `SELECT count(*) FILTER (WHERE detention) AS detentions,
              (SELECT count(*) FROM findings f JOIN inspections x ON x.id = f.inspection_id WHERE x.subject_kind = $1 AND x.subject_id = $2 AND f.status = 'OPEN' AND x.id <> $3) AS open_findings,
              (SELECT count(*) FROM findings f JOIN inspections x ON x.id = f.inspection_id WHERE x.subject_kind = $1 AND x.subject_id = $2 AND x.id <> $3 AND x.closed_at >= $4) AS recent_findings
         FROM inspections i WHERE i.subject_kind = $1 AND i.subject_id = $2 AND i.id <> $3`, [i.subject_kind, i.subject_id, i.id, new Date(now.getTime() - 365 * 24 * H)])).rows[0] ?? {};
    const rec = await c.query<Row>(
      `SELECT f.deficiency_code, count(*) AS n FROM findings f JOIN inspections x ON x.id = f.inspection_id WHERE x.subject_kind = $1 AND x.subject_id = $2 AND x.id <> $3 AND x.closed_at >= $4 GROUP BY f.deficiency_code ORDER BY count(*) DESC, f.deficiency_code LIMIT 3`,
      [i.subject_kind, i.subject_id, i.id, new Date(now.getTime() - 730 * 24 * H)]);
    const detentions = Number(h.detentions) || 0; const open = Number(h.open_findings) || 0; const recent = Number(h.recent_findings) || 0;
    score = Math.min(100, 12 + detentions * 22 + open * 8 + recent * 4); band = bandOf(score); codes = rec.rows.map((r) => r.deficiency_code);
    basis = { detentions, openFindings: open, recentFindings: recent, rule: 'history' };
  }
  const r = await c.query<PredictionRow>(
    `INSERT INTO inspection_predictions(inspection_id, source, decision_id, predicted_at, risk_score, band, predicted_codes, basis) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
    [i.id, source, decisionId, now, score, band, JSON.stringify(codes), JSON.stringify(basis)]);
  const row = r.rows[0];
  await mark(c, i, 'PREDICTION_RECORDED', now, source, { band, riskScore: score, codes });
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.inspection.predictionRecorded, { inspectionId: i.id, number: i.number, subjectKind: i.subject_kind, subjectName: i.subject_name, source, band, riskScore: score, predictedCodes: codes, predictedAt: now.toISOString(), scope: recordScope(i) }, { subject: i.id, actor: opts.actor }));
  return row;
}
export const bandOf = (score: number) => (score >= 60 ? 'HIGH' : score >= 35 ? 'MEDIUM' : 'LOW');
/** Scores the prediction against what the survey found: a predicted code that was raised, or a band that agreed with whether anything was found at all. */
export async function scorePrediction(c: Queryable, env: Env, i: InspectionRow, findings: FindingApi[], opts: { now?: Date; actor?: Actor } = {}): Promise<PredictionRow | null> {
  const p = (await c.query<PredictionRow>('SELECT * FROM inspection_predictions WHERE inspection_id = $1 AND scored_at IS NULL FOR UPDATE', [i.id])).rows[0];
  if (!p) return null;
  const now = opts.now ?? new Date();
  const actual = [...new Set(findings.map((f) => f.deficiencyCode))];
  const matched = (p.predicted_codes ?? []).filter((code) => actual.includes(code));
  const bandAgrees = p.band === 'LOW' ? actual.length === 0 : actual.length > 0;
  const correlated = matched.length > 0 || bandAgrees;
  const outcome = { findings: actual.length, codes: actual, matched, bandAgrees, result: i.result, detention: i.detention };
  const r = await c.query<PredictionRow>('UPDATE inspection_predictions SET scored_at = $2, outcome = $3, correlated = $4, updated_at = now() WHERE id = $1 RETURNING *', [p.id, now, JSON.stringify(outcome), correlated]);
  await mark(c, i, 'PREDICTION_SCORED', now, p.source, { correlated, matched, band: p.band, findings: actual.length });
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.inspection.predictionScored, { inspectionId: i.id, number: i.number, source: p.source, band: p.band, correlated, matched, findings: actual.length, scoredAt: now.toISOString(), scope: recordScope(i) }, { subject: i.id, actor: opts.actor }));
  return r.rows[0];
}

/* ---------------------------------------------------------------- close-out classification --- */
export interface Classification { severity: (typeof SEVERITIES)[number]; recommendation: (typeof RECOMMENDATIONS)[number]; grounds: string; codes: string[] }
/** The severity model at close: what was found decides the class, and the class decides what the rules recommend. The officer decides; the rules only say. */
export function classify(findings: FindingApi[], score: { criticalFail: boolean }, result: string): Classification {
  const open = findings.filter((f) => f.status === 'OPEN');
  const detainable = findings.filter((f) => f.detainable || f.actionCode === DETAINABLE_ACTION);
  const major = open.filter((f) => f.severity === 'MAJOR');
  if (result === 'DETAINED' || detainable.length || score.criticalFail) {
    return { severity: 'CRITICAL', recommendation: 'DETAIN', codes: detainable.map((f) => f.deficiencyCode), grounds: detainable.length ? `Detainable deficiencies ${detainable.map((f) => f.deficiencyCode).join(', ')} found` : score.criticalFail ? 'A critical checklist item failed' : 'Closed as detained' };
  }
  if (open.length >= 5 || major.length >= 2) return { severity: 'MAJOR', recommendation: 'RESTRICT', codes: open.map((f) => f.deficiencyCode), grounds: `${open.length} deficiencies open at close, ${major.length} of them major` };
  if (open.length || findings.length) return { severity: major.length ? 'MAJOR' : 'MINOR', recommendation: 'RECTIFY', codes: open.map((f) => f.deficiencyCode), grounds: `${open.length} deficiencies to rectify` };
  return { severity: 'NONE', recommendation: 'NONE', codes: [], grounds: '' };
}

/* ------------------------------------------------------------ restriction recommendations --- */
export async function recommendRestriction(c: Queryable, env: Env, i: InspectionRow, input: { kind: string; source?: string; grounds: string; codes: string[] }, opts: { now?: Date; actor?: Actor; decidedNow?: { decision: string; detentionId?: string | null; by?: { id: string; name: string } } } = {}): Promise<RecommendationRow> {
  const now = opts.now ?? new Date();
  const d = opts.decidedNow;
  const r = await c.query<RecommendationRow>(
    `INSERT INTO restriction_recommendations(inspection_id, kind, source, grounds, finding_codes, recommended_at, recommended_by_id, recommended_by, routed_at, routed_to, decided_at, decided_by_id, decided_by, decision, decision_note, detention_id, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [i.id, input.kind, input.source ?? 'RULES', input.grounds, JSON.stringify(input.codes), now, opts.actor?.id ?? null, opts.actor?.name ?? 'Severity rules',
      d ? now : null, d ? 'inspections.close' : '', d ? now : null, d?.by?.id ?? null, d?.by?.name ?? '', d?.decision ?? '', d ? 'Decided at close-out by the closing officer' : '', d?.detentionId ?? null, d?.decision ?? 'PENDING']);
  const row = r.rows[0];
  await mark(c, i, 'RESTRICTION_RECOMMENDED', now, row.source, { recommendationId: row.id, kind: row.kind, codes: input.codes });
  if (d) { await mark(c, i, 'RESTRICTION_ROUTED', now, 'DESK', { recommendationId: row.id, via: 'close-out' }); await mark(c, i, 'RESTRICTION_DECIDED', now, 'DESK', { recommendationId: row.id, decision: d.decision }); }
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.inspection.restrictionRecommended, recommendationEvent(i, row), { subject: row.id, actor: opts.actor }));
  return row;
}
export const recommendationEvent = (i: InspectionRow, r: RecommendationRow) => ({
  recommendationId: r.id, inspectionId: i.id, number: i.number, subjectKind: i.subject_kind, subjectName: i.subject_name, vesselId: i.vessel_id, vesselName: i.vessel_name,
  kind: r.kind, source: r.source, grounds: r.grounds, findingCodes: r.finding_codes ?? [], recommendedAt: iso(r.recommended_at), status: r.status, decision: r.decision, decidedAt: iso(r.decided_at), scope: recordScope(i),
});
/** Stamps the moment the recommendation came back off the bus — the proof it reached the officers who subscribe to it. */
export async function routeRecommendation(c: Queryable, recommendationId: string, at: Date, eventId?: string): Promise<boolean> {
  const r = await c.query<RecommendationRow & { number: string }>(
    `UPDATE restriction_recommendations r SET routed_at = $2, routed_to = 'inspections.close', updated_at = now() FROM inspections i WHERE r.id::text = $1 AND i.id = r.inspection_id AND r.routed_at IS NULL RETURNING r.*, i.number`, [recommendationId, at]);
  const row = r.rows[0];
  if (!row) return false;
  await mark(c, { id: row.inspection_id, number: row.number }, 'RESTRICTION_ROUTED', at, 'BUS', { recommendationId: row.id, via: 'bus' }, eventId ? `${eventId}:routed` : undefined);
  return true;
}

/* ----------------------------------------------------------------- reports and notices --- */
export async function draftReport(c: Queryable, env: Env, i: InspectionRow, input: { source: string; title?: string; summary?: string; body: string; severity?: string; recommendation?: string; draftId?: string | null; by?: { id?: string | null; name: string }; at?: Date }, opts: { cause?: EventEnvelope; actor?: Actor } = {}): Promise<ReportRow> {
  const at = input.at ?? new Date();
  await c.query(`UPDATE inspection_reports SET status = 'SUPERSEDED', updated_at = now() WHERE inspection_id = $1 AND status = 'DRAFT'`, [i.id]);
  const v = await c.query<{ n: string }>('SELECT COALESCE(max(version), 0) + 1 AS n FROM inspection_reports WHERE inspection_id = $1', [i.id]);
  const r = await c.query<ReportRow>(
    `INSERT INTO inspection_reports(inspection_id, version, source, status, draft_id, title, summary, body, severity, recommendation, drafted_at, drafted_by_id, drafted_by)
     VALUES ($1,$2,$3,'DRAFT',$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [i.id, Number(v.rows[0].n), input.source, input.draftId ?? null, input.title ?? `Inspection report — ${i.number}`, input.summary ?? '', input.body, input.severity ?? i.severity ?? '', input.recommendation ?? i.recommendation ?? '', at, input.by?.id ?? null, input.by?.name ?? '']);
  const row = r.rows[0];
  await mark(c, i, 'REPORT_DRAFTED', at, input.source, { reportId: row.id, version: row.version, draftId: row.draft_id }, opts.cause ? `${opts.cause.id}:report` : undefined);
  const data = { reportId: row.id, inspectionId: i.id, number: i.number, subjectName: i.subject_name, vesselName: i.vessel_name, version: row.version, source: row.source, draftId: row.draft_id, title: row.title, draftedAt: iso(row.drafted_at), draftedBy: row.drafted_by, scope: recordScope(i) };
  await enqueue(c, opts.cause
    ? makeEvent({ type: EVENTS.inspection.reportDrafted, source: env.SERVICE_NAME, data, subject: i.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor })
    : eventFromContext(env.SERVICE_NAME, EVENTS.inspection.reportDrafted, data, { subject: i.id, actor: opts.actor }));
  return row;
}
export async function issueReport(c: Queryable, env: Env, i: InspectionRow, reportId: string, by: { id?: string | null; name: string }, opts: { now?: Date; actor?: Actor } = {}): Promise<ReportRow | null> {
  const now = opts.now ?? new Date();
  const r = await c.query<ReportRow>(`UPDATE inspection_reports SET status = 'ISSUED', issued_at = $3, issued_by_id = $4, issued_by = $5, updated_at = now() WHERE id::text = $1 AND inspection_id = $2 AND status = 'DRAFT' RETURNING *`, [reportId, i.id, now, by.id ?? null, by.name]);
  const row = r.rows[0];
  if (!row) return null;
  await mark(c, i, 'REPORT_ISSUED', now, row.source, { reportId: row.id, version: row.version });
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.inspection.reportIssued, { reportId: row.id, inspectionId: i.id, number: i.number, subjectName: i.subject_name, vesselName: i.vessel_name, version: row.version, source: row.source, issuedAt: now.toISOString(), issuedBy: row.issued_by, minutesAfterClose: i.closed_at ? Math.round((now.getTime() - new Date(i.closed_at).getTime()) / 60_000) : null, scope: recordScope(i) }, { subject: i.id, actor: opts.actor }));
  return row;
}
export async function nextNoticeNumber(c: Queryable, env: Env, at: Date): Promise<string> {
  const year = at.getUTCFullYear();
  const r = await c.query<{ last_value: string }>('INSERT INTO numbering_series(series, last_value) VALUES ($1, 1) ON CONFLICT (series) DO UPDATE SET last_value = numbering_series.last_value + 1 RETURNING last_value', [`${env.NOTICE_PREFIX}-${year}`]);
  return `${env.NOTICE_PREFIX}-${year}-${String(r.rows[0].last_value).padStart(4, '0')}`;
}
export async function draftNotice(c: Queryable, env: Env, i: InspectionRow, input: { kind: string; source: string; subject?: string; body: string; addressedTo?: string; findingIds?: string[]; draftId?: string | null; by?: { id?: string | null; name: string }; at?: Date }, opts: { cause?: EventEnvelope; actor?: Actor } = {}): Promise<NoticeRow> {
  const at = input.at ?? new Date();
  const number = await nextNoticeNumber(c, env, at);
  const r = await c.query<NoticeRow>(
    `INSERT INTO inspection_notices(inspection_id, number, kind, source, status, draft_id, addressed_to, subject, body, finding_ids, drafted_at, drafted_by_id, drafted_by)
     VALUES ($1,$2,$3,$4,'DRAFT',$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
    [i.id, number, input.kind, input.source, input.draftId ?? null, input.addressedTo ?? (i.subject_name || i.vessel_name), input.subject ?? `${input.kind === 'DETENTION' ? 'Notice of detention' : 'Deficiency notice'} — ${i.number}`, input.body, JSON.stringify(input.findingIds ?? []), at, input.by?.id ?? null, input.by?.name ?? '']);
  const row = r.rows[0];
  await mark(c, i, 'NOTICE_DRAFTED', at, input.source, { noticeId: row.id, kind: row.kind, number: row.number, minutesAfterClose: i.closed_at ? Math.round((at.getTime() - new Date(i.closed_at).getTime()) / 60_000) : null }, opts.cause ? `${opts.cause.id}:notice` : undefined);
  const data = { noticeId: row.id, inspectionId: i.id, number: i.number, noticeNumber: row.number, kind: row.kind, source: row.source, subjectName: i.subject_name, vesselName: i.vessel_name, draftedAt: iso(row.drafted_at), draftedBy: row.drafted_by, minutesAfterClose: i.closed_at ? Math.round((at.getTime() - new Date(i.closed_at).getTime()) / 60_000) : null, scope: recordScope(i) };
  await enqueue(c, opts.cause
    ? makeEvent({ type: EVENTS.inspection.noticeDrafted, source: env.SERVICE_NAME, data, subject: i.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor })
    : eventFromContext(env.SERVICE_NAME, EVENTS.inspection.noticeDrafted, data, { subject: i.id, actor: opts.actor }));
  return row;
}
export async function issueNotice(c: Queryable, env: Env, i: InspectionRow, noticeId: string, by: { id?: string | null; name: string }, opts: { now?: Date; actor?: Actor } = {}): Promise<NoticeRow | null> {
  const now = opts.now ?? new Date();
  const r = await c.query<NoticeRow>(`UPDATE inspection_notices SET status = 'ISSUED', issued_at = $3, issued_by_id = $4, issued_by = $5, updated_at = now() WHERE id::text = $1 AND inspection_id = $2 AND status = 'DRAFT' RETURNING *`, [noticeId, i.id, now, by.id ?? null, by.name]);
  const row = r.rows[0];
  if (!row) return null;
  await mark(c, i, 'NOTICE_ISSUED', now, row.source, { noticeId: row.id, kind: row.kind, number: row.number });
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.inspection.noticeIssued, { noticeId: row.id, inspectionId: i.id, number: i.number, noticeNumber: row.number, kind: row.kind, source: row.source, subjectName: i.subject_name, vesselName: i.vessel_name, addressedTo: row.addressed_to, issuedAt: now.toISOString(), issuedBy: row.issued_by, scope: recordScope(i) }, { subject: i.id, actor: opts.actor }));
  return row;
}

/* ---------------------------------------------------------------------- the overdue sweep --- */
/** Findings past their rectification date that have not been flagged in the last week: one event per survey, so the desk hears about a ship once, not once per deficiency. */
export async function sweepOverdueFindings(c: Queryable, env: Env, now = new Date(), cause?: EventEnvelope): Promise<{ inspections: number; findings: number }> {
  const r = await c.query<Row>(
    `SELECT i.id, i.number, i.subject_kind, i.subject_name, i.vessel_id, i.vessel_name, i.scope_port,
            json_agg(json_build_object('id', f.id, 'code', f.deficiency_code, 'label', f.deficiency_label, 'dueDate', f.due_date, 'daysOverdue', floor(extract(epoch FROM ($1::timestamptz - f.due_date)) / 86400)) ORDER BY f.due_date) AS findings
       FROM findings f JOIN inspections i ON i.id = f.inspection_id
      WHERE f.status = 'OPEN' AND f.due_date IS NOT NULL AND f.due_date < $1
        AND NOT EXISTS (SELECT 1 FROM inspection_timeline t WHERE t.inspection_id = i.id AND t.kind = 'FINDING_OVERDUE' AND t.at > $1::timestamptz - interval '7 days')
      GROUP BY i.id`, [now]);
  let findings = 0;
  for (const row of r.rows) {
    const list = (row.findings ?? []) as Row[];
    findings += list.length;
    await mark(c, { id: row.id, number: row.number }, 'FINDING_OVERDUE', now, 'SWEEP', { findingIds: list.map((f) => f.id), codes: list.map((f) => f.code) });
    const data = { inspectionId: row.id, number: row.number, subjectKind: row.subject_kind, subjectName: row.subject_name, vesselId: row.vessel_id, vesselName: row.vessel_name, findings: list.map((f) => ({ ...f, dueDate: iso(f.dueDate) })), count: list.length, scope: { port: row.scope_port || undefined } };
    await enqueue(c, cause
      ? makeEvent({ type: EVENTS.inspection.deficiencyOverdue, source: env.SERVICE_NAME, data, subject: row.id, correlationId: cause.correlationid, causationId: cause.id, actor: cause.actor })
      : eventFromContext(env.SERVICE_NAME, EVENTS.inspection.deficiencyOverdue, data, { subject: row.id }));
  }
  return { inspections: r.rows.length, findings };
}
