import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Pool } from 'pg';
import { createApp, loadEnv, signHS256, StaticPrincipalResolver, PRINCIPAL_RESOLVER, KIT_BUS, KIT_RELAY, MemoryBus, OutboxRelay } from '@maritime/service-kit';
import { EVENTS, makeEvent, subjectFor } from '@maritime/contracts';
import { envSchema } from '../src/env';
import { buildAppModule } from '../src/app.module';
import { seedDocuments, minimalPdf } from '../src/seed';
import { LocalStorage } from '../src/storage';
import { fileSignature } from '../src/signing';
import { startFakeClamAv } from './scanner.test';

const DB = 'maritime_documents_test'; const DB_URL = `postgres://maritime:maritime@127.0.0.1:5432/${DB}`; const SECRET = 'test-secret-test-secret'; const URL_SECRET = 'signed-url-test-secret';
let app: INestApplication; let server: unknown; let bus: MemoryBus; let relay: OutboxRelay; let pool: Pool; let clam: Awaited<ReturnType<typeof startFakeClamAv>>; let storageDir: string; let storage: LocalStorage;
const tok = (sub: string) => `Bearer ${signHS256({ sub, typ: 'access' }, SECRET, { expiresInSec: 600, issuer: 'maritime-platform' })}`;
const admin = tok('admin'); const officer = tok('officer'); const viewer = tok('viewer'); const compliance = tok('compliance');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const pdf = minimalPdf('Survey report (sample)');
const binary = (res: request.Response, cb: (err: Error | null, body: Buffer) => void) => { const chunks: Buffer[] = []; res.on('data', (c: Buffer) => chunks.push(c)); res.on('end', () => cb(null, Buffer.concat(chunks))); };
const srv = () => request(server as never);
const upload = (t: string, fields: Record<string, string>, file: { name: string; type: string; body: Buffer }, path = '/documents') => {
  let r = srv().post(path).set('authorization', t);
  for (const [k, v] of Object.entries(fields)) r = r.field(k, v);
  return r.attach('file', file.body, { filename: file.name, contentType: file.type });
};
/** Drains the outbox (the relay publishes at most 100 rows per tick and also ticks on its own timer) and returns everything published so far. */
const published = async () => {
  for (let i = 0; i < 100; i++) {
    const n = await relay.tick();
    const pending = await pool.query<{ n: string }>('SELECT count(*) AS n FROM outbox WHERE published_at IS NULL');
    if (Number(pending.rows[0].n) === 0) break;
    if (n === 0) await new Promise((r) => setTimeout(r, 25));
  }
  return bus.published;
};

beforeAll(async () => {
  const a = new Pool({ connectionString: 'postgres://maritime:maritime@127.0.0.1:5432/postgres' });
  await a.query(`DROP DATABASE IF EXISTS ${DB}`); await a.query(`CREATE DATABASE ${DB}`); await a.end();
  storageDir = mkdtempSync(join(tmpdir(), 'maritime-documents-')); storage = new LocalStorage(storageDir);
  await seedDocuments(DB_URL, 'AE', storage);
  clam = await startFakeClamAv();
  const env = loadEnv(envSchema, { ...process.env, DATABASE_URL: DB_URL, PORT: '0', AUTH_MODE: 'local', EVENT_BUS: 'memory', LOG_LEVEL: 'silent', JWT_SECRET: SECRET, STORAGE_DRIVER: 'local', STORAGE_DIR: storageDir,
    SCANNER_DRIVER: 'clamav', CLAMAV_HOST: '127.0.0.1', CLAMAV_PORT: String(clam.port), MAX_UPLOAD_MB: '1', DOCUMENT_URL_SECRET: URL_SECRET, FILES_BASE_URL: 'http://127.0.0.1:5410/files', PURGE_DELETED_AFTER_DAYS: '30' } as never);
  const resolver = new StaticPrincipalResolver({
    admin: { id: 'admin', sub: 'admin', name: 'Admin', email: 'admin@maritime.example', perms: ['*'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
    officer: { id: 'officer', sub: 'officer', name: 'Duty Officer', email: 'officer@maritime.example', perms: ['incidents.view', 'incidents.manage', 'certificates.view'], scope: { level: 'PORT' }, kind: 'user', active: true },
    viewer: { id: 'viewer', sub: 'viewer', name: 'Viewer', email: 'viewer@maritime.example', perms: ['dashboard.view'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
    compliance: { id: 'compliance', sub: 'compliance', name: 'Compliance', email: 'compliance@maritime.example', perms: ['settings.manage', 'incidents.view'], scope: { level: 'NATIONAL' }, kind: 'user', active: true },
  });
  app = await createApp({ env, module: buildAppModule(env, { provide: PRINCIPAL_RESOLVER, useValue: resolver }) });
  await app.init(); server = app.getHttpServer(); bus = app.get(KIT_BUS); relay = app.get(KIT_RELAY); pool = new Pool({ connectionString: DB_URL });
});
afterAll(async () => { await app?.close(); await pool?.end(); await new Promise<void>((r) => clam?.server.close(() => r())); rmSync(storageDir, { recursive: true, force: true }); });

describe('documents', () => {
  it('seeds fictional case files and lists them only to holders of the audience permission', async () => {
    const seeded = await srv().get('/documents?entityType=Incident&limit=5').set('authorization', officer);
    expect(seeded.status).toBe(200); expect(seeded.body.meta.total).toBeGreaterThan(20); expect(seeded.body.data[0].virusStatus).toBe('SKIPPED');
    const hidden = await srv().get('/documents?entityType=Incident').set('authorization', viewer); expect(hidden.body.meta.total).toBe(0);
    expect((await srv().get('/documents')).status).toBe(401);
    const stats = await srv().get('/documents/stats').set('authorization', officer);
    expect(stats.body.data.total).toBe(seeded.body.meta.total); expect(stats.body.data.bytes).toBeGreaterThan(0); expect(stats.body.data.byDocType.length).toBeGreaterThan(1);
  });

  it('uploads a PDF, hashes and scans it, streams it as an attachment and publishes the events', async () => {
    const up = await upload(officer, { entityType: 'Incident', entityId: 'INC-SAMPLE-1', docType: 'report', audiencePerm: 'incidents.view', note: 'Survey after the berth contact' }, { name: 'survey report.pdf', type: 'application/pdf', body: pdf });
    expect(up.status).toBe(201);
    const doc = up.body.data;
    expect(doc).toMatchObject({ entityType: 'Incident', entityId: 'INC-SAMPLE-1', docType: 'REPORT', mime: 'application/pdf', sizeBytes: pdf.length, sha256: sha(pdf), version: 1, virusStatus: 'CLEAN', audiencePerm: 'incidents.view', uploadedBy: { id: 'officer', name: 'Duty Officer' }, legalHold: false });
    const one = await srv().get(`/documents/${doc.id}`).set('authorization', officer); expect(one.body.data.versions).toHaveLength(1); expect(one.body.data.links).toEqual([]);
    const list = await srv().get('/documents?entityType=Incident&entityId=INC-SAMPLE-1').set('authorization', officer); expect(list.body.data.map((d: { id: string }) => d.id)).toContain(doc.id);
    const content = await srv().get(`/documents/${doc.id}/content`).set('authorization', officer).buffer(true).parse(binary);
    expect(content.status).toBe(200); expect(content.headers['content-type']).toBe('application/pdf'); expect(content.headers['content-disposition']).toMatch(/^attachment; filename="survey report.pdf"; filename\*=UTF-8''survey%20report.pdf$/);
    expect(content.headers['x-content-type-options']).toBe('nosniff'); expect(Buffer.compare(content.body as Buffer, pdf)).toBe(0);
    const events = await published();
    const uploaded = events.find((e) => e.event.type === EVENTS.documents.uploaded && (e.event.data as { documentId: string }).documentId === doc.id);
    expect(uploaded?.event.actor?.id).toBe('officer'); expect((uploaded?.event.data as { sha256: string }).sha256).toBe(sha(pdf));
    expect(events.some((e) => e.event.type === EVENTS.readModel.upserted && (e.event.data as { kind: string; entity: { id: string } }).kind === 'document' && (e.event.data as { entity: { id: string } }).entity.id === doc.id)).toBe(true);
    expect(events.some((e) => e.event.type === EVENTS.audit.recorded && (e.event.data as { action: string; entityId: string }).action === 'UPLOAD' && (e.event.data as { entityId: string }).entityId === doc.id)).toBe(true);
  });

  it('checks the audience on upload and on every read', async () => {
    const up = await upload(officer, { entityType: 'Incident', entityId: 'INC-SAMPLE-2', audiencePerm: 'incidents.view' }, { name: 'photo.png', type: 'image/png', body: PNG });
    expect(up.status).toBe(201);
    expect((await srv().get(`/documents/${up.body.data.id}`).set('authorization', viewer)).status).toBe(403);
    expect((await srv().get(`/documents/${up.body.data.id}/content`).set('authorization', viewer)).status).toBe(403);
    expect((await srv().post(`/documents/${up.body.data.id}/signed-url`).set('authorization', viewer)).status).toBe(403);
    expect((await srv().get(`/documents/${up.body.data.id}`).set('authorization', admin)).status).toBe(200);
    const foreign = await upload(viewer, { entityType: 'Incident', entityId: 'INC-SAMPLE-2', audiencePerm: 'incidents.view' }, { name: 'photo.png', type: 'image/png', body: PNG });
    expect(foreign.status).toBe(403); expect(foreign.body.message).toContain('audience');
    expect((await upload(officer, { entityType: 'Incident', entityId: 'INC-SAMPLE-2', audiencePerm: 'nope.nothing' }, { name: 'photo.png', type: 'image/png', body: PNG })).status).toBe(400);
    expect((await upload(officer, { entityType: 'Incident', entityId: 'INC-SAMPLE-2', audiencePerm: '*' }, { name: 'photo.png', type: 'image/png', body: PNG })).status).toBe(403);
    expect((await upload(admin, { entityType: 'Incident', entityId: 'INC-SAMPLE-2', audiencePerm: '*' }, { name: 'photo.png', type: 'image/png', body: PNG })).status).toBe(201);
  });

  it('refuses blocked types, content that contradicts its type, and oversize uploads', async () => {
    const exe = await upload(officer, { entityType: 'Incident', entityId: 'INC-SAMPLE-3', audiencePerm: 'incidents.view' }, { name: 'tool.exe', type: 'application/x-msdownload', body: Buffer.from('MZ....') });
    expect(exe.status).toBe(415);
    const script = await upload(officer, { entityType: 'Incident', entityId: 'INC-SAMPLE-3', audiencePerm: 'incidents.view' }, { name: 'macro.js', type: 'application/octet-stream', body: Buffer.from('alert(1)') });
    expect(script.status).toBe(415);
    const mismatch = await upload(officer, { entityType: 'Incident', entityId: 'INC-SAMPLE-3', audiencePerm: 'incidents.view' }, { name: 'report.pdf', type: 'application/pdf', body: PNG });
    expect(mismatch.status).toBe(422); expect(mismatch.body.message).toContain('does not match');
    const inferred = await upload(officer, { entityType: 'Incident', entityId: 'INC-SAMPLE-3', audiencePerm: 'incidents.view' }, { name: 'notes.csv', type: 'application/octet-stream', body: Buffer.from('a,b\n1,2\n') });
    expect(inferred.status).toBe(201); expect(inferred.body.data.mime).toBe('text/csv');
    const big = await upload(officer, { entityType: 'Incident', entityId: 'INC-SAMPLE-3', audiencePerm: 'incidents.view' }, { name: 'big.pdf', type: 'application/pdf', body: Buffer.concat([pdf, Buffer.alloc(1200 * 1024, 0x20)]) });
    expect(big.status).toBe(413);
    expect((await srv().post('/documents').set('authorization', officer).field('entityType', 'Incident').field('entityId', 'x').field('audiencePerm', 'incidents.view')).status).toBe(400);
  });

  it('signs download links that stream without a session, expire, and reject tampering', async () => {
    const up = await upload(officer, { entityType: 'Vessel', entityId: 'V-SAMPLE-1', audiencePerm: 'certificates.view', docType: 'CERTIFICATE' }, { name: 'load-line.pdf', type: 'application/pdf', body: pdf });
    const id = up.body.data.id;
    const signed = await srv().post(`/documents/${id}/signed-url`).set('authorization', officer).send({ ttlSec: 60 });
    expect(signed.status).toBe(201); expect(signed.body.data.url).toMatch(new RegExp(`^http://127.0.0.1:5410/files/${id}\\?exp=\\d+&sig=[a-f0-9]{64}$`));
    expect(new Date(signed.body.data.expiresAt).getTime()).toBeGreaterThan(Date.now() + 50_000);
    const path = new URL(signed.body.data.url).pathname + new URL(signed.body.data.url).search;
    const ok = await srv().get(path).buffer(true).parse(binary);
    expect(ok.status).toBe(200); expect(ok.headers['content-disposition']).toContain('attachment'); expect(Buffer.compare(ok.body as Buffer, pdf)).toBe(0);
    const tampered = path.slice(0, -1) + (path.endsWith('0') ? '1' : '0');
    expect((await srv().get(tampered)).status).toBe(403);
    expect((await srv().get(path.replace(/exp=\d+/, 'exp=9999999999'))).status).toBe(403);
    expect((await srv().get(`/files/${id}`)).status).toBe(403);
    const past = Math.floor(Date.now() / 1000) - 120;
    expect((await srv().get(`/files/${id}?exp=${past}&sig=${fileSignature(URL_SECRET, id, past)}`)).status).toBe(410);
    const unknown = '00000000-0000-4000-8000-000000000000'; const soon = Math.floor(Date.now() / 1000) + 60;
    expect((await srv().get(`/files/${unknown}?exp=${past}&sig=${fileSignature(URL_SECRET, unknown, past)}`)).status).toBe(410);
    expect((await srv().get(`/files/${unknown}?exp=${soon}&sig=${fileSignature(URL_SECRET, unknown, soon)}`)).status).toBe(404);
  });

  it('versions a document and keeps every earlier version retrievable', async () => {
    const v1 = pdf; const v2 = minimalPdf('Survey report, revised (sample)');
    const up = await upload(officer, { entityType: 'Incident', entityId: 'INC-SAMPLE-4', audiencePerm: 'incidents.view' }, { name: 'survey.pdf', type: 'application/pdf', body: v1 });
    const id = up.body.data.id;
    const rev = await upload(officer, { note: 'Revised after the master statement' }, { name: 'survey-v2.pdf', type: 'application/pdf', body: v2 }, `/documents/${id}/versions`);
    expect(rev.status).toBe(201); expect(rev.body.data).toMatchObject({ version: 2, name: 'survey-v2.pdf', sha256: sha(v2), sizeBytes: v2.length });
    const versions = await srv().get(`/documents/${id}/versions`).set('authorization', officer);
    expect(versions.body.data.map((v: { version: number; sha256: string }) => [v.version, v.sha256])).toEqual([[1, sha(v1)], [2, sha(v2)]]);
    const old = await srv().get(`/documents/${id}/versions/1/content`).set('authorization', officer).buffer(true).parse(binary); expect(Buffer.compare(old.body as Buffer, v1)).toBe(0);
    const latest = await srv().get(`/documents/${id}/content`).set('authorization', officer).buffer(true).parse(binary); expect(Buffer.compare(latest.body as Buffer, v2)).toBe(0);
    expect((await srv().get(`/documents/${id}/versions/3/content`).set('authorization', officer)).status).toBe(404);
    expect((await upload(viewer, {}, { name: 'x.pdf', type: 'application/pdf', body: v2 }, `/documents/${id}/versions`)).status).toBe(403);
  });

  it('links a document to a second entity so it lists there too', async () => {
    const up = await upload(officer, { entityType: 'Incident', entityId: 'INC-SAMPLE-5', audiencePerm: 'incidents.view' }, { name: 'statement.pdf', type: 'application/pdf', body: pdf });
    const id = up.body.data.id;
    const link = await srv().post(`/documents/${id}/links`).set('authorization', officer).send({ entityType: 'PortCall', entityId: 'PC-SAMPLE-9', relation: 'evidence' });
    expect(link.status).toBe(201); expect(link.body.data.relation).toBe('EVIDENCE');
    const byCall = await srv().get('/documents?entityType=PortCall&entityId=PC-SAMPLE-9').set('authorization', officer); expect(byCall.body.data.map((d: { id: string }) => d.id)).toEqual([id]);
    expect((await srv().delete(`/documents/${id}/links/${link.body.data.id}`).set('authorization', officer)).status).toBe(200);
    expect((await srv().get('/documents?entityType=PortCall&entityId=PC-SAMPLE-9').set('authorization', officer)).body.meta.total).toBe(0);
  });

  it('soft-deletes for the uploader or a settings manager, never under legal hold', async () => {
    const mine = (await upload(officer, { entityType: 'Incident', entityId: 'INC-SAMPLE-6', audiencePerm: 'incidents.view' }, { name: 'draft.txt', type: 'text/plain', body: Buffer.from('draft') })).body.data.id;
    const theirs = (await upload(admin, { entityType: 'Incident', entityId: 'INC-SAMPLE-6', audiencePerm: 'incidents.view' }, { name: 'official.txt', type: 'text/plain', body: Buffer.from('official') })).body.data.id;
    expect((await srv().delete(`/documents/${theirs}`).set('authorization', officer)).status).toBe(403);
    expect((await srv().post(`/documents/${mine}/legal-hold`).set('authorization', officer).send({ hold: true })).status).toBe(403);
    const hold = await srv().post(`/documents/${mine}/legal-hold`).set('authorization', compliance).send({ hold: true, reason: 'Board of inquiry' });
    expect(hold.status).toBe(201); expect(hold.body.data).toMatchObject({ legalHold: true, legalHoldReason: 'Board of inquiry' });
    const blocked = await srv().delete(`/documents/${mine}`).set('authorization', officer); expect(blocked.status).toBe(409); expect(blocked.body.message).toContain('legal hold');
    expect((await srv().post(`/documents/${mine}/legal-hold`).set('authorization', compliance).send({ hold: false })).body.data.legalHold).toBe(false);
    const del = await srv().delete(`/documents/${mine}`).set('authorization', officer); expect(del.body.data).toEqual({ deleted: true, softDelete: true });
    expect((await srv().get(`/documents/${mine}`).set('authorization', officer)).status).toBe(404);
    expect((await srv().get('/documents?entityType=Incident&entityId=INC-SAMPLE-6').set('authorization', officer)).body.data.map((d: { id: string }) => d.id)).toEqual([theirs]);
    expect((await srv().delete(`/documents/${theirs}`).set('authorization', compliance)).status).toBe(200);
    const events = await published();
    expect(events.some((e) => e.event.type === EVENTS.documents.legalHoldChanged && (e.event.data as { documentId: string }).documentId === mine)).toBe(true);
    expect(events.some((e) => e.event.type === EVENTS.documents.deleted && (e.event.data as { documentId: string }).documentId === mine)).toBe(true);
  });

  it('purges documents past retention unless held, from the internal sweep and from the scheduler event', async () => {
    const expired = (await upload(officer, { entityType: 'Incident', entityId: 'INC-SAMPLE-7', audiencePerm: 'incidents.view', retentionUntil: '2024-01-01T00:00:00Z' }, { name: 'old.pdf', type: 'application/pdf', body: pdf })).body.data;
    const held = (await upload(officer, { entityType: 'Incident', entityId: 'INC-SAMPLE-7', audiencePerm: 'incidents.view', retentionUntil: '2024-01-01T00:00:00Z' }, { name: 'held.pdf', type: 'application/pdf', body: pdf })).body.data;
    const future = (await upload(officer, { entityType: 'Incident', entityId: 'INC-SAMPLE-7', audiencePerm: 'incidents.view', retentionUntil: '2099-01-01T00:00:00Z' }, { name: 'future.pdf', type: 'application/pdf', body: pdf })).body.data;
    await srv().post(`/documents/${held.id}/legal-hold`).set('authorization', compliance).send({ hold: true, reason: 'Litigation' });
    const key = (await pool.query<{ storage_key: string }>('SELECT storage_key FROM documents WHERE id = $1', [expired.id])).rows[0].storage_key;
    expect(existsSync(storage.pathFor(key))).toBe(true);
    expect((await srv().post('/internal/documents/retention-sweep')).status).toBe(401);
    const sweep = await srv().post('/internal/documents/retention-sweep').set('x-service-token', 'development-service-token');
    expect(sweep.status).toBe(201); expect(sweep.body.data.documentIds).toContain(expired.id); expect(sweep.body.data.documentIds).not.toContain(held.id); expect(sweep.body.data.documentIds).not.toContain(future.id);
    expect(existsSync(storage.pathFor(key))).toBe(false);
    expect((await pool.query('SELECT 1 FROM documents WHERE id = $1', [expired.id])).rowCount).toBe(0);
    expect((await srv().get(`/documents/${expired.id}`).set('authorization', officer)).status).toBe(404);
    const events = await published();
    expect(events.some((e) => e.event.type === EVENTS.documents.purged && (e.event.data as { documentId: string }).documentId === expired.id)).toBe(true);
    // the scheduler's nightly event runs the same sweep, once per event id
    await srv().post(`/documents/${held.id}/legal-hold`).set('authorization', compliance).send({ hold: false });
    const event = makeEvent({ type: EVENTS.scheduler.sweepRetention, source: 'scheduler', data: { jobKey: 'document-retention' } });
    await bus.publish(subjectFor(EVENTS.scheduler.sweepRetention), event); await bus.publish(subjectFor(EVENTS.scheduler.sweepRetention), event); await bus.drain();
    expect((await pool.query('SELECT 1 FROM documents WHERE id = $1', [held.id])).rowCount).toBe(0);
    expect((await pool.query('SELECT count(*) AS n FROM processed_events WHERE event_id = $1', [event.id])).rows[0].n).toBe('1');
    expect((await srv().get(`/documents/${future.id}`).set('authorization', officer)).status).toBe(200);
  });

  it('quarantines infected content found at upload or reported by the scanner service', async () => {
    const eicar = Buffer.from('test marker EICAR-STANDARD-ANTIVIRUS-TEST-FILE for the fake clamd');
    const refused = await upload(officer, { entityType: 'Incident', entityId: 'INC-SAMPLE-8', audiencePerm: 'incidents.view' }, { name: 'payload.txt', type: 'text/plain', body: eicar });
    expect(refused.status).toBe(422); expect(refused.body.message).toContain('Eicar-Test-Signature');
    const quarantined = await pool.query<{ id: string; virus_status: string; deleted_at: Date | null; storage_key: string }>("SELECT id, virus_status, deleted_at, storage_key FROM documents WHERE entity_id = 'INC-SAMPLE-8'");
    expect(quarantined.rows[0].virus_status).toBe('INFECTED'); expect(quarantined.rows[0].deleted_at).not.toBeNull(); expect(existsSync(storage.pathFor(quarantined.rows[0].storage_key))).toBe(false);
    expect((await srv().get(`/documents/${quarantined.rows[0].id}/content`).set('authorization', officer)).status).toBe(410);
    const clean = (await upload(officer, { entityType: 'Incident', entityId: 'INC-SAMPLE-9', audiencePerm: 'incidents.view' }, { name: 'later.pdf', type: 'application/pdf', body: pdf })).body.data;
    expect((await srv().post('/internal/documents/scan-result').send({ documentId: clean.id, status: 'INFECTED' })).status).toBe(401);
    const result = await srv().post('/internal/documents/scan-result').set('x-service-token', 'development-service-token').send({ documentId: clean.id, status: 'INFECTED', detail: 'Win.Test.Signature', scanner: 'sandbox' });
    expect(result.status).toBe(201); expect(result.body.data).toMatchObject({ virusStatus: 'INFECTED', scanDetail: 'Win.Test.Signature' });
    expect((await srv().get(`/documents/${clean.id}/content`).set('authorization', officer)).status).toBe(410);
    const cleanKey = (await pool.query<{ storage_key: string }>('SELECT storage_key FROM documents WHERE id = $1', [clean.id])).rows[0].storage_key;
    expect(existsSync(storage.pathFor(cleanKey))).toBe(false);
    const stats = await srv().get('/documents/stats').set('authorization', officer); expect(stats.body.data.infected).toBeGreaterThanOrEqual(2);
    const events = await published();
    expect(events.filter((e) => e.event.type === EVENTS.documents.scanned && (e.event.data as { status: string }).status === 'INFECTED').length).toBeGreaterThanOrEqual(2);
  });
});
