import { getJurisdiction, SEAFARER_RANKS, SEAFARER_CERT_TYPES } from '@maritime/contracts';
import { Prng, D, HIST_START, stableId, iso } from './prng';
import { NAME_POOLS } from './people';
import type { WorldVessel } from './vessels';

export type SeafarerRank = (typeof SEAFARER_RANKS)[number];
export interface WorldSeafarerCert { certType: string; grade: string; number: string; issuer: string; issueDate: string; expiryDate: string; remarks: string }
export interface WorldSeaService { vesselId: string | null; vesselName: string; imo: string; rank: string; from: string; to: string; verified: boolean; remarks: string }
export interface WorldSeafarer {
  id: string; cdcNo: string; seafarerId: string; seafarerIdLabel: string; nationalId: string; nationalIdLabel: string; name: string; dob: string; nationality: string; rank: SeafarerRank;
  phone: string; email: string; status: 'ACTIVE' | 'SHORE_LEAVE' | 'SIGNED_OFF' | 'SUSPENDED'; currentVesselId: string | null; currentVesselName: string | null; signedOnAt: string | null;
  certificates: WorldSeafarerCert[]; seaService: WorldSeaService[]; remarks: string;
}

const NATIONALITIES: Record<string, [string, number][]> = {
  AE: [['India', 32], ['Philippines', 20], ['United Arab Emirates', 8], ['Pakistan', 10], ['Egypt', 8], ['Bangladesh', 8], ['Indonesia', 7], ['Ukraine', 7]],
  IN: [['India', 88], ['Nepal', 4], ['Bangladesh', 4], ['Sri Lanka', 4]],
};
// crews are named from the profile pools; nationalities the pools do not cover get a small supplement
const EXTRA: Record<string, { first: string[]; last: string[] }> = {
  Philippines: { first: ['Jose', 'Ramon', 'Marlon', 'Rodel', 'Arnel', 'Joel', 'Reynaldo', 'Edgar'], last: ['Santos', 'Reyes', 'Dela Cruz', 'Bautista', 'Villanueva', 'Garcia', 'Mendoza', 'Aquino'] },
  Indonesia: { first: ['Budi', 'Agus', 'Dedi', 'Rizal', 'Wawan', 'Hendra'], last: ['Santoso', 'Wijaya', 'Saputra', 'Pratama', 'Hidayat', 'Nugroho'] },
  Ukraine: { first: ['Oleksandr', 'Andriy', 'Serhiy', 'Dmytro', 'Yuriy', 'Volodymyr'], last: ['Shevchenko', 'Kovalenko', 'Bondarenko', 'Tkachenko', 'Melnyk', 'Kravchenko'] },
  Pakistan: { first: ['Imran', 'Bilal', 'Kashif', 'Tariq', 'Adnan', 'Waqar'], last: ['Khan', 'Malik', 'Hussain', 'Siddiqui', 'Baig', 'Qureshi'] },
  Egypt: { first: ['Mahmoud', 'Mostafa', 'Khaled', 'Tamer', 'Hossam', 'Karim'], last: ['Abdel Rahman', 'El Sayed', 'Farouk', 'Mansour', 'Hassan', 'Ibrahim'] },
  Bangladesh: { first: ['Rafiqul', 'Jahangir', 'Shahidul', 'Anwar', 'Mizanur', 'Abdul'], last: ['Islam', 'Hossain', 'Rahman', 'Miah', 'Chowdhury', 'Uddin'] },
  Nepal: { first: ['Tenzin', 'Ramesh', 'Bikash'], last: ['Dorjee', 'Gurung', 'Thapa'] },
  'Sri Lanka': { first: ['Nuwan', 'Kasun', 'Chaminda'], last: ['Perera', 'Fernando', 'Silva'] },
};
const poolFor = (nat: string) => EXTRA[nat] ?? (nat === 'United Arab Emirates' ? { first: NAME_POOLS.AE.first.slice(0, 20), last: NAME_POOLS.AE.last.slice(0, 15) } : NAME_POOLS.IN);
const RANK_WEIGHTS: [SeafarerRank, number][] = [['Master', 6], ['Chief Officer', 6], ['Second Officer', 8], ['Third Officer', 8], ['Chief Engineer', 6], ['Second Engineer', 6], ['Third Engineer', 8], ['Fourth Engineer', 6],
  ['Electro-Technical Officer', 5], ['Bosun', 6], ['Able Seaman', 16], ['Ordinary Seaman', 10], ['Oiler', 8], ['Fitter', 5], ['Cook', 6], ['Steward', 5], ['Deck Cadet', 5], ['Engine Cadet', 5]];
export const isOfficerRank = (r: string) => /Master|Officer|Engineer/.test(r) && !/Cadet/.test(r);
const isDeck = (r: string) => /Master|Chief Officer|Second Officer|Third Officer/.test(r);
const gradeFor = (rank: string, i: number) => (/Engineer/.test(rank) ? `MEO Class ${rank.startsWith('Chief') ? '1' : '2'}` : rank === 'Master' ? 'Master (FG)' : `Class ${2 + (i % 2)}`);

/** ~150 seafarers on the fictional fleet: ranks from the contracts, sea service walked back to 2023, about 55% signed on now. */
export function buildSeafarers(rng: Prng, profile: string, vessels: WorldVessel[], now: Date, count = 150): WorldSeafarer[] {
  const j = getJurisdiction(profile); const ae = j.code === 'AE';
  const fleet = vessels.filter((v) => !v.real); const issuer = ae ? 'Ministry of Energy and Infrastructure — Maritime Sector' : 'DG Shipping, India';
  const [CoC, GMDSS, MED, BST, AFF, MFA, SSO, TANK, CDC] = SEAFARER_CERT_TYPES;
  const out: WorldSeafarer[] = [];
  for (let i = 0; i < count; i++) {
    const nationality = rng.weighted(NATIONALITIES[j.code] ?? NATIONALITIES.AE); const pool = poolFor(nationality);
    const name = `${rng.pick(pool.first)} ${rng.pick(pool.last)}`; const rank = rng.weighted(RANK_WEIGHTS);
    const officer = isOfficerRank(rank); const cadet = /Cadet/.test(rank);
    const age = cadet ? rng.int(19, 24) : officer ? rng.int(30, 58) : rng.int(22, 55);
    const onboard = i % 20 < 11; const vessel = onboard ? rng.pick(fleet) : null;
    const plan = [MED, BST, CDC, ...(officer ? [CoC, AFF, MFA] : []), ...(officer && isDeck(rank) ? [GMDSS] : []), ...(/Master|Chief Officer/.test(rank) ? [SSO] : []), ...(vessel?.type === 'TANK' || i % 4 === 0 ? [TANK] : [])];
    const certificates: WorldSeafarerCert[] = plan.map((certType, k) => {
      let expiry = new Date(now.getTime() + (90 + ((i * 11 + k * 71) % 900)) * D);
      if (certType === MED && i % 23 === 3) expiry = new Date(now.getTime() + 14 * D);   // medical expiring
      if (certType === BST && i % 29 === 7) expiry = new Date(now.getTime() - 20 * D);   // BST lapsed
      if (certType === CoC && i % 31 === 11) expiry = new Date(now.getTime() + 21 * D);  // competency revalidation due
      const years = certType === MED ? 2 : certType === CDC ? 10 : 5; // MLC A1.2 / STCW A-I/9: seafarer medical certificates run two years at most
      return { certType, grade: certType === CoC ? gradeFor(rank, i) : '', number: `${certType.split(' ').map((w) => w[0]).join('')}-${20100 + i * 17 + k}`, issuer, issueDate: iso(expiry.getTime() - years * 365 * D), expiryDate: iso(expiry), remarks: '' };
    });
    // walk backward contract by contract until the service history reaches the start of the record
    const seaService: WorldSeaService[] = [];
    let cursor = now.getTime() - (onboard ? rng.int(10, 160) : 30 + rng.int(0, 60)) * D; const signedOnAt = onboard ? cursor : null;
    if (onboard && vessel) { seaService.push({ vesselId: vessel.id, vesselName: vessel.name, imo: vessel.imo, rank, from: iso(cursor), to: iso(now), verified: false, remarks: 'Current tour' }); cursor -= rng.int(20, 90) * D; }
    for (let k = 0; k < 12 && cursor > HIST_START.getTime(); k++) {
      const to = cursor; const from = to - rng.int(120, 260) * D; const served = rng.pick(fleet);
      seaService.push({ vesselId: served.id, vesselName: served.name, imo: served.imo, rank, from: iso(from), to: iso(to), verified: rng.chance(0.7), remarks: k === 0 ? 'Verified against crew list and movement records' : '' });
      cursor = from - rng.int(20, 90) * D;
    }
    const national = nationality === j.name;
    out.push({
      id: stableId('seafarer', `${j.code}:${i}`), cdcNo: ae ? `AUH-${52000 + i * 37}` : `MUM-${52000 + i * 37}`,
      seafarerId: ae ? `SID-784-${String(100000 + i * 911).slice(0, 6)}` : `8INL${3200 + i * 13}`, seafarerIdLabel: j.identity.seafarerIdLabel,
      nationalId: national ? (ae ? `784-${1968 + (i % 32)}-${String(1000000 + i * 7919).slice(0, 7)}-${i % 10} (sample)` : `AAAP${String.fromCharCode(65 + (i % 26))}${1000 + i}X (sample)`) : `P-${nationality.slice(0, 3).toUpperCase()}-${String(4000000 + i * 3571).slice(0, 7)} (sample)`,
      nationalIdLabel: national ? j.identity.nationalIdLabel : 'Passport', name, dob: iso(Date.UTC(now.getUTCFullYear() - age, (i * 5) % 12, 3 + (i % 25))), nationality, rank,
      phone: ae ? `+971 5${i % 9} ${String(2000000 + i * 991177).slice(0, 3)} ${String(2000000 + i * 991177).slice(3, 7)}` : `+91 98${String(20000000 + i * 991177).slice(0, 8)}`,
      email: `${name.toLowerCase().replace(/[^a-z]+/g, '.')}${i}@crew.example`,
      status: i % 50 === 49 ? 'SUSPENDED' : onboard ? 'ACTIVE' : i % 3 === 0 ? 'SHORE_LEAVE' : 'SIGNED_OFF',
      currentVesselId: vessel?.id ?? null, currentVesselName: vessel?.name ?? null, signedOnAt: signedOnAt ? iso(signedOnAt) : null, certificates, seaService, remarks: '',
    });
  }
  return out;
}
