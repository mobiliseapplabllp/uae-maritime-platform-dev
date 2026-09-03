import { EVENTS, makeEvent, type Actor, type EventEnvelope } from '@maritime/contracts';
import { enqueue, eventFromContext, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { availability, iso, monthWindow, num, overlapDays, round1, type MonthBucket } from './history';

/* The berth estate: the row, its outage record and the availability readings the estate screens draw.
 * Outages live in their own table (a berth accumulates years of them) but travel on the read-model snapshot,
 * because the reporting projection keeps them on the berth record. */

export interface BerthRow { id: string; code: string; name: string; terminal: string; berth_type: string; loa_max: string | number; draft_max: string | number; status: string; remarks: string; created_at: Date; updated_at: Date }
export interface OutageRow { id: string; berth_id: string; from_at: Date; to_at: Date; days: string | number; kind: string; reason: string; recorded_by: string; created_at: Date }
export interface OutageApi { id: string; from: string; to: string; days: number; kind: string; reason: string; by: string }

export const OUTAGE_KINDS = ['PLANNED', 'BREAKDOWN', 'DREDGING', 'WEATHER'] as const;
export const BERTH_TYPES = ['CONTAINER', 'BULK', 'MULTIPURPOSE', 'LIQUID', 'RORO', 'SPM', 'COAL'] as const;
export const BERTH_STATUS = ['OPERATIONAL', 'MAINTENANCE', 'CLOSED'] as const;

export const outageApi = (o: OutageRow): OutageApi => ({ id: o.id, from: iso(o.from_at)!, to: iso(o.to_at)!, days: Number(o.days) || 0, kind: o.kind, reason: o.reason, by: o.recorded_by });
export const toApi = (b: BerthRow, outages: OutageApi[] = []) => ({
  id: b.id, code: b.code, name: b.name, terminal: b.terminal, berthType: b.berth_type, loaMax: num(b.loa_max) ?? 0, draftMax: num(b.draft_max) ?? 0, status: b.status, remarks: b.remarks,
  outages, createdAt: iso(b.created_at), updatedAt: iso(b.updated_at),
});
export type BerthApi = ReturnType<typeof toApi>;

export async function findBerth(c: Queryable, ref: string): Promise<BerthRow | null> {
  const r = await c.query<BerthRow>('SELECT * FROM berths WHERE id::text = $1 OR code = $1', [ref]);
  return r.rows[0] ?? null;
}
export async function outagesOf(c: Queryable, berthId: string): Promise<OutageApi[]> {
  const r = await c.query<OutageRow>('SELECT * FROM berth_outages WHERE berth_id = $1 ORDER BY from_at DESC', [berthId]);
  return r.rows.map(outageApi);
}
/** The berth with its outage record, as every write publishes it. */
export async function berthEntity(c: Queryable, b: BerthRow): Promise<BerthApi> { return toApi(b, await outagesOf(c, b.id)); }

/** Every berth write publishes the API-shaped snapshot first, then the business event. */
export async function publishBerth(c: Queryable, env: Env, b: BerthRow, opts: { event?: string; data?: Record<string, unknown>; cause?: EventEnvelope; actor?: Actor } = {}) {
  const entity = await berthEntity(c, b);
  const mk = <T,>(type: string, data: T) => (opts.cause ? makeEvent({ type, source: env.SERVICE_NAME, data, subject: b.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor }) : eventFromContext(env.SERVICE_NAME, type, data, { subject: b.id, actor: opts.actor }));
  await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'berth', entity }));
  if (opts.event) await enqueue(c, mk(opts.event, { berthId: b.id, code: b.code, name: b.name, terminal: b.terminal, status: b.status, berth: entity, ...(opts.data ?? {}) }));
}
export async function publishBerthDeleted(c: Queryable, env: Env, b: BerthRow) {
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.deleted, { kind: 'berth', id: b.id }, { subject: b.id }));
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.ports.berthChanged, { berthId: b.id, code: b.code, deleted: true }, { subject: b.id }));
}

export interface WindowSpan { from: Date; to: Date }
/** Outage days per month bucket for one berth's record. */
export const outageSeries = (bounds: MonthBucket[], outages: OutageApi[]) => bounds.map((b) => ({
  month: b.key, label: b.label,
  days: round1(outages.reduce((s, o) => s + overlapDays(o.from, o.to, b.from, b.to), 0)),
  outages: outages.filter((o) => new Date(o.from) < b.to && new Date(o.to) > b.from).length,
}));
export const byKindOf = (outages: OutageApi[], win?: WindowSpan) => {
  const m = new Map<string, { kind: string; outages: number; days: number }>();
  for (const o of outages) {
    if (win && !(new Date(o.from) < win.to && new Date(o.to) > win.from)) continue;
    const k = o.kind || 'OTHER'; const e = m.get(k) ?? { kind: k, outages: 0, days: 0 };
    e.outages += 1; e.days += win ? overlapDays(o.from, o.to, win.from, win.to) : o.days;
    m.set(k, e);
  }
  return [...m.values()].sort((a, b) => b.days - a.days).map((k) => ({ ...k, days: round1(k.days) }));
};
/** One berth's outage record with the availability the windows leave over the trailing months. */
export function outageReport(b: BerthRow, outages: OutageApi[], months: number) {
  const { bounds, from, to } = monthWindow(months);
  const av = availability(outages.map((o) => ({ from: o.from, to: o.to })), from, to);
  const inWindow = outages.filter((o) => new Date(o.from) < to && new Date(o.to) > from);
  const longest = outages.reduce<OutageApi | null>((best, o) => (best && best.days >= o.days ? best : o), null);
  return {
    berth: { id: b.id, code: b.code, name: b.name, terminal: b.terminal, berthType: b.berth_type, loaMax: num(b.loa_max) ?? 0, draftMax: num(b.draft_max) ?? 0, status: b.status },
    summary: {
      window: { from: iso(from)!, to: iso(to)!, months },
      outages: inWindow.length, days: av.days, availabilityPct: av.availabilityPct,
      lifetime: {
        outages: outages.length, days: round1(outages.reduce((s, o) => s + o.days, 0)),
        firstFrom: outages.length ? outages[outages.length - 1].from : null, lastTo: outages.length ? outages[0].to : null,
      },
      byKind: byKindOf(outages), series: outageSeries(bounds, outages), longest,
    },
    outages,
  };
}
