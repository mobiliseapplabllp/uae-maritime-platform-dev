import { describe, expect, it } from 'vitest';
import { bucketOf, receivablesDashboard, type ArInvoice } from '../src/receivables';

/* Nine fictional invoices to three fictional agents, dated so that every yardstick can be worked by hand. */
const NOW = new Date('2026-09-06T12:00:00Z');
const inv = (o: Partial<ArInvoice> & { id: string; total: number }): ArInvoice => ({
  number: `INV-${o.id}`, status: 'ISSUED', proforma: false, paidAmount: 0, taxAmount: 0, issuedAt: null, dueAt: null, paidAt: null, createdAt: o.issuedAt ?? '2026-01-01T00:00:00Z', remindedAt: null,
  billTo: 'Oceanic Agencies', vesselName: `Ship ${o.id}`, lines: [{ code: 'PD', amount: o.total }], payments: [], ...o,
});
const rows: ArInvoice[] = [
  inv({ id: '1', total: 100000, status: 'PAID', paidAmount: 100000, issuedAt: '2026-08-01T08:00:00Z', dueAt: '2026-08-31T08:00:00Z', paidAt: '2026-08-20T08:00:00Z', payments: [{ at: '2026-08-20T08:00:00Z', amount: 100000, method: 'TRANSFER' }] }),
  inv({ id: '2', total: 50000, status: 'PAID', paidAmount: 50000, billTo: 'Gulf Star Shipping', issuedAt: '2026-07-10T08:00:00Z', dueAt: '2026-08-09T08:00:00Z', paidAt: '2026-08-15T08:00:00Z', lines: [{ code: 'TUG', amount: 50000 }], payments: [{ at: '2026-08-15T08:00:00Z', amount: 50000, method: 'GATEWAY' }] }),
  inv({ id: '3', total: 80000, issuedAt: '2026-08-20T08:00:00Z', dueAt: '2026-09-19T08:00:00Z', lines: [{ code: 'WFC', amount: 80000 }] }),
  inv({ id: '4', total: 30000, paidAmount: 10000, billTo: 'Gulf Star Shipping', issuedAt: '2026-07-01T08:00:00Z', dueAt: '2026-07-31T08:00:00Z', lines: [{ code: 'PIL', amount: 30000 }], payments: [{ at: '2026-08-30T08:00:00Z', amount: 10000, method: 'TRANSFER' }] }),
  inv({ id: '5', total: 20000, billTo: 'Trident Marine', issuedAt: '2026-04-01T08:00:00Z', dueAt: '2026-05-01T08:00:00Z', remindedAt: '2026-06-01T08:00:00Z', lines: [{ code: 'ANC', amount: 20000 }] }),
  inv({ id: '6', total: 15000, status: 'DRAFT', proforma: true, createdAt: '2026-09-03T08:00:00Z' }),
  inv({ id: '7', total: 9000, status: 'CANCELLED', issuedAt: '2026-08-05T08:00:00Z' }),
  inv({ id: '8', total: 200000, status: 'PAID', paidAmount: 200000, issuedAt: '2026-03-03T08:00:00Z', dueAt: '2026-04-02T08:00:00Z', paidAt: '2026-03-20T08:00:00Z', payments: [{ at: '2026-03-20T08:00:00Z', amount: 200000, method: 'TRANSFER' }] }),
  inv({ id: '9', total: 60000, status: 'PAID', paidAmount: 60000, taxAmount: 3000, billTo: 'Trident Marine', issuedAt: '2026-09-02T08:00:00Z', dueAt: '2026-10-02T08:00:00Z', paidAt: '2026-09-04T08:00:00Z', lines: [{ code: 'WFB', amount: 60000 }], payments: [{ at: '2026-09-04T08:00:00Z', amount: 60000, method: 'TRANSFER' }] }),
];

describe('receivables dashboard', () => {
  const d = receivablesDashboard(rows, NOW, { currency: 'AED', termsDays: 30 });
  it('reads the open book and its ageing', () => {
    expect(d.kpis.outstanding).toBe(120000); expect(d.kpis.openInvoices).toBe(3);
    expect(d.kpis.overdueCount).toBe(2); expect(d.kpis.overdueAmount).toBe(40000); expect(d.kpis.remindersDue).toBe(1);
    expect(d.ageing).toEqual([
      { bucket: 'Current', count: 1, amount: 80000 }, { bucket: '1–30', count: 0, amount: 0 }, { bucket: '31–60', count: 1, amount: 20000 }, { bucket: '61–90', count: 0, amount: 0 }, { bucket: '90+', count: 1, amount: 20000 },
    ]);
    expect(d.overdueList.map((o) => [o.number, o.outstanding, o.reminded])).toEqual([['INV-5', 20000, true], ['INV-4', 20000, false]]); // equal amounts: the older debt first
    expect(bucketOf(0)).toBe('Current'); expect(bucketOf(30)).toBe('1–30'); expect(bucketOf(91)).toBe('90+');
  });
  it('works DSO and the collection effectiveness index over the last ninety days', () => {
    // 320 000 billed in ninety days is 3 555.56 a day; 120 000 open is 33.8 days of it
    expect(d.kpis.dsoDays).toBe(33.8);
    // opened the window owed 20 000, billed 320 000, ends owed 120 000 of which 80 000 is not yet due: (20+320-120)/(20+320-80)
    expect(d.kpis.ceiPct).toBe(85);
    expect(d.kpis.avgDaysToPay).toBe(19); expect(d.kpis.paidOnTimePct).toBe(67); expect(d.kpis.settled90d).toBe(3);
  });
  it('sums the month, the year and the sources of revenue', () => {
    expect(d.kpis.billedMtd).toBe(60000); expect(d.kpis.collectedMtd).toBe(60000); expect(d.kpis.billedPrevMonth).toBe(100000); // the same six days of August: invoice 1 only
    expect(d.kpis.billedYtd).toBe(540000); expect(d.kpis.collectedYtd).toBe(420000); expect(d.kpis.collectionRate12mPct).toBe(78); expect(d.kpis.vatMtd).toBe(3000);
    expect(d.byMonth).toHaveLength(12); expect(d.byMonth[11]).toMatchObject({ key: '2026-09', billed: 60000, collected: 60000, invoices: 1 });
    expect(d.byLine[0]).toMatchObject({ code: 'PD', label: 'Port dues', amount: 300000, sharePct: 56 });
    expect(d.methods).toEqual([{ method: 'TRANSFER', count: 4, amount: 370000 }, { method: 'GATEWAY', count: 1, amount: 50000 }]);
    expect(d.kpis.drafts).toEqual({ count: 1, total: 15000, proforma: 1 }); expect(d.kpis.cancelled12m).toEqual({ count: 1, total: 9000 });
  });
  it('names the debtors, worst first', () => {
    expect(d.debtors[0]).toMatchObject({ name: 'Oceanic Agencies', invoices: 3, billed: 380000, outstanding: 80000, overdue: 0, avgDaysToPay: 18 });
    expect(d.debtors.map((x) => x.name)).toEqual(['Oceanic Agencies', 'Gulf Star Shipping', 'Trident Marine']);
    expect(d.debtors[1]).toMatchObject({ outstanding: 20000, overdue: 20000, avgDaysToPay: 36 });
  });
  it('has nothing to say about an empty ledger without failing', () => {
    const e = receivablesDashboard([], NOW);
    expect(e.kpis.dsoDays).toBeNull(); expect(e.kpis.ceiPct).toBeNull(); expect(e.kpis.outstanding).toBe(0); expect(e.ageing.every((b) => b.count === 0)).toBe(true);
  });
});
