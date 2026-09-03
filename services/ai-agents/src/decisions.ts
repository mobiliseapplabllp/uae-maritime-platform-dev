import type { PoolClient } from 'pg';
import { EVENTS, type Actor, type EventEnvelope, makeEvent } from '@maritime/contracts';
import { AuditClient, enqueue, eventFromContext, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { adjudicate, isReviewed, type Adjudication, type AgentPolicy, type Disposition, type Effect, type ReviewStatus } from './autonomy';
import { policyOf, statsByAgent, publishAgent, type AgentRecord, type Row } from './registry';

/* The decision register.
 *
 * Every run of every agent lands here whatever the outcome: what it was given, what it concluded, why, the
 * weighted factors behind the conclusion, how sure it was, the autonomy in force at that moment, and what the
 * runtime therefore allowed. The register is append-only — a review does not edit the row it reviewed, it writes
 * a superseding row that points back at it, so "what did the agent actually say before a human touched it?" is
 * always answerable. */

export interface DecisionRecord {
  id: string; agent_id: string; agent_name: string; action: string; effect: string;
  entity_type: string; entity_id: string; entity_label: string;
  inputs: Row; output: Row; explanation: string; factors: Row[];
  confidence: string | number; autonomy_level: string; threshold: string | number;
  disposition: string; review_status: string; escalation_code: string; escalation_reason: string; applied: boolean;
  reviewed_by_id: string | null; reviewed_by: string; reviewed_at: Date | null; override_reason: string;
  supersedes_id: string | null; superseded: boolean;
  model_key: string; model_version: string; latency_ms: number; cohort: Row; at: Date; created_at: Date;
}

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export function decisionApi(d: DecisionRecord) {
  return {
    id: d.id, agentId: d.agent_id, agentName: d.agent_name, action: d.action, effect: d.effect as Effect,
    /* The web console reads a decision's subject as `subjectType`/`subjectId`; reporting projects the same two
     * fields as `entityType`/`entityId`. Both names are emitted from the one column pair so neither has to guess. */
    subjectType: d.entity_type, subjectId: d.entity_id, subjectLabel: d.entity_label,
    entityType: d.entity_type, entityId: d.entity_id, entityLabel: d.entity_label,
    inputs: d.inputs ?? {}, output: d.output ?? {}, explanation: d.explanation, factors: d.factors ?? [],
    confidence: num(d.confidence), autonomyLevel: d.autonomy_level, threshold: num(d.threshold),
    disposition: d.disposition as Disposition, reviewStatus: d.review_status as ReviewStatus,
    escalationCode: d.escalation_code || null, escalationReason: d.escalation_reason, applied: d.applied,
    reviewedById: d.reviewed_by_id, reviewedBy: d.reviewed_by, reviewedAt: iso(d.reviewed_at), overrideReason: d.override_reason,
    supersedesId: d.supersedes_id, superseded: d.superseded,
    /* A configuration key for the runtime profile in force, never a vendor's own model identifier. */
    modelKey: d.model_key, modelVersion: d.model_version, latencyMs: d.latency_ms, cohort: d.cohort ?? {},
    at: iso(d.at)!, createdAt: iso(d.created_at),
  };
}
export type DecisionApi = ReturnType<typeof decisionApi>;

/** A conclusion an agent reached, before the runtime decides what may be done about it. */
export interface Judgement {
  action: string; subjectType: string; subjectId: string; subjectLabel: string;
  inputs: Row; output: Row; explanation: string;
  factors: { factor: string; weight: number; value: string; contribution: number }[];
  confidence: number;
}
export interface RecordInput {
  agent: AgentRecord; judgement: Judgement; effect: Effect;
  /** The dimensions the subject record actually carries, kept so outcomes can be compared across cohorts. */
  cohort?: Row; latencyMs?: number; at?: Date;
}
export interface RecordOptions { cause?: EventEnvelope; actor?: Actor; audit?: AuditClient }

/** Actions this agent has already applied inside the trailing hour — the ceiling is a fact, not an intention. */
export async function actionsLastHour(c: Queryable, agentId: string, now: Date): Promise<number> {
  const r = await c.query<{ n: string }>('SELECT count(*)::int AS n FROM agent_actions WHERE agent_id = $1 AND at > $2', [agentId, new Date(now.getTime() - 3_600_000)]);
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * Record one decision under the autonomy in force. The ladder decides the disposition; this function only writes
 * what it decided, so an agent can never talk its way past its own configuration.
 */
export async function recordDecision(c: PoolClient, env: Env, input: RecordInput, opts: RecordOptions = {}): Promise<{ decision: DecisionApi; adjudication: Adjudication; policy: AgentPolicy }> {
  const now = input.at ?? new Date();
  const policy = policyOf(input.agent);
  const used = await actionsLastHour(c, policy.agentId, now);
  const adjudication = adjudicate(policy, { effect: input.effect, confidence: input.judgement.confidence, actionsLastHour: used }, env.ABSOLUTE_MIN_CONFIDENCE);
  const j = input.judgement;
  const r = await c.query<DecisionRecord>(
    `INSERT INTO decisions(agent_id, agent_name, action, effect, entity_type, entity_id, entity_label, inputs, output, explanation, factors,
        confidence, autonomy_level, threshold, disposition, review_status, escalation_code, escalation_reason, applied, model_key, model_version, latency_ms, cohort, at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
    [policy.agentId, input.agent.name, j.action, input.effect, j.subjectType, j.subjectId, j.subjectLabel,
      JSON.stringify(j.inputs ?? {}), JSON.stringify(j.output ?? {}), j.explanation, JSON.stringify(j.factors ?? []),
      j.confidence, policy.autonomyLevel, policy.confidenceThreshold, adjudication.disposition, adjudication.reviewStatus,
      adjudication.escalationCode, adjudication.escalationReason, adjudication.applied,
      env.REASONING_PROFILE, env.REASONING_PROFILE_VERSION, Math.round(input.latencyMs ?? 0), JSON.stringify(input.cohort ?? {}), now]);
  const row = r.rows[0];
  if (adjudication.applied) await c.query('INSERT INTO agent_actions(agent_id, decision_id, at) VALUES ($1,$2,$3)', [policy.agentId, row.id, now]);
  await c.query('UPDATE agents SET last_run_at = GREATEST(COALESCE(last_run_at, $2), $2), updated_at = now() WHERE agent_id = $1', [policy.agentId, now]);

  const decision = await publishDecision(c, env, row, { cause: opts.cause, actor: opts.actor, event: EVENTS.ai.decisionRecorded });
  if (!adjudication.applied) {
    await enqueueFor(c, env, row, EVENTS.ai.decisionEscalated, { escalationCode: adjudication.escalationCode, escalationReason: adjudication.escalationReason, escalateTo: input.agent.escalate_to }, opts);
  }
  if (opts.audit) {
    await opts.audit.record(c, {
      action: adjudication.applied ? 'AI_DECISION_APPLIED' : 'AI_DECISION_ESCALATED', entity: 'AiDecision', entityId: row.id,
      entityLabel: `${input.agent.name}: ${j.action}`, after: { disposition: adjudication.disposition, confidence: j.confidence, subject: j.subjectLabel },
      note: adjudication.escalationReason || 'Applied under the agent\'s configured autonomy',
      ...(opts.actor ? { actor: { id: opts.actor.id, name: opts.actor.name ?? opts.actor.id, kind: opts.actor.kind ?? 'agent' } } : {}),
    });
  }
  return { decision, adjudication, policy };
}

async function enqueueFor(c: Queryable, env: Env, d: DecisionRecord, type: string, data: Row, opts: RecordOptions) {
  const event = opts.cause
    ? makeEvent({ type, source: env.SERVICE_NAME, data: { decisionId: d.id, agentId: d.agent_id, ...data }, subject: d.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor })
    : eventFromContext(env.SERVICE_NAME, type, { decisionId: d.id, agentId: d.agent_id, ...data }, { subject: d.id, actor: opts.actor });
  await enqueue(c, event);
}

/** Publishes the decision for the read models (`agentDecision`) and, when asked, the business event with it. */
export async function publishDecision(c: Queryable, env: Env, d: DecisionRecord, opts: RecordOptions & { event?: string; data?: Row } = {}): Promise<DecisionApi> {
  const entity = decisionApi(d);
  const mk = <T,>(type: string, data: T) => (opts.cause
    ? makeEvent({ type, source: env.SERVICE_NAME, data, subject: d.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor })
    : eventFromContext(env.SERVICE_NAME, type, data, { subject: d.id, actor: opts.actor }));
  await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'agentDecision', entity }));
  if (opts.event) {
    await enqueue(c, mk(opts.event, {
      decisionId: d.id, agentId: d.agent_id, agentName: d.agent_name, action: d.action, disposition: d.disposition, reviewStatus: d.review_status,
      confidence: num(d.confidence), autonomyLevel: d.autonomy_level, entityType: d.entity_type, entityId: d.entity_id,
      escalationCode: d.escalation_code || null, applied: d.applied, decision: entity, ...(opts.data ?? {}),
    }));
  }
  return entity;
}

/**
 * A human accepts or overturns a decision. The original row is marked superseded and left exactly as it was; the
 * outcome is a new row carrying the reviewer, the time and — when it is overturned — the reason, which the
 * service refuses to do without.
 */
export async function reviewDecision(
  c: PoolClient, env: Env, original: DecisionRecord, input: { accept: boolean; reason: string; reviewer: { id: string; name: string } }, opts: RecordOptions = {},
): Promise<DecisionApi> {
  const outcome: Disposition = input.accept ? 'APPROVED_BY_HUMAN' : 'OVERRIDDEN';
  const reviewStatus: ReviewStatus = input.accept ? 'REVIEWED' : 'OVERRIDDEN';
  const at = new Date();
  const r = await c.query<DecisionRecord>(
    `INSERT INTO decisions(agent_id, agent_name, action, effect, entity_type, entity_id, entity_label, inputs, output, explanation, factors,
        confidence, autonomy_level, threshold, disposition, review_status, escalation_code, escalation_reason, applied,
        reviewed_by_id, reviewed_by, reviewed_at, override_reason, supersedes_id, model_key, model_version, latency_ms, cohort, at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29) RETURNING *`,
    [original.agent_id, original.agent_name, original.action, original.effect, original.entity_type, original.entity_id, original.entity_label,
      JSON.stringify(original.inputs ?? {}), JSON.stringify(original.output ?? {}), original.explanation, JSON.stringify(original.factors ?? []),
      original.confidence, original.autonomy_level, original.threshold, outcome, reviewStatus, '', '', input.accept,
      input.reviewer.id, input.reviewer.name, at, input.accept ? '' : input.reason, original.id,
      original.model_key, original.model_version, 0, JSON.stringify(original.cohort ?? {}), at]);
  const superseding = r.rows[0];
  await c.query('UPDATE decisions SET superseded = true, review_status = $2, reviewed_by_id = $3, reviewed_by = $4, reviewed_at = $5 WHERE id = $1',
    [original.id, reviewStatus, input.reviewer.id, input.reviewer.name, at]);
  if (input.accept) await c.query('INSERT INTO agent_actions(agent_id, decision_id, at) VALUES ($1,$2,$3)', [original.agent_id, superseding.id, at]);

  // the original row is republished so the read models carry its new review state, and the outcome as its own record
  const originalNow = (await c.query<DecisionRecord>('SELECT * FROM decisions WHERE id = $1', [original.id])).rows[0];
  await publishDecision(c, env, originalNow, { actor: opts.actor });
  const entity = await publishDecision(c, env, superseding, {
    actor: opts.actor, event: input.accept ? EVENTS.ai.decisionReviewed : EVENTS.ai.decisionOverridden,
    data: { supersedesId: original.id, reason: input.accept ? '' : input.reason },
  });
  return entity;
}

/** Whether this decision is still open for a human to act on. */
export const isOpenForReview = (d: DecisionRecord) => !d.superseded && (d.disposition === 'AWAITING_REVIEW' || d.disposition === 'ESCALATED');

export { isReviewed };
export type { AgentRecord };
export { statsByAgent, publishAgent };
