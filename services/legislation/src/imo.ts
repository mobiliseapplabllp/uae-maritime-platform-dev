import type { PoolClient } from 'pg';
import { EVENTS, makeEvent, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, badRequest, enqueue, eventFromContext, lookupOptions, notFound, type LookupOption, type Principal, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { dateOnly, iso, type InstrumentRow } from './instruments';

/* The IMO watch.
 *
 * The legislation desk monitors the IMO bodies the `imoSource` master names — a committee's circular
 * series, the Assembly's resolutions, GISIS notifications — each with its address and how often it is
 * read. The reading itself goes through the integration hub, which is the only place the platform talks to
 * the outside from; this file never opens a socket to the IMO. What comes back is turned into watch items,
 * one per document, once: a second sighting counts the sighting and changes nothing else.
 *
 * The desk then does the work a maritime administration actually has to do with an IMO document: decide
 * whether it needs transposing into a national instrument, by when, and — when it does — which instrument
 * on the register implements it. That decision is the item's status, and the link to the instrument is what
 * lets the register answer "which of our circulars implements MSC's amendment" from data. */

export const ITEM_STATUS = ['NEW', 'ASSESSED', 'TRANSPOSED', 'DISMISSED'] as const;
export type ItemStatus = (typeof ITEM_STATUS)[number];

export interface FeedItem { reference: string; title: string; subject?: string; published?: string | null; entryIntoForce?: string | null; url?: string }
export interface SourceRef { code: string; label: string; body: string; series: string; url: string; pollHours: number }
/** Where the documents come from. The hub implementation is the production one; a test hands in a stub. */
export interface SourceFeed { fetch(source: SourceRef, since: Date, correlationId?: string): Promise<{ items: FeedItem[]; mode: string }> }

/** Reads a source through the integration hub's adapter, on the service token. */
export class HubSourceFeed implements SourceFeed {
  constructor(private readonly hubUrl: string, private readonly serviceToken: string, private readonly adapter: string, private readonly timeoutMs = 10_000) {}
  async fetch(source: SourceRef, since: Date, correlationId?: string) {
    const res = await fetch(`${this.hubUrl.replace(/\/$/, '')}/internal/call/${encodeURIComponent(this.adapter)}`, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': this.serviceToken },
      body: JSON.stringify({ operation: 'sourceItems', payload: { body: source.body, series: source.series, since: since.toISOString().slice(0, 10), url: source.url }, correlationId }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const text = await res.text();
    let parsed: { data?: { status?: string; mode?: string; data?: { documents?: FeedItem[] }; error?: string }; message?: string } = {};
    try { parsed = JSON.parse(text); } catch { throw new Error(`hub answered ${res.status} with a body that is not JSON`); }
    if (!res.ok) throw new Error(parsed.message ?? `hub answered ${res.status}`);
    const outcome = parsed.data ?? {};
    if (outcome.status && outcome.status !== 'ok') throw new Error(outcome.error ?? `adapter call ${outcome.status}`);
    const documents = outcome.data?.documents ?? [];
    return { items: documents.map((d) => ({ reference: String(d.reference ?? ''), title: String(d.title ?? ''), subject: d.subject ? String(d.subject) : '', published: d.published ?? null, entryIntoForce: d.entryIntoForce ?? null, url: d.url ? String(d.url) : '' })).filter((d) => d.reference && d.title), mode: outcome.mode ?? 'unknown' };
  }
}

export interface ItemRow {
  id: string; source: string; body: string; series: string; reference: string; title: string; subject: string; published_on: Date | null; entry_into_force: Date | null; url: string;
  status: string; assessment: string; assessed_by_id: string | null; assessed_by: string; assessed_at: Date | null; due_on: Date | null; instrument_id: string | null; instrument_ref: string;
  first_seen_at: Date; last_seen_at: Date; seen_count: number; raw: Record<string, unknown>; created_at: Date; updated_at: Date;
}
export interface PollRow { source: string; last_polled_at: Date | null; last_status: string; last_error: string; last_items: number; new_items: number; next_due_at: Date | null; polls: number; mode: string; updated_at: Date }

export const sourceRef = (o: LookupOption): SourceRef => ({ code: o.code, label: o.label, body: String(o.meta.body ?? o.code), series: String(o.meta.series ?? ''), url: String(o.meta.url ?? ''), pollHours: Number(o.meta.pollHours) || 24 });
export function itemApi(r: ItemRow, extra: { sourceLabel?: string; sourceLabelAr?: string | null; assessDays?: number; now?: Date } = {}) {
  const now = extra.now ?? new Date();
  const overdue = r.status === 'NEW' ? (now.getTime() - r.first_seen_at.getTime()) / 86_400_000 > (extra.assessDays ?? 30) : r.status === 'ASSESSED' && !!r.due_on && r.due_on.getTime() < now.getTime();
  return {
    id: r.id, source: r.source, sourceLabel: extra.sourceLabel ?? r.source, sourceLabelAr: extra.sourceLabelAr ?? null, body: r.body, series: r.series, reference: r.reference, title: r.title, subject: r.subject,
    publishedOn: dateOnly(r.published_on), entryIntoForce: dateOnly(r.entry_into_force), url: r.url, status: r.status, assessment: r.assessment, assessedBy: r.assessed_by, assessedAt: iso(r.assessed_at), dueOn: dateOnly(r.due_on),
    instrumentId: r.instrument_id, instrumentRef: r.instrument_ref, firstSeenAt: iso(r.first_seen_at)!, lastSeenAt: iso(r.last_seen_at)!, seenCount: r.seen_count, overdue, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
  };
}
export type ItemApi = ReturnType<typeof itemApi>;
export const pollApi = (p: PollRow | undefined, s: SourceRef & { labelAr?: string | null }) => ({
  source: s.code, label: s.label, labelAr: s.labelAr ?? null, body: s.body, series: s.series, url: s.url, pollHours: s.pollHours,
  lastPolledAt: iso(p?.last_polled_at ?? null), lastStatus: p?.last_status ?? 'NEVER', lastError: p?.last_error ?? '', lastItems: p?.last_items ?? 0, newItems: p?.new_items ?? 0, nextDueAt: iso(p?.next_due_at ?? null), polls: p?.polls ?? 0, mode: p?.mode ?? '',
});

export async function sources(c: Queryable): Promise<(SourceRef & { labelAr: string | null })[]> {
  return (await lookupOptions(c, 'imoSource')).map((o) => ({ ...sourceRef(o), labelAr: o.labelAr }));
}
export async function pollStates(c: Queryable): Promise<Map<string, PollRow>> {
  return new Map((await c.query<PollRow>('SELECT * FROM imo_source_polls')).rows.map((p) => [p.source, p]));
}

/** Upserts one document as a watch item: new on first sight, counted on every later one. Answers the row and whether it was new. */
export async function recordItem(c: Queryable, source: SourceRef, d: FeedItem, seenAt: Date): Promise<{ row: ItemRow; created: boolean }> {
  const existing = await c.query<ItemRow>('SELECT * FROM imo_watch_items WHERE source = $1 AND upper(reference) = upper($2)', [source.code, d.reference.trim()]);
  if (existing.rows[0]) {
    const r = await c.query<ItemRow>(`UPDATE imo_watch_items SET title = $2, subject = COALESCE(NULLIF($3, ''), subject), published_on = COALESCE($4, published_on), entry_into_force = COALESCE($5, entry_into_force), url = COALESCE(NULLIF($6, ''), url), last_seen_at = $7, seen_count = seen_count + 1, raw = $8, updated_at = now() WHERE id = $1 RETURNING *`,
      [existing.rows[0].id, d.title, d.subject ?? '', d.published || null, d.entryIntoForce || null, d.url ?? '', seenAt, JSON.stringify(d)]);
    return { row: r.rows[0], created: false };
  }
  const r = await c.query<ItemRow>(`INSERT INTO imo_watch_items(source, body, series, reference, title, subject, published_on, entry_into_force, url, first_seen_at, last_seen_at, raw) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11) RETURNING *`,
    [source.code, source.body, source.series, d.reference.trim(), d.title, d.subject ?? '', d.published || null, d.entryIntoForce || null, d.url ?? '', seenAt, JSON.stringify(d)]);
  return { row: r.rows[0], created: true };
}

export interface PollOutcome { source: string; status: 'OK' | 'FAILED' | 'SKIPPED'; items: number; newItems: number; error: string; mode: string }
/** Reads every source that is due (or the one asked for), records what came back and announces it. */
export async function pollSources(c: PoolClient, env: Env, audit: AuditClient, feed: SourceFeed, opts: { now?: Date; force?: boolean; only?: string; cause?: EventEnvelope; actor?: { id: string; name: string; kind: string } } = {}): Promise<{ polled: PollOutcome[]; newItems: number }> {
  const now = opts.now ?? new Date();
  const all = await sources(c);
  const states = await pollStates(c);
  const targets = opts.only ? all.filter((s) => s.code === opts.only) : all;
  if (opts.only && !targets.length) throw badRequest(`${opts.only} is not an active entry of the imoSource master`);
  const polled: PollOutcome[] = []; let created = 0;
  for (const s of targets) {
    const state = states.get(s.code);
    const due = opts.force || !!opts.only || !state?.next_due_at || state.next_due_at.getTime() <= now.getTime();
    if (!due) { polled.push({ source: s.code, status: 'SKIPPED', items: 0, newItems: 0, error: '', mode: state?.mode ?? '' }); continue; }
    const since = state?.last_polled_at ?? new Date(now.getTime() - env.IMO_DEFAULT_SINCE_DAYS * 86_400_000);
    const nextDue = new Date(now.getTime() + s.pollHours * 3_600_000);
    try {
      const { items, mode } = await feed.fetch(s, since, opts.cause?.correlationid);
      let fresh = 0;
      for (const d of items) {
        const { row, created: isNew } = await recordItem(c, s, d, now);
        if (!isNew) continue;
        fresh += 1; created += 1;
        await enqueue(c, opts.cause
          ? makeEvent({ type: EVENTS.legislation.sourceItemReceived, source: env.SERVICE_NAME, data: { itemId: row.id, source: s.code, sourceLabel: s.label, reference: row.reference, title: row.title, subject: row.subject, publishedOn: dateOnly(row.published_on), url: row.url }, subject: row.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.cause.actor })
          : eventFromContext(env.SERVICE_NAME, EVENTS.legislation.sourceItemReceived, { itemId: row.id, source: s.code, sourceLabel: s.label, reference: row.reference, title: row.title, subject: row.subject, publishedOn: dateOnly(row.published_on), url: row.url }, { subject: row.id }));
      }
      await c.query(`INSERT INTO imo_source_polls(source, last_polled_at, last_status, last_error, last_items, new_items, next_due_at, polls, mode) VALUES ($1,$2,'OK','',$3,$4,$5,1,$6)
        ON CONFLICT (source) DO UPDATE SET last_polled_at = EXCLUDED.last_polled_at, last_status = 'OK', last_error = '', last_items = EXCLUDED.last_items, new_items = EXCLUDED.new_items, next_due_at = EXCLUDED.next_due_at, polls = imo_source_polls.polls + 1, mode = EXCLUDED.mode, updated_at = now()`,
        [s.code, now, items.length, fresh, nextDue, mode]);
      polled.push({ source: s.code, status: 'OK', items: items.length, newItems: fresh, error: '', mode });
      await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.legislation.sourcePolled, { source: s.code, sourceLabel: s.label, items: items.length, newItems: fresh, mode, since: since.toISOString(), firstTitle: items[0]?.title ?? '' }, { subject: s.code }));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      // a failed read is due again at the very next sweep, whatever the source's own cadence
      await c.query(`INSERT INTO imo_source_polls(source, last_polled_at, last_status, last_error, last_items, new_items, next_due_at, polls, mode) VALUES ($1,$2,'FAILED',$3,0,0,$4,1,'')
        ON CONFLICT (source) DO UPDATE SET last_status = 'FAILED', last_error = EXCLUDED.last_error, next_due_at = EXCLUDED.next_due_at, polls = imo_source_polls.polls + 1, updated_at = now()`,
        [s.code, state?.last_polled_at ?? null, error.slice(0, 500), now]);
      polled.push({ source: s.code, status: 'FAILED', items: 0, newItems: 0, error, mode: '' });
      await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.legislation.sourcePolled, { source: s.code, sourceLabel: s.label, items: 0, newItems: 0, error, since: since.toISOString() }, { subject: s.code }));
    }
  }
  const attempted = polled.filter((p) => p.status !== 'SKIPPED');
  if (attempted.length) await audit.record(c, { action: 'IMO_SOURCES_POLLED', entity: 'ImoWatch', entityId: 'imo-watch', entityLabel: 'IMO watch', after: { sources: attempted.map((p) => `${p.source}:${p.status}`), newItems: created }, note: attempted.filter((p) => p.error).map((p) => `${p.source}: ${p.error}`).join('; '), actor: opts.actor ?? { id: 'scheduler', name: 'Scheduler', kind: 'system' } });
  return { polled, newItems: created };
}

export interface AssessInput { status: string; assessment?: string; dueOn?: string | null; instrumentRef?: string | null }
/** The desk's decision on one item. Transposition names the instrument on the register that implements it. */
export async function assessItem(c: PoolClient, env: Env, audit: AuditClient, id: string, input: AssessInput, user: Principal | null): Promise<ItemRow> {
  const found = await c.query<ItemRow>('SELECT * FROM imo_watch_items WHERE id::text = $1 FOR UPDATE', [id]);
  const before = found.rows[0];
  if (!before) throw notFound('Watch item not found');
  if (!(ITEM_STATUS as readonly string[]).includes(input.status) || input.status === 'NEW') throw badRequest(`status must be one of ${ITEM_STATUS.filter((s) => s !== 'NEW').join(', ')}`);
  let instrument: InstrumentRow | null = null;
  if (input.instrumentRef) {
    instrument = (await c.query<InstrumentRow>('SELECT * FROM legal_instruments WHERE upper(ref_no) = upper($1) OR id::text = $1', [input.instrumentRef.trim()])).rows[0] ?? null;
    if (!instrument) throw notFound(`${input.instrumentRef} is not on the register`);
  }
  if (input.status === 'TRANSPOSED' && !instrument) throw badRequest('A transposed item names the instrument on the register that implements it');
  if (input.status === 'ASSESSED' && !input.assessment?.trim()) throw badRequest('An assessment says what the desk concluded');
  const r = await c.query<ItemRow>(`UPDATE imo_watch_items SET status = $2, assessment = $3, assessed_by_id = $4, assessed_by = $5, assessed_at = now(), due_on = $6, instrument_id = $7, instrument_ref = $8, updated_at = now() WHERE id = $1 RETURNING *`,
    [before.id, input.status, input.assessment?.trim() ?? '', user?.id ?? null, user?.name ?? 'Legislation desk', input.dueOn || null, instrument?.id ?? null, instrument?.ref_no ?? '']);
  const row = r.rows[0];
  await audit.record(c, { action: `IMO_ITEM_${input.status}`, entity: 'ImoWatchItem', entityId: row.id, entityLabel: `${row.reference} — ${row.title}`, before: { status: before.status, instrumentRef: before.instrument_ref }, after: { status: row.status, instrumentRef: row.instrument_ref, dueOn: dateOnly(row.due_on) }, note: row.assessment });
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.legislation.sourceItemAssessed, { itemId: row.id, source: row.source, reference: row.reference, title: row.title, status: row.status, instrumentId: row.instrument_id, instrumentRef: row.instrument_ref, dueOn: dateOnly(row.due_on), assessedBy: row.assessed_by }, { subject: row.id }));
  return row;
}

/** The watch as the desk sees it: what each source produced and where it stands, and what waits. */
export function watchDashboard(items: ItemApi[], polls: ReturnType<typeof pollApi>[], now = new Date()) {
  const by = (s: string) => items.filter((i) => i.status === s).length;
  const since30 = now.getTime() - 30 * 86_400_000;
  return {
    kpis: {
      sources: polls.length, polledOk: polls.filter((p) => p.lastStatus === 'OK').length, failed: polls.filter((p) => p.lastStatus === 'FAILED').length, neverPolled: polls.filter((p) => p.lastStatus === 'NEVER').length,
      items: items.length, new: by('NEW'), assessed: by('ASSESSED'), transposed: by('TRANSPOSED'), dismissed: by('DISMISSED'), overdue: items.filter((i) => i.overdue).length,
      last30Days: items.filter((i) => new Date(i.firstSeenAt).getTime() >= since30).length, withInstrument: items.filter((i) => i.instrumentId).length,
    },
    bySource: polls.map((p) => ({ ...p, items: items.filter((i) => i.source === p.source).length, new: items.filter((i) => i.source === p.source && i.status === 'NEW').length })),
    attention: items.filter((i) => i.status === 'NEW' || i.overdue).sort((a, b) => (b.publishedOn ?? '').localeCompare(a.publishedOn ?? '')).slice(0, 10),
    generatedAt: now.toISOString(),
  };
}
