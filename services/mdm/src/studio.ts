/* The Data Studio dashboard: the state of the reference data every other module validates against, read across the
 * masters, the golden records and the settings.
 *
 * Data quality is measured on the dimensions the discipline uses — completeness, uniqueness, validity, timeliness — and
 * a fifth this bilingual platform owes its users: whether every value carries its Arabic label. Each master is graded
 * on its own and the platform on the whole, so a steward can see which list needs work rather than that "data quality"
 * is a number. */
type Instant = Date | string | number | null | undefined;
export interface StudioLookup { category: string; code: string; label: string; labelAr: string | null; active: boolean; updatedAt: Instant; createdAt: Instant }
export interface StudioVessel { imo: string; mmsi: string | null; callSign: string | null; flag: string | null; type: string | null; built: number | null; dwt: number | null; grt: number | null; loa: number | null; owner: string | null; operator: string | null; classSociety: string | null; status: string; recordStatus: string; updatedAt: Instant }
export interface StudioCompany { code: string; name: string; nameAr: string | null; category: string | null; taxId: string | null; registrationNo: string | null; hasContacts: boolean; status: string; recordStatus: string; updatedAt: Instant }
export interface StudioSetting { key: string; updatedAt: Instant; updatedBy: string | null }
export interface StudioInput { lookups: StudioLookup[]; vessels: StudioVessel[]; companies: StudioCompany[]; settings: StudioSetting[] }
export interface StudioPolicy { staleDays: number }
const D = 86_400_000;
const CODE_RE = /^[A-Za-z0-9][A-Za-z0-9_.:/-]*$/;
const ms = (d: Instant) => (d == null || d === '' ? NaN : new Date(d).getTime());
const has = (d: Instant) => !Number.isNaN(ms(d));
const iso = (d: Instant) => (has(d) ? new Date(ms(d)).toISOString() : null);
const pct = (part: number, whole: number) => (whole ? Math.round((part / whole) * 100) : 100);
const filled = (v: unknown) => v != null && String(v).trim() !== '' && Number(v) !== 0 || (typeof v === 'number' && v !== 0);
const VESSEL_KEYS: (keyof StudioVessel)[] = ['imo', 'mmsi', 'callSign', 'flag', 'type', 'built', 'dwt', 'grt', 'loa', 'owner', 'operator', 'classSociety'];
const grade = (score: number) => (score >= 95 ? 'A' : score >= 85 ? 'B' : score >= 70 ? 'C' : 'D');

export function studioDashboard(input: StudioInput, now = new Date(), policy: StudioPolicy = { staleDays: 180 }) {
  const t = now.getTime(); const d30 = t - 30 * D; const stale = t - policy.staleDays * D;
  const { lookups, vessels, companies, settings } = input;
  const cats = new Map<string, StudioLookup[]>();
  for (const l of lookups) { const list = cats.get(l.category); if (list) list.push(l); else cats.set(l.category, [l]); }
  const masters = [...cats].map(([category, list]) => {
    const arabic = list.filter((l) => l.labelAr && l.labelAr.trim()).length;
    const labels = new Map<string, number>(); for (const l of list) { const k = l.label.trim().toLowerCase(); labels.set(k, (labels.get(k) ?? 0) + 1); }
    const duplicates = [...labels.values()].filter((n) => n > 1).reduce((s, n) => s + n - 1, 0);
    const invalid = list.filter((l) => !CODE_RE.test(l.code) || !l.label.trim()).length;
    const updatedAt = list.reduce<number>((m, l) => Math.max(m, has(l.updatedAt) ? ms(l.updatedAt) : 0), 0);
    const completeness = pct(arabic, list.length); const uniqueness = pct(list.length - duplicates, list.length); const validity = pct(list.length - invalid, list.length);
    const score = Math.round((completeness + uniqueness + validity) / 3);
    return { category, entries: list.length, active: list.filter((l) => l.active).length, arabicPct: completeness, duplicates, invalid, updatedAt: updatedAt ? new Date(updatedAt).toISOString() : null, ageDays: updatedAt ? Math.floor((t - updatedAt) / D) : null, stale: !updatedAt || updatedAt < stale, score, grade: grade(score) };
  }).sort((a, b) => b.entries - a.entries || a.category.localeCompare(b.category));
  const entries = lookups.length;
  const arabicAll = lookups.filter((l) => l.labelAr && l.labelAr.trim()).length;
  const duplicatesAll = masters.reduce((s, m) => s + m.duplicates, 0); const invalidAll = masters.reduce((s, m) => s + m.invalid, 0);
  const fresh = masters.filter((m) => !m.stale).length;
  const vesselScore = vessels.length ? Math.round(vessels.reduce((s, v) => s + VESSEL_KEYS.filter((k) => filled(v[k])).length / VESSEL_KEYS.length, 0) / vessels.length * 100) : 100;
  const companyScore = companies.length ? Math.round(companies.reduce((s, c) => s + [c.nameAr, c.taxId, c.registrationNo, c.category].filter(filled).length + (c.hasContacts ? 1 : 0), 0) / (companies.length * 5) * 100) : 100;
  const dimensions = [
    { dimension: 'Completeness', score: Math.round((vesselScore + companyScore) / 2), detail: `golden vessels ${vesselScore}%, companies ${companyScore}% of key fields filled` },
    { dimension: 'Bilingual', score: pct(arabicAll, entries), detail: `${arabicAll} of ${entries} master values carry an Arabic label` },
    { dimension: 'Uniqueness', score: pct(entries - duplicatesAll, entries), detail: `${duplicatesAll} duplicate labels within a master` },
    { dimension: 'Validity', score: pct(entries - invalidAll, entries), detail: `${invalidAll} values with a malformed code or an empty label` },
    { dimension: 'Timeliness', score: pct(fresh, masters.length), detail: `${fresh} of ${masters.length} masters touched within ${policy.staleDays} days` },
  ];
  const quality = Math.round(dimensions.reduce((s, d) => s + d.score, 0) / dimensions.length);
  const recentSettings = settings.filter((s) => has(s.updatedAt) && ms(s.updatedAt) >= d30).sort((a, b) => ms(b.updatedAt) - ms(a.updatedAt)).slice(0, 10)
    .map((s) => ({ key: s.key, updatedAt: iso(s.updatedAt), updatedBy: s.updatedBy ?? '' }));
  return {
    kpis: {
      masters: masters.length, entries, active: lookups.filter((l) => l.active).length, inactive: lookups.filter((l) => !l.active).length,
      arabicPct: pct(arabicAll, entries), duplicates: duplicatesAll, invalid: invalidAll, staleMasters: masters.length - fresh, staleDays: policy.staleDays,
      updated30d: lookups.filter((l) => has(l.updatedAt) && ms(l.updatedAt) >= d30).length,
      goldenVessels: vessels.length, goldenCompanies: companies.length, vesselCompletenessPct: vesselScore, companyCompletenessPct: companyScore,
      pendingRecords: vessels.filter((v) => v.recordStatus !== 'PUBLISHED').length + companies.filter((c) => c.recordStatus !== 'PUBLISHED').length,
      settingsChanged30d: recentSettings.length, qualityScore: quality, grade: grade(quality),
    },
    dimensions, masters, recentSettings,
    weakest: masters.filter((m) => m.grade !== 'A').sort((a, b) => a.score - b.score).slice(0, 8),
    generatedAt: now.toISOString(),
  };
}
export type StudioDashboard = ReturnType<typeof studioDashboard>;
