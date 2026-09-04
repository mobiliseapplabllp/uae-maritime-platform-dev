import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { EVENTS, makeEvent, subjectFor } from '@maritime/contracts';
import { AuditClient, PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256, withTx } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedRevenue, seriesOf } from '../src/seed';
import { applyEvent, remindOverdue } from '../src/consumer';
import { buildLines, computeTotals, daysAlongside, impliedServices, tugsFor, wharfageCode } from '../src/invoicing';
import { rateAsAt } from '../src/tariffs.controller';
import { upsertCall } from '../src/subjects';

const DB = 'maritime_revenue_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let audit: AuditClient; let env: ReturnType<typeof loadEnv<typeof envSchema>>;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const biller = tok('biller'); const cashier = tok('cashier'); const viewer = tok('viewer'); const nobody = tok('nobody');
const g = (p: string, t = admin) => request(server as never).get(p).set('authorization', t);
const post = (p: string, body?: unknown, t = admin) => request(server as never).post(p).set('authorization', t).send((body ?? {}) as never);
const put = (p: string, body: unknown, t = admin) => request(server as never).put(p).set('authorization', t).send(body as never);
const del = (p: string, t = admin) => request(server as never).delete(p).set('authorization', t);
const outbox = async (type: string) => (await pool.query('SELECT payload FROM outbox WHERE subject = $1 ORDER BY id', [subjectFor(type)])).rows.map((r) => r.payload as { type: string; data: Record<string, any> });
const clearOutbox = () => pool.query('DELETE FROM outbox');
const H = 3600_000; const D = 24 * H;

/** A call the harbour desk would have published: 40 000 GRT, 300 m, two days alongside after a 30-hour wait, 1 000 TEU discharged. */
const sampleCall = (id: string, vcn: string, atd: Date | null) => {
  const atb = new Date((atd ?? new Date()).getTime() - 48 * H);
  return { id, vcn, vesselId: 'test-vessel', vesselName: 'Trial Runner', vesselImo: '9111111', agentCode: 'GSS', agentName: 'Gulf Star Shipping Agency LLC', status: atd ? 'SAILED' : 'BERTHED',
    eta: new Date(atb.getTime() - 30 * H).toISOString(), etb: atb.toISOString(), etd: atd ? atd.toISOString() : null, ata: new Date(atb.getTime() - 30 * H).toISOString(), atb: atb.toISOString(), atd: atd ? atd.toISOString() : null,
    berthCode: 'CT4-1', services: [], cargoOps: [{ cargoType: 'CONTAINERS', operation: 'DISCHARGE', qty: 1000, unit: 'TEU', qtyMT: 12000 }],
    vessel: { id: 'test-vessel', name: 'Trial Runner', imo: '9111111', type: 'CONT', flag: 'AE', grt: 40000, loa: 300, maxDraft: 14, real: false } };
};

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedRevenue(URL, 'AE');
  env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET } as never);
  const base = { scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    admin: { ...base, id: 'admin', sub: 'admin', name: 'Admin', perms: ['*'] },
    biller: { ...base, id: 'biller', sub: 'biller', name: 'Billing Officer', perms: ['invoices.view', 'invoices.create', 'invoices.issue', 'tariffs.view'] },
    cashier: { ...base, id: 'cashier', sub: 'cashier', name: 'Cashier', perms: ['invoices.view', 'invoices.pay'] },
    viewer: { ...base, id: 'viewer', sub: 'viewer', name: 'Auditor', perms: ['invoices.view', 'tariffs.view'] },
    nobody: { ...base, id: 'nobody', sub: 'nobody', name: 'Nobody', perms: ['dashboard.view'] },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer(); pool = new Pool({ connectionString: URL }); audit = app.get(AuditClient);
  await withTx(pool, (c) => upsertCall(c, sampleCall('test-call-1', 'TST-2026-0001', new Date(Date.now() - 6 * H))));
  await withTx(pool, (c) => upsertCall(c, sampleCall('test-call-2', 'TST-2026-0002', new Date(Date.now() - 5 * H))));
  await withTx(pool, (c) => upsertCall(c, sampleCall('test-call-3', 'TST-2026-0003', null)));
});
afterAll(async () => { await pool?.end(); await app?.close(); });

describe('revenue — invoice arithmetic', () => {
  it('rounds every line to two decimals and sums the total in minor units', () => {
    const t = computeTotals([{ code: 'PD', description: 'Port dues', unit: 'per GRT', qty: 41234, rate: 0.6 }, { code: 'WFB', description: 'Wharfage', unit: 'per MT', qty: 63421, rate: 5.2 }], 5);
    expect(t.lines[0].amount).toBe(24740.4);
    expect(t.lines[1].amount).toBe(329789.2);
    expect(t.subtotal).toBe(354529.6);
    expect(t.taxAmount).toBe(17726.48);
    expect(t.total).toBe(372256.08);
    // summing in minor units is exactly why the stored total is exact where the float addition is not
    expect(t.subtotal + t.taxAmount).not.toBe(t.total);
    expect(Math.round((t.subtotal + t.taxAmount) * 100) / 100).toBe(t.total);
  });
  it('routes cargo to its wharfage head, scales tugs by length and counts days alongside', () => {
    expect(wharfageCode({ unit: 'TEU', cargoType: 'CONTAINERS' })).toBe('WFC');
    expect(wharfageCode({ unit: 'UNITS', cargoType: 'AUTO' })).toBe('WFR');
    expect(wharfageCode({ unit: 'MT', cargoType: 'LNG' })).toBe('WFL');
    expect(wharfageCode({ unit: 'MT', cargoType: 'GRAIN' })).toBe('WFB');
    expect(tugsFor(300)).toBe(3); expect(tugsFor(250)).toBe(2);
    const atb = new Date('2026-03-01T00:00:00Z').toISOString();
    expect(daysAlongside({ vcn: 'x', vesselName: 'y', atb, atd: new Date('2026-03-03T00:00:00Z').toISOString() })).toBe(2);
    expect(daysAlongside({ vcn: 'x', vesselName: 'y', atb, atd: new Date('2026-03-01T06:00:00Z').toISOString() })).toBe(1);
    const s = impliedServices({ vcn: 'x', vesselName: 'y', grt: 40000, loa: 300, ata: new Date('2026-03-01T00:00:00Z').toISOString(), atb: new Date('2026-03-02T06:00:00Z').toISOString(), atd: new Date('2026-03-04T06:00:00Z').toISOString() });
    expect(s.map((x) => x.tariffCode)).toEqual(['PIL', 'TUG', 'BH', 'ANC']);
    expect(s.find((x) => x.tariffCode === 'TUG')!.qty).toBe(6);
    expect(s.find((x) => x.tariffCode === 'BH')!.qty).toBe(80000);
    expect(s.find((x) => x.tariffCode === 'ANC')!.qty).toBe(2);
  });
  it('prices the rate card exactly: port dues, marine services, anchorage and wharfage', () => {
    const tariffs = { PD: { code: 'PD', name: 'Port dues', unit: 'per GRT', rate: 0.6, currency: 'AED' }, PIL: { code: 'PIL', name: 'Pilotage (in/out)', unit: 'per movement', rate: 3800, currency: 'AED' },
      TUG: { code: 'TUG', name: 'Tug assistance', unit: 'per tug-movement', rate: 2800, currency: 'AED' }, BH: { code: 'BH', name: 'Berth hire', unit: 'per GRT per day', rate: 0.2, currency: 'AED' },
      ANC: { code: 'ANC', name: 'Anchorage charges', unit: 'per day', rate: 1100, currency: 'AED' }, WFC: { code: 'WFC', name: 'Wharfage — containers', unit: 'per TEU', rate: 42, currency: 'AED' } };
    const call = { vcn: 'X', vesselName: 'Trial Runner', grt: 40000, loa: 300, cargoOps: [{ cargoType: 'CONTAINERS', qty: 1000, unit: 'TEU' }],
      ata: new Date('2026-03-01T00:00:00Z').toISOString(), atb: new Date('2026-03-02T06:00:00Z').toISOString(), atd: new Date('2026-03-04T06:00:00Z').toISOString() };
    const totals = computeTotals(buildLines(call, tariffs, { implyServices: true }), 5);
    expect(totals.lines.map((l) => [l.code, l.amount])).toEqual([['PD', 24000], ['PIL', 7600], ['TUG', 16800], ['BH', 16000], ['ANC', 2200], ['WFC', 42000]]);
    expect(totals.subtotal).toBe(108600);
    expect(totals.taxAmount).toBe(5430);
    expect(totals.total).toBe(114030);
  });
  it('reads a numbering series back out of a seeded number', () => {
    expect(seriesOf('MAR/INV/2026/0087')).toEqual({ series: 'MAR/INV/2026', value: 87 });
    expect(seriesOf('INV-2026-00042')).toEqual({ series: 'INV-2026', value: 42 });
  });
});

describe('revenue — the rate card', () => {
  it('seeds the card, filters and searches it and carries the published trail', async () => {
    const all = await g('/tariffs?limit=50');
    expect(all.body.meta.total).toBe(11);
    const pd = all.body.data.find((t: { code: string }) => t.code === 'PD');
    expect(pd.rate).toBe(0.6); expect(pd.currency).toBe('AED'); expect(pd.revisions.length).toBeGreaterThan(2);
    expect(pd.revisions[0].id).toBeTruthy();
    const marine = await g('/tariffs?category=MARINE&limit=50');
    expect(marine.body.data.every((t: { category: string }) => t.category === 'MARINE')).toBe(true);
    expect((await g('/tariffs?q=wharfage&limit=50')).body.meta.total).toBe(4);
    const meta = await g('/tariffs/meta');
    expect(meta.body.data.tax.ratePct).toBe(5); expect(meta.body.data.currency.code).toBe('AED');
  });
  it('reports the published rate history and the rate in force on a date', async () => {
    const pd = (await g('/tariffs/PD')).body.data;
    const h = await g(`/tariffs/${pd.id}/history`);
    expect(h.status).toBe(200);
    expect(h.body.data.item.code).toBe('PD');
    expect(h.body.data.series[0].label).toBe('Base');
    expect(h.body.data.summary.currentRate).toBe(0.6);
    expect(h.body.data.summary.baseRate).toBeLessThan(0.6);
    expect(h.body.data.summary.totalChangePct).toBeGreaterThan(0);
    expect(h.body.data.asAt.rate).toBe(0.6);
    const first = h.body.data.revisions[0];
    const before = await g(`/tariffs/${pd.id}/history?asAt=${new Date(new Date(first.effectiveFrom).getTime() - D).toISOString()}`);
    expect(before.body.data.asAt.rate).toBe(h.body.data.summary.baseRate);
    expect(rateAsAt(h.body.data.revisions, h.body.data.summary.baseRate, new Date(first.effectiveFrom)).rate).toBe(first.rate);
  });
  it('publishes a revision when a rate changes and protects a head that has been billed', async () => {
    await clearOutbox();
    const made = await post('/tariffs', { code: 'TST', name: 'Trial head', category: 'MISC', unit: 'per call', rate: 100 });
    expect(made.status).toBe(201); expect(made.body.data.currency).toBe('AED');
    const id = made.body.data.id;
    expect((await outbox(EVENTS.readModel.upserted))[0].data.kind).toBe('tariff');
    expect(await outbox(EVENTS.revenue.tariffChanged)).toHaveLength(1);
    expect((await post('/tariffs', { code: 'TST', name: 'dup', rate: 1 })).status).toBe(409);
    const revised = await put(`/tariffs/${id}`, { rate: 125, circular: 'TAR-CIRC/2026', note: 'Annual revision' });
    expect(revised.body.data.rate).toBe(125);
    expect(revised.body.data.revisions).toHaveLength(1);
    expect(revised.body.data.revisions[0]).toMatchObject({ previousRate: 100, rate: 125, changePct: 25, circular: 'TAR-CIRC/2026' });
    const again = await post(`/tariffs/${id}/revisions`, { rate: 130, circular: 'TAR-CIRC/2027' });
    expect(again.body.data.revisions).toHaveLength(2);
    expect(again.body.data.summary.totalChangePct).toBe(30);
    expect((await post(`/tariffs/${id}/revisions`, { rate: 130 })).status).toBe(400);
    const renamed = await put(`/tariffs/${id}`, { name: 'Trial head (renamed)' });
    expect(renamed.body.data.revisions).toHaveLength(2);
    expect((await del(`/tariffs/${id}`)).body.data.deleted).toBe(true);
    const billed = (await g('/tariffs/PD')).body.data;
    const refused = await del(`/tariffs/${billed.id}`);
    expect(refused.status).toBe(409); expect(refused.body.message).toContain('retire it');
  });
  it('denies rate-card changes to a role that only reads it', async () => {
    expect((await request(server as never).get('/tariffs')).status).toBe(401);
    expect((await g('/tariffs', nobody)).status).toBe(403);
    expect((await post('/tariffs', { code: 'X', name: 'x', rate: 1 }, biller)).status).toBe(403);
    expect((await g('/tariffs', viewer)).status).toBe(200);
  });
});

describe('revenue — the invoice book', () => {
  it('seeds the book and pages, filters, searches and sorts it', async () => {
    /* The seeded world runs up to today, so the book grows by a few invoices every day it is not reseeded.
     * These assertions are on its shape — that the statuses partition the whole book, that collection is
     * what the ledger says — rather than on a count that was true on the day it was written. */
    const all = await g('/invoices?limit=1');
    const total = all.body.meta.total;
    expect(total).toBeGreaterThan(800);
    const paid = await g('/invoices?status=PAID&limit=1');
    const cancelled = await g('/invoices?status=CANCELLED&limit=5');
    const issued = await g('/invoices?status=ISSUED&limit=1');
    const draft = await g('/invoices?status=DRAFT&limit=1');
    expect(paid.body.meta.total + cancelled.body.meta.total + issued.body.meta.total + draft.body.meta.total).toBe(total);
    expect(paid.body.meta.total / total).toBeGreaterThan(0.9);
    expect(cancelled.body.meta.total).toBeGreaterThan(0);
    const page2 = await g('/invoices?limit=5&page=2&sort=number');
    expect(page2.body.data).toHaveLength(5); expect(page2.body.meta.page).toBe(2);
    const one = paid.body.data[0];
    expect((await g(`/invoices?q=${encodeURIComponent(one.number)}`)).body.meta.total).toBe(1);
    const byVessel = await g(`/invoices?vessel=${one.vesselId}&limit=200`);
    expect(byVessel.body.data.every((i: { vesselId: string }) => i.vesselId === one.vesselId)).toBe(true);
    const byCall = await g(`/invoices?portCall=${one.portCallId}`);
    expect(byCall.body.meta.total).toBe(1);
    const window = await g('/invoices?from=2024-01-01&to=2024-12-31&limit=1');
    expect(window.body.meta.total).toBeGreaterThan(0);
    expect(window.body.meta.total).toBeLessThan(total);
    const summary = await g('/invoices/summary');
    expect(summary.body.data.byStatus.PAID.count).toBe(paid.body.meta.total);
    expect(summary.body.data.collectionPct).toBeGreaterThan(80);
    expect(summary.body.data.currency).toBe('AED');
  });
  it('returns an invoice with its lines, totals, payments and the call it closed', async () => {
    const one = (await g('/invoices?status=PAID&limit=1')).body.data[0];
    const d = (await g(`/invoices/${one.id}`)).body.data;
    expect(d.lines.length).toBeGreaterThan(2);
    expect(d.taxName).toBe('VAT'); expect(d.taxRatePct).toBe(5);
    expect(Math.round((d.subtotal + d.taxAmount) * 100) / 100).toBe(d.total);
    expect(d.taxAmount).toBe(Math.round(d.subtotal * 5) / 100);
    expect(d.balance).toBe(0); expect(d.payments).toHaveLength(1);
    expect(d.vessel?.imo).toMatch(/^\d{7}$/);
    expect(d.portCall?.vcn).toBe(d.vcn);
    expect(d.billTo.taxIdLabel).toBe('TRN');
    expect((await g('/invoices/00000000-0000-4000-a000-000000000000')).status).toBe(404);
  });
  it('raises an account from a call, on its own series, with the arithmetic the rate card gives', async () => {
    await clearOutbox();
    const made = await post('/invoices/generate', { portCallId: 'test-call-1' }, biller);
    expect(made.status).toBe(201);
    const inv = made.body.data;
    expect(inv.number).toMatch(/^INV-\d{4}-\d{5}$/);
    expect(inv.status).toBe('DRAFT');
    expect(inv.vcn).toBe('TST-2026-0001');
    expect(inv.billTo.name).toBe('Gulf Star Shipping Agency LLC');
    expect(inv.billTo.taxId).toBeTruthy();
    expect(inv.lines.map((l: { code: string; amount: number }) => [l.code, l.amount])).toEqual([['PD', 24000], ['PIL', 7600], ['TUG', 16800], ['BH', 16000], ['ANC', 2200], ['WFC', 42000]]);
    expect(inv.subtotal).toBe(108600); expect(inv.taxAmount).toBe(5430); expect(inv.total).toBe(114030); expect(inv.balance).toBe(114030);
    const rm = await outbox(EVENTS.readModel.upserted);
    expect(rm).toHaveLength(1); expect(rm[0].data.kind).toBe('invoice'); expect(rm[0].data.entity.number).toBe(inv.number);
    expect(await outbox(EVENTS.revenue.invoiceDrafted)).toHaveLength(1);
    expect((await outbox(EVENTS.audit.recorded)).some((e) => e.data.action === 'CREATE' && e.data.entity === 'Invoice')).toBe(true);
    const dup = await post('/invoices/generate', { portCallId: 'test-call-1' }, biller);
    expect(dup.status).toBe(409); expect(dup.body.message).toContain(inv.number);
    expect((await post('/invoices/generate', { portCallId: 'no-such-call' }, biller)).status).toBe(404);
  });
  it('prices a re-raised world call on the same heads the world costed it on', async () => {
    const cancelled = (await pool.query<{ port_call_id: string; lines: { code: string; amount: number }[] }>("SELECT port_call_id, lines FROM invoices WHERE status = 'CANCELLED' ORDER BY number LIMIT 1")).rows[0];
    const raised = await post('/invoices/generate', { portCallId: cancelled.port_call_id }, biller);
    expect(raised.status).toBe(201);
    const ours = new Map(raised.body.data.lines.map((l: { code: string; amount: number }) => [l.code, l.amount]));
    for (const code of ['PD', 'PIL', 'TUG', 'BH']) expect(ours.get(code)).toBe(cancelled.lines.find((l) => l.code === code)!.amount);
    const wharfage = cancelled.lines.find((l) => /^WF/.test(l.code))!;
    expect(ours.get(wharfage.code)).toBe(wharfage.amount);
    await del(`/invoices/${raised.body.data.id}`);
  });
  it('edits a draft, issues it, takes payment in parts and settles it', async () => {
    await clearOutbox();
    const inv = (await g('/invoices?portCall=test-call-1')).body.data[0];
    const edited = await put(`/invoices/${inv.id}`, { notes: 'Agent to collect', lines: [{ code: 'PD', description: 'Port dues', unit: 'per GRT', qty: 40000, rate: 0.6 }, { code: 'GBG', description: 'Garbage reception', unit: 'per call', qty: 1, rate: 800 }] }, biller);
    expect(edited.body.data.subtotal).toBe(24800); expect(edited.body.data.taxAmount).toBe(1240); expect(edited.body.data.total).toBe(26040);
    expect((await post(`/invoices/${inv.id}/pay`, { paymentRef: 'FT-1' }, cashier)).status).toBe(409);
    const issued = await post(`/invoices/${inv.id}/issue`, {}, biller);
    expect(issued.body.data.status).toBe('ISSUED'); expect(issued.body.data.issuedAt).toBeTruthy(); expect(issued.body.data.dueAt).toBeTruthy();
    expect((await post(`/invoices/${inv.id}/issue`, {}, biller)).status).toBe(409);
    expect((await del(`/invoices/${inv.id}`)).status).toBe(400);
    const part = await post(`/invoices/${inv.id}/pay`, { amount: 10000, paymentRef: 'FT-100001' }, cashier);
    expect(part.body.data.status).toBe('ISSUED'); expect(part.body.data.paidAmount).toBe(10000); expect(part.body.data.balance).toBe(16040);
    expect((await post(`/invoices/${inv.id}/pay`, { amount: 99999 }, cashier)).status).toBe(400);
    const rest = await post(`/invoices/${inv.id}/pay`, { paymentRef: 'FT-100002' }, cashier);
    expect(rest.body.data.status).toBe('PAID'); expect(rest.body.data.balance).toBe(0); expect(rest.body.data.payments).toHaveLength(2); expect(rest.body.data.paidAt).toBeTruthy();
    expect((await post(`/invoices/${inv.id}/cancel`, { reason: 'no' }, biller)).status).toBe(409);
    const types = (await pool.query<{ payload: { type: string } }>('SELECT payload FROM outbox ORDER BY id')).rows.map((r) => r.payload.type);
    expect(types).toContain(EVENTS.revenue.invoiceIssued);
    expect(types).toContain(EVENTS.revenue.paymentReceived);
    expect(types).toContain(EVENTS.revenue.invoicePaid);
    expect(types.indexOf(EVENTS.readModel.upserted)).toBeLessThan(types.indexOf(EVENTS.revenue.invoiceUpdated));
    const history = (await g(`/invoices/${inv.id}`)).body.data.history;
    expect(history.map((h: { to: string }) => h.to)).toEqual(['DRAFT', 'ISSUED', 'ISSUED', 'PAID']);
  });
  it('cancels a draft with its reason and lets the call be re-raised', async () => {
    const first = await post('/invoices/generate', { portCallId: 'test-call-3' }, biller);
    expect(first.status).toBe(201);
    const cancelled = await post(`/invoices/${first.body.data.id}/cancel`, { reason: 'Raised against the wrong agent' }, biller);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect(cancelled.body.data.cancelReason).toBe('Raised against the wrong agent');
    expect((await outbox(EVENTS.revenue.invoiceCancelled)).length).toBeGreaterThan(0);
    const again = await post('/invoices/generate', { portCallId: 'test-call-3' }, biller);
    expect(again.status).toBe(201); expect(again.body.data.number).not.toBe(first.body.data.number);
    expect((await del(`/invoices/${again.body.data.id}`, admin)).body.data.deleted).toBe(true);
  });
  it('estimates a call before she sails without writing anything', async () => {
    const est = await g('/invoices/proforma?portCallId=test-call-2');
    expect(est.status).toBe(200);
    expect(est.body.data.call.vcn).toBe('TST-2026-0002');
    expect(est.body.data.subtotal).toBe(108600);
    expect(est.body.data.total).toBe(114030);
    expect(est.body.data.taxRatePct).toBe(5);
    expect(est.body.data.basis).toMatchObject({ grt: 40000, loa: 300, daysAlongside: 2, cargoParcels: 1 });
    expect(est.body.data.invoice).toBeNull();
    expect((await pool.query("SELECT count(*) AS n FROM invoices WHERE port_call_id = 'test-call-2'")).rows[0].n).toBe('0');
    expect((await g('/invoices/proforma')).status).toBe(400);
    expect((await g('/invoices/proforma?portCallId=nope')).status).toBe(404);
  });
  it('denies by default and refuses the actions a role does not hold', async () => {
    expect((await request(server as never).get('/invoices')).status).toBe(401);
    expect((await g('/invoices', nobody)).status).toBe(403);
    expect((await post('/invoices/generate', { portCallId: 'test-call-2' }, cashier)).status).toBe(403);
    const one = (await g('/invoices?status=DRAFT&limit=1', viewer)).body.data[0];
    expect((await post(`/invoices/${one.id}/issue`, {}, cashier)).status).toBe(403);
    expect((await post(`/invoices/${one.id}/pay`, { paymentRef: 'x' }, biller)).status).toBe(403);
    expect((await del(`/invoices/${one.id}`, biller)).status).toBe(403);
  });
});

describe('revenue — the event-driven billing path', () => {
  const deps = () => ({ env, audit });
  const sailed = (portCallId: string, vcn: string) => makeEvent({ type: EVENTS.ports.sailed, source: 'ports', data: { portCallId, vcn, status: 'SAILED' } });

  it('projects the call, ship and company snapshots the billing maths reads', async () => {
    const entity = { ...sampleCall('test-call-4', 'TST-2026-0004', new Date(Date.now() - 3 * H)) };
    await withTx(pool, (c) => applyEvent(c, deps(), makeEvent({ type: EVENTS.readModel.upserted, source: 'ports', data: { kind: 'portCall', entity } })));
    expect((await pool.query("SELECT vcn FROM port_calls WHERE id = 'test-call-4'")).rows[0].vcn).toBe('TST-2026-0004');
    await withTx(pool, (c) => applyEvent(c, deps(), makeEvent({ type: EVENTS.readModel.upserted, source: 'ships', data: { kind: 'vessel', entity: { id: 'test-vessel', imo: '9111111', name: 'Trial Runner', type: 'CONT', flag: 'AE', grt: 40000, loa: 300, status: 'ACTIVE' } } })));
    expect((await pool.query("SELECT grt FROM vessels WHERE id = 'test-vessel'")).rows[0].grt).toBe(40000);
    await withTx(pool, (c) => applyEvent(c, deps(), makeEvent({ type: EVENTS.readModel.upserted, source: 'mdm', data: { kind: 'company', entity: { id: 'test-co', code: 'TCO', name: 'Trial Agencies', address: 'Free Zone', taxId: '100123456700003', status: 'ACTIVE' } } })));
    expect((await pool.query("SELECT tax_id FROM companies WHERE code = 'TCO'")).rows[0].tax_id).toBe('100123456700003');
  });

  it('raises and issues the account when a call sails, once per call', async () => {
    await clearOutbox();
    await withTx(pool, (c) => applyEvent(c, deps(), sailed('test-call-4', 'TST-2026-0004')));
    const rows = await pool.query<{ id: string; number: string; status: string; total: string; proforma: boolean }>("SELECT id, number, status, total, proforma FROM invoices WHERE port_call_id = 'test-call-4'");
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].status).toBe('ISSUED');
    expect(rows.rows[0].proforma).toBe(false);
    expect(Number(rows.rows[0].total)).toBe(114030);
    const issuedEvents = await outbox(EVENTS.revenue.invoiceIssued);
    expect(issuedEvents).toHaveLength(1);
    expect(issuedEvents[0].data.automatic).toBe(true);
    expect((await outbox(EVENTS.readModel.upserted))[0].data.kind).toBe('invoice');
    // a redelivered sailing changes nothing, and neither does a second one
    await withTx(pool, (c) => applyEvent(c, deps(), sailed('test-call-4', 'TST-2026-0004')));
    expect((await pool.query("SELECT count(*) AS n FROM invoices WHERE port_call_id = 'test-call-4'")).rows[0].n).toBe('1');
    const detail = (await g(`/invoices/${rows.rows[0].id}`)).body.data;
    expect(detail.history.map((h: { to: string }) => h.to)).toEqual(['DRAFT', 'ISSUED']);
    expect(detail.dueAt).toBeTruthy();
  });

  it('raises the pro-forma when a vessel berths and finalises the same account when she sails', async () => {
    const entity = sampleCall('test-call-5', 'TST-2026-0005', null);
    await withTx(pool, (c) => applyEvent(c, deps(), makeEvent({ type: EVENTS.readModel.upserted, source: 'ports', data: { kind: 'portCall', entity } })));
    await withTx(pool, (c) => applyEvent(c, deps(), makeEvent({ type: EVENTS.ports.berthed, source: 'ports', data: { portCallId: 'test-call-5', vcn: 'TST-2026-0005' } })));
    const draft = (await pool.query<{ id: string; status: string; proforma: boolean; notes: string }>("SELECT id, status, proforma, notes FROM invoices WHERE port_call_id = 'test-call-5'")).rows[0];
    expect(draft.status).toBe('DRAFT'); expect(draft.proforma).toBe(true); expect(draft.notes).toMatch(/Pro-forma/);
    await withTx(pool, (c) => applyEvent(c, deps(), makeEvent({ type: EVENTS.readModel.upserted, source: 'ports', data: { kind: 'portCall', entity: sampleCall('test-call-5', 'TST-2026-0005', new Date()) } })));
    await withTx(pool, (c) => applyEvent(c, deps(), sailed('test-call-5', 'TST-2026-0005')));
    const rows = await pool.query<{ id: string; status: string; proforma: boolean }>("SELECT id, status, proforma FROM invoices WHERE port_call_id = 'test-call-5'");
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0].id).toBe(draft.id);
    expect(rows.rows[0].status).toBe('ISSUED');
    expect(rows.rows[0].proforma).toBe(false);
  });

  it('cancels the draft when the harbour desk withdraws the call', async () => {
    const entity = sampleCall('test-call-6', 'TST-2026-0006', null);
    await withTx(pool, (c) => applyEvent(c, deps(), makeEvent({ type: EVENTS.readModel.upserted, source: 'ports', data: { kind: 'portCall', entity } })));
    await withTx(pool, (c) => applyEvent(c, deps(), makeEvent({ type: EVENTS.ports.berthed, source: 'ports', data: { portCallId: 'test-call-6' } })));
    await withTx(pool, (c) => applyEvent(c, deps(), makeEvent({ type: EVENTS.ports.cancelled, source: 'ports', data: { portCallId: 'test-call-6', note: 'Owners withdrew' } })));
    const row = (await pool.query<{ status: string; cancel_reason: string }>("SELECT status, cancel_reason FROM invoices WHERE port_call_id = 'test-call-6'")).rows[0];
    expect(row.status).toBe('CANCELLED');
    expect(row.cancel_reason).toContain('Owners withdrew');
  });

  it('announces every overdue account once inside the reminder window', async () => {
    await clearOutbox();
    await pool.query("UPDATE invoices SET status = 'ISSUED', due_at = now() - interval '20 days', paid_at = NULL, paid_amount = 0, reminded_at = NULL WHERE id IN (SELECT id FROM invoices WHERE status = 'PAID' ORDER BY number LIMIT 3)");
    const sweep = makeEvent({ type: EVENTS.scheduler.digestInvoices, source: 'scheduler', data: {} });
    const n = await withTx(pool, (c) => remindOverdue(c, env, sweep));
    expect(n).toBeGreaterThanOrEqual(3);
    const events = await outbox(EVENTS.revenue.invoiceOverdue);
    expect(events.length).toBe(n);
    expect(events[0].data.daysOverdue).toBeGreaterThanOrEqual(19);
    expect(events[0].data.outstanding).toBeGreaterThan(0);
    const second = await withTx(pool, (c) => remindOverdue(c, env, sweep));
    expect(second).toBe(0);
    expect((await g('/invoices?overdue=true&limit=1')).body.meta.total).toBeGreaterThanOrEqual(3);
  });
});
