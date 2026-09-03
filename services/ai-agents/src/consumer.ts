import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, KIT_BUS, KIT_ENV, KIT_POOL, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';
import type { Env } from './env';
import { agentsForSubject, TRIGGER_SUBJECTS, type AgentRecord, type Row } from './registry';
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

export interface Deps { env: Env; audit: AuditClient }

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
    await runAgent(c, deps, agent, { subjectId, limit: subjectId ? 1 : deps.env.RUN_BATCH, cause: event, actor: { id: agent.agent_id, name: agent.name, kind: 'agent' } });
  }
}

/** Read models first, then every subject any agent is configured to react to. */
export const SUBJECTS = [
  subjectFor(EVENTS.readModel.upserted), subjectFor(EVENTS.readModel.deleted),
  ...TRIGGER_SUBJECTS.map(subjectFor),
];

@Injectable()
export class AgentsConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(
    @Inject(KIT_BUS) private readonly bus: EventBus,
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    private readonly audit: AuditClient,
  ) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('ai-agents-consumer', [...new Set(SUBJECTS)], (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) { await withInbox(this.pool, event, (c) => applyEvent(c, { env: this.env, audit: this.audit }, event)); }
}
