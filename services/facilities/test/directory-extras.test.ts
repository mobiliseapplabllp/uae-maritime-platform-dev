import { describe, expect, it } from 'vitest';
import { directoryExtras } from '../src/directory';

const NOW = new Date('2026-09-06T12:00:00Z'); const D = 86_400_000;
const at = (days: number) => new Date(NOW.getTime() + days * D).toISOString();
describe('directory extras', () => {
  const x = directoryExtras({
    instruments: [
      { status: 'ISSUED', instrumentClass: 'LICENCE', expiryDate: at(20), appliedDate: at(-400), issueDate: at(-345) }, { status: 'ISSUED', instrumentClass: 'LICENCE', expiryDate: at(50), appliedDate: null, issueDate: at(-700) },
      { status: 'ISSUED', instrumentClass: 'CERTIFICATE', expiryDate: at(80), appliedDate: null, issueDate: at(-10) }, { status: 'ISSUED', instrumentClass: 'CERTIFICATE', expiryDate: at(-3), appliedDate: null, issueDate: at(-800) },
      { status: 'APPLIED', instrumentClass: 'LICENCE', expiryDate: null, appliedDate: at(-12), issueDate: null }, { status: 'UNDER_REVIEW', instrumentClass: 'LICENCE', expiryDate: null, appliedDate: at(-30), issueDate: null },
      { status: 'SUSPENDED', instrumentClass: 'ACCREDITATION', expiryDate: at(200), appliedDate: null, issueDate: at(-100) },
    ],
    obligations: [{ status: 'OPEN', kind: 'AUDIT_FINDING', dueAt: at(-5) }, { status: 'OPEN', kind: 'AUDIT_FINDING', dueAt: at(10) }, { status: 'OPEN', kind: 'CONDITION', dueAt: null }, { status: 'CLEARED', kind: 'CONDITION', dueAt: at(-40) }],
    icpReviews: [{ status: 'CLEARED', requestedAt: at(-30), decidedAt: at(-20) }, { status: 'CLEARED', requestedAt: at(-500), decidedAt: at(-480) }, { status: 'REJECTED', requestedAt: at(-15), decidedAt: at(-12) }, { status: 'SUBMITTED', requestedAt: at(-2), decidedAt: null }],
    cycles: [
      { companyId: 'a', category: 'LSA_SERVICING', cycleNo: 1, startsOn: at(-800), endsOn: at(-435), status: 'RENEWED' }, { companyId: 'a', category: 'LSA_SERVICING', cycleNo: 2, startsOn: at(-435), endsOn: at(-70), status: 'RENEWED' },
      { companyId: 'a', category: 'LSA_SERVICING', cycleNo: 3, startsOn: at(-50), endsOn: at(315), status: 'CURRENT' }, // twenty days late
      { companyId: 'b', category: 'FFA_SERVICING', cycleNo: 1, startsOn: at(-300), endsOn: at(65), status: 'CURRENT' },
    ],
    ratings: [4.5, 3.8, 3.2, 4.9, 2.4, 0],
  }, NOW);
  it('buckets the expiries and the applications', () => {
    expect(x.expiries).toEqual({ d30: 1, d60: 2, d90: 3, expired: 1 });
    expect(x.applications).toEqual({ pending: 2, applied: 1, underReview: 1, oldestDays: 30, avgDays: 21 });
    expect(x.byClass[0]).toEqual({ instrumentClass: 'LICENCE', issued: 2, pending: 2, suspended: 0 });
    expect(x.issued12m).toBe(3); // the suspended accreditation was issued this year too
  });
  it('reads obligations, security reviews, ratings and renewals', () => {
    expect(x.obligations).toMatchObject({ open: 3, overdue: 1 }); expect(x.obligations.byKind[0]).toEqual({ kind: 'AUDIT_FINDING', open: 2, overdue: 1 });
    expect(x.securityReviewsDetail).toEqual({ submitted: 1, cleared12m: 1, rejected12m: 1, avgClearanceDays: 15 });
    expect(x.ratingBands).toEqual([{ band: '1–2', total: 0 }, { band: '2–3', total: 1 }, { band: '3–4', total: 2 }, { band: '4–5', total: 2 }]);
    expect(x.renewalStats).toEqual({ total: 2, onTime: 1, onTimePct: 50 });
  });
});
