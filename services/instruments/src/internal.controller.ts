import { Body, Controller, Get, Inject, Param, Post } from '@nestjs/common';
import type { Pool } from 'pg';
import { EVENTS, SUBJECT_KINDS, type SubjectKind } from '@maritime/contracts';
import { KIT_ENV, KIT_POOL, AuditClient, ServiceOnly, badRequest, notFound, withTx } from '@maritime/service-kit';
import type { Env } from './env';
import { SigningService } from './signing';
import { detail, findLicence, publishState } from './licences';
import { checksFor, resolveSubject } from './subjects';
import { issueFromApplication, type ApplicationIssue } from './consumer';

/** Service-to-service surface: the workflow engine may issue synchronously instead of by event, and any service may ask what an instrument or a subject's checks look like. */
@ServiceOnly() @Controller('internal')
export class InternalController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient, private readonly signing: SigningService) {}
  @Get('instruments/:idOrNo')
  async get(@Param('idOrNo') idOrNo: string) { const row = await findLicence(this.pool, idOrNo); if (!row) throw notFound('Instrument not found'); return detail(row, this.signing, this.pool); }
  @Post('instruments/issue')
  async issue(@Body() body: ApplicationIssue) {
    if (!body || typeof body !== 'object' || !body.instrumentType) throw badRequest('instrumentType is required');
    return withTx(this.pool, async (c) => {
      const { row, created } = await issueFromApplication(c, { env: this.env, signing: this.signing, audit: this.audit }, body);
      if (created) await publishState(c, this.env, row, { event: EVENTS.instruments.issued, data: { by: body.issuedBy ?? null } });
      return detail(row, this.signing, c);
    });
  }
  @Get('subjects/:kind/:id/checks')
  async checks(@Param('kind') kindRaw: string, @Param('id') id: string) {
    const kind = kindRaw.toUpperCase() as SubjectKind; if (!SUBJECT_KINDS.includes(kind)) throw badRequest('Unknown subject kind');
    const subject = await resolveSubject(this.pool, kind, id); const checks = checksFor(kind, subject, new Date());
    return { subjectKind: kind, subjectId: id, subjectLinked: !!subject, label: subject?.label ?? null, checks, blocking: checks.filter((x) => x.blocking && !x.passed).length };
  }
}
