import { Body, Controller, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { EVENTS } from '@maritime/contracts';
import {
  AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, badRequest, conflict, notFound, withTx, zod, type Principal,
} from '@maritime/service-kit';
import type { Env } from './env';
import { AUTONOMY_LEVELS, raisesAutonomy, type AutonomyLevel } from './autonomy';
import { agentApi, changesOf, isRunnable, policyOf, publishAgent, statsByAgent, EMPTY_STATS, type AgentRecord, type AgentStats, type Row } from './registry';
import { decisionApi, type DecisionRecord } from './decisions';
import { performance, type MetricAgent, type MetricDecision } from './metrics';
import { isRunnableAgent, runAgent } from './runtime';

/* The agent console.
 *
 * Four things the authority must be able to do without calling a vendor, and all four are here: see every agent
 * and what it is allowed to do, change that latitude with the reason recorded, suspend an agent that is
 * misbehaving, and run one over live records to see what it would say. Widening an agent is refused without a
 * written reason; narrowing one never is, because nobody should have to argue to make a system safer. */

const text = (max: number) => z.string().trim().max(max);
const configureBody = z.object({
  autonomyLevel: z.enum(AUTONOMY_LEVELS).optional(),
  confidenceThreshold: z.coerce.number().min(0).max(1).optional(),
  requiresConfirmation: z.boolean().optional(),
  maxActionsPerHour: z.coerce.number().int().min(1).max(10_000).optional(),
  escalateTo: text(120).optional(),
  enabled: z.boolean().optional(),
  reason: text(1000).optional(),
});
const suspendBody = z.object({ suspended: z.boolean().default(true), reason: text(1000).default('') });
const runBody = z.object({ limit: z.coerce.number().int().min(1).max(100).optional(), subjectId: text(120).optional() });

@Controller('agents')
export class AgentsController {
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    private readonly audit: AuditClient,
  ) {}

  private async load(c: Pool | PoolClient, agentId: string): Promise<AgentRecord> {
    const r = await c.query<AgentRecord>('SELECT * FROM agents WHERE agent_id = $1 OR id::text = $1', [agentId]);
    if (!r.rows[0]) throw notFound('Agent not found');
    return r.rows[0];
  }
  private async lock(c: PoolClient, agentId: string): Promise<AgentRecord> {
    const r = await c.query<AgentRecord>('SELECT * FROM agents WHERE agent_id = $1 OR id::text = $1 FOR UPDATE', [agentId]);
    if (!r.rows[0]) throw notFound('Agent not found');
    return r.rows[0];
  }
  private async statsOf(c: Pool | PoolClient, agentId: string): Promise<AgentStats> {
    return (await statsByAgent(c)).get(agentId) ?? EMPTY_STATS;
  }

  /** The roster: every agent with its latitude, its rolling counts and how often reviewers agreed with it. */
  @RequirePerm('agents.view') @Get()
  async list(@Query() query: { level?: string; enabled?: string; suspended?: string; mandated?: string; q?: string }) {
    const where: string[] = []; const args: unknown[] = [];
    if (query.level) { args.push(query.level); where.push(`autonomy_level = $${args.length}`); }
    if (query.enabled !== undefined && query.enabled !== '') { args.push(String(query.enabled) === 'true'); where.push(`enabled = $${args.length}`); }
    if (query.suspended !== undefined && query.suspended !== '') { args.push(String(query.suspended) === 'true'); where.push(`suspended = $${args.length}`); }
    if (query.mandated !== undefined && query.mandated !== '') { args.push(String(query.mandated) === 'true'); where.push(`mandated = $${args.length}`); }
    if (query.q) { args.push(`%${query.q.trim()}%`); where.push(`(name ILIKE $${args.length} OR agent_id ILIKE $${args.length} OR role ILIKE $${args.length})`); }
    const rows = (await this.pool.query<AgentRecord>(`SELECT * FROM agents ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY mandated DESC, domain, name`, args)).rows;
    const stats = await statsByAgent(this.pool);
    const data = rows.map((a) => agentApi(a, stats.get(a.agent_id) ?? EMPTY_STATS));
    return {
      success: true, data,
      meta: {
        total: data.length, active: data.filter((a) => a.enabled && !a.suspended).length, suspended: data.filter((a) => a.suspended).length,
        autonomous: data.filter((a) => a.autonomyLevel === 'AUTONOMOUS' && !a.suspended).length, mandated: data.filter((a) => a.mandated).length,
      },
    };
  }

  /** The console header: counts by rung, dispositions, review outcomes and mean confidence per agent. */
  @RequirePerm('agents.view') @Get('dashboard')
  async dashboard() {
    const agents = (await this.pool.query<AgentRecord>('SELECT * FROM agents ORDER BY mandated DESC, domain, name')).rows;
    const decisions = (await this.pool.query<Row>(
      'SELECT agent_id, agent_name, disposition, review_status, confidence, autonomy_level, applied, escalation_code, at, cohort, output FROM decisions WHERE supersedes_id IS NULL')).rows;
    return performance(agents.map(toMetricAgent), decisions.map(toMetricDecision), new Date(), this.env.DRIFT_WINDOW_DAYS);
  }

  /** One agent with its governance history and the decisions it most recently recorded. */
  @RequirePerm('agents.view') @Get(':agentId')
  async get(@Param('agentId') agentId: string) {
    const a = await this.load(this.pool, agentId);
    const [stats, changes, recent] = await Promise.all([
      this.statsOf(this.pool, a.agent_id),
      changesOf(this.pool, a.agent_id),
      this.pool.query<DecisionRecord>('SELECT * FROM decisions WHERE agent_id = $1 AND supersedes_id IS NULL ORDER BY at DESC LIMIT 20', [a.agent_id]),
    ]);
    return { ...agentApi(a, stats, changes), runnable: isRunnable(a.agent_id) && isRunnableAgent(a.agent_id), recentDecisions: recent.rows.map(decisionApi) };
  }

  /**
   * Change what an agent is allowed to do. Every field that moves is written to the governance trail with the
   * officer who moved it; raising latitude without a reason is refused outright.
   */
  @RequirePerm('agents.configure') @Put(':agentId')
  async configure(@Param('agentId') agentId: string, @Body(zod(configureBody)) body: z.infer<typeof configureBody>, @CurrentUser() user: Principal) {
    const reason = (body.reason ?? '').trim();
    const entity = await withTx(this.pool, async (c) => {
      const a = await this.lock(c, agentId);
      const before = agentApi(a);
      const changes: { field: string; from: string; to: string }[] = [];
      const sets: string[] = []; const args: unknown[] = [];
      const set = (col: string, value: unknown) => { args.push(value); sets.push(`${col} = $${args.length}`); };

      if (body.autonomyLevel && body.autonomyLevel !== a.autonomy_level) {
        if (raisesAutonomy(a.autonomy_level as AutonomyLevel, body.autonomyLevel) && !reason) {
          throw badRequest("Raising an agent's autonomy requires a written reason");
        }
        changes.push({ field: 'autonomyLevel', from: a.autonomy_level, to: body.autonomyLevel });
        set('autonomy_level', body.autonomyLevel);
      }
      if (body.confidenceThreshold !== undefined && Number(body.confidenceThreshold) !== Number(a.confidence_threshold)) {
        if (Number(body.confidenceThreshold) < this.env.ABSOLUTE_MIN_CONFIDENCE) {
          throw badRequest(`The confidence threshold cannot be set below the platform floor of ${this.env.ABSOLUTE_MIN_CONFIDENCE}`);
        }
        changes.push({ field: 'confidenceThreshold', from: String(Number(a.confidence_threshold)), to: String(body.confidenceThreshold) });
        set('confidence_threshold', body.confidenceThreshold);
      }
      if (body.requiresConfirmation !== undefined && body.requiresConfirmation !== a.requires_confirmation) {
        // dropping the confirmation requirement widens what the agent may do alone, so it is justified like a level change
        if (!body.requiresConfirmation && !reason) throw badRequest('Removing the confirmation requirement requires a written reason');
        changes.push({ field: 'requiresConfirmation', from: String(a.requires_confirmation), to: String(body.requiresConfirmation) });
        set('requires_confirmation', body.requiresConfirmation);
      }
      if (body.enabled !== undefined && body.enabled !== a.enabled) {
        changes.push({ field: 'enabled', from: String(a.enabled), to: String(body.enabled) });
        set('enabled', body.enabled);
      }
      if (body.maxActionsPerHour !== undefined && body.maxActionsPerHour !== a.max_actions_per_hour) {
        changes.push({ field: 'maxActionsPerHour', from: String(a.max_actions_per_hour), to: String(body.maxActionsPerHour) });
        set('max_actions_per_hour', body.maxActionsPerHour);
      }
      if (body.escalateTo !== undefined && body.escalateTo !== a.escalate_to) {
        changes.push({ field: 'escalateTo', from: a.escalate_to, to: body.escalateTo });
        set('escalate_to', body.escalateTo);
      }
      if (!changes.length) throw badRequest('Nothing to change');

      args.push(a.agent_id);
      const updated = (await c.query<AgentRecord>(`UPDATE agents SET ${sets.join(', ')}, updated_at = now() WHERE agent_id = $${args.length} RETURNING *`, args)).rows[0];
      for (const ch of changes) {
        await c.query('INSERT INTO agent_changes(agent_id, field, from_value, to_value, by_id, by, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)',
          [a.agent_id, ch.field, ch.from, ch.to, user.id, user.name, reason]);
      }
      const stats = await this.statsOf(c, a.agent_id);
      const after = await publishAgent(c, this.env, updated, stats, {
        event: EVENTS.ai.agentConfigured, data: { changes, reason, by: user.name, policy: policyOf(updated) },
      });
      await this.audit.record(c, {
        action: 'AGENT_CONFIGURED', entity: 'Agent', entityId: updated.id, entityLabel: `${updated.name}: ${changes.map((ch) => `${ch.field} ${ch.from} → ${ch.to}`).join(', ')}`,
        before, after, note: reason || 'Configuration changed',
      });
      return { ...after, changes: (await changesOf(c, a.agent_id)).map((ch) => ({ field: ch.field, from: ch.from_value, to: ch.to_value, at: ch.at.toISOString(), by: ch.by, byId: ch.by_id || null, reason: ch.reason })) };
    });
    return entity;
  }

  /** Suspend an agent producing biased or inaccurate output — or put it back to work. */
  @RequirePerm('agents.configure') @Post(':agentId/suspend')
  async suspend(@Param('agentId') agentId: string, @Body(zod(suspendBody)) body: z.infer<typeof suspendBody>, @CurrentUser() user: Principal) {
    const reason = body.reason.trim();
    if (body.suspended && !reason) throw badRequest('A reason is required to suspend an agent');
    return withTx(this.pool, async (c) => {
      const a = await this.lock(c, agentId);
      if (a.suspended === body.suspended) throw conflict(body.suspended ? 'Agent is already suspended' : 'Agent is not suspended');
      const before = agentApi(a);
      const at = new Date();
      const updated = (await c.query<AgentRecord>(
        'UPDATE agents SET suspended = $2, suspended_reason = $3, suspended_by = $4, suspended_at = $5, updated_at = now() WHERE agent_id = $1 RETURNING *',
        [a.agent_id, body.suspended, body.suspended ? reason : '', body.suspended ? user.name : '', body.suspended ? at : null])).rows[0];
      await c.query('INSERT INTO agent_changes(agent_id, field, from_value, to_value, by_id, by, reason) VALUES ($1,$2,$3,$4,$5,$6,$7)',
        [a.agent_id, 'suspended', String(a.suspended), String(body.suspended), user.id, user.name, reason || 'Reinstated after investigation']);
      const stats = await this.statsOf(c, a.agent_id);
      const after = await publishAgent(c, this.env, updated, stats, { event: EVENTS.ai.agentSuspended, data: { suspended: body.suspended, reason, by: user.name } });
      await this.audit.record(c, {
        action: body.suspended ? 'AGENT_SUSPENDED' : 'AGENT_REINSTATED', entity: 'Agent', entityId: updated.id,
        entityLabel: `${updated.name}${reason ? ` — ${reason}` : ''}`, before, after, note: reason || 'Reinstated after investigation',
      });
      return after;
    });
  }

  /**
   * Run an agent over the records it is responsible for, now. Every conclusion is recorded under the autonomy in
   * force — a suspended or disabled agent still runs, and every one of its conclusions is escalated instead of
   * applied, which is exactly what an officer wants to see before reinstating it.
   */
  @RequirePerm('agents.review') @Post(':agentId/run')
  async run(@Param('agentId') agentId: string, @Body(zod(runBody)) body: z.infer<typeof runBody>, @CurrentUser() user: Principal) {
    const agent = await this.load(this.pool, agentId);
    if (!isRunnableAgent(agent.agent_id)) throw badRequest('This agent runs on its own schedule and cannot be triggered here');
    const decisions = await withTx(this.pool, async (c) => runAgent(c, { env: this.env, audit: this.audit }, agent, {
      limit: body.limit, subjectId: body.subjectId, actor: { id: user.id, name: user.name, kind: 'user' },
    }));
    const byDisposition: Record<string, number> = {};
    for (const d of decisions) byDisposition[d.disposition] = (byDisposition[d.disposition] ?? 0) + 1;
    await withTx(this.pool, async (c) => {
      const fresh = await this.load(c, agent.agent_id);
      await publishAgent(c, this.env, fresh, await this.statsOf(c, agent.agent_id), {
        event: EVENTS.ai.agentRan,
        data: { recorded: decisions.length, applied: decisions.filter((d) => d.applied).length, byDisposition, by: user.name, onDemand: true },
      });
      await this.audit.record(c, {
        action: 'AGENT_RUN', entity: 'Agent', entityId: agent.id, entityLabel: `${agent.name} run on demand — ${decisions.length} decision(s) recorded`,
        after: { recorded: decisions.length, applied: decisions.filter((d) => d.applied).length, byDisposition },
      });
    });
    return {
      ran: agent.name, agentId: agent.agent_id, recorded: decisions.length,
      applied: decisions.filter((d) => d.applied).length, escalated: decisions.filter((d) => !d.applied).length,
      byDisposition, decisions: decisions.slice(0, 20),
    };
  }
}

export const toMetricAgent = (a: AgentRecord): MetricAgent => ({ agentId: a.agent_id, name: a.name, autonomyLevel: a.autonomy_level, enabled: a.enabled, suspended: a.suspended, mandated: a.mandated });
export const toMetricDecision = (d: Row): MetricDecision => ({
  agentId: d.agent_id, agentName: d.agent_name, disposition: d.disposition, reviewStatus: d.review_status,
  confidence: Number(d.confidence) || 0, autonomyLevel: d.autonomy_level, applied: d.applied, escalationCode: d.escalation_code,
  at: d.at, cohort: d.cohort ?? {}, output: d.output ?? {},
});
