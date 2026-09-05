import { getJurisdiction } from '@maritime/contracts';
import { Prng, D, stableId, iso, dateOnly } from './prng';
import { namePoolFor, type WorldSeafarer } from './crew';
import type { WorldCompany } from './organisations';
import type { WorldVessel } from './vessels';
import type { WorldPortCall } from './operations';
import type { WorldLookup } from './reference';
import type { WorldLicence } from './instruments';

/* The parts of the crew domain that sit beside the register rather than inside it.
 *
 *   The MET register — the maritime education and training providers the administration accredits under
 *   STCW regulation I/8, and the programmes each is approved to deliver. An institution is a company on the
 *   directory; the accreditation itself is an instrument, and its annual cycle runs on the same engine as
 *   the six industry schemes. What lives here is the register's own overlay: type, capacity, simulators,
 *   the quality system, and the programme approvals.
 *
 *   The safe manning scale — what the minimum safe manning document (SOLAS V/14) says a ship must carry
 *   before she sails, rank by rank. The document is an instrument; the scale is the structured reading of
 *   it that a crew list can be checked against.
 *
 *   The FAL-5 crew list — what the master declares on arrival, one row per person. Rows are matched to the
 *   national register where they can be, and to the foreign seafarer ledger where they cannot; every
 *   person on a list is either one the administration certificated or one it has now seen.
 *
 * Every rank, programme, source and trading area here is a code of a Data Studio master, looked up by code
 * and never spelled again; the seed writes the master's label beside the code so the record reads as text.
 * Every person on a crew list who is not on the register is fictional. */

export interface WorldMetInstitution {
  id: string; companyId: string; code: string; name: string; nameAr: string; institutionType: string; city: string; address: string;
  contactName: string; contactEmail: string; contactPhone: string; status: 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
  /** The accreditation instrument the register holds for it, when it holds one; an unaccredited provider is on the register too, so that it can be watched. */
  accreditationInstrumentId: string | null; accreditationInstrumentNo: string;
  /** Where the accreditation stands on the day the world is built, read from the instrument the way the facilities cycle would read it. */
  accreditationStatus: 'NONE' | 'CURRENT' | 'DUE' | 'EXPIRED' | 'SUSPENDED' | 'WITHDRAWN'; accreditedFrom: string | null; accreditedUntil: string | null; accreditationCycleNo: number;
  instructors: number; capacity: number; simulators: string[]; qualitySystem: string; establishedOn: string; remarks: string;
}
export interface WorldMetProgramme {
  id: string; institutionId: string; programme: string; title: string; regulation: string; seatsPerIntake: number; intakesPerYear: number;
  status: 'APPROVED' | 'PENDING' | 'SUSPENDED' | 'WITHDRAWN'; approvalNo: string; instrumentId: string | null; approvedOn: string | null; expiresOn: string | null; remarks: string;
}
export interface WorldManningRow { rankCode: string; rank: string; count: number; cocGrade: string; notes: string }
export interface WorldManningScale { id: string; vesselId: string; vesselName: string; imo: string; msmdNo: string; instrumentId: string | null; issuedOn: string | null; tradingArea: string; rows: WorldManningRow[]; remarks: string }
/** One line of a FAL form 5. The register id is set when the person is on the national register — the seed knows, the desk has to match. */
export interface WorldCrewRow {
  seq: number; familyName: string; givenNames: string; rankCode: string; rank: string; nationality: string; dob: string; pob: string; gender: 'M' | 'F';
  idType: string; idNumber: string; idExpiry: string | null; cdcNo: string; seafarerId: string | null;
}
export interface WorldCrewList {
  id: string; number: string; vcn: string; portCallId: string; vesselId: string; vesselName: string; imo: string; movement: 'ARRIVAL' | 'DEPARTURE'; date: string; source: string;
  agentCode: string; submittedBy: string; declaredCrew: number; rows: WorldCrewRow[]; remarks: string;
  /** Where the desk left it: an older list has been decided, a recent one waits; the ones built with something wrong in them are the ones the desk queried. */
  status: 'CHECKED' | 'CLEARED' | 'QUERIED';
}

/* Safe manning by ship type, as the flag would set it under IMO resolution A.1047(27): a watchkeeping
 * arrangement on the bridge and in the engine room, ratings forming part of a navigational watch, and the
 * catering the MLC requires. Ranks and competency grades are master codes; the label is read from the master. */
type Template = [rank: string, count: number, cocGrade?: string][];
const DEEP_SEA: Template = [['MASTER', 1, 'MASTER'], ['CHIEF_OFFICER', 1, 'CHIEF_MATE'], ['SECOND_OFFICER', 1, 'OOW_NAV'], ['THIRD_OFFICER', 1, 'OOW_NAV'], ['CHIEF_ENGINEER', 1, 'CHIEF_ENGINEER'], ['SECOND_ENGINEER', 1, 'SECOND_ENGINEER'], ['THIRD_ENGINEER', 1, 'OOW_ENG'], ['AB', 3], ['OS', 1], ['OILER', 2], ['COOK', 1]];
const TEMPLATES: Record<string, Template> = {
  CONT: [...DEEP_SEA, ['ETO', 1, 'ETO']],
  TANK: [...DEEP_SEA, ['ETO', 1, 'ETO'], ['FITTER', 1], ['OS', 1]],
  BULK: [...DEEP_SEA, ['OS', 1]],
  RORO: [...DEEP_SEA, ['ETO', 1, 'ETO']],
  OSV: [['MASTER', 1, 'MASTER'], ['CHIEF_OFFICER', 1, 'CHIEF_MATE'], ['CHIEF_ENGINEER', 1, 'CHIEF_ENGINEER'], ['SECOND_ENGINEER', 1, 'SECOND_ENGINEER'], ['AB', 2], ['COOK', 1]],
  GEN: [['MASTER', 1, 'MASTER'], ['CHIEF_OFFICER', 1, 'CHIEF_MATE'], ['SECOND_OFFICER', 1, 'OOW_NAV'], ['CHIEF_ENGINEER', 1, 'CHIEF_ENGINEER'], ['SECOND_ENGINEER', 1, 'SECOND_ENGINEER'], ['AB', 2], ['OS', 1], ['OILER', 1], ['COOK', 1]],
};
/** The scale a type sails under: several rows may name the same rank, and the scale carries the sum. */
function scaleRows(type: string, rankLabel: (code: string) => string): WorldManningRow[] {
  const t = TEMPLATES[type] ?? TEMPLATES.GEN; const merged = new Map<string, WorldManningRow>();
  for (const [rankCode, count, cocGrade] of t) {
    const row = merged.get(rankCode) ?? { rankCode, rank: rankLabel(rankCode), count: 0, cocGrade: cocGrade ?? '', notes: '' };
    row.count += count; merged.set(rankCode, row);
  }
  return [...merged.values()];
}

const FOREIGN: [string, number][] = [['Philippines', 30], ['India', 26], ['Indonesia', 12], ['Ukraine', 8], ['Bangladesh', 8], ['Pakistan', 6], ['Egypt', 6], ['Sri Lanka', 4]];
const ISO2: Record<string, string> = { Philippines: 'PH', India: 'IN', Indonesia: 'ID', Ukraine: 'UA', Bangladesh: 'BD', Pakistan: 'PK', Egypt: 'EG', 'Sri Lanka': 'LK', Nepal: 'NP' };
const CITIES: Record<string, string[]> = { Philippines: ['Manila', 'Cebu', 'Iloilo'], India: ['Mumbai', 'Chennai', 'Kochi'], Indonesia: ['Jakarta', 'Surabaya'], Ukraine: ['Odesa', 'Mykolaiv'], Bangladesh: ['Chittagong', 'Dhaka'], Pakistan: ['Karachi'], Egypt: ['Alexandria', 'Port Said'], 'Sri Lanka': ['Colombo', 'Galle'] };

interface Person { familyName: string; givenNames: string; nationality: string; dob: string; pob: string; gender: 'M' | 'F'; idType: string; idNumber: string; idExpiry: string | null; cdcNo: string; rankCode: string }

export function buildMet(rng: Prng, profile: string, companies: WorldCompany[], vessels: WorldVessel[], seafarers: WorldSeafarer[], portCalls: WorldPortCall[], licences: WorldLicence[], lookups: WorldLookup[], now: Date) {
  const j = getJurisdiction(profile); const ae = j.code === 'AE';
  const label = (category: string, code: string) => lookups.find((l) => l.category === category && l.code === code)?.label ?? code;
  const programmeMeta = (code: string) => (lookups.find((l) => l.category === 'metProgramme' && l.code === code)?.meta ?? {}) as { regulation?: string; hours?: number };

  /* ---------------------------------------------------------------- the MET register --- */
  const providers = companies.filter((c) => !c.real && c.types.includes('TRAINING_INSTITUTE'));
  const metInstitutions: WorldMetInstitution[] = providers.map((c, i) => {
    const accreditation = licences.find((l) => l.subjectId === c.id && l.entityType === 'MET_INSTITUTION_ACCREDITATION') ?? null;
    const academy = c.category === 'INSTITUTE';
    const until = accreditation?.expiryDate ? new Date(accreditation.expiryDate).getTime() : null;
    const accreditationStatus: WorldMetInstitution['accreditationStatus'] = !accreditation ? 'NONE'
      : accreditation.status === 'ISSUED' ? (until != null && until < now.getTime() ? 'EXPIRED' : until != null && until < now.getTime() + 120 * D ? 'DUE' : 'CURRENT')
      : accreditation.status === 'SUSPENDED' ? 'SUSPENDED' : accreditation.status === 'REVOKED' ? 'WITHDRAWN' : 'NONE';
    return {
      id: stableId('met', c.code), companyId: c.id, code: c.code, name: c.name, nameAr: c.nameAr ?? '', institutionType: academy ? 'ACADEMY' : 'TRAINING_CENTRE',
      city: c.address.split(',').pop()?.trim() ?? '', address: c.address, contactName: c.contactName, contactEmail: c.contactEmail, contactPhone: c.contactPhone,
      status: c.status === 'SUSPENDED' ? 'SUSPENDED' : c.status === 'INACTIVE' || c.status === 'BLACKLISTED' ? 'CLOSED' : 'ACTIVE',
      accreditationInstrumentId: accreditation?.id ?? null, accreditationInstrumentNo: accreditation?.licenseNo ?? '',
      accreditationStatus, accreditedFrom: accreditation?.issueDate ?? null, accreditedUntil: accreditation?.expiryDate ?? null,
      accreditationCycleNo: accreditation ? 1 + accreditation.history.filter((h) => h.from === 'ISSUED' && h.to === 'ISSUED').length : 0,
      instructors: academy ? 24 + i : 6 + i, capacity: academy ? 320 : 60, simulators: academy ? ['Full-mission bridge', 'Engine room', 'GMDSS', 'Liquid cargo handling'] : ['GMDSS'],
      qualitySystem: academy ? 'ISO 9001:2015 — certified; STCW I/8 quality standards system evaluated' : 'STCW I/8 quality standards system — internal',
      establishedOn: dateOnly(Date.UTC(academy ? 2009 : 2016, 3 + i, 12)), remarks: academy ? 'Foundation programmes for deck and engine officers; short courses for ratings.' : 'Short-course provider attached to a recruitment and placement service.',
    };
  });
  const metProgrammes: WorldMetProgramme[] = [];
  const catalogue: Record<'ACADEMY' | 'TRAINING_CENTRE', [string, WorldMetProgramme['status']][]> = {
    ACADEMY: [['DECK_OOW', 'APPROVED'], ['ENGINE_OOW', 'APPROVED'], ['BST', 'APPROVED'], ['AFF', 'APPROVED'], ['MFA', 'APPROVED'], ['PSCRB', 'APPROVED'], ['SSO', 'APPROVED'], ['GMDSS_GOC', 'APPROVED'], ['ECDIS', 'APPROVED'], ['BRM', 'PENDING'], ['TANKER_OIL_ADV', 'SUSPENDED'], ['ERM', 'WITHDRAWN']],
    TRAINING_CENTRE: [['BST', 'APPROVED'], ['AFF', 'APPROVED'], ['MFA', 'APPROVED'], ['SSO', 'PENDING']],
  };
  let seq = 0;
  for (const inst of metInstitutions) {
    const approval = licences.find((l) => l.subjectId === inst.companyId && l.entityType === 'MET_PROGRAMME_APPROVAL') ?? null;
    catalogue[inst.institutionType as 'ACADEMY' | 'TRAINING_CENTRE'].forEach(([code, status], k) => {
      seq += 1;
      const meta = programmeMeta(code); const foundation = code === 'DECK_OOW' || code === 'ENGINE_OOW';
      const approvedOn = status === 'PENDING' ? null : new Date(now.getTime() - (400 + k * 37 + seq * 11) * D);
      const linked = k === 0 && approval && approval.status === 'ISSUED' ? approval : null;
      metProgrammes.push({
        id: stableId('metprog', `${inst.code}:${code}`), institutionId: inst.id, programme: code, title: label('metProgramme', code), regulation: meta.regulation ?? '',
        seatsPerIntake: foundation ? 40 : code === 'GMDSS_GOC' || code === 'ECDIS' ? 12 : 20, intakesPerYear: foundation ? 1 : code.startsWith('GMDSS') ? 6 : 10,
        status, approvalNo: linked ? linked.licenseNo : approvedOn ? `PA-${approvedOn.getUTCFullYear()}-${String(seq).padStart(4, '0')}` : '', instrumentId: linked?.id ?? null,
        approvedOn: approvedOn ? iso(approvedOn) : null, expiresOn: approvedOn ? iso(approvedOn.getTime() + 5 * 365 * D) : null,
        remarks: status === 'SUSPENDED' ? 'Simulator time per candidate below the approved syllabus — suspended pending a follow-up audit' : status === 'WITHDRAWN' ? 'Withdrawn at the institution\'s request' : status === 'PENDING' ? 'Application under review — syllabus and instructor qualifications received' : '',
      });
    });
  }

  /* ------------------------------------------------------------- safe manning scales --- */
  const fleet = vessels.filter((v) => !v.real && v.status === 'ACTIVE');
  const manningScales: WorldManningScale[] = fleet.map((v, i) => {
    const msmd = licences.find((l) => l.subjectId === v.id && l.entityType === 'MINIMUM_SAFE_MANNING_DOCUMENT') ?? null;
    return {
      id: stableId('manning', v.imo), vesselId: v.id, vesselName: v.name, imo: v.imo, msmdNo: msmd?.licenseNo ?? '', instrumentId: msmd?.id ?? null, issuedOn: msmd?.issueDate ?? null,
      tradingArea: v.type === 'OSV' ? 'GULF' : v.type === 'GEN' && i % 3 === 0 ? 'NEAR_COASTAL' : 'UNLIMITED', rows: scaleRows(v.type, (code) => label('seafarerRank', code)),
      remarks: msmd ? 'Read from the minimum safe manning document on the instrument register' : 'Scale recorded by the flag desk — no minimum safe manning document on the register yet',
    };
  });
  const scaleOf = new Map(manningScales.map((s) => [s.vesselId, s]));

  /* ------------------------------------------------------------------- crew lists --- */
  const recent = portCalls
    .filter((p) => scaleOf.has(p.vesselId) && p.status !== 'CANCELLED' && p.status !== 'ANNOUNCED' && new Date(p.eta).getTime() >= now.getTime() - 150 * D)
    .sort((a, b) => b.eta.localeCompare(a.eta)).slice(0, 40);
  const byVessel = new Map(fleet.map((v) => [v.id, v]));
  const person = (r: Prng, nationality: string, rankCode: string, k: number): Person => {
    const pool = namePoolFor(nationality); const familyName = r.pick(pool.last); const givenNames = `${r.pick(pool.first)}${r.chance(0.4) ? ` ${r.pick(pool.first)}` : ''}`;
    const age = /MASTER|CHIEF/.test(rankCode) ? r.int(36, 58) : /OFFICER|ENGINEER|ETO/.test(rankCode) ? r.int(26, 50) : r.int(21, 54);
    const dob = dateOnly(Date.UTC(now.getUTCFullYear() - age, r.int(0, 11), r.int(1, 28)));
    const iso2 = ISO2[nationality] ?? 'XX'; const idNumber = `${iso2}${String(3000000 + r.int(0, 6999999)).padStart(7, '0')}`;
    // a few travel on a passport that has already lapsed, which the check has to notice
    const expiry = r.chance(0.06) ? now.getTime() - r.int(10, 200) * D : now.getTime() + r.int(200, 3000) * D;
    return { familyName, givenNames, nationality, dob, pob: r.pick(CITIES[nationality] ?? ['—']), gender: r.chance(0.94) ? 'M' : 'F', idType: 'Passport', idNumber, idExpiry: iso(expiry), cdcNo: r.chance(0.7) ? `${iso2}-SB-${String(100000 + r.int(0, 899999))}` : '', rankCode: rankCode + (k ? '' : '') };
  };
  /* Each ship keeps a stable complement of foreign crew, so the same people appear call after call and the
   * ledger sees them more than once — which is the whole point of a ledger. */
  const complements = new Map<string, Person[]>();
  const complementOf = (v: WorldVessel): Person[] => {
    if (!complements.has(v.id)) {
      const r = rng.fork(`complement:${v.imo}`); const out: Person[] = [];
      for (const row of scaleOf.get(v.id)!.rows) for (let k = 0; k < row.count + 1; k++) out.push(person(r, r.weighted(FOREIGN), row.rankCode, k));
      complements.set(v.id, out);
    }
    return complements.get(v.id)!;
  };
  const rankOf = (code: string) => label('seafarerRank', code);
  const unnumbered: WorldCrewList[] = recent.map((call, i) => {
    const v = byVessel.get(call.vesselId)!; const scale = scaleOf.get(v.id)!; const r = rng.fork(`crewlist:${call.vcn}`);
    const date = call.ata ?? call.eta; const rows: WorldCrewRow[] = [];
    // the national register's people aboard on the day: those with a tour on this ship spanning it
    const aboard = seafarers.filter((s) => s.seaService.some((t) => t.vesselId === v.id && t.from <= date && t.to >= date));
    for (const s of aboard) {
      const [givenNames, ...rest] = s.name.split(' '); const national = s.nationality === j.name;
      rows.push({ seq: rows.length + 1, familyName: rest.join(' ') || givenNames, givenNames, rankCode: '', rank: s.rank, nationality: s.nationality, dob: s.dob.slice(0, 10), pob: national ? (ae ? 'Abu Dhabi' : 'Mumbai') : '—', gender: 'M',
        idType: national ? s.seafarerIdLabel : 'Passport', idNumber: national ? s.seafarerId : s.nationalId, idExpiry: iso(now.getTime() + 900 * D), cdcNo: s.cdcNo, seafarerId: s.id });
    }
    // fill the scale from the ship's complement; every sixth list sails one short somewhere, which the check has to say
    const short = i % 6 === 5 ? scale.rows[r.int(0, scale.rows.length - 1)].rankCode : '';
    const counted = new Map<string, number>(); for (const row of rows) { const code = codeForLabel(row.rank, lookups); counted.set(code, (counted.get(code) ?? 0) + 1); }
    for (const sr of scale.rows) {
      const need = sr.count - (counted.get(sr.rankCode) ?? 0) - (sr.rankCode === short ? 1 : 0);
      const pool = complementOf(v).filter((p) => p.rankCode === sr.rankCode);
      for (let k = 0; k < need && k < pool.length; k++) {
        const p = pool[k];
        rows.push({ seq: rows.length + 1, familyName: p.familyName, givenNames: p.givenNames, rankCode: sr.rankCode, rank: rankOf(sr.rankCode), nationality: p.nationality, dob: p.dob, pob: p.pob, gender: p.gender, idType: p.idType, idNumber: p.idNumber, idExpiry: p.idExpiry, cdcNo: p.cdcNo, seafarerId: null });
      }
    }
    // twice, a national of the flag who is not on the register at all — the check is expected to flag it
    if (i === 2 || i === 9) {
      const pool = namePoolFor(j.name);
      rows.push({ seq: rows.length + 1, familyName: r.pick(pool.last), givenNames: r.pick(pool.first), rankCode: 'OS', rank: rankOf('OS'), nationality: j.name, dob: dateOnly(Date.UTC(now.getUTCFullYear() - 23, 4, 9)), pob: ae ? 'Sharjah' : 'Kochi', gender: 'M', idType: j.identity.nationalIdLabel, idNumber: ae ? `784-2003-${String(1000000 + i * 7919).slice(0, 7)}-${i % 10} (sample)` : `AAAP${String.fromCharCode(65 + i)}${1100 + i}X (sample)`, idExpiry: iso(now.getTime() + 1200 * D), cdcNo: '', seafarerId: null });
    }
    for (const row of rows) if (!row.rankCode) row.rankCode = codeForLabel(row.rank, lookups);
    const defective = !!short || i === 2 || i === 9 || i % 10 === 7;
    const ageDays = (now.getTime() - new Date(date).getTime()) / D;
    return {
      id: stableId('crewlist', call.vcn), number: '', vcn: call.vcn, portCallId: call.id, vesselId: v.id, vesselName: v.name, imo: v.imo, movement: 'ARRIVAL', date,
      source: r.weighted([['MSW', 50], ['AGENT_PORTAL', 30], ['FAL_EDI', 15], ['AGENT_UPLOAD', 5]]), agentCode: call.agentCode, submittedBy: `${call.agentCode.toLowerCase()}.ops@agent.example`,
      // the general declaration's crew count, which every tenth list gets wrong
      declaredCrew: rows.length + (i % 10 === 7 ? 1 : 0), rows, remarks: '',
      status: ageDays > 14 ? (defective ? 'QUERIED' : 'CLEARED') : 'CHECKED',
    };
  });
  // numbered in the order the desk received them: one series a year, `CL-<year>-<sequence>`
  const series = new Map<number, number>();
  const crewLists: WorldCrewList[] = [...unnumbered].sort((a, b) => a.date.localeCompare(b.date)).map((l) => {
    const year = new Date(l.date).getUTCFullYear(); const n = (series.get(year) ?? 0) + 1; series.set(year, n);
    return { ...l, number: `CL-${year}-${String(n).padStart(4, '0')}` };
  });
  return { metInstitutions, metProgrammes, manningScales, crewLists };
}

const codeForLabel = (rankLabel: string, lookups: WorldLookup[]) => lookups.find((l) => l.category === 'seafarerRank' && l.label === rankLabel)?.code ?? '';
