import { DAY, HOUR, monthWindow, round1, type Instant, ms } from './history';

/* The harbour operations dashboard: the port's service quality, read from the call register, the estate and the craft board.
 *
 * The yardsticks are the ones the port-performance literature uses. A wait at anchorage under four hours is an efficient
 * port and the world median runs seven to ten; berth occupancy between sixty and seventy percent is healthy and above
 * eighty-five percent congests; a call whose arrival lands within the berth-window slack of its ETA is a reliable one.
 * Everything is computed from timestamps the desk actually records — ETA, ATA, ATB, ATD — so a number here can be
 * traced to the calls behind it. */

export interface HarbourCall {
  id: string; vcn: string; vesselName: string; vesselType: string | null; status: string; agentCode: string; agentName: string; purpose: string;
  eta: Instant; etb: Instant; etd: Instant; ata: Instant; atb: Instant; atd: Instant; berthId: string | null; berthCode: string | null;
  cargoOps: { cargoType?: string; qtyMT?: number; qty?: number; unit?: string }[];
}
export interface HarbourBerth { id: string; code: string; name: string; terminal: string; berthType: string; status: string }
export interface HarbourOutage { berthId: string; from: Instant; to: Instant; kind: string }
export interface HarbourResource { id: string; type: string; status: string }
export interface HarbourJob { resourceId: string; kind: string; at: Instant; endedAt: Instant; hours: number }
export interface HarbourResourceOutage { resourceId: string; from: Instant; to: Instant }
export interface HarbourTargets { waitingHrs: number; occupancyPct: number; congestionPct: number; etaSlackHrs: number; anchorageAlertHrs: number }
export interface HarbourInput {
  calls: HarbourCall[]; berths: HarbourBerth[]; outages: HarbourOutage[]; resources: HarbourResource[]; jobs: HarbourJob[]; resourceOutages: HarbourResourceOutage[];
}
export const DEFAULT_TARGETS: HarbourTargets = { waitingHrs: 4, occupancyPct: 70, congestionPct: 85, etaSlackHrs: 4, anchorageAlertHrs: 24 };

const OPEN = new Set(['ANNOUNCED', 'CONFIRMED', 'AT_ANCHORAGE', 'BERTHED']);
const hrs = (from: Instant, to: Instant) => (ms(to) - ms(from)) / HOUR;
const has = (d: Instant) => d != null && d !== '' && !Number.isNaN(ms(d));
const inWin = (d: Instant, from: number, to: number) => has(d) && ms(d) >= from && ms(d) < to;
const avg = (xs: number[]) => (xs.length ? round1(xs.reduce((s, x) => s + x, 0) / xs.length) : 0);
const median = (xs: number[]) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return round1(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2); };
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 0);
/** Hours of [from, to] that fall inside the window. An open interval (`to` null) runs to the window's end. */
const overlapHrs = (from: Instant, to: Instant, winFrom: number, winTo: number) => {
  if (!has(from)) return 0;
  const a = Math.max(ms(from), winFrom); const b = Math.min(has(to) ? ms(to) : winTo, winTo);
  return b > a ? (b - a) / HOUR : 0;
};
const cargoOf = (c: HarbourCall) => c.cargoOps.reduce((s, o) => s + (Number(o.qtyMT) || 0), 0);
const teuOf = (c: HarbourCall) => c.cargoOps.filter((o) => o.unit === 'TEU').reduce((s, o) => s + (Number(o.qty) || 0), 0);

export function harbourDashboard(input: HarbourInput, now = new Date(), targets: HarbourTargets = DEFAULT_TARGETS) {
  const t = now.getTime();
  const w30 = t - 30 * DAY; const w12 = t - 365 * DAY; const w7 = t + 7 * DAY; const w72 = t + 72 * HOUR;
  const startMonth = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const prevStart = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1);
  // month to date is read against the same days of the previous month, never against the whole of it
  const prevSameDays = Math.min(startMonth, prevStart + (t - startMonth));
  const { calls, berths, outages, resources, jobs, resourceOutages } = input;

  // --- the last thirty days, call by call
  const arrived30 = calls.filter((c) => inWin(c.ata, w30, t));
  const berthed30 = calls.filter((c) => has(c.ata) && inWin(c.atb, w30, t));
  const sailed30 = calls.filter((c) => has(c.ata) && inWin(c.atd, w30, t));
  const waits30 = berthed30.map((c) => Math.max(0, hrs(c.ata, c.atb)));
  const turnarounds30 = sailed30.map((c) => Math.max(0, hrs(c.ata, c.atd)));
  const alongside30 = sailed30.filter((c) => has(c.atb)).map((c) => Math.max(0, hrs(c.atb, c.atd)));
  const onEta = arrived30.filter((c) => has(c.eta) && Math.abs(hrs(c.eta, c.ata)) <= targets.etaSlackHrs);

  // --- the estate: occupied hours against available hours, berth by berth, over the same thirty days
  const windowHrs = 30 * 24;
  const operational = berths.filter((b) => b.status === 'OPERATIONAL');
  const byBerth = operational.map((b) => {
    const occupied = calls.filter((c) => c.berthId === b.id && has(c.atb)).reduce((s, c) => s + overlapHrs(c.atb, c.atd, w30, t), 0);
    const lost = outages.filter((o) => o.berthId === b.id).reduce((s, o) => s + overlapHrs(o.from, o.to, w30, t), 0);
    const available = Math.max(0, windowHrs - lost);
    return { id: b.id, code: b.code, name: b.name, terminal: b.terminal, berthType: b.berthType, occupiedHrs: round1(occupied), availableHrs: round1(available), occupancyPct: available ? Math.min(100, pct(occupied, available)) : 0 };
  });
  const terminals = [...new Set(byBerth.map((b) => b.terminal))].map((terminal) => {
    const list = byBerth.filter((b) => b.terminal === terminal);
    const occ = list.reduce((s, b) => s + b.occupiedHrs, 0); const av = list.reduce((s, b) => s + b.availableHrs, 0);
    return { terminal, berths: list.length, occupiedHrs: round1(occ), availableHrs: round1(av), occupancyPct: av ? Math.min(100, pct(occ, av)) : 0 };
  }).sort((a, b) => b.occupancyPct - a.occupancyPct || a.terminal.localeCompare(b.terminal));
  const occupiedAll = byBerth.reduce((s, b) => s + b.occupiedHrs, 0); const availableAll = byBerth.reduce((s, b) => s + b.availableHrs, 0);
  const occupancyPct = availableAll ? Math.min(100, pct(occupiedAll, availableAll)) : 0;

  // --- downtime: the outages of the last thirty days and of the year, by kind
  const kindsOf = (from: number) => {
    const m = new Map<string, { kind: string; count: number; hours: number }>();
    for (const o of outages) { const h = overlapHrs(o.from, o.to, from, t); if (h <= 0) continue; const acc = m.get(o.kind) ?? { kind: o.kind, count: 0, hours: 0 }; acc.count += 1; acc.hours += h; m.set(o.kind, acc); }
    return [...m.values()].map((k) => ({ ...k, hours: round1(k.hours) })).sort((a, b) => b.hours - a.hours);
  };
  const outages30 = kindsOf(w30); const outages12 = kindsOf(w12);
  const downtimeHrs30 = round1(outages30.reduce((s, k) => s + k.hours, 0));

  // --- the craft board: assist hours against the hours the fleet could have worked
  const craftByType = [...new Set(resources.map((r) => r.type))].map((type) => {
    const fleet = resources.filter((r) => r.type === type); const ids = new Set(fleet.map((r) => r.id));
    const typeJobs = jobs.filter((j) => ids.has(j.resourceId) && inWin(j.at, w30, t));
    const hours = typeJobs.reduce((s, j) => s + (Number(j.hours) || 0), 0);
    const lost = resourceOutages.filter((o) => ids.has(o.resourceId)).reduce((s, o) => s + overlapHrs(o.from, o.to, w30, t), 0);
    const capacity = Math.max(0, fleet.length * windowHrs - lost);
    return { type, craft: fleet.length, available: fleet.filter((r) => r.status === 'AVAILABLE').length, tasked: fleet.filter((r) => r.status === 'TASKED').length, jobs: typeJobs.length, hours: round1(hours), utilisationPct: capacity ? Math.min(100, pct(hours, capacity)) : 0 };
  }).sort((a, b) => b.hours - a.hours);
  const util = (type: string) => craftByType.find((c) => c.type === type)?.utilisationPct ?? 0;

  // --- the year, month by month
  const { bounds } = monthWindow(12, now);
  const byMonth = bounds.map((b) => {
    const f = b.from.getTime(); const e = b.to.getTime();
    const arrivals = calls.filter((c) => inWin(c.ata, f, e));
    const waits = calls.filter((c) => has(c.ata) && inWin(c.atb, f, e)).map((c) => Math.max(0, hrs(c.ata, c.atb)));
    const turns = calls.filter((c) => has(c.ata) && inWin(c.atd, f, e)).map((c) => Math.max(0, hrs(c.ata, c.atd)));
    const sailed = calls.filter((c) => inWin(c.atd, f, e));
    return { month: b.label, key: b.key, calls: arrivals.length, avgWaitingHrs: avg(waits), avgTurnaroundHrs: avg(turns), cargoMT: Math.round(sailed.reduce((s, c) => s + cargoOf(c), 0)) };
  });

  // --- who calls, and how long each kind of ship holds the quay
  const sailed12 = calls.filter((c) => has(c.ata) && inWin(c.atd, w12, t));
  const byType = [...new Set(sailed12.map((c) => c.vesselType || 'OTHER'))].map((type) => {
    const list = sailed12.filter((c) => (c.vesselType || 'OTHER') === type);
    return { type, calls: list.length, avgTurnaroundHrs: avg(list.map((c) => Math.max(0, hrs(c.ata, c.atd)))), avgWaitingHrs: avg(list.filter((c) => has(c.atb)).map((c) => Math.max(0, hrs(c.ata, c.atb)))), cargoMT: Math.round(list.reduce((s, c) => s + cargoOf(c), 0)) };
  }).sort((a, b) => b.calls - a.calls);
  const arrived12 = calls.filter((c) => inWin(c.ata, w12, t));
  const agentMap = new Map<string, { agentCode: string; agentName: string; calls: number }>();
  for (const c of arrived12) { const acc = agentMap.get(c.agentCode) ?? { agentCode: c.agentCode, agentName: c.agentName, calls: 0 }; acc.calls += 1; agentMap.set(c.agentCode, acc); }
  const agents = [...agentMap.values()].sort((a, b) => b.calls - a.calls).slice(0, 6).map((a) => ({ ...a, sharePct: pct(a.calls, arrived12.length) }));

  // --- the live position
  const open = calls.filter((c) => OPEN.has(c.status));
  const anchored = open.filter((c) => c.status === 'AT_ANCHORAGE').map((c) => ({ id: c.id, vcn: c.vcn, vesselName: c.vesselName, vesselType: c.vesselType, agentName: c.agentName, since: has(c.ata) ? new Date(ms(c.ata)).toISOString() : null, waitingHrs: has(c.ata) ? round1(Math.max(0, hrs(c.ata, t))) : 0, etb: has(c.etb) ? new Date(ms(c.etb)).toISOString() : null }))
    .sort((a, b) => b.waitingHrs - a.waitingHrs);
  const expected = open.filter((c) => (c.status === 'ANNOUNCED' || c.status === 'CONFIRMED') && has(c.eta) && ms(c.eta) > t);
  const arrivals = expected.filter((c) => ms(c.eta) <= w7).sort((a, b) => ms(a.eta) - ms(b.eta)).slice(0, 10)
    .map((c) => ({ id: c.id, vcn: c.vcn, vesselName: c.vesselName, vesselType: c.vesselType, status: c.status, eta: new Date(ms(c.eta)).toISOString(), berthCode: c.berthCode, agentName: c.agentName, purpose: c.purpose }));
  const mtd = calls.filter((c) => inWin(c.atd, startMonth, t)); const prevSailed = calls.filter((c) => inWin(c.atd, prevStart, prevSameDays));

  return {
    kpis: {
      callsMtd: calls.filter((c) => inWin(c.ata, startMonth, t)).length, callsPrevMonth: calls.filter((c) => inWin(c.ata, prevStart, prevSameDays)).length,
      calls30d: arrived30.length, sailed30d: sailed30.length,
      inPort: open.filter((c) => c.status === 'BERTHED').length, atAnchorage: anchored.length,
      expected72h: expected.filter((c) => ms(c.eta) <= w72).length, expected7d: expected.filter((c) => ms(c.eta) <= w7).length,
      avgTurnaroundHrs: avg(turnarounds30), medianTurnaroundHrs: median(turnarounds30), avgAlongsideHrs: avg(alongside30),
      avgWaitingHrs: avg(waits30), medianWaitingHrs: median(waits30), waitingWithinTargetPct: pct(waits30.filter((h) => h <= targets.waitingHrs).length, waits30.length),
      waitingOverAlertPct: pct(waits30.filter((h) => h > targets.anchorageAlertHrs).length, waits30.length),
      etaReliabilityPct: pct(onEta.length, arrived30.filter((c) => has(c.eta)).length),
      berthOccupancyPct: occupancyPct, operationalBerths: operational.length, berthsUnderMaintenance: berths.filter((b) => b.status === 'MAINTENANCE').length,
      berthDowntimeHrs30d: downtimeHrs30, outages30d: outages30.reduce((s, k) => s + k.count, 0),
      pilotUtilisationPct: util('PILOT'), tugUtilisationPct: util('TUG'), craftJobs30d: craftByType.reduce((s, c) => s + c.jobs, 0), craftHours30d: round1(craftByType.reduce((s, c) => s + c.hours, 0)),
      cargoMtd: Math.round(mtd.reduce((s, c) => s + cargoOf(c), 0)), teuMtd: Math.round(mtd.reduce((s, c) => s + teuOf(c), 0)), cargoPrevMonth: Math.round(prevSailed.reduce((s, c) => s + cargoOf(c), 0)),
    },
    targets,
    byMonth, byTerminal: terminals, byBerth: byBerth.sort((a, b) => b.occupancyPct - a.occupancyPct), byType, outagesByKind: outages12, outages30ByKind: outages30, craftByType, agents,
    arrivals, anchored: anchored.slice(0, 10),
    generatedAt: now.toISOString(),
  };
}
export type HarbourDashboard = ReturnType<typeof harbourDashboard>;
