/* The autonomy ladder, and the escalation rule that is the whole point of it.
 *
 * Three rungs, and each one is a permission the runtime grants rather than a habit the agent keeps:
 *
 *   SUPERVISED   suggest only — the agent may conclude, never apply. Every decision waits for a human.
 *   ASSISTED     act with confirmation — above its confidence threshold it may apply a reversible effect, and
 *                if the agent is configured to require confirmation it still waits.
 *   AUTONOMOUS   act within limits — applies without waiting, up to its hourly ceiling, and never an
 *                irreversible effect.
 *
 * An agent can never exceed the rung it is configured on because it does not decide the outcome: `adjudicate`
 * does, from the configuration row read at the moment of the decision. The four things that force an escalation
 * are here and nowhere else — below the threshold, outside the level, an irreversible effect, or a guardrail
 * (suspended, disabled, over the hourly ceiling, confirmation required). Nothing in this file touches a database
 * or a clock it was not given, which is what makes the rule testable on its own. */

export const AUTONOMY_LEVELS = ['SUPERVISED', 'ASSISTED', 'AUTONOMOUS'] as const;
export type AutonomyLevel = (typeof AUTONOMY_LEVELS)[number];
export const isAutonomyLevel = (v: unknown): v is AutonomyLevel => AUTONOMY_LEVELS.includes(v as AutonomyLevel);
/** Where `to` sits above `from` on the ladder: raising latitude is a governance decision and must be justified. */
export const raisesAutonomy = (from: AutonomyLevel, to: AutonomyLevel) => AUTONOMY_LEVELS.indexOf(to) > AUTONOMY_LEVELS.indexOf(from);

/** What the proposed action would do to the world. An advisory conclusion changes nothing by being recorded. */
export const EFFECTS = ['ADVISORY', 'REVERSIBLE', 'IRREVERSIBLE'] as const;
export type Effect = (typeof EFFECTS)[number];

export const DISPOSITIONS = ['AUTO_APPLIED', 'ESCALATED', 'AWAITING_REVIEW', 'APPROVED_BY_HUMAN', 'OVERRIDDEN', 'REJECTED_BY_HUMAN'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
/** The review state reporting projects: automatic, waiting for a human, reviewed, or overturned. */
export const REVIEW_STATUSES = ['AUTO', 'PENDING', 'REVIEWED', 'OVERRIDDEN'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/** Why a decision was not applied. One code per rule, so the escalation queue can be read by cause. */
export const ESCALATION_CODES = ['BELOW_THRESHOLD', 'OUTSIDE_AUTONOMY', 'IRREVERSIBLE_EFFECT', 'CONFIRMATION_REQUIRED', 'AGENT_SUSPENDED', 'AGENT_DISABLED', 'RATE_LIMIT', 'BELOW_FLOOR'] as const;
export type EscalationCode = (typeof ESCALATION_CODES)[number];

/** The configuration in force for one agent at the moment of a decision. */
export interface AgentPolicy {
  agentId: string;
  name: string;
  autonomyLevel: AutonomyLevel;
  confidenceThreshold: number;
  requiresConfirmation: boolean;
  maxActionsPerHour: number;
  enabled: boolean;
  suspended: boolean;
  suspendedReason?: string;
}

/** What an agent concluded, before the runtime decides what may be done about it. */
export interface Proposal {
  effect: Effect;
  confidence: number;
  /** Actions already applied by this agent inside the trailing hour. */
  actionsLastHour?: number;
}

export interface Adjudication {
  disposition: Disposition;
  reviewStatus: ReviewStatus;
  /** True only when the runtime actually let the agent act on its own conclusion. */
  applied: boolean;
  escalationCode: EscalationCode | '';
  escalationReason: string;
}

const pct = (n: number) => `${Math.round(n * 100)}%`;
const escalate = (code: EscalationCode, reason: string): Adjudication => ({ disposition: 'ESCALATED', reviewStatus: 'PENDING', applied: false, escalationCode: code, escalationReason: reason });
const hold = (code: EscalationCode, reason: string): Adjudication => ({ disposition: 'AWAITING_REVIEW', reviewStatus: 'PENDING', applied: false, escalationCode: code, escalationReason: reason });

/**
 * The one place an agent's latitude is applied. Order matters and is deliberate: the guardrails that mean the
 * agent should not be acting at all come first, then the floor no configuration can lower, then the effect that
 * can never be undone, then the rung, then the threshold. `floor` is the platform-wide minimum confidence.
 */
export function adjudicate(policy: AgentPolicy, proposal: Proposal, floor = 0): Adjudication {
  const level = policy.autonomyLevel;
  const confidence = Number.isFinite(proposal.confidence) ? proposal.confidence : 0;

  if (!policy.enabled) return escalate('AGENT_DISABLED', `${policy.name} is disabled — the conclusion is recorded but nothing is applied`);
  if (policy.suspended) return escalate('AGENT_SUSPENDED', `${policy.name} is suspended: ${policy.suspendedReason || 'under investigation'}`);
  if (confidence < floor) return escalate('BELOW_FLOOR', `Confidence ${pct(confidence)} is below the platform floor of ${pct(floor)}`);

  // Nothing that cannot be undone is ever done by an agent, at any rung. The reviewer, not the runtime, carries that.
  if (proposal.effect === 'IRREVERSIBLE') return escalate('IRREVERSIBLE_EFFECT', 'The effect cannot be undone, so it is put to a human whatever the confidence');

  // Suggest-only: a supervised agent's conclusion is a recommendation and waits, however sure it is.
  if (level === 'SUPERVISED') return hold('OUTSIDE_AUTONOMY', `${policy.name} is supervised — every conclusion is reviewed before it takes effect`);

  if (confidence < policy.confidenceThreshold) {
    return escalate('BELOW_THRESHOLD', `Confidence ${pct(confidence)} is below the ${pct(policy.confidenceThreshold)} threshold set for ${policy.name}`);
  }

  if (level === 'ASSISTED' && policy.requiresConfirmation) {
    return hold('CONFIRMATION_REQUIRED', `${policy.name} acts with confirmation — an officer confirms before it takes effect`);
  }

  const used = proposal.actionsLastHour ?? 0;
  if (used >= policy.maxActionsPerHour) {
    return escalate('RATE_LIMIT', `${policy.name} has already acted ${used} time(s) this hour against a ceiling of ${policy.maxActionsPerHour}`);
  }

  return { disposition: 'AUTO_APPLIED', reviewStatus: 'AUTO', applied: true, escalationCode: '', escalationReason: '' };
}

/** Whether a decision is still the human queue's problem. */
export const isPending = (d: string) => d === 'AWAITING_REVIEW' || d === 'ESCALATED';
export const PENDING_DISPOSITIONS: Disposition[] = ['AWAITING_REVIEW', 'ESCALATED'];
/** The dispositions a human put there: the only ones drift can be measured against. */
export const REVIEWED_DISPOSITIONS: Disposition[] = ['APPROVED_BY_HUMAN', 'OVERRIDDEN', 'REJECTED_BY_HUMAN'];
export const isReviewed = (d: string) => REVIEWED_DISPOSITIONS.includes(d as Disposition);
