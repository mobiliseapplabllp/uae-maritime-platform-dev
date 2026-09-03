import { Body, Controller, Delete, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { EVENTS, type PageQuery } from '@maritime/contracts';
import {
  AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, escapeLike, forbidden, notFound, paged, parsePage, withTx, zod, type Principal,
} from '@maritime/service-kit';
import type { Env } from './env';
import { conversationApi, createConversation, messagesOf, publishConversation, publishConversationDeleted, titleFrom, type ConversationRecord } from './conversations';

/* A person's own history with the assistant.
 *
 * Scoped by the row's owner and not by a filter someone might forget to apply: every read here goes through
 * `own`, which fetches by id and then refuses anything that is not the caller's. An administrator's wildcard
 * does not open another operator's conversation either — what the assistant showed a particular person under
 * their permissions is theirs, and the audit ledger is where the authority looks instead. */

const createBody = z.object({ title: z.string().trim().max(200).optional(), language: z.enum(['en', 'ar']).default('en') });
const SORT: Record<string, string> = { lastMessageAt: 'last_message_at', createdAt: 'created_at', title: 'title' };

@Controller('ai/conversations')
export class ConversationsController {
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    private readonly audit: AuditClient,
  ) {}

  private async own(id: string, user: Principal): Promise<ConversationRecord> {
    const r = await this.pool.query<ConversationRecord>('SELECT * FROM conversations WHERE id::text = $1', [id]);
    if (!r.rows[0]) throw notFound('Conversation not found');
    if (r.rows[0].user_id !== user.id) throw forbidden('This conversation belongs to another user');
    return r.rows[0];
  }

  /** The caller's own conversations, most recent first. */
  @RequirePerm('ai.use') @Get()
  async list(@Query() query: PageQuery & { archived?: string }, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: '-lastMessageAt', sortable: Object.keys(SORT), maxLimit: 100 });
    const args: unknown[] = [user.id];
    const where = ['user_id = $1'];
    if (query.archived !== undefined && query.archived !== '') { args.push(String(query.archived) === 'true'); where.push(`archived = $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`title ILIKE $${args.length}`); }
    const sql = `WHERE ${where.join(' AND ')}`;
    const total = Number((await this.pool.query<{ n: string }>(`SELECT count(*)::int AS n FROM conversations ${sql}`, args)).rows[0].n);
    const rows = (await this.pool.query<ConversationRecord>(
      `SELECT * FROM conversations ${sql} ORDER BY ${SORT[p.sortField] ?? 'last_message_at'} ${p.sortDir === 'asc' ? 'ASC' : 'DESC'} NULLS LAST, created_at DESC LIMIT ${p.limit} OFFSET ${p.offset}`, args)).rows;
    return paged(rows.map((c) => conversationApi(c)), { page: p.page, limit: p.limit, total });
  }

  /** One conversation with every turn in it, including what each answer cited and what it refused to read. */
  @RequirePerm('ai.use') @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: Principal) {
    const conv = await this.own(id, user);
    return conversationApi(conv, await messagesOf(this.pool, conv.id));
  }

  @RequirePerm('ai.use') @Post()
  async create(@Body(zod(createBody)) body: z.infer<typeof createBody>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const conv = await createConversation(c, { id: user.id, name: user.name }, titleFrom(body.title ?? ''), body.language);
      const entity = await publishConversation(c, this.env, conv, { event: EVENTS.ai.conversationStarted });
      await this.audit.record(c, { action: 'AI_CONVERSATION_STARTED', entity: 'AiConversation', entityId: conv.id, entityLabel: conv.title, after: entity });
      return entity;
    });
  }

  @RequirePerm('ai.use') @Delete(':id')
  async remove(@Param('id') id: string, @CurrentUser() user: Principal) {
    const conv = await this.own(id, user);
    return withTx(this.pool, async (c) => {
      await c.query('DELETE FROM conversations WHERE id = $1', [conv.id]);
      await publishConversationDeleted(c, this.env, conv);
      await this.audit.record(c, { action: 'AI_CONVERSATION_DELETED', entity: 'AiConversation', entityId: conv.id, entityLabel: conv.title, before: conversationApi(conv) });
      return { id: conv.id, deleted: true };
    });
  }
}
