import { describe, expect, it } from 'vitest';
import { registerTrends, type DashboardRow } from '../src/instruments';

const NOW = new Date('2026-09-06T12:00:00Z');
const row = (o: Partial<DashboardRow> & { id: string; issued_date: Date }): DashboardRow => ({ ref_no: o.id, title: o.id, type: 'CIRCULAR', category: 'Port operations', status: 'IN_FORCE', effective_date: null, expiry_date: null, ack_required: false, acks: 0, recipients: 0, reviewed_at: null, cleared_at: null, drafted_by: '', ...o });
const rows: DashboardRow[] = [
  row({ id: 'c1', issued_date: new Date('2026-09-02') }), row({ id: 'n1', type: 'NOTICE', issued_date: new Date('2026-08-15') }), row({ id: 'r1', type: 'RULES', issued_date: new Date('2026-08-20') }),
  row({ id: 'd1', status: 'DRAFT', issued_date: new Date('2026-09-01') }), row({ id: 'old', type: 'ACT', issued_date: new Date('2019-03-01') }), row({ id: 'conv', type: 'CONVENTION', issued_date: new Date('1974-11-01') }),
  row({ id: 'gone', status: 'SUPERSEDED', issued_date: new Date('2015-01-01') }),
];

describe('register trends', () => {
  const t = registerTrends(rows, { acksByMonth: [{ key: '2026-09', acks: 40, avgDays: 3.5, within: 38 }, { key: '2026-08', acks: 60, avgDays: 9, within: 30 }], acks12m: 100, avgDays: 6.8, withinDuePct: 68 }, NOW);
  it('lays issuance out month by month, drafts excluded, with the acknowledgements alongside', () => {
    expect(t.byMonth).toHaveLength(12);
    expect(t.byMonth[11]).toMatchObject({ key: '2026-09', issued: 1, circulars: 1, notices: 0, other: 0, acknowledgements: 40 });
    expect(t.byMonth[10]).toMatchObject({ key: '2026-08', issued: 2, notices: 1, other: 1, acknowledgements: 60 });
    expect(t.issued12m).toBe(3);
  });
  it('reports the review age of the law in force', () => {
    expect(t.currency).toMatchObject({ inForce: 5, olderThanReview: 2, olderThanReviewPct: 40, reviewYears: 5 });
    expect(t.reviewList.map((r) => r.refNo)).toEqual(['conv', 'old']); expect(t.reviewList[1].ageYears).toBe(7.5);
    expect(t.acknowledgements).toEqual({ acks12m: 100, avgDays: 6.8, withinDuePct: 68 });
  });
  it('copes without acknowledgement statistics', () => {
    const e = registerTrends([], null, NOW);
    expect(e.byMonth.every((m) => m.issued === 0 && m.acknowledgements === 0)).toBe(true); expect(e.currency.olderThanReviewPct).toBe(0); expect(e.acknowledgements.avgDays).toBeNull();
  });
});
