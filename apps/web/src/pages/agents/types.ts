/* AI Agent Operations API contract — the shapes the ai-agents service returns for the agent console, the
 * append-only decision register and the assurance reports. Ids are `id`; `agentId` is the agent's stable key
 * used in every path and filter. Field names follow the service exactly (registry.agentApi, decisions.decisionApi,
 * metrics.performance / drift / bias / serviceLevels). */

export type AutonomyLevel = 'SUPERVISED' | 'ASSISTED' | 'AUTONOMOUS';
export type Effect = 'ADVISORY' | 'REVERSIBLE' | 'IRREVERSIBLE';
export type Disposition = 'AUTO_APPLIED' | 'ESCALATED' | 'AWAITING_REVIEW' | 'APPROVED_BY_HUMAN' | 'OVERRIDDEN' | 'REJECTED_BY_HUMAN';
export type ReviewStatus = 'AUTO' | 'PENDING' | 'REVIEWED' | 'OVERRIDDEN';
/** Why the ladder refused to let an agent act on its own conclusion — one code per rule in the runtime. */
export type EscalationCode = 'BELOW_THRESHOLD' | 'OUTSIDE_AUTONOMY' | 'IRREVERSIBLE_EFFECT' | 'CONFIRMATION_REQUIRED' | 'AGENT_SUSPENDED' | 'AGENT_DISABLED' | 'RATE_LIMIT' | 'BELOW_FLOOR';

export interface AgentStats { decisions: number; autoApplied: number; escalated: number; awaitingReview: number; overridden: number; approved: number; avgConfidence: number; lastRunAt: string | null }
/** One entry in an agent's governance trail — what moved, who moved it and the reason recorded with it. */
export interface AgentChange { field: string; from: string; to: string; at: string; by: string; byId: string | null; reason: string }
export interface AgentTrigger { kind: string; subjects: string[]; cron: string; cadence: string }
export interface AgentSchedule { cadence: string; cron: string; timezone: string }

/** GET /agents — one roster card. `agreementRate` is derived by the service (null until a decision has been reviewed). */
export interface AgentRow {
  id: string; agentId: string; name: string; nameAr: string | null; description: string; descriptionAr: string | null;
  role: string; domain: number; mandated: boolean;
  trigger: AgentTrigger; schedule: AgentSchedule;
  enabled: boolean; autonomyLevel: AutonomyLevel; confidenceThreshold: number;
  requiresConfirmation: boolean; maxActionsPerHour: number; escalateTo: string;
  suspended: boolean; suspendedReason: string; suspendedBy: string; suspendedAt: string | null;
  lastRunAt: string | null; stats: AgentStats; agreementRate: number | null;
  changes?: AgentChange[]; createdAt: string | null; updatedAt: string | null;
}
/** GET /agents — the meta counters that ride with the roster. */
export interface AgentRosterMeta { total: number; active: number; suspended: number; autonomous: number; mandated: number }
/** GET /agents/:agentId — the agent with its governance history and its last decisions. */
export interface Agent extends AgentRow { runnable: boolean; recentDecisions: AiDecision[] }

export interface AiFactor { factor: string; weight?: number; value?: string | number | null; contribution?: number }
/** GET /agents/decisions — one recorded decision. A review never rewrites this row; it writes a superseding one. */
export interface AiDecision {
  id: string; agentId: string; agentName: string; action: string; effect: Effect;
  subjectType: string; subjectId: string; subjectLabel: string;
  entityType: string; entityId: string; entityLabel: string;
  inputs: Record<string, unknown>; output: Record<string, unknown>; explanation: string; factors: AiFactor[];
  confidence: number; autonomyLevel: AutonomyLevel; threshold: number;
  disposition: Disposition; reviewStatus: ReviewStatus; escalationCode: EscalationCode | null; escalationReason: string; applied: boolean;
  reviewedById: string | null; reviewedBy: string; reviewedAt: string | null; overrideReason: string;
  supersedesId: string | null; superseded: boolean;
  /** A configuration key for the runtime profile in force — never a vendor's own identifier. */
  modelKey: string; modelVersion: string; latencyMs: number; cohort: Record<string, unknown>;
  at: string; createdAt: string | null;
}
/** GET /agents/decisions/:id — the decision with its weighted factors and whatever a human made of it. */
export interface AiDecisionDetail extends AiDecision {
  factorTotal: number; review: AiDecision | null; supersedes: AiDecision | null; openForReview: boolean;
}
/** GET /agents/decisions/escalations — meta: the queue read by cause and by agent. */
export interface EscalationMeta {
  page: number; limit: number; total: number;
  byCode: { code: string; decisions: number }[];
  byAgent: { agentId: string; name: string; decisions: number; oldest: string | null }[];
  oldest: string | null;
}
/** GET /agents/decisions/meta — the reference the console filters by, so the two cannot drift apart. */
export interface DecisionMeta { dispositions: Disposition[]; reviewStatuses: ReviewStatus[]; pending: Disposition[] }

/** GET /agents/dashboard — the console header and the per-agent performance series. */
export interface AgentPerformanceRow {
  agentId: string; name: string; autonomyLevel: AutonomyLevel; suspended: boolean;
  decisions: number; autoApplied: number; escalated: number; awaitingReview: number; overridden: number; pending: number;
  avgConfidence: number; agreementRate: number | null;
}
export interface AgentDashboardData {
  agents: number; active: number; suspended: number; byLevel: { level: AutonomyLevel; count: number }[];
  decisions: number; decisions30d: number; autoAppliedPct: number; pendingReview: number;
  agreementRate: number | null; avgConfidence: number; perAgent: AgentPerformanceRow[];
}

/** PUT /agents/:agentId — raising latitude, or dropping the confirmation requirement, requires a written reason. */
export interface ConfigurePayload {
  autonomyLevel?: AutonomyLevel; confidenceThreshold?: number; requiresConfirmation?: boolean;
  maxActionsPerHour?: number; escalateTo?: string; enabled?: boolean; reason?: string;
}
/** POST /agents/:agentId/suspend */
export interface SuspendPayload { suspended: boolean; reason: string }
/** POST /agents/:agentId/run — an on-demand pass over the records the agent is responsible for. */
export interface RunResult {
  ran: string; agentId: string; recorded: number; applied: number; escalated: number;
  byDisposition: Partial<Record<Disposition, number>>; decisions: AiDecision[];
}
/** POST /agents/decisions/:id/review */
export interface ReviewPayload { accept: boolean; reason: string }

/* --------------------------------------------------------------------------- assurance --- */

export interface DriftBucket { from: string; to: string; decisions: number; reviewed: number; overridden: number; agreementRate: number | null; avgConfidence: number; escalationRate: number | null }
export interface ConfidenceBand { band: string; from: number; to: number; decisions: number; share: number; agreementRate: number | null }
export interface DriftAgent {
  agentId: string; name: string; autonomyLevel: AutonomyLevel; suspended: boolean;
  decisions: number; reviewed: number; agreementRate: number | null; avgConfidence: number;
  baselineAgreement: number | null; latestAgreement: number | null; agreementDelta: number | null; drifting: boolean;
  buckets: DriftBucket[]; confidence: ConfidenceBand[];
}
/** GET /agents/monitoring/drift */
export interface DriftData { windowDays: number; bucketDays: number; from: string; to: string; decisions: number; drifting: string[]; perAgent: DriftAgent[] }

export interface BiasCohort {
  value: string; decisions: number; escalationRate: number | null; overrideRate: number | null; autoAppliedRate: number | null;
  avgConfidence: number; escalationDelta: number | null; overrideDelta: number | null; sufficient: boolean; flagged: boolean;
}
export interface BiasDimension { dimension: string; decisions: number; populationEscalationRate: number | null; populationOverrideRate: number | null; cohorts: BiasCohort[]; flagged: string[] }
/** GET /agents/monitoring/bias */
export interface BiasData { agentId: string | null; minCohort: number; flagDeltaPct: number; decisions: number; dimensions: BiasDimension[]; flagged: number }

export interface ServiceLevel { key: string; label: string; value: number | null; target: number | null; unit: string; meets: boolean | null }
/** GET /agents/monitoring/metrics */
export interface ServiceLevelData {
  agentId: string | null; windowDays: number; from: string; to: string;
  decisions: number; reviewed: number; escalated: number;
  highRiskCalls: number; highRiskReviewed: number; falsePositives: number; metrics: ServiceLevel[];
}
