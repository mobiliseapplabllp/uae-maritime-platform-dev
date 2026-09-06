import { Body, Controller, Get, Headers, Inject, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { AiGatewayClient, AuditClient, CurrentUser, KIT_POOL, RequirePerm, badGateway, badRequest, notFound, withTx, zod, type Principal } from '@maritime/service-kit';
import type { Pool } from 'pg';
import { GATEWAY_CLIENT } from './providers';
import { INSIGHT_MODULES, MODULE_DASHBOARD, insightsFor } from './insights';

/* Insights for one module, computed from the dashboard the module already keeps, read through the tool gateway as
 * the person looking. What they may not see, the gateway refuses, and the refusal is the answer. An insight's action
 * runs the same way: as that person, logged as theirs. */

const actBody = z.object({ module: z.string().trim().min(1).max(20), insightId: z.string().trim().max(120).default(''), tool: z.string().trim().min(1).max(80), args: z.record(z.unknown()).default({}) });
const bearer = (h?: string) => (h ?? '').replace(/^Bearer\s+/i, '').trim() || undefined;

@Controller('agents/insights')
export class InsightsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(GATEWAY_CLIENT) private readonly gateway: AiGatewayClient, private readonly audit: AuditClient) {}

  @RequirePerm('dashboard.view') @Get(':module')
  async forModule(@Param('module') module: string, @Headers('authorization') authorization?: string) {
    const tool = MODULE_DASHBOARD[module];
    if (!tool) throw notFound(`No insights are defined for ${module}`);
    const run = await this.gateway.run('agent:insights', tool, {}, { userToken: bearer(authorization), cause: `insights:${module}` });
    if (run.outcome === 'REFUSED') return { module, generatedAt: new Date().toISOString(), source: 'rules', insights: [], refused: { code: run.code, reason: run.reason } };
    if (run.outcome !== 'OK') throw badGateway(`${module}'s dashboard could not be read: ${run.reason ?? run.outcome}`);
    const insights = insightsFor(module, run.data as Record<string, unknown>);
    return { module, generatedAt: new Date().toISOString(), source: 'rules', dashboardCallId: run.callId, insights, counts: { critical: insights.filter((i) => i.severity === 'critical').length, warning: insights.filter((i) => i.severity === 'warning').length, info: insights.filter((i) => i.severity === 'info').length } };
  }

  @RequirePerm('dashboard.view') @Get()
  modules() { return { modules: INSIGHT_MODULES.map((m) => ({ module: m, dashboardTool: MODULE_DASHBOARD[m] })) }; }

  /** Carries an insight's action through the gateway as the person who clicked it. */
  @RequirePerm('dashboard.view') @Post('act')
  async act(@Body(zod(actBody)) body: z.infer<typeof actBody>, @CurrentUser() user: Principal, @Headers('authorization') authorization?: string) {
    const token = bearer(authorization);
    if (!token) throw badRequest('An action runs as the person asking; no session token was carried');
    const run = await this.gateway.run('svc:ai-agents', body.tool, body.args, { userToken: token, cause: `insight:${body.insightId || body.module}` });
    if (run.tier === 'ACT' || run.tier === 'PROPOSE') {
      await withTx(this.pool, async (c) => this.audit.record(c, { action: run.outcome === 'OK' ? 'AI_INSIGHT_ACTED' : 'AI_INSIGHT_ACTION_REFUSED', entity: 'AiInsight', entityId: body.insightId || body.module, entityLabel: body.tool, after: { module: body.module, tool: body.tool, args: body.args, outcome: run.outcome, code: run.code ?? null, reason: run.reason ?? null, callId: run.callId }, actor: { id: user.id, name: user.name, kind: 'user' } }));
    }
    return run;
  }
}
