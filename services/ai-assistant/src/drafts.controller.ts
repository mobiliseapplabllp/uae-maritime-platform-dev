import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { PageQuery } from '@maritime/contracts';
import {
  AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, escapeLike, forbidden, notFound, paged, parsePage, withTx, zod, type Principal,
} from '@maritime/service-kit';
import type { Env } from './env';
import { COMPLETION_CLIENT, type CompletionClient } from './completion';
import { DRAFT_KINDS, DRAFT_PERMISSION, draftApi, mayPrepare, prepareDraft, publishDraft, type DraftKind, type DraftRecord } from './drafts';

/* Drafting a notice, a decision letter or an inspection summary from the platform's own record.
 *
 * Preparing a draft is gated on the permission that governs the thing being drafted, not on the assistant: an
 * officer who may not assess an application may not have a decision letter written for them either. What comes
 * back is a draft — unsigned, unnumbered, with its citations attached — for a human to take or discard. */

const prepareBody = z.object({
  kind: z.enum(DRAFT_KINDS),
  subjectId: z.string().trim().min(1).max(200),
  language: z.enum(['en', 'ar']).default('en'),
  note: z.string().trim().max(2000).optional(),
});
const SORT: Record<string, string> = { createdAt: 'created_at', kind: 'kind', title: 'title' };

@Controller('ai/drafts')
export class DraftsController {
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    @Inject(COMPLETION_CLIENT) private readonly completion: CompletionClient,
    private readonly audit: AuditClient,
  ) {}

  /** The kinds that can be drafted and the permission each one sits behind. */
  @RequirePerm('ai.use') @Get('kinds')
  kinds(@CurrentUser() user: Principal) {
    return DRAFT_KINDS.map((kind) => ({ kind, permission: DRAFT_PERMISSION[kind], available: mayPrepare(kind, user.perms) }));
  }

  @RequirePerm('ai.use') @Get()
  async list(@Query() query: PageQuery & { kind?: string; subjectId?: string }, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: '-createdAt', sortable: Object.keys(SORT), maxLimit: 200 });
    const args: unknown[] = []; const where: string[] = [];
    // a draft is only listed to a reader who could have had it prepared
    const kinds = DRAFT_KINDS.filter((k) => mayPrepare(k, user.perms));
    if (!kinds.length) return paged([], { page: p.page, limit: p.limit, total: 0 });
    args.push(kinds); where.push(`kind = ANY($${args.length})`);
    if (query.kind) { args.push(query.kind); where.push(`kind = $${args.length}`); }
    if (query.subjectId) { args.push(query.subjectId); where.push(`subject_id = $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(title ILIKE $${args.length} OR subject_label ILIKE $${args.length})`); }
    const sql = `WHERE ${where.join(' AND ')}`;
    const total = Number((await this.pool.query<{ n: string }>(`SELECT count(*)::int AS n FROM drafts ${sql}`, args)).rows[0].n);
    const rows = (await this.pool.query<DraftRecord>(
      `SELECT * FROM drafts ${sql} ORDER BY ${SORT[p.sortField] ?? 'created_at'} ${p.sortDir === 'asc' ? 'ASC' : 'DESC'} LIMIT ${p.limit} OFFSET ${p.offset}`, args)).rows;
    return paged(rows.map(draftApi), { page: p.page, limit: p.limit, total });
  }

  @RequirePerm('ai.use') @Get(':id')
  async get(@Param('id') id: string, @CurrentUser() user: Principal) {
    const r = await this.pool.query<DraftRecord>('SELECT * FROM drafts WHERE id::text = $1', [id]);
    if (!r.rows[0]) throw notFound('Draft not found');
    if (!mayPrepare(r.rows[0].kind as DraftKind, user.perms)) throw forbidden(`Reading this draft needs the ${DRAFT_PERMISSION[r.rows[0].kind as DraftKind]} permission`);
    return draftApi(r.rows[0]);
  }

  /** Prepares the draft from records the caller is entitled to have drafted from, and publishes it as prepared. */
  @RequirePerm('ai.use') @Post()
  async prepare(@Body(zod(prepareBody)) body: z.infer<typeof prepareBody>, @CurrentUser() user: Principal) {
    if (!mayPrepare(body.kind, user.perms)) throw forbidden(`Preparing a ${body.kind.toLowerCase().replace(/_/g, ' ')} needs the ${DRAFT_PERMISSION[body.kind]} permission`);
    const prepared = await prepareDraft(this.pool, body, user.name);
    if (!prepared) throw notFound('No record on the platform matches that subject, so there is nothing to draft from');
    return withTx(this.pool, async (c) => {
      const r = await c.query<DraftRecord>(
        `INSERT INTO drafts(kind, subject_type, subject_id, subject_label, title, body, citations, facts, language, status, engine, prepared_by_id, prepared_by)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'DRAFT',$10,$11,$12) RETURNING *`,
        [body.kind, prepared.subjectType, body.subjectId, prepared.subjectLabel, prepared.title, prepared.body,
          JSON.stringify(prepared.citations), JSON.stringify(prepared.facts), body.language, this.completion.profile, user.id, user.name]);
      const entity = await publishDraft(c, this.env, r.rows[0], { actor: { id: user.id, name: user.name, kind: 'user' } });
      await this.audit.record(c, {
        action: 'AI_DRAFT_PREPARED', entity: 'AiDraft', entityId: r.rows[0].id, entityLabel: entity.title,
        after: { kind: entity.kind, subject: entity.subjectLabel, citations: entity.citations.length },
        note: 'Draft prepared from the platform record; not issued',
      });
      return entity;
    });
  }
}
