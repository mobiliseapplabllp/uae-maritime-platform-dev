import { createHash } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { EventEnvelope } from '@maritime/contracts';

export interface AuditPayload { action: string; entity: string; entityId: string | null; entityLabel: string | null; before: unknown; after: unknown; note: string | null; actor: { id: string; name?: string; email?: string; kind?: string }; ip: string | null; at: string; service: string }
const canonical = (v: unknown): string => JSON.stringify(v, (_k, val) => (val && typeof val === 'object' && !Array.isArray(val) ? Object.fromEntries(Object.keys(val as object).sort().map((k) => [k, (val as Record<string, unknown>)[k]])) : val));
export const GENESIS = 'genesis';
export const hashEntry = (prevHash: string, body: unknown) => createHash('sha256').update(prevHash).update('|').update(canonical(body)).digest('hex');

/** Appends one entry, chaining its hash to the previous row. Serialised by a transaction-level advisory lock so the chain never forks. */
export async function appendEntry(client: PoolClient, event: EventEnvelope<AuditPayload>): Promise<{ seq: number; hash: string } | null> {
  await client.query('SELECT pg_advisory_xact_lock(4242)');
  const prev = await client.query<{ hash: string }>('SELECT hash FROM audit_entries ORDER BY seq DESC LIMIT 1');
  const prevHash = prev.rows[0]?.hash ?? GENESIS;
  const d = event.data;
  const body = { eventId: event.id, at: d.at, service: d.service, actor: d.actor, action: d.action, entity: d.entity, entityId: d.entityId, entityLabel: d.entityLabel, before: d.before, after: d.after, note: d.note, ip: d.ip, correlationId: event.correlationid };
  const hash = hashEntry(prevHash, body);
  const r = await client.query<{ seq: string }>(
    `INSERT INTO audit_entries(event_id, at, service, actor_id, actor_name, actor_email, actor_kind, action, entity, entity_id, entity_label, before, after, note, ip, correlation_id, prev_hash, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) ON CONFLICT (event_id) DO NOTHING RETURNING seq`,
    [event.id, d.at, d.service, d.actor?.id ?? 'system', d.actor?.name ?? '', d.actor?.email ?? '', d.actor?.kind ?? 'user', d.action, d.entity, d.entityId, d.entityLabel, d.before == null ? null : JSON.stringify(d.before), d.after == null ? null : JSON.stringify(d.after), d.note, d.ip, event.correlationid, prevHash, hash]);
  return r.rows[0] ? { seq: Number(r.rows[0].seq), hash } : null;
}

export interface Anchor { seq: number; hash: string; purged: number; purgedBefore: string | null; at: string }
/** The retention anchor: the last row purged under the policy and its hash, from which the chain is verified. Null when nothing has ever left. */
export async function anchorOf(pool: Pool | PoolClient): Promise<Anchor | null> {
  const r = await pool.query<{ seq: string; hash: string; purged: string; purged_before: Date | null; at: Date }>('SELECT seq, hash, purged, purged_before, at FROM audit_anchor WHERE id = 1');
  const a = r.rows[0]; return a ? { seq: Number(a.seq), hash: a.hash, purged: Number(a.purged), purgedBefore: a.purged_before ? new Date(a.purged_before).toISOString() : null, at: new Date(a.at).toISOString() } : null;
}
/** Purges every row older than the cut-off in ledger order and moves the anchor to the last row that left. */
export async function purgeBeyond(client: PoolClient, cutoff: Date): Promise<{ purged: number; anchor: Anchor | null }> {
  await client.query('SELECT pg_advisory_xact_lock(4242)');
  const r = await client.query<{ purged: string; anchor_seq: string | null; anchor_hash: string | null }>('SELECT * FROM audit_retention_purge($1)', [cutoff]);
  return { purged: Number(r.rows[0]?.purged ?? 0), anchor: await anchorOf(client) };
}

/** Recomputes every hash from genesis — or from the retention anchor, when rows have left under the policy; the first mismatch is the point of tampering. */
export async function verifyChain(pool: Pool, limit = 100000): Promise<{ ok: boolean; checked: number; brokenAt: number | null; anchor: Anchor | null }> {
  const anchor = await anchorOf(pool);
  const rows = await pool.query<{ seq: string; event_id: string; at: Date; service: string; actor_id: string; actor_name: string; actor_email: string; actor_kind: string; action: string; entity: string; entity_id: string | null; entity_label: string | null; before: unknown; after: unknown; note: string | null; ip: string | null; correlation_id: string | null; prev_hash: string; hash: string }>('SELECT * FROM audit_entries WHERE seq > $2 ORDER BY seq LIMIT $1', [limit, anchor?.seq ?? 0]);
  let prev = anchor?.hash ?? GENESIS;
  for (const r of rows.rows) {
    const body = { eventId: r.event_id, at: new Date(r.at).toISOString(), service: r.service, actor: { id: r.actor_id, name: r.actor_name || undefined, email: r.actor_email || undefined, kind: r.actor_kind || undefined }, action: r.action, entity: r.entity, entityId: r.entity_id, entityLabel: r.entity_label, before: r.before, after: r.after, note: r.note, ip: r.ip, correlationId: r.correlation_id ?? undefined };
    const expected = hashEntry(prev, stripUndefined(body));
    if (r.prev_hash !== prev || r.hash !== expected) return { ok: false, checked: Number(r.seq), brokenAt: Number(r.seq), anchor };
    prev = r.hash;
  }
  return { ok: true, checked: rows.rows.length, brokenAt: null, anchor };
}
const stripUndefined = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
