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
/** One action a decision carried to the record through the tool gateway — run as the agent itself, or as the reviewer
 * who approved it. The gateway's own refusal code and reason ride with anything that did not go through. */
export interface ExecutionRecord {
  tool: string; label: string; outcome: 'OK' | 'REFUSED' | 'FAILED' | 'DRY_RUN' | 'SKIPPED';
  code?: string; reason?: string; callId?: string; status?: number; at: string; as: 'agent' | 'person';
}
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
  /** What the decision carried to the record once applied, and when — empty for a conclusion that is a recommendation. */
  execution: ExecutionRecord[]; executedAt: string | null;
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

export interface CoverageTarget {
  start: string; end: string; monthsElapsed: number; required: number; startTarget: number; endTarget: number;
  meets: boolean | null; servicesToRequired: number; servicesToEndTarget: number;
}
export interface ServiceCoverageRow {
  code: string; name: string; nameAr?: string; domain: number;
  requests: number; touched: number; decisions: number; autonomous: number;
  agents: string[]; lastAt: string | null; covered: boolean;
}
export interface DomainCoverage { domain: number; services: number; covered: number; rate: number | null; requests: number; touched: number }
/** GET /agents/coverage */
export interface CoverageData {
  windowDays: number; from: string; to: string;
  services: number; covered: number; serviceRate: number | null;
  autonomousServices: number; autonomousRate: number | null;
  requests: number; requestsTouched: number; requestRate: number | null;
  withoutRequests: number; target: CoverageTarget;
  byDomain: DomainCoverage[]; rows: ServiceCoverageRow[];
}

/* -------------------------------------------------------------------------- tool gateway --- */

/** The four tiers the gateway orders a tool's reach by: READ answers from a record, PROPOSE writes a proposal for a
 * person to accept, ACT changes a record, INFER reaches a hosted model. A caller holds a ceiling; a tool above it is
 * refused before anything is looked up. */
export type GatewayTier = 'READ' | 'PROPOSE' | 'ACT' | 'INFER';
export type CallOutcome = 'OK' | 'REFUSED' | 'FAILED' | 'DRY_RUN';
export type InferenceOutcome = 'OK' | 'REFUSED' | 'FAILED' | 'LOCAL';
export type CallerKind = 'ASSISTANT' | 'AGENT' | 'SERVICE';
/** Why the gateway refused a call — one code per rule in its policy. */
export type GatewayRefusalCode = 'CALLER_UNKNOWN' | 'CALLER_DISABLED' | 'TOOL_UNKNOWN' | 'TOOL_DISABLED' | 'TOOL_NOT_ALLOWED' | 'TIER_CEILING' | 'NOT_EXPOSED' | 'HOURLY_QUOTA' | 'DAILY_QUOTA' | 'PERMISSION' | 'NO_PRINCIPAL' | 'PRINCIPAL_UNKNOWN' | 'BAD_ARGS' | 'INJECTION' | 'NO_PROVIDER';

/** GET /ai-gateway/callers — one registered caller: what it may reach, and what it has used this hour and today. */
export interface GatewayCaller {
  callerId: string; label: string; kind: CallerKind; allowedTools: string[]; maxTier: GatewayTier;
  hourlyQuota: number; dailyQuota: number; enabled: boolean; note: string; usage: { hour: number; day: number };
}
/** PUT /ai-gateway/callers/:id — only what moved is sent. */
export interface CallerUpdate { allowedTools?: string[]; maxTier?: GatewayTier; hourlyQuota?: number; dailyQuota?: number; enabled?: boolean; note?: string }
/** GET /ai-gateway/tools — the registry as the gateway holds it, with the switch an administrator may throw. */
export interface GatewayTool {
  name: string; module: string; label: string; labelAr: string; description: string; tier: GatewayTier; permission: string;
  exposure: 'ASSISTANT' | 'AGENT' | 'BOTH'; upstream: string; enabled: boolean; args: string[];
}
/** GET /ai-gateway/calls — one call through the gateway; the arguments arrive already redacted. */
export interface GatewayCall {
  id: string; at: string; callerId: string; principalId: string; principalName: string; principalKind: string;
  tool: string; tier: GatewayTier; module: string; argsHash: string; args: Record<string, unknown>;
  outcome: CallOutcome; refusalCode: GatewayRefusalCode | string | null; reason: string; httpStatus: number | null; upstream: string;
  latencyMs: number; redactions: number; cause: string; decisionId: string | null;
}
/** GET /ai-gateway/inferences — one completion that reached a hosted model, or was stopped before it did. */
export interface GatewayInference {
  id: string; at: string; callerId: string; principalName: string; purpose: string; provider: string; profile: string; residency: string;
  promptFingerprint: string; promptChars: number; groundingBlocks: number; redactions: number; redactionKinds: Record<string, number>;
  injectionScore: number; injectionFlags: string[]; outcome: InferenceOutcome; reason: string; latencyMs: number; tokensIn: number; tokensOut: number; replyChars: number;
}
/** GET /ai-gateway/stats — the governance face in one payload: volumes, latencies, refusals, what left the platform. */
export interface GatewayStats {
  calls: { last24h: number; last7d: number; last30d: number; failed24h: number; refused24h: number; p50Ms: number | null; p95Ms: number | null };
  byOutcome: Partial<Record<CallOutcome, number>>;
  byCaller: { callerId: string; calls: number; refused: number; failed: number; acted: number }[];
  byTier: Partial<Record<GatewayTier, number>>;
  byModule: { module: string; calls: number }[];
  byTool: { tool: string; calls: number; p50Ms: number | null }[];
  refusals: { code: string; count: number }[];
  inferences: { provider: string; outcome: InferenceOutcome; count: number; tokensIn: number; tokensOut: number; redactions: number; flagged: number; p50Ms: number | null }[];
  byDay: { day: string; ok: number; refused: number; failed: number; inferences: number }[];
  callers: GatewayCaller[];
  tools: { registered: number; byTier: Partial<Record<GatewayTier, number>> };
  generatedAt: string;
}
