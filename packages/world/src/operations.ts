import { Prng, HIST_START, H, D, stableId } from './prng';
import type { WorldVessel } from './vessels';
import type { WorldBerth } from './organisations';

export interface WorldCargoOp { cargoType: string; operation: 'LOAD' | 'DISCHARGE'; qty: number; unit: 'MT' | 'TEU' | 'UNITS'; qtyMT: number }
export interface WorldPortCall { id: string; vcn: string; vesselId: string; vesselName: string; agentCode: string; status: 'ANNOUNCED' | 'CONFIRMED' | 'AT_ANCHORAGE' | 'BERTHED' | 'SAILED' | 'CANCELLED'; eta: string; etb: string; etd: string; ata: string | null; atb: string | null; atd: string | null; berthCode: string | null; prevPort: string; nextPort: string; cargoOps: WorldCargoOp[] }

const PORTS = ['CNSHA', 'SGSIN', 'AEJEA', 'SAJED', 'MYPKG', 'LKCMB', 'NLRTM', 'KWKWI', 'SARTA', 'OMSLL', 'QAHMD', 'INNSA', 'PKKHI', 'EGPSD', 'KRPUS'];
const cargoFor = (rng: Prng, type: string): WorldCargoOp[] => {
  if (type === 'CONT') { const q = rng.int(400, 4200); return [{ cargoType: 'CONTAINERS', operation: rng.chance(0.5) ? 'DISCHARGE' : 'LOAD', qty: q, unit: 'TEU', qtyMT: q * 12 }]; }
  if (type === 'TANK') { const q = rng.int(20000, 140000); return [{ cargoType: rng.pick(['CRUDE', 'POL', 'EDIBLE', 'LNG']), operation: rng.chance(0.6) ? 'DISCHARGE' : 'LOAD', qty: q, unit: 'MT', qtyMT: q }]; }
  if (type === 'BULK') { const q = rng.int(25000, 90000); return [{ cargoType: rng.pick(['COAL', 'FERT', 'GRAIN']), operation: 'DISCHARGE', qty: q, unit: 'MT', qtyMT: q }]; }
  if (type === 'RORO') { const q = rng.int(300, 2400); return [{ cargoType: 'AUTO', operation: 'DISCHARGE', qty: q, unit: 'UNITS', qtyMT: Math.round(q * 1.5) }]; }
  const q = rng.int(3000, 18000); return [{ cargoType: rng.pick(['STEEL', 'PROJ']), operation: rng.chance(0.5) ? 'DISCHARGE' : 'LOAD', qty: q, unit: 'MT', qtyMT: q }];
};
const berthFor = (rng: Prng, berths: WorldBerth[], type: string): WorldBerth => {
  const want = type === 'CONT' ? 'CONTAINER' : type === 'TANK' ? 'LIQUID' : type === 'BULK' ? 'BULK' : type === 'RORO' ? 'RORO' : 'MULTIPURPOSE';
  return rng.pick(berths.filter((b) => b.berthType === want && b.status === 'OPERATIONAL'));
};

/** Port calls from January 2023 to now on a growth ramp, plus a live snapshot at the end. */
export function buildPortCalls(rng: Prng, vessels: WorldVessel[], berths: WorldBerth[], now: Date, vcnPrefix = 'MAR'): WorldPortCall[] {
  const out: WorldPortCall[] = [];
  const months = (now.getUTCFullYear() - HIST_START.getUTCFullYear()) * 12 + (now.getUTCMonth() - HIST_START.getUTCMonth());
  const seqByYear = new Map<number, number>();
  const next = (d: Date) => { const y = d.getUTCFullYear(); const n = (seqByYear.get(y) ?? 0) + 1; seqByYear.set(y, n); return `${vcnPrefix}-${y}-${String(n).padStart(4, '0')}`; };
  for (let m = 0; m <= months; m++) {
    const mStart = new Date(Date.UTC(HIST_START.getUTCFullYear(), HIST_START.getUTCMonth() + m, 1));
    const daysInMonth = new Date(Date.UTC(mStart.getUTCFullYear(), mStart.getUTCMonth() + 1, 0)).getUTCDate();
    const target = Math.round(18 + (m / Math.max(1, months)) * 14 + rng.int(-2, 2));
    for (let k = 0; k < target; k++) {
      const v = rng.pick(vessels); const b = berthFor(rng, berths, v.type);
      const eta = new Date(mStart.getTime() + rng.int(0, daysInMonth - 1) * D + rng.int(0, 23) * H);
      if (eta.getTime() > now.getTime() - 3 * D) continue;
      const wait = rng.int(2, 30) * H; const stay = rng.int(14, 72) * H;
      const atb = new Date(eta.getTime() + wait); const atd = new Date(atb.getTime() + stay);
      out.push({ id: stableId('portcall', `${eta.toISOString()}:${v.imo}`), vcn: next(eta), vesselId: v.id, vesselName: v.name, agentCode: v.agentCode, status: 'SAILED', eta: eta.toISOString(), etb: new Date(eta.getTime() + 6 * H).toISOString(), etd: new Date(atb.getTime() + stay - 4 * H).toISOString(),
        ata: eta.toISOString(), atb: atb.toISOString(), atd: atd.toISOString(), berthCode: b.code, prevPort: rng.pick(PORTS), nextPort: rng.pick(PORTS), cargoOps: cargoFor(rng, v.type) });
    }
  }
  // live snapshot: berthed, at anchorage, confirmed and announced calls around "now"
  const live: [WorldPortCall['status'], number][] = [['BERTHED', 9], ['AT_ANCHORAGE', 4], ['CONFIRMED', 5], ['ANNOUNCED', 6]];
  const usedBerths = new Set<string>();
  for (const [status, count] of live) {
    for (let k = 0; k < count; k++) {
      const v = rng.pick(vessels); let b = berthFor(rng, berths, v.type); let tries = 0;
      while (usedBerths.has(b.code) && tries++ < 10) b = berthFor(rng, berths, v.type);
      const eta = new Date(now.getTime() + (status === 'BERTHED' ? -rng.int(6, 40) * H : status === 'AT_ANCHORAGE' ? -rng.int(2, 20) * H : status === 'CONFIRMED' ? rng.int(6, 48) * H : rng.int(48, 120) * H));
      const berthed = status === 'BERTHED';
      if (berthed) usedBerths.add(b.code);
      out.push({ id: stableId('portcall', `${eta.toISOString()}:${v.imo}:${status}`), vcn: next(eta), vesselId: v.id, vesselName: v.name, agentCode: v.agentCode, status, eta: eta.toISOString(), etb: new Date(eta.getTime() + 6 * H).toISOString(), etd: new Date(eta.getTime() + rng.int(30, 80) * H).toISOString(),
        ata: berthed || status === 'AT_ANCHORAGE' ? eta.toISOString() : null, atb: berthed ? new Date(eta.getTime() + 5 * H).toISOString() : null, atd: null, berthCode: berthed || status === 'CONFIRMED' ? b.code : null, prevPort: rng.pick(PORTS), nextPort: rng.pick(PORTS), cargoOps: cargoFor(rng, v.type) });
    }
  }
  return out.sort((a, b) => a.eta.localeCompare(b.eta));
}
