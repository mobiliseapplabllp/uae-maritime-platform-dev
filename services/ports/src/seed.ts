import { join } from 'node:path';
import { Prng, buildWorld, geoFor, servicesFor, stableId, type WorldPortCall, type WorldVessel } from '@maritime/world';
import { createDb, runMigrations, withTx, type Queryable } from '@maritime/service-kit';
import { env } from './env';
import { toMT, type CallService, type CargoOp, type HistoryEntry } from './calls';
import { upsertCompany, upsertInvoice, upsertTariff, upsertVessel } from './subjects';

/* Seeds the harbour desk from the shared world: the berth estate with its outage record, the marine craft with their service
 * records, and the vessel-call register. The snapshots other domains own (ships, companies, the rate card, invoices) are
 * seeded here too so the service is usable before any event arrives. Idempotent — every write is an upsert on the world's
 * stable id, and the numbering series are advanced past the seeded numbers. */
const H = 3600_000; const D = 24 * H;
const ORDER = ['ANNOUNCED', 'CONFIRMED', 'AT_ANCHORAGE', 'BERTHED', 'SAILED'];
const seq = (call: WorldPortCall): string[] => {
  const at = ORDER.indexOf(call.status);
  if (call.status === 'CANCELLED') return ['ANNOUNCED', 'CANCELLED'];
  return ORDER.slice(0, Math.max(1, at + 1));
};
/** The status trail a call would have accumulated, timed off the stamps it carries. */
function historyOf(call: WorldPortCall, createdAt: Date): HistoryEntry[] {
  const stamps: Record<string, string | null> = { ANNOUNCED: createdAt.toISOString(), CONFIRMED: call.etb ?? call.eta, AT_ANCHORAGE: call.ata, BERTHED: call.atb, SAILED: call.atd, CANCELLED: call.eta };
  const notes: Record<string, string> = { ANNOUNCED: 'Call announced', CONFIRMED: 'Berth allocated and call confirmed', AT_ANCHORAGE: 'Reported at the anchorage', BERTHED: 'All fast alongside', SAILED: 'Sailed', CANCELLED: 'Call withdrawn by the agent' };
  const path = seq(call); const out: HistoryEntry[] = []; let prev = '';
  for (const s of path) {
    const at = stamps[s] ?? call.eta;
    out.push({ from: prev, to: s, at: new Date(at).toISOString(), by: 'Harbour Master Control', note: notes[s] ?? '' });
    prev = s;
  }
  return out;
}
const cargoOf = (call: WorldPortCall): CargoOp[] => call.cargoOps.map((o, i) => {
  const started = call.atb ? new Date(new Date(call.atb).getTime() + 2 * H) : null;
  const completed = call.atd ? new Date(new Date(call.atd).getTime() - 2 * H) : null;
  return { id: stableId('cargoop', `${call.id}:${i}`), cargoType: o.cargoType, operation: o.operation, qty: o.qty, unit: o.unit, qtyMT: o.qtyMT || toMT(o.qty, o.unit), gangs: 2 + (i % 3), startedAt: started ? started.toISOString() : null, completedAt: completed ? completed.toISOString() : null, remarks: '', createdAt: new Date(call.eta).toISOString() };
});
const servicesOf = (call: WorldPortCall, vessel: WorldVessel): CallService[] => servicesFor(new Prng(0), call, vessel).map((s, i) => ({
  id: stableId('callservice', `${call.id}:${s.tariffCode}`), type: s.type, tariffCode: s.tariffCode, description: s.description, qty: s.qty, unit: s.unit,
  at: call.atb ? new Date(new Date(call.atb).getTime() + i * H).toISOString() : null, remarks: '', createdAt: new Date(call.eta).toISOString(),
}));

/** Advances a numbering series so the next issued number never collides with a seeded one. */
async function advance(c: Queryable, series: string, value: number) {
  await c.query('INSERT INTO numbering_series(series, last_value) VALUES ($1,$2) ON CONFLICT (series) DO UPDATE SET last_value = GREATEST(numbering_series.last_value, EXCLUDED.last_value)', [series, value]);
}

export async function seedPorts(databaseUrl: string, profile = 'AE') {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });
  const counts = await withTx(pool, async (c) => {
    for (const v of world.vessels) await upsertVessel(c, { id: v.id, imo: v.imo, name: v.name, type: v.type, flag: v.flag, grt: v.grt, dwt: v.dwt, loa: v.loa, maxDraft: v.maxDraft, agentCode: v.agentCode, status: v.status, real: v.real });
    for (const o of world.companies) await upsertCompany(c, { id: o.id, code: o.code, name: o.name, category: o.category, status: o.status });
    for (const t of world.tariffs) await upsertTariff(c, { id: t.id, code: t.code, name: t.name, category: t.category, unit: t.unit, rate: t.rate, currency: t.currency, active: t.active });
    for (const i of world.invoices) await upsertInvoice(c, i);

    /* The estate is what makes the port partition real: a berth belongs to the port it is built in, and a
     * call inherits its port from the berth it is allocated. Everything else follows from these two rows. */
    const homePort = geoFor(world.profile).portCode;
    for (const b of world.berths) {
      await c.query(`INSERT INTO berths(id, code, name, terminal, berth_type, loa_max, draft_max, status, remarks, scope_port) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'',$9)
        ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, terminal = EXCLUDED.terminal, berth_type = EXCLUDED.berth_type, loa_max = EXCLUDED.loa_max, draft_max = EXCLUDED.draft_max, status = EXCLUDED.status, scope_port = EXCLUDED.scope_port, updated_at = now()`,
        [b.id, b.code, b.name, b.terminal, b.berthType, b.loaMax, b.draftMax, b.status, homePort]);
    }
    for (const o of world.berthOutages) {
      await c.query('INSERT INTO berth_outages(id, berth_id, from_at, to_at, days, kind, reason, recorded_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (id) DO UPDATE SET berth_id = EXCLUDED.berth_id, from_at = EXCLUDED.from_at, to_at = EXCLUDED.to_at, days = EXCLUDED.days, kind = EXCLUDED.kind, reason = EXCLUDED.reason, recorded_by = EXCLUDED.recorded_by',
        [o.id, o.berthId, o.from, o.to, o.days, o.kind, o.reason, o.by]);
    }

    const berthByCode = new Map(world.berths.map((b) => [b.code, b]));
    const vesselById = new Map(world.vessels.map((v) => [v.id, v]));
    const agentByCode = new Map(world.companies.map((o) => [o.code, o]));
    const series = new Map<string, number>();
    for (const call of world.portCalls) {
      const v = vesselById.get(call.vesselId);
      const berth = call.berthCode ? berthByCode.get(call.berthCode) : undefined;
      const agent = agentByCode.get(call.agentCode);
      const createdAt = new Date(new Date(call.eta).getTime() - 5 * D);
      const services = v ? servicesOf(call, v) : [];
      await c.query(`INSERT INTO port_calls(id, vcn, vessel_id, vessel_name, vessel_imo, vessel_type, vessel_flag, agent_code, agent_name, purpose, status, eta, etb, etd, ata, atb, atd, berth_id, berth_code, prev_port, next_port, draft_arrival, draft_departure, crew, remarks, services, cargo_ops, sof_entries, status_history, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,'',$25,$26,'[]'::jsonb,$27,$28)
        ON CONFLICT (id) DO UPDATE SET vcn = EXCLUDED.vcn, vessel_id = EXCLUDED.vessel_id, vessel_name = EXCLUDED.vessel_name, vessel_imo = EXCLUDED.vessel_imo, vessel_type = EXCLUDED.vessel_type, vessel_flag = EXCLUDED.vessel_flag, agent_code = EXCLUDED.agent_code, agent_name = EXCLUDED.agent_name,
          purpose = EXCLUDED.purpose, status = EXCLUDED.status, eta = EXCLUDED.eta, etb = EXCLUDED.etb, etd = EXCLUDED.etd, ata = EXCLUDED.ata, atb = EXCLUDED.atb, atd = EXCLUDED.atd, berth_id = EXCLUDED.berth_id, berth_code = EXCLUDED.berth_code, prev_port = EXCLUDED.prev_port, next_port = EXCLUDED.next_port,
          draft_arrival = EXCLUDED.draft_arrival, draft_departure = EXCLUDED.draft_departure, crew = EXCLUDED.crew, services = EXCLUDED.services, cargo_ops = EXCLUDED.cargo_ops, status_history = EXCLUDED.status_history, created_at = EXCLUDED.created_at, updated_at = now()`,
        [call.id, call.vcn, call.vesselId, call.vesselName, v?.imo ?? '', v?.type ?? null, v?.flag ?? null, call.agentCode, agent?.name ?? call.agentCode, v?.type === 'CONT' ? 'Container discharge and loading' : v?.type === 'TANK' ? 'Liquid bulk discharge' : v?.type === 'BULK' ? 'Dry bulk discharge' : 'Cargo operations',
          call.status, call.eta, call.etb, call.etd, call.ata, call.atb, call.atd, berth?.id ?? null, call.berthCode, call.prevPort, call.nextPort, v?.maxDraft ?? null, call.atd && v ? v.maxDraft : null,
          JSON.stringify({ count: 14 + (call.vcn.charCodeAt(call.vcn.length - 1) % 12), master: '' }), JSON.stringify(services), JSON.stringify(cargoOf(call)), JSON.stringify(historyOf(call, createdAt)), createdAt]);
      const at = call.vcn.lastIndexOf('-'); const key = call.vcn.slice(0, at); const n = Number(call.vcn.slice(at + 1));
      if (Number.isFinite(n)) series.set(key, Math.max(series.get(key) ?? 0, n));
    }
    for (const [key, n] of series) await advance(c, key, n);

    let jobs = 0; let outages = 0;
    for (const r of world.resources) {
      await c.query(`INSERT INTO resources(id, code, name, type, spec, status, current_task, master, user_id, contact, remarks, scope_port) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
        ON CONFLICT (id) DO UPDATE SET code = EXCLUDED.code, name = EXCLUDED.name, type = EXCLUDED.type, spec = EXCLUDED.spec, status = EXCLUDED.status, current_task = EXCLUDED.current_task, master = EXCLUDED.master, user_id = EXCLUDED.user_id, contact = EXCLUDED.contact, remarks = EXCLUDED.remarks, scope_port = EXCLUDED.scope_port, updated_at = now()`,
        [r.id, r.code, r.name, r.type, r.spec, r.status, r.currentTask, r.master, r.userId, r.contact, r.remarks, homePort]);
      await c.query('DELETE FROM resource_jobs WHERE resource_id = $1', [r.id]);
      for (const j of r.jobs) {
        await c.query('INSERT INTO resource_jobs(id, resource_id, at, ended_at, kind, vcn, port_call_id, vessel_name, berth, hours, remarks) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) ON CONFLICT (id) DO NOTHING',
          [stableId('resourcejob', `${r.code}:${j.at}:${j.kind}`), r.id, j.at, j.endedAt, j.kind, j.vcn, j.portCallId, j.vesselName, j.berth, j.hours, j.remarks]);
        jobs += 1;
      }
      await c.query('DELETE FROM resource_outages WHERE resource_id = $1', [r.id]);
      for (const o of r.outages) {
        await c.query('INSERT INTO resource_outages(id, resource_id, from_at, to_at, days, reason) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (id) DO NOTHING', [stableId('resourceoutage', `${r.code}:${o.from}`), r.id, o.from, o.to, o.days, o.reason]);
        outages += 1;
      }
    }
    return { profile: world.profile, berths: world.berths.length, berthOutages: world.berthOutages.length, portCalls: world.portCalls.length, resources: world.resources.length, resourceJobs: jobs, resourceOutages: outages, vessels: world.vessels.length, companies: world.companies.length, tariffs: world.tariffs.length, invoices: world.invoices.length, series: series.size };
  });
  await pool.end();
  return counts;
}

if (require.main === module) {
  const e = env();
  seedPorts(e.DATABASE_URL, e.JURISDICTION).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
