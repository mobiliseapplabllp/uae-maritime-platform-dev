/* Survey & Audit Cell API contract — the shapes the inspection service returns for the survey and checklist screens.
 * Populated refs become flat *Id / *Name fields, as in packages/world. */
export type InspectionStatus = 'PLANNED' | 'IN_PROGRESS' | 'CLOSED';
export type InspectionResult = 'SATISFACTORY' | 'DEFICIENCIES' | 'DETAINED';
export type Answer = 'YES' | 'NO' | 'NA' | '';
export type AnswerType = 'YES_NO' | 'YES_NO_NA' | 'TEXT' | 'NUMBER';
export interface ChecklistAnswer { seq: number; text: string; category: string; answer: Answer; note?: string }
export interface Finding { id: string; deficiencyCode: string; deficiencyLabel?: string; description: string; actionCode?: string; dueDate?: string | null; status: 'OPEN' | 'CLOSED'; closedAt?: string | null }
/** GET /inspections — one register row. */
export interface InspectionRow {
  id: string; number: string; vesselId: string; vesselName: string; vesselImo?: string; vesselFlag?: string; type: string; inspectorId?: string; inspector: string;
  plannedAt: string; startedAt?: string | null; closedAt?: string | null; status: InspectionStatus; result?: InspectionResult | '' | null; detention?: boolean; scorePct?: number | null;
  findings?: Finding[]; findingsCount?: number;
}
/** GET /inspections/:id — the survey with its checklist answers and findings. */
export interface Inspection extends InspectionRow { portCallId?: string | null; vcn?: string | null; templateId?: string | null; checklist: ChecklistAnswer[]; findings: Finding[]; remarks?: string }
export interface ChecklistItem { seq: number; text: string; category: string; answerType: AnswerType; weight: number; critical: boolean; guidance?: string }
/** GET /checklist-templates — a versioned template; surveys copy its questions when they are planned. */
export interface ChecklistTemplate { id?: string; name: string; inspectionType: string; description?: string; items: ChecklistItem[]; active: boolean; version: number; passScorePct: number }
/** POST /inspections */
export interface PlanInspectionPayload { vesselId: string; type: string; plannedAt: string; inspector: string; templateId?: string; portCallId?: string; remarks?: string }
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
