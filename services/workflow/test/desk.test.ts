import { describe, expect, it } from 'vitest';
import { ageBucket, deskDashboard, type DeskRow } from '../src/desk';

const NOW = new Date('2026-09-06T12:00:00Z');
const row = (o: Partial<DeskRow> & { status: string }): DeskRow => ({ category: 'Licensing', definitionKey: 'svc', subjectKind: 'COMPANY', auto: false, infoRequested: false, createdAt: o.submittedAt ?? '2026-08-01T00:00:00Z', submittedAt: null, decidedAt: null, closedAt: null, slaDueAt: null, slaBreachedAt: null, feesTotal: 0, paymentStatus: 'NOT_REQUIRED', paidAt: null, ...o });
const rows: DeskRow[] = [
  row({ status: 'ISSUED', auto: true, submittedAt: '2026-08-01T09:00:00Z', decidedAt: '2026-08-10T09:00:00Z', slaDueAt: '2026-08-15T09:00:00Z', feesTotal: 1000, paymentStatus: 'PAID', paidAt: '2026-08-02T09:00:00Z' }),
  row({ status: 'APPROVED', auto: true, submittedAt: '2026-08-20T09:00:00Z', decidedAt: '2026-08-21T08:00:00Z', slaDueAt: '2026-08-27T09:00:00Z', feesTotal: 500, paymentStatus: 'PAID', paidAt: '2026-09-01T09:00:00Z' }),
  row({ status: 'REJECTED', infoRequested: true, subjectKind: 'VESSEL', submittedAt: '2026-07-01T09:00:00Z', decidedAt: '2026-07-20T09:00:00Z', slaDueAt: '2026-07-08T09:00:00Z' }),
  row({ status: 'UNDER_ASSESSMENT', submittedAt: '2026-08-30T12:00:00Z', slaDueAt: '2026-09-07T12:00:00Z', feesTotal: 700, paymentStatus: 'DUE' }),
  row({ status: 'SUBMITTED', submittedAt: '2026-08-01T12:00:00Z', slaDueAt: '2026-08-08T12:00:00Z', slaBreachedAt: '2026-08-08T12:00:00Z', feesTotal: 300, paymentStatus: 'DUE' }),
  row({ status: 'INFO_REQUESTED', infoRequested: true, submittedAt: '2026-06-01T12:00:00Z', slaDueAt: '2026-06-08T12:00:00Z', slaBreachedAt: '2026-06-08T12:00:00Z' }),
  row({ status: 'ISSUED', submittedAt: '2026-03-01T09:00:00Z', decidedAt: '2026-03-05T09:00:00Z', slaDueAt: '2026-03-08T09:00:00Z', feesTotal: 2000, paymentStatus: 'PAID', paidAt: '2026-03-06T09:00:00Z' }),
  row({ status: 'WITHDRAWN', submittedAt: '2026-08-25T09:00:00Z' }),
  row({ status: 'DRAFT', createdAt: '2026-09-05T09:00:00Z' }),
];

describe('service desk yardsticks', () => {
  const d = deskDashboard(rows, NOW);
  it('ages the open work and sees what is about to breach', () => {
    expect(d.ageing).toEqual([{ bucket: '0–7', count: 1 }, { bucket: '8–14', count: 0 }, { bucket: '15–30', count: 0 }, { bucket: '31–60', count: 1 }, { bucket: '60+', count: 1 }]);
    expect(d.desk.breachedOpen).toBe(2); expect(d.desk.atRisk48h).toBe(1); expect(d.desk.oldestOpenDays).toBe(97);
    expect(d.byStage).toEqual([{ status: 'UNDER_ASSESSMENT', count: 1, breached: 0 }, { status: 'SUBMITTED', count: 1, breached: 1 }, { status: 'INFO_REQUESTED', count: 1, breached: 1 }]);
    expect(ageBucket(7)).toBe('0–7'); expect(ageBucket(61)).toBe('60+');
  });
  it('measures the last ninety days of decisions', () => {
    expect(d.desk.decided90d).toBe(3); expect(d.desk.withinSlaPct90d).toBe(67); expect(d.desk.medianDecisionDays90d).toBe(9); expect(d.desk.avgDecisionDays90d).toBe(9.7);
    expect(d.desk.firstTimeRightPct90d).toBe(67); expect(d.desk.approvalRatePct90d).toBe(67);
    expect(d.desk.autoDecided90d).toBe(2); expect(d.desk.straightThroughPct90d).toBe(50); // one of the two eligible went through within a day
  });
  it('lays the year out and reads the fee position', () => {
    const aug = d.series.find((m) => m.key === '2026-08')!; const jun = d.series.find((m) => m.key === '2026-06')!;
    expect(aug).toMatchObject({ received: 5, decided: 2, issued: 1, breached: 1 }); expect(jun).toMatchObject({ received: 1, breached: 1 });
    expect(d.desk.receivedMtd).toBe(0); expect(d.desk.receivedPrevMonth).toBe(2); // lodged in the same six days of August expect(d.desk.received12m).toBe(8);
    expect(d.desk.feesCollectedMtd).toBe(500); expect(d.desk.feesCollectedYtd).toBe(3500); expect(d.desk.feesOutstanding).toBe(1000); expect(d.desk.feesDueCount).toBe(2);
    expect(d.bySubjectKind[0]).toEqual({ subjectKind: 'COMPANY', total: 8, open: 3 });
  });
  it('is quiet on an empty desk', () => {
    const e = deskDashboard([], NOW);
    expect(e.desk.withinSlaPct90d).toBeNull(); expect(e.desk.medianDecisionDays90d).toBeNull(); expect(e.ageing.every((b) => b.count === 0)).toBe(true);
  });
});
