import { EVENTS, RESOURCE_TYPES, makeEvent, type Actor, type EventEnvelope } from '@maritime/contracts';
import { enqueue, eventFromContext, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { DAY, availability, iso, monthKey, monthWindow, round1, type MonthBucket } from './history';

/* Marine craft and pilots. Each carries its own service record — a tug runs to several hundred jobs — so the board gets a
 * digest and the history endpoint pages the detail. Jobs and outages live in their own tables and travel on the snapshot. */
export const RESOURCE_STATUS = ['AVAILABLE', 'TASKED', 'MAINTENANCE', 'OFF_DUTY'] as const;
export const JOB_KINDS = ['PILOTAGE', 'PILOT_TRANSFER', 'BERTHING', 'UNBERTHING', 'LINE_HANDLING', 'SHIFTING', 'ESCORT', 'STANDBY', 'SURVEY', 'BUNKERING', 'OTHER'] as const;
export type ResourceStatus = (typeof RESOURCE_STATUS)[number];

export interface ResourceRow { id: string; code: string; name: string; type: string; spec: string; status: string; current_task: string; master: string; user_id: string | null; contact: string; remarks: string; created_at: Date; updated_at: Date }
export interface JobRow { id: string; resource_id: string; at: Date; ended_at: Date | null; kind: string; vcn: string; port_call_id: string | null; vessel_name: string; berth: string; hours: string | number; remarks: string }
export interface ResourceOutageRow { id: string; resource_id: string; from_at: Date; to_at: Date; days: string | number; reason: string }
export interface JobApi { id: string; at: string; endedAt: string | null; kind: string; vcn: string; portCallId: string | null; vesselName: string; berth: string; hours: number; remarks: string }
export interface OutageApi { id: string; from: string; to: string; days: number; reason: string }

export const jobApi = (j: JobRow): JobApi => ({ id: j.id, at: iso(j.at)!, endedAt: iso(j.ended_at), kind: j.kind, vcn: j.vcn, portCallId: j.port_call_id, vesselName: j.vessel_name, berth: j.berth, hours: Number(j.hours) || 0, remarks: j.remarks });
export const outageApi = (o: ResourceOutageRow): OutageApi => ({ id: o.id, from: iso(o.from_at)!, to: iso(o.to_at)!, days: Number(o.days) || 0, reason: o.reason });
export const core = (r: ResourceRow) => ({ id: r.id, code: r.code, name: r.name, type: r.type, spec: r.spec, status: r.status, currentTask: r.current_task, master: r.master, userId: r.user_id, contact: r.contact, remarks: r.remarks });
export const toApi = (r: ResourceRow, jobs: JobApi[] = [], outages: OutageApi[] = []) => ({ ...core(r), jobs, outages, createdAt: iso(r.created_at), updatedAt: iso(r.updated_at) });

export async function findResource(c: Queryable, ref: string): Promise<ResourceRow | null> {
  const r = await c.query<ResourceRow>('SELECT * FROM resources WHERE id::text = $1 OR code = $1', [ref]);
  return r.rows[0] ?? null;
}
export async function jobsOf(c: Queryable, resourceId: string): Promise<JobApi[]> {
  const r = await c.query<JobRow>('SELECT * FROM resource_jobs WHERE resource_id = $1 ORDER BY at DESC', [resourceId]);
  return r.rows.map(jobApi);
}
export async function resourceOutagesOf(c: Queryable, resourceId: string): Promise<OutageApi[]> {
  const r = await c.query<ResourceOutageRow>('SELECT * FROM resource_outages WHERE resource_id = $1 ORDER BY from_at DESC', [resourceId]);
  return r.rows.map(outageApi);
}
/** Every craft write publishes the API-shaped snapshot — jobs and outages included, because the read model keeps them on the record. */
export async function publishResource(c: Queryable, env: Env, r: ResourceRow, opts: { event?: string; data?: Record<string, unknown>; cause?: EventEnvelope; actor?: Actor } = {}) {
  const entity = toApi(r, await jobsOf(c, r.id), await resourceOutagesOf(c, r.id));
  const mk = <T,>(type: string, data: T) => (opts.cause ? makeEvent({ type, source: env.SERVICE_NAME, data, subject: r.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor }) : eventFromContext(env.SERVICE_NAME, type, data, { subject: r.id, actor: opts.actor }));
  await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'resource', entity }));
  if (opts.event) await enqueue(c, mk(opts.event, { resourceId: r.id, code: r.code, name: r.name, type: r.type, status: r.status, currentTask: r.current_task, resource: entity, ...(opts.data ?? {}) }));
}
export async function publishResourceDeleted(c: Queryable, env: Env, r: ResourceRow) {
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.deleted, { kind: 'resource', id: r.id }, { subject: r.id }));
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.ports.resourceChanged, { resourceId: r.id, code: r.code, deleted: true }, { subject: r.id }));
}

export interface Window { from: Date; to: Date }
/** The board digest: lifetime and in-window workload, plus how much of the window the craft was actually available. */
export function serviceDigest(jobs: JobApi[], outages: OutageApi[], win: Window, now = new Date()) {
  const since30 = now.getTime() - 30 * DAY;
  let hours = 0; let last: string | null = null; let windowJobs = 0; let windowHours = 0; let jobs30d = 0;
  for (const j of jobs) {
    const at = new Date(j.at).getTime();
    hours += j.hours;
    if (!last || at > new Date(last).getTime()) last = j.at;
    if (at >= win.from.getTime() && at < win.to.getTime()) { windowJobs += 1; windowHours += j.hours; }
    if (at >= since30) jobs30d += 1;
  }
  const av = availability(outages, win.from, win.to);
  return { jobs: jobs.length, hours: round1(hours), windowJobs, windowHours: round1(windowHours), jobs30d, lastJobAt: last, outages: outages.length, outageDays: av.days, availabilityPct: av.availabilityPct };
}
export const emptyBuckets = (bounds: MonthBucket[]) => new Map(bounds.map((b) => [b.key, { month: b.key, label: b.label, jobs: 0, hours: 0 }]));
/** Jobs and hours per month bucket, plus the split by job kind. */
export function bucketJobs(jobs: JobApi[], bounds: MonthBucket[], win: Window) {
  const buckets = emptyBuckets(bounds); const kinds = new Map<string, { kind: string; jobs: number; hours: number }>();
  let windowJobs = 0; let windowHours = 0;
  for (const j of jobs) {
    const at = new Date(j.at);
    if (at < win.from || at >= win.to) continue;
    windowJobs += 1; windowHours += j.hours;
    const b = buckets.get(monthKey(at)); if (b) { b.jobs += 1; b.hours += j.hours; }
    const k = j.kind || 'OTHER'; const kb = kinds.get(k) ?? { kind: k, jobs: 0, hours: 0 };
    kb.jobs += 1; kb.hours += j.hours; kinds.set(k, kb);
  }
  return {
    series: [...buckets.values()].map((b) => ({ ...b, hours: round1(b.hours) })),
    byKind: [...kinds.values()].sort((a, b) => b.jobs - a.jobs).map((k) => ({ ...k, hours: round1(k.hours) })),
    windowJobs, windowHours: round1(windowHours),
  };
}
/** One craft's service record: the window reading, the month series, the kinds and the lifetime totals. */
export function historyReport(r: ResourceRow, jobs: JobApi[], outages: OutageApi[], months: number) {
  const { bounds, from, to } = monthWindow(months);
  const win = { from, to };
  const { series, byKind, windowJobs, windowHours } = bucketJobs(jobs, bounds, win);
  const av = availability(outages, from, to);
  const busiest = series.reduce<(typeof series)[number] | null>((best, b) => (best && best.jobs >= b.jobs ? best : b), null);
  const lifetimeHours = round1(jobs.reduce((s, j) => s + j.hours, 0));
  return {
    resource: core(r),
    summary: {
      window: { from: iso(from)!, to: iso(to)!, months },
      jobs: windowJobs, hours: windowHours, avgHours: windowJobs ? round1(windowHours / windowJobs) : 0, avgJobsPerMonth: round1(windowJobs / months),
      outageDays: av.days, availabilityPct: av.availabilityPct, busiestMonth: busiest && busiest.jobs ? busiest : null,
      lifetime: { jobs: jobs.length, hours: lifetimeHours, firstJobAt: jobs.length ? jobs[jobs.length - 1].at : null, lastJobAt: jobs.length ? jobs[0].at : null, outages: outages.length, outageDays: round1(outages.reduce((s, o) => s + o.days, 0)) },
      series, byKind,
    },
    outages,
  };
}
export const RESOURCE_TYPE_LIST = RESOURCE_TYPES;
