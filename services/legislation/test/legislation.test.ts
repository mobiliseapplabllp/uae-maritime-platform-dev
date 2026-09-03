import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { EVENTS, makeEvent, subjectFor } from '@maritime/contracts';
import { AuditClient, PRINCIPAL_RESOLVER, StaticPrincipalResolver, createApp, loadEnv, signHS256, withInbox, withTx, type Principal } from '@maritime/service-kit';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedLegislation, seriesOf } from '../src/seed';
import { applyEvent } from '../src/consumer';
import { canApprove, canSupersede, canTransition, registerDashboard, type DashboardRow } from '../src/instruments';

const DB = 'maritime_legislation_test'; const URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret';
let app: INestApplication; let server: unknown; let pool: Pool; let audit: AuditClient; let env: ReturnType<typeof loadEnv<typeof envSchema>>;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
let admin: string; let clerk: string; let approver: string; let reader: string; let nobody: string; let drafterTok: string;
/** A seeded draft, the person who drafted it, and a member of staff who owes receipts. */
let draft: { id: string; ref_no: string; drafted_by_id: string; drafted_by: string };
let staff: { id: string; name: string; role_name: string };
const g = (p: string, t = admin) => request(server as never).get(p).set('authorization', t);
const post = (p: string, body?: unknown, t = admin) => request(server as never).post(p).set('authorization', t).send((body ?? {}) as never);
const put = (p: string, body: unknown, t = admin) => request(server as never).put(p).set('authorization', t).send(body as never);
const del = (p: string, t = admin) => request(server as never).delete(p).set('authorization', t);
const outbox = async (type: string) => (await pool.query('SELECT payload FROM outbox WHERE subject = $1 ORDER BY id', [subjectFor(type)])).rows.map((r) => r.payload as { type: string; subject?: string; data: Record<string, any> });
const clearOutbox = () => pool.query('DELETE FROM outbox');
const D = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  await seedLegislation(URL, 'AE');
  pool = new Pool({ connectionString: URL });
  draft = (await pool.query(`SELECT id, ref_no, drafted_by_id, drafted_by FROM legal_instruments WHERE status = 'DRAFT' AND drafted_by_id IS NOT NULL ORDER BY issued_date DESC LIMIT 1`)).rows[0];
  staff = (await pool.query(`SELECT id, name, role_name FROM users WHERE active AND id <> $1 ORDER BY name LIMIT 1`, [draft.drafted_by_id])).rows[0];
  env = loadEnv(envSchema, { ...process.env, DATABASE_URL: URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, MDM_URL: 'http://127.0.0.1:1' } as never);
  const base = { scope: { level: 'NATIONAL' }, kind: 'user' as const, active: true, email: 'x@maritime.example' };
  const people: Record<string, Principal> = {
    admin: { ...base, id: 'admin', sub: 'admin', name: 'Admin', perms: ['*'] },
    clerk: { ...base, id: 'clerk', sub: 'clerk', name: 'Legal Clerk', roleName: 'Legal Officer', perms: ['legislation.view', 'legislation.manage'] },
    approver: { ...base, id: 'approver', sub: 'approver', name: 'Approving Officer', roleName: 'Approver', perms: ['legislation.view', 'legislation.approve'] },
    nobody: { ...base, id: 'nobody', sub: 'nobody', name: 'Nobody', perms: ['reports.view'] },
    [staff.id]: { ...base, id: staff.id, sub: staff.id, name: staff.name, roleName: staff.role_name, perms: ['legislation.view'] },
    [draft.drafted_by_id]: { ...base, id: draft.drafted_by_id, sub: draft.drafted_by_id, name: draft.drafted_by, roleName: 'Legal Officer', perms: ['legislation.view', 'legislation.manage', 'legislation.approve'] },
  };
  admin = tok('admin'); clerk = tok('clerk'); approver = tok('approver'); nobody = tok('nobody'); reader = tok(staff.id); drafterTok = tok(draft.drafted_by_id);
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: new StaticPrincipalResolver(people) }) });
  await app.init(); server = app.getHttpServer(); audit = app.get(AuditClient);
});
afterAll(async () => { await pool?.end(); await app?.close(); });

/** A fresh draft owned by the clerk, so a lifecycle test never disturbs a seeded chain. */
async function newDraft(over: Record<string, unknown> = {}, t = clerk) {
  const r = await post('/legislation/instruments', {
    title: 'Draft circular for test purposes', type: 'CIRCULAR', category: 'Port operations', issuedBy: 'Harbour Master',
    summary: 'A circular created by the test suite.', tags: ['test'], ...over,
  }, t);
  expect(r.status).toBe(201);
  return r.body.data;
}

describe('legislation — the governance rules, tested without a database', () => {
  it('runs the lifecycle one way only', () => {
    expect(canTransition('DRAFT', 'IN_FORCE')).toEqual({ ok: true });
    expect(canTransition('IN_FORCE', 'SUPERSEDED')).toEqual({ ok: true });
    expect(canTransition('IN_FORCE', 'DRAFT')).toMatchObject({ ok: false });
    expect(canTransition('SUPERSEDED', 'IN_FORCE').ok).toBe(false);
    expect(canTransition('WITHDRAWN', 'IN_FORCE')).toMatchObject({ ok: false, error: expect.stringContaining('final') });
    expect(canTransition('IN_FORCE', 'IN_FORCE')).toMatchObject({ ok: false, error: expect.stringContaining('already') });
    expect(canTransition('NOWHERE', 'IN_FORCE').ok).toBe(false);
  });
  it('keeps the drafter and the approver apart', () => {
    expect(canApprove({ status: 'DRAFT', drafted_by_id: 'u1' }, 'u2')).toEqual({ ok: true });
    expect(canApprove({ status: 'DRAFT', drafted_by_id: 'u1' }, 'u1')).toMatchObject({ ok: false, error: expect.stringContaining('drafted it') });
    expect(canApprove({ status: 'DRAFT', drafted_by_id: null }, 'u2')).toMatchObject({ ok: false, error: expect.stringContaining('no drafter') });
    expect(canApprove({ status: 'IN_FORCE', drafted_by_id: 'u1' }, 'u2').ok).toBe(false);
  });
  it('refuses a supersession that would replace an instrument with itself or with a dead one', () => {
    const target = { id: 'a', status: 'IN_FORCE' };
    expect(canSupersede(target, { id: 'b', status: 'IN_FORCE', ref_no: 'B' })).toEqual({ ok: true });
    expect(canSupersede(target, { id: 'a', status: 'IN_FORCE', ref_no: 'A' })).toMatchObject({ ok: false, error: expect.stringContaining('itself') });
    expect(canSupersede(target, { id: 'b', status: 'WITHDRAWN', ref_no: 'B' })).toMatchObject({ ok: false, error: expect.stringContaining('withdrawn') });
    expect(canSupersede({ id: 'a', status: 'DRAFT' }, { id: 'b', status: 'IN_FORCE', ref_no: 'B' }).ok).toBe(false);
  });
  it('reads a reference number back to the series that allocated it', () => {
    expect(seriesOf('CIRC-14/2026')).toEqual({ series: 'CIRC-2026', value: 14 });
    expect(seriesOf('MSA-CIRC-HS-26/2026')).toEqual({ series: 'MSA-CIRC-HS-2026', value: 26 });
    expect(seriesOf('SOLAS-74')).toBeNull();
    expect(seriesOf('MARPOL-73/78')).toBeNull();
  });
  it('summarises the register, the drafting queue and what is still owed', () => {
    const now = new Date('2026-06-15T00:00:00Z');
    const row = (over: Partial<DashboardRow>): DashboardRow => ({
      id: 'i', ref_no: 'R', title: 'T', type: 'CIRCULAR', category: 'Safety', status: 'IN_FORCE', issued_date: new Date('2026-01-05T00:00:00Z'),
      effective_date: null, expiry_date: null, ack_required: false, acks: 0, recipients: 0, reviewed_at: null, cleared_at: null, drafted_by: 'A Drafter', ...over,
    });
    const d = registerDashboard([
      row({}),
      row({ ack_required: true, acks: 6, recipients: 10 }),
      row({ status: 'DRAFT', reviewed_at: new Date(), cleared_at: new Date() }),
      row({ status: 'DRAFT' }),
      row({ status: 'SUPERSEDED', type: 'ORDER' }),
      row({ status: 'WITHDRAWN', type: 'NOTICE' }),
      row({ expiry_date: new Date(now.getTime() + 10 * D) }),
      row({ effective_date: new Date(now.getTime() + 10 * D) }),
    ], now, 60);
    expect(d.kpis).toMatchObject({ total: 8, inForce: 4, drafts: 2, superseded: 1, withdrawn: 1, ackRequired: 1, ackOutstanding: 4, ackCompliancePct: 60, awaitingApproval: 1, awaitingReview: 1, lapsingSoon: 1, comingIntoForce: 1 });
    expect(d.byType.find((t) => t.type === 'CIRCULAR')).toMatchObject({ total: 6, drafts: 2 });
    expect(d.outstanding[0]).toMatchObject({ recipients: 10, acknowledgements: 6, outstanding: 4 });
    expect(d.byYear.at(-1)).toMatchObject({ year: 2026 });
  });
});

describe('legislation — the register', () => {
  it('pages, filters, searches and sorts the library', async () => {
    const first = await g('/legislation/instruments?limit=5');
    expect(first.status).toBe(200);
    expect(first.body.data).toHaveLength(5);
    expect(first.body.meta.total).toBeGreaterThan(40);
    const second = await g('/legislation/instruments?limit=5&page=2');
    expect(second.body.data[0].id).not.toBe(first.body.data[0].id);
    const circulars = await g('/legislation/instruments?type=CIRCULAR&limit=500');
    expect(circulars.body.data.every((r: any) => r.type === 'CIRCULAR')).toBe(true);
    expect(circulars.body.meta.total).toBeLessThan(first.body.meta.total);
    const inForce = await g('/legislation/instruments?status=IN_FORCE&limit=500');
    expect(inForce.body.data.every((r: any) => r.status === 'IN_FORCE')).toBe(true);
    const conventions = await g('/legislation/instruments?type=CONVENTION&limit=100');
    const year = conventions.body.data[0].year;
    const byYear = await g(`/legislation/instruments?year=${year}&limit=100`);
    expect(byYear.body.data.every((r: any) => r.year === year)).toBe(true);
    const subject = await g('/legislation/instruments?subject=Environment&limit=100');
    expect(subject.body.data.length).toBeGreaterThan(0);
    expect(subject.body.data.every((r: any) => r.category === 'Environment')).toBe(true);
    const sorted = await g('/legislation/instruments?sort=refNo&limit=6');
    expect(sorted.body.data.map((r: any) => r.refNo)).toEqual([...sorted.body.data.map((r: any) => r.refNo)].sort());
    const mandatory = await g('/legislation/instruments?ackRequired=true&limit=200');
    expect(mandatory.body.data.every((r: any) => r.ackRequired)).toBe(true);
  });
  it('searches reference, title, summary, subject and keywords', async () => {
    const one = (await g('/legislation/instruments?limit=1&sort=refNo')).body.data[0];
    expect((await g(`/legislation/instruments?q=${encodeURIComponent(one.refNo)}`)).body.data.map((r: any) => r.refNo)).toContain(one.refNo);
    const tagged = await g('/legislation/instruments?q=ballast&limit=50');
    expect(tagged.body.data.length).toBeGreaterThan(0);
    const byTag = await g('/legislation/instruments?tag=imo&limit=200');
    expect(byTag.body.data.length).toBeGreaterThan(0);
    expect(byTag.body.data.every((r: any) => r.tags.includes('imo'))).toBe(true);
  });
  it('returns the full record with its governance chain, its receipts and both sides of its supersession', async () => {
    const superseded = (await pool.query(`SELECT id FROM legal_instruments WHERE status = 'SUPERSEDED' AND superseded_by <> '' LIMIT 1`)).rows[0];
    const r = await g(`/legislation/instruments/${superseded.id}`);
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ status: 'SUPERSEDED' });
    expect(r.body.data.supersededBy).toBeTruthy();
    expect(r.body.data.links.some((l: any) => l.kind === 'SUPERSEDED_BY' && l.direction === 'INCOMING')).toBe(true);
    const successor = await g(`/legislation/instruments/${r.body.data.links.find((l: any) => l.kind === 'SUPERSEDED_BY').instrumentId}`);
    expect(successor.body.data.supersedes).toBe(r.body.data.refNo);
    expect(successor.body.data.links.some((l: any) => l.kind === 'SUPERSEDES' && l.direction === 'OUTGOING')).toBe(true);
    const byRef = await g(`/legislation/instruments/${encodeURIComponent(r.body.data.refNo)}`);
    expect(byRef.body.data.id).toBe(superseded.id);
    expect((await g('/legislation/instruments/00000000-0000-0000-0000-000000000000')).status).toBe(404);
  });
  it('reports the subjects, keywords, issuers and years the search filters offer', async () => {
    const r = await g('/legislation/meta');
    expect(r.status).toBe(200);
    expect(r.body.data.types).toContain('CIRCULAR');
    expect(r.body.data.transitions.IN_FORCE).toEqual(['SUPERSEDED', 'WITHDRAWN']);
    expect(r.body.data.subjects.length).toBeGreaterThan(3);
    expect(r.body.data.keywords.some((k: any) => k.tag === 'imo')).toBe(true);
    expect(r.body.data.years[0].year).toBeGreaterThan(2020);
  });
  it('serves the register dashboard', async () => {
    const r = await g('/legislation/dashboard');
    expect(r.status).toBe(200);
    const d = r.body.data;
    expect(d.kpis.total).toBeGreaterThan(40);
    expect(d.kpis.inForce + d.kpis.drafts + d.kpis.superseded + d.kpis.withdrawn).toBe(d.kpis.total);
    expect(d.kpis.ackRequired).toBeGreaterThan(0);
    expect(d.roll).toBeGreaterThan(5);
    expect(d.byType.length).toBeGreaterThan(2);
    expect(d.byYear.length).toBeGreaterThan(1);
    expect(d.recent.length).toBeGreaterThan(0);
  });
});

describe('legislation — drafting and editing', () => {
  it('records the drafter, allocates a reference and refuses a duplicate one', async () => {
    await clearOutbox();
    const created = await newDraft();
    expect(created).toMatchObject({ status: 'DRAFT', draftedById: 'clerk', draftedBy: 'Legal Clerk' });
    expect(created.refNo).toMatch(/^CIRC-\d+\/\d{4}$/);
    expect(created.governance.stage).toBe('REVIEWED');
    const dupe = await post('/legislation/instruments', { refNo: created.refNo, title: 'Another circular entirely', type: 'CIRCULAR' }, clerk);
    expect(dupe.status).toBe(409);
    const events = await outbox(EVENTS.legislation.instrumentDrafted);
    expect(events.at(-1)?.data.refNo).toBe(created.refNo);
    const rm = await outbox(EVENTS.readModel.upserted);
    expect(rm.at(-1)?.data).toMatchObject({ kind: 'legalInstrument' });
    expect(rm.at(-1)?.data.entity).toMatchObject({ refNo: created.refNo, ackRequired: false, acknowledgedBy: [] });
    expect(Object.keys(rm.at(-1)!.data.entity).sort()).toEqual(['ackRequired', 'acknowledgedBy', 'id', 'issuedDate', 'refNo', 'status', 'title', 'type']);
  });
  it('allocates each type its own series, and never reuses a seeded number', async () => {
    const a = await newDraft({ type: 'ORDER', title: 'Test order one' });
    const b = await newDraft({ type: 'ORDER', title: 'Test order two' });
    expect(a.refNo).toMatch(/^ORD-/); expect(b.refNo).toMatch(/^ORD-/);
    expect(seriesOf(b.refNo)!.value).toBe(seriesOf(a.refNo)!.value + 1);
    const clash = await pool.query('SELECT count(*) AS n FROM legal_instruments WHERE ref_no = $1', [a.refNo]);
    expect(Number(clash.rows[0].n)).toBe(1);
  });
  it('edits the text, the classification and the dates, and refuses to move status by editing', async () => {
    const d = await newDraft({ title: 'Draft to be edited' });
    const edited = await put(`/legislation/instruments/${d.id}`, { title: 'Draft after editing', category: 'Safety', tags: ['edited', 'safety'], effectiveDate: iso(Date.now() + 30 * D), expiryDate: iso(Date.now() + 400 * D) }, clerk);
    expect(edited.status).toBe(200);
    expect(edited.body.data).toMatchObject({ title: 'Draft after editing', category: 'Safety', tags: ['edited', 'safety'] });
    expect(edited.body.data.expiryDate).toBeTruthy();
    const forced = await put(`/legislation/instruments/${d.id}`, { status: 'IN_FORCE' }, clerk);
    expect(forced.status).toBe(409);
    expect(forced.body.message).toMatch(/approval/i);
    const superseded = await put(`/legislation/instruments/${d.id}`, { status: 'SUPERSEDED' }, clerk);
    expect(superseded.status).toBe(409);
    const noReason = await put(`/legislation/instruments/${d.id}`, { status: 'WITHDRAWN' }, clerk);
    expect(noReason.status).toBe(400);
    const withdrawn = await put(`/legislation/instruments/${d.id}`, { status: 'WITHDRAWN', withdrawalReason: 'Superseded by policy before publication' }, clerk);
    expect(withdrawn.body.data).toMatchObject({ status: 'WITHDRAWN', withdrawalReason: 'Superseded by policy before publication' });
    const again = await put(`/legislation/instruments/${d.id}`, { title: 'Cannot touch this' }, clerk);
    expect(again.status).toBe(409);
    expect(again.body.message).toMatch(/closed record/i);
  });
  it('deletes a draft and refuses to delete anything that has been in force', async () => {
    const d = await newDraft({ title: 'Draft to be deleted' });
    await clearOutbox();
    expect((await del(`/legislation/instruments/${d.id}`, clerk)).status).toBe(200);
    expect((await g(`/legislation/instruments/${d.id}`)).status).toBe(404);
    const deleted = await outbox(EVENTS.readModel.deleted);
    expect(deleted.at(-1)?.data).toMatchObject({ kind: 'legalInstrument', id: d.id });
    const live = (await pool.query(`SELECT id FROM legal_instruments WHERE status = 'IN_FORCE' LIMIT 1`)).rows[0];
    const refused = await del(`/legislation/instruments/${live.id}`, clerk);
    expect(refused.status).toBe(409);
    expect(refused.body.message).toMatch(/withdraw it instead/i);
  });
});

describe('legislation — the approval chain', () => {
  it('reviews, clears and puts a draft in force, and keeps the drafter out of the approval', async () => {
    const d = await newDraft({ title: 'Draft on the governance path' });
    const selfApproval = await post(`/legislation/instruments/${d.id}/publish`, {}, clerk);
    expect(selfApproval.status).toBe(403);
    const clearanceFirst = await post(`/legislation/instruments/${d.id}/clearance`, { note: 'Cleared' }, approver);
    expect(clearanceFirst.status).toBe(409);
    expect(clearanceFirst.body.message).toMatch(/follows review/i);
    const reviewed = await post(`/legislation/instruments/${d.id}/review`, { note: 'Read against the register' }, clerk);
    expect(reviewed.body.data).toMatchObject({ reviewedBy: 'Legal Clerk', reviewNote: 'Read against the register' });
    expect(reviewed.body.data.governance.stage).toBe('CLEARED');
    const cleared = await post(`/legislation/instruments/${d.id}/clearance`, { note: 'No legal impediment' }, approver);
    expect(cleared.body.data).toMatchObject({ clearedBy: 'Approving Officer' });
    expect(cleared.body.data.governance.stage).toBe('IN_FORCE');
    await clearOutbox();
    const published = await post(`/legislation/instruments/${d.id}/publish`, { effectiveDate: iso(Date.now() + 7 * D) }, approver);
    expect(published.status).toBe(201);
    expect(published.body.data).toMatchObject({ status: 'IN_FORCE', approvedBy: 'Approving Officer' });
    expect(published.body.data.effectiveDate).toBeTruthy();
    expect(published.body.data.governance).toMatchObject({ stage: 'COMPLETE', reviewed: true, cleared: true, approved: true });
    const events = await outbox(EVENTS.legislation.instrumentPublished);
    expect(events.at(-1)?.data).toMatchObject({ refNo: d.refNo, approvedBy: 'Approving Officer', draftedBy: 'Legal Clerk' });
    const rm = await outbox(EVENTS.readModel.upserted);
    expect(rm.at(-1)?.data.entity).toMatchObject({ status: 'IN_FORCE' });
    expect((await post(`/legislation/instruments/${d.id}/publish`, {}, approver)).status).toBe(409);
    expect((await post(`/legislation/instruments/${d.id}/review`, {}, clerk)).status).toBe(409);
  });
  it('refuses approval when the register does not know who drafted the instrument', async () => {
    const d = await newDraft({ title: 'Draft with no drafter on record' });
    await pool.query('UPDATE legal_instruments SET drafted_by_id = NULL WHERE id = $1', [d.id]);
    const r = await post(`/legislation/instruments/${d.id}/publish`, {}, approver);
    expect(r.status).toBe(409);
    expect(r.body.message).toMatch(/no drafter/i);
  });
  it('supersedes one instrument with another and keeps both sides of the link', async () => {
    const older = await newDraft({ title: 'The instrument being replaced' });
    await post(`/legislation/instruments/${older.id}/publish`, {}, approver);
    const newer = await newDraft({ title: 'The instrument that replaces it' });
    await post(`/legislation/instruments/${newer.id}/publish`, {}, approver);
    expect((await post(`/legislation/instruments/${older.id}/supersede`, { successorId: older.id }, approver)).body.message).toMatch(/itself/i);
    await clearOutbox();
    const done = await post(`/legislation/instruments/${older.id}/supersede`, { successorRef: newer.refNo, note: 'Reissued for 2026' }, approver);
    expect(done.status).toBe(201);
    expect(done.body.data).toMatchObject({ status: 'SUPERSEDED', supersededBy: newer.refNo });
    const successor = await g(`/legislation/instruments/${newer.id}`);
    expect(successor.body.data.supersedes).toBe(older.refNo);
    expect(successor.body.data.links.find((l: any) => l.kind === 'SUPERSEDES')).toMatchObject({ refNo: older.refNo, direction: 'OUTGOING' });
    const replaced = await g(`/legislation/instruments/${older.id}`);
    expect(replaced.body.data.links.find((l: any) => l.kind === 'SUPERSEDED_BY')).toMatchObject({ refNo: newer.refNo, direction: 'INCOMING' });
    const events = await outbox(EVENTS.legislation.instrumentSuperseded);
    expect(events.at(-1)?.data).toMatchObject({ refNo: older.refNo, supersededBy: newer.refNo });
    expect((await outbox(EVENTS.readModel.upserted)).filter((e) => e.data.entity.id === newer.id).length).toBeGreaterThan(0);
    expect((await post(`/legislation/instruments/${older.id}/supersede`, { successorRef: newer.refNo }, approver)).status).toBe(409);
  });
  it('withdraws an instrument with a reason, and never revives a closed one', async () => {
    const d = await newDraft({ title: 'The instrument to be withdrawn' });
    await post(`/legislation/instruments/${d.id}/publish`, {}, approver);
    expect((await post(`/legislation/instruments/${d.id}/withdraw`, { reason: 'no' }, approver)).status).toBe(400);
    expect((await post(`/legislation/instruments/${d.id}/withdraw`, { reason: 'Replaced by the revised circular' }, approver)).status).toBe(201);
    const fresh = await newDraft({ title: 'Second instrument to be withdrawn' });
    await post(`/legislation/instruments/${fresh.id}/publish`, {}, approver);
    await clearOutbox();
    const r = await post(`/legislation/instruments/${fresh.id}/withdraw`, { reason: 'Overtaken by the revised port rules' }, approver);
    expect(r.body.data).toMatchObject({ status: 'WITHDRAWN', withdrawalReason: 'Overtaken by the revised port rules', withdrawnBy: 'Approving Officer' });
    expect((await outbox(EVENTS.legislation.instrumentWithdrawn)).at(-1)?.data).toMatchObject({ refNo: fresh.refNo, reason: 'Overtaken by the revised port rules' });
    expect((await post(`/legislation/instruments/${fresh.id}/withdraw`, { reason: 'Again for good measure' }, approver)).status).toBe(409);
    expect((await post(`/legislation/instruments/${fresh.id}/supersede`, { successorRef: d.refNo }, approver)).status).toBe(409);
    const short = await post(`/legislation/instruments/${d.id}/withdraw`, { reason: '' }, approver);
    expect(short.status).toBe(400);
  });
});

describe('legislation — the acknowledgement roll', () => {
  it('tracks who has acknowledged, what is outstanding, and refuses a receipt on anything not in force', async () => {
    const d = await newDraft({ title: 'A mandatory circular', ackRequired: true });
    const early = await post(`/notices/${d.id}/acknowledge`, {}, reader);
    expect(early.status).toBe(400);
    expect(early.body.message).toMatch(/in force/i);
    await post(`/legislation/instruments/${d.id}/publish`, {}, approver);
    const before = await g(`/legislation/instruments/${d.id}/acknowledgements`);
    expect(before.body.data.recipients).toBeGreaterThan(5);
    expect(before.body.data.acknowledged).toBe(0);
    expect(before.body.data.outstandingCount).toBe(before.body.data.recipients);
    expect(before.body.data.outstanding.some((p: any) => p.id === staff.id)).toBe(true);
    expect(before.body.data.dueBy).toBeTruthy();
    await clearOutbox();
    const acked = await post(`/notices/${d.id}/acknowledge`, { note: 'Read and understood' }, reader);
    expect(acked.status).toBe(201);
    expect(acked.body.data.acknowledgedBy.some((a: any) => a.userId === staff.id)).toBe(true);
    expect(acked.body.data.outstanding).toBe(before.body.data.recipients - 1);
    const events = await outbox(EVENTS.legislation.acknowledgementRecorded);
    expect(events.at(-1)?.data).toMatchObject({ userId: staff.id, acknowledgements: 1 });
    expect((await outbox(EVENTS.readModel.upserted)).at(-1)?.data.entity.acknowledgedBy[0]).toMatchObject({ userId: staff.id });
    await clearOutbox();
    const twice = await post(`/notices/${d.id}/acknowledge`, {}, reader);
    expect(twice.status).toBe(201);
    expect(twice.body.data.acknowledgedBy).toHaveLength(1);
    expect(await outbox(EVENTS.legislation.acknowledgementRecorded)).toHaveLength(0);
    const after = await g(`/legislation/instruments/${d.id}/acknowledgements`);
    expect(after.body.data.acknowledged).toBe(1);
    expect(after.body.data.outstanding.some((p: any) => p.id === staff.id)).toBe(false);
    expect(after.body.data.compliancePct).toBeGreaterThan(0);
  });
  it('serves each person only the notices addressed to them, and drops them off the list once acknowledged', async () => {
    const mine = await newDraft({ title: 'A circular for everybody', ackRequired: true });
    await post(`/legislation/instruments/${mine.id}/publish`, {}, approver);
    const theirs = await newDraft({ title: 'A circular for the security desk only', ackRequired: true, ackClass: 'ROLE', ackClassValue: 'Security Officer' });
    await post(`/legislation/instruments/${theirs.id}/publish`, {}, approver);
    const pending = await g('/notices/pending', reader);
    expect(pending.status).toBe(200);
    const ids = pending.body.data.map((p: any) => p.id);
    expect(ids).toContain(mine.id);
    expect(staff.role_name === 'Security Officer' ? true : !ids.includes(theirs.id)).toBe(true);
    expect(pending.body.data[0]).toHaveProperty('dueBy');
    expect(pending.body.data.every((p: any) => p.refNo && p.title)).toBe(true);
    await post(`/notices/${mine.id}/acknowledge`, {}, reader);
    expect((await g('/notices/pending', reader)).body.data.map((p: any) => p.id)).not.toContain(mine.id);
  });
  it('serves the notice board — what is in force and addressed to the desk', async () => {
    const r = await g('/notices?limit=10');
    expect(r.status).toBe(200);
    expect(r.body.data.every((x: any) => x.status === 'IN_FORCE' && ['CIRCULAR', 'NOTICE', 'ORDER'].includes(x.type))).toBe(true);
    expect(r.body.meta.total).toBeGreaterThan(5);
    const onlyNotices = await g('/notices?type=NOTICE&limit=50');
    expect(onlyNotices.body.data.every((x: any) => x.type === 'NOTICE')).toBe(true);
  });
});

describe('legislation — amendments, references and attachments', () => {
  it('links two instruments and reads the link back from both ends', async () => {
    const parent = await newDraft({ title: 'The rules being amended', type: 'RULES' });
    await post(`/legislation/instruments/${parent.id}/publish`, {}, approver);
    const amendment = await newDraft({ title: 'The amending order', type: 'ORDER' });
    await clearOutbox();
    const linked = await post(`/legislation/instruments/${amendment.id}/links`, { kind: 'AMENDS', targetRef: parent.refNo, note: 'Amends rule 4' }, clerk);
    expect(linked.status).toBe(201);
    expect(linked.body.data.links.find((l: any) => l.kind === 'AMENDS')).toMatchObject({ refNo: parent.refNo, direction: 'OUTGOING' });
    const other = await g(`/legislation/instruments/${parent.id}`);
    expect(other.body.data.links.find((l: any) => l.kind === 'AMENDED_BY')).toMatchObject({ refNo: amendment.refNo, direction: 'INCOMING' });
    expect((await outbox(EVENTS.legislation.instrumentLinked)).at(-1)?.data).toMatchObject({ kind: 'AMENDS', targetRef: parent.refNo });
    expect((await post(`/legislation/instruments/${amendment.id}/links`, { kind: 'REFERS_TO', targetId: amendment.id }, clerk)).status).toBe(400);
    expect((await post(`/legislation/instruments/${amendment.id}/links`, { kind: 'REFERS_TO', targetRef: 'NOT-A-REF/2026' }, clerk)).status).toBe(404);
    const linkId = linked.body.data.links.find((l: any) => l.kind === 'AMENDS').id;
    const removed = await del(`/legislation/instruments/${amendment.id}/links/${linkId}`, clerk);
    expect(removed.body.data.links).toHaveLength(0);
  });
  it('carries attachments on the instrument and takes them off again', async () => {
    const d = await newDraft({ title: 'A circular with a chart extract' });
    const attached = await post(`/legislation/instruments/${d.id}/attachments`, { name: 'Chart extract.pdf', kind: 'CHART', documentId: 'doc-1', sizeBytes: 2048 }, clerk);
    expect(attached.status).toBe(201);
    expect(attached.body.data.attachments).toHaveLength(1);
    expect(attached.body.data.attachments[0]).toMatchObject({ name: 'Chart extract.pdf', kind: 'CHART', documentId: 'doc-1' });
    const id = attached.body.data.attachments[0].id;
    expect((await del(`/legislation/instruments/${d.id}/attachments/nope`, clerk)).status).toBe(404);
    const detached = await del(`/legislation/instruments/${d.id}/attachments/${id}`, clerk);
    expect(detached.body.data.attachments).toHaveLength(0);
  });
});

describe('legislation — the staff roll it consumes', () => {
  const deps = () => ({ env, audit });
  const userEvent = (over: Record<string, unknown> = {}) => makeEvent({
    type: EVENTS.readModel.upserted, source: 'identity-access',
    data: { kind: 'user', entity: { id: 'consumer-user', name: 'A New Officer', email: 'new@maritime.example', roleName: 'Security Officer', department: 'Security', active: true, ...over } },
  });
  it('projects the roll, republishes the instruments the change affects, and ignores what it does not own', async () => {
    const mandatory = await newDraft({ title: 'A security circular for the roll test', ackRequired: true, ackClass: 'ROLE', ackClassValue: 'Security Officer', category: 'Security' });
    await post(`/legislation/instruments/${mandatory.id}/publish`, {}, approver);
    await clearOutbox();
    const event = userEvent();
    await withTx(pool, (c) => applyEvent(c, deps(), event));
    const roll = await pool.query('SELECT * FROM users WHERE id = $1', ['consumer-user']);
    expect(roll.rows[0]).toMatchObject({ name: 'A New Officer', role_name: 'Security Officer', active: true });
    const republished = (await outbox(EVENTS.readModel.upserted)).filter((e) => e.data.entity.id === mandatory.id);
    expect(republished.length).toBeGreaterThan(0);
    expect((await g(`/legislation/instruments/${mandatory.id}/acknowledgements`)).body.data.outstanding.some((p: any) => p.id === 'consumer-user')).toBe(true);
    await clearOutbox();
    await withTx(pool, (c) => applyEvent(c, deps(), makeEvent({ type: EVENTS.readModel.upserted, source: 'ports', data: { kind: 'berth', entity: { id: 'b1', code: 'CT1-1' } } })));
    expect(await outbox(EVENTS.readModel.upserted)).toHaveLength(0);
  });
  it('deactivates a leaver and takes them off the outstanding list', async () => {
    await withTx(pool, (c) => applyEvent(c, deps(), makeEvent({ type: EVENTS.readModel.deleted, source: 'identity-access', data: { kind: 'user', id: 'consumer-user' } })));
    const roll = await pool.query('SELECT active FROM users WHERE id = $1', ['consumer-user']);
    expect(roll.rows[0].active).toBe(false);
    const mandatory = (await pool.query(`SELECT id FROM legal_instruments WHERE ack_required AND ack_class = 'ROLE' AND status = 'IN_FORCE' LIMIT 1`)).rows[0];
    expect((await g(`/legislation/instruments/${mandatory.id}/acknowledgements`)).body.data.outstanding.some((p: any) => p.id === 'consumer-user')).toBe(false);
  });
  it('applies a redelivered event exactly once', async () => {
    const event = userEvent({ name: 'Redelivered Officer' });
    expect(await withInbox(pool, event, (c) => applyEvent(c, deps(), event))).toBe(true);
    expect(await withInbox(pool, event, (c) => applyEvent(c, deps(), event))).toBe(false);
    expect((await pool.query('SELECT name FROM users WHERE id = $1', ['consumer-user'])).rows[0].name).toBe('Redelivered Officer');
  });
});

describe('legislation — who may do what', () => {
  it('refuses an unauthenticated caller and a caller without the permission', async () => {
    expect((await request(server as never).get('/legislation/instruments')).status).toBe(401);
    expect((await request(server as never).get('/legislation/instruments').set('authorization', 'Bearer nonsense')).status).toBe(401);
    expect((await g('/legislation/instruments', nobody)).status).toBe(403);
    expect((await post('/legislation/instruments', { title: 'Not allowed at all', type: 'NOTICE' }, tok(staff.id))).status).toBe(403);
    expect((await post(`/legislation/instruments/${draft.id}/publish`, {}, clerk)).status).toBe(403);
    expect((await post(`/legislation/instruments/${draft.id}/withdraw`, { reason: 'Not allowed' }, clerk)).status).toBe(403);
    expect((await del(`/legislation/instruments/${draft.id}`, tok(staff.id))).status).toBe(403);
  });
  it('lets the officer who drafted a seeded instrument review it, but not put it in force', async () => {
    const reviewed = await post(`/legislation/instruments/${draft.id}/review`, { note: 'Checked' }, drafterTok);
    expect(reviewed.status).toBe(201);
    const published = await post(`/legislation/instruments/${draft.id}/publish`, {}, drafterTok);
    expect(published.status).toBe(409);
    expect(published.body.message).toMatch(/drafted it/i);
  });
  it('writes an audit entry for every mutation', async () => {
    await clearOutbox();
    const d = await newDraft({ title: 'A circular that must leave a trail' });
    await post(`/legislation/instruments/${d.id}/review`, { note: 'Checked' }, clerk);
    await post(`/legislation/instruments/${d.id}/publish`, {}, approver);
    await post(`/legislation/instruments/${d.id}/withdraw`, { reason: 'Test complete' }, approver);
    const entries = (await outbox(EVENTS.audit.recorded)).map((e) => e.data.action);
    expect(entries).toEqual(expect.arrayContaining(['CREATE', 'REVIEW', 'APPROVE', 'WITHDRAW']));
    expect((await outbox(EVENTS.audit.recorded)).every((e) => e.data.entity === 'LegalInstrument' && e.data.entityLabel)).toBe(true);
  });
});
