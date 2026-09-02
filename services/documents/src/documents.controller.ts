import { Body, Controller, Delete, Get, Inject, Param, Post, Query, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { z } from 'zod';
import type { PageQuery } from '@maritime/contracts';
import { KIT_ENV, CurrentUser, RequirePerm, zod, paged, parsePage, escapeLike, badRequest, notFound, ApiError, type Principal } from '@maritime/service-kit';
import type { Env } from './env';
import { DocumentsService, linkToApi, streamObject, toApi, versionToApi, UUID, type DocRow } from './documents.service';
import { buildSignedUrl } from './signing';

const isoDate = z.string().refine((s) => !Number.isNaN(Date.parse(s)), 'must be an ISO-8601 date-time');
const entityType = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{1,59}$/, 'entityType must be a model name');
const entityId = z.string().min(1).max(120);
const docType = z.string().max(40).optional().default('OTHER').transform((s) => s.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'OTHER');
const uploadSchema = z.object({
  entityType, entityId, docType,
  audiencePerm: z.string().regex(/^(\*|[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*)$/, 'audiencePerm must be a module.action permission or *'),
  note: z.string().max(2000).optional().default(''),
  name: z.string().max(200).optional(),
  retentionUntil: isoDate.optional().nullable(),
});
const versionSchema = z.object({ note: z.string().max(2000).optional().default(''), name: z.string().max(200).optional() });
const signedUrlSchema = z.object({ ttlSec: z.coerce.number().int().min(30).max(86400).optional() }).optional().default({});
const legalHoldSchema = z.object({ hold: z.boolean(), reason: z.string().max(500).optional().nullable() });
const retentionSchema = z.object({ retentionUntil: isoDate.nullable() });
const linkSchema = z.object({ entityType, entityId, relation: z.string().max(40).optional().default('RELATED').transform((s) => s.toUpperCase()) });
const SORT: Record<string, string> = { createdAt: 'created_at', name: 'name', docType: 'doc_type', sizeBytes: 'size_bytes', version: 'version', entityType: 'entity_type' };
type Upload = Express.Multer.File;
const fromUpload = (file: Upload | undefined) => { if (!file?.buffer) throw badRequest('file is required (multipart field "file")'); return { buffer: file.buffer, originalName: file.originalname, declaredMime: file.mimetype }; };

/** Every module attaches evidence here. Readers must hold the document's audience permission; uploaders can only address audiences they belong to. */
@Controller('documents')
export class DocumentsController {
  constructor(private readonly docs: DocumentsService, @Inject(KIT_ENV) private readonly env: Env) {}

  @Post() @UseInterceptors(FileInterceptor('file'))
  async upload(@CurrentUser() user: Principal, @UploadedFile() file: Upload | undefined, @Body(zod(uploadSchema)) b: z.infer<typeof uploadSchema>) {
    const row = await this.docs.create(user, { ...fromUpload(file), entityType: b.entityType, entityId: b.entityId, docType: b.docType, audiencePerm: b.audiencePerm, note: b.note, name: b.name, retentionUntil: b.retentionUntil ? new Date(b.retentionUntil).toISOString() : null });
    return toApi(row);
  }

  @Get('stats')
  async stats(@CurrentUser() user: Principal) {
    const args: unknown[] = []; const aud = this.docs.audienceClause(user, args);
    const t = await this.docs.pool.query<Record<string, string>>(
      `SELECT count(*) FILTER (WHERE deleted_at IS NULL) AS total, coalesce(sum(size_bytes) FILTER (WHERE deleted_at IS NULL), 0) AS bytes,
              count(*) FILTER (WHERE deleted_at IS NULL AND legal_hold) AS legal_hold, count(*) FILTER (WHERE deleted_at IS NULL AND virus_status = 'PENDING') AS pending_scan,
              count(*) FILTER (WHERE virus_status = 'INFECTED') AS infected, count(*) FILTER (WHERE deleted_at IS NOT NULL AND virus_status <> 'INFECTED') AS deleted,
              count(*) FILTER (WHERE deleted_at IS NULL AND retention_until IS NOT NULL AND retention_until <= now() + interval '30 days') AS expiring_30d
       FROM documents d WHERE ${aud}`, args);
    const byType = await this.docs.pool.query<{ doc_type: string; n: string }>(`SELECT doc_type, count(*) AS n FROM documents d WHERE deleted_at IS NULL AND ${aud} GROUP BY 1 ORDER BY n DESC, 1 LIMIT 12`, args);
    const byEntity = await this.docs.pool.query<{ entity_type: string; n: string }>(`SELECT entity_type, count(*) AS n FROM documents d WHERE deleted_at IS NULL AND ${aud} GROUP BY 1 ORDER BY n DESC, 1 LIMIT 12`, args);
    const s = t.rows[0];
    return { total: Number(s.total), bytes: Number(s.bytes), legalHold: Number(s.legal_hold), pendingScan: Number(s.pending_scan), infected: Number(s.infected), deleted: Number(s.deleted), expiringWithin30Days: Number(s.expiring_30d),
      byDocType: byType.rows.map((r) => ({ docType: r.doc_type, count: Number(r.n) })), byEntityType: byEntity.rows.map((r) => ({ entityType: r.entity_type, count: Number(r.n) })) };
  }

  @Get()
  async list(@CurrentUser() user: Principal, @Query() query: PageQuery & { entityType?: string; entityId?: string; docType?: string }) {
    const p = parsePage(query, { defaultSort: '-createdAt', sortable: Object.keys(SORT) });
    const args: unknown[] = []; const where = ['d.deleted_at IS NULL', this.docs.audienceClause(user, args)];
    if (query.entityType && query.entityId) {
      args.push(query.entityType, query.entityId); const t = args.length - 1; const i = args.length;
      where.push(`((d.entity_type = $${t} AND d.entity_id = $${i}) OR EXISTS (SELECT 1 FROM document_links l WHERE l.document_id = d.id AND l.entity_type = $${t} AND l.entity_id = $${i}))`);
    } else if (query.entityType) { args.push(query.entityType); where.push(`d.entity_type = $${args.length}`); }
    if (query.docType) { args.push(String(query.docType).toUpperCase()); where.push(`d.doc_type = $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(d.name ILIKE $${args.length} OR d.note ILIKE $${args.length} OR d.entity_id ILIKE $${args.length})`); }
    const w = `WHERE ${where.join(' AND ')}`;
    const total = await this.docs.pool.query<{ n: string }>(`SELECT count(*) AS n FROM documents d ${w}`, args);
    const rows = await this.docs.pool.query<DocRow>(`SELECT d.* FROM documents d ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, d.id LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(toApi), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  @Get(':id')
  async get(@CurrentUser() user: Principal, @Param('id') id: string) {
    const row = await this.docs.findFor(user, id);
    const [versions, links] = await Promise.all([this.docs.versions(id), this.docs.links(id)]);
    return { ...toApi(row), versions: versions.map(versionToApi), links: links.map(linkToApi) };
  }

  @Get(':id/content')
  async content(@CurrentUser() user: Principal, @Param('id') id: string, @Res() res: Response) {
    const row = await this.readable(user, id);
    await streamObject(res, this.docs.storage, row.storage_key, row.name, row.mime, Number(row.size_bytes), this.docs.log);
  }

  @Get(':id/versions')
  async versions(@CurrentUser() user: Principal, @Param('id') id: string) { await this.docs.findFor(user, id); return (await this.docs.versions(id)).map(versionToApi); }

  @Post(':id/versions') @UseInterceptors(FileInterceptor('file'))
  async newVersion(@CurrentUser() user: Principal, @Param('id') id: string, @UploadedFile() file: Upload | undefined, @Body(zod(versionSchema)) b: z.infer<typeof versionSchema>) {
    return toApi(await this.docs.addVersion(user, id, { ...fromUpload(file), note: b.note, name: b.name }));
  }

  @Get(':id/versions/:version/content')
  async versionContent(@CurrentUser() user: Principal, @Param('id') id: string, @Param('version') version: string, @Res() res: Response) {
    await this.readable(user, id);
    const n = Number.parseInt(version, 10); if (!Number.isInteger(n) || n < 1) throw notFound('Version not found');
    const v = (await this.docs.versions(id)).find((x) => x.version === n); if (!v) throw notFound('Version not found');
    await streamObject(res, this.docs.storage, v.storage_key, v.name, v.mime, Number(v.size_bytes), this.docs.log);
  }

  /** A time-limited link for viewers without a session header (browser downloads, e-mails, mobile). */
  @Post(':id/signed-url')
  async signedUrl(@CurrentUser() user: Principal, @Param('id') id: string, @Body(zod(signedUrlSchema)) b: z.infer<typeof signedUrlSchema>) {
    const row = await this.readable(user, id);
    return buildSignedUrl(this.env.FILES_BASE_URL, this.env.DOCUMENT_URL_SECRET, row.id, b.ttlSec ?? this.env.SIGNED_URL_TTL_SEC);
  }

  @Post(':id/links')
  async link(@CurrentUser() user: Principal, @Param('id') id: string, @Body(zod(linkSchema)) b: z.infer<typeof linkSchema>) { return linkToApi(await this.docs.addLink(user, id, b.entityType, b.entityId, b.relation)); }
  @Delete(':id/links/:linkId')
  async unlink(@CurrentUser() user: Principal, @Param('id') id: string, @Param('linkId') linkId: string) { await this.docs.removeLink(user, id, linkId); return { deleted: true }; }

  @RequirePerm('settings.manage') @Post(':id/legal-hold')
  async legalHold(@Param('id') id: string, @Body(zod(legalHoldSchema)) b: z.infer<typeof legalHoldSchema>) { return toApi(await this.docs.setLegalHold(id, b.hold, b.reason ?? null)); }
  @RequirePerm('settings.manage') @Post(':id/retention')
  async retention(@Param('id') id: string, @Body(zod(retentionSchema)) b: z.infer<typeof retentionSchema>) { return toApi(await this.docs.setRetention(id, b.retentionUntil ? new Date(b.retentionUntil) : null)); }

  @Delete(':id')
  async remove(@CurrentUser() user: Principal, @Param('id') id: string) { await this.docs.softDelete(user, id); return { deleted: true, softDelete: true }; }

  /** A row the caller may stream: quarantined content is gone for good, deleted content is not served. */
  private async readable(user: Principal, id: string): Promise<DocRow> {
    if (!UUID.test(id)) throw notFound('Document not found');
    const row = await this.docs.find(id, { includeDeleted: true });
    if (!row) throw notFound('Document not found');
    if (!this.docs.canRead(user, row)) throw new ApiError(403, 'Forbidden: document audience');
    if (row.virus_status === 'INFECTED') throw new ApiError(410, 'Document quarantined by the virus scanner');
    if (row.deleted_at) throw notFound('Document not found');
    return row;
  }
}
