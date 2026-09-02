import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { z } from 'zod';
import { ServiceOnly, zod, notFound, withTx } from '@maritime/service-kit';
import { DocumentsService, toApi, versionToApi } from './documents.service';

const scanResultSchema = z.object({ documentId: z.string().uuid(), status: z.enum(['CLEAN', 'INFECTED']), detail: z.string().max(500).optional().nullable(), scanner: z.string().max(60).optional().default('external') });

/** Service-to-service surface: scanner call-backs, the retention sweep (also driven by the scheduler event) and metadata for other modules. */
@ServiceOnly()
@Controller('internal/documents')
export class InternalDocumentsController {
  constructor(private readonly docs: DocumentsService) {}
  @Post('scan-result')
  async scanResult(@Body(zod(scanResultSchema)) b: z.infer<typeof scanResultSchema>) { return toApi(await this.docs.applyScanResult(b.documentId, b.status, b.detail ?? null, b.scanner)); }
  @Post('retention-sweep')
  async retentionSweep() { return withTx(this.docs.pool, (c) => this.docs.purgeExpired(c)); }
  @Get(':id')
  async get(@Param('id') id: string) {
    const row = await this.docs.find(id); if (!row) throw notFound('Document not found');
    return { ...toApi(row), versions: (await this.docs.versions(id)).map(versionToApi) };
  }
}
