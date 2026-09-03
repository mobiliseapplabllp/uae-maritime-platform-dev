import { EVENTS, type Actor } from '@maritime/contracts';
import { enqueue, eventFromContext, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';

/* Conversations and the turns in them.
 *
 * A conversation belongs to the person who started it. The assistant answers from records under that person's
 * permissions, so the history is a record of what they were shown, and nobody else — not another operator, not
 * an administrator reading the register — is served it from here. */

export type Row = Record<string, any>;
export interface ConversationRecord {
  id: string; user_id: string; user_name: string; title: string; language: string; message_count: number;
  last_message_at: Date | null; archived: boolean; created_at: Date; updated_at: Date;
}
export interface MessageRecord {
  id: string; conversation_id: string; seq: number; role: string; text: string;
  citations: Row[]; tools: Row[]; refusals: Row[]; flagged: Row[]; engine: string; latency_ms: number; created_at: Date;
}

const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);

export const conversationApi = (c: ConversationRecord, messages?: MessageRecord[]) => ({
  id: c.id, userId: c.user_id, userName: c.user_name, title: c.title, language: c.language,
  messageCount: c.message_count, lastMessageAt: iso(c.last_message_at), archived: c.archived,
  createdAt: iso(c.created_at), updatedAt: iso(c.updated_at),
  ...(messages ? { messages: messages.map(messageApi) } : {}),
});
export const messageApi = (m: MessageRecord) => ({
  id: m.id, conversationId: m.conversation_id, seq: m.seq, role: m.role, text: m.text,
  citations: m.citations ?? [], tools: m.tools ?? [], refusals: m.refusals ?? [], flagged: m.flagged ?? [],
  engine: m.engine, latencyMs: m.latency_ms, at: iso(m.created_at)!,
});

/** A conversation is titled from its first question, which is what an operator recognises it by. */
export const titleFrom = (question: string) => {
  const t = question.replace(/\s+/g, ' ').trim();
  return t.length > 70 ? `${t.slice(0, 69)}…` : t || 'New conversation';
};

export async function createConversation(c: Queryable, user: { id: string; name: string }, title: string, language: string): Promise<ConversationRecord> {
  const r = await c.query<ConversationRecord>(
    'INSERT INTO conversations(user_id, user_name, title, language) VALUES ($1,$2,$3,$4) RETURNING *',
    [user.id, user.name, title, language]);
  return r.rows[0];
}

export async function appendMessage(c: Queryable, conversationId: string, message: Partial<MessageRecord> & { role: string; text: string }): Promise<MessageRecord> {
  const seq = Number((await c.query<{ n: string }>('SELECT COALESCE(max(seq), 0) + 1 AS n FROM messages WHERE conversation_id = $1', [conversationId])).rows[0].n);
  const r = await c.query<MessageRecord>(
    `INSERT INTO messages(conversation_id, seq, role, text, citations, tools, refusals, flagged, engine, latency_ms)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [conversationId, seq, message.role, message.text, JSON.stringify(message.citations ?? []), JSON.stringify(message.tools ?? []),
      JSON.stringify(message.refusals ?? []), JSON.stringify(message.flagged ?? []), message.engine ?? '', message.latency_ms ?? 0]);
  await c.query('UPDATE conversations SET message_count = message_count + 1, last_message_at = now(), updated_at = now() WHERE id = $1', [conversationId]);
  return r.rows[0];
}

export async function messagesOf(c: Queryable, conversationId: string, limit = 200): Promise<MessageRecord[]> {
  return (await c.query<MessageRecord>('SELECT * FROM messages WHERE conversation_id = $1 ORDER BY seq LIMIT $2', [conversationId, limit])).rows;
}

/** Every write publishes the record for the read models, and the answer itself as its own event. */
export async function publishConversation(c: Queryable, env: Env, conv: ConversationRecord, opts: { event?: string; data?: Row; actor?: Actor } = {}) {
  const entity = conversationApi(conv);
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.upserted, { kind: 'aiConversation', entity }, { subject: conv.id, actor: opts.actor }));
  if (opts.event) {
    await enqueue(c, eventFromContext(env.SERVICE_NAME, opts.event, {
      conversationId: conv.id, userId: conv.user_id, title: conv.title, messageCount: conv.message_count, ...(opts.data ?? {}),
    }, { subject: conv.id, actor: opts.actor }));
  }
  return entity;
}
export async function publishConversationDeleted(c: Queryable, env: Env, conv: ConversationRecord) {
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.deleted, { kind: 'aiConversation', id: conv.id }, { subject: conv.id }));
}
