import { getJurisdiction } from '@maritime/contracts';

export interface WorldLookup { category: string; code: string; label: string; labelAr?: string; meta: Record<string, unknown>; active: boolean }
const lk = (category: string, code: string, label: string, meta: Record<string, unknown> = {}, labelAr?: string): WorldLookup => ({ category, code, label, labelAr, meta, active: true });

export function buildLookups(profile: string): WorldLookup[] {
  const j = getJurisdiction(profile);
  const ae = j.code === 'AE';
  const out: WorldLookup[] = [
    lk('vesselType', 'CONT', 'Container Ship', {}, 'سفينة حاويات'), lk('vesselType', 'BULK', 'Bulk Carrier', {}, 'ناقلة بضائع سائبة'),
    lk('vesselType', 'TANK', 'Tanker', {}, 'ناقلة'), lk('vesselType', 'GEN', 'General Cargo', {}, 'بضائع عامة'),
    lk('vesselType', 'RORO', 'Ro-Ro / Car Carrier', {}, 'دحرجة'), lk('vesselType', 'OSV', 'Offshore Support Vessel', {}, 'سفينة دعم بحري'),
    lk('vesselType', 'FISH', 'Fishing Vessel', {}, 'سفينة صيد'), lk('vesselType', 'YACHT', 'Yacht / Pleasure Craft', {}, 'يخت'), lk('vesselType', 'TUG', 'Tug', {}, 'قاطرة'),
    lk('cargoType', 'CONTAINERS', 'Containers', { group: 'container', unit: 'TEU', mtFactor: 12 }),
    lk('cargoType', 'COAL', 'Thermal Coal', { group: 'dryBulk', unit: 'MT', mtFactor: 1 }),
    lk('cargoType', 'CRUDE', 'Crude Oil', { group: 'liquid', unit: 'MT', mtFactor: 1 }),
    lk('cargoType', 'POL', 'Petroleum Products', { group: 'liquid', unit: 'MT', mtFactor: 1 }),
    lk('cargoType', 'FERT', 'Fertilizer', { group: 'dryBulk', unit: 'MT', mtFactor: 1 }),
    lk('cargoType', 'GRAIN', 'Grain', { group: 'dryBulk', unit: 'MT', mtFactor: 1 }),
    lk('cargoType', 'STEEL', 'Steel Coils', { group: 'breakBulk', unit: 'MT', mtFactor: 1 }),
    lk('cargoType', 'EDIBLE', 'Edible Oil', { group: 'liquid', unit: 'MT', mtFactor: 1 }),
    lk('cargoType', 'AUTO', 'Automobiles', { group: 'roro', unit: 'UNITS', mtFactor: 1.5 }),
    lk('cargoType', 'PROJ', 'Project Cargo', { group: 'breakBulk', unit: 'MT', mtFactor: 1 }),
    lk('cargoType', 'LNG', 'LNG', { group: 'liquid', unit: 'MT', mtFactor: 1 }),
    lk('port', 'CNSHA', 'Shanghai', { country: 'China' }), lk('port', 'SGSIN', 'Singapore', { country: 'Singapore' }),
    lk('port', 'AEJEA', 'Jebel Ali', { country: 'United Arab Emirates' }), lk('port', 'AEKLF', 'Khor Fakkan', { country: 'United Arab Emirates' }),
    lk('port', 'AEFJR', 'Fujairah', { country: 'United Arab Emirates' }), lk('port', 'AEAUH', 'Abu Dhabi (Khalifa Port)', { country: 'United Arab Emirates' }),
    lk('port', 'AESHJ', 'Sharjah', { country: 'United Arab Emirates' }), lk('port', 'AERKT', 'Ras Al Khaimah', { country: 'United Arab Emirates' }),
    lk('port', 'SAJED', 'Jeddah', { country: 'Saudi Arabia' }), lk('port', 'SADMM', 'Dammam', { country: 'Saudi Arabia' }), lk('port', 'SARTA', 'Ras Tanura', { country: 'Saudi Arabia' }),
    lk('port', 'OMSLL', 'Salalah', { country: 'Oman' }), lk('port', 'OMSOH', 'Sohar', { country: 'Oman' }), lk('port', 'QAHMD', 'Hamad Port', { country: 'Qatar' }),
    lk('port', 'KWKWI', 'Kuwait', { country: 'Kuwait' }), lk('port', 'IQBSR', 'Basrah', { country: 'Iraq' }), lk('port', 'IRBND', 'Bandar Abbas', { country: 'Iran' }),
    lk('port', 'INNSA', 'Nhava Sheva', { country: 'India' }), lk('port', 'INMUN', 'Mundra', { country: 'India' }), lk('port', 'INCOK', 'Kochi', { country: 'India' }),
    lk('port', 'PKKHI', 'Karachi', { country: 'Pakistan' }), lk('port', 'LKCMB', 'Colombo', { country: 'Sri Lanka' }), lk('port', 'MYPKG', 'Port Klang', { country: 'Malaysia' }),
    lk('port', 'NLRTM', 'Rotterdam', { country: 'Netherlands' }), lk('port', 'DEHAM', 'Hamburg', { country: 'Germany' }), lk('port', 'EGPSD', 'Port Said', { country: 'Egypt' }),
    lk('port', 'KEMBA', 'Mombasa', { country: 'Kenya' }), lk('port', 'ZADUR', 'Durban', { country: 'South Africa' }), lk('port', 'AUHPT', 'Hay Point', { country: 'Australia' }),
    lk('port', 'IDJKT', 'Jakarta', { country: 'Indonesia' }), lk('port', 'KRPUS', 'Busan', { country: 'Korea' }),
  ];
  const agents: [string, string, string][] = ae
    ? [['GSS', 'Gulf Star Shipping Agency LLC', 'Port Users Building, Harbour Zone 1'], ['ABM', 'Al Bahri Marine Services', 'Industrial Area 3'], ['OAP', 'Oceanic Agencies FZE', 'Free Zone, Gate 4'],
       ['WCM', 'West Coast Maritime Services', 'Corniche Road'], ['SSL', 'Seven Seas Logistics LLC', 'Logistics Park, Zone 4'], ['TMA', 'Trident Marine Agencies', 'Harbour Road']]
    : [['KSA', 'Harbour Shipping Agency', 'Port User Building, Harbour 370421'], ['BMS', 'Bharat Marine Services', 'Industrial Estate, Zone-1'], ['OAP', 'Oceanic Agencies Pvt Ltd', 'Freight Village, Gate 4'],
       ['WCM', 'WestCoast Maritime Services', 'Bhuj Road, Harbour'], ['SSL', 'Seven Seas Logistics', 'SEZ Zone-4, Harbour'], ['TMA', 'Trident Marine Agencies', 'Coast Road, Harbour']];
  agents.forEach(([c, l, addr], i) => out.push(lk('agent', c, l, { address: addr, taxId: ae ? `1000${i + 1}${i + 2}${i + 3}00003 (sample)` : `24XXXXX${i + 1}${i + 1}${i + 1}${i + 1}X1Z${i} (sample)`, taxIdLabel: j.tax.registrationLabel })));
  out.push(
    lk('deficiencyCode', '01101', 'Ship certificates — missing / expired', { category: 'Certificates & Documentation' }),
    lk('deficiencyCode', '04103', 'Emergency generator inoperative', { category: 'Emergency Systems' }),
    lk('deficiencyCode', '07105', 'Fire-fighting equipment defective', { category: 'Fire Safety' }),
    lk('deficiencyCode', '10111', 'Nautical charts / publications not updated', { category: 'Safety of Navigation' }),
    lk('deficiencyCode', '11101', 'Lifeboat launching arrangement defective', { category: 'Life Saving Appliances' }),
    lk('deficiencyCode', '13101', 'Main engine — abnormal operation', { category: 'Propulsion & Machinery' }),
    lk('deficiencyCode', '14104', 'Oily-water separator / 15ppm alarm defective', { category: 'MARPOL Annex I' }),
    lk('deficiencyCode', '18203', 'Crew rest hours records incomplete', { category: 'MLC — Working Conditions' }),
    lk('actionCode', '10', 'Deficiency rectified'), lk('actionCode', '15', 'Rectify at next port'), lk('actionCode', '16', 'Rectify within 14 days'),
    lk('actionCode', '17', 'Rectify before departure'), lk('actionCode', '30', 'Detainable deficiency — ship detained'), lk('actionCode', '99', 'Other (specify)'),
  );
  const countries: [string, string][] = [['AE', 'United Arab Emirates'], ['SA', 'Saudi Arabia'], ['OM', 'Oman'], ['QA', 'Qatar'], ['KW', 'Kuwait'], ['BH', 'Bahrain'], ['IQ', 'Iraq'], ['IR', 'Iran'], ['IN', 'India'], ['PK', 'Pakistan'],
    ['CN', 'China'], ['SG', 'Singapore'], ['MY', 'Malaysia'], ['LK', 'Sri Lanka'], ['NL', 'Netherlands'], ['DE', 'Germany'], ['ID', 'Indonesia'], ['AU', 'Australia'], ['ZA', 'South Africa'], ['EG', 'Egypt'],
    ['KE', 'Kenya'], ['PA', 'Panama'], ['LR', 'Liberia'], ['MT', 'Malta'], ['HK', 'Hong Kong SAR'], ['MH', 'Marshall Islands'], ['JP', 'Japan'], ['KR', 'Korea'], ['GB', 'United Kingdom'], ['US', 'United States']];
  countries.forEach(([c, l]) => out.push(lk('country', c, l)));
  const states: [string, string, string][] = ae
    ? [['AUH', 'Abu Dhabi', 'AE'], ['DXB', 'Dubai', 'AE'], ['SHJ', 'Sharjah', 'AE'], ['AJM', 'Ajman', 'AE'], ['UAQ', 'Umm Al Quwain', 'AE'], ['RAK', 'Ras Al Khaimah', 'AE'], ['FJR', 'Fujairah', 'AE']]
    : [['GJ', 'Gujarat', 'IN'], ['MH2', 'Maharashtra', 'IN'], ['KL', 'Kerala', 'IN'], ['TN', 'Tamil Nadu', 'IN'], ['KA', 'Karnataka', 'IN'], ['GA', 'Goa', 'IN'], ['AP', 'Andhra Pradesh', 'IN'], ['WB', 'West Bengal', 'IN'], ['OD', 'Odisha', 'IN'], ['DL', 'Delhi (NCT)', 'IN']];
  states.forEach(([c, l, co]) => out.push(lk('state', c, l, { country: co })));
  const cities: [string, string, string][] = ae
    ? [['ABUDHABI', 'Abu Dhabi', 'AUH'], ['DUBAI', 'Dubai', 'DXB'], ['SHARJAH', 'Sharjah', 'SHJ'], ['AJMAN', 'Ajman', 'AJM'], ['UAQ', 'Umm Al Quwain', 'UAQ'], ['RAK', 'Ras Al Khaimah', 'RAK'], ['FUJAIRAH', 'Fujairah', 'FJR'], ['KHORFAKKAN', 'Khor Fakkan', 'SHJ'], ['ALAIN', 'Al Ain', 'AUH'], ['RUWAIS', 'Ruwais', 'AUH']]
    : [['BHUJ', 'Bhuj', 'GJ'], ['GDM', 'Gandhidham', 'GJ'], ['AMD', 'Ahmedabad', 'GJ'], ['BOM', 'Mumbai', 'MH2'], ['MAA', 'Chennai', 'TN'], ['COK', 'Kochi', 'KL'], ['CCU', 'Kolkata', 'WB'], ['VTZ', 'Visakhapatnam', 'AP'], ['NDLS', 'New Delhi', 'DL']];
  cities.forEach(([c, l, st]) => out.push(lk('city', c, l, { state: st, country: j.code })));
  [['MT', 'Metric Tonne'], ['TEU', 'Twenty-foot Equivalent Unit'], ['UNITS', 'Units (vehicles/pieces)'], ['KL', 'Kilolitre'], ['CBM', 'Cubic Metre'], ['MOVE', 'Crane Move'], ['TUGMOV', 'Tug Movement'], ['DAY', 'Day'], ['HR', 'Hour'], ['CALL', 'Per Call'], ['NM', 'Nautical Mile'], ['KN', 'Knot'], ['M', 'Metre'], ['GRT', 'Gross Register Tonnage']]
    .forEach(([c, l]) => out.push(lk('uom', c, l)));
  const currencies: [string, string, Record<string, unknown>][] = ae
    ? [['AED', 'UAE Dirham', { symbol: 'AED', base: true }], ['USD', 'US Dollar', { symbol: '$' }], ['EUR', 'Euro', { symbol: '€' }], ['SAR', 'Saudi Riyal', { symbol: 'SAR' }], ['INR', 'Indian Rupee', { symbol: '₹' }], ['SGD', 'Singapore Dollar', { symbol: 'S$' }]]
    : [['INR', 'Indian Rupee', { symbol: '₹', base: true }], ['USD', 'US Dollar', { symbol: '$' }], ['EUR', 'Euro', { symbol: '€' }], ['AED', 'UAE Dirham', { symbol: 'AED' }], ['SGD', 'Singapore Dollar', { symbol: 'S$' }]];
  currencies.forEach(([c, l, m]) => out.push(lk('currency', c, l, m)));
  [['STS', 'Ship-to-Shore Crane'], ['RTG', 'Rubber-Tyred Gantry'], ['MHC', 'Harbour Mobile Crane'], ['RS', 'Reach Stacker'], ['CONV', 'Conveyor Stream'], ['SL', 'Shiploader'], ['GU', 'Grab Unloader'], ['FL', 'Forklift'], ['TT', 'Terminal Tractor'], ['BOOM', 'Oil Containment Boom'], ['SKIM', 'Oil Skimmer'], ['GWY', 'Shore Gangway']]
    .forEach(([c, l]) => out.push(lk('equipmentType', c, l)));
  const equipment: [string, string, string, string, string, string][] = [
    ['STS-01', 'STS Crane 1 — CT4-1', 'STS', 'Container Terminal 4', 'OPERATIONAL', 'ZPMC'], ['STS-02', 'STS Crane 2 — CT4-1', 'STS', 'Container Terminal 4', 'OPERATIONAL', 'ZPMC'],
    ['STS-03', 'STS Crane 3 — CT4-2', 'STS', 'Container Terminal 4', 'OPERATIONAL', 'ZPMC'], ['STS-04', 'STS Crane 4 — CT5-1', 'STS', 'Container Terminal 5', 'OPERATIONAL', 'Liebherr'],
    ['STS-05', 'STS Crane 5 — CT1-1', 'STS', 'Container Terminal 1', 'OPERATIONAL', 'ZPMC'], ['RTG-01', 'RTG 1 — CT3 Yard Block A', 'RTG', 'Container Terminal 4', 'OPERATIONAL', 'Konecranes'],
    ['RTG-02', 'RTG 2 — CT3 Yard Block B', 'RTG', 'Container Terminal 4', 'OPERATIONAL', 'Konecranes'], ['RTG-03', 'RTG 3 — CT4 Yard', 'RTG', 'Container Terminal 5', 'MAINTENANCE', 'Konecranes'],
    ['MHC-01', 'Harbour Mobile Crane 1 — MP', 'MHC', 'Multipurpose Terminal', 'OPERATIONAL', 'Liebherr LHM 550'], ['MHC-02', 'Harbour Mobile Crane 2 — MP', 'MHC', 'Multipurpose Terminal', 'OPERATIONAL', 'Liebherr LHM 550'],
    ['GU-01', 'Grab Unloader 1 — WB-1', 'GU', 'West Basin Bulk Terminal', 'OPERATIONAL', 'ThyssenKrupp'], ['GU-02', 'Grab Unloader 2 — WB-2', 'GU', 'West Basin Bulk Terminal', 'OPERATIONAL', 'ThyssenKrupp'],
    ['CONV-W1', 'Bulk Conveyor Stream 1', 'CONV', 'West Basin Bulk Terminal', 'OPERATIONAL', '—'], ['CONV-W2', 'Bulk Conveyor Stream 2', 'CONV', 'West Basin Bulk Terminal', 'OPERATIONAL', '—'],
    ['SL-01', 'Shiploader — Bulk Export', 'SL', 'Multipurpose Terminal', 'OPERATIONAL', '—'], ['RS-01', 'Reach Stacker 1', 'RS', 'Container Terminal 4', 'OPERATIONAL', 'Kalmar'],
    ['RS-02', 'Reach Stacker 2', 'RS', 'Container Terminal 5', 'OPERATIONAL', 'Kalmar'], ['BOOM-A', 'Containment Boom Set A (400 m)', 'BOOM', 'Liquid Terminal', 'OPERATIONAL', '—'],
    ['SKIM-1', 'Disc Skimmer Unit 1', 'SKIM', 'Liquid Terminal', 'OPERATIONAL', '—'], ['GWY-L1', 'Shore Gangway — LB-1', 'GWY', 'Liquid Terminal', 'OPERATIONAL', '—']];
  equipment.forEach(([c, l, t, term, st, make]) => out.push(lk('equipment', c, l, { type: t, terminal: term, status: st, make })));
  [['MAR', 'Marine Operations'], ['PIL', 'Pilotage'], ['HSE', 'HSE & Fire'], ['TER', 'Terminal Operations'], ['ENG', 'Engineering & Maintenance'], ['FIN', 'Finance & Billing'], ['COM', 'Commercial & Marketing'], ['SEC', 'Security & ISPS'], ['SUR', 'Surveys & Compliance'], ['IT', 'IT & Systems'], ['HR2', 'Human Resources'], ['STO', 'Stores & Procurement'], ['LEG', 'Legal & Regulatory'], ['REG', 'Ship Registry']]
    .forEach(([c, l]) => out.push(lk('department', c, l)));
  const desigs: [string, string, string][] = [['AHM', 'Asst. Harbour Master', 'Marine Operations'], ['BP', 'Berth Planner', 'Marine Operations'], ['MO', 'Marine Officer', 'Marine Operations'], ['VTS', 'VTS Operator', 'Marine Operations'], ['PLT', 'Pilot', 'Pilotage'],
    ['HSO', 'HSE Officer', 'HSE & Fire'], ['FO', 'Fire Officer', 'HSE & Fire'], ['EO', 'Environment Officer', 'HSE & Fire'], ['TS', 'Terminal Supervisor', 'Terminal Operations'], ['SIC', 'Shift In-charge', 'Terminal Operations'], ['YP', 'Yard Planner', 'Terminal Operations'],
    ['ME', 'Maintenance Engineer', 'Engineering & Maintenance'], ['EE', 'Electrical Engineer', 'Engineering & Maintenance'], ['CT', 'Crane Technician', 'Engineering & Maintenance'], ['BC', 'Billing Clerk', 'Finance & Billing'], ['AO', 'Accounts Officer', 'Finance & Billing'],
    ['CE', 'Collections Executive', 'Finance & Billing'], ['CX', 'Commercial Executive', 'Commercial & Marketing'], ['SO', 'Security Officer', 'Security & ISPS'], ['GS', 'Gate Supervisor', 'Security & ISPS'], ['SV', 'Surveyor', 'Surveys & Compliance'], ['CA', 'Compliance Auditor', 'Surveys & Compliance'],
    ['SE', 'Systems Engineer', 'IT & Systems'], ['HRX', 'HR Executive', 'Human Resources'], ['RSH', 'Registrar of Ships', 'Ship Registry'], ['LO', 'Legal Officer', 'Legal & Regulatory']];
  desigs.forEach(([c, l, d]) => out.push(lk('designation', c, l, { department: d })));
  [['A', 'Shift A (0600–1400)', { start: '06:00', end: '14:00' }], ['B', 'Shift B (1400–2200)', { start: '14:00', end: '22:00' }], ['C', 'Shift C (2200–0600)', { start: '22:00', end: '06:00' }], ['G', 'General (0800–1700)', { start: '08:00', end: '17:00' }]]
    .forEach(([c, l, m]) => out.push(lk('shift', c as string, l as string, m as Record<string, unknown>)));
  [['REPORT', 'Report'], ['PHOTO', 'Photographs'], ['STATEMENT', 'Statement'], ['SAMPLE', 'Sample / Analysis'], ['PERMIT', 'Permit to Work'], ['CCTV', 'CCTV Footage'], ['MANIFEST', 'Cargo Manifest'], ['SURVEY', 'Survey Report'], ['NOTICE', 'Notice / Letter'], ['CERT', 'Certificate'], ['OTHER', 'Other']]
    .forEach(([c, l]) => out.push(lk('documentType', c, l)));
  [['APPCH', 'Approach channel'], ['ANCH-A1', 'Outer anchorage A1'], ['FWY', 'Fairway buoy sector'], ['GATE', 'Gate complex'], ['CT3YD', 'CT-3 container yard'], ['CT4YD', 'CT-4 container yard'], ['WBSY', 'West Basin stockyard'], ['TANKF', 'Liquid terminal tank farm'], ['FZ2', 'Free Zone 2'], ['RAILY', 'Railway sidings'], ['WSHOP', 'Engineering workshop']]
    .forEach(([c, l]) => out.push(lk('incidentArea', c, l)));
  const holidays: [string, string, string][] = ae
    ? [['NY26', 'New Year\'s Day', '2026-01-01'], ['EIDF26A', 'Eid Al Fitr (indicative)', '2026-03-20'], ['EIDF26B', 'Eid Al Fitr holiday (indicative)', '2026-03-21'], ['EIDF26C', 'Eid Al Fitr holiday (indicative)', '2026-03-22'],
       ['ARAF26', 'Arafat Day (indicative)', '2026-05-26'], ['EIDA26A', 'Eid Al Adha (indicative)', '2026-05-27'], ['EIDA26B', 'Eid Al Adha holiday (indicative)', '2026-05-28'], ['HIJ26', 'Islamic New Year (indicative)', '2026-06-16'],
       ['PBD26', 'Prophet Muhammad\'s Birthday (indicative)', '2026-08-25'], ['COMM26', 'Commemoration Day', '2026-12-01'], ['NAT26A', 'National Day', '2026-12-02'], ['NAT26B', 'National Day holiday', '2026-12-03']]
    : [['REP26', 'Republic Day', '2026-01-26'], ['HOLI26', 'Holi', '2026-03-04'], ['GDFR26', 'Good Friday', '2026-04-03'], ['IDU26', 'Idul Fitr', '2026-03-21'], ['IND26', 'Independence Day', '2026-08-15'], ['GAN26', 'Ganesh Chaturthi', '2026-09-14'],
       ['GJ26', 'Gandhi Jayanti', '2026-10-02'], ['DUS26', 'Dussehra', '2026-10-20'], ['DIW26', 'Diwali', '2026-11-08'], ['XMAS26', 'Christmas Day', '2026-12-25']];
  holidays.forEach(([c, l, d]) => out.push(lk('holiday', c, l, { date: d, working: '24×365 marine operations — office and gate restricted' })));
  return out;
}
