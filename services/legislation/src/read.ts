import type { Pool, PoolClient } from 'pg';
import { notFound } from '@maritime/service-kit';
import { ackApi, instrumentApi, linkApi, type AckApi, type AckRow, type InstrumentApi, type InstrumentRow, type LinkRow } from './instruments';
import { recipientCounts, recipientsIn, recipientsOf } from './subjects';

/* Reading one instrument the way every screen wants it: the record, its receipts, its links in both
 * directions, and how far the recipient class it is addressed to has got. Kept here rather than on a
 * controller because the register and the notice board both serve it. */

export type Q = Pool | PoolClient;

export async function loadInstrument(c: Q, id: string, lock = false): Promise<InstrumentRow> {
  const r = await c.query<InstrumentRow>(`SELECT * FROM legal_instruments WHERE id::text = $1 OR upper(ref_no) = upper($1)${lock ? ' FOR UPDATE' : ''}`, [id]);
  if (!r.rows[0]) throw notFound('Instrument not found');
  return r.rows[0];
}

export async function acksOf(c: Q, ids: string[]): Promise<Map<string, AckApi[]>> {
  const out = new Map<string, AckApi[]>();
  if (!ids.length) return out;
  const r = await c.query<AckRow>('SELECT * FROM instrument_acknowledgements WHERE instrument_id = ANY($1::uuid[]) ORDER BY at', [ids]);
  for (const a of r.rows) { const cur = out.get(a.instrument_id); if (cur) cur.push(ackApi(a)); else out.set(a.instrument_id, [ackApi(a)]); }
  return out;
}

export async function linksOf(c: Q, id: string) {
  const r = await c.query<LinkRow>('SELECT * FROM instrument_links WHERE from_id = $1 OR to_id = $1 ORDER BY at', [id]);
  return r.rows.map((l) => linkApi(l, id));
}

/** The instrument with its receipts, its links and the state of its recipient class. */
export async function fullInstrument(c: Q, row: InstrumentRow): Promise<InstrumentApi> {
  // sequential rather than concurrent: `c` is often a transaction's own client, which serves one query at a time
  const acks = await acksOf(c, [row.id]);
  const links = await linksOf(c, row.id);
  const acknowledgedBy = acks.get(row.id) ?? [];
  if (!row.ack_required) return instrumentApi(row, { acknowledgedBy, links, recipients: null, outstanding: null });
  const recipients = await recipientsOf(c, row.ack_class, row.ack_class_value);
  const done = new Set(acknowledgedBy.map((a) => a.userId));
  return instrumentApi(row, { acknowledgedBy, links, recipients: recipients.length, outstanding: recipients.filter((p) => !done.has(p.id)).length });
}

export { recipientCounts, recipientsIn, recipientsOf };
