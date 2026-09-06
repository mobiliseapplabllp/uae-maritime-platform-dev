import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, KIT_BUS, KIT_ENV, KIT_POOL, KIT_SETTINGS, SettingsClient, withInbox, type EventBus, type Subscription, type AiGatewayClient } from '@maritime/service-kit';
import type { Env } from './env';
import { GATEWAY_CLIENT, actingGateway } from './providers';
import { EMPTY_STATS, agentsForSubject, publishAgent, statsByAgent, TRIGGER_SUBJECTS, type AgentRecord, type Row } from './registry';
import { publishDecision, type DecisionRecord } from './decisions';
import { projectSnapshot } from './subjects';
import { isRunnableAgent, runAgent } from './runtime';

/* What wakes an agent.
 *
 * Two jobs, both idempotent through the inbox. First, every read-model event the agents reason over is folded
 * into the local snapshots, so a ship is scored from the same record the register shows. Second, the domain
 * events an agent is configured to react to — a call scheduled, a survey closed, a detention ordered, an incident
 * opened, an instrument about to lapse, an invoice gone overdue, an application lodged — wake the agents that
 * name that subject in their trigger, and each records a decision under the autonomy in force.
 *
 * An agent that is disabled or suspended is not skipped: it runs, and every conclusion it reaches is escalated
 * rather than applied, which is what leaves an audit trail of what a suspended agent would have done. */

export interface Deps { env: Env; audit: AuditClient; settings?: SettingsClient; gateway?: AiGatewayClient }

const SWEEPER = { id: 'scheduler', name: 'Scheduler', kind: 'system' as const };
/** The windows AI Agents → module settings sets: how long a decision may wait for review, how long an agent may sit suspended before the desk is reminded. */
export async function sweepWindows(settings?: SettingsClient): Promise<{ escalationHours: number; suspensionNoticeHours: number }> {
  const fallback = { escalationHours: 4, suspensionNoticeHours: 4 };
  const s = settings ? await settings.moduleGet<Record<string, unknown>>('agents', fallback) : fallback;
  const hours = (v: unknown, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d; };
  return { escalationHours: hours(s.escalationHours, 4), suspensionNoticeHours: hours(s.suspensionNoticeHours, 4) };
}

/**
 * The hourly sweep. A decision still awaiting review past the escalation window is chased once — published as overdue so the
 * reviewers are told — and an agent left suspended past the notice window is raised once with the people who configure agents.
 * Both marks are cleared when the record moves on: a review supersedes the decision, a reinstatement clears the notice.
 */
export async function sweepDecisions(c: PoolClient, deps: Deps, event: EventEnvelope, now = new Date()) {
  const w = await sweepWindows(deps.settings);
  const overdue = await c.query<DecisionRecord>(
    `SELECT * FROM decisions WHERE review_status = 'PENDING' AND NOT superseded AND chased_at IS NULL AND disposition IN ('AWAITING_REVIEW', 'ESCALATED')
       AND at < $1::timestamptz - ($2::text || ' hours')::interval ORDER BY at LIMIT 100`, [now, String(w.escalationHours)]);
  const suspended = await c.query<AgentRecord>(
    `SELECT * FROM agents WHERE suspended AND suspension_noticed_at IS NULL AND suspended_at < $1::timestamptz - ($2::text || ' hours')::interval ORDER BY suspended_at`, [now, String(w.suspensionNoticeHours)]);
  const escalateTo = new Map((await c.query<{ agent_id: string; escalate_to: string }>('SELECT agent_id, escalate_to FROM agents')).rows.map((r) => [r.agent_id, r.escalate_to]));
  for (const d of overdue.rows) {
    const waitingHours = Math.round((now.getTime() - new Date(d.at).getTime()) / 3_600_000);
    await publishDecision(c, deps.env, d, { event: EVENTS.ai.decisionOverdue, cause: event, actor: SWEEPER, data: { waitingHours, escalationHours: w.escalationHours, escalateTo: escalateTo.get(d.agent_id) ?? 'agents.review', agentName: d.agent_name, entityLabel: d.entity_label, action: d.action } });
    await c.query('UPDATE decisions SET chased_at = $2 WHERE id = $1', [d.id, now]);
  }
  const stats = suspended.rowCount ? await statsByAgent(c) : new Map();
  for (const a of suspended.rows) {
    const suspendedHours = Math.round((now.getTime() - new Date(a.suspended_at ?? now).getTime()) / 3_600_000);
    await publishAgent(c, deps.env, a, stats.get(a.agent_id) ?? EMPTY_STATS, { event: EVENTS.ai.agentSuspensionNotice, cause: event, actor: SWEEPER, data: { suspendedHours, suspensionNoticeHours: w.suspensionNoticeHours, reason: a.suspended_reason, by: a.suspended_by } });
    await c.query('UPDATE agents SET suspension_noticed_at = $2 WHERE agent_id = $1', [a.agent_id, now]);
  }
  const out = { ...w, chased: overdue.rowCount ?? 0, noticed: suspended.rowCount ?? 0 };
  if (out.chased || out.noticed) {
    await deps.audit.record(c, { action: 'SWEEP', entity: 'AgentDecision', entityId: 'decision-escalation', entityLabel: `${out.chased} decision(s) chased, ${out.noticed} suspension notice(s)`, after: { ...out, decisions: overdue.rows.map((d) => d.id), agents: suspended.rows.map((a) => a.agent_id) }, actor: SWEEPER });
  }
  return out;
}

/** The subject an agent's decision concerns, taken from the event that woke it. */
export function subjectOf(event: EventEnvelope): string | undefined {
  const d = (event.data ?? {}) as Row;
  const id = d.vesselId ?? d.requestId ?? d.instrumentId ?? d.inspectionId ?? d.incidentId ?? d.invoiceId ?? d.portCallId ?? d.subjectId;
  return id ? String(id) : undefined;
}

/** Which of a subject's woken agents actually have a runner here; the rest are scheduled elsewhere. */
export async function agentsToWake(c: PoolClient, event: EventEnvelope): Promise<AgentRecord[]> {
  const ids = agentsForSubject(event.type).filter(isRunnableAgent);
  if (!ids.length) return [];
  return (await c.query<AgentRecord>('SELECT * FROM agents WHERE agent_id = ANY($1)', [ids])).rows;
}

export async function applyEvent(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<void> {
  // a decision this service published itself must never wake the agent that published it
  if (event.source === deps.env.SERVICE_NAME) return;

  await projectSnapshot(c, event);

  const agents = await agentsToWake(c, event);
  if (!agents.length) return;
  const subjectId = subjectOf(event);
  for (const agent of agents) {
    /* A trigger points the agent at the record the event was about when it names one; without a subject the
     * agent falls back to its ordinary batch, which is what a schedule-driven wake wants. */
    await runAgent(c, { env: deps.env, audit: deps.audit, gateway: deps.gateway }, agent, { subjectId, limit: subjectId ? 1 : deps.env.RUN_BATCH, cause: event, actor: { id: agent.agent_id, name: agent.name, kind: 'agent' } });
  }
}

/** Read models first, then every subject any agent is configured to react to. */
export const SUBJECTS = [
  subjectFor(EVENTS.readModel.upserted), subjectFor(EVENTS.readModel.deleted), subjectFor(EVENTS.scheduler.sweepDecisions),
  ...TRIGGER_SUBJECTS.map(subjectFor),
];

@Injectable()
export class AgentsConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(
    @Inject(KIT_BUS) private readonly bus: EventBus,
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    @Inject(KIT_SETTINGS) private readonly settings: SettingsClient,
    @Inject(GATEWAY_CLIENT) private readonly gateway: AiGatewayClient,
    private readonly audit: AuditClient,
  ) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('ai-agents-consumer', [...new Set(SUBJECTS)], (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) {
    if (event.type === EVENTS.scheduler.sweepDecisions) { await withInbox(this.pool, event, async (c) => { await sweepDecisions(c, { env: this.env, audit: this.audit, settings: this.settings }, event); }); return; }
    await withInbox(this.pool, event, (c) => applyEvent(c, { env: this.env, audit: this.audit, gateway: actingGateway(this.env, this.gateway) }, event));
  }
}
