import { Body, Controller, Get, Inject, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import {
  AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, badRequest, forbidden, notFound, withTx, zod, type Principal,
} from '@maritime/service-kit';
import type { Env } from './env';
import { COMPLETION_CLIENT, type CompletionClient, type Language } from './completion';
import { INDEX_CACHE } from './providers';
import { SUGGESTIONS, answer, retrieve, type IndexCache } from './assistant';
import { toolCatalogue } from './tools';
import { appendMessage, conversationApi, createConversation, messagesOf, publishConversation, titleFrom, type ConversationRecord } from './conversations';
import { EVENTS } from '@maritime/contracts';

/* The assistant's own surface: ask a question, see what it can retrieve, and see what it is allowed to read.
 *
 * Everything here runs under the asking principal's permissions and no others. The assistant holds no standing
 * of its own, which is why the chat handler passes `user.perms` down and never a widened set. */

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
    private readonly audit: AuditClient,
  ) {}

  /** What the dock offers when a conversation is empty. */
  @RequirePerm('ai.use') @Get('suggestions')
  suggestions() { return SUGGESTIONS; }

  /** The tool surface, with the permission each tool sits behind and whether this reader holds it. */
  @RequirePerm('ai.use') @Get('tools')
  tools(@CurrentUser() user: Principal) {
    return toolCatalogue().map((t) => ({ ...t, available: user.perms.includes('*') || user.perms.includes(t.permission) }));
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
  async chat(@Body(zod(chatBody)) body: z.infer<typeof chatBody>, @CurrentUser() user: Principal) {
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
      { env: this.env, db: this.pool, completion: this.completion, index },
      { question: body.message, permissions: user.perms, history, language },
    );

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
    };
  }
}
