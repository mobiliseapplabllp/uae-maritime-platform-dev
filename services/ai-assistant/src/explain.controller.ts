import { Body, Controller, Headers, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { ApiError, CurrentUser, KIT_ENV, KIT_POOL, KIT_SETTINGS, RequirePerm, SettingsClient, zod, type AiGatewayClient, type Principal } from '@maritime/service-kit';
import type { Env } from './env';
import { aiSettingsOf } from './ai-settings';
import { GATEWAY_CLIENT } from './providers';
import { ASSISTANT_CONTRACT, ToolGatewayCompletionClient } from './completion';
import { explainLocally, type ExplainInput } from './explain';

/* "Explain this" on a dashboard card.
 *
 * The card sends the figures it is drawn from; the explanation is composed from those figures — the facts are
 * deterministic and stay in the answer as its record — and, when Settings → AI name a provider, the prose is
 * written by that provider through the tool gateway, as the person asking, with the facts and the figures as its
 * only grounding. Grounded-only mode, or no provider, keeps the platform composer's own prose. */

const EXPLAIN_CONTRACT = `${ASSISTANT_CONTRACT} The reader is looking at one figure on a dashboard. Explain, in three to five short sentences, what it shows, what the numbers say, whether it is on target, and what usually moves it. Use only the facts and the records supplied; where they do not answer something, say so rather than guess.`;
const scalar = z.union([z.string().trim().max(120), z.number()]).nullable().optional();
const explainBody = z.object({
  kind: z.enum(['chart', 'stat', 'yardstick', 'panel', 'list']),
  title: z.string().trim().min(1).max(200),
  sub: z.string().trim().max(400).optional(),
  module: z.string().trim().max(24).optional(),
  data: z.unknown().optional(),
  value: scalar, target: scalar,
  unit: z.string().trim().max(24).optional(),
  period: z.string().trim().max(80).optional(),
  language: z.enum(['en', 'ar']).default('en'),
});
const bearer = (h?: string) => (h ?? '').replace(/^Bearer\s+/i, '').trim() || undefined;

@Controller('ai')
export class ExplainController {
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    @Inject(KIT_SETTINGS) private readonly settings: SettingsClient,
    @Inject(GATEWAY_CLIENT) private readonly gateway: AiGatewayClient,
  ) {}

  @RequirePerm('ai.use') @Post('explain')
  async explain(@Body(zod(explainBody)) body: z.infer<typeof explainBody>, @CurrentUser() user: Principal, @Headers('authorization') authorization?: string) {
    const ai = await aiSettingsOf(this.settings, this.env);
    if (!ai.enabled) throw new ApiError(503, 'The assistant is switched off in Settings → AI assistant');
    if (body.data !== undefined && JSON.stringify(body.data).length > 200_000) throw new ApiError(413, 'The figures sent are too large to explain; send the rows the card draws, not the whole register');
    const used = await this.pool.query<{ tokens: string }>('SELECT tokens::text FROM ai_usage WHERE day = current_date');
    const spent = Number(used.rows[0]?.tokens ?? 0);
    if (ai.dailyTokenBudget > 0 && spent >= ai.dailyTokenBudget) throw new ApiError(429, `The assistant has spent today's token budget (${spent.toLocaleString('en-GB')} of ${ai.dailyTokenBudget.toLocaleString('en-GB')} tokens)`);

    const input: ExplainInput = { ...body, value: body.value ?? undefined, target: body.target ?? undefined };
    const local = explainLocally(input);
    let text = local.text; let engine = 'platform composer'; let provider: string | undefined; let residency: string | undefined;
    const hosted = this.env.TOOL_MODE === 'gateway' && !ai.groundedOnly && ai.provider !== 'local';
    if (hosted) {
      const client = new ToolGatewayCompletionClient(this.gateway, ai.profile, bearer(authorization));
      const question = body.language === 'ar'
        ? `اشرح «${body.title}»${body.sub ? ` (${body.sub})` : ''} لضابط في الميناء.`
        : `Explain “${body.title}”${body.sub ? ` (${body.sub})` : ''} to a port officer.`;
      const r = await client.complete({ contract: EXPLAIN_CONTRACT, question, grounding: local.grounding.map((g, i) => ({ id: `explain-${i + 1}`, link: '', score: 1, ...g })), findings: local.facts, refusals: [], history: [], language: body.language }, { profile: ai.profile, temperature: ai.temperature, purpose: 'explain' });
      if (r.refused) { text = r.text; engine = 'refused at the tool gateway'; }
      else if (r.provider && r.provider !== 'local') {
        text = r.text; provider = r.provider; residency = r.residency;
        engine = r.provider === 'cli' ? `${r.profile} via the command line on the gateway host` : `${r.profile} via tool gateway, ${r.residency === 'AE' ? 'in-country' : 'hosted abroad'}`;
        if (r.tokens) await this.pool.query('INSERT INTO ai_usage(day, tokens, questions) VALUES (current_date, $1, 0) ON CONFLICT (day) DO UPDATE SET tokens = ai_usage.tokens + EXCLUDED.tokens', [r.tokens]);
      }
    }
    return { kind: body.kind, title: body.title, text, engine, provider, residency, grounded: true, facts: local.facts, meaning: local.meaning, askedBy: user.name };
  }
}
