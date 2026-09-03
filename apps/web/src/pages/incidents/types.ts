/* Incident Desk API contract — the shapes the maritime-centre service returns for the case-file screens.
 * Populated refs become flat *Id / *Name fields, as in packages/world; threads (comms, documents, tasks, log) come only with the case file. */
import type { IncidentStatus } from '@maritime/contracts';

export type { IncidentStatus };
export type IncidentSeverity = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type IncidentPriority = 'P1' | 'P2' | 'P3' | 'P4';
export type CommDirection = 'IN' | 'OUT' | 'INTERNAL';
export interface IncidentComm { id: string; at: string; by: string; channel: string; direction: CommDirection; message: string }
export interface IncidentDoc { id: string; name: string; docType: string; sizeKB: number; uploadedBy: string; at: string; note?: string }
export interface IncidentTask { id: string; title: string; assignee?: string; due?: string | null; status: 'OPEN' | 'DONE'; doneAt?: string | null }
export interface IncidentLogEntry { at: string; by: string; entry: string }
export interface IncidentHistoryEntry { from: string; to: string; at: string; by: string; note?: string }
export interface IncidentRca { rootCause?: string; category?: string; correctiveAction?: string; preventiveAction?: string }
/** GET /incidents — one register row (threads omitted). */
export interface IncidentRow {
  id: string; number: string; category: string; type: string; severity: IncidentSeverity; priority: IncidentPriority; status: IncidentStatus; title: string;
  vesselId?: string | null; vesselName?: string; berthId?: string | null; berthCode?: string; berthTerminal?: string; location?: { area?: string; lat?: number; lon?: number } | null;
  reportedAt: string; reportedBy?: string; source: string; assignedToId?: string | null; assignedTo?: string;
}
/** GET /incidents/:id — the full case file. */
export interface Incident extends IncidentRow {
  description?: string; assets?: string[]; injuries?: number; pollutionTier?: number; weather?: { windKn?: number; seaState?: number } | null;
  comms: IncidentComm[]; documents: IncidentDoc[]; tasks: IncidentTask[]; log: IncidentLogEntry[]; statusHistory: IncidentHistoryEntry[]; rca?: IncidentRca | null;
  acknowledgedAt?: string | null; resolvedAt?: string | null; closedAt?: string | null; outcome?: string;
}
/** POST /incidents */
export interface ReportIncidentPayload { title: string; category: string; type: string; severity?: string; source?: string; vesselId?: string; vesselName?: string; berthId?: string; location?: { area: string }; reportedBy?: string; description?: string }
/** POST /incidents/:id/transition */
export interface TransitionPayload { to: IncidentStatus; note?: string }
/** GET /incidents/dashboard */
export interface IncidentMonth { month: string; LOW: number; MEDIUM: number; HIGH: number; CRITICAL: number; total: number }
export interface IncidentDashboardData {
  sla?: { mttaTargetMin: number; mttrTargetHrs: number };
  kpis: { open: number; highOpen: number; loggedYtd: number; closedYtd: number; mttrHrs: number; mttaMin: number; injuriesYtd: number };
  byMonth: IncidentMonth[]; byType: { type: string; count: number }[]; byCategory: { category: string; count: number }[]; byStatus: { status: string; count: number }[];
  aging: { bucket: string; count: number }[];
  openList: { id: string; number: string; title: string; severity: IncidentSeverity; status: IncidentStatus; reportedAt: string; priority?: IncidentPriority; assignedTo?: string }[];
}
/** GET /incidents/risk-matrix?days= */
export interface MatrixCell { likelihood: number; consequence: number; count: number; sample: { id: string; number: string; title: string; status: string }[] }
export interface RiskMatrixData { days: number; total: number; initial: MatrixCell[]; residual: MatrixCell[] }
export interface VesselOption { id: string; name: string; imo?: string }
export interface BerthOption { id: string; code: string; terminal?: string }
export interface LookupOption { id: string; code: string; label: string }
