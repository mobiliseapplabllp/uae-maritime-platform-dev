import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import { KIT_ENV, Public, ApiError, notFound } from '@maritime/service-kit';
import type { Env } from './env';
import { DocumentsService, streamObject, UUID } from './documents.service';
import { verifyFileSignature } from './signing';

/** Signed download links: no session, the signature over `id|exp` is the credential and it is compared in constant time. */
@Controller('files')
export class FilesController {
  constructor(private readonly docs: DocumentsService, @Inject(KIT_ENV) private readonly env: Env) {}
  @Public() @Get(':id')
  async file(@Param('id') id: string, @Query('exp') exp: string | undefined, @Query('sig') sig: string | undefined, @Res() res: Response) {
    if (!UUID.test(id)) throw notFound('Document not found');
    const expires = Number(exp);
    if (!exp || !sig || !/^\d{1,12}$/.test(exp) || !verifyFileSignature(this.env.DOCUMENT_URL_SECRET, id, expires, String(sig))) throw new ApiError(403, 'Invalid or tampered link');
    if (expires * 1000 < Date.now()) throw new ApiError(410, 'Link expired');
    const row = await this.docs.find(id, { includeDeleted: true });
    if (!row) throw notFound('Document not found');
    if (row.virus_status === 'INFECTED') throw new ApiError(410, 'Document quarantined by the virus scanner');
    if (row.deleted_at) throw notFound('Document not found');
    await streamObject(res, this.docs.storage, row.storage_key, row.name, row.mime, Number(row.size_bytes), this.docs.log);
  }
}
