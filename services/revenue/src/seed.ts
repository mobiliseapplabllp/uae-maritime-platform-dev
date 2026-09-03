import { join } from 'node:path';
import { Prng, buildWorld, servicesFor, stableId } from '@maritime/world';
import { createDb, runMigrations, withTx, type Queryable } from '@maritime/service-kit';
import { env } from './env';
import { upsertCall, upsertCompany, upsertVessel } from './subjects';

/* Seeds the rate card and the invoice book from the shared world, together with the snapshots billing reads: the calls the
 * harbour desk published, the ship register and the company directory. Idempotent — every write is an upsert on the world's
 * stable id, and each numbering series is advanced past the seeded numbers so the next account cannot collide. */
async function advance(c: Queryable, series: string, value: number) {
  await c.query('INSERT INTO numbering_series(series, last_value) VALUES ($1,$2) ON CONFLICT (series) DO UPDATE SET last_value = GREATEST(numbering_series.last_value, EXCLUDED.last_value)', [series, value]);
}
/** `MAR/INV/2026/0087` → series `MAR/INV/2026`, value 87. */
export function seriesOf(number: string): { series: string; value: number } | null {
  const at = Math.max(number.lastIndexOf('/'), number.lastIndexOf('-'));
  if (at < 1) return null;
  const value = Number(number.slice(at + 1));
  return Number.isFinite(value) ? { series: number.slice(0, at), value } : null;
}

export async function seedRevenue(databaseUrl: string, profile = 'AE') {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });
  const counts = await withTx(pool, async (c) => {
    for (const v of world.vessels) await upsertVessel(c, v);
    for (const o of world.companies) await upsertCompany(c, o);

    const vesselById = new Map(world.vessels.map((v) => [v.id, v]));
    const agentByCode = new Map(world.companies.map((o) => [o.code, o]));
    for (const call of world.portCalls) {
      const v = vesselById.get(call.vesselId);
      await upsertCall(c, {
        id: call.id, vcn: call.vcn, vesselId: call.vesselId, vesselName: call.vesselName, vesselImo: v?.imo ?? '', agentCode: call.agentCode, agentName: agentByCode.get(call.agentCode)?.name ?? call.agentCode,
        status: call.status, eta: call.eta, etb: call.etb, etd: call.etd, ata: call.ata, atb: call.atb, atd: call.atd, berthCode: call.berthCode,
        services: v ? servicesFor(new Prng(0), call, v) : [], cargoOps: call.cargoOps,
        vessel: v ? { id: v.id, name: v.name, imo: v.imo, type: v.type, flag: v.flag, grt: v.grt, dwt: v.dwt, loa: v.loa, maxDraft: v.maxDraft, real: v.real } : {},
      });
    }

    for (const t of world.tariffs) {
      const revisions = t.revisions.map((r) => ({ id: stableId('tariffrev', `${t.code}:${r.effectiveFrom}`), effectiveFrom: r.effectiveFrom, rate: r.rate, previousRate: r.previousRate, changePct: r.changePct, circular: r.circular, note: r.note }));
      await c.query(`INSERT INTO tariffs(id, code, name, name_ar, category, unit, rate, currency, active, revisions) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, name_ar = EXCLUDED.name_ar, category = EXCLUDED.category, unit = EXCLUDED.unit, rate = EXCLUDED.rate, currency = EXCLUDED.currency, active = EXCLUDED.active, revisions = EXCLUDED.revisions, updated_at = now()`,
        [t.id, t.code, t.name, t.nameAr ?? null, t.category, t.unit, t.rate, t.currency, t.active, JSON.stringify(revisions)]);
    }

    const series = new Map<string, number>();
    for (const i of world.invoices) {
      const history = [{ from: '', to: 'DRAFT', at: i.createdAt, by: 'Billing desk', note: `Raised on call ${i.vcn}` }];
      if (i.issuedAt) history.push({ from: 'DRAFT', to: 'ISSUED', at: i.issuedAt, by: 'Billing desk', note: `Issued, payable by ${(i.dueAt ?? i.issuedAt).slice(0, 10)}` });
      if (i.paidAt) history.push({ from: 'ISSUED', to: 'PAID', at: i.paidAt, by: 'Billing desk', note: `Settled — ${i.paymentRef}` });
      if (i.status === 'CANCELLED') history.push({ from: 'ISSUED', to: 'CANCELLED', at: i.issuedAt ?? i.createdAt, by: 'Billing desk', note: i.notes });
      const payments = i.paidAt ? [{ id: stableId('payment', i.id), at: i.paidAt, amount: i.total, ref: i.paymentRef, method: 'TRANSFER', by: 'Billing desk', note: '' }] : [];
      await c.query(`INSERT INTO invoices(id, number, port_call_id, vcn, vessel_id, vessel_name, vessel_imo, bill_to, lines, subtotal, tax_name, tax_rate_pct, tax_amount, total, currency, status, proforma, issued_at, due_at, paid_at, paid_amount, payment_ref, payments, cancel_reason, notes, history, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27)
        ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, port_call_id = EXCLUDED.port_call_id, vcn = EXCLUDED.vcn, vessel_id = EXCLUDED.vessel_id, vessel_name = EXCLUDED.vessel_name, vessel_imo = EXCLUDED.vessel_imo, bill_to = EXCLUDED.bill_to, lines = EXCLUDED.lines,
          subtotal = EXCLUDED.subtotal, tax_name = EXCLUDED.tax_name, tax_rate_pct = EXCLUDED.tax_rate_pct, tax_amount = EXCLUDED.tax_amount, total = EXCLUDED.total, currency = EXCLUDED.currency, status = EXCLUDED.status, proforma = EXCLUDED.proforma,
          issued_at = EXCLUDED.issued_at, due_at = EXCLUDED.due_at, paid_at = EXCLUDED.paid_at, paid_amount = EXCLUDED.paid_amount, payment_ref = EXCLUDED.payment_ref, payments = EXCLUDED.payments, cancel_reason = EXCLUDED.cancel_reason, notes = EXCLUDED.notes, history = EXCLUDED.history, created_at = EXCLUDED.created_at, updated_at = now()`,
        [i.id, i.number, i.portCallId, i.vcn, i.vesselId, i.vesselName, vesselById.get(i.vesselId)?.imo ?? '', JSON.stringify(i.billTo), JSON.stringify(i.lines), i.subtotal, i.taxName, i.taxRatePct, i.taxAmount, i.total, i.currency, i.status,
          i.status === 'DRAFT' && /Pro-forma/i.test(i.notes), i.issuedAt, i.dueAt, i.paidAt, i.paidAt ? i.total : 0, i.paymentRef, JSON.stringify(payments), i.status === 'CANCELLED' ? i.notes : '', i.notes, JSON.stringify(history), i.createdAt]);
      const s = seriesOf(i.number); if (s) series.set(s.series, Math.max(series.get(s.series) ?? 0, s.value));
    }
    for (const [key, n] of series) await advance(c, key, n);
    return { profile: world.profile, tariffs: world.tariffs.length, invoices: world.invoices.length, portCalls: world.portCalls.length, vessels: world.vessels.length, companies: world.companies.length, series: series.size,
      issued: world.invoices.filter((i) => i.status === 'ISSUED').length, paid: world.invoices.filter((i) => i.status === 'PAID').length, drafts: world.invoices.filter((i) => i.status === 'DRAFT').length, cancelled: world.invoices.filter((i) => i.status === 'CANCELLED').length };
  });
  await pool.end();
  return counts;
}

if (require.main === module) {
  const e = env();
  seedRevenue(e.DATABASE_URL, e.JURISDICTION).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
