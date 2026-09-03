import { badRequest, conflict, type Queryable } from '@maritime/service-kit';
import { iso, ms } from './history';

/* Berth allocation rules. A berth is held by a call from its actual (or planned) berthing to its planned departure; windows are
 * half-open, so a ship sailing at the very instant the next one berths is not a clash. On top of the occupancy check the estate
 * limits apply: the berth must be in service, no outage window may cover the stay, and the ship must fit the quay's LOA and draft. */
export const ACTIVE_STATUSES = ['CONFIRMED', 'AT_ANCHORAGE', 'BERTHED'] as const;
export interface Occupant { id: string; vcn: string; berthId: string; atb: Date | string | null; etb: Date | string | null; etd: Date | string | null }
export interface BerthLimits { id: string; code: string; name: string; terminal: string; berth_type: string; loa_max: string | number; draft_max: string | number; status: string }
export interface OutageSpan { from_at: Date; to_at: Date; kind: string; reason: string }
export interface Applicant { vesselName?: string | null; loa?: number | null; draft?: number | null }
const FAR_FUTURE = 8640000000000000;

export const overlaps = (aStart: number, aEnd: number, bStart: number, bEnd: number) => aStart < bEnd && bStart < aEnd;

/** The call already holding the berth inside [from, to), if any. An open-ended occupation (no ETD) blocks everything after it. */
export function findBerthConflict(active: Occupant[], berthId: string, from: Date, to: Date, excludeId?: string | null): Occupant | null {
  for (const c of active) {
    if (excludeId && String(c.id) === String(excludeId)) continue;
    if (String(c.berthId) !== String(berthId)) continue;
    const start = c.atb ?? c.etb; if (!start) continue;
    const end = c.etd ? ms(c.etd) : FAR_FUTURE;
    if (overlaps(ms(start), end, from.getTime(), to.getTime())) return c;
  }
  return null;
}
/** Every reason a berth cannot take a ship in a window, in the order the harbour master would check them. Pure, so it is testable without a database. */
export function berthProblems(berth: BerthLimits, active: Occupant[], outages: OutageSpan[], from: Date, to: Date, o: { excludeId?: string | null; vessel?: Applicant } = {}): { status: 400 | 409; message: string } | null {
  if (berth.status !== 'OPERATIONAL') return { status: 400, message: `Berth ${berth.code} is under maintenance` };
  const loa = o.vessel?.loa ?? null; const loaMax = Number(berth.loa_max) || 0;
  if (loa && loaMax && loa > loaMax) return { status: 409, message: `${o.vessel?.vesselName ?? 'The vessel'} (LOA ${loa} m) exceeds the ${berth.code} limit of ${loaMax} m` };
  const draft = o.vessel?.draft ?? null; const draftMax = Number(berth.draft_max) || 0;
  if (draft && draftMax && draft > draftMax) return { status: 409, message: `Draft ${draft} m exceeds the ${berth.code} limit of ${draftMax} m` };
  const outage = outages.find((x) => overlaps(x.from_at.getTime(), x.to_at.getTime(), from.getTime(), to.getTime()));
  if (outage) return { status: 409, message: `Berth ${berth.code} is out of service — ${outage.reason || outage.kind.toLowerCase()} from ${iso(outage.from_at)!.slice(0, 16).replace('T', ' ')} to ${iso(outage.to_at)!.slice(0, 16).replace('T', ' ')}` };
  const clash = findBerthConflict(active, berth.id, from, to, o.excludeId);
  if (clash) return { status: 409, message: `Berth ${berth.code} is held by call ${clash.vcn} in that window` };
  return null;
}
export async function loadBerth(c: Queryable, ref: string): Promise<BerthLimits | null> {
  const r = await c.query<BerthLimits>('SELECT id, code, name, terminal, berth_type, loa_max, draft_max, status FROM berths WHERE id::text = $1 OR code = $1', [ref]);
  return r.rows[0] ?? null;
}
export async function activeOccupants(c: Queryable, berthId: string): Promise<Occupant[]> {
  const r = await c.query<{ id: string; vcn: string; berth_id: string; atb: Date | null; etb: Date | null; etd: Date | null }>('SELECT id, vcn, berth_id, atb, etb, etd FROM port_calls WHERE berth_id = $1 AND status = ANY($2)', [berthId, [...ACTIVE_STATUSES]]);
  return r.rows.map((x) => ({ id: x.id, vcn: x.vcn, berthId: x.berth_id, atb: x.atb, etb: x.etb, etd: x.etd }));
}
/** Loads the berth and refuses the allocation when any rule fails; returns the berth when the window is clear. */
export async function assertBerthAvailable(c: Queryable, ref: string, from: Date, to: Date, o: { excludeId?: string | null; vessel?: Applicant } = {}): Promise<BerthLimits> {
  const berth = await loadBerth(c, ref); if (!berth) throw badRequest('Selected berth does not exist');
  const outages = await c.query<OutageSpan>('SELECT from_at, to_at, kind, reason FROM berth_outages WHERE berth_id = $1 AND from_at < $3 AND to_at > $2 ORDER BY from_at', [berth.id, from, to]);
  const problem = berthProblems(berth, await activeOccupants(c, berth.id), outages.rows, from, to, o);
  if (problem) throw problem.status === 400 ? badRequest(problem.message) : conflict(problem.message);
  return berth;
}
