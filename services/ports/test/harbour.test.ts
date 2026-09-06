import { describe, expect, it } from 'vitest';
import { harbourDashboard, type HarbourInput } from '../src/harbour';

/* The harbour dashboard is one pure function over the call register, the estate and the craft board. The fixture is a
 * small port with two container berths and one bulk berth under maintenance, seven calls across the last year, one planned
 * outage and two tugs; every expected number below is worked by hand from those records. */
const NOW = new Date('2026-09-06T12:00:00Z'); const t = NOW.getTime(); const H = 3600_000; const D = 24 * H;
const at = (h: number) => new Date(t + h * H).toISOString();
const call = (o: Partial<HarbourInput['calls'][number]> & { id: string }) => ({ vcn: `VCN-${o.id}`, vesselName: `Ship ${o.id}`, vesselType: 'CONTAINER', status: 'SAILED', agentCode: 'GSS', agentName: 'Gulf Star', purpose: 'CARGO', eta: null, etb: null, etd: null, ata: null, atb: null, atd: null, berthId: null, berthCode: null, cargoOps: [], ...o });
const input: HarbourInput = {
  berths: [
    { id: 'b1', code: 'CT1-1', name: 'Berth 1', terminal: 'Container Terminal 1', berthType: 'CONTAINER', status: 'OPERATIONAL' },
    { id: 'b2', code: 'CT1-2', name: 'Berth 2', terminal: 'Container Terminal 1', berthType: 'CONTAINER', status: 'OPERATIONAL' },
    { id: 'b3', code: 'BT-1', name: 'Bulk 1', terminal: 'Bulk Terminal', berthType: 'BULK', status: 'MAINTENANCE' },
  ],
  outages: [{ berthId: 'b1', from: at(-5 * 24), to: at(-3 * 24), kind: 'PLANNED' }, { berthId: 'b2', from: at(-200 * 24), to: at(-199 * 24), kind: 'WEATHER' }],
  calls: [
    // sailed: 8 h wait, 48 h turnaround, arrived an hour early against the ETA, 10 000 t and 500 TEU worked
    call({ id: 'c1', eta: at(-239), ata: at(-240), atb: at(-232), atd: at(-192), berthId: 'b1', berthCode: 'CT1-1', cargoOps: [{ cargoType: 'CONTAINERS', qtyMT: 10000, qty: 500, unit: 'TEU' }] }),
    // sailed: 2 h wait, 40 h turnaround, ten hours late against the ETA
    call({ id: 'c2', vesselType: 'TANKER', agentCode: 'OAP', agentName: 'Oceanic', eta: at(-110), ata: at(-100), atb: at(-98), atd: at(-60), berthId: 'b2', berthCode: 'CT1-2', cargoOps: [{ cargoType: 'CRUDE', qtyMT: 40000 }] }),
    // alongside now: 3 h wait, at the berth for 27 h so far
    call({ id: 'c3', status: 'BERTHED', eta: at(-30), ata: at(-30), atb: at(-27), berthId: 'b1', berthCode: 'CT1-1' }),
    // waiting at anchor for six hours
    call({ id: 'c4', status: 'AT_ANCHORAGE', eta: at(-9), ata: at(-6) }),
    call({ id: 'c5', status: 'CONFIRMED', eta: at(24) }),
    call({ id: 'c6', status: 'ANNOUNCED', eta: at(5 * 24) }),
    // early last month: the same days of the previous month, for the month-to-date comparison
    call({ id: 'c8', eta: at(-34 * 24), ata: at(-34 * 24), atb: at(-34 * 24 + 8), atd: at(-32 * 24), berthId: 'b2', berthCode: 'CT1-2', cargoOps: [{ cargoType: 'CONTAINERS', qtyMT: 5000 }] }),
    // a year and more ago: outside every window
    call({ id: 'c7', eta: at(-400 * 24), ata: at(-400 * 24), atb: at(-399 * 24), atd: at(-398 * 24), berthId: 'b1' }),
  ],
  resources: [{ id: 'r1', type: 'TUG', status: 'AVAILABLE' }, { id: 'r2', type: 'TUG', status: 'TASKED' }, { id: 'r3', type: 'PILOT', status: 'AVAILABLE' }],
  jobs: [{ resourceId: 'r1', kind: 'BERTHING', at: at(-232), endedAt: at(-228), hours: 4 }, { resourceId: 'r1', kind: 'UNBERTHING', at: at(-192), endedAt: at(-188), hours: 4 }, { resourceId: 'r2', kind: 'BERTHING', at: at(-98), endedAt: at(-94), hours: 4 }, { resourceId: 'r3', kind: 'PILOTAGE', at: at(-98), endedAt: at(-96), hours: 2 }],
  resourceOutages: [{ resourceId: 'r3', from: at(-24 * 15), to: at(-24 * 5) }],
};

describe('harbour dashboard', () => {
  const d = harbourDashboard(input, NOW);
  it('reads the live position and the calls of the month', () => {
    expect(d.kpis.inPort).toBe(1); expect(d.kpis.atAnchorage).toBe(1); expect(d.kpis.expected72h).toBe(1); expect(d.kpis.expected7d).toBe(2);
    expect(d.kpis.calls30d).toBe(4); expect(d.kpis.sailed30d).toBe(2);
    expect(d.anchored[0]).toMatchObject({ vcn: 'VCN-c4', waitingHrs: 6 });
    expect(d.arrivals.map((a) => a.vcn)).toEqual(['VCN-c5', 'VCN-c6']);
  });
  it('works turnaround, waiting and ETA reliability from the recorded timestamps', () => {
    expect(d.kpis.avgTurnaroundHrs).toBe(44); expect(d.kpis.medianTurnaroundHrs).toBe(44); expect(d.kpis.avgAlongsideHrs).toBe(39);
    expect(d.kpis.avgWaitingHrs).toBe(4.3); expect(d.kpis.medianWaitingHrs).toBe(3);
    expect(d.kpis.waitingWithinTargetPct).toBe(67); // two of the three waits were under four hours
    expect(d.kpis.etaReliabilityPct).toBe(75); // three of the four arrivals landed within the slack of their ETA
    expect(d.byType.map((x) => [x.type, x.avgTurnaroundHrs])).toEqual([['CONTAINER', 48], ['TANKER', 40]]); // c1 and c8 both took 48 h
  });
  it('measures berth occupancy against the hours the estate was actually available', () => {
    const b1 = d.byBerth.find((b) => b.code === 'CT1-1')!; const b2 = d.byBerth.find((b) => b.code === 'CT1-2')!;
    expect(b1.availableHrs).toBe(672); // 720 hours less the planned two-day outage
    expect(b1.occupiedHrs).toBe(67); // forty hours alongside for c1, twenty-seven so far for c3
    expect(b2).toMatchObject({ occupiedHrs: 38, availableHrs: 720, occupancyPct: 5 });
    expect(d.kpis.berthOccupancyPct).toBe(8); expect(d.byTerminal).toEqual([{ terminal: 'Container Terminal 1', berths: 2, occupiedHrs: 105, availableHrs: 1392, occupancyPct: 8 }]);
    expect(d.kpis.operationalBerths).toBe(2); expect(d.kpis.berthsUnderMaintenance).toBe(1);
    expect(d.kpis.berthDowntimeHrs30d).toBe(48); expect(d.outagesByKind.map((k) => k.kind)).toEqual(['PLANNED', 'WEATHER']); expect(d.outages30ByKind).toEqual([{ kind: 'PLANNED', count: 1, hours: 48 }]);
  });
  it('reads the craft board as hours worked against hours the fleet could have worked', () => {
    const tugs = d.craftByType.find((c) => c.type === 'TUG')!; const pilots = d.craftByType.find((c) => c.type === 'PILOT')!;
    expect(tugs).toMatchObject({ craft: 2, available: 1, tasked: 1, jobs: 3, hours: 12, utilisationPct: 1 });
    expect(pilots.hours).toBe(2); expect(pilots.utilisationPct).toBe(0); // 2 h against 480 available hours after the ten-day outage
    expect(d.kpis.craftJobs30d).toBe(4); expect(d.kpis.tugUtilisationPct).toBe(1);
  });
  it('lays the year out month by month and names who calls', () => {
    expect(d.byMonth).toHaveLength(12); expect(d.byMonth[11].key).toBe('2026-09'); expect(d.byMonth[11].calls).toBe(3); // c1 arrived in August
    expect(d.byMonth[11].cargoMT).toBe(40000); expect(d.byMonth[10].cargoMT).toBe(15000);
    expect(d.agents.map((a) => [a.agentCode, a.calls, a.sharePct])).toEqual([['GSS', 4, 80], ['OAP', 1, 20]]);
    expect(d.kpis.cargoMtd).toBe(40000); expect(d.kpis.teuMtd).toBe(0);
    // the comparison is with the same days of last month: c8 (early August) counts, c1 (late August) does not
    expect(d.kpis.cargoPrevMonth).toBe(5000); expect(d.kpis.callsMtd).toBe(3); expect(d.kpis.callsPrevMonth).toBe(1);
  });
  it('tolerates an empty port', () => {
    const e = harbourDashboard({ calls: [], berths: [], outages: [], resources: [], jobs: [], resourceOutages: [] }, NOW);
    expect(e.kpis.berthOccupancyPct).toBe(0); expect(e.kpis.avgWaitingHrs).toBe(0); expect(e.byMonth).toHaveLength(12); expect(e.agents).toEqual([]);
  });
});
