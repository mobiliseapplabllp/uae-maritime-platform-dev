import { describe, expect, it } from 'vitest';
import { explainLocally, meaningOf, seriesFacts, yardstickFacts } from '../src/explain';

/* The explanation of a dashboard figure is composed from the figures alone: the same rows always give the same facts,
 * every sentence traces to a number on the screen, and the trade's meaning of the measure comes from the glossary. */

const months = [
  { month: 'Apr 26', billed: 6_000_000, collected: 5_800_000 }, { month: 'May 26', billed: 6_400_000, collected: 6_100_000 },
  { month: 'Jun 26', billed: 5_900_000, collected: 6_000_000 }, { month: 'Jul 26', billed: 7_200_000, collected: 6_600_000 },
];

describe('ai-assistant — explaining a figure', () => {
  it('reads a monthly series: where it started, where it ended, its direction, its highest and lowest', () => {
    const facts = seriesFacts(months, 'en');
    expect(facts).toHaveLength(2);
    expect(facts[0]).toBe('billed: 6,000,000 in Apr 26 to 7,200,000 in Jul 26, up 20%; highest 7,200,000 in Jul 26, lowest 5,900,000 in Jun 26; average 6,375,000 over 4 points.');
    expect(facts[1]).toContain('collected: 5,800,000 in Apr 26 to 6,600,000 in Jul 26, up 14%');
    const ar = seriesFacts(months, 'ar');
    expect(ar[0]).toContain('billed: من 6,000,000 في Apr 26 إلى 7,200,000 في Jul 26، ارتفع بنسبة 20%');
  });
  it('reads a breakdown: the total, the largest member and its share, the smallest', () => {
    const facts = seriesFacts([{ bucket: 'Current', amount: 3_889_735, count: 11 }, { bucket: '1–30', amount: 0, count: 0 }, { bucket: '31–60', amount: 1_200_000, count: 3 }], 'en');
    expect(facts[0]).toBe('amount: 5,089,735 in total across 3 entries; largest Current at 3,889,735 (76.4%), smallest 1–30 at 0.');
    expect(facts[1]).toContain('count: 14 in total across 3 entries; largest Current at 11');
  });
  it('judges a yardstick against its target, reading the direction from the target label', () => {
    expect(yardstickFacts('11.4 h', 'target ≤ 4 h', 'en')).toEqual(['The reading of 11.4 h is off target (target ≤ 4 h) by 7.4, 185% of the target.']);
    expect(yardstickFacts('100%', 'target ≥ 85%', 'en')).toEqual(['The reading of 100% is on target (target ≥ 85%).']);
    expect(yardstickFacts('41 d', 'target ≤ 40 d', 'ar')[0]).toContain('خارج الهدف');
    expect(yardstickFacts('—', 'target ≤ 4 h', 'en')).toEqual([]);
  });
  it('knows the trade\'s meaning of the measure from the words of the title, in both languages', () => {
    expect(meaningOf('Days sales outstanding', undefined, 'en')).toContain('how many days, on average, an invoice stays unpaid');
    expect(meaningOf('Berth occupancy, 30 d', undefined, 'ar')).toContain('إشغال الأرصفة');
    expect(meaningOf('Something the glossary never heard of', undefined, 'en')).toBeNull();
    expect(meaningOf('Cargo throughput', 'metric tonnes handled per month', 'en')).toContain('Throughput');
  });
  it('composes the whole explanation: the card, the facts, the meaning and the footer, and keeps the figures as grounding', () => {
    const e = explainLocally({ kind: 'chart', title: 'Billed revenue', sub: 'issued invoices per month, AED', data: months, period: 'trailing 12 months' });
    expect(e.text.startsWith('“Billed revenue” — issued invoices per month, AED (trailing 12 months).')).toBe(true);
    expect(e.text).toContain('billed: 6,000,000 in Apr 26 to 7,200,000 in Jul 26, up 20%');
    expect(e.text).toContain('Billed is what was invoiced in the period');
    expect(e.text.endsWith('Composed from the figures on the screen; nothing is invented.')).toBe(true);
    expect(e.facts).toHaveLength(2); expect(e.meaning).toContain('Billed');
    expect(e.grounding).toEqual([{ label: 'Billed revenue', kind: 'chart', text: JSON.stringify(months) }]);
  });
  it('explains a stat and a yardstick from their own value, and a nested answer from its richest list and its scalars', () => {
    const stat = explainLocally({ kind: 'stat', title: 'Avg turnaround, 30 d', value: '46 h', sub: 'median 47 h · 32.6 h alongside', language: 'ar' });
    expect(stat.text).toContain('تقرأ البطاقة 46 h.'); expect(stat.text).toContain('زمن الدوران'); expect(stat.grounding[0].text).toContain('"value":"46 h"');
    const yard = explainLocally({ kind: 'yardstick', title: 'Anchorage waiting, avg', value: '11.4 h', target: 'target ≤ 4 h', sub: '13% of calls within target' });
    expect(yard.facts[0]).toContain('off target'); expect(yard.text).toContain('Anchorage waiting is the time a ship spends at anchor');
    const nested = explainLocally({ kind: 'panel', title: 'Berth downtime', data: { estate: { berths: 24, outages: 146, availabilityPct: 90.3 }, series: [{ month: '2026-07', days: 56.9 }, { month: '2026-08', days: 40.2 }], berths: [{ code: 'LB-1', days: 72 }, { code: 'LB-2', days: 30 }, { code: 'CB-1', days: 12 }] } });
    expect(nested.facts[0].startsWith('berths: days: 114 in total across 3 entries; largest LB-1 at 72')).toBe(true);
    expect(nested.facts[1]).toContain('series: days: 56.9 in 2026-07 to 40.2 in 2026-08, down 29%');
    expect(nested.facts[2]).toBe('The figures behind the card: estate berths: 24; estate outages: 146; estate availability pct: 90.3.');
    expect(explainLocally({ kind: 'list', title: 'Nothing here' }).text).toContain('The card carries no figures to read yet.');
  });
});
