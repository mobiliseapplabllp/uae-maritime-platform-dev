import { Prng, stableId } from './prng';

export interface WorldVessel { id: string; name: string; imo: string; mmsi: string; callSign: string; flag: string; type: string; built: number; dwt: number; grt: number; loa: number; beam: number; maxDraft: number; owner: string; operator: string; manager: string; agentCode: string; classSociety: string; teuCapacity: number | null; liner: boolean; real: boolean; status: 'ACTIVE' | 'INACTIVE' }
/** IMO check digit: sum of the first six digits weighted 7..2, modulo 10. */
export const imoCheck = (six: string) => String(six.split('').reduce((s, d, i) => s + Number(d) * (7 - i), 0) % 10);
export const makeImo = (n: number) => { const six = String(970000 + (n % 29999)).padStart(6, '0'); return `${six}${imoCheck(six)}`; };
/** The eight documented real liner callers appear for schedule realism only and carry clean records everywhere. */
export const REAL_LINERS: [string, string][] = [['MSC Anna', 'CONT'], ['APL Raffles', 'CONT'], ['MSC Al Rawdah', 'CONT'], ['Maersk Kensington', 'CONT'], ['Maersk Chicago', 'CONT'], ['CMA CGM Ural', 'CONT'], ['ESL Wafa', 'CONT'], ['Folk Jazan', 'CONT']];
export const isRealLiner = (name: string) => REAL_LINERS.some(([n]) => n === name);

const FICTIONAL: [string, string, string][] = [
  ['Al Dhafra Pearl', 'BULK', 'AE'], ['Khor Fakkan Star', 'CONT', 'AE'], ['Ruwais Spirit', 'TANK', 'AE'], ['Liwa Horizon', 'TANK', 'AE'], ['Saadiyat Breeze', 'GEN', 'AE'],
  ['Hatta Crest', 'BULK', 'PA'], ['Jazirat Voyager', 'CONT', 'LR'], ['Mina Zayed Trader', 'GEN', 'AE'], ['Falaj Grace', 'RORO', 'MH'], ['Sir Bani Yas', 'OSV', 'AE'],
  ['Musandam Wave', 'TANK', 'MT'], ['Dibba Fortune', 'BULK', 'PA'], ['Kalba Mariner', 'CONT', 'SG'], ['Al Ain Oasis', 'GEN', 'AE'], ['Barakah Light', 'TANK', 'AE'],
  ['Corniche Navigator', 'CONT', 'HK'], ['Sharjah Sunrise', 'BULK', 'AE'], ['Umm Al Quwain Tide', 'GEN', 'AE'], ['Ajman Pioneer', 'RORO', 'PA'], ['Fujairah Dawn', 'TANK', 'AE'],
  ['Ghantoot Runner', 'OSV', 'AE'], ['Marawah Endeavour', 'BULK', 'LR'], ['Delma Island', 'GEN', 'AE'],
];
const AGENTS = ['GSS', 'ABM', 'OAP', 'WCM', 'SSL', 'TMA'];
const CLASS = ['DNV', 'LR', 'ABS', 'BV', 'ClassNK', 'RINA', 'TASNEEF'];

export function buildVessels(rng: Prng, profile: string): WorldVessel[] {
  const out: WorldVessel[] = [];
  const mk = (name: string, type: string, flag: string, real: boolean, i: number): WorldVessel => {
    const teu = type === 'CONT' ? rng.pick([2500, 4500, 8500, 13000, 15000]) : null;
    const loa = type === 'CONT' ? (teu! > 9000 ? rng.int(330, 400) : rng.int(210, 300)) : type === 'TANK' ? rng.int(180, 330) : type === 'BULK' ? rng.int(180, 290) : type === 'OSV' ? rng.int(60, 90) : rng.int(120, 220);
    const grt = Math.round(loa * loa * rng.int(1, 2) * 0.9);
    return {
      id: stableId('vessel', name), name, imo: makeImo(i * 97 + 13), mmsi: String(470000000 + i * 1237), callSign: `A6E${String.fromCharCode(65 + (i % 26))}${i}`,
      flag: profile === 'AE' ? flag : flag === 'AE' ? 'IN' : flag, type, built: rng.int(2005, 2023), dwt: Math.round(grt * 1.4), grt, loa, beam: Math.round(loa / 6.5), maxDraft: Math.round((loa / 22) * 10) / 10,
      owner: real ? '—' : `${name.split(' ')[0]} Shipping Holdings`, operator: real ? '—' : `${name.split(' ')[0]} Marine Operations`, manager: real ? '—' : rng.pick(['Gulf Ship Management', 'Blue Water Managers', 'Pearl Fleet Services']),
      agentCode: rng.pick(AGENTS), classSociety: rng.pick(CLASS), teuCapacity: teu, liner: real, real, status: 'ACTIVE',
    };
  };
  REAL_LINERS.forEach(([n, t], i) => out.push(mk(n, t, rng.pick(['PA', 'LR', 'DK', 'MT', 'SG']), true, i)));
  FICTIONAL.forEach(([n, t, f], i) => out.push(mk(n, t, f, false, i + 8)));
  return out;
}
