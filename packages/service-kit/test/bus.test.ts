import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connect, type NatsConnection } from 'nats';
import { randomUUID } from 'node:crypto';
import { STREAM_NAME, STREAM_PREFIX, makeEvent, type EventEnvelope } from '@maritime/contracts';
import { NatsBus } from '../src/events/bus';

/*
 * The durable consumer on the server outlives the code that created it. A service that learns to listen to a new
 * subject must bring the server's filter with it, or the new events sit in the stream and are never delivered.
 */
const NATS_URL = process.env.NATS_URL ?? 'nats://127.0.0.1:4222';
const run = randomUUID().slice(0, 8);
const durable = `kit-test-${run}`;
const subjectA = `${STREAM_PREFIX}.kit-test.${run}.a`;
const subjectB = `${STREAM_PREFIX}.kit-test.${run}.b`;
let bus: NatsBus; let nc: NatsConnection;
const event = (type: string) => makeEvent({ type, source: 'kit-test', data: { run } });
const until = async (test: () => boolean, ms = 5000) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (test()) return true; await new Promise((r) => setTimeout(r, 25)); } return test(); };
const filterOf = async () => { const jsm = await nc.jetstreamManager(); const info = await jsm.consumers.info(STREAM_NAME, durable); return [...((info.config as { filter_subjects?: string[] }).filter_subjects ?? [])].sort(); };

beforeAll(async () => { bus = await NatsBus.connect(NATS_URL); nc = await connect({ servers: NATS_URL }); });
afterAll(async () => { try { await (await nc.jetstreamManager()).consumers.delete(STREAM_NAME, durable); } catch { /* never created */ } await bus.close(); await nc.close(); });

describe('the NATS bus and its durable consumers', () => {
  it('creates the consumer with the subjects it is given, and brings the filter up to date when the subjects grow', async () => {
    const seen: EventEnvelope[] = [];
    const first = await bus.subscribe(durable, [subjectA], async (e) => { seen.push(e); });
    expect(await filterOf()).toEqual([subjectA]);
    await bus.publish(subjectA, event('kit.a'));
    expect(await until(() => seen.length === 1)).toBe(true);
    await bus.publish(subjectB, event('kit.b-before'));
    await new Promise((r) => setTimeout(r, 300));
    expect(seen.map((e) => e.type)).toEqual(['kit.a']); // b is not in the filter, so it is not delivered
    await first.stop();

    // the service restarts, now listening to b as well: the same durable name, a wider filter
    const second = await bus.subscribe(durable, [subjectB, subjectA], async (e) => { seen.push(e); });
    expect(await filterOf()).toEqual([subjectA, subjectB].sort());
    await bus.publish(subjectB, event('kit.b-after'));
    expect(await until(() => seen.some((e) => e.type === 'kit.b-after'))).toBe(true);
    await second.stop();
  });
});
