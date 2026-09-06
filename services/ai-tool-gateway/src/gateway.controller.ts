import { Body, Controller, Get, Headers, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import { CurrentUser, RequirePerm, ServiceOnly, badRequest, notFound, zod, type Principal } from '@maritime/service-kit';
import { GatewayService } from './gateway.service';
import { TIERS, isTier } from './policy';

/* Two faces. The service face — catalogue, run, complete — is reachable only with the service token, and carries
 * the person's own token alongside when the call is on someone's behalf. The governance face is for people who
 * hold the agent permissions: what was called, what was refused, what left the platform, and who may call what. */

const runBody = z.object({
  caller: z.string().trim().min(1).max(80),
  args: z.record(z.unknown()).default({}),
  dryRun: z.boolean().default(false),
  decisionId: z.string().trim().max(80).optional(),
  cause: z.string().trim().max(200).optional(),
});
const completeBody = z.object({
  caller: z.string().trim().min(1).max(80),
  purpose: z.string().trim().max(40).default('answer'),
  contract: z.string().max(4000).default(''),
  question: z.string().min(1).max(20_000),
  language: z.enum(['en', 'ar']).default('en'),
  grounding: z.array(z.object({ marker: z.string().max(20), label: z.string().max(300), kind: z.string().max(60), untrusted: z.boolean().optional(), text: z.string().max(6000) })).max(40).default([]),
  findings: z.array(z.string().max(4000)).max(60).default([]),
  refusals: z.array(z.string().max(400)).max(40).default([]),
  history: z.array(z.object({ role: z.enum(['user', 'assistant']), text: z.string().max(6000) })).max(40).default([]),
  temperature: z.number().min(0).max(1).optional(),
});
const callerBody = z.object({
  allowedTools: z.array(z.string().trim().min(1).max(80)).max(200).optional(),
  maxTier: z.string().refine(isTier, `maxTier must be one of ${TIERS.join(', ')}`).optional(),
  hourlyQuota: z.number().int().min(1).max(100_000).optional(),
  dailyQuota: z.number().int().min(1).max(1_000_000).optional(),
  enabled: z.boolean().optional(),
  note: z.string().max(400).optional(),
});
const toolBody = z.object({ enabled: z.boolean() });
const bearer = (h?: string) => (h ?? '').replace(/^Bearer\s+/i, '').trim() || undefined;

@Controller('ai-gateway')
export class GatewayController {
  constructor(private readonly gateway: GatewayService) {}

  /* ------------------------------------------------------------------------------ the service face --- */

  /** The catalogue as one caller sees it: every tool, with whether this caller may reach it. */
  @ServiceOnly() @Get('tools/catalogue')
  async catalogue(@Query('caller') caller?: string) {
    const tools = await this.gateway.catalogue(caller?.trim() || undefined);
    return { caller: caller ?? null, tools: tools.map((t) => ({ name: t.name, module: t.module, label: t.label, labelAr: t.labelAr, description: t.description, tier: t.tier, permission: t.permission, exposure: t.exposure, input: t.input, triggers: t.triggers, enabled: t.enabled, allowed: t.allowed })) };
  }

  /** Runs one tool for a caller, as the person whose token is forwarded in `x-user-token` or as the agent the caller is. */
  @ServiceOnly() @Post('tools/:name/run')
  async run(@Param('name') name: string, @Body(zod(runBody)) body: z.infer<typeof runBody>, @Headers('x-user-token') userToken?: string) {
    return this.gateway.run(body.caller, name, body.args, { userToken: bearer(userToken), dryRun: body.dryRun, decisionId: body.decisionId, cause: body.cause });
  }

  /** One completion through the configured provider: redacted, fenced, classified, fingerprinted and logged. */
  @ServiceOnly() @Post('complete')
  async complete(@Body(zod(completeBody)) body: z.infer<typeof completeBody>, @Headers('x-user-token') userToken?: string) {
    const { caller, ...req } = body;
    return this.gateway.complete(caller, req, { userToken: bearer(userToken) });
  }

  /* --------------------------------------------------------------------------- the governance face --- */

  @RequirePerm('agents.view') @Get('tools')
  async tools() {
    const tools = await this.gateway.catalogue();
    return tools.map((t) => ({ name: t.name, module: t.module, label: t.label, labelAr: t.labelAr, description: t.description, tier: t.tier, permission: t.permission, exposure: t.exposure, upstream: `${t.upstream.method} ${t.upstream.service}${t.upstream.path}`, enabled: t.enabled, args: Object.keys(t.input) }));
  }

  @RequirePerm('agents.configure') @Put('tools/:name')
  async setTool(@Param('name') name: string, @Body(zod(toolBody)) body: z.infer<typeof toolBody>, @CurrentUser() user: Principal) {
    const r = await this.gateway.setToolEnabled(name, body.enabled, user);
    if (!r) throw notFound('No such tool');
    return { name: r.name, enabled: r.enabled };
  }

  @RequirePerm('agents.view') @Get('calls')
  calls(@Query() q: { caller?: string; outcome?: string; tool?: string; module?: string; tier?: string; sinceHours?: string; limit?: string }) {
    return this.gateway.calls({ caller: q.caller, outcome: q.outcome, tool: q.tool, module: q.module, tier: q.tier, sinceHours: num(q.sinceHours), limit: num(q.limit) });
  }

  @RequirePerm('agents.view') @Get('inferences')
  inferences(@Query() q: { caller?: string; outcome?: string; sinceHours?: string; limit?: string }) {
    return this.gateway.inferences({ caller: q.caller, outcome: q.outcome, sinceHours: num(q.sinceHours), limit: num(q.limit) });
  }

  @RequirePerm('agents.view') @Get('stats')
  stats() { return this.gateway.stats(); }

  @RequirePerm('agents.view') @Get('callers')
  callers() { return this.gateway.listCallers(); }

  @RequirePerm('agents.configure') @Put('callers/:id')
  async updateCaller(@Param('id') id: string, @Body(zod(callerBody)) body: z.infer<typeof callerBody>, @CurrentUser() user: Principal) {
    if (!Object.keys(body).length) throw badRequest('Nothing to change');
    const r = await this.gateway.updateCaller(id, body as never, user);
    if (!r) throw notFound('No such caller');
    return r;
  }
}

const num = (v?: string) => (v === undefined || v === '' ? undefined : Number(v));
