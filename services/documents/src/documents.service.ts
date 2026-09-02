import { Inject, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Response } from 'express';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, hasPerm, isKnownPermission, WILDCARD } from '@maritime/contracts';
import { KIT_ENV, KIT_LOGGER, KIT_POOL, ApiError, AuditClient, badRequest, conflict, forbidden, notFound, unprocessable, withTx, enqueue, eventFromContext, getContext, type AppLogger, type Principal, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { STORAGE, StorageObjectNotFound, newStorageKey, type Storage } from './storage';
import { SCANNER, type Scanner, type ScanResult } from './scanner';
import { contentDisposition, contentMatches, resolveMime, safeFileName } from './mime';

export interface Uploader { id: string; name: string }
export interface DocRow {
  id: string; entity_type: string; entity_id: string; name: string; doc_type: string; mime: string; size_bytes: string; sha256: string; storage_key: string; version: number; uploaded_by: Uploader;
  audience_perm: string; virus_status: string; scan_detail: string | null; retention_until: Date | null; legal_hold: boolean; legal_hold_reason: string | null; note: string; scope: unknown;
  created_at: Date; updated_at: Date; deleted_at: Date | null;
}
export interface VersionRow { id: string; document_id: string; version: number; name: string; mime: string; size_bytes: string; sha256: string; storage_key: string; uploaded_by: Uploader; note: string; created_at: Date }
export interface LinkRow { id: string; document_id: string; entity_type: string; entity_id: string; relation: string; created_by: Uploader; created_at: Date }
export interface UploadInput { buffer: Buffer; originalName: string; declaredMime?: string; name?: string; note?: string }
export interface NewDocumentInput extends UploadInput { entityType: string; entityId: string; docType: string; audiencePerm: string; retentionUntil?: string | null }

export const toApi = (r: DocRow) => ({
  id: r.id, entityType: r.entity_type, entityId: r.entity_id, name: r.name, docType: r.doc_type, mime: r.mime, sizeBytes: Number(r.size_bytes), sha256: r.sha256, version: r.version, uploadedBy: r.uploaded_by,
  audiencePerm: r.audience_perm, virusStatus: r.virus_status, scanDetail: r.scan_detail, retentionUntil: r.retention_until, legalHold: r.legal_hold, legalHoldReason: r.legal_hold_reason, note: r.note,
  createdAt: r.created_at, updatedAt: r.updated_at, deletedAt: r.deleted_at,
});
export const versionToApi = (v: VersionRow) => ({ id: v.id, documentId: v.document_id, version: v.version, name: v.name, mime: v.mime, sizeBytes: Number(v.size_bytes), sha256: v.sha256, uploadedBy: v.uploaded_by, note: v.note, createdAt: v.created_at });
export const linkToApi = (l: LinkRow) => ({ id: l.id, documentId: l.document_id, entityType: l.entity_type, entityId: l.entity_id, relation: l.relation, createdBy: l.created_by, createdAt: l.created_at });
export const sha256Of = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Streams a stored object as an attachment; the browser never renders it inline and never sniffs a different type. */
export async function streamObject(res: Response, storage: Storage, key: string, name: string, mime: string, size: number, log?: AppLogger): Promise<void> {
  let stream: Readable;
  try { stream = await storage.get(key); } catch (e) { if (e instanceof StorageObjectNotFound) throw notFound('Stored object is missing'); throw e; }
  res.status(200);
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', String(size));
  res.setHeader('Content-Disposition', contentDisposition(name));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, no-store');
  try { await pipeline(stream, res); } catch (e) {
    log?.warn({ err: e, key }, 'document stream interrupted');
    if (!res.headersSent) res.status(500).json({ success: false, message: 'Stream failed' }); else res.destroy();
  }
}

@Injectable()
export class DocumentsService {
  constructor(
    @Inject(KIT_POOL) readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, @Inject(KIT_LOGGER) readonly log: AppLogger,
    @Inject(STORAGE) readonly storage: Storage, @Inject(SCANNER) private readonly scanner: Scanner, private readonly audit: AuditClient,
  ) {}

  /** Rows whose audience permission the caller holds; the wildcard sees everything. */
  audienceClause(user: Principal, args: unknown[], alias = 'd'): string {
    if (hasPerm(user.perms, WILDCARD)) return 'TRUE';
    args.push(user.perms);
    return `${alias}.audience_perm = ANY($${args.length}::text[])`;
  }
  canRead(user: Principal, row: DocRow): boolean { return hasPerm(user.perms, row.audience_perm); }
  canModify(user: Principal, row: DocRow): boolean { return hasPerm(user.perms, WILDCARD) || hasPerm(user.perms, 'settings.manage') || row.uploaded_by?.id === user.id; }
  uploader(user: Principal): Uploader { return { id: user.id, name: user.name }; }

  async find(id: string, opts: { includeDeleted?: boolean } = {}): Promise<DocRow | null> {
    if (!UUID.test(id)) return null;
    const r = await this.pool.query<DocRow>(`SELECT * FROM documents WHERE id = $1${opts.includeDeleted ? '' : ' AND deleted_at IS NULL'}`, [id]);
    return r.rows[0] ?? null;
  }
  async findFor(user: Principal, id: string, opts: { includeDeleted?: boolean } = {}): Promise<DocRow> {
    const row = await this.find(id, opts);
    if (!row) throw notFound('Document not found');
    if (!this.canRead(user, row)) throw forbidden('Forbidden: document audience');
    return row;
  }
  async versions(id: string): Promise<VersionRow[]> { return (await this.pool.query<VersionRow>('SELECT * FROM document_versions WHERE document_id = $1 ORDER BY version', [id])).rows; }
  async links(id: string): Promise<LinkRow[]> { return (await this.pool.query<LinkRow>('SELECT * FROM document_links WHERE document_id = $1 ORDER BY created_at', [id])).rows; }

  /** Allow-listed type, magic bytes that agree with it, a safe name and the content hash. */
  prepare(input: UploadInput): { mime: string; name: string; sha256: string } {
    if (!input.buffer || input.buffer.length === 0) throw badRequest('file is required');
    const name = safeFileName(input.name || input.originalName);
    const mime = resolveMime(input.declaredMime, name);
    if (!mime) throw new ApiError(415, `Unsupported file type${input.declaredMime ? ` ${input.declaredMime.split(';')[0]}` : ''}: allowed are PDF, images, office documents, CSV, text and zip`);
    if (!contentMatches(mime, input.buffer)) throw unprocessable(`File content does not match the declared type ${mime}`);
    return { mime, name, sha256: sha256Of(input.buffer) };
  }
  assertAudience(user: Principal, audiencePerm: string) {
    if (!isKnownPermission(audiencePerm)) throw badRequest(`Unknown audience permission ${audiencePerm}`);
    if (!hasPerm(user.perms, audiencePerm)) throw forbidden(`Forbidden: you do not hold the audience permission ${audiencePerm}`);
  }
  private async scan(buffer: Buffer): Promise<ScanResult> {
    try { return await this.scanner.scan(buffer); }
    catch (e) { this.log.warn({ err: e, scanner: this.scanner.name }, 'virus scan unavailable; document left PENDING'); return { status: 'PENDING', scanner: this.scanner.name, detail: (e as Error).message }; }
  }
  private async emitUpsert(c: Queryable, row: DocRow) { await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.readModel.upserted, { kind: 'document', entity: toApi(row) }, { subject: row.id })); }
  private async emitDelete(c: Queryable, id: string) { await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.readModel.deleted, { kind: 'document', id }, { subject: id })); }
  private uploadedEvent(row: DocRow) {
    return { documentId: row.id, entityType: row.entity_type, entityId: row.entity_id, name: row.name, docType: row.doc_type, mime: row.mime, sizeBytes: Number(row.size_bytes), sha256: row.sha256, version: row.version, audiencePerm: row.audience_perm, uploadedBy: row.uploaded_by, virusStatus: row.virus_status };
  }

  /** Store, scan, record. An infected upload is quarantined (object removed, row marked) and refused. */
  async create(user: Principal, input: NewDocumentInput): Promise<DocRow> {
    const meta = this.prepare(input);
    this.assertAudience(user, input.audiencePerm);
    const key = newStorageKey();
    await this.storage.put(key, input.buffer, meta.mime);
    const scan = await this.scan(input.buffer);
    let row: DocRow;
    try {
      row = await withTx(this.pool, async (c) => {
        const r = await c.query<DocRow>(
          `INSERT INTO documents(entity_type, entity_id, name, doc_type, mime, size_bytes, sha256, storage_key, version, uploaded_by, audience_perm, virus_status, scan_detail, retention_until, note, scope)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,1,$9,$10,$11,$12,$13,$14,$15) RETURNING *`,
          [input.entityType, input.entityId, meta.name, input.docType, meta.mime, input.buffer.length, meta.sha256, key, JSON.stringify(this.uploader(user)), input.audiencePerm, scan.status, scan.detail ?? null, input.retentionUntil ?? null, input.note ?? '', JSON.stringify(getContext()?.scope ?? { level: 'NATIONAL' })]);
        const doc = r.rows[0];
        await c.query('INSERT INTO document_versions(document_id, version, name, mime, size_bytes, sha256, storage_key, uploaded_by, note) VALUES ($1,1,$2,$3,$4,$5,$6,$7,$8)', [doc.id, doc.name, doc.mime, doc.size_bytes, doc.sha256, key, JSON.stringify(doc.uploaded_by), doc.note]);
        await this.audit.record(c, { action: 'UPLOAD', entity: 'Document', entityId: doc.id, entityLabel: doc.name, after: toApi(doc) });
        await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.documents.uploaded, this.uploadedEvent(doc), { subject: doc.id }));
        if (scan.status === 'INFECTED') return this.quarantine(c, doc, scan);
        await this.emitUpsert(c, doc);
        return doc;
      });
    } catch (e) { await this.storage.delete(key).catch(() => undefined); throw e; }
    if (row.virus_status === 'INFECTED') { await this.deleteObjects([key]); throw unprocessable(`File rejected by the virus scanner${scan.detail ? ` (${scan.detail})` : ''}`); }
    return row;
  }

  /** A new version replaces the served content; every earlier version stays retrievable until the document is purged. */
  async addVersion(user: Principal, id: string, input: UploadInput): Promise<DocRow> {
    await this.findFor(user, id);
    const meta = this.prepare(input);
    const key = newStorageKey();
    await this.storage.put(key, input.buffer, meta.mime);
    const scan = await this.scan(input.buffer);
    let row: DocRow;
    try {
      row = await withTx(this.pool, async (c) => {
        const locked = await c.query<DocRow>('SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL FOR UPDATE', [id]);
        const before = locked.rows[0]; if (!before) throw notFound('Document not found');
        const r = await c.query<DocRow>(
          'UPDATE documents SET name=$2, mime=$3, size_bytes=$4, sha256=$5, storage_key=$6, version=version+1, uploaded_by=$7, virus_status=$8, scan_detail=$9, note = CASE WHEN $10 <> \'\' THEN $10 ELSE note END, updated_at=now() WHERE id=$1 RETURNING *',
          [id, meta.name, meta.mime, input.buffer.length, meta.sha256, key, JSON.stringify(this.uploader(user)), scan.status, scan.detail ?? null, input.note ?? '']);
        const doc = r.rows[0];
        await c.query('INSERT INTO document_versions(document_id, version, name, mime, size_bytes, sha256, storage_key, uploaded_by, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, doc.version, doc.name, doc.mime, doc.size_bytes, doc.sha256, key, JSON.stringify(doc.uploaded_by), input.note ?? '']);
        await this.audit.record(c, { action: 'NEW_VERSION', entity: 'Document', entityId: id, entityLabel: doc.name, before: toApi(before), after: toApi(doc) });
        await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.documents.uploaded, this.uploadedEvent(doc), { subject: id }));
        if (scan.status === 'INFECTED') return this.quarantine(c, doc, scan);
        await this.emitUpsert(c, doc);
        return doc;
      });
    } catch (e) { await this.storage.delete(key).catch(() => undefined); throw e; }
    if (row.virus_status === 'INFECTED') { await this.deleteObjects(await this.keysFor(this.pool, id)); throw unprocessable(`File rejected by the virus scanner${scan.detail ? ` (${scan.detail})` : ''}`); }
    return row;
  }

  /** Marks the row infected and removed; the caller deletes the objects once the transaction is committed. */
  private async quarantine(c: Queryable, doc: DocRow, scan: ScanResult): Promise<DocRow> {
    const r = await c.query<DocRow>('UPDATE documents SET virus_status = \'INFECTED\', scan_detail = $2, deleted_at = now(), updated_at = now() WHERE id = $1 RETURNING *', [doc.id, scan.detail ?? null]);
    const row = r.rows[0];
    await this.audit.record(c, { action: 'QUARANTINE', entity: 'Document', entityId: row.id, entityLabel: row.name, before: toApi(doc), after: toApi(row), note: scan.detail ?? undefined });
    await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.documents.scanned, { documentId: row.id, status: 'INFECTED', detail: scan.detail ?? null, scanner: scan.scanner }, { subject: row.id }));
    await this.emitDelete(c, row.id);
    return row;
  }

  /** Result from the scanner service (or a re-scan): INFECTED removes the objects and marks the row; CLEAN clears the pending state. */
  async applyScanResult(id: string, status: 'CLEAN' | 'INFECTED', detail: string | null, scanner: string): Promise<DocRow> {
    const doc = await this.find(id);
    if (!doc) throw notFound('Document not found');
    const row = await withTx(this.pool, async (c) => {
      if (status === 'INFECTED') return this.quarantine(c, doc, { status, scanner, detail: detail ?? undefined });
      const r = await c.query<DocRow>('UPDATE documents SET virus_status = \'CLEAN\', scan_detail = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, detail]);
      await this.audit.record(c, { action: 'SCAN', entity: 'Document', entityId: id, entityLabel: doc.name, before: { virusStatus: doc.virus_status }, after: { virusStatus: 'CLEAN' } });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.documents.scanned, { documentId: id, status: 'CLEAN', detail, scanner }, { subject: id }));
      await this.emitUpsert(c, r.rows[0]);
      return r.rows[0];
    });
    if (status === 'INFECTED') await this.deleteObjects(await this.keysFor(this.pool, id));
    return row;
  }

  async softDelete(user: Principal, id: string): Promise<void> {
    const doc = await this.findFor(user, id);
    if (!this.canModify(user, doc)) throw forbidden('Forbidden: only the uploader or a settings manager can delete a document');
    if (doc.legal_hold) throw conflict('Document is under legal hold');
    await withTx(this.pool, async (c) => {
      await c.query('UPDATE documents SET deleted_at = now(), updated_at = now() WHERE id = $1', [id]);
      await this.audit.record(c, { action: 'DELETE', entity: 'Document', entityId: id, entityLabel: doc.name, before: toApi(doc) });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.documents.deleted, { documentId: id, entityType: doc.entity_type, entityId: doc.entity_id, name: doc.name, softDelete: true }, { subject: id }));
      await this.emitDelete(c, id);
    });
  }

  async setLegalHold(id: string, hold: boolean, reason: string | null): Promise<DocRow> {
    const doc = await this.find(id, { includeDeleted: true });
    if (!doc) throw notFound('Document not found');
    return withTx(this.pool, async (c) => {
      const r = await c.query<DocRow>('UPDATE documents SET legal_hold = $2, legal_hold_reason = $3, updated_at = now() WHERE id = $1 RETURNING *', [id, hold, hold ? reason : null]);
      await this.audit.record(c, { action: hold ? 'LEGAL_HOLD' : 'LEGAL_HOLD_RELEASED', entity: 'Document', entityId: id, entityLabel: doc.name, before: { legalHold: doc.legal_hold, reason: doc.legal_hold_reason }, after: { legalHold: hold, reason: hold ? reason : null } });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.documents.legalHoldChanged, { documentId: id, legalHold: hold, reason: hold ? reason : null }, { subject: id }));
      if (!r.rows[0].deleted_at) await this.emitUpsert(c, r.rows[0]);
      return r.rows[0];
    });
  }

  async setRetention(id: string, until: Date | null): Promise<DocRow> {
    const doc = await this.find(id, { includeDeleted: true });
    if (!doc) throw notFound('Document not found');
    return withTx(this.pool, async (c) => {
      const r = await c.query<DocRow>('UPDATE documents SET retention_until = $2, updated_at = now() WHERE id = $1 RETURNING *', [id, until]);
      await this.audit.record(c, { action: 'RETENTION', entity: 'Document', entityId: id, entityLabel: doc.name, before: { retentionUntil: doc.retention_until }, after: { retentionUntil: until } });
      if (!r.rows[0].deleted_at) await this.emitUpsert(c, r.rows[0]);
      return r.rows[0];
    });
  }

  async addLink(user: Principal, id: string, entityType: string, entityId: string, relation: string): Promise<LinkRow> {
    const doc = await this.findFor(user, id);
    return withTx(this.pool, async (c) => {
      const r = await c.query<LinkRow>('INSERT INTO document_links(document_id, entity_type, entity_id, relation, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (document_id, entity_type, entity_id) DO UPDATE SET relation = EXCLUDED.relation RETURNING *', [id, entityType, entityId, relation, JSON.stringify(this.uploader(user))]);
      await this.audit.record(c, { action: 'LINK', entity: 'Document', entityId: id, entityLabel: doc.name, after: linkToApi(r.rows[0]) });
      return r.rows[0];
    });
  }
  async removeLink(user: Principal, id: string, linkId: string): Promise<void> {
    const doc = await this.findFor(user, id);
    if (!UUID.test(linkId)) throw notFound('Link not found');
    await withTx(this.pool, async (c) => {
      const r = await c.query<LinkRow>('DELETE FROM document_links WHERE id = $1 AND document_id = $2 RETURNING *', [linkId, id]);
      if (!r.rows[0]) throw notFound('Link not found');
      await this.audit.record(c, { action: 'UNLINK', entity: 'Document', entityId: id, entityLabel: doc.name, before: linkToApi(r.rows[0]) });
    });
  }

  async keysFor(client: Queryable, id: string): Promise<string[]> {
    const r = await client.query<{ storage_key: string }>('SELECT storage_key FROM documents WHERE id = $1 UNION SELECT storage_key FROM document_versions WHERE document_id = $1', [id]);
    return [...new Set(r.rows.map((x) => x.storage_key))];
  }
  async deleteObjects(keys: string[]): Promise<void> {
    for (const key of keys) { try { await this.storage.delete(key); } catch (e) { this.log.warn({ err: e, key }, 'object delete failed'); } }
  }

  /** Purges rows past their retention date (and soft-deleted rows older than PURGE_DELETED_AFTER_DAYS) unless a legal hold applies. Objects go first; a row whose objects cannot be removed is retried on the next sweep. */
  async purgeExpired(client: PoolClient, now = new Date()): Promise<{ purged: number; documentIds: string[] }> {
    const due = await client.query<DocRow>(
      `SELECT * FROM documents WHERE legal_hold = false AND ((retention_until IS NOT NULL AND retention_until <= $1::timestamptz) OR (deleted_at IS NOT NULL AND deleted_at <= $1::timestamptz - make_interval(days => $2::int)))
       ORDER BY created_at LIMIT 500 FOR UPDATE SKIP LOCKED`, [now, this.env.PURGE_DELETED_AFTER_DAYS]);
    const purged: string[] = [];
    for (const doc of due.rows) {
      const keys = await this.keysFor(client, doc.id);
      let failed = false;
      for (const key of keys) { try { await this.storage.delete(key); } catch (e) { failed = true; this.log.warn({ err: e, key, documentId: doc.id }, 'purge: object delete failed; row kept for the next sweep'); } }
      if (failed) continue;
      await client.query('DELETE FROM documents WHERE id = $1', [doc.id]);
      await this.audit.record(client, { action: 'PURGE', entity: 'Document', entityId: doc.id, entityLabel: doc.name, before: toApi(doc), note: doc.retention_until ? 'retention period ended' : 'deleted document aged out' });
      await enqueue(client, eventFromContext(this.env.SERVICE_NAME, EVENTS.documents.purged, { documentId: doc.id, entityType: doc.entity_type, entityId: doc.entity_id, name: doc.name, docType: doc.doc_type, retentionUntil: doc.retention_until, deletedAt: doc.deleted_at, objects: keys.length }, { subject: doc.id }));
      await this.emitDelete(client, doc.id);
      purged.push(doc.id);
    }
    return { purged: purged.length, documentIds: purged };
  }
}
