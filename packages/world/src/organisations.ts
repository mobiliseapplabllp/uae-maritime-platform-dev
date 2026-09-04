import { getJurisdiction } from '@maritime/contracts';
import { Prng, stableId } from './prng';

export interface WorldCompany { id: string; code: string; name: string; category: 'AGENCY' | 'TERMINAL_OPERATOR' | 'SERVICE_PROVIDER' | 'SUPPLIER' | 'INSTITUTE'; types: string[]; contactName: string; contactEmail: string; contactPhone: string; taxId: string; registrationNo: string; status: 'ACTIVE' | 'SUSPENDED' | 'BLACKLISTED' | 'INACTIVE'; onboardedAt: string; rating: number; real: boolean; address: string }
export interface WorldBerth { id: string; code: string; name: string; terminal: string; berthType: 'CONTAINER' | 'BULK' | 'MULTIPURPOSE' | 'LIQUID' | 'RORO' | 'SPM'; loaMax: number; draftMax: number; status: 'OPERATIONAL' | 'MAINTENANCE' }

export function buildCompanies(rng: Prng, profile: string, now: Date): WorldCompany[] {
  const j = getJurisdiction(profile); const ae = j.code === 'AE';
  const defs: [string, string, WorldCompany['category'], string[]][] = ae ? [
    ['GSS', 'Gulf Star Shipping Agency LLC', 'AGENCY', ['SHIPPING_AGENCY']], ['ABM', 'Al Bahri Marine Services', 'AGENCY', ['SHIPPING_AGENCY', 'SHIP_CHANDLER']],
    ['OAP', 'Oceanic Agencies FZE', 'AGENCY', ['SHIPPING_AGENCY']], ['WCM', 'West Coast Maritime Services', 'AGENCY', ['SHIPPING_AGENCY']],
    ['SSL', 'Seven Seas Logistics LLC', 'AGENCY', ['SHIPPING_AGENCY', 'STEVEDORE']], ['TMA', 'Trident Marine Agencies', 'AGENCY', ['SHIPPING_AGENCY']],
    ['CTO', 'Harbour Container Terminals LLC', 'TERMINAL_OPERATOR', ['STEVEDORE', 'PORT_FACILITY_ISPS']], ['BTO', 'West Basin Bulk Terminal Co.', 'TERMINAL_OPERATOR', ['STEVEDORE', 'PORT_FACILITY_ISPS']],
    ['LTO', 'Liquid Terminal Operations FZE', 'TERMINAL_OPERATOR', ['PORT_FACILITY_ISPS']], ['ABS', 'Al Barsha Bunkering Supplies', 'SUPPLIER', ['BUNKER_SUPPLIER']],
    ['NMC', 'Noor Marine Chandlers', 'SUPPLIER', ['SHIP_CHANDLER']], ['EDY', 'Emirates Dry Dock & Repairs', 'SERVICE_PROVIDER', ['REPAIR_YARD']],
    ['GCC', 'Gulf Compass Calibration Services', 'SERVICE_PROVIDER', ['COMPASS_CALIBRATION']], ['SLS', 'SafeLife LSA Servicing LLC', 'SERVICE_PROVIDER', ['LSA_SERVICING', 'FFA_SERVICING']],
    ['DMC', 'Deepwater Marine Contractors', 'SERVICE_PROVIDER', ['DIVING_CONTRACTOR']], ['PCS', 'Pearl Coast Surveyors', 'SERVICE_PROVIDER', ['MARINE_SURVEYOR', 'SMALL_VESSEL_SURVEY']],
    // Three licensed recruitment and placement services. One would have been enough to model a manning
    // agency; it takes more than one for "an agent sees their own crew and nobody else's" to be a claim the
    // register can be held to.
    ['MCA', 'Maritime Crewing Associates', 'SERVICE_PROVIDER', ['MANNING_AGENCY']],
    ['ANC', 'Anchor Crew Management LLC', 'SERVICE_PROVIDER', ['MANNING_AGENCY']],
    ['KRM', 'Khaleej Recruitment & Manning FZE', 'SERVICE_PROVIDER', ['MANNING_AGENCY', 'TRAINING_INSTITUTE']],
    ['AMI', 'Arabian Maritime Institute', 'INSTITUTE', ['TRAINING_INSTITUTE']],
  ] : [
    ['KSA', 'Harbour Shipping Agency', 'AGENCY', ['SHIPPING_AGENCY']], ['BMS', 'Bharat Marine Services', 'AGENCY', ['SHIPPING_AGENCY', 'SHIP_CHANDLER']],
    ['OAP', 'Oceanic Agencies Pvt Ltd', 'AGENCY', ['SHIPPING_AGENCY']], ['WCM', 'WestCoast Maritime Services', 'AGENCY', ['SHIPPING_AGENCY']],
    ['SSL', 'Seven Seas Logistics', 'AGENCY', ['SHIPPING_AGENCY', 'STEVEDORE']], ['TMA', 'Trident Marine Agencies', 'AGENCY', ['SHIPPING_AGENCY']],
    ['CTO', 'Harbour Container Terminals Ltd', 'TERMINAL_OPERATOR', ['STEVEDORE', 'PORT_FACILITY_ISPS']], ['BTO', 'West Basin Bulk Terminal Co.', 'TERMINAL_OPERATOR', ['STEVEDORE', 'PORT_FACILITY_ISPS']],
    ['LTO', 'Liquid Terminal Operations Ltd', 'TERMINAL_OPERATOR', ['PORT_FACILITY_ISPS']], ['ABS', 'Adarsh Bunkering Supplies', 'SUPPLIER', ['BUNKER_SUPPLIER']],
    ['NMC', 'Neptune Marine Chandlers', 'SUPPLIER', ['SHIP_CHANDLER']], ['EDY', 'Eastern Dry Dock & Repairs', 'SERVICE_PROVIDER', ['REPAIR_YARD']],
    ['GCC', 'Gulf Compass Calibration Services', 'SERVICE_PROVIDER', ['COMPASS_CALIBRATION']], ['SLS', 'SafeLife LSA Servicing', 'SERVICE_PROVIDER', ['LSA_SERVICING', 'FFA_SERVICING']],
    ['DMC', 'Deepwater Marine Contractors', 'SERVICE_PROVIDER', ['DIVING_CONTRACTOR']], ['PCS', 'Pearl Coast Surveyors', 'SERVICE_PROVIDER', ['MARINE_SURVEYOR', 'SMALL_VESSEL_SURVEY']],
    ['MCA', 'Maritime Crewing Associates', 'SERVICE_PROVIDER', ['MANNING_AGENCY']],
    ['ANC', 'Anchor Crew Management Pvt Ltd', 'SERVICE_PROVIDER', ['MANNING_AGENCY']],
    ['IMR', 'Indus Maritime Recruitment', 'SERVICE_PROVIDER', ['MANNING_AGENCY', 'TRAINING_INSTITUTE']],
    ['AMI', 'Coastal Maritime Institute', 'INSTITUTE', ['TRAINING_INSTITUTE']],
  ];
  const statuses: WorldCompany['status'][] = ['ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'ACTIVE', 'SUSPENDED', 'INACTIVE'];
  return defs.map(([code, name, category, types], i) => ({
    id: stableId('company', code), code, name, category, types,
    contactName: `${rng.pick(['Ahmed', 'Priya', 'Omar', 'Sana', 'Rahul', 'Layla'])} ${rng.pick(['Al Mansoori', 'Nair', 'Haddad', 'Patel', 'Khan'])}`,
    contactEmail: `ops@${code.toLowerCase()}.example`, contactPhone: ae ? `+971 4 ${String(2000000 + i * 4321).slice(0, 3)} ${String(2000000 + i * 4321).slice(3, 7)}` : `+91 2838 ${String(200000 + i * 4321).slice(0, 6)}`,
    taxId: ae ? `100${String(200000000 + i * 7919).slice(0, 9)}0003 (sample)` : `24XXXXX${String(1000 + i)}X1Z${i % 10} (sample)`,
    registrationNo: ae ? `CN-${String(1200000 + i * 131)} (sample)` : `U61100GJ20${String(10 + i)}PTC0${String(10000 + i * 97)} (sample)`,
    status: i < 9 ? 'ACTIVE' : statuses[(i * 7) % statuses.length], onboardedAt: new Date(now.getTime() - rng.int(200, 1300) * 86400000).toISOString().slice(0, 10),
    rating: Math.round((2.5 + rng.next() * 2.5) * 10) / 10, real: false, address: ae ? `${rng.pick(['Harbour Zone 1', 'Free Zone', 'Corniche Road', 'Industrial Area 3'])}, ${rng.pick(['Abu Dhabi', 'Dubai', 'Sharjah', 'Fujairah'])}` : `${rng.pick(['Port Road', 'SEZ Zone-4', 'Gate 4'])}, Harbour`,
  }));
}

export function buildBerths(): WorldBerth[] {
  const defs: [string, string, string, WorldBerth['berthType'], number, number][] = [
    ['CT1-1', 'Container Terminal 1 — Berth 1', 'Container Terminal 1', 'CONTAINER', 300, 14], ['CT1-2', 'Container Terminal 1 — Berth 2', 'Container Terminal 1', 'CONTAINER', 300, 14],
    ['CT3-1', 'Container Terminal 3 — Berth 1', 'Container Terminal 3', 'CONTAINER', 340, 15.5], ['CT3-2', 'Container Terminal 3 — Berth 2', 'Container Terminal 3', 'CONTAINER', 340, 15.5],
    ['CT4-1', 'Container Terminal 4 — Berth 1', 'Container Terminal 4', 'CONTAINER', 400, 16.5], ['CT4-2', 'Container Terminal 4 — Berth 2', 'Container Terminal 4', 'CONTAINER', 400, 16.5],
    ['CT5-1', 'Container Terminal 5 — Berth 1', 'Container Terminal 5', 'CONTAINER', 400, 17], ['CT5-2', 'Container Terminal 5 — Berth 2', 'Container Terminal 5', 'CONTAINER', 400, 17],
    ['MP-1', 'Multipurpose Berth 1', 'Multipurpose Terminal', 'MULTIPURPOSE', 230, 12], ['MP-2', 'Multipurpose Berth 2', 'Multipurpose Terminal', 'MULTIPURPOSE', 230, 12],
    ['MP-3', 'Multipurpose Berth 3', 'Multipurpose Terminal', 'MULTIPURPOSE', 230, 12], ['MP-4', 'Multipurpose Berth 4', 'Multipurpose Terminal', 'MULTIPURPOSE', 250, 13],
    ['WB-1', 'West Basin Bulk Berth 1', 'West Basin Bulk Terminal', 'BULK', 290, 16], ['WB-2', 'West Basin Bulk Berth 2', 'West Basin Bulk Terminal', 'BULK', 290, 16],
    ['WB-3', 'West Basin Bulk Berth 3', 'West Basin Bulk Terminal', 'BULK', 260, 14.5], ['WB-4', 'West Basin Bulk Berth 4', 'West Basin Bulk Terminal', 'BULK', 260, 14.5],
    ['LB-1', 'Liquid Berth 1', 'Liquid Terminal', 'LIQUID', 250, 14], ['LB-2', 'Liquid Berth 2', 'Liquid Terminal', 'LIQUID', 250, 14],
    ['LB-3', 'Liquid Berth 3', 'Liquid Terminal', 'LIQUID', 280, 15], ['LB-4', 'Liquid Berth 4', 'Liquid Terminal', 'LIQUID', 280, 15],
    ['RR-1', 'Ro-Ro Berth 1', 'Ro-Ro Terminal', 'RORO', 220, 11], ['RR-2', 'Ro-Ro Berth 2', 'Ro-Ro Terminal', 'RORO', 220, 11],
    ['SPM-1', 'Single Point Mooring 1', 'Offshore SPM', 'SPM', 350, 22], ['SPM-2', 'Single Point Mooring 2', 'Offshore SPM', 'SPM', 350, 22],
  ];
  return defs.map(([code, name, terminal, berthType, loaMax, draftMax], i) => ({ id: stableId('berth', code), code, name, terminal, berthType, loaMax, draftMax, status: i === 7 ? 'MAINTENANCE' : 'OPERATIONAL' }));
}
