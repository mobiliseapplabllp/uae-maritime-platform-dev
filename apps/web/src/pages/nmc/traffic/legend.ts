/* The legend the map draws by and the words the card uses. Colours follow the trade's convention so an officer used
 * to any traffic picture reads this one at a glance: cargo green, tankers red, passenger blue, high-speed yellow,
 * tugs and special craft cyan, fishing orange, pleasure craft magenta, the rest grey. */
export type Category = 'cargo' | 'tanker' | 'passenger' | 'highspeed' | 'tug' | 'fishing' | 'pleasure' | 'other';
export const CATEGORIES: Category[] = ['cargo', 'tanker', 'passenger', 'highspeed', 'tug', 'fishing', 'pleasure', 'other'];
export const CATEGORY_COLOR: Record<Category, string> = { cargo: '#2E9E4F', tanker: '#D93B3B', passenger: '#2F6FE0', highspeed: '#E5B800', tug: '#22B8CF', fishing: '#F2861F', pleasure: '#C83BC8', other: '#8A96A3' };
export const CATEGORY_LABEL: Record<Category, string> = { cargo: 'Cargo', tanker: 'Tanker', passenger: 'Passenger', highspeed: 'High-speed craft', tug: 'Tug & special craft', fishing: 'Fishing', pleasure: 'Pleasure craft', other: 'Other' };
export const NAV_LABEL: Record<string, string> = {
  UNDER_WAY: 'Underway using engine', UNDERWAY: 'Underway using engine', UNDER_WAY_SAILING: 'Underway sailing', AT_ANCHOR: 'At anchor', MOORED: 'Moored', NOT_UNDER_COMMAND: 'Not under command',
  RESTRICTED: 'Restricted manoeuvrability', CONSTRAINED_BY_DRAUGHT: 'Constrained by draught', AGROUND: 'Aground', FISHING: 'Engaged in fishing', TOWING_ASTERN: 'Towing astern', PUSHING_AHEAD: 'Pushing ahead', AIS_SART: 'AIS-SART', UNDEFINED: 'Not reported',
};
export const navLabel = (s?: string | null) => NAV_LABEL[String(s ?? '').toUpperCase()] ?? String(s ?? '').replace(/_/g, ' ').toLowerCase().replace(/^\w/, (c) => c.toUpperCase());
/** A stationary ship is a dot, a moving one an arrow — the picture's oldest convention. */
export const isMoving = (sog: number, navStatus?: string | null) => sog >= 0.5 && !['MOORED', 'AT_ANCHOR', 'AGROUND'].includes(String(navStatus ?? '').toUpperCase());
/** ISO country code → the flag emoji, which every modern browser draws. */
export const flagEmoji = (iso?: string | null) => { const c = String(iso ?? '').toUpperCase(); return /^[A-Z]{2}$/.test(c) ? String.fromCodePoint(...[...c].map((ch) => 0x1f1e6 + ch.charCodeAt(0) - 65)) : ''; };
const COUNTRY: Record<string, string> = { AE: 'United Arab Emirates', IN: 'India', PA: 'Panama', LR: 'Liberia', MH: 'Marshall Islands', SG: 'Singapore', MT: 'Malta', HK: 'Hong Kong', BS: 'Bahamas', GR: 'Greece', CN: 'China', JP: 'Japan', KR: 'Korea', GB: 'United Kingdom', NO: 'Norway', DK: 'Denmark', DE: 'Germany', NL: 'Netherlands', FR: 'France', IT: 'Italy', TR: 'Türkiye', SA: 'Saudi Arabia', QA: 'Qatar', KW: 'Kuwait', BH: 'Bahrain', OM: 'Oman', IR: 'Iran', PK: 'Pakistan', LK: 'Sri Lanka', BD: 'Bangladesh', MY: 'Malaysia', ID: 'Indonesia', PH: 'Philippines', VN: 'Viet Nam', US: 'United States', CY: 'Cyprus', PT: 'Portugal', AG: 'Antigua and Barbuda', VC: 'Saint Vincent and the Grenadines', KM: 'Comoros', TZ: 'Tanzania', TG: 'Togo', SL: 'Sierra Leone', BZ: 'Belize', BM: 'Bermuda', KY: 'Cayman Islands', GI: 'Gibraltar', IM: 'Isle of Man', EG: 'Egypt', RU: 'Russia', TW: 'Taiwan', TH: 'Thailand', AU: 'Australia', NZ: 'New Zealand', ZA: 'South Africa', KE: 'Kenya', DJ: 'Djibouti', YE: 'Yemen', IQ: 'Iraq', JO: 'Jordan', MV: 'Maldives', SC: 'Seychelles', MU: 'Mauritius', ES: 'Spain', BE: 'Belgium', SE: 'Sweden', FI: 'Finland', PL: 'Poland', UA: 'Ukraine', RO: 'Romania', BG: 'Bulgaria', HR: 'Croatia', LU: 'Luxembourg', CH: 'Switzerland', MC: 'Monaco', IL: 'Israel', LB: 'Lebanon', SY: 'Syria', TN: 'Tunisia', MA: 'Morocco', DZ: 'Algeria', LY: 'Libya', NG: 'Nigeria', GH: 'Ghana', CM: 'Cameroon', AO: 'Angola', MZ: 'Mozambique', MG: 'Madagascar', BR: 'Brazil', AR: 'Argentina', CL: 'Chile', MX: 'Mexico', CA: 'Canada', CU: 'Cuba', VU: 'Vanuatu', TV: 'Tuvalu', PW: 'Palau', KH: 'Cambodia', MM: 'Myanmar', ET: 'Ethiopia', SD: 'Sudan', ER: 'Eritrea', SO: 'Somalia' };
export const countryName = (iso?: string | null) => COUNTRY[String(iso ?? '').toUpperCase()] ?? String(iso ?? '');
/** "6 hours, 2 minutes ago" — the card's own clock. */
export function ageWords(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return 'never';
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s} seconds ago`;
  const m = Math.floor(s / 60); if (m < 60) return `${m} minute${m === 1 ? '' : 's'} ago`;
  const h = Math.floor(m / 60); const mm = m % 60; if (h < 48) return `${h} hour${h === 1 ? '' : 's'}${mm ? `, ${mm} minute${mm === 1 ? '' : 's'}` : ''} ago`;
  const d = Math.floor(h / 24); return `${d} days ago`;
}
export const fmtCoord = (lat: number, lon: number) => `${Math.abs(lat).toFixed(4)}° ${lat >= 0 ? 'N' : 'S'}, ${Math.abs(lon).toFixed(4)}° ${lon >= 0 ? 'E' : 'W'}`;
/** The ship's silhouette by class — a drawn side profile, so every target has a picture and none is a photograph of a real ship. */
export const SILHOUETTE: Record<Category, string> = {
  cargo: 'M6 46 L18 62 H122 L134 46 H120 V38 H112 V30 H92 V38 H84 V30 H64 V38 H56 V30 H36 V38 H28 V46 Z M96 22 H108 V38 H96 Z',
  tanker: 'M6 46 L18 62 H122 L134 46 H124 V41 H30 V46 Z M104 24 H118 V41 H104 Z M40 34 H92 V41 H40 Z M60 30 H72 V34 H60 Z',
  passenger: 'M6 48 L16 62 H124 L134 48 Z M22 40 H118 V48 H22 Z M30 30 H110 V40 H30 Z M40 22 H100 V30 H40 Z M70 16 H90 V22 H70 Z',
  highspeed: 'M4 50 L24 62 H126 L134 46 L100 46 L92 40 H60 L52 46 H4 Z M62 30 H92 V40 H62 Z',
  tug: 'M10 48 L20 62 H96 L112 48 H80 V36 H60 V30 H50 V36 H40 V48 Z M46 22 H58 V30 H46 Z',
  fishing: 'M10 48 L20 62 H100 L118 46 H86 V40 H72 V34 H62 V40 H46 V48 Z M96 30 L100 46 H92 Z',
  pleasure: 'M14 50 L26 62 H98 L120 50 H84 V44 H50 V50 Z M62 8 L66 44 H58 Z M60 20 L100 44 H62 Z',
  other: 'M6 46 L18 62 H122 L134 46 H118 V38 H36 V46 Z M88 26 H104 V38 H88 Z',
};
