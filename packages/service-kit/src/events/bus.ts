import { connect, JSONCodec, NatsConnection, JetStreamClient, JetStreamManager, StringCodec, headers as natsHeaders } from 'nats';
import { STREAM_NAME, STREAM_PREFIX, type EventEnvelope } from '@maritime/contracts';
import type { AppLogger } from '../logger';

export type EventHandler = (event: EventEnvelope, subject: string) => Promise<void>;
export interface Subscription { stop(): Promise<void> }
export interface EventBus {
  publish(subject: string, event: EventEnvelope): Promise<void>;
  subscribe(name: string, subjects: string[], handler: EventHandler): Promise<Subscription>;
  /**
   * A watch is the other kind of subscription: every running instance receives every matching event from now on, nothing
   * is replayed and nothing is acknowledged. It is for signals a process keeps in memory — a cache to drop, a setting to
   * re-read — where a durable consumer would be wrong twice over: it would hand each event to one instance only, and it
   * would replay history into a fresh cache that has nothing to drop.
   */
  watch(subjects: string[], handler: EventHandler): Promise<Subscription>;
  close(): Promise<void>;
}

const matches = (pattern: string, subject: string): boolean => {
  const p = pattern.split('.'); const s = subject.split('.');
  for (let i = 0; i < p.length; i++) {
    if (p[i] === '>') return true;
    if (s[i] === undefined) return false;
    if (p[i] !== '*' && p[i] !== s[i]) return false;
  }
  return p.length === s.length;
};

/** In-process bus for tests and single-process development. Delivery is asynchronous but ordered per subscriber. */
export class MemoryBus implements EventBus {
  private subs: { name: string; subjects: string[]; handler: EventHandler; queue: Promise<void> }[] = [];
  readonly published: { subject: string; event: EventEnvelope }[] = [];
  async publish(subject: string, event: EventEnvelope) {
    this.published.push({ subject, event });
    for (const s of this.subs) if (s.subjects.some((p) => matches(p, subject))) s.queue = s.queue.then(() => s.handler(event, subject)).catch(() => undefined);
  }
  async subscribe(name: string, subjects: string[], handler: EventHandler): Promise<Subscription> {
    const sub = { name, subjects, handler, queue: Promise.resolve() };
    this.subs.push(sub);
    return { stop: async () => { this.subs = this.subs.filter((s) => s !== sub); } };
  }
  async watch(subjects: string[], handler: EventHandler): Promise<Subscription> { return this.subscribe(`watch-${this.subs.length}`, subjects, handler); }
  async drain() { await Promise.all(this.subs.map((s) => s.queue)); }
  async close() { this.subs = []; }
}

/** NATS JetStream bus: one durable stream for `maritime.>`; durable pull consumers per subscriber with explicit acks. */
export class NatsBus implements EventBus {
  private constructor(private readonly nc: NatsConnection, private readonly js: JetStreamClient, private readonly jsm: JetStreamManager, private readonly log?: AppLogger) {}
  static async connect(servers: string, log?: AppLogger): Promise<NatsBus> {
    const nc = await connect({ servers, name: 'maritime-service' });
    const jsm = await nc.jetstreamManager();
    try { await jsm.streams.info(STREAM_NAME); } catch {
      await jsm.streams.add({ name: STREAM_NAME, subjects: [`${STREAM_PREFIX}.>`], retention: 'limits' as never, max_age: 30 * 24 * 3600 * 1e9, duplicate_window: 10 * 60 * 1e9 } as never);
    }
    return new NatsBus(nc, nc.jetstream(), jsm, log);
  }
  async publish(subject: string, event: EventEnvelope) {
    const h = natsHeaders(); h.set('Nats-Msg-Id', event.id); h.set('ce-type', event.type);
    await this.js.publish(subject, JSONCodec().encode(event), { headers: h, msgID: event.id });
  }
  async subscribe(name: string, subjects: string[], handler: EventHandler): Promise<Subscription> {
    const durable = name.replace(/[^A-Za-z0-9_-]/g, '_');
    try { await this.jsm.consumers.info(STREAM_NAME, durable); } catch {
      await this.jsm.consumers.add(STREAM_NAME, { durable_name: durable, ack_policy: 'explicit' as never, deliver_policy: 'all' as never, filter_subjects: subjects, max_deliver: 20, ack_wait: 30 * 1e9 } as never);
    }
    const consumer = await this.js.consumers.get(STREAM_NAME, durable);
    const messages = await consumer.consume({ max_messages: 50 });
    let stopped = false;
    (async () => {
      for await (const m of messages) {
        if (stopped) break;
        try {
          const event = JSONCodec<EventEnvelope>().decode(m.data);
          await handler(event, m.subject);
          m.ack();
        } catch (e) {
          this.log?.warn({ err: e, subject: m.subject, redeliveries: m.info.redeliveryCount }, 'event handler failed; will redeliver');
          m.nak(Math.min(60_000, 1000 * 2 ** Math.min(6, m.info.redeliveryCount)));
        }
      }
    })().catch((e) => this.log?.error({ err: e }, 'consumer loop ended'));
    return { stop: async () => { stopped = true; messages.stop(); } };
  }
  async watch(subjects: string[], handler: EventHandler): Promise<Subscription> {
    // Core NATS subscriptions: JetStream publishes on the plain subject, so a core subscriber sees the same message the
    // stream captured, on every instance, with no consumer state anywhere.
    const subs = subjects.map((subject) => this.nc.subscribe(subject));
    for (const sub of subs) {
      (async () => {
        for await (const m of sub) {
          try { await handler(JSONCodec<EventEnvelope>().decode(m.data), m.subject); }
          catch (e) { this.log?.warn({ err: e, subject: m.subject }, 'watch handler failed'); }
        }
      })().catch((e) => this.log?.error({ err: e }, 'watch loop ended'));
    }
    return { stop: async () => { for (const sub of subs) sub.unsubscribe(); } };
  }
  async close() { await this.nc.drain(); }
}

export const sc = StringCodec();
