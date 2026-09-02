import { getJurisdiction, RESOURCE_TYPES } from '@maritime/contracts';
import { Prng, D, H, HIST_START, stableId, iso } from './prng';
import { personName, type WorldUser } from './people';
import type { WorldBerth } from './organisations';
import type { WorldPortCall } from './operations';
import type { WorldVessel } from './vessels';
import type { WorldIncident } from './incidents';

export type ResourceType = (typeof RESOURCE_TYPES)[number];
export interface WorldBerthOutage { id: string; berthId: string; berthCode: string; from: string; to: string; days: number; kind: 'PLANNED' | 'BREAKDOWN' | 'DREDGING' | 'WEATHER'; reason: string; by: string }
export interface WorldResourceJob { at: string; endedAt: string | null; kind: string; vcn: string; portCallId: string | null; vesselName: string; berth: string; hours: number; remarks: string }
export interface WorldResourceOutage { from: string; to: string; reason: string; days: number }
export interface WorldResource {
  id: string; code: string; name: string; type: ResourceType; spec: string; status: 'AVAILABLE' | 'TASKED' | 'MAINTENANCE' | 'OFF_DUTY'; currentTask: string;
  master: string; userId: string | null; contact: string; remarks: string; jobs: WorldResourceJob[]; outages: WorldResourceOutage[];
}

/** Each berth takes a couple of outages a year across the whole history. */
export function buildBerthOutages(rng: Prng, profile: string, berths: WorldBerth[], now: Date): WorldBerthOutage[] {
  const ae = getJurisdiction(profile).code === 'AE'; const histDays = Math.floor((now.getTime() - HIST_START.getTime()) / D);
  const kinds: [WorldBerthOutage['kind'], string][] = [['PLANNED', 'Scheduled fender and bollard renewal'], ['PLANNED', 'Quay crane rail alignment'], ['BREAKDOWN', 'Shore gangway hydraulic failure'],
    ['DREDGING', 'Maintenance dredging of the berth pocket'], ['WEATHER', ae ? 'Berth vacated — shamal wind contingency' : 'Berth vacated — cyclone contingency'], ['PLANNED', 'Cope-line concrete repair'], ['BREAKDOWN', 'Conveyor gallery belt replacement']];
  const out: WorldBerthOutage[] = [];
  berths.forEach((b, bi) => {
    const mine: WorldBerthOutage[] = [];
    for (let back = histDays - rng.int(10, 90); back > 20; back -= rng.int(150, 260)) {
      const from = new Date(now.getTime() - back * D); const [kind, reason] = kinds[(bi + mine.length) % kinds.length];
      const days = kind === 'WEATHER' ? rng.int(2, 4) : kind === 'BREAKDOWN' ? rng.int(1, 5) : rng.int(4, 14);
      mine.push({ id: stableId('outage', `${b.code}:${iso(from)}`), berthId: b.id, berthCode: b.code, from: iso(from), to: iso(from.getTime() + days * D), days, kind, reason, by: 'Civil & Marine Works' });
    }
    out.push(...mine.reverse());
  });
  return out;
}

/** Marine craft and pilots. Every sailed call needed pilots, tugs and line boats, so each craft's service record is dealt from the real call history. */
export function buildResources(rng: Prng, profile: string, users: WorldUser[], portCalls: WorldPortCall[], berths: WorldBerth[], vessels: WorldVessel[], incidents: WorldIncident[], now: Date): WorldResource[] {
  const ae = getJurisdiction(profile).code === 'AE'; const histDays = Math.floor((now.getTime() - HIST_START.getTime()) / D);
  const pilots = users.filter((u) => /pilot/i.test(u.designation)).slice(0, 4);
  const craft: [string, string, ResourceType, string][] = ae ? [
    ['TUG-01', 'Al Reem', 'TUG', 'ASD tug — 60 T bollard pull, FiFi-1'], ['TUG-02', 'Al Yasat', 'TUG', 'ASD tug — 60 T bollard pull, FiFi-1'], ['TUG-03', 'Dalma', 'TUG', 'ASD tug — 45 T bollard pull'],
    ['TUG-04', 'Umm Al Nar', 'TUG', 'Conventional tug — 36 T bollard pull'], ['TUG-05', 'Al Sila', 'TUG', 'ASD tug — 50 T bollard pull, oil-spill kit'],
    ['PLT-01', 'Pilot 1', 'PILOT_LAUNCH', 'Pilot launch — 22 kn'], ['PLT-02', 'Pilot 2', 'PILOT_LAUNCH', 'Pilot launch — 22 kn'], ['PLT-03', 'Pilot 3', 'PILOT_LAUNCH', 'Pilot launch — 18 kn'], ['PLT-04', 'Pilot 4', 'PILOT_LAUNCH', 'Pilot launch — 14 kn'], ['PLT-05', 'Pilot 5', 'PILOT_LAUNCH', 'Pilot launch — 14 kn'],
    ['MB-01', 'Marsa 1', 'MOORING_BOAT', 'Mooring boat — line handling'], ['MB-02', 'Marsa 2', 'MOORING_BOAT', 'Mooring boat — line handling'], ['SVL-01', 'Survey 1', 'SURVEY_LAUNCH', 'Hydrographic survey launch'],
  ] : [
    ['TUG-01', 'Harbour Shakti', 'TUG', 'ASD tug — 52 T bollard pull, FiFi-1'], ['TUG-02', 'Harbour Veer', 'TUG', 'ASD tug — 52 T bollard pull, FiFi-1'], ['TUG-03', 'Coastal Sahas', 'TUG', 'ASD tug — 40 T bollard pull'],
    ['TUG-04', 'Coastal Bal', 'TUG', 'Conventional tug — 36 T bollard pull'], ['TUG-05', 'Samudra Tez', 'TUG', 'ASD tug — 45 T bollard pull, oil-spill kit'],
    ['PLT-01', 'Harbour P-1', 'PILOT_LAUNCH', 'Pilot launch — 12 kn'], ['PLT-02', 'Harbour P-2', 'PILOT_LAUNCH', 'Pilot launch — 12 kn'], ['PLT-03', 'Harbour P-3', 'PILOT_LAUNCH', 'Pilot launch — 11 kn'], ['PLT-04', 'Harbour P-4', 'PILOT_LAUNCH', 'Pilot launch — 7 kn'], ['PLT-05', 'Harbour P-5', 'PILOT_LAUNCH', 'Pilot launch — 7 kn'],
    ['MB-01', 'Anchor Bay-1', 'MOORING_BOAT', 'Mooring boat — line handling'], ['MB-02', 'Anchor Bay-2', 'MOORING_BOAT', 'Mooring boat — line handling'], ['SVL-01', 'Harbour Survey-1', 'SURVEY_LAUNCH', 'Hydrographic survey launch'],
  ];
  const defs: [string, string, ResourceType, string, string, string | null, string][] = [
    ...craft.map(([code, name, type, spec]): [string, string, ResourceType, string, string, string | null, string] => [code, name, type, spec, personName(rng, profile), null, type === 'TUG' ? 'VHF Ch 12' : type === 'PILOT_LAUNCH' ? 'VHF Ch 14' : type === 'MOORING_BOAT' ? 'VHF Ch 68' : 'VHF Ch 71']),
    ...pilots.map((u, i): [string, string, ResourceType, string, string, string | null, string] => [`PIL-${String(i + 1).padStart(2, '0')}`, u.name, 'PILOT', i === 0 ? 'Senior pilot — unrestricted, VLCC endorsed' : i === 3 ? 'Pilot — restricted to 250 m LOA' : 'Pilot — unrestricted', '', u.id, u.phone]),
  ];
  const codesOf = (t: ResourceType) => defs.filter((d) => d[2] === t).map((d) => d[0]);
  const tugs = codesOf('TUG'); const launches = codesOf('PILOT_LAUNCH'); const pilotCodes = codesOf('PILOT'); const mooring = codesOf('MOORING_BOAT');
  const jobs: Record<string, WorldResourceJob[]> = Object.fromEntries(defs.map((d) => [d[0], []]));
  const bigTypes = new Set(['CONT', 'TANK', 'BULK']); const vById = new Map(vessels.map((v) => [v.id, v]));
  const sailed = portCalls.filter((c) => c.status === 'SAILED' && c.atb && c.atd).sort((a, b) => a.atb!.localeCompare(b.atb!));
  sailed.forEach((c, ci) => {
    const big = bigTypes.has(vById.get(c.vesselId)?.type ?? '');
    const push = (code: string | undefined, kind: string, at: string, hrs: number, remarks: string) => {
      if (!code) return;
      jobs[code].push({ at, endedAt: iso(new Date(at).getTime() + hrs * H), kind, vcn: c.vcn, portCallId: c.id, vesselName: c.vesselName, berth: c.berthCode ?? '', hours: hrs, remarks });
    };
    push(pilotCodes[ci % pilotCodes.length], 'PILOTAGE', c.atb!, rng.int(2, 4), 'Inward pilotage');
    push(launches[ci % launches.length], 'PILOT_TRANSFER', iso(new Date(c.atb!).getTime() - 1.5 * H), rng.int(1, 2), 'Pilot to boarding ground');
    push(tugs[ci % tugs.length], 'BERTHING', c.atb!, rng.int(2, 3), `${big ? 2 : 1} tug assist`);
    if (big) push(tugs[(ci + 2) % tugs.length], 'BERTHING', c.atb!, rng.int(2, 3), 'Second tug');
    push(mooring[ci % mooring.length], 'LINE_HANDLING', c.atb!, rng.int(1, 2), 'Made fast');
    push(pilotCodes[(ci + 1) % pilotCodes.length], 'PILOTAGE', c.atd!, rng.int(2, 4), 'Outward pilotage');
    push(tugs[(ci + 1) % tugs.length], 'UNBERTHING', c.atd!, rng.int(2, 3), 'Unberthing assist');
    push(mooring[(ci + 1) % mooring.length], 'LINE_HANDLING', c.atd!, rng.int(1, 2), 'Let go');
  });
  const berthedNow = portCalls.filter((c) => c.status === 'BERTHED');
  const sar = incidents.find((i) => i.type === 'SAR' && i.status === 'RESPONDING'); const hazard = incidents.find((i) => i.type === 'NAV_HAZARD' && i.status === 'MONITORING');
  const reasons = ['Annual survey and class docking', 'Gearbox overhaul', 'Hull cleaning and propeller polish', 'Engine top overhaul', 'FiFi system recertification', 'Winch and towing gear renewal'];
  return defs.map(([code, name, type, spec, master, userId, contact], i) => {
    let status: WorldResource['status'] = 'AVAILABLE'; let currentTask = '';
    if (code === 'TUG-04') status = 'MAINTENANCE';
    else if (code === 'PLT-05') status = 'OFF_DUTY';
    else if (code === 'TUG-01' && sar) { status = 'TASKED'; currentTask = `${sar.number} — SAR tow in progress`; jobs[code].push({ at: iso(now.getTime() - 4.6 * H), endedAt: null, kind: 'ESCORT', vcn: '', portCallId: null, vesselName: sar.vesselName, berth: '', hours: 0, remarks: `${sar.number} — tasked to the SAR tow` }); }
    else if (code === 'PLT-02' && sar) { status = 'TASKED'; currentTask = `${sar.number} — standby at the fishing harbour`; jobs[code].push({ at: iso(now.getTime() - 4.2 * H), endedAt: null, kind: 'STANDBY', vcn: '', portCallId: null, vesselName: sar.vesselName, berth: '', hours: 0, remarks: `${sar.number} — casualty standby` }); }
    else if (code === 'SVL-01' && hazard) { status = 'TASKED'; currentTask = `${hazard.number} — hazard verification sweep at first light`; jobs[code].push({ at: iso(now.getTime() - 24 * H), endedAt: null, kind: 'SURVEY', vcn: '', portCallId: null, vesselName: '', berth: '', hours: 0, remarks: `${hazard.number} — verify and mark the drifting container` }); }
    else if (code === 'PIL-02' && berthedNow[i % berthedNow.length]) { status = 'TASKED'; currentTask = `${berthedNow[i % berthedNow.length].vcn} — pilotage in progress`; }
    const outages: WorldResourceOutage[] = [];
    if (type !== 'PILOT') { // craft dock roughly yearly; pilots take leave rather than dock
      for (let back = histDays - rng.int(20, 120); back > 30; back -= rng.int(320, 400)) {
        const from = new Date(now.getTime() - back * D); const days = rng.int(4, 16);
        outages.push({ from: iso(from), to: iso(from.getTime() + days * D), days, reason: reasons[(i + outages.length) % reasons.length] });
      }
      outages.reverse();
    }
    return { id: stableId('resource', code), code, name, type, spec, status, currentTask, master, userId, contact, remarks: code === 'TUG-04' ? 'Annual survey — gearbox overhaul at the repair yard' : '', jobs: jobs[code].sort((a, b) => a.at.localeCompare(b.at)), outages };
  });
}
