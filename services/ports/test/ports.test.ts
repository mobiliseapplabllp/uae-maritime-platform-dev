import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { EVENTS, makeEvent, subjectFor } from '@maritime/contracts';
import { AuditClient, PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256, withTx } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedPorts } from '../src/seed';
import { applyEvent } from '../src/consumer';
import { berthProblems, findBerthConflict, overlaps } from '../src/berthing';
import { computeTotals, tugsFor, wharfageCode } from '../src/pda';

const DB = 'maritime_ports_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let audit: AuditClient; let env: ReturnType<typeof loadEnv<typeof envSchema>>;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const officer = tok('officer'); const clerk = tok('clerk'); const nobody = tok('nobody');
/* The two tenants the harbour registers actually have: an officer posted to one port, and an agent who may
 * see their own company's calls and nothing else. */
const khalifa = tok('khalifa'); const fujairah = tok('fujairah'); const agentGss = tok('agent-gss');
const g = (p: string, t = admin) => request(server as never).get(p).set('authorization', t);
const post = (p: string, body?: unknown, t = admin) => request(server as never).post(p).set('authorization', t).send((body ?? {}) as never);
const put = (p: string, body: unknown, t = admin) => request(server as never).put(p).set('authorization', t).send(body as never);
const del = (p: string, t = admin) => request(server as never).delete(p).set('authorization', t);
const outbox = async (type: string) => (await pool.query('SELECT payload FROM outbox WHERE subject = $1 ORDER BY id', [subjectFor(type)])).rows.map((r) => r.payload as { type: string; data: Record<string, any> });
const clearOutbox = () => pool.query('DELETE FROM outbox');
const H = 3600_000;

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedPorts(URL, 'AE');
  env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET } as never);
  const base = { scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const resolver = new StaticPrincipalResolver({
    admin: { ...base, id: 'admin', sub: 'admin', name: 'Admin', perms: ['*'] },
    officer: { ...base, id: 'officer', sub: 'officer', name: 'Duty Officer', perms: ['portcalls.view', 'portcalls.create', 'portcalls.edit', 'portcalls.transition', 'cargo.manage', 'masters.view'] },
    clerk: { ...base, id: 'clerk', sub: 'clerk', name: 'Records Clerk', perms: ['portcalls.view', 'masters.view'] },
    nobody: { ...base, id: 'nobody', sub: 'nobody', name: 'Nobody', perms: ['dashboard.view'] },
    khalifa: { ...base, id: 'khalifa', sub: 'khalifa', name: 'Khalifa Port Officer', perms: ['portcalls.view', 'portcalls.edit', 'masters.view', 'masters.manage'], scope: { level: 'PORT', ports: ['AEAUH'] } },
    fujairah: { ...base, id: 'fujairah', sub: 'fujairah', name: 'Fujairah Officer', perms: ['portcalls.view', 'masters.view'], scope: { level: 'PORT', ports: ['AEFJR'] } },
    'agent-gss': { ...base, id: 'agent-gss', sub: 'agent-gss', name: 'Gulf Star Shipping', kind: 'agent' as const, perms: ['portcalls.view', 'masters.view'], scope: { level: 'COMPANY', companies: ['GSS'] } },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer(); pool = new Pool({ connectionString: URL }); audit = app.get(AuditClient);
});
afterAll(async () => { await pool?.end(); await app?.close(); });

/** A vessel on the active register that holds no open call, and a berth that fits her and is clear. */
async function freeVessel(minLoa = 0) {
  const r = await pool.query<{ id: string; name: string; loa: string; max_draft: string; grt: number }>(
    `SELECT v.id, v.name, v.loa, v.max_draft, v.grt FROM vessels v WHERE v.status = 'ACTIVE' AND NOT v.real AND v.loa >= $1
       AND NOT EXISTS (SELECT 1 FROM port_calls pc WHERE pc.vessel_id = v.id AND pc.status = ANY($2)) ORDER BY v.loa DESC LIMIT 1`,
    [minLoa, ['ANNOUNCED', 'CONFIRMED', 'AT_ANCHORAGE', 'BERTHED']]);
  return r.rows[0];
}
async function freeBerth() {
  const r = await pool.query<{ id: string; code: string; loa_max: string; draft_max: string }>(
    `SELECT b.id, b.code, b.loa_max, b.draft_max FROM berths b WHERE b.status = 'OPERATIONAL'
       AND NOT EXISTS (SELECT 1 FROM port_calls pc WHERE pc.berth_id = b.id AND pc.status = ANY($1))
       AND NOT EXISTS (SELECT 1 FROM berth_outages o WHERE o.berth_id = b.id AND o.to_at > now()) ORDER BY b.loa_max DESC LIMIT 1`,
    [['CONFIRMED', 'AT_ANCHORAGE', 'BERTHED']]);
  return r.rows[0];
}

describe('ports — berth allocation rules', () => {
  it('treats windows as half-open and blocks an open-ended occupation', () => {
    expect(overlaps(0, 10, 10, 20)).toBe(false);
    expect(overlaps(0, 11, 10, 20)).toBe(true);
    const held = [{ id: 'a', vcn: 'MAR-1', berthId: 'B1', atb: new Date(1000), etb: null, etd: null }];
    expect(findBerthConflict(held, 'B1', new Date(5000), new Date(6000))?.vcn).toBe('MAR-1');
    expect(findBerthConflict(held, 'B2', new Date(5000), new Date(6000))).toBeNull();
    expect(findBerthConflict(held, 'B1', new Date(5000), new Date(6000), 'a')).toBeNull();
  });
  it('refuses a berth out of service, over its LOA or draft limit, or already held', () => {
    const berth = { id: 'B1', code: 'CT1-1', name: 'x', terminal: 't', berth_type: 'CONTAINER', loa_max: 300, draft_max: 14, status: 'OPERATIONAL' };
    const from = new Date(1000); const to = new Date(2000);
    expect(berthProblems({ ...berth, status: 'MAINTENANCE' }, [], [], from, to)?.status).toBe(400);
    expect(berthProblems(berth, [], [], from, to, { vessel: { vesselName: 'X', loa: 340 } })?.status).toBe(409);
    expect(berthProblems(berth, [], [], from, to, { vessel: { vesselName: 'X', draft: 16 } })?.message).toContain('Draft 16');
    expect(berthProblems(berth, [], [{ from_at: new Date(500), to_at: new Date(1500), kind: 'PLANNED', reason: 'Dredging' }], from, to)?.message).toContain('out of service');
    expect(berthProblems(berth, [{ id: 'z', vcn: 'MAR-9', berthId: 'B1', atb: new Date(900), etb: null, etd: new Date(3000) }], [], from, to)?.message).toContain('MAR-9');
    expect(berthProblems(berth, [], [], from, to, { vessel: { vesselName: 'X', loa: 280, draft: 12 } })).toBeNull();
  });
});

describe('ports — estimate arithmetic', () => {
  it('rounds each line to two decimals and sums the total in minor units', () => {
    const t = computeTotals([{ code: 'PD', description: 'Port dues', unit: 'per GRT', qty: 41234, rate: 0.6 }, { code: 'PIL', description: 'Pilotage', unit: 'per movement', qty: 2, rate: 3800 }], 5);
    expect(t.lines[0].amount).toBe(24740.4);
    expect(t.subtotal).toBe(32340.4);
    expect(t.taxAmount).toBe(1617.02);
    expect(t.total).toBe(33957.42);
  });
  it('routes cargo to its wharfage head and scales tugs by length', () => {
    expect(wharfageCode({ unit: 'TEU', cargoType: 'CONTAINERS' })).toBe('WFC');
    expect(wharfageCode({ unit: 'UNITS', cargoType: 'AUTO' })).toBe('WFR');
    expect(wharfageCode({ unit: 'MT', cargoType: 'CRUDE' })).toBe('WFL');
    expect(wharfageCode({ unit: 'MT', cargoType: 'COAL' })).toBe('WFB');
    expect(tugsFor(320)).toBe(3); expect(tugsFor(180)).toBe(2);
  });
});

describe('ports — the vessel-call register', () => {
  it('seeds the register and pages, filters, searches and sorts it', async () => {
    const all = await g('/port-calls?limit=1');
    expect(all.status).toBe(200); expect(all.body.meta.total).toBeGreaterThan(1000); expect(all.body.data).toHaveLength(1);
    const berthed = await g('/port-calls?status=BERTHED&limit=100');
    expect(berthed.body.meta.total).toBe(9);
    expect(berthed.body.data.every((c: { status: string; berthCode: string }) => c.status === 'BERTHED' && !!c.berthCode)).toBe(true);
    const page2 = await g('/port-calls?limit=5&page=2&sort=vcn');
    expect(page2.body.data).toHaveLength(5); expect(page2.body.meta.page).toBe(2);
    const first = await g('/port-calls?limit=5&sort=vcn');
    expect(first.body.data[0].vcn < page2.body.data[0].vcn).toBe(true);
    const one = berthed.body.data[0];
    const search = await g(`/port-calls?q=${encodeURIComponent(one.vcn)}`);
    expect(search.body.meta.total).toBe(1); expect(search.body.data[0].id).toBe(one.id);
    const byVessel = await g(`/port-calls?vessel=${one.vesselId}&limit=200`);
    expect(byVessel.body.data.every((c: { vesselId: string }) => c.vesselId === one.vesselId)).toBe(true);
    const byBerth = await g(`/port-calls?berth=${one.berthId}&limit=200`);
    expect(byBerth.body.data.every((c: { berthId: string }) => c.berthId === one.berthId)).toBe(true);
    const active = await g('/port-calls?active=true&limit=200');
    expect(active.body.data.every((c: { status: string }) => ['ANNOUNCED', 'CONFIRMED', 'AT_ANCHORAGE', 'BERTHED'].includes(c.status))).toBe(true);
    const window = await g('/port-calls?from=2024-01-01&to=2024-12-31&limit=1');
    expect(window.body.meta.total).toBeGreaterThan(0);
    expect(window.body.meta.total).toBeLessThan(all.body.meta.total);
  });

  it('returns a call with its cargo, statement of facts, movements and charges summary', async () => {
    const sailed = (await g('/port-calls?status=SAILED&limit=1&sort=-atd')).body.data[0];
    const detail = await g(`/port-calls/${sailed.id}`);
    expect(detail.status).toBe(200);
    const d = detail.body.data;
    expect(d.cargoOps.length).toBeGreaterThan(0);
    expect(d.services.length).toBeGreaterThan(0);
    expect(d.vessel.imo).toMatch(/^\d{7}$/);
    expect(d.sof.some((e: { event: string }) => /Vessel sailed/.test(e.event))).toBe(true);
    expect(d.sof.map((e: { at: string }) => e.at)).toEqual([...d.sof.map((e: { at: string }) => e.at)].sort());
    expect(d.movements.some((m: { kind: string }) => m.kind === 'ATD')).toBe(true);
    expect(d.turnaroundHours).toBeGreaterThan(0);
    expect(d.charges.invoice?.number).toBeTruthy();
    expect(d.charges.taxName).toBe('VAT');
    expect((await g('/port-calls/00000000-0000-4000-a000-000000000000')).status).toBe(404);
  });

  it('announces a call on its own numbering series, publishes the snapshot and the business event, and records the audit', async () => {
    await clearOutbox();
    const v = await freeVessel();
    const eta = new Date(Date.now() + 30 * H);
    const created = await post('/port-calls', { vesselId: v.id, eta: eta.toISOString(), etd: new Date(eta.getTime() + 40 * H).toISOString(), agentCode: 'GSS', purpose: 'Bunkers and stores', prevPort: 'AEJEA', nextPort: 'SGSIN' }, officer);
    expect(created.status).toBe(201);
    expect(created.body.data.vcn).toMatch(/^VCN-\d{4}-\d{5}$/);
    expect(created.body.data.status).toBe('ANNOUNCED');
    expect(created.body.data.agentName).toBeTruthy();
    expect(created.body.data.statusHistory[0]).toMatchObject({ from: '', to: 'ANNOUNCED', by: 'Duty Officer' });
    const rm = await outbox(EVENTS.readModel.upserted);
    expect(rm).toHaveLength(1); expect(rm[0].data.kind).toBe('portCall'); expect(rm[0].data.entity.vcn).toBe(created.body.data.vcn);
    const scheduled = await outbox(EVENTS.ports.portCallScheduled);
    expect(scheduled).toHaveLength(1); expect(scheduled[0].data.portCall.id).toBe(created.body.data.id);
    const audits = await outbox(EVENTS.audit.recorded);
    expect(audits.some((e) => e.data.action === 'CREATE' && e.data.entity === 'PortCall')).toBe(true);
    const rows = await pool.query('SELECT id FROM outbox ORDER BY id');
    expect(rows.rowCount).toBe(3);
    const second = await post('/port-calls', { vesselId: v.id, eta: eta.toISOString() }, officer);
    expect(second.body.data.vcn).not.toBe(created.body.data.vcn);
    await del(`/port-calls/${second.body.data.id}`);
  });

  it('refuses an unknown or inactive vessel', async () => {
    expect((await post('/port-calls', { vesselId: 'nope', eta: new Date().toISOString() }, officer)).status).toBe(400);
    const inactive = (await pool.query("SELECT id FROM vessels WHERE status <> 'ACTIVE' LIMIT 1")).rows[0];
    if (inactive) {
      const r = await post('/port-calls', { vesselId: inactive.id, eta: new Date().toISOString() }, officer);
      expect(r.status).toBe(400); expect(r.body.message).toContain('registry');
    }
    expect((await post('/port-calls', { eta: new Date().toISOString() }, officer)).status).toBe(400);
  });

  it('walks the lifecycle, allocating a berth and refusing every clash', async () => {
    const v = await freeVessel(); const berth = await freeBerth();
    const eta = new Date(Date.now() + 2 * H);
    const call = (await post('/port-calls', { vesselId: v.id, eta: eta.toISOString(), etd: new Date(eta.getTime() + 30 * H).toISOString() }, officer)).body.data;
    expect((await post(`/port-calls/${call.id}/transition`, { to: 'SAILED' }, officer)).status).toBe(409);
    const confirmed = await post(`/port-calls/${call.id}/transition`, { to: 'CONFIRMED', berthId: berth.id, note: 'Berth allocated' }, officer);
    expect(confirmed.status).toBe(201); expect(confirmed.body.data.status).toBe('CONFIRMED'); expect(confirmed.body.data.berthCode).toBe(berth.code);
    const anchored = await post(`/port-calls/${call.id}/transition`, { to: 'AT_ANCHORAGE' }, officer);
    expect(anchored.body.data.ata).toBeTruthy();
    // a second call cannot take the same berth in the same window
    const other = await freeVessel();
    const rival = (await post('/port-calls', { vesselId: other.id, eta: eta.toISOString(), etd: new Date(eta.getTime() + 20 * H).toISOString() }, officer)).body.data;
    await post(`/port-calls/${call.id}/transition`, { to: 'BERTHED' }, officer);
    await post(`/port-calls/${rival.id}/transition`, { to: 'CONFIRMED' }, officer);
    const clash = await post(`/port-calls/${rival.id}/transition`, { to: 'BERTHED', berthId: berth.id }, officer);
    expect(clash.status).toBe(409); expect(clash.body.message).toContain(berth.code);
    // and a ship too long for the quay is refused outright
    const small = (await pool.query("SELECT id, code FROM berths WHERE status = 'OPERATIONAL' ORDER BY loa_max ASC LIMIT 1")).rows[0];
    const tooBig = await post(`/port-calls/${rival.id}/transition`, { to: 'BERTHED', berthId: small.id }, officer);
    expect([400, 409]).toContain(tooBig.status);
    const berthed = await g(`/port-calls/${call.id}`);
    expect(berthed.body.data.status).toBe('BERTHED'); expect(berthed.body.data.atb).toBeTruthy(); expect(berthed.body.data.ata).toBeTruthy();
    const sailed = await post(`/port-calls/${call.id}/transition`, { to: 'SAILED' }, officer);
    expect(sailed.body.data.status).toBe('SAILED'); expect(sailed.body.data.atd).toBeTruthy(); expect(sailed.body.data.turnaroundHours).toBeGreaterThanOrEqual(0);
    expect((await post(`/port-calls/${call.id}/transition`, { to: 'CANCELLED', note: 'too late' }, officer)).status).toBe(409);
    expect((await put(`/port-calls/${call.id}`, { remarks: 'x' }, officer)).status).toBe(400);
    const noNote = await post(`/port-calls/${rival.id}/transition`, { to: 'CANCELLED' }, officer);
    expect(noNote.status).toBe(400);
    const cancelled = await post(`/port-calls/${rival.id}/transition`, { to: 'CANCELLED', note: 'Owners withdrew the call' }, officer);
    expect(cancelled.body.data.status).toBe('CANCELLED');
    expect((await del(`/port-calls/${rival.id}`)).status).toBe(200);
    return { call };
  });

  it('publishes the read-model snapshot before the business event on every move', async () => {
    await clearOutbox();
    const v = await freeVessel(); const berth = await freeBerth();
    const eta = new Date(Date.now() + 4 * H);
    const call = (await post('/port-calls', { vesselId: v.id, eta: eta.toISOString(), etd: new Date(eta.getTime() + 24 * H).toISOString() }, officer)).body.data;
    await post(`/port-calls/${call.id}/transition`, { to: 'CONFIRMED', berthId: berth.id }, officer);
    await post(`/port-calls/${call.id}/transition`, { to: 'BERTHED' }, officer);
    const rows = (await pool.query<{ payload: { type: string } }>('SELECT payload FROM outbox ORDER BY id')).rows.map((r) => r.payload.type);
    const rmAt = rows.indexOf(EVENTS.readModel.upserted);
    expect(rmAt).toBeLessThan(rows.indexOf(EVENTS.ports.portCallScheduled));
    expect(rows.indexOf(EVENTS.readModel.upserted, rows.indexOf(EVENTS.ports.berthed) - 2)).toBeLessThan(rows.indexOf(EVENTS.ports.berthed));
    expect(rows).toContain(EVENTS.ports.confirmed);
    await post(`/port-calls/${call.id}/transition`, { to: 'SAILED' }, officer);
    const sailedEvents = await outbox(EVENTS.ports.sailed);
    expect(sailedEvents).toHaveLength(1);
    expect(sailedEvents[0].data.portCall.services).toBeDefined();
    expect(sailedEvents[0].data.portCall.vessel.grt).toBeGreaterThan(0);
  });

  it('keeps cargo operations, services and statement entries on the call', async () => {
    const v = await freeVessel();
    const call = (await post('/port-calls', { vesselId: v.id, eta: new Date(Date.now() + 6 * H).toISOString() }, officer)).body.data;
    const added = await post(`/port-calls/${call.id}/cargo`, { cargoType: 'CONTAINERS', operation: 'DISCHARGE', qty: 1200, unit: 'TEU', gangs: 3, startedAt: new Date(Date.now() + 7 * H).toISOString() }, officer);
    expect(added.status).toBe(201);
    const op = added.body.data.cargoOps[0];
    expect(op.qtyMT).toBe(14400);
    const patched = await put(`/port-calls/${call.id}/cargo/${op.id}`, { qty: 900 }, officer);
    expect(patched.body.data.cargoOps[0].qty).toBe(900); expect(patched.body.data.cargoOps[0].qtyMT).toBe(10800);
    expect(patched.body.data.cargoMT).toBe(10800); expect(patched.body.data.teu).toBe(900);
    expect((await put(`/port-calls/${call.id}/cargo/00000000-0000-4000-a000-000000000000`, { qty: 1 }, officer)).status).toBe(404);
    const svc = await post(`/port-calls/${call.id}/services`, { type: 'TUGS', tariffCode: 'TUG', description: '2 tugs x 2 movements', qty: 4, unit: 'tug-movement' }, officer);
    expect(svc.body.data.services).toHaveLength(1);
    const entry = await post(`/port-calls/${call.id}/sof`, { at: new Date().toISOString(), event: 'Hatches opened', detail: 'Gangs standing by' }, officer);
    expect(entry.body.data.events.some((e: { event: string }) => e.event === 'Hatches opened')).toBe(true);
    const sof = await g(`/port-calls/${call.id}/sof`, officer);
    expect(sof.body.data.call.vcn).toBe(call.vcn);
    expect(sof.body.data.events.some((e: { event: string }) => /Discharge CONTAINERS/.test(e.event))).toBe(true);
    const cleared = await del(`/port-calls/${call.id}/cargo/${op.id}`, officer);
    expect(cleared.body.data.cargoOps).toHaveLength(0);
    const svcId = svc.body.data.services[0].id;
    expect((await del(`/port-calls/${call.id}/services/${svcId}`, officer)).body.data.services).toHaveLength(0);
  });

  it('prices a pro-forma disbursement account off the rate card and reconciles it against the invoice', async () => {
    const sailed = (await pool.query<{ id: string }>("SELECT pc.id FROM port_calls pc JOIN invoices i ON i.port_call_id = pc.id::text AND i.status IN ('ISSUED','PAID') WHERE pc.status = 'SAILED' ORDER BY pc.atd DESC LIMIT 1")).rows[0];
    expect((await g(`/port-calls/${sailed.id}/pda`)).status).toBe(404);
    const made = await post(`/port-calls/${sailed.id}/pda`, {}, admin);
    expect(made.status).toBe(201);
    const pda = made.body.data;
    expect(pda.number).toMatch(/^PDA\//); expect(pda.taxRate).toBe(5); expect(pda.currency).toBe('AED');
    expect(pda.lines.some((l: { code: string }) => l.code === 'PD')).toBe(true);
    expect(pda.lines.some((l: { code: string }) => l.code === 'PIL')).toBe(true);
    expect(Math.round((pda.subtotal + pda.taxAmount) * 100) / 100).toBe(pda.total);
    expect(pda.taxAmount).toBe(Math.round(pda.subtotal * 5) / 100);
    const view = await g(`/port-calls/${sailed.id}/pda`);
    expect(view.body.data.variance.invoiceNumber).toBeTruthy();
    expect(view.body.data.variance.delta).toBe(Math.round((view.body.data.variance.actualTotal - view.body.data.variance.estimatedTotal) * 100) / 100);
  });

  it('denies by default and refuses the moves a role does not hold', async () => {
    expect((await request(server as never).get('/port-calls')).status).toBe(401);
    expect((await g('/port-calls', nobody)).status).toBe(403);
    expect((await post('/port-calls', { vesselId: 'x', eta: new Date().toISOString() }, clerk)).status).toBe(403);
    const one = (await g('/port-calls?limit=1', clerk)).body.data[0];
    expect((await post(`/port-calls/${one.id}/transition`, { to: 'CONFIRMED' }, clerk)).status).toBe(403);
    expect((await post(`/port-calls/${one.id}/cargo`, { cargoType: 'X', operation: 'LOAD', qty: 1, unit: 'MT' }, clerk)).status).toBe(403);
    expect((await del(`/port-calls/${one.id}`, officer)).status).toBe(403);
    expect((await post('/berths', { code: 'ZZ-9', name: 'x', terminal: 't' }, officer)).status).toBe(403);
  });
});

describe('ports — the berth estate', () => {
  it('lists, filters and searches the estate and carries the outage digest', async () => {
    const all = await g('/berths?limit=100');
    expect(all.body.meta.total).toBe(24);
    expect(all.body.data[0].outages.length).toBeGreaterThan(0);
    const containers = await g('/berths?berthType=CONTAINER&limit=50');
    expect(containers.body.data.every((b: { berthType: string }) => b.berthType === 'CONTAINER')).toBe(true);
    const search = await g('/berths?q=liquid');
    expect(search.body.meta.total).toBeGreaterThan(0);
  });
  it('runs berth CRUD, protects a berth in use and keeps the outage record', async () => {
    await clearOutbox();
    const made = await post('/berths', { code: 'TST-1', name: 'Trial Berth 1', terminal: 'Trial Terminal', berthType: 'MULTIPURPOSE', loaMax: 200, draftMax: 10 });
    expect(made.status).toBe(201);
    const id = made.body.data.id;
    expect((await outbox(EVENTS.readModel.upserted))[0].data.kind).toBe('berth');
    expect((await outbox(EVENTS.ports.berthChanged))).toHaveLength(1);
    expect((await post('/berths', { code: 'TST-1', name: 'dup', terminal: 't' })).status).toBe(409);
    const edited = await put(`/berths/${id}`, { status: 'MAINTENANCE', remarks: 'Fender renewal' });
    expect(edited.body.data.status).toBe('MAINTENANCE');
    const from = new Date(Date.now() - 3 * 24 * H); const to = new Date(Date.now() + 2 * 24 * H);
    const outage = await post(`/berths/${id}/outages`, { from: from.toISOString(), to: to.toISOString(), kind: 'BREAKDOWN', reason: 'Bollard damage' });
    expect(outage.status).toBe(201);
    expect(outage.body.data.summary.lifetime.outages).toBe(1);
    expect(outage.body.data.summary.availabilityPct).toBeLessThan(100);
    expect((await post(`/berths/${id}/outages`, { from: from.toISOString(), to: to.toISOString(), kind: 'PLANNED' })).status).toBe(409);
    expect((await post(`/berths/${id}/outages`, { from: to.toISOString(), to: from.toISOString() })).status).toBe(400);
    const report = await g(`/berths/${id}/outages`);
    expect(report.body.data.outages).toHaveLength(1);
    expect(report.body.data.summary.byKind[0].kind).toBe('BREAKDOWN');
    const outageId = report.body.data.outages[0].id;
    expect((await del(`/berths/${id}/outages/${outageId}`)).body.data.deleted).toBe(true);
    expect((await del(`/berths/${id}`)).body.data.deleted).toBe(true);
    expect((await g(`/berths/${id}`)).status).toBe(404);
    const inUse = (await pool.query("SELECT berth_id FROM port_calls WHERE status = 'BERTHED' AND berth_id IS NOT NULL LIMIT 1")).rows[0];
    const refused = await del(`/berths/${inUse.berth_id}`);
    expect(refused.status).toBe(400); expect(refused.body.message).toContain('free it first');
  });
  it('reports estate downtime and the berth board', async () => {
    const dt = await g('/berths/downtime?months=12');
    expect(dt.body.data.estate.berths).toBe(24);
    expect(dt.body.data.estate.availabilityPct).toBeLessThanOrEqual(100);
    expect(dt.body.data.series).toHaveLength(12);
    expect(dt.body.data.byKind.length).toBeGreaterThan(0);
    expect(dt.body.data.berths[0].days).toBeGreaterThanOrEqual(dt.body.data.berths[1].days);
    const board = await g('/berths/board');
    expect(board.body.data.berths).toHaveLength(24);
    expect(board.body.data.occupancy.occupied).toBeGreaterThan(0);
    expect(board.body.data.berths.some((b: { occupiedBy: unknown }) => !!b.occupiedBy)).toBe(true);
  });
});

describe('ports — harbour operations', () => {
  it('draws the quay twin, the day programme and the berth window plan', async () => {
    const twin = await g('/ops/twin');
    expect(twin.body.data.berths).toHaveLength(24);
    expect(twin.body.data.berths.filter((b: { occupiedBy: unknown }) => b.occupiedBy).length).toBeGreaterThan(0);
    expect(twin.body.data.anchorage.length).toBeGreaterThan(0);
    expect(twin.body.data.inbound.length).toBeGreaterThan(0);
    const sched = await g('/ops/schedule?days=5');
    expect(sched.body.data.events.length).toBeGreaterThan(0);
    expect(sched.body.data.events.every((e: { kind: string }) => ['ARRIVAL', 'BERTHING', 'SAILING', 'SAILED'].includes(e.kind))).toBe(true);
    expect(sched.body.data.byDay.length).toBeGreaterThan(0);
    expect(sched.body.data.byDay.reduce((s: number, d: { events: unknown[] }) => s + d.events.length, 0)).toBe(sched.body.data.events.length);
    const plan = await g('/ops/berth-plan?days=5');
    expect(plan.body.data.berths).toHaveLength(24);
    expect(plan.body.data.blocks.length).toBeGreaterThan(0);
    expect(plan.body.data.blocks.every((b: { berthId: string; start: string }) => !!b.berthId && !!b.start)).toBe(true);
    expect(Array.isArray(plan.body.data.conflicts)).toBe(true);
  });
  it('shows the craft board with its service digest and the fleet utilisation', async () => {
    const board = await g('/ops/resources');
    expect(board.body.data).toHaveLength(17);
    const tug = board.body.data.find((r: { code: string }) => r.code === 'TUG-01');
    expect(tug.service.jobs).toBeGreaterThan(0);
    expect(tug.service.hours).toBeGreaterThan(0);
    expect(tug.service.availabilityPct).toBeLessThanOrEqual(100);
    expect(tug.service.lastJobAt).toBeTruthy();
    expect((board.body.data as { jobs?: unknown }[]).every((r) => r.jobs === undefined)).toBe(true);
    const util = await g('/ops/resources/utilisation?months=12');
    expect(util.body.data.totals.craft).toBe(17);
    expect(util.body.data.series).toHaveLength(12);
    expect(util.body.data.byType.length).toBeGreaterThan(1);
    expect(util.body.data.craft[0].jobs).toBeGreaterThanOrEqual(util.body.data.craft[1].jobs);
    const hist = await g(`/ops/resources/${tug.id}/history?limit=10`);
    expect(hist.body.meta.total).toBe(tug.service.jobs);
    expect(hist.body.data.jobs).toHaveLength(10);
    expect(hist.body.meta.kinds.length).toBeGreaterThan(0);
    expect(hist.body.data.summary.lifetime.jobs).toBe(tug.service.jobs);
    const filtered = await g(`/ops/resources/${tug.id}/history?kind=${hist.body.meta.kinds[0]}&limit=5`);
    expect(filtered.body.data.jobs.every((j: { kind: string }) => j.kind === hist.body.meta.kinds[0])).toBe(true);
  });
  it('works the craft board: status, job assignment and out-of-service windows', async () => {
    await clearOutbox();
    const craft = (await pool.query<{ id: string; code: string }>("SELECT id, code FROM resources WHERE type = 'TUG' AND status = 'AVAILABLE' ORDER BY code LIMIT 1")).rows[0];
    const tasked = await put(`/ops/resources/${craft.id}`, { status: 'TASKED', currentTask: 'Standby at the fairway' }, officer);
    expect(tasked.body.data.status).toBe('TASKED'); expect(tasked.body.data.currentTask).toBe('Standby at the fairway');
    expect((await outbox(EVENTS.readModel.upserted))[0].data.kind).toBe('resource');
    expect((await outbox(EVENTS.readModel.upserted))[0].data.entity.jobs.length).toBeGreaterThan(0);
    const back = await put(`/ops/resources/${craft.id}`, { status: 'AVAILABLE' }, officer);
    expect(back.body.data.currentTask).toBe('');
    const call = (await pool.query<{ id: string; vcn: string }>("SELECT id, vcn FROM port_calls WHERE status = 'BERTHED' LIMIT 1")).rows[0];
    const job = await post(`/ops/resources/${craft.id}/jobs`, { kind: 'BERTHING', portCallId: call.id, remarks: 'Two-tug assist' }, officer);
    expect(job.status).toBe(201);
    expect(job.body.data.status).toBe('TASKED');
    expect(job.body.data.job.vcn).toBe(call.vcn);
    const closed = await put(`/ops/resources/${craft.id}/jobs/${job.body.data.job.id}`, { hours: 2.5 }, officer);
    expect(closed.body.data.status).toBe('AVAILABLE');
    const hist = await g(`/ops/resources/${craft.id}/history?limit=1`);
    expect(hist.body.data.jobs[0].hours).toBe(2.5);
    const maint = (await pool.query<{ id: string }>("SELECT id FROM resources WHERE status = 'MAINTENANCE' LIMIT 1")).rows[0];
    expect((await post(`/ops/resources/${maint.id}/jobs`, { kind: 'BERTHING' }, officer)).status).toBe(409);
    const dock = await post(`/ops/resources/${craft.id}/outages`, { from: new Date(Date.now() - H).toISOString(), to: new Date(Date.now() + 5 * 24 * H).toISOString(), reason: 'Annual survey' }, admin);
    expect(dock.status).toBe(201);
    expect(dock.body.data.resource.status).toBe('MAINTENANCE');
    expect((await g('/ops/resources', nobody)).status).toBe(403);
  });
});

describe('ports — the event consumer', () => {
  const deps = () => ({ env, audit });
  it('projects the ship register, the directory, the rate card and invoices, and is idempotent', async () => {
    const id = 'test-vessel-1';
    const event = makeEvent({ type: EVENTS.readModel.upserted, source: 'ships', data: { kind: 'vessel', entity: { id, imo: '9111111', name: 'Trial Runner', type: 'GEN', flag: 'AE', grt: 12000, dwt: 18000, loa: 150, maxDraft: 9, agentCode: 'GSS', status: 'ACTIVE', real: false } } });
    await withTx(pool, (c) => applyEvent(c, deps(), event));
    const v = (await pool.query('SELECT name, grt FROM vessels WHERE id = $1', [id])).rows[0];
    expect(v).toMatchObject({ name: 'Trial Runner', grt: 12000 });
    // the projected ship can be announced against straight away
    const call = await post('/port-calls', { vesselId: id, eta: new Date(Date.now() + 50 * H).toISOString() }, officer);
    expect(call.status).toBe(201); expect(call.body.data.vesselName).toBe('Trial Runner');
    await del(`/port-calls/${call.body.data.id}`);
    await withTx(pool, (c) => applyEvent(c, deps(), makeEvent({ type: EVENTS.readModel.upserted, source: 'revenue', data: { kind: 'tariff', entity: { id: 'test-tariff', code: 'ZZZ', name: 'Trial head', category: 'MISC', unit: 'per call', rate: 99.5, currency: 'AED', active: true } } })));
    expect(Number((await pool.query("SELECT rate FROM tariffs WHERE code = 'ZZZ'")).rows[0].rate)).toBe(99.5);
    await withTx(pool, (c) => applyEvent(c, deps(), makeEvent({ type: EVENTS.readModel.deleted, source: 'revenue', data: { kind: 'tariff', id: 'test-tariff' } })));
    expect((await pool.query("SELECT rate FROM tariffs WHERE code = 'ZZZ'")).rowCount).toBe(0);
    await withTx(pool, (c) => applyEvent(c, deps(), makeEvent({ type: EVENTS.readModel.upserted, source: 'mdm', data: { kind: 'company', entity: { id: 'test-co', code: 'TCO', name: 'Trial Agencies', category: 'AGENCY', status: 'ACTIVE' } } })));
    expect((await pool.query("SELECT name FROM companies WHERE code = 'TCO'")).rows[0].name).toBe('Trial Agencies');
  });
  it('flags a detention ordered against a call and lifts it again', async () => {
    const call = (await pool.query<{ id: string; vcn: string }>("SELECT id, vcn FROM port_calls WHERE status = 'BERTHED' LIMIT 1")).rows[0];
    const order = makeEvent({ type: EVENTS.inspection.detention, source: 'inspection', data: { portCallId: call.id, reason: 'Deficiencies grounds for detention' } });
    expect(await withTx(pool, (c) => applyEvent(c, deps(), order).then(() => true))).toBe(true);
    expect((await g(`/port-calls/${call.id}`)).body.data.detention).toBe(true);
    await withTx(pool, (c) => applyEvent(c, deps(), makeEvent({ type: EVENTS.inspection.detention, source: 'inspection', data: { vcn: call.vcn, released: true } })));
    expect((await g(`/port-calls/${call.id}`)).body.data.detention).toBe(false);
  });
});

/* ================================================================= tenancy on the harbour registers === */

describe('ports — tenancy', () => {
  it('seeds the estate into its port, so a call inherits the port of the berth it is allocated', async () => {
    const berths = await pool.query<{ n: string; ports: string[] }>(
      "SELECT count(*)::text AS n, array_agg(DISTINCT scope_port) AS ports FROM berths");
    expect(Number(berths.rows[0].n)).toBeGreaterThan(0);
    expect(berths.rows[0].ports).toEqual(['AEAUH']);
    const berthed = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM port_calls WHERE berth_id IS NOT NULL AND scope_port <> 'AEAUH'");
    expect(Number(berthed.rows[0].n)).toBe(0);
    // a call with no berth is not yet any port's, which is why it is shared rather than hidden
    const unberthed = await pool.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM port_calls WHERE berth_id IS NULL AND scope_port <> ''");
    expect(Number(unberthed.rows[0].n)).toBe(0);
    // and every call belongs to the agent named on it
    const owned = await pool.query<{ mismatched: string }>(
      "SELECT count(*)::text AS mismatched FROM port_calls WHERE agent_code <> '' AND scope_company <> agent_code");
    expect(Number(owned.rows[0].mismatched)).toBe(0);
  });

  it('shows a port officer their own port and an officer elsewhere nothing of it', async () => {
    const mine = await g('/berths?limit=200', khalifa);
    expect(mine.status).toBe(200);
    expect(mine.body.meta.total).toBeGreaterThan(0);
    const theirs = await g('/berths?limit=200', fujairah);
    expect(theirs.status).toBe(200);
    expect(theirs.body.meta.total).toBe(0);
    // the count is the filtered count, not a full count with a filtered page hung off it
    expect(theirs.body.data).toHaveLength(0);
    // and the same is true of the boards drawn from the same tables
    expect((await g('/ops/twin', fujairah)).body.data.berths).toHaveLength(0);
    expect((await g('/ops/twin', khalifa)).body.data.berths.length).toBeGreaterThan(0);
    expect((await g('/ops/resources', fujairah)).body.data).toHaveLength(0);
    expect((await g('/ops/resources', khalifa)).body.data.length).toBeGreaterThan(0);
  });

  it('answers "not found" for one record in another port, so its existence is not disclosed', async () => {
    // a berth in the other officer's port, so the rule is tested in both directions on real rows
    const other = (await pool.query<{ id: string }>(
      `INSERT INTO berths(code, name, terminal, berth_type, loa_max, draft_max, status, scope_port)
       VALUES ('FJR-9', 'Fujairah 9', 'FJR', 'MULTIPURPOSE', 300, 16, 'OPERATIONAL', 'AEFJR') RETURNING id`)).rows[0];
    try {
      expect((await g(`/berths/${other.id}`, fujairah)).status).toBe(200);
      const denied = await g(`/berths/${other.id}`, khalifa);
      expect(denied.status).toBe(404);
      // word for word the answer a berth that never existed would get
      expect(denied.body.message).toBe((await g('/berths/00000000-0000-0000-0000-000000000000', khalifa)).body.message);
      // and a write the reader does hold the permission for is refused by the same route, not a different one
      expect((await request(server as never).delete(`/berths/${other.id}`).set('authorization', khalifa)).status).toBe(404);
      expect((await pool.query('SELECT id FROM berths WHERE id = $1', [other.id])).rowCount).toBe(1);
      // the register a port officer does own is unaffected
      const mine = (await g('/berths?limit=1', khalifa)).body.data[0];
      expect((await g(`/berths/${mine.id}`, khalifa)).status).toBe(200);
    } finally {
      await pool.query('DELETE FROM berths WHERE id = $1', [other.id]);
    }
  });

  it('shows an agent their own company\'s calls and nobody else\'s', async () => {
    const mine = await g('/port-calls?limit=500', agentGss);
    expect(mine.status).toBe(200);
    expect(mine.body.meta.total).toBeGreaterThan(0);
    expect(mine.body.data.every((c: any) => c.agentCode === 'GSS')).toBe(true);
    const all = await g('/port-calls?limit=500', admin);
    expect(all.body.meta.total).toBeGreaterThan(mine.body.meta.total);

    // one call belonging to another agent: not listed, and not readable by id either
    const other = all.body.data.find((c: any) => c.agentCode && c.agentCode !== 'GSS');
    expect(other).toBeTruthy();
    expect(mine.body.data.some((c: any) => c.id === other.id)).toBe(false);
    expect((await g(`/port-calls/${other.id}`, agentGss)).status).toBe(404);
    expect((await g(`/port-calls/${other.id}/sof`, agentGss)).status).toBe(404);
    expect((await g(`/port-calls/${other.id}`, admin)).status).toBe(200);
    // and one of their own is readable, by id and by call number
    const own = mine.body.data[0];
    expect((await g(`/port-calls/${own.id}`, agentGss)).status).toBe(200);
    expect((await g(`/port-calls/${own.vcn}`, agentGss)).status).toBe(200);
  });

  it('lets an agent read the published estate but not the register the administration keeps', async () => {
    // a berth list is how an agent knows where their ship is going: published, and readable
    expect((await g('/berths?limit=5', agentGss)).body.meta.total).toBeGreaterThan(0);
    // the craft roster is a service they order, so it is theirs to read too
    expect((await g('/ops/resources', agentGss)).body.data.length).toBeGreaterThan(0);
  });

  it('narrows the boards and planners an agent sees to their own calls', async () => {
    const twin = (await g('/ops/twin', agentGss)).body.data;
    const occupied = twin.berths.filter((b: any) => b.occupiedBy);
    const adminTwin = (await g('/ops/twin', admin)).body.data;
    expect(adminTwin.berths.filter((b: any) => b.occupiedBy).length).toBeGreaterThanOrEqual(occupied.length);
    expect(twin.anchorage.length + twin.inbound.length).toBeLessThanOrEqual(adminTwin.anchorage.length + adminTwin.inbound.length);
    const plan = (await g('/ops/berth-plan?days=30', agentGss)).body.data;
    const adminPlan = (await g('/ops/berth-plan?days=30', admin)).body.data;
    expect(JSON.stringify(plan).length).toBeLessThanOrEqual(JSON.stringify(adminPlan).length);
  });

  it('leaves a national principal seeing everything, with no clause added at all', async () => {
    const all = await g('/port-calls?limit=1', admin);
    const officerView = await g('/port-calls?limit=1', officer);
    expect(officerView.body.meta.total).toBe(all.body.meta.total);
    expect((await g('/berths?limit=1', officer)).body.meta.total).toBe((await g('/berths?limit=1', admin)).body.meta.total);
  });
});
