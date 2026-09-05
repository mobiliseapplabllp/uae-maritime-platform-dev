import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { KIT_CACHE, createApp, loadEnv, StaticPrincipalResolver, PRINCIPAL_RESOLVER, signHS256, withTx, type Cache } from '@maritime/service-kit';
import { makeEvent, EVENTS } from '@maritime/contracts';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedReporting } from '../src/seed';
import { invalidateDerived, project } from '../src/consumer';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://maritime:maritime@127.0.0.1:5432/postgres';
const DB = 'maritime_reporting_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`;
const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let cache: Cache;
const principal = (id: string, perms: string[]) => ({ id, sub: id, name: `User ${id}`, email: `${id}@maritime.example`, perms, scope: { level: 'NATIONAL' as const }, kind: 'user' as const, active: true });
const token = (sub: string) => signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 3600, issuer: 'maritime-platform' });
const get = (path: string, as = 'admin') => request(server as never).get(path).set('authorization', `Bearer ${token(as)}`);

beforeAll(async () => {
  const admin = new Pool({ connectionString: ADMIN_URL });
  await admin.query(`DROP DATABASE IF EXISTS ${DB}`); await admin.query(`CREATE DATABASE ${DB}`); await admin.end();
  await seedReporting(URL, 'AE');
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET } as never);
  const resolver = { provide: PRINCIPAL_RESOLVER, useValue: new StaticPrincipalResolver({
    admin: principal('admin', ['*']),
    agent: principal('agent', ['portcalls.view', 'invoices.view']),
    /* A shipping agent as they really are: scoped to one company, holding the permissions their role holds
     * over their own records — which is the case these surfaces used to answer nationally. */
    gss: { ...principal('gss', ['vessels.view', 'portcalls.view', 'invoices.view', 'legislation.view', 'registry.view', 'dashboard.view']), scope: { level: 'COMPANY' as const, companies: ['GSS'] } },
    registrar: principal('registrar', ['legislation.view', 'legislation.manage']),
    /* The other kind of external tenant: a licensed manning agency, scoped to the seafarers it placed. */
    mca: { ...principal('mca', ['seafarers.view', 'dashboard.view']), scope: { level: 'COMPANY' as const, companies: ['MCA'] } },
  }) };
  app = await createApp({ env, module: buildAppModule(env, resolver) });
  await app.init(); server = app.getHttpServer();
  pool = new Pool({ connectionString: URL });
  cache = app.get<Cache>(KIT_CACHE);
});
afterAll(async () => { await app?.close(); await pool?.end(); });

describe('reporting', () => {
  it('serves the command-centre dashboard from the seeded read models', async () => {
    const r = await get('/dashboard'); expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.kpis.vesselsAtBerth).toBeGreaterThan(0); expect(d.throughputByMonth).toHaveLength(12); expect(d.berthBoard.length).toBe(24);
    expect(d.arrivals.length).toBeGreaterThan(0); expect(d.throughputByMonth.some((m: { total: number }) => m.total > 0)).toBe(true);
  });
  it('computes every stat scope and enforces the scope permission', async () => {
    for (const scope of ['portcalls', 'berths', 'registry', 'vessels', 'certificates', 'seafarers', 'met', 'crewLists', 'legislation', 'facilities', 'inspections', 'incidents', 'invoices', 'risk', 'masters', 'users', 'tariffs', 'marine', 'audit']) {
      const r = await get(`/stats/${scope}`); expect(r.status, scope).toBe(200); expect(r.body.data.cards.length, scope).toBeGreaterThanOrEqual(4);
    }
    expect((await get('/stats/users', 'agent')).status).toBe(403);
    expect((await get('/stats/nope')).status).toBe(404);
    const cards = (await get('/stats/portcalls')).body.data.cards; expect(cards[0].label).toBe('At berth'); expect(cards).toHaveLength(8);
  });
  it('searches only the registers the caller may see', async () => {
    const admin = await get('/search?q=MSC'); expect(admin.status).toBe(200);
    expect(admin.body.data.groups.some((g: { type: string }) => g.type === 'vessel')).toBe(true);
    const agent = await get('/search?q=a', 'agent'); expect(agent.body.data.groups.every((g: { type: string }) => ['call', 'invoice'].includes(g.type))).toBe(true);
    expect((await get('/search?q=x')).body.data.groups).toEqual([]);
  });
  it('renders hover cards for vessels, berths, users and agents', async () => {
    const v = (await get('/search?q=Maersk')).body.data.groups.find((g: { type: string }) => g.type === 'vessel').items[0];
    const card = await get(`/cards/vessel/${v.id}`); expect(card.status).toBe(200); expect(card.body.data.kind).toBe('vessel'); expect(card.body.data.lines[0].label).toBe('Now');
    const berth = await get('/cards/berth/CT1-1'); expect(berth.status).toBe(200); expect(berth.body.data.chips[1].label).toMatch(/Occupied|Free/);
    expect((await get('/cards/user/00000000-0000-0000-0000-000000000000')).status).toBe(404);
    expect((await get('/cards/thing/1')).status).toBe(404);
  });
  it('lists the report library and runs a report with sanitised parameters', async () => {
    const cat = await get('/reports/catalog'); expect(cat.body.data.length).toBeGreaterThanOrEqual(15);
    const run = await get('/reports/run/port-calls-by-month?months=6;DROP'); expect(run.status).toBe(200); expect(run.body.data.params.months).toBe('12');
    expect((await get('/reports/run/port-calls-by-month?months=99999')).body.data.params.months).toBe('3650');
    const ok = await get('/reports/run/port-calls-by-month?months=6'); expect(ok.body.data.rows.length).toBeGreaterThan(0); expect(ok.body.data.currency).toBe('AED');
    expect((await get('/reports/run/nope')).status).toBe(404);
    const mis = await get('/reports/mis?months=6'); expect(mis.body.data.rows).toHaveLength(6); expect(mis.body.data.totals.calls).toBeGreaterThan(0); expect(mis.body.data.benchmarks.length).toBeGreaterThan(0);
  });
  it('projects read-model events and audit activity idempotently', async () => {
    const e = makeEvent({ type: EVENTS.readModel.upserted, source: 'ports', data: { kind: 'portCall', entity: { id: '11111111-1111-4111-8111-111111111111', vcn: 'TST-2026-9999', vesselId: '22222222-2222-4222-8222-222222222222', vesselName: 'Test Ship', status: 'BERTHED', eta: new Date().toISOString(), cargoOps: [{ cargoType: 'CONTAINERS', qty: 100, unit: 'TEU', qtyMT: 1200 }] } } });
    await withTx(pool, (c) => project(c, e)); await withTx(pool, (c) => project(c, { ...e, data: { ...e.data, entity: { ...(e.data as { entity: object }).entity, status: 'SAILED' } } }));
    const row = (await pool.query('SELECT status, teu FROM rm_port_calls WHERE vcn = $1', ['TST-2026-9999'])).rows[0]; expect(row.status).toBe('SAILED'); expect(row.teu).toBe(100);
    const a = makeEvent({ type: EVENTS.audit.recorded, source: 'identity-access', data: { action: 'LOGIN', entity: 'User', entityLabel: 'x@maritime.example', actor: { id: 'u1', name: 'Someone' }, at: new Date().toISOString() } });
    await withTx(pool, (c) => project(c, a)); await withTx(pool, (c) => project(c, a));
    expect(Number((await pool.query('SELECT count(*) AS n FROM rm_audit_activity WHERE id = $1', [a.id])).rows[0].n)).toBe(1);
    /* Driving `project` directly is what the consumer does inside a transaction; the invalidation it does
     * afterwards is part of the same contract, so this test owes it too. */
    await invalidateDerived(cache);
    const dash = await get('/dashboard'); expect(dash.body.data.recentActivity[0].actor).toBe('Someone');
  });
  /*
   * STK-05 and STK-06: search runs behind a driver seam and the read paths are cached. Both are places
   * where an answer can be produced somewhere other than the query that authorises it, so both are tested
   * for the boundary and not only for the feature.
   */
  it('searches through the driver seam and reports which driver answered', async () => {
    const r = await get('/search?q=Maersk');
    expect(r.status).toBe(200);
    expect(r.body.data.driver).toBe('postgres');
    expect(r.body.data.groups.find((g: { type: string }) => g.type === 'vessel').items.length).toBeGreaterThan(0);
  });

  it('finds a notice by its Arabic title, not only its English one', async () => {
    const ar = await get('/search?q=' + encodeURIComponent('الاتفاقية'));
    const notices = ar.body.data.groups.find((g: { type: string }) => g.type === 'notice');
    expect(notices?.items.length).toBeGreaterThan(0);
    expect(notices.items[0].labelAr).toContain('الاتفاقية');
  });

  it('keeps the tenancy boundary in the query when search matches across it', async () => {
    /* The driver ranks by relevance and knows nothing about the reader. An agent must still only see their
     * own company's invoices, however high another company's rank. */
    const all = (await get('/search?q=INV', 'admin')).body.data.groups.find((g: { type: string }) => g.type === 'invoice');
    const mine = (await get('/search?q=INV', 'gss')).body.data.groups.find((g: { type: string }) => g.type === 'invoice');
    expect(all.items.length).toBeGreaterThan(0);
    if (mine) expect(mine.items.length).toBeLessThanOrEqual(all.items.length);
    const invoices = await pool.query<{ scope_company: string }>('SELECT scope_company FROM rm_invoices WHERE number = ANY($1::text[])', [(mine?.items ?? []).map((i: { label: string }) => i.label)]);
    for (const row of invoices.rows) expect(row.scope_company).toBe('GSS');
  });

  it('serves a repeated stat strip from the cache and recomputes it after a projection', async () => {
    await invalidateDerived(cache);
    const before = cache.stats().hits;
    const first = await get('/stats/portcalls'); expect(first.status).toBe(200);
    const second = await get('/stats/portcalls'); expect(second.status).toBe(200);
    expect(second.body.data.cards).toEqual(first.body.data.cards);
    expect(cache.stats().hits).toBeGreaterThan(before);
    /* After a projection invalidates, the next ask is a miss again — the strip is recomputed rather than
     * served from an entry the new rows have made wrong. */
    await invalidateDerived(cache);
    const misses = cache.stats().misses;
    await get('/stats/portcalls');
    expect(cache.stats().misses).toBeGreaterThan(misses);
  });

  it('never serves one tenant a cached answer computed for another', async () => {
    /* The whole reason the cache key carries the reader's scope. Two readers ask the same question of the
     * same endpoint; the numbers must still differ, which they cannot if one is served the other's entry. */
    await invalidateDerived(cache);
    const national = await get('/stats/portcalls', 'admin');
    const agent = await get('/stats/portcalls', 'gss');
    expect(national.status).toBe(200); expect(agent.status).toBe(200);
    const totalOf = (r: { body: { data: { cards: { label: string; value: string | number }[] } } }) =>
      String(r.body.data.cards.find((c) => c.label === 'Total port calls')?.value ?? '');
    expect(totalOf(national)).not.toBe(totalOf(agent));
  });

  /*
   * Reporting projects registers that are partitioned, and for a while it did not carry the partition: the
   * search palette, the hover cards and the stat strips all answered nationally to whoever held the module
   * permission. These are the three surfaces that leaked, kept shut.
   */
  describe('tenancy on the read models', () => {
    it('confines the search palette to the caller\'s own records', async () => {
      const mine = (await pool.query("SELECT name FROM rm_vessels WHERE scope_company = 'GSS' ORDER BY name")).rows.map((r) => r.name as string);
      expect(mine.length).toBeGreaterThan(1);
      const term = mine[0].slice(0, 3);
      const asAgent = (await get(`/search?q=${encodeURIComponent(term)}`, 'gss')).body.data.groups;
      const vessels = (asAgent.find((g: { type: string }) => g.type === 'vessel')?.items ?? []) as { label: string }[];
      expect(vessels.length).toBeGreaterThan(0);
      for (const v of vessels) expect(mine, `${v.label} is not this agent's ship`).toContain(v.label);
      // the administration still sees the whole register through the same endpoint
      const national = (await get(`/search?q=${encodeURIComponent(term)}`)).body.data.groups;
      const all = (national.find((g: { type: string }) => g.type === 'vessel')?.items ?? []) as unknown[];
      expect(all.length).toBeGreaterThanOrEqual(vessels.length);
    });

    it('does not publish an unpublished instrument to the industry', async () => {
      const draft = (await pool.query("SELECT ref_no, title FROM rm_legal_instruments WHERE status NOT IN ('IN_FORCE','SUPERSEDED') LIMIT 1")).rows[0];
      if (!draft) return;                                   // a world with nothing in draft has nothing to leak
      const term = String(draft.ref_no).slice(0, 6);
      const agentSaw = (await get(`/search?q=${encodeURIComponent(term)}`, 'gss')).body.data.groups
        .flatMap((g: { items: { label: string }[] }) => g.items).map((i: { label: string }) => i.label);
      expect(agentSaw.join(' ')).not.toContain(draft.ref_no);
      const registrarSaw = (await get(`/search?q=${encodeURIComponent(term)}`, 'registrar')).body.data.groups
        .flatMap((g: { items: { label: string }[] }) => g.items).map((i: { label: string }) => i.label);
      expect(registrarSaw.join(' ')).toContain(draft.ref_no);
    });

    it('answers a hover card only for a record the caller could open', async () => {
      const mine = (await pool.query("SELECT id FROM rm_vessels WHERE scope_company = 'GSS' LIMIT 1")).rows[0];
      const theirs = (await pool.query("SELECT id FROM rm_vessels WHERE scope_company <> 'GSS' AND scope_company <> '' LIMIT 1")).rows[0];
      expect((await get(`/cards/vessel/${mine.id}`, 'gss')).status).toBe(200);
      // out of scope reads as absent, not as forbidden: a hover must not confirm that a record exists
      expect((await get(`/cards/vessel/${theirs.id}`, 'gss')).status).toBe(404);
      expect((await get(`/cards/vessel/${theirs.id}`)).status).toBe(200);
    });

    it('refuses a card type the caller holds no permission for', async () => {
      const incident = (await pool.query('SELECT id FROM rm_incidents LIMIT 1')).rows[0];
      const user = (await pool.query('SELECT id FROM rm_users LIMIT 1')).rows[0];
      expect((await get(`/cards/incident/${incident.id}`, 'gss')).status).toBe(404);
      expect((await get(`/cards/user/${user.id}`, 'gss')).status).toBe(404);
      expect((await get(`/cards/incident/${incident.id}`)).status).toBe(200);
    });

    it('counts only the caller\'s own records in the stat strips and the dashboard', async () => {
      const fleet = Number((await pool.query("SELECT count(*) AS n FROM rm_vessels WHERE scope_company = 'GSS' AND status = 'ACTIVE'")).rows[0].n);
      const agentCards = (await get('/stats/vessels', 'gss')).body.data.cards as { label: string; value: number }[];
      const nationalCards = (await get('/stats/vessels')).body.data.cards as { label: string; value: number }[];
      const active = (cards: { label: string; value: number }[]) => cards.find((c) => c.label === 'Active vessels')!.value;
      expect(active(agentCards)).toBe(fleet);
      expect(active(nationalCards)).toBeGreaterThan(active(agentCards));

      const agentDash = (await get('/dashboard', 'gss')).body.data.kpis;
      const nationalDash = (await get('/dashboard')).body.data.kpis;
      expect(agentDash.vesselsAtBerth).toBeLessThanOrEqual(nationalDash.vesselsAtBerth);
      expect(nationalDash.vesselsAtBerth).toBeGreaterThan(0);
    });
  });

  describe('the crew read model follows the register', () => {
    it('confines a manning agency to the seafarers it placed', async () => {
      const placed = (await pool.query("SELECT name FROM rm_seafarers WHERE scope_company = 'MCA'")).rows.map((r) => r.name as string);
      const others = (await pool.query("SELECT name FROM rm_seafarers WHERE scope_company <> 'MCA'")).rows.map((r) => r.name as string);
      expect(placed.length).toBeGreaterThan(0);
      expect(others.length).toBeGreaterThan(0);

      const term = placed[0].split(' ')[0];
      const groups = (await get(`/search?q=${encodeURIComponent(term)}`, 'mca')).body.data.groups;
      const found = (groups.find((g: { type: string }) => g.type === 'seafarer')?.items ?? []) as { label: string }[];
      for (const s of found) expect(placed, `${s.label} is not an MCA placement`).toContain(s.label);

      const cards = await pool.query("SELECT id FROM rm_seafarers WHERE scope_company <> 'MCA' LIMIT 1");
      expect((await get(`/cards/seafarer/${cards.rows[0].id}`, 'mca')).status).toBe(404);
      const own = await pool.query("SELECT id FROM rm_seafarers WHERE scope_company = 'MCA' LIMIT 1");
      expect((await get(`/cards/seafarer/${own.rows[0].id}`, 'mca')).status).toBe(200);
    });

    it('counts only its own placements in the crew stat strip', async () => {
      const mine = Number((await pool.query("SELECT count(*) AS n FROM rm_seafarers WHERE scope_company = 'MCA'")).rows[0].n);
      const cards = (await get('/stats/seafarers', 'mca')).body.data.cards as { label: string; value: number }[];
      const national = (await get('/stats/seafarers')).body.data.cards as { label: string; value: number }[];
      const roll = (c: { label: string; value: number }[]) => c[0].value;
      expect(roll(cards)).toBe(mine);
      expect(roll(national)).toBeGreaterThan(roll(cards));
    });
  });
});
