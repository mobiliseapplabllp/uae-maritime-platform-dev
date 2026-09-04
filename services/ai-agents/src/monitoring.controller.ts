import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Pool } from 'pg';
import { KIT_ENV, KIT_POOL, RequirePerm } from '@maritime/service-kit';
import type { Env } from './env';
import { BIAS_DIMENSIONS, bias, drift, serviceLevels } from './metrics';
import { toMetricAgent, toMetricDecision } from './agents.controller';
import type { AgentRecord, Row } from './registry';

/* Drift, bias and the service levels.
 *
 * An agent that was right last quarter and is wrong this one looks identical from the outside unless somebody is
 * measuring, so all three reports read the same decision rows and the same reviewer verdicts. Nothing here is
 * derived from the agent's own opinion of itself: accuracy means agreement with the humans who reviewed it. */

@Controller('agents/monitoring')
export class MonitoringController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env) {}

  private async load(agentId?: string) {
    const args: unknown[] = [];
    let where = 'WHERE supersedes_id IS NULL';
    if (agentId) { args.push(agentId); where += ` AND agent_id = $${args.length}`; }
    const [agents, decisions] = await Promise.all([
      this.pool.query<AgentRecord>(`SELECT * FROM agents ${agentId ? 'WHERE agent_id = $1' : ''} ORDER BY mandated DESC, domain, name`, agentId ? [agentId] : []),
      // nosemgrep: maritime-sql-template-interpolation — the fragment is one of two literals chosen in code; the value travels as $1
      this.pool.query<Row>(`SELECT agent_id, agent_name, disposition, review_status, confidence, autonomy_level, applied, escalation_code, at, cohort, output FROM decisions ${where}`, args),
    ]);
    return { agents: agents.rows.map(toMetricAgent), decisions: decisions.rows.map(toMetricDecision) };
  }

  /** Rolling accuracy and confidence per agent, bucketed, with the agents whose agreement has fallen away. */
  @RequirePerm('agents.view') @Get('drift')
  async drift(@Query() query: { agentId?: string; windowDays?: string; bucketDays?: string }) {
    const { agents, decisions } = await this.load(query.agentId);
    return drift(decisions, agents, new Date(), {
      windowDays: Number(query.windowDays) || this.env.DRIFT_WINDOW_DAYS,
      bucketDays: Number(query.bucketDays) || this.env.DRIFT_BUCKET_DAYS,
    });
  }

  /** The bias audit across the dimensions the records carry, with the cohorts that warrant a human audit. */
  @RequirePerm('agents.view') @Get('bias')
  async bias(@Query() query: { agentId?: string; dimensions?: string }) {
    const { decisions } = await this.load(query.agentId);
    const dimensions = query.dimensions ? query.dimensions.split(',').map((s) => s.trim()).filter(Boolean) : BIAS_DIMENSIONS;
    return {
      agentId: query.agentId ?? null, minCohort: this.env.BIAS_MIN_COHORT, flagDeltaPct: this.env.BIAS_FLAG_DELTA_PCT,
      ...bias(decisions, dimensions, { minCohort: this.env.BIAS_MIN_COHORT, flagDeltaPct: this.env.BIAS_FLAG_DELTA_PCT }),
    };
  }

  /** The service levels the AI layer is measured against, including the high-risk false-positive rate. */
  @RequirePerm('agents.view') @Get('metrics')
  async metrics(@Query() query: { agentId?: string; windowDays?: string }) {
    const { decisions } = await this.load(query.agentId);
    return {
      agentId: query.agentId ?? null,
      ...serviceLevels(decisions, new Date(), {
        windowDays: Number(query.windowDays) || this.env.DRIFT_WINDOW_DAYS,
        agreementTarget: this.env.SLA_AGREEMENT_PCT,
        falsePositiveCeiling: this.env.SLA_MAX_FALSE_POSITIVE_PCT,
      }),
    };
  }
}
