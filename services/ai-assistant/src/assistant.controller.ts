import { Body, Controller, Get, Headers, Inject, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import {
  AiGatewayClient, ApiError, AuditClient, CurrentUser, KIT_ENV, KIT_POOL, KIT_SETTINGS, RequirePerm, SettingsClient, badRequest, forbidden, notFound, withTx, zod, type Principal,
} from '@maritime/service-kit';
import type { Env } from './env';
import { COMPLETION_CLIENT, LocalCompletionClient, ToolGatewayCompletionClient, type CompletionClient, type Language } from './completion';
import { aiSettingsOf, estimateTokens, type AiSettings } from './ai-settings';
import { GATEWAY_CLIENT, INDEX_CACHE } from './providers';
import { answer, retrieve, suggestionsFor, type IndexCache } from './assistant';
import { TOOLS, toolCatalogue } from './tools';
import { GATEWAY_TOOLS } from './gateway-tools';
import { appendMessage, conversationApi, createConversation, messagesOf, publishConversation, titleFrom, type ConversationRecord } from './conversations';
import { EVENTS } from '@maritime/contracts';

/* The assistant's own surface: ask a question, see what it can retrieve, and see what it is allowed to read.
 *
 * Everything here runs under the asking principal's permissions and no others. The assistant holds no standing
 * of its own, which is why the chat handler passes `user.perms` down and never a widened set. */

const extractBody = z.object({ documentRef: z.string().trim().min(1).max(300), fields: z.array(z.string().trim().min(1).max(80)).min(1).max(40), subject: z.string().max(120).optional(), pages: z.number().int().min(1).max(500).default(1) });
const chatBody = z.object({
  message: z.string().trim().min(1).max(2000),
  conversationId: z.string().trim().uuid().optional(),
  language: z.enum(['en', 'ar']).optional(),
});

@Controller('ai')
export class AssistantController {
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    @Inject(COMPLETION_CLIENT) private readonly completion: CompletionClient,
    @Inject(INDEX_CACHE) private readonly indexCache: IndexCache,
    @Inject(KIT_SETTINGS) private readonly settings: SettingsClient,
    @Inject(GATEWAY_CLIENT) private readonly gateway: AiGatewayClient,
    private readonly audit: AuditClient,
  ) {}

  private get gatewayMode() { return this.env.TOOL_MODE === 'gateway'; }
  private get toolSurface() { return this.gatewayMode ? GATEWAY_TOOLS : TOOLS; }

  /** Which client composes: grounded-only or a local provider pins the platform composer; otherwise the tool gateway composes through the provider Settings → AI names, as the person asking. */
  private clientFor(ai: AiSettings, userToken?: string): CompletionClient {
    if (ai.groundedOnly || ai.provider === 'local') return new LocalCompletionClient(ai.profile);
    if (this.gatewayMode) return new ToolGatewayCompletionClient(this.gateway, ai.profile, userToken);
    return this.completion;
  }
  private async usageToday(): Promise<{ tokens: number; questions: number }> {
    const r = await this.pool.query<{ tokens: string; questions: number }>('SELECT tokens::text, questions FROM ai_usage WHERE day = current_date');
    return { tokens: Number(r.rows[0]?.tokens ?? 0), questions: Number(r.rows[0]?.questions ?? 0) };
  }

  /** The assistant's standing: switched on or off, which profile composes, and how much of today's budget is left. */
  @RequirePerm('ai.use') @Get('status')
  async status() {
    const ai = await aiSettingsOf(this.settings, this.env);
    const used = await this.usageToday();
    const remaining = ai.dailyTokenBudget > 0 ? Math.max(0, ai.dailyTokenBudget - used.tokens) : null;
    return {
      enabled: ai.enabled, provider: ai.provider, profile: ai.profile, groundedOnly: ai.groundedOnly, temperature: ai.temperature,
      composer: ai.groundedOnly || ai.provider === 'local' || !this.gatewayMode ? 'platform composer' : 'tool gateway',
      keyConfigured: !!ai.apiKey,
      toolMode: this.env.TOOL_MODE,
      budget: { dailyTokens: ai.dailyTokenBudget, usedToday: used.tokens, questionsToday: used.questions, remaining, exhausted: ai.dailyTokenBudget > 0 && used.tokens >= ai.dailyTokenBudget },
    };
  }

  /** What the dock offers when a conversation is empty. */
  @RequirePerm('ai.use') @Get('suggestions')
  suggestions(@Query('module') module?: string) { return suggestionsFor(String(module ?? '').trim().toLowerCase() || undefined); }

  /** The tool surface, with the permission each tool sits behind and whether this reader holds it. */
  @RequirePerm('ai.use') @Get('tools')
  tools(@CurrentUser() user: Principal) {
    return toolCatalogue(this.toolSurface).map((t) => ({ ...t, available: user.perms.includes('*') || user.perms.includes(t.permission) }));
  }

  /** Document intelligence: the fields asked for, read out of a lodged document by the in-country model platform, through the gateway as this reader. */
  @RequirePerm('ai.use') @Post('extract')
  async extract(@Body(zod(extractBody)) body: z.infer<typeof extractBody>, @CurrentUser() user: Principal, @Headers('authorization') authorization?: string) {
    if (!this.gatewayMode) throw new ApiError(503, 'Document intelligence needs the tool gateway, which this deployment runs without');
    const userToken = (authorization ?? '').replace(/^Bearer\s+/i, '').trim() || undefined;
    const run = await this.gateway.run('assistant', 'docs.extract', { documentRef: body.documentRef, fields: body.fields.join(','), subject: body.subject ?? '', pages: body.pages }, { userToken, cause: 'extract' });
    if (run.outcome === 'REFUSED') throw new ApiError(403, run.reason ?? 'Refused at the tool gateway');
    if (run.outcome !== 'OK') throw new ApiError(502, run.reason ?? 'The model platform did not answer');
    await withTx(this.pool, async (c) => this.audit.record(c, { action: 'AI_DOCUMENT_READ', entity: 'Document', entityId: body.documentRef, entityLabel: body.subject ?? body.documentRef, after: { fields: body.fields, callId: run.callId }, actor: { id: user.id, name: user.name, kind: 'user' } }));
    return { callId: run.callId, ...(run.data as Record<string, unknown>) };
  }

  /** Retrieval on its own: the passages this reader may see, with their scores and their records. */
  @RequirePerm('ai.use') @Get('search')
  async search(@Query() query: { q?: string; kind?: string; limit?: string }, @CurrentUser() user: Principal) {
    const q = String(query.q ?? '').trim();
    if (!q) throw badRequest('Give me something to look for');
    const index = await this.indexCache.get();
    const hits = await retrieve(this.pool, index, q, {
      permissions: user.perms, topK: Math.min(20, Number(query.limit) || this.env.RETRIEVAL_TOP_K),
      minScore: this.env.RETRIEVAL_MIN_SCORE, kinds: query.kind ? query.kind.split(',').map((s) => s.trim()) : undefined,
      denseWeight: this.env.RETRIEVAL_DENSE_WEIGHT, annMinDocs: this.env.RETRIEVAL_ANN_MIN_DOCS,
      forceMemory: this.env.RETRIEVAL_VECTOR_MODE === 'memory',
    });
    return hits.map((h) => ({
      id: h.doc.id, kind: h.doc.kind, ref: h.doc.ref, title: h.doc.title, titleAr: h.doc.titleAr ?? null, link: h.doc.link,
      permission: h.doc.permission, score: h.score, lexical: h.lexical, fuzzy: h.dense,
      untrusted: h.doc.untrusted, markers: h.doc.injectionMarkers,
      excerpt: h.doc.body.replace(/\s+/g, ' ').slice(0, 300),
    }));
  }

  /**
   * One turn. The question chooses the tools, the reader's permissions decide which of them run, retrieval is
   * scoped to what that reader may see, and only then is anything composed. Both turns are recorded so the
   * conversation is a true account of what the reader was shown.
   */
  @RequirePerm('ai.use') @Post('chat')
  async chat(@Body(zod(chatBody)) body: z.infer<typeof chatBody>, @CurrentUser() user: Principal, @Headers('authorization') authorization?: string) {
    // the person's own token travels to the gateway: every read the answer needs runs as them, and is logged as theirs
    const userToken = this.gatewayMode ? (authorization ?? '').replace(/^Bearer\s+/i, '').trim() || undefined : undefined;
    // the settings first: an assistant that is switched off, or has spent its day, answers with the reason rather than a reply
    const ai = await aiSettingsOf(this.settings, this.env);
    if (!ai.enabled) throw new ApiError(503, 'The assistant is switched off in Settings → AI assistant');
    const used = await this.usageToday();
    if (ai.dailyTokenBudget > 0 && used.tokens >= ai.dailyTokenBudget) throw new ApiError(429, `The assistant has spent today's token budget (${used.tokens.toLocaleString('en-GB')} of ${ai.dailyTokenBudget.toLocaleString('en-GB')}). It resumes tomorrow, or when the budget is raised in Settings → AI assistant.`);
    const index = await this.indexCache.get();
    const language = (body.language ?? 'en') as Language;

    const conversation = await withTx(this.pool, async (c) => {
      if (body.conversationId) {
        const r = await c.query<ConversationRecord>('SELECT * FROM conversations WHERE id = $1', [body.conversationId]);
        if (!r.rows[0]) throw notFound('Conversation not found');
        if (r.rows[0].user_id !== user.id) throw forbidden('This conversation belongs to another user');
        return r.rows[0];
      }
      const created = await createConversation(c, { id: user.id, name: user.name }, titleFrom(body.message), language);
      await publishConversation(c, this.env, created, { event: EVENTS.ai.conversationStarted });
      await this.audit.record(c, { action: 'AI_CONVERSATION_STARTED', entity: 'AiConversation', entityId: created.id, entityLabel: created.title, after: conversationApi(created) });
      return created;
    });

    const history = (await messagesOf(this.pool, conversation.id, this.env.HISTORY_TURNS * 2))
      .map((m) => ({ role: m.role as 'user' | 'assistant', text: m.text }));

    const result = await answer(
      { env: this.env, db: this.pool, completion: this.clientFor(ai, userToken), index, tools: this.toolSurface, gateway: this.gatewayMode ? this.gateway : undefined },
      { question: body.message, permissions: user.perms, history, language, completionOptions: { profile: ai.profile, temperature: ai.temperature }, userToken },
    );
    const tokens = estimateTokens(body.message, result.reply, result.citations.length);

    const messageId = await withTx(this.pool, async (c) => {
      await appendMessage(c, conversation.id, { role: 'user', text: body.message });
      const assistantMessage = await appendMessage(c, conversation.id, {
        role: 'assistant', text: result.reply, citations: result.citations, tools: result.tools,
        refusals: result.refusals, flagged: result.flagged, engine: result.engine, latency_ms: result.latencyMs,
      });
      const fresh = (await c.query<ConversationRecord>('SELECT * FROM conversations WHERE id = $1', [conversation.id])).rows[0];
      await publishConversation(c, this.env, fresh, {
        event: EVENTS.ai.answered,
        data: {
          messageId: assistantMessage.id, question: body.message, citations: result.citations.length,
          tools: result.tools.map((t) => t.tool), refused: result.refusals.map((r) => r.tool),
          flagged: result.flagged.map((f) => f.id), grounded: result.grounded, engine: result.engine,
        },
      });
      await c.query('INSERT INTO ai_usage(day, tokens, questions) VALUES (current_date, $1, 1) ON CONFLICT (day) DO UPDATE SET tokens = ai_usage.tokens + EXCLUDED.tokens, questions = ai_usage.questions + 1, updated_at = now()', [tokens]);
      await this.audit.record(c, {
        action: 'AI_ANSWERED', entity: 'AiConversation', entityId: conversation.id, entityLabel: conversation.title,
        after: { messageId: assistantMessage.id, tools: result.tools.map((t) => t.tool), refused: result.refusals.map((r) => r.tool), citations: result.citations.length },
        note: result.flagged.length ? `Retrieved content carrying instruction markers was quoted, not followed (${result.flagged.length})` : 'Answered from the platform record',
      });
      return assistantMessage.id;
    });

    return {
      conversationId: conversation.id, messageId,
      reply: result.reply, sources: result.sources, suggestions: result.suggestions, engine: result.engine,
      citations: result.citations, tools: result.tools, refusals: result.refusals, flagged: result.flagged,
      grounded: result.grounded, latencyMs: result.latencyMs,
      usage: { tokens, todayTokens: used.tokens + tokens, dailyTokenBudget: ai.dailyTokenBudget },
    };
  }
}
