import { describe, expect, it } from 'vitest';
import { studioDashboard, type StudioInput } from '../src/studio';

/* Two small masters, three golden vessels and two companies, arranged so every dimension has something to say. */
const NOW = new Date('2026-09-06T12:00:00Z');
const lk = (category: string, code: string, label: string, labelAr: string | null, updatedAt = '2026-09-01T00:00:00Z', active = true) => ({ category, code, label, labelAr, active, updatedAt, createdAt: updatedAt });
const input: StudioInput = {
  lookups: [
    lk('port', 'AEJEA', 'Jebel Ali', 'جبل علي'), lk('port', 'AEKLF', 'Khalifa Port', 'ميناء خليفة'), lk('port', 'AEFJR', 'Fujairah', null), lk('port', 'AEDXB', 'Fujairah', 'الفجيرة'), // one missing Arabic, one duplicate label
    lk('cargoType', 'CONTAINERS', 'Containers', 'حاويات', '2025-12-01T00:00:00Z'), lk('cargoType', 'bad code!', 'Coal', 'فحم', '2025-12-01T00:00:00Z'), lk('cargoType', 'GRAIN', '', 'حبوب', '2025-12-01T00:00:00Z', false), // malformed code, empty label, inactive; master untouched for nine months
  ],
  vessels: [
    { imo: '9000001', mmsi: '470000001', callSign: 'A6AA', flag: 'AE', type: 'CONTAINER', built: 2015, dwt: 50000, grt: 40000, loa: 250, owner: 'Owner', operator: 'Op', classSociety: 'DNV', status: 'ACTIVE', recordStatus: 'PUBLISHED', updatedAt: '2026-09-01T00:00:00Z' },
    { imo: '9000002', mmsi: null, callSign: null, flag: 'AE', type: 'TANKER', built: 2010, dwt: 0, grt: null, loa: null, owner: 'Owner', operator: null, classSociety: null, status: 'ACTIVE', recordStatus: 'DRAFT', updatedAt: '2026-09-01T00:00:00Z' },
  ],
  companies: [
    { code: 'GSS', name: 'Gulf Star', nameAr: 'جلف ستار', category: 'AGENCY', taxId: '100', registrationNo: 'R1', hasContacts: true, status: 'ACTIVE', recordStatus: 'PUBLISHED', updatedAt: '2026-09-01T00:00:00Z' },
    { code: 'OAP', name: 'Oceanic', nameAr: null, category: 'AGENCY', taxId: null, registrationNo: null, hasContacts: false, status: 'ACTIVE', recordStatus: 'PUBLISHED', updatedAt: '2026-09-01T00:00:00Z' },
  ],
  settings: [{ key: 'org', updatedAt: '2026-09-05T00:00:00Z', updatedBy: 'Ashish Sharma' }, { key: 'module:ops', updatedAt: '2026-06-01T00:00:00Z', updatedBy: 'seed' }],
};

describe('data studio dashboard', () => {
  const d = studioDashboard(input, NOW, { staleDays: 180 });
  it('counts the masters and grades each on its own', () => {
    expect(d.kpis.masters).toBe(2); expect(d.kpis.entries).toBe(7); expect(d.kpis.active).toBe(6); expect(d.kpis.inactive).toBe(1);
    const port = d.masters.find((m) => m.category === 'port')!; const cargo = d.masters.find((m) => m.category === 'cargoType')!;
    expect(port).toMatchObject({ entries: 4, arabicPct: 75, duplicates: 1, invalid: 0, stale: false });
    expect(cargo).toMatchObject({ entries: 3, arabicPct: 100, duplicates: 0, invalid: 2, stale: true, grade: 'C' });
    expect(d.kpis.staleMasters).toBe(1); expect(d.kpis.duplicates).toBe(1); expect(d.kpis.invalid).toBe(2);
  });
  it('scores the dimensions the discipline uses, plus the bilingual one this platform owes', () => {
    const score = (name: string) => d.dimensions.find((x) => x.dimension === name)!.score;
    expect(score('Bilingual')).toBe(86); // six of seven values carry an Arabic label
    expect(score('Uniqueness')).toBe(86); expect(score('Validity')).toBe(71); expect(score('Timeliness')).toBe(50);
    expect(d.kpis.vesselCompletenessPct).toBe(71); // 12/12 and 5/12 key fields
    expect(d.kpis.companyCompletenessPct).toBe(60); // 5/5 and 1/5
    expect(score('Completeness')).toBe(66); expect(d.kpis.qualityScore).toBe(72); expect(d.kpis.grade).toBe('C');
  });
  it('reads the golden records and the settings trail', () => {
    expect(d.kpis.goldenVessels).toBe(2); expect(d.kpis.goldenCompanies).toBe(2); expect(d.kpis.pendingRecords).toBe(1);
    expect(d.recentSettings).toEqual([{ key: 'org', updatedAt: '2026-09-05T00:00:00.000Z', updatedBy: 'Ashish Sharma' }]); expect(d.kpis.settingsChanged30d).toBe(1);
    expect(d.weakest[0].category).toBe('cargoType');
  });
  it('is whole on an empty studio', () => {
    const e = studioDashboard({ lookups: [], vessels: [], companies: [], settings: [] }, NOW);
    expect(e.kpis.qualityScore).toBe(100); expect(e.masters).toEqual([]); expect(e.kpis.grade).toBe('A');
  });
});
