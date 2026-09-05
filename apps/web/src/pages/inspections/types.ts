/* Survey & Audit Cell API contract — the shapes the inspection service returns for the survey and checklist screens.
 * Populated refs become flat *Id / *Name fields, as in packages/world. */
export type InspectionStatus = 'PLANNED' | 'IN_PROGRESS' | 'CLOSED';
export type InspectionResult = 'SATISFACTORY' | 'DEFICIENCIES' | 'DETAINED';
export type Answer = 'YES' | 'NO' | 'NA' | '';
export type AnswerType = 'YES_NO' | 'YES_NO_NA' | 'TEXT' | 'NUMBER';
export interface ChecklistAnswer { seq: number; text: string; category: string; answer: Answer; note?: string }
export interface Finding { id: string; deficiencyCode: string; deficiencyLabel?: string; description: string; actionCode?: string; dueDate?: string | null; status: 'OPEN' | 'CLOSED'; closedAt?: string | null }
/** Who or what a survey is raised against — the regime master says which kind each regime applies to. */
export type SubjectKind = 'VESSEL' | 'COMPANY' | 'PORT_FACILITY' | 'MET_INSTITUTION';
/** GET /inspections — one register row. */
export interface InspectionRow {
  id: string; number: string; vesselId: string | null; vesselName: string; vesselImo?: string; vesselFlag?: string; type: string; regime?: string; inspectorId?: string; inspector: string;
  subjectKind?: SubjectKind; subjectId?: string | null; subjectName?: string;
  plannedAt: string; startedAt?: string | null; closedAt?: string | null; status: InspectionStatus; result?: InspectionResult | '' | null; detention?: boolean; scorePct?: number | null;
  findings?: Finding[]; findingsCount?: number;
  dossierPreparedAt?: string | null; dossierSource?: string; hasDossier?: boolean; severity?: string; recommendation?: string;
}
/** GET /inspections/subjects — a subject a survey can be planned against. */
export interface SubjectOption { kind: SubjectKind; id: string; code: string; name: string; status: string; detail?: Record<string, unknown> }
/** The dossier the boarding party holds before it boards. */
export interface Dossier {
  subject: Record<string, unknown> & { kind?: string; name?: string; code?: string }; portCall?: { vcn?: string; berthCode?: string | null; eta?: string | null; atb?: string | null } | null;
  history: { inspections: number; lastInspectionAt: string | null; lastResult: string; detentions: number; lastDetentionAt: string | null; openFindings: { code: string; label: string; number: string; dueDate: string | null }[]; recurringCodes: { code: string; label: string; times: number }[] };
  prediction?: { source: string; band: string; riskScore: number | null; predictedCodes: string[] } | null; agentDossier?: Record<string, unknown> | null;
  checklist?: { templateId: string | null; questions: number; critical: number }; preparedAt: string; source: string;
}
export interface InspectionReport { id: string; version: number; source: 'AI' | 'MANUAL' | string; status: 'DRAFT' | 'ISSUED' | 'SUPERSEDED' | string; draftId?: string | null; title: string; summary: string; body: string; severity: string; recommendation: string; draftedAt: string; draftedBy: string; issuedAt: string | null; issuedBy: string; aiDrafted: boolean }
export interface InspectionNotice { id: string; number: string; kind: string; source: string; status: 'DRAFT' | 'ISSUED' | 'WITHDRAWN' | string; addressedTo: string; subject: string; body: string; findingIds: string[]; draftedAt: string; draftedBy: string; issuedAt: string | null; issuedBy: string; aiDrafted: boolean }
export interface RestrictionRecommendation { id: string; kind: string; source: string; grounds: string; findingCodes: string[]; recommendedAt: string; recommendedBy: string; routedAt: string | null; decidedAt: string | null; decidedBy: string; decision: string; decisionNote: string; detentionId: string | null; status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'DEFERRED' | string; routedMinutes: number | null; decidedMinutes: number | null; number?: string; subjectName?: string; subjectKind?: string }
export interface InspectionPrediction { id: string; source: string; decisionId: string | null; predictedAt: string; riskScore: number | null; band: string; predictedCodes: string[]; basis: Record<string, unknown>; scoredAt: string | null; outcome: { findings?: number; codes?: string[]; matched?: string[]; bandAgrees?: boolean } | null; correlated: boolean | null }
export interface TimelineEntry { id: string; kind: string; at: string; source: string; meta: Record<string, unknown> }
/** GET /inspections/:id — the survey with its checklist answers, findings and the Smart Inspection records. */
export interface Inspection extends InspectionRow {
  portCallId?: string | null; vcn?: string | null; templateId?: string | null; checklist: ChecklistAnswer[]; findings: Finding[]; remarks?: string;
  dossier?: Dossier | null; reports?: InspectionReport[]; notices?: InspectionNotice[]; recommendations?: RestrictionRecommendation[]; prediction?: InspectionPrediction | null; timeline?: TimelineEntry[];
  detentionRecord?: { id: string; status: string; orderedAt: string; releasedAt?: string | null } | null;
}
/** GET /inspections/kpis — the six programme KPIs, measured from the survey desk's timeline. */
export type KpiStatus = 'MET' | 'ON_TRACK' | 'BEHIND' | 'NOT_CAPTURED';
export interface KpiResult { key: string; label: string; target: number; unit: string; value: number | null; required: number; status: KpiStatus; numerator: number; denominator: number; detail: string; baselineMinutes?: number | null; currentMinutes?: number | null }
export interface InspectionKpis {
  programme: { start: string; end: string; monthsTotal: number; monthsElapsed: number; pct: number };
  kpis: KpiResult[];
  trend: { month: string; key: string; closed: number; dossierCoverage: number | null; aiReports: number | null; noticeSpeed: number | null; predictionCorrelation: number | null; restrictionRouting: number | null; reportTurnaroundMinutes: number | null }[];
  asOf: string; targets: Record<string, unknown>;
}
export interface ChecklistItem { seq: number; text: string; category: string; answerType: AnswerType; weight: number; critical: boolean; guidance?: string }
/** GET /checklist-templates — a versioned template; surveys copy its questions when they are planned. */
export interface ChecklistTemplate { id?: string; name: string; inspectionType: string; description?: string; items: ChecklistItem[]; active: boolean; version: number; passScorePct: number }
/** POST /inspections — a ship by `vesselId`, or any other subject the regime applies to by `subjectId`. */
export interface PlanInspectionPayload { vesselId?: string; subjectKind?: SubjectKind; subjectId?: string; type: string; plannedAt: string; inspector: string; templateId?: string; portCallId?: string; remarks?: string }
/** POST/PUT /inspections/:id/findings[/:findingId] */
export interface FindingPayload { deficiencyCode: string; description: string; actionCode?: string; dueDate?: string; status?: 'OPEN' | 'CLOSED' }
/** POST /inspections/:id/close */
export interface ClosePayload { result: InspectionResult; remarks?: string }
/** GET /inspections/dashboard */
export interface InspectionDashboardData {
  kpis: { open: number; closedYtd: number; satisfactionPct: number; detentionRatePct: number; avgFindings: number; openFindings: number; checklistCompliancePct: number };
  byMonth: { month: string; SATISFACTORY: number; DEFICIENCIES: number; DETAINED: number }[];
  byType: { type: string; total: number; closed: number; detained: number }[];
}
export interface VesselOption { id: string; name: string; imo?: string }
export interface LookupOption { id: string; code: string; label: string }
