import type { Pool, PoolClient } from 'pg';
import { makeEvent, subjectFor, type Actor, type EventEnvelope } from '@maritime/contracts';
import type { EventBus } from './bus';
import type { AppLogger } from '../logger';
import { getContext } from '../context';
import { withTx, type Queryable } from '../db';

/** Enqueue an event in the same transaction as the write it describes. Publication happens through the relay. */
export async function enqueue(client: Queryable, event: EventEnvelope): Promise<void> {
  await client.query('INSERT INTO outbox(event_id, subject, payload) VALUES ($1, $2, $3) ON CONFLICT (event_id) DO NOTHING', [event.id, subjectFor(event.type), JSON.stringify(event)]);
}

/** Build an event stamped with the current request's correlation id and actor. */
export function eventFromContext<T>(source: string, type: string, data: T, extra: { subject?: string; actor?: Actor } = {}): EventEnvelope<T> {
  const ctx = getContext();
  return makeEvent({ type, source, data, subject: extra.subject, correlationId: ctx?.correlationId, causationId: ctx?.causationId, actor: extra.actor ?? ctx?.actor, scope: ctx?.scope });
}

/** Polls the outbox and publishes in id order; a crashed relay simply resumes where it left off. */
export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(private readonly pool: Pool, private readonly bus: EventBus, private readonly log?: AppLogger, private readonly intervalMs = 500) {}
  start() { if (!this.timer) this.timer = setInterval(() => void this.tick(), this.intervalMs); this.timer.unref?.(); }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  async tick(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      return await withTx(this.pool, async (c) => {
        const rows = await c.query<{ id: string; subject: string; payload: EventEnvelope }>('SELECT id, subject, payload FROM outbox WHERE published_at IS NULL ORDER BY id LIMIT 100 FOR UPDATE SKIP LOCKED');
        for (const r of rows.rows) {
          await this.bus.publish(r.subject, r.payload);
          await c.query('UPDATE outbox SET published_at = now() WHERE id = $1', [r.id]);
        }
        return rows.rowCount ?? 0;
      });
    } catch (e) {
      this.log?.warn({ err: e }, 'outbox relay tick failed');
      return 0;
    } finally { this.running = false; }
  }
}

/** Idempotent consumption: the handler runs once per event id, inside a transaction with the inbox insert. */
export async function withInbox(pool: Pool, event: EventEnvelope, handler: (client: PoolClient) => Promise<void>): Promise<boolean> {
  return withTx(pool, async (c) => {
    const ins = await c.query('INSERT INTO processed_events(event_id, subject) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING event_id', [event.id, subjectFor(event.type)]);
    if (ins.rowCount === 0) return false;
    await handler(c);
    return true;
  });
}
