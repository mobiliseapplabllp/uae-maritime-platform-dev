/* The six Smart Inspection KPIs, measured from the platform's own events.
 *
 * The RFP commits the inspection domain to six figures inside eighteen months: every boarding party holds a
 * dossier before it boards; seven reports in ten are first drafted by the machine; eight deficiency notices in
 * ten are drafted within half an hour of the survey closing; the risk prediction made before boarding agrees
 * with what was found two times in three; a report takes half the time it took before; and every restriction
 * the rules recommend reaches the officer who decides it inside the hour.
 *
 * None of those is a number a service asserts about itself. Each is computed here from a timeline of dated
 * events the inspection service wrote as things happened — planned, boarded, closed, dossier prepared, report
 * drafted, notice drafted, restriction recommended and routed, prediction made and scored — so the same
 * evaluator gives the same answer in the inspection service and in reporting, and a figure that cannot be
 * measured yet says "not captured" rather than 0 or 100. Targets and windows come from the inspect module's
 * settings, never from here. */

export const INSPECTION_KPI_KEYS = ['dossierCoverage', 'aiReports', 'noticeSpeed', 'predictionCorrelation', 'reportTurnaround', 'restrictionRouting'] as const;
export type InspectionKpiKey = (typeof INSPECTION_KPI_KEYS)[number];

export const TIMELINE_KINDS = [
  'PLANNED', 'STARTED', 'CLOSED', 'DOSSIER_PREPARED', 'REPORT_DRAFTED', 'REPORT_ISSUED', 'NOTICE_DRAFTED', 'NOTICE_ISSUED',
  'RESTRICTION_RECOMMENDED', 'RESTRICTION_ROUTED', 'RESTRICTION_DECIDED', 'PREDICTION_RECORDED', 'PREDICTION_SCORED', 'FINDING_OVERDUE',
] as const;
export type TimelineKind = (typeof TIMELINE_KINDS)[number];

/** One dated fact about one survey. `source` says who did it — AI, MANUAL, RULES, A5, AUTO, DESK — and `meta` carries what the fact needs (findings at close, the correlation verdict, the reference of the record). */
export interface KpiTimelineRow { inspectionId: string; number?: string; kind: TimelineKind | string; at: string | Date; source?: string; meta?: Record<string, unknown> }

export interface KpiTargets {
  /** ISO date the programme started; empty means the day of the first instrumented event. */ programmeStart: string | null;
  programmeMonths: number;
  dossierTargetPct: number; aiReportTargetPct: number; noticeTargetPct: number; noticeMinutes: number;
  predictionTargetPct: number; predictionWindowMonths: number; reportReductionTargetPct: number;
  /** The manual-era median in minutes; 0 means "measure it from the manual reports on the platform". */ reportBaselineMinutes: number;
  restrictionTargetPct: number; restrictionMinutes: number;
}
export type KpiStatus = 'MET' | 'ON_TRACK' | 'BEHIND' | 'NOT_CAPTURED';
export interface KpiResult {
  key: InspectionKpiKey; label: string; target: number; unit: '%';
  /** The measured figure, or null when it cannot be measured yet. */ value: number | null;
  /** What the linear ramp asks for on the day: the target once the programme has run its course. */ required: number;
  status: KpiStatus; numerator: number; denominator: number; detail: string;
  /** Turnaround only: the two medians the reduction is computed from, in minutes. */ baselineMinutes?: number | null; currentMinutes?: number | null;
}
export interface KpiProgramme { start: string; end: string; monthsTotal: number; monthsElapsed: number; pct: number }
export interface KpiTrendPoint { month: string; key: string; dossierCoverage: number | null; aiReports: number | null; noticeSpeed: number | null; predictionCorrelation: number | null; restrictionRouting: number | null; reportTurnaroundMinutes: number | null; closed: number }
export interface InspectionKpiReport { programme: KpiProgramme; kpis: KpiResult[]; trend: KpiTrendPoint[]; asOf: string }

/** The programme's defaults, so a caller with no settings service still measures against the RFP figures. */
export const DEFAULT_KPI_TARGETS: KpiTargets = {
  programmeStart: null, programmeMonths: 18, dossierTargetPct: 100, aiReportTargetPct: 70, noticeTargetPct: 80, noticeMinutes: 30,
  predictionTargetPct: 65, predictionWindowMonths: 12, reportReductionTargetPct: 50, reportBaselineMinutes: 0, restrictionTargetPct: 100, restrictionMinutes: 60,
};
export const KPI_LABELS: Record<InspectionKpiKey, string> = {
  dossierCoverage: 'Dossier before boarding', aiReports: 'Reports first drafted by AI', noticeSpeed: 'Notices drafted within the window',
  predictionCorrelation: 'Predictions that matched the findings', reportTurnaround: 'Report time reduced', restrictionRouting: 'Restrictions routed within the hour',
};
/** Reads the inspect module's settings into targets; anything missing or unreadable falls back to the programme default. */
export function kpiTargetsFrom(settings: Record<string, unknown> | null | undefined): KpiTargets {
  const s = settings ?? {};
  const n = (k: string, d: number) => { const v = Number(s[k]); return Number.isFinite(v) && v >= 0 && s[k] !== '' && s[k] != null ? v : d; };
  const start = typeof s.kpiProgrammeStart === 'string' && s.kpiProgrammeStart.trim() ? s.kpiProgrammeStart.trim() : null;
  return {
    programmeStart: start && !Number.isNaN(new Date(start).getTime()) ? start : null,
    programmeMonths: n('kpiProgrammeMonths', 18) || 18, dossierTargetPct: n('kpiDossierTargetPct', 100), aiReportTargetPct: n('kpiAiReportTargetPct', 70),
    noticeTargetPct: n('kpiNoticeTargetPct', 80), noticeMinutes: n('kpiNoticeMinutes', 30) || 30, predictionTargetPct: n('kpiPredictionTargetPct', 65),
    predictionWindowMonths: n('kpiPredictionWindowMonths', 12) || 12, reportReductionTargetPct: n('kpiReportReductionTargetPct', 50),
    reportBaselineMinutes: n('kpiReportBaselineMinutes', 0), restrictionTargetPct: n('kpiRestrictionTargetPct', 100), restrictionMinutes: n('kpiRestrictionMinutes', 60) || 60,
  };
}

const MIN = 60_000;
const ms = (v: string | Date) => new Date(v).getTime();
const median = (xs: number[]): number | null => { if (!xs.length) return null; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (num: number, den: number) => (den ? Math.round((num / den) * 1000) / 10 : null);
const monthKey = (d: Date) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
const monthLabel = (d: Date) => `${d.toLocaleString('en-GB', { month: 'short', timeZone: 'UTC' })} ${String(d.getUTCFullYear()).slice(2)}`;
const addMonths = (d: Date, n: number) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, d.getUTCDate()));
const monthsBetween = (a: Date, b: Date) => (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth()) + (b.getUTCDate() - a.getUTCDate()) / 30;

interface Survey {
  id: string; planned?: number; started?: number; closed?: number; findingsAtClose: number; result?: string;
  dossier?: number; reports: { at: number; source: string }[]; issued?: number; notices: { at: number; source: string }[];
  recommendations: { at: number; routed?: number; decided?: number; id?: string }[]; predicted?: number; scored?: { at: number; correlated: boolean };
}
/** Folds the timeline into one record per survey, earliest fact winning where only one is wanted. */
function fold(rows: KpiTimelineRow[]): Map<string, Survey> {
  const by = new Map<string, Survey>();
  const of = (id: string) => { let s = by.get(id); if (!s) { s = { id, findingsAtClose: 0, reports: [], notices: [], recommendations: [] }; by.set(id, s); } return s; };
  const sorted = [...rows].sort((a, b) => ms(a.at) - ms(b.at));
  for (const r of sorted) {
    const s = of(r.inspectionId); const at = ms(r.at); const meta = r.meta ?? {};
    switch (r.kind) {
      case 'PLANNED': s.planned = s.planned ?? at; break;
      case 'STARTED': s.started = s.started ?? at; break;
      case 'CLOSED': s.closed = s.closed ?? at; s.findingsAtClose = Number(meta.findings ?? s.findingsAtClose) || 0; s.result = String(meta.result ?? s.result ?? ''); break;
      case 'DOSSIER_PREPARED': s.dossier = s.dossier ?? at; break;
      case 'REPORT_DRAFTED': s.reports.push({ at, source: String(r.source ?? 'MANUAL') }); break;
      case 'REPORT_ISSUED': s.issued = s.issued ?? at; break;
      case 'NOTICE_DRAFTED': s.notices.push({ at, source: String(r.source ?? 'MANUAL') }); break;
      case 'RESTRICTION_RECOMMENDED': s.recommendations.push({ at, id: String(meta.recommendationId ?? '') }); break;
      case 'RESTRICTION_ROUTED': { const rec = s.recommendations.find((x) => (meta.recommendationId ? x.id === String(meta.recommendationId) : x.routed === undefined)); if (rec && rec.routed === undefined) rec.routed = at; break; }
      case 'RESTRICTION_DECIDED': { const rec = s.recommendations.find((x) => (meta.recommendationId ? x.id === String(meta.recommendationId) : x.decided === undefined)); if (rec && rec.decided === undefined) rec.decided = at; break; }
      case 'PREDICTION_RECORDED': s.predicted = s.predicted ?? at; break;
      case 'PREDICTION_SCORED': s.scored = s.scored ?? { at, correlated: meta.correlated === true || meta.correlated === 'true' }; break;
      default: break;
    }
  }
  return by;
}

/** The programme's clock: where the eighteen months stand on the day, from the configured start or the first fact on record. */
export function kpiProgramme(rows: KpiTimelineRow[], targets: KpiTargets, now = new Date()): KpiProgramme {
  const first = rows.length ? new Date(Math.min(...rows.map((r) => ms(r.at)))) : now;
  const start = targets.programmeStart ? new Date(targets.programmeStart) : first;
  const end = addMonths(start, targets.programmeMonths);
  const elapsed = Math.max(0, Math.min(targets.programmeMonths, monthsBetween(start, now)));
  return { start: start.toISOString(), end: end.toISOString(), monthsTotal: targets.programmeMonths, monthsElapsed: Math.round(elapsed * 10) / 10, pct: Math.round((elapsed / targets.programmeMonths) * 100) };
}

/** What the linear ramp asks for today: the full target once the programme has run, a proportional share before that. */
export const requiredToday = (target: number, programme: KpiProgramme) => Math.round(target * Math.min(1, programme.monthsElapsed / programme.monthsTotal) * 10) / 10;

function statusOf(value: number | null, target: number, required: number): KpiStatus {
  if (value === null) return 'NOT_CAPTURED';
  if (value >= target) return 'MET';
  if (value >= required) return 'ON_TRACK';
  return 'BEHIND';
}

/** Measures the six KPIs over the surveys in the programme window (predictions over their own trailing window). */
export function evaluateInspectionKpis(rows: KpiTimelineRow[], targets: KpiTargets = DEFAULT_KPI_TARGETS, now = new Date()): InspectionKpiReport {
  const programme = kpiProgramme(rows, targets, now);
  const from = ms(programme.start); const to = now.getTime();
  const all = [...fold(rows).values()];
  const inWindow = (t?: number) => t !== undefined && t >= from && t <= to;

  // 1. dossier coverage — of the surveys boarded in the window, how many had a dossier before the boarding party went up the gangway
  const boarded = all.filter((s) => inWindow(s.started));
  const withDossier = boarded.filter((s) => s.dossier !== undefined && s.dossier <= s.started!);
  // 2. AI-first reports — of the surveys closed in the window that have a report, how many had their first draft written by the machine
  const closed = all.filter((s) => inWindow(s.closed));
  const reported = closed.filter((s) => s.reports.length);
  const aiFirst = reported.filter((s) => s.reports[0].source === 'AI');
  // 3. notice speed — of the surveys closed with findings, how many had an AI-drafted notice inside the window after closing
  const withFindings = closed.filter((s) => s.findingsAtClose > 0);
  const noticeLimit = targets.noticeMinutes * MIN;
  const noticed = withFindings.filter((s) => s.notices.some((n) => n.source === 'AI' && n.at <= s.closed! + noticeLimit));
  const noticedAny = withFindings.filter((s) => s.notices.some((n) => n.at <= s.closed! + noticeLimit));
  // 4. prediction correlation — of the predictions scored in the trailing window, how many agreed with what was found
  const predFrom = addMonths(now, -targets.predictionWindowMonths).getTime();
  const scored = all.filter((s) => s.scored && s.scored.at >= predFrom && s.scored.at <= to);
  const correlated = scored.filter((s) => s.scored!.correlated);
  // 5. report turnaround — the median minutes from closing to the report going out, against the manual-era median
  const turnaround = (s: Survey) => { const out = s.issued ?? (s.reports.length ? s.reports[s.reports.length - 1].at : undefined); return out !== undefined && s.closed !== undefined && out >= s.closed ? (out - s.closed) / MIN : null; };
  const current = median(closed.map(turnaround).filter((x): x is number => x !== null));
  const manualBaseline = median(all.filter((s) => s.reports.length && s.reports[0].source !== 'AI').map(turnaround).filter((x): x is number => x !== null));
  const baseline = targets.reportBaselineMinutes > 0 ? targets.reportBaselineMinutes : manualBaseline;
  const reduction = current !== null && baseline !== null && baseline > 0 ? Math.round((1 - current / baseline) * 1000) / 10 : null;
  // 6. restriction routing — of the restrictions recommended in the window, how many reached the deciding officer inside the hour
  const recs = all.flatMap((s) => s.recommendations.filter((r) => inWindow(r.at)));
  const routed = recs.filter((r) => r.routed !== undefined && r.routed <= r.at + targets.restrictionMinutes * MIN);

  const make = (key: InspectionKpiKey, target: number, value: number | null, numerator: number, denominator: number, detail: string, extra: Partial<KpiResult> = {}): KpiResult => {
    const required = requiredToday(target, programme);
    return { key, label: KPI_LABELS[key], target, unit: '%', value, required, status: statusOf(value, target, required), numerator, denominator, detail, ...extra };
  };
  const kpis: KpiResult[] = [
    make('dossierCoverage', targets.dossierTargetPct, pct(withDossier.length, boarded.length), withDossier.length, boarded.length, boarded.length ? `${withDossier.length} of ${boarded.length} boardings held a dossier before the party boarded` : 'No survey has been boarded in the programme window yet'),
    make('aiReports', targets.aiReportTargetPct, pct(aiFirst.length, reported.length), aiFirst.length, reported.length, reported.length ? `${aiFirst.length} of ${reported.length} reports were first drafted by the assistant` : closed.length ? 'Surveys have closed but no report has been drafted on the platform yet' : 'No survey has closed in the programme window yet'),
    make('noticeSpeed', targets.noticeTargetPct, pct(noticed.length, withFindings.length), noticed.length, withFindings.length, withFindings.length ? `${noticed.length} of ${withFindings.length} surveys with findings had an AI-drafted notice within ${targets.noticeMinutes} min (${noticedAny.length} within the window from any source)` : 'No survey with findings has closed in the programme window yet'),
    make('predictionCorrelation', targets.predictionTargetPct, pct(correlated.length, scored.length), correlated.length, scored.length, scored.length ? `${correlated.length} of ${scored.length} predictions scored in the last ${targets.predictionWindowMonths} months agreed with the findings` : `No prediction has been scored against a closed survey in the last ${targets.predictionWindowMonths} months`),
    make('reportTurnaround', targets.reportReductionTargetPct, reduction, closed.filter((s) => turnaround(s) !== null).length, closed.length,
      reduction === null
        ? (current === null ? 'No report has gone out on a survey closed in the programme window yet' : 'No baseline: set the manual-era median in the module settings, or record manual reports the platform can measure')
        : `median ${Math.round(current!)} min from closing to report, against a baseline of ${Math.round(baseline!)} min${targets.reportBaselineMinutes > 0 ? ' (configured)' : ' (measured from manual reports)'}`,
      { baselineMinutes: baseline, currentMinutes: current }),
    make('restrictionRouting', targets.restrictionTargetPct, pct(routed.length, recs.length), routed.length, recs.length, recs.length ? `${routed.length} of ${recs.length} recommendations reached the deciding officer within ${targets.restrictionMinutes} min` : 'No restriction has been recommended in the programme window yet'),
  ];

  // the trailing twelve months, month by month, so the dashboard can show the direction of travel
  const trend: KpiTrendPoint[] = [];
  for (let k = 11; k >= 0; k -= 1) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - k, 1)); const key = monthKey(d);
    const inMonth = (t?: number) => t !== undefined && monthKey(new Date(t)) === key;
    const b = all.filter((s) => inMonth(s.started)); const c = all.filter((s) => inMonth(s.closed)); const cr = c.filter((s) => s.reports.length); const cf = c.filter((s) => s.findingsAtClose > 0);
    const sc = all.filter((s) => s.scored && inMonth(s.scored.at)); const rr = all.flatMap((s) => s.recommendations.filter((r) => inMonth(r.at)));
    trend.push({
      month: monthLabel(d), key, closed: c.length,
      dossierCoverage: pct(b.filter((s) => s.dossier !== undefined && s.dossier <= s.started!).length, b.length),
      aiReports: pct(cr.filter((s) => s.reports[0].source === 'AI').length, cr.length),
      noticeSpeed: pct(cf.filter((s) => s.notices.some((n) => n.source === 'AI' && n.at <= s.closed! + noticeLimit)).length, cf.length),
      predictionCorrelation: pct(sc.filter((s) => s.scored!.correlated).length, sc.length),
      restrictionRouting: pct(rr.filter((r) => r.routed !== undefined && r.routed <= r.at + targets.restrictionMinutes * MIN).length, rr.length),
      reportTurnaroundMinutes: (() => { const m = median(c.map(turnaround).filter((x): x is number => x !== null)); return m === null ? null : Math.round(m); })(),
    });
  }
  return { programme, kpis, trend, asOf: now.toISOString() };
}
