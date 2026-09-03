/* AI Agent Operations API contract — the shapes the ai-agents service returns for the agent console and the
 * append-only decision register. Ids are `id`; `agentId` is the agent's stable key used in every path and filter. */
export type AutonomyLevel = 'SUPERVISED' | 'ASSISTED' | 'AUTONOMOUS';
export type Disposition = 'AUTO_APPLIED' | 'ESCALATED' | 'AWAITING_REVIEW' | 'APPROVED_BY_HUMAN' | 'OVERRIDDEN' | 'REJECTED_BY_HUMAN';

export interface AgentStats { decisions: number; autoApplied: number; escalated: number; overridden: number; avgConfidence: number; lastRunAt?: string | null }
export interface AgentChange { field: string; from: string; to: string; at: string; by: string; reason?: string }
/** GET /agents — one roster card. `agreementRate` is derived by the service (null until a decision has been reviewed). */
export interface AgentRow {
  id: string; agentId: string; name: string; role: string; domain?: number; enabled: boolean; autonomyLevel: AutonomyLevel;
  confidenceThreshold: number; maxActionsPerHour: number; escalateTo?: string;
  schedule?: { cadence: string; cron?: string; timezone?: string };
  suspended: boolean; suspendedReason?: string; suspendedBy?: string; suspendedAt?: string | null;
  stats?: AgentStats; agreementRate?: number | null;
}
/** GET /agents/:agentId — the agent with its governance history and its last decisions. */
export interface Agent extends AgentRow { changes?: AgentChange[]; recentDecisions?: AiDecision[] }
export interface AiFactor { factor: string; weight?: number; value?: string | number | null; contribution?: number }
/** GET /agents/decisions — one recorded decision. A review never rewrites this row; it writes a superseding one. */
export interface AiDecision {
  id: string; agentId: string; agentName?: string; action: string; subjectType?: string; subjectId?: string; subjectLabel?: string;
  inputs?: Record<string, unknown>; output?: Record<string, unknown>; explanation?: string; factors?: AiFactor[];
  confidence?: number; autonomyLevel?: AutonomyLevel; threshold?: number; disposition: Disposition; escalationReason?: string;
  reviewedById?: string | null; reviewedBy?: string; reviewedAt?: string | null; overrideReason?: string; supersedesId?: string | null;
  modelId?: string; modelVersion?: string; latencyMs?: number; at: string;
}
/** GET /agents/dashboard — the console header and the per-agent performance series. */
export interface AgentDashboardData {
  agents: number; active: number; suspended: number; byLevel: { level: AutonomyLevel; count: number }[];
  decisions: number; decisions30d: number; autoAppliedPct: number; pendingReview: number; agreementRate: number | null; avgConfidence: number;
  perAgent: { agentId: string; name: string; autonomyLevel: AutonomyLevel; suspended: boolean; decisions: number; escalated: number; overridden: number; agreementRate: number | null }[];
}
/** PUT /agents/:agentId — raising autonomy requires a written reason, enforced server-side. */
export interface ConfigurePayload { autonomyLevel: AutonomyLevel; confidenceThreshold: number; enabled: boolean; reason?: string }
/** POST /agents/:agentId/suspend */
export interface SuspendPayload { suspended: boolean; reason: string }
/** POST /agents/:agentId/run — an on-demand pass over the records the agent is responsible for. */
export interface RunResult { ran: string; recorded: number; byDisposition: Partial<Record<Disposition, number>>; decisions?: AiDecision[] }
/** POST /agents/decisions/:id/review */
export interface ReviewPayload { accept: boolean; reason: string }
