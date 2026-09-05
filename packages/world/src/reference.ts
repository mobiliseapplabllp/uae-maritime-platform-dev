import { getJurisdiction } from '@maritime/contracts';
import { EVIDENCE } from './registry';

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

  /* The vocabularies the domain services validate against. Each of these used to be an inline list in a form
   * definition or a constant in a controller; a clerk who needed a new area of operation or a new visit type
   * had to wait for a release. Now they are rows, and a service reads its mirror of them. */
  const push = (category: string, rows: [string, string, string, Record<string, unknown>?][]) => rows.forEach(([code, label, labelAr, meta]) => out.push(lk(category, code, label, meta ?? {}, labelAr)));
  push('voyageArea', [['PORT_LIMITS', 'Port limits', 'حدود الميناء'], ['COASTAL', 'Coastal', 'ساحلي'], ['GULF', 'Arabian Gulf and Gulf of Oman', 'الخليج العربي وخليج عمان'], ['INTERNATIONAL', 'International', 'دولي']]);
  push('movementType', [['SHIFTING', 'Shifting', 'تحويل الرصيف'], ['DRY_DOCK', 'Dry dock', 'الحوض الجاف'], ['LAYUP', 'Lay-up', 'إرساء طويل'], ['DEPARTURE', 'Departure', 'مغادرة'], ['SEA_TRIAL', 'Sea trial', 'تجربة بحرية'], ['TOWAGE', 'Towage', 'قطر']]);
  push('callPurpose', [['CARGO', 'Cargo operations', 'عمليات شحن'], ['BUNKERING', 'Bunkering', 'التزود بالوقود'], ['REPAIR', 'Repair', 'إصلاح'], ['LAYUP', 'Lay-up', 'إرساء'], ['CREW_CHANGE', 'Crew change', 'تبديل الطاقم'], ['STORES', 'Stores and provisions', 'تموين']]);
  push('recognisedOrganisation', [['TASNEEF', 'TASNEEF', 'تصنيف', { iacs: true }], ['LR', 'Lloyd\'s Register', 'لويدز ريجستر', { iacs: true }], ['DNV', 'DNV', 'دي إن في', { iacs: true }], ['BV', 'Bureau Veritas', 'بيرو فيريتاس', { iacs: true }],
    ['NK', 'ClassNK', 'كلاس إن كيه', { iacs: true }], ['ABS', 'American Bureau of Shipping', 'المكتب الأمريكي للشحن', { iacs: true }], ['RINA', 'RINA', 'رينا', { iacs: true }], ['CCS', 'China Classification Society', 'جمعية التصنيف الصينية', { iacs: true }],
    ['KR', 'Korean Register', 'السجل الكوري', { iacs: true }], ['IRS', 'Indian Register of Shipping', 'السجل الهندي للشحن', { iacs: true }]]);
  /* The registration variants. Everything the registrar's runtime needs about a variant is here: the family it belongs to
   * (opens an entry, alters it, suspends it for a bareboat charter out, closes it, or issues a document against it), its SLA,
   * the validity of what it issues, the certificate series, the state the ship enters on grant, the fee, and the evidence. */
  type KindMeta = { family: string; slaDays: number; validityMonths: number | null; issuesCertificate: boolean; closesRegistry: boolean; registryState: string | null; series: string; transactionType: string | null; carving: boolean; fee: number; order: number };
  const kind = (code: string, label: string, labelAr: string, m: KindMeta): [string, string, string, Record<string, unknown>] => [code, label, labelAr, { ...m, evidence: EVIDENCE[code] ?? [] }];
  const f = (aed: number, inr: number) => (ae ? aed : inr);
  push('registrationKind', [
    kind('PROVISIONAL', 'Provisional registration', 'تسجيل مؤقت', { family: 'FIRST', slaDays: 7, validityMonths: j.registry.provisionalValidityMonths.value, issuesCertificate: true, closesRegistry: false, registryState: 'PROVISIONAL', series: 'PCR', transactionType: 'REGISTRATION', carving: false, fee: f(1500, 15000), order: 1 }),
    kind('PERMANENT', 'Permanent registration', 'تسجيل دائم', { family: 'FIRST', slaDays: 30, validityMonths: null, issuesCertificate: true, closesRegistry: false, registryState: 'REGISTERED', series: 'CR', transactionType: 'REGISTRATION', carving: true, fee: f(5000, 50000), order: 2 }),
    kind('BAREBOAT_IN', 'Bareboat charter registration (in)', 'تسجيل بعقد إيجار عاري (وارد)', { family: 'FIRST', slaDays: 21, validityMonths: 24, issuesCertificate: true, closesRegistry: false, registryState: 'BAREBOAT_IN', series: 'BCR', transactionType: 'BAREBOAT_IN', carving: false, fee: f(3000, 30000), order: 3 }),
    kind('BAREBOAT_OUT', 'Bareboat charter registration (out)', 'تسجيل بعقد إيجار عاري (صادر)', { family: 'OUT', slaDays: 21, validityMonths: 24, issuesCertificate: false, closesRegistry: false, registryState: 'BAREBOAT_OUT', series: 'BBO', transactionType: 'BAREBOAT_OUT', carving: false, fee: f(3000, 30000), order: 4 }),
    kind('UNDER_CONSTRUCTION', 'Registration of a ship under construction', 'تسجيل سفينة قيد الإنشاء', { family: 'FIRST', slaDays: 21, validityMonths: 24, issuesCertificate: true, closesRegistry: false, registryState: 'PROVISIONAL', series: 'UCR', transactionType: 'REGISTRATION', carving: false, fee: f(2000, 20000), order: 5 }),
    kind('TEMPORARY_PASS', 'Temporary pass for a single voyage', 'تصريح مؤقت لرحلة واحدة', { family: 'DOCUMENT', slaDays: 3, validityMonths: 1, issuesCertificate: true, closesRegistry: false, registryState: null, series: 'TP', transactionType: 'TEMPORARY_PASS', carving: false, fee: f(500, 5000), order: 6 }),
    kind('AMENDMENT', 'Amendment of registry particulars', 'تعديل بيانات التسجيل', { family: 'ALTER', slaDays: 15, validityMonths: null, issuesCertificate: true, closesRegistry: false, registryState: null, series: 'CR', transactionType: null, carving: false, fee: f(1000, 10000), order: 7 }),
    kind('RE_REGISTRATION', 'Re-registration', 'إعادة التسجيل', { family: 'FIRST', slaDays: 30, validityMonths: null, issuesCertificate: true, closesRegistry: false, registryState: 'REGISTERED', series: 'CR', transactionType: 'RE_REGISTRATION', carving: false, fee: f(2500, 25000), order: 8 }),
    kind('DELETION', 'Closure of registry', 'إغلاق التسجيل', { family: 'CLOSE', slaDays: 15, validityMonths: null, issuesCertificate: true, closesRegistry: true, registryState: 'CLOSED', series: 'DEL', transactionType: 'CLOSURE', carving: false, fee: f(500, 5000), order: 9 })]);
  /* What can be recorded against an entry. `direct` transactions are recorded on the register by the registrar without an
   * application; the rest arrive through a registration journey and are written when it is granted. */
  push('registryTransactionType', [
    ['REGISTRATION', 'Ship registered', 'تسجيل السفينة', { affectsTitle: true, requiresConsent: false, direct: false, feeCode: '', order: 1 }],
    ['RE_REGISTRATION', 'Ship re-registered', 'إعادة تسجيل السفينة', { affectsTitle: true, requiresConsent: false, direct: false, feeCode: '', order: 2 }],
    ['BAREBOAT_IN', 'Bareboat charter registered in', 'تسجيل إيجار عارٍ وارد', { affectsTitle: false, requiresConsent: true, direct: false, feeCode: '', order: 3 }],
    ['BAREBOAT_OUT', 'Bareboat charter registered out', 'تسجيل إيجار عارٍ صادر', { affectsTitle: false, requiresConsent: true, direct: false, feeCode: '', order: 4 }],
    ['TEMPORARY_PASS', 'Temporary pass issued', 'إصدار تصريح مؤقت', { affectsTitle: false, requiresConsent: false, direct: false, feeCode: '', order: 5 }],
    ['CLOSURE', 'Registry closed', 'إغلاق التسجيل', { affectsTitle: true, requiresConsent: true, direct: false, feeCode: '', order: 6 }],
    ['MORTGAGE_REGISTRATION', 'Registration of a mortgage', 'تسجيل رهن', { affectsTitle: false, requiresConsent: false, direct: true, feeCode: 'REG-MORTGAGE', order: 7 }],
    ['MORTGAGE_DISCHARGE', 'Discharge of a mortgage', 'فك رهن', { affectsTitle: false, requiresConsent: false, direct: true, feeCode: 'REG-MORTGAGE', order: 8 }],
    ['MORTGAGE_TRANSFER', 'Transfer of a mortgage', 'نقل رهن', { affectsTitle: false, requiresConsent: true, direct: true, feeCode: 'REG-MORTGAGE', order: 9 }],
    ['TRANSFER_OF_OWNERSHIP', 'Transfer of ownership', 'نقل الملكية', { affectsTitle: true, requiresConsent: true, direct: false, feeCode: 'REG-AMENDMENT', order: 10 }],
    ['CHANGE_OF_NAME', 'Change of name', 'تغيير الاسم', { affectsTitle: false, requiresConsent: true, direct: false, feeCode: 'REG-AMENDMENT', order: 11 }],
    ['CHANGE_OF_PORT', 'Change of port of registry', 'تغيير ميناء التسجيل', { affectsTitle: false, requiresConsent: false, direct: false, feeCode: 'REG-AMENDMENT', order: 12 }],
    ['CHANGE_OF_MANAGER', 'Change of manager', 'تغيير المدير', { affectsTitle: false, requiresConsent: false, direct: true, feeCode: 'REG-AMENDMENT', order: 13 }],
    ['CHANGE_OF_TONNAGE', 'Change of tonnage or particulars', 'تغيير الحمولة أو البيانات', { affectsTitle: false, requiresConsent: false, direct: false, feeCode: 'REG-AMENDMENT', order: 14 }],
    ['ALTERATION', 'Alteration of the ship recorded', 'تسجيل تعديل في السفينة', { affectsTitle: false, requiresConsent: false, direct: false, feeCode: 'REG-AMENDMENT', order: 15 }],
    ['CAVEAT', 'Caveat lodged', 'تسجيل اعتراض', { affectsTitle: true, requiresConsent: false, direct: true, feeCode: '', order: 16 }],
    ['CAVEAT_WITHDRAWAL', 'Caveat withdrawn', 'سحب الاعتراض', { affectsTitle: true, requiresConsent: false, direct: true, feeCode: '', order: 17 }],
    ['TRANSCRIPT', 'Transcript of registry issued', 'إصدار مستخرج من السجل', { affectsTitle: false, requiresConsent: false, direct: true, feeCode: 'REG-TRANSCRIPT', order: 18 }],
    ['CERTIFICATE_REISSUE', 'Certificate of registry reissued', 'إعادة إصدار شهادة التسجيل', { affectsTitle: false, requiresConsent: false, direct: true, feeCode: 'REG-REISSUE', order: 19 }]]);
  push('amendmentType', [['NAME', 'Name', 'الاسم', { transactionType: 'CHANGE_OF_NAME', needsApproval: true }], ['OWNERSHIP', 'Ownership', 'الملكية', { transactionType: 'TRANSFER_OF_OWNERSHIP', needsApproval: false }], ['PORT_OF_REGISTRY', 'Port of registry', 'ميناء التسجيل', { transactionType: 'CHANGE_OF_PORT', needsApproval: false }],
    ['TONNAGE', 'Tonnage', 'الحمولة', { transactionType: 'CHANGE_OF_TONNAGE', needsApproval: false }], ['ALTERATION', 'Alteration of the ship', 'تعديل في السفينة', { transactionType: 'ALTERATION', needsApproval: false }], ['MANAGER', 'Manager', 'المدير', { transactionType: 'CHANGE_OF_MANAGER', needsApproval: false }], ['MORTGAGE', 'Mortgage', 'الرهن', { transactionType: 'MORTGAGE_REGISTRATION', needsApproval: false }]]);
  push('tradingArea', [['UNLIMITED', 'Unlimited', 'غير محدودة', { order: 1 }], ['NEAR_COASTAL', 'Near-coastal', 'ساحلية قريبة', { order: 2 }], ['GULF', 'Gulf and Gulf of Oman', 'الخليج وخليج عُمان', { order: 3 }], ['PORT_LIMITS', 'Within port limits', 'ضمن حدود الميناء', { order: 4 }], ['SHELTERED', 'Sheltered waters', 'مياه محمية', { order: 5 }]]);
  push('deletionReason', [['SOLD_FOREIGN', 'Sold to a foreign owner', 'بيعت لمالك أجنبي'], ['TRANSFER_OF_REGISTRY', 'Transfer to another registry', 'نقل إلى سجل آخر'], ['BROKEN_UP', 'Broken up', 'تفكيك'], ['TOTAL_LOSS', 'Total loss', 'خسارة كلية'], ['MISSING', 'Missing', 'مفقودة'], ['CEASED_TO_QUALIFY', 'Ceased to qualify', 'لم تعد مؤهلة']]);
  // code, label, Arabic, department, officer, the competency grade the rank sails on (blank for a rating), order
  const ranks: [string, string, string, string, boolean, string, number][] = [
    ['MASTER', 'Master', 'الربان', 'DECK', true, 'MASTER', 1], ['CHIEF_OFFICER', 'Chief Officer', 'الضابط الأول', 'DECK', true, 'CHIEF_MATE', 2], ['SECOND_OFFICER', 'Second Officer', 'الضابط الثاني', 'DECK', true, 'OOW_NAV', 3], ['THIRD_OFFICER', 'Third Officer', 'الضابط الثالث', 'DECK', true, 'OOW_NAV', 4],
    ['CHIEF_ENGINEER', 'Chief Engineer', 'كبير المهندسين', 'ENGINE', true, 'CHIEF_ENGINEER', 5], ['SECOND_ENGINEER', 'Second Engineer', 'المهندس الثاني', 'ENGINE', true, 'SECOND_ENGINEER', 6], ['THIRD_ENGINEER', 'Third Engineer', 'المهندس الثالث', 'ENGINE', true, 'OOW_ENG', 7], ['FOURTH_ENGINEER', 'Fourth Engineer', 'المهندس الرابع', 'ENGINE', true, 'OOW_ENG', 8],
    ['ETO', 'Electro-Technical Officer', 'ضابط كهروتقني', 'ENGINE', true, 'ETO', 9], ['BOSUN', 'Bosun', 'رئيس البحارة', 'DECK', false, '', 10], ['AB', 'Able Seaman', 'بحار مؤهل', 'DECK', false, '', 11], ['OS', 'Ordinary Seaman', 'بحار عادي', 'DECK', false, '', 12],
    ['OILER', 'Oiler', 'مزيّت', 'ENGINE', false, '', 13], ['FITTER', 'Fitter', 'فني تركيب', 'ENGINE', false, '', 14], ['COOK', 'Cook', 'طاهٍ', 'CATERING', false, '', 15], ['STEWARD', 'Steward', 'مضيف', 'CATERING', false, '', 16],
    ['DECK_CADET', 'Deck Cadet', 'طالب ضابط سطح', 'DECK', false, '', 17], ['ENGINE_CADET', 'Engine Cadet', 'طالب مهندس', 'ENGINE', false, '', 18]];
  ranks.forEach(([c, l, ar, dept, officer, cocGrade, order]) => out.push(lk('seafarerRank', c, l, { department: dept, officer, cocGrade, order }, ar)));
  // the kind says what a document is for: the sign-on gate and the crew-list check read the mandatory ones, and give a MEDICAL a longer horizon than the rest
  push('seafarerCertType', [
    ['COC', 'Certificate of Competency', 'شهادة الكفاءة', { kind: 'COMPETENCY', convention: 'STCW II/III', validityMonths: 60, mandatory: true }], ['GOC', 'GMDSS GOC', 'شهادة مشغل GMDSS عام', { kind: 'COMPETENCY', convention: 'STCW IV/2', validityMonths: 60, mandatory: false }],
    ['MEDICAL', 'Medical Fitness (ILO/MLC)', 'اللياقة الطبية', { kind: 'MEDICAL', convention: 'MLC 2006 / STCW I/9', validityMonths: 24, mandatory: true }], ['BST', 'STCW Basic Safety Training', 'التدريب الأساسي على السلامة', { kind: 'PROFICIENCY', convention: 'STCW VI/1', validityMonths: 60, mandatory: true }],
    ['AFF', 'Advanced Fire Fighting', 'مكافحة الحريق المتقدمة', { kind: 'PROFICIENCY', convention: 'STCW VI/3', validityMonths: 60, mandatory: false }], ['MFA', 'Medical First Aid', 'الإسعافات الأولية الطبية', { kind: 'PROFICIENCY', convention: 'STCW VI/4', validityMonths: 60, mandatory: false }],
    ['SSO', 'Ship Security Officer', 'ضابط أمن السفينة', { kind: 'PROFICIENCY', convention: 'STCW VI/5', validityMonths: 60, mandatory: false }], ['TANKER_FAM', 'Tanker Familiarisation', 'التعريف بالناقلات', { kind: 'PROFICIENCY', convention: 'STCW V/1', validityMonths: 60, mandatory: false }],
    ['CDC', 'Certificate of Discharge (CDC)', 'دفتر خدمة البحار', { kind: 'RECORD', convention: 'National', validityMonths: 120, mandatory: true }], ['FSE', 'Flag State Endorsement', 'اعتماد دولة العلم', { kind: 'ENDORSEMENT', convention: 'STCW I/10', validityMonths: 60, mandatory: false }],
    ['SEAMAN_CARD', 'Seafarer Identity Card', 'بطاقة هوية البحار', { kind: 'IDENTITY', convention: 'ILO 185', validityMonths: 60, mandatory: false }]]);
  push('cocGrade', [['MASTER', 'Master', 'ربان', { regulation: 'II/2', seaServiceMonths: 36 }], ['CHIEF_MATE', 'Chief Mate', 'ضابط أول', { regulation: 'II/2', seaServiceMonths: 24 }], ['OOW_NAV', 'Officer in Charge of a Navigational Watch', 'ضابط نوبة ملاحية', { regulation: 'II/1', seaServiceMonths: 12 }],
    ['CHIEF_ENGINEER', 'Chief Engineer', 'كبير المهندسين', { regulation: 'III/2', seaServiceMonths: 36 }], ['SECOND_ENGINEER', 'Second Engineer', 'مهندس ثانٍ', { regulation: 'III/2', seaServiceMonths: 24 }], ['OOW_ENG', 'Officer in Charge of an Engineering Watch', 'ضابط نوبة هندسية', { regulation: 'III/1', seaServiceMonths: 12 }], ['ETO', 'Electro-Technical Officer', 'ضابط كهروتقني', { regulation: 'III/6', seaServiceMonths: 12 }]]);
  push('copCourse', [['BST', 'Basic Safety Training', 'التدريب الأساسي على السلامة', { regulation: 'VI/1', validityMonths: 60 }], ['AFF', 'Advanced Fire Fighting', 'مكافحة الحريق المتقدمة', { regulation: 'VI/3', validityMonths: 60 }], ['MFA', 'Medical First Aid', 'الإسعافات الأولية الطبية', { regulation: 'VI/4', validityMonths: 60 }],
    ['TANKER_FAM', 'Tanker Familiarisation', 'التعريف بالناقلات', { regulation: 'V/1', validityMonths: 60 }], ['PSCRB', 'Proficiency in Survival Craft and Rescue Boats', 'إتقان قوارب النجاة والإنقاذ', { regulation: 'VI/2', validityMonths: 60 }], ['SSO', 'Ship Security Officer', 'ضابط أمن السفينة', { regulation: 'VI/5', validityMonths: 60 }]]);
  push('gmdssGrade', [['GOC', 'General Operator Certificate', 'شهادة مشغل عام'], ['ROC', 'Restricted Operator Certificate', 'شهادة مشغل مقيد']]);
  push('deliveryOffice', ae
    ? [['ABU_DHABI', 'Abu Dhabi', 'أبوظبي', { city: 'Abu Dhabi', hours: '07:30–15:30' }], ['DUBAI', 'Dubai', 'دبي', { city: 'Dubai', hours: '07:30–15:30' }], ['SHARJAH', 'Sharjah', 'الشارقة', { city: 'Sharjah', hours: '07:30–15:30' }], ['FUJAIRAH', 'Fujairah', 'الفجيرة', { city: 'Fujairah', hours: '07:30–15:30' }], ['RAK', 'Ras Al Khaimah', 'رأس الخيمة', { city: 'Ras Al Khaimah', hours: '07:30–15:30' }]]
    : [['MUMBAI', 'Mumbai', 'مومباي', { city: 'Mumbai', hours: '09:30–17:30' }], ['CHENNAI', 'Chennai', 'تشيناي', { city: 'Chennai', hours: '09:30–17:30' }], ['KOCHI', 'Kochi', 'كوتشي', { city: 'Kochi', hours: '09:30–17:30' }], ['KOLKATA', 'Kolkata', 'كولكاتا', { city: 'Kolkata', hours: '09:30–17:30' }]]);
  push('recordBookReason', [['FIRST_ISSUE', 'First issue', 'إصدار أول'], ['REPLACEMENT_LOST', 'Replacement — lost', 'بدل فاقد'], ['REPLACEMENT_FULL', 'Replacement — full', 'بدل ممتلئ'], ['REPLACEMENT_DAMAGED', 'Replacement — damaged', 'بدل تالف']]);
  push('metProgramme', [['BST', 'Basic Safety Training', 'التدريب الأساسي على السلامة', { regulation: 'VI/1', hours: 40, simulator: false }], ['AFF', 'Advanced Fire Fighting', 'مكافحة الحريق المتقدمة', { regulation: 'VI/3', hours: 32, simulator: false }], ['MFA', 'Medical First Aid', 'الإسعافات الأولية الطبية', { regulation: 'VI/4', hours: 24, simulator: false }],
    ['PSCRB', 'Proficiency in Survival Craft and Rescue Boats', 'إتقان قوارب النجاة والإنقاذ', { regulation: 'VI/2', hours: 30, simulator: false }], ['SSO', 'Ship Security Officer', 'ضابط أمن السفينة', { regulation: 'VI/5', hours: 24, simulator: false }], ['GMDSS_GOC', 'GMDSS General Operator', 'مشغل GMDSS عام', { regulation: 'IV/2', hours: 120, simulator: true }],
    ['ECDIS', 'ECDIS generic', 'نظام عرض الخرائط الإلكترونية', { regulation: 'II/1', hours: 40, simulator: true }], ['BRM', 'Bridge Resource Management', 'إدارة موارد الجسر', { regulation: 'II/1', hours: 40, simulator: true }], ['ERM', 'Engine-room Resource Management', 'إدارة موارد غرفة المحركات', { regulation: 'III/1', hours: 40, simulator: true }],
    ['TANKER_OIL_ADV', 'Advanced Oil Tanker Cargo Operations', 'عمليات شحن ناقلات النفط المتقدمة', { regulation: 'V/1-1', hours: 60, simulator: true }], ['DECK_OOW', 'Deck Officer Foundation Programme', 'برنامج تأسيس ضباط السطح', { regulation: 'II/1', hours: 1200, simulator: true }], ['ENGINE_OOW', 'Engineer Officer Foundation Programme', 'برنامج تأسيس ضباط المحركات', { regulation: 'III/1', hours: 1200, simulator: true }]]);
  push('metInstitutionType', [['ACADEMY', 'Maritime academy', 'أكاديمية بحرية'], ['TRAINING_CENTRE', 'Training centre', 'مركز تدريب'], ['UNIVERSITY', 'University maritime faculty', 'كلية بحرية جامعية'], ['SIMULATOR_CENTRE', 'Simulator centre', 'مركز محاكاة'], ['COMPANY_TRAINING', 'Company in-house training unit', 'وحدة تدريب داخلية']]);
  push('crewListSource', [['MSW', 'Maritime Single Window', 'النافذة البحرية الموحدة'], ['AGENT_PORTAL', 'Agent portal', 'بوابة الوكيل'], ['AGENT_UPLOAD', 'Uploaded by the agent', 'مرفوع من الوكيل'], ['PSC_BOARDING', 'Taken at PSC boarding', 'مأخوذة عند التفتيش'], ['FAL_EDI', 'FAL electronic message', 'رسالة FAL الإلكترونية']]);
  // the reference prefix is the series the register allocates numbers in (`CIRC-14/2026`); `citable` is whether the public portal shows the type at all
  push('legalInstrumentType', [['ACT', 'Federal law / Act', 'قانون اتحادي', { citable: true, refPrefix: 'ACT', order: 1 }], ['RULES', 'Rules / regulations', 'لائحة', { citable: true, refPrefix: 'RULES', order: 2 }], ['CIRCULAR', 'Circular', 'تعميم', { citable: true, refPrefix: 'CIRC', order: 3 }], ['NOTICE', 'Marine notice', 'إشعار بحري', { citable: true, refPrefix: 'NOTICE', order: 4 }],
    ['ORDER', 'Ministerial order', 'قرار وزاري', { citable: true, refPrefix: 'ORD', order: 5 }], ['CONVENTION', 'Convention', 'اتفاقية', { citable: true, refPrefix: 'CONV', order: 6 }], ['GUIDANCE', 'Guidance note', 'مذكرة إرشادية', { citable: true, refPrefix: 'GN', order: 7 }], ['INTERNAL', 'Internal instruction', 'تعليمات داخلية', { citable: false, refPrefix: 'INS', order: 8 }]]);
  push('legalLinkKind', [['AMENDS', 'Amends', 'يعدّل'], ['SUPERSEDES', 'Supersedes', 'يحل محل'], ['REFERS_TO', 'Refers to', 'يشير إلى'], ['IMPLEMENTS', 'Implements', 'ينفّذ'], ['REVOKES', 'Revokes', 'يلغي'], ['CONSOLIDATES', 'Consolidates', 'يوحّد']]);
  push('imoSource', [
    ['MSC', 'Maritime Safety Committee', 'لجنة السلامة البحرية', { body: 'MSC', series: 'MSC.1/Circ.', url: 'https://www.imo.org/en/MediaCentre/MeetingSummaries/Pages/Default.aspx', pollHours: 24 }],
    ['MEPC', 'Marine Environment Protection Committee', 'لجنة حماية البيئة البحرية', { body: 'MEPC', series: 'MEPC.1/Circ.', url: 'https://www.imo.org/en/MediaCentre/MeetingSummaries/Pages/Default.aspx', pollHours: 24 }],
    ['LEG', 'Legal Committee', 'اللجنة القانونية', { body: 'LEG', series: 'LEG/Circ.', url: 'https://www.imo.org/en/MediaCentre/MeetingSummaries/Pages/Default.aspx', pollHours: 72 }],
    ['FAL', 'Facilitation Committee', 'لجنة التسهيل', { body: 'FAL', series: 'FAL.5/Circ.', url: 'https://www.imo.org/en/MediaCentre/MeetingSummaries/Pages/Default.aspx', pollHours: 72 }],
    ['ASSEMBLY', 'Assembly resolutions', 'قرارات الجمعية', { body: 'A', series: 'A.', url: 'https://www.imo.org/en/KnowledgeCentre/IndexofIMOResolutions/Pages/Default.aspx', pollHours: 168 }],
    ['III', 'Sub-Committee on Implementation of IMO Instruments', 'اللجنة الفرعية لتنفيذ صكوك المنظمة', { body: 'III', series: 'III', url: 'https://www.imo.org/en/MediaCentre/MeetingSummaries/Pages/Default.aspx', pollHours: 168 }],
    ['HTW', 'Sub-Committee on Human Element, Training and Watchkeeping', 'اللجنة الفرعية للعنصر البشري والتدريب', { body: 'HTW', series: 'HTW', url: 'https://www.imo.org/en/MediaCentre/MeetingSummaries/Pages/Default.aspx', pollHours: 168 }],
    ['GISIS', 'GISIS notifications', 'إخطارات GISIS', { body: 'GISIS', series: 'GISIS', url: 'https://gisis.imo.org/', pollHours: 24 }]]);
  push('companyCategory', [['AGENCY', 'Shipping agency', 'وكالة ملاحية'], ['TERMINAL_OPERATOR', 'Terminal operator', 'مشغل محطة'], ['SERVICE_PROVIDER', 'Service provider', 'مزود خدمات'], ['SUPPLIER', 'Supplier', 'مورّد'], ['INSTITUTE', 'Institute', 'معهد'], ['SHIPOWNER', 'Shipowner / manager', 'مالك / مدير سفن'], ['CONTRACTOR', 'Marine contractor', 'مقاول بحري']]);
  const scheme = (type: string, weight = 1) => ({ instrumentType: type, cycleMonths: 12, visitsPerCycle: 1, reminderDays: '90,30,7', ratingWeight: weight });
  push('accreditationCategory', [['COMPASS_CALIBRATION', 'Magnetic compass adjusting', 'ضبط البوصلة المغناطيسية', scheme('COMPASS_CALIBRATION')], ['LSA_SERVICING', 'Life-saving appliance servicing', 'صيانة معدات إنقاذ الأرواح', scheme('LSA_SERVICING', 1.2)],
    ['FFA_SERVICING', 'Fire-fighting appliance servicing', 'صيانة معدات مكافحة الحريق', scheme('FFA_SERVICING', 1.2)], ['SMALL_VESSEL_SURVEY', 'Small vessel survey', 'مساحة السفن الصغيرة', scheme('SMALL_VESSEL_SURVEY')],
    ['PEST_CONTROL', 'Pest control and deratting', 'مكافحة الآفات وإبادة القوارض', scheme('PEST_CONTROL', 0.8)], ['TOWAGE_CERTIFICATION', 'Towage', 'القطر', scheme('TOWAGE_CERTIFICATION')],
    // a maritime education and training provider is accredited on the same engine: an annual cycle with an audit, under STCW regulation I/8
    ['MET_INSTITUTION', 'Maritime education and training institution', 'مؤسسة التعليم والتدريب البحري', { ...scheme('MET_INSTITUTION_ACCREDITATION', 1.5), reminderDays: '120,60,30' }]]);
  push('facilityType', [['BERTH', 'Berth', 'رصيف'], ['TERMINAL', 'Terminal', 'محطة'], ['JETTY', 'Jetty', 'رصيف بحري'], ['YARD', 'Yard', 'ساحة'], ['SPM', 'Single point mooring', 'مرسى أحادي النقطة'], ['ANCHORAGE', 'Anchorage', 'مرسى'], ['MARINA', 'Marina', 'مارينا'], ['SHIPYARD', 'Shipyard', 'حوض بناء سفن']]);
  push('facilityCapability', [['CONTAINER', 'Containers', 'حاويات'], ['REEFER_PLUGS', 'Reefer plugs', 'وصلات تبريد'], ['SHIP_TO_SHORE_CRANES', 'Ship-to-shore cranes', 'رافعات رصيف'], ['DRY_BULK', 'Dry bulk', 'بضائع سائبة جافة'], ['GRAB_DISCHARGE', 'Grab discharge', 'تفريغ بالكباش'], ['CONVEYOR', 'Conveyor', 'ناقل'],
    ['LIQUID_BULK', 'Liquid bulk', 'سوائل سائبة'], ['PIPELINE', 'Pipeline', 'خط أنابيب'], ['VAPOUR_RECOVERY', 'Vapour recovery', 'استرداد الأبخرة'], ['RORO', 'Ro-Ro', 'دحرجة'], ['VEHICLES', 'Vehicles', 'مركبات'], ['LINKSPAN', 'Linkspan', 'جسر ربط'], ['BREAK_BULK', 'Break bulk', 'بضائع عامة'], ['PROJECT_CARGO', 'Project cargo', 'شحنات مشاريع'],
    ['MOBILE_HARBOUR_CRANE', 'Mobile harbour crane', 'رافعة مينائية متنقلة'], ['CRUDE_OIL', 'Crude oil', 'نفط خام'], ['SINGLE_POINT_MOORING', 'Single point mooring', 'مرسى أحادي النقطة'], ['PASSENGERS', 'Passengers', 'ركاب'], ['DANGEROUS_GOODS', 'Dangerous goods', 'بضائع خطرة'], ['LNG', 'LNG', 'غاز طبيعي مسال']]);
  push('visitType', [['INITIAL', 'Initial accreditation visit', 'زيارة الاعتماد الأولى', { ratingWeight: 1, scheduled: true, order: 1 }], ['ANNUAL', 'Annual accreditation visit', 'زيارة الاعتماد السنوية', { ratingWeight: 1, scheduled: true, order: 2 }], ['RENEWAL', 'Renewal visit', 'زيارة التجديد', { ratingWeight: 1, scheduled: true, order: 3 }],
    ['FOLLOW_UP', 'Follow-up visit', 'زيارة متابعة', { ratingWeight: 0.8, scheduled: true, order: 4 }], ['SPOT_CHECK', 'Unannounced spot check', 'تفتيش مفاجئ', { ratingWeight: 0.6, scheduled: false, order: 5 }], ['COMPLAINT', 'Complaint investigation', 'تحقيق في شكوى', { ratingWeight: 0.8, scheduled: false, order: 6 }]]);
  push('obligationKind', [['AUDIT_FINDING', 'Audit finding', 'ملاحظة تدقيق', { defaultDueDays: 30 }], ['VISIT_FINDING', 'Inspection visit finding', 'ملاحظة زيارة تفتيش', { defaultDueDays: 30 }], ['RENEWAL', 'Renewal due', 'تجديد مستحق', { defaultDueDays: 90 }], ['CONDITION', 'Condition to meet', 'شرط واجب الاستيفاء', { defaultDueDays: 30 }], ['DOCUMENT', 'Document to produce', 'وثيقة مطلوبة', { defaultDueDays: 14 }]]);
  push('auditType', [['INITIAL', 'Initial', 'أولي'], ['ANNUAL', 'Annual', 'سنوي'], ['INTERMEDIATE', 'Intermediate', 'مرحلي'], ['RENEWAL', 'Renewal', 'تجديد'], ['ADDITIONAL', 'Additional', 'إضافي']]);
  push('inspectionRegime', [['PSC', 'Port State Control', 'رقابة دولة الميناء', { subjectKind: 'VESSEL', intervalMonths: null, convention: 'Riyadh MoU' }], ['FSI', 'Flag State Inspection', 'تفتيش دولة العلم', { subjectKind: 'VESSEL', intervalMonths: 12, convention: 'SOLAS I/6' }],
    ['ISM', 'ISM audit', 'تدقيق ISM', { subjectKind: 'COMPANY', intervalMonths: 12, convention: 'ISM Code' }], ['ISPS', 'ISPS verification', 'تحقق ISPS', { subjectKind: 'PORT_FACILITY', intervalMonths: 12, convention: 'ISPS Code' }], ['MLC', 'MLC inspection', 'تفتيش اتفاقية العمل البحري', { subjectKind: 'VESSEL', intervalMonths: 36, convention: 'MLC 2006' }],
    ['HSE', 'HSE inspection', 'تفتيش الصحة والسلامة والبيئة', { subjectKind: 'PORT_FACILITY', intervalMonths: 12, convention: '' }], ['TERMINAL', 'Terminal inspection', 'تفتيش المحطة', { subjectKind: 'PORT_FACILITY', intervalMonths: 12, convention: '' }],
    ['ACCREDITATION', 'Accreditation visit', 'زيارة اعتماد', { subjectKind: 'COMPANY', intervalMonths: 12, convention: '' }], ['MET', 'MET institution audit', 'تدقيق مؤسسة تعليم بحري', { subjectKind: 'MET_INSTITUTION', intervalMonths: 12, convention: 'STCW I/8' }]]);
  return out;
}
