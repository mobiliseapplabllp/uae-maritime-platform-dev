/** Everything that changes when the platform is deployed for a different maritime administration lives in one profile.
 * Figures that cannot be cited are marked `confirmed: false` so they surface as unverified rather than passing as fact. */
export interface Sourced<T> { value: T; confirmed: boolean; source: string }
export interface PortOfRegistry { code: string; name: string; region: string; default?: boolean }
export interface JurisdictionProfile {
  code: string; name: string; authority: string; regulatorNote: string;
  pscRegime: { code: string; name: string };
  currency: { code: string; symbol: string; locale: string; grouping: 'standard' | 'lakh-crore'; minorUnits: number };
  tax: { name: string; ratePct: number; registrationLabel: string; invoicePrefix: string };
  timezone: string; languages: string[];
  workingWeek: { weekend: string[]; note: string };
  identity: { seafarerIdLabel: string; nationalIdLabel: string; companyIdLabel: string };
  registry: {
    registrar: string; statute: Sourced<string>; portsOfRegistry: PortOfRegistry[]; defaultPort: string;
    shareDenominator: Sourced<number>; maxRegisteredOwners: Sourced<number>; provisionalValidityMonths: Sourced<number>;
    officialNumberBase: number; nationalityRule: string;
  };
  benchmarks: Record<string, Sourced<number | number[]>>;
}

export const UAE: JurisdictionProfile = {
  code: 'AE',
  name: 'United Arab Emirates',
  authority: 'Ministry of Energy and Infrastructure — Maritime Sector (federal maritime administration and flag state)',
  regulatorNote: 'Federal maritime administration; Riyadh MoU member for port state control; Paris and Tokyo MoU histories used as risk inputs.',
  pscRegime: { code: 'RMOU', name: 'Riyadh MoU' },
  currency: { code: 'AED', symbol: 'AED', locale: 'en-AE', grouping: 'standard', minorUnits: 2 },
  tax: { name: 'VAT', ratePct: 5, registrationLabel: 'TRN', invoicePrefix: 'MAR/INV' },
  timezone: 'Asia/Dubai',
  languages: ['en', 'ar'],
  workingWeek: { weekend: ['Saturday', 'Sunday'], note: 'Federal working week Monday to Friday; public holidays from the holiday master' },
  identity: { seafarerIdLabel: 'SID', nationalIdLabel: 'Emirates ID', companyIdLabel: 'Trade licence' },
  registry: {
    registrar: 'Registrar of Ships',
    statute: { value: 'Federal Decree-Law on Maritime Law (2023) and its implementing decisions', confirmed: false,
      source: 'VERIFY the instrument reference and article numbers with the authority before go-live.' },
    portsOfRegistry: [
      { code: 'AUH', name: 'Abu Dhabi', region: 'Abu Dhabi', default: true },
      { code: 'DXB', name: 'Dubai', region: 'Dubai' },
      { code: 'SHJ', name: 'Sharjah', region: 'Sharjah' },
      { code: 'AJM', name: 'Ajman', region: 'Ajman' },
      { code: 'UAQ', name: 'Umm Al Quwain', region: 'Umm Al Quwain' },
      { code: 'RAK', name: 'Ras Al Khaimah', region: 'Ras Al Khaimah' },
      { code: 'FJR', name: 'Fujairah', region: 'Fujairah' },
      { code: 'KLF', name: 'Khor Fakkan', region: 'Sharjah' },
    ],
    defaultPort: 'AUH',
    shareDenominator: { value: 24, confirmed: false, source: 'VERIFY — division of ownership shares in a ship under the Maritime Law.' },
    maxRegisteredOwners: { value: 24, confirmed: false, source: 'VERIFY — maximum persons registered as owners at one time.' },
    provisionalValidityMonths: { value: 6, confirmed: false, source: 'VERIFY — provisional certificate of registry validity.' },
    officialNumberBase: 700001,
    nationalityRule: 'A UAE ship must satisfy the ownership and nationality conditions of the Maritime Law and the decisions issued under it (to be confirmed with the authority).',
  },
  benchmarks: {
    turnaroundHours: { value: 36, confirmed: false, source: 'VERIFY — Gulf port turnaround benchmark, source to be cited at design.' },
    preBerthingWaitHours: { value: 4, confirmed: false, source: 'VERIFY — pre-berthing wait benchmark.' },
    pscDetentionRatePct: { value: 3.0, confirmed: false, source: 'VERIFY — Riyadh MoU annual report detention rate.' },
    berthOccupancyHealthyPct: { value: [40, 70], confirmed: true, source: 'UNCTAD guidance band for healthy berth occupancy before congestion risk' },
    collectionEfficiencyPct: { value: 95, confirmed: true, source: 'Standard receivables collection target (industry norm)' },
  },
};

export const INDIA: JurisdictionProfile = {
  code: 'IN',
  name: 'India',
  authority: 'Directorate General of Shipping',
  regulatorNote: 'Merchant Shipping Act 1958; Indian Ports Act 1908. Kept for parity checks against the reference product.',
  pscRegime: { code: 'IOMOU', name: 'Indian Ocean MoU' },
  currency: { code: 'INR', symbol: '₹', locale: 'en-IN', grouping: 'lakh-crore', minorUnits: 2 },
  tax: { name: 'GST', ratePct: 18, registrationLabel: 'GSTIN', invoicePrefix: 'REF/INV' },
  timezone: 'Asia/Kolkata',
  languages: ['en', 'hi'],
  workingWeek: { weekend: ['Sunday'], note: 'Sunday weekend; national and state holidays from the holiday master' },
  identity: { seafarerIdLabel: 'INDoS', nationalIdLabel: 'PAN', companyIdLabel: 'CIN' },
  registry: {
    registrar: 'Registrar of Indian Ships',
    statute: { value: 'Merchant Shipping Act 1958, Part V (ss. 20-73)', confirmed: true, source: 'Merchant Shipping Act 1958' },
    portsOfRegistry: [
      { code: 'NSA', name: 'Nhava Sheva', region: 'Maharashtra', default: true }, { code: 'MUM', name: 'Mumbai', region: 'Maharashtra' },
      { code: 'KOL', name: 'Kolkata', region: 'West Bengal' }, { code: 'CHN', name: 'Chennai', region: 'Tamil Nadu' },
      { code: 'KOC', name: 'Kochi', region: 'Kerala' }, { code: 'MRM', name: 'Mormugao', region: 'Goa' },
      { code: 'VTZ', name: 'Visakhapatnam', region: 'Andhra Pradesh' }, { code: 'MRM', name: 'Mormugao', region: 'Goa' },
      { code: 'PRP', name: 'Paradip', region: 'Odisha' }, { code: 'PBL', name: 'Port Blair', region: 'Andaman & Nicobar Islands' },
      { code: 'TUT', name: 'Tuticorin', region: 'Tamil Nadu' },
    ],
    defaultPort: 'NSA',
    shareDenominator: { value: 10, confirmed: false, source: 'Merchant Shipping Act 1958 s.32 — VERIFY against the section in force.' },
    maxRegisteredOwners: { value: 10, confirmed: false, source: 'Merchant Shipping Act 1958 s.32 — VERIFY before go-live.' },
    provisionalValidityMonths: { value: 6, confirmed: true, source: 'Merchant Shipping Act 1958 — provisional certificate of registry, six months from issue' },
    officialNumberBase: 900001,
    nationalityRule: 'An Indian ship must be owned wholly by Indian citizens, by a company or body established under Indian law with its principal place of business in India, or by a co-operative society registered in India (Merchant Shipping Act 1958 s.21).',
  },
  benchmarks: {
    turnaroundHours: { value: 50.4, confirmed: true, source: 'Indian major ports average ship turnaround ~2.1 days FY2023-24 — Ministry of Ports, Shipping & Waterways / IPA' },
    outputPerShipBerthDayMt: { value: 16500, confirmed: true, source: 'Average output per ship-berth-day, Indian major ports FY2023-24 — IPA' },
    preBerthingWaitHours: { value: 5.0, confirmed: true, source: 'Average pre-berthing detention on port account, major ports FY2023-24 — IPA' },
    idleTimeAtBerthPct: { value: 18.0, confirmed: true, source: 'Idle time as a share of time at berth, Indian major ports — IPA' },
    pscDetentionRatePct: { value: 5.6, confirmed: true, source: 'Indian Ocean MoU regional PSC detention rate, 2023 annual report' },
    berthOccupancyHealthyPct: { value: [40, 70], confirmed: true, source: 'UNCTAD guidance band for healthy berth occupancy before congestion risk' },
    collectionEfficiencyPct: { value: 95, confirmed: true, source: 'Standard commercial port receivables collection target (industry norm)' },
  },
};

export const JURISDICTIONS: Record<string, JurisdictionProfile> = { AE: UAE, IN: INDIA };
export const DEFAULT_JURISDICTION = 'AE';
export const getJurisdiction = (code?: string | null): JurisdictionProfile =>
  JURISDICTIONS[String(code || DEFAULT_JURISDICTION).toUpperCase()] ?? UAE;
export const unconfirmedFigures = (code?: string) => {
  const p = getJurisdiction(code);
  const out: { key: string; source: string }[] = [];
  for (const [k, b] of Object.entries(p.benchmarks)) if (!b.confirmed) out.push({ key: `benchmarks.${k}`, source: b.source });
  for (const k of ['statute', 'shareDenominator', 'maxRegisteredOwners', 'provisionalValidityMonths'] as const) {
    const s = p.registry[k] as Sourced<unknown>;
    if (!s.confirmed) out.push({ key: `registry.${k}`, source: s.source });
  }
  return out;
};
