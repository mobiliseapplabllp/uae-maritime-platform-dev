import { Body, Controller, Headers, Inject, Post } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { ApiError, AuditClient, CurrentUser, KIT_ENV, KIT_POOL, KIT_SETTINGS, RequirePerm, SettingsClient, forbidden, notFound, withTx, zod, type AiGatewayClient, type Principal } from '@maritime/service-kit';
import type { Env } from './env';
import { aiSettingsOf, type AiSettings } from './ai-settings';
import { GATEWAY_CLIENT } from './providers';
import { ASSISTANT_CONTRACT, ToolGatewayCompletionClient, type CompletionClient } from './completion';
import { composeDefinition, findTemplate, readTemplate, type DefinitionDraft } from './definition-drafts';
import { mayRead } from './retrieval';

/* Drafting a service definition for the Service Studio.
 *
 * The composer is deterministic: it reads the description and, through the tool gateway as the officer asking,
 * the template. When Settings → AI name a hosted provider, that provider is asked for the Arabic wording of the
 * name and the description — through the same gateway, under the same contract — and its answer is taken only
 * when it parses and is Arabic; the composer's own words stand otherwise. Nothing is created here: the Studio
 * creates the definition as a DEV draft when the person says so, and the runtime validates it there. */

const draftBody = z.object({
  description: z.string().trim().min(12).max(4000),
  name: z.string().trim().max(120).optional(),
  /** A definition key or id to draft from; without one, the catalogue is searched for the closest published service. */
  basedOn: z.string().trim().max(120).optional(),
  subjectKind: z.string().trim().max(20).optional(),
  category: z.string().trim().max(80).optional(),
  language: z.enum(['en', 'ar']).default('en'),
  suggestTemplate: z.boolean().default(true),
});
const bearer = (h?: string) => (h ?? '').replace(/^Bearer\s+/i, '').trim() || undefined;
const ARABIC = /[؀-ۿ]/;

@Controller('ai/definitions')
export class DefinitionsController {
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    @Inject(KIT_SETTINGS) private readonly settings: SettingsClient,
    @Inject(GATEWAY_CLIENT) private readonly gateway: AiGatewayClient,
    private readonly audit: AuditClient,
  ) {}

  /** Composes a definition from a plain-language description: a proposal for the Studio, never a record. */
  @RequirePerm('ai.use') @Post('draft')
  async draft(@Body(zod(draftBody)) body: z.infer<typeof draftBody>, @CurrentUser() user: Principal, @Headers('authorization') authorization?: string): Promise<DefinitionDraft> {
    const ai = await aiSettingsOf(this.settings, this.env);
    if (!ai.enabled) throw new ApiError(503, 'The assistant is switched off in Settings → AI assistant');
    if (!mayRead('services.manage', user.perms)) throw forbidden('Drafting a service definition needs the services.manage permission');
    const viaGateway = this.env.TOOL_MODE === 'gateway';
    const reader = { gateway: viaGateway ? this.gateway : undefined, userToken: viaGateway ? bearer(authorization) : undefined };
    const template = body.basedOn ? await readTemplate(reader, body.basedOn) : body.suggestTemplate ? await findTemplate(reader, body.description) : null;
    if (body.basedOn && !template) throw notFound(`No service definition ${body.basedOn} could be read through the tool gateway to draft from`);
    const draft = composeDefinition(body, template);
    if (viaGateway && ai.provider !== 'local') await refineArabic(draft, new ToolGatewayCompletionClient(this.gateway, ai.profile, reader.userToken), ai);
    await withTx(this.pool, (c) => this.audit.record(c, {
      action: 'AI_DEFINITION_DRAFTED', entity: 'ServiceDefinition', entityId: draft.key, entityLabel: draft.name,
      after: {
        basedOn: draft.basedOn?.key ?? null, subjectKind: draft.subjectKind, category: draft.category, documents: draft.content.documents.length,
        feeLines: draft.content.fees.lines.length, slaDays: draft.content.sla.days, instrument: draft.issuesInstrument, gaps: draft.gaps.length, engine: draft.engine,
      },
      actor: { id: user.id, name: user.name, kind: 'user' }, note: 'Definition drafted by the assistant from a plain-language description; nothing created',
    }));
    return draft;
  }
}

/** The Arabic wording from the hosted provider, taken only when it parses as JSON and is Arabic. */
async function refineArabic(draft: DefinitionDraft, client: CompletionClient, ai: AiSettings) {
  try {
    const r = await client.complete({
      contract: `${ASSISTANT_CONTRACT}\nYou also translate service names and descriptions for the authority's bilingual catalogue. Reply with JSON only, of the form {"nameAr": "...", "descriptionAr": "..."}, in formal administrative Arabic.`,
      question: `Service name: ${draft.name}\nDescription: ${draft.description}\nGive the Arabic name and a one-paragraph Arabic description as JSON.`,
      grounding: [], findings: [], refusals: [], history: [], language: 'ar',
    }, { profile: ai.profile, temperature: 0 });
    if (!r.provider || r.refused) return;
    const json = r.text.match(/\{[\s\S]*\}/)?.[0]; if (!json) return;
    const parsed = JSON.parse(json) as { nameAr?: unknown; descriptionAr?: unknown };
    let took = false;
    if (typeof parsed.nameAr === 'string' && ARABIC.test(parsed.nameAr)) { draft.nameAr = parsed.nameAr.trim().slice(0, 200); draft.gaps = draft.gaps.filter((g) => !g.en.startsWith('The Arabic name is a suggestion')); took = true; }
    if (typeof parsed.descriptionAr === 'string' && ARABIC.test(parsed.descriptionAr)) { draft.descriptionAr = parsed.descriptionAr.trim().slice(0, 2000); draft.gaps = draft.gaps.filter((g) => !g.en.startsWith('Write the Arabic description')); took = true; }
    if (!took) return;
    draft.engine = `platform composer; Arabic wording by ${r.profile} via tool gateway${r.residency === 'AE' ? ', in-country' : ', hosted abroad'}`;
    draft.inferred.push({ field: 'nameAr', value: draft.nameAr, evidence: `${r.profile} via tool gateway` });
    draft.gaps.push({ en: 'The Arabic wording came from the hosted model; read it before publishing.', ar: 'الصياغة العربية من النموذج المستضاف؛ راجعها قبل النشر.' });
  } catch { /* the composer's words stand */ }
}
