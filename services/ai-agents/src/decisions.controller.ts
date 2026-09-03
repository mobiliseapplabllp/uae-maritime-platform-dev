import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { PageQuery } from '@maritime/contracts';
import {
  AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, badRequest, conflict, escapeLike, notFound, paged, parsePage, withTx, zod, type Principal,
} from '@maritime/service-kit';
import type { Env } from './env';
import { DISPOSITIONS, PENDING_DISPOSITIONS, REVIEW_STATUSES } from './autonomy';
import { decisionApi, isOpenForReview, reviewDecision, type DecisionRecord } from './decisions';
import type { Row } from './registry';

/* The decision register and the human queue that hangs off it.
 *
 * Every conclusion an agent reached is here, filterable by the things an officer actually asks: which agent, what
 * it decided, whether anyone has looked at it, which record it concerns and why it was escalated. The queue is
 * the same register filtered to what is still waiting, ordered oldest first, because the point of an escalation
 * queue is that nothing sits in it unseen. */

const text = (max: number) => z.string().trim().max(max);
const reviewBody = z.object({ accept: z.boolean(), reason: text(2000).default('') });

const SORT: Record<string, string> = { at: 'at', confidence: 'confidence', agentId: 'agent_id', disposition: 'disposition', action: 'action', reviewStatus: 'review_status' };
type ListQuery = PageQuery & {
  agentId?: string; disposition?: string; reviewStatus?: string; action?: string; entityType?: string; entityId?: string;
  escalationCode?: string; effect?: string; pending?: string; applied?: string; from?: string; to?: string;
  minConfidence?: string; maxConfidence?: string; includeSuperseding?: string;
};

@Controller('agents/decisions')
export class DecisionsController {
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    private readonly audit: AuditClient,
  ) {}

  private where(query: ListQuery, p: { q: string }) {
    const where: string[] = []; const args: unknown[] = [];
    /* A reviewer's verdict is a row of its own. The register shows the agents' own conclusions by default, so a
     * decision is not counted twice, and the verdicts are available on request. */
    if (String(query.includeSuperseding) !== 'true') where.push('supersedes_id IS NULL');
    const eq = (col: string, v: string | undefined) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
    eq('agent_id', query.agentId); eq('disposition', query.disposition); eq('review_status', query.reviewStatus);
    eq('entity_type', query.entityType); eq('entity_id', query.entityId); eq('escalation_code', query.escalationCode); eq('effect', query.effect);
    if (query.action) { args.push(`%${escapeLike(query.action)}%`); where.push(`action ILIKE $${args.length}`); }
    if (String(query.pending) === 'true') { args.push(PENDING_DISPOSITIONS); where.push(`disposition = ANY($${args.length}) AND review_status = 'PENDING'`); }
    if (query.applied !== undefined && query.applied !== '') { args.push(String(query.applied) === 'true'); where.push(`applied = $${args.length}`); }
    if (query.from) { args.push(query.from); where.push(`at >= $${args.length}`); }
    if (query.to) { args.push(query.to); where.push(`at <= $${args.length}`); }
    if (query.minConfidence) { args.push(Number(query.minConfidence)); where.push(`confidence >= $${args.length}`); }
    if (query.maxConfidence) { args.push(Number(query.maxConfidence)); where.push(`confidence <= $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(action ILIKE $${args.length} OR entity_label ILIKE $${args.length} OR agent_name ILIKE $${args.length} OR explanation ILIKE $${args.length})`); }
    return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', args };
  }

  /** The register: paged, filtered and searchable. */
  @RequirePerm('agents.view') @Get()
  async list(@Query() query: ListQuery) {
    const p = parsePage(query, { defaultSort: '-at', sortable: Object.keys(SORT), maxLimit: 500 });
    const { sql, args } = this.where(query, p);
    const total = Number((await this.pool.query<{ n: string }>(`SELECT count(*)::int AS n FROM decisions ${sql}`, args)).rows[0].n);
    const rows = (await this.pool.query<DecisionRecord>(
      `SELECT * FROM decisions ${sql} ORDER BY ${SORT[p.sortField] ?? 'at'} ${p.sortDir === 'asc' ? 'ASC' : 'DESC'}, id LIMIT ${p.limit} OFFSET ${p.offset}`, args)).rows;
    return paged(rows.map(decisionApi), { page: p.page, limit: p.limit, total });
  }

  /**
   * The escalation queue: everything the ladder refused to let an agent do on its own and nobody has closed yet,
   * oldest first, with a breakdown of why each one is here.
   */
  @RequirePerm('agents.view') @Get('escalations')
  async escalations(@Query() query: ListQuery) {
    const p = parsePage(query, { defaultSort: 'at', sortable: Object.keys(SORT), maxLimit: 500 });
    const args: unknown[] = [PENDING_DISPOSITIONS];
    const where = [`supersedes_id IS NULL`, `disposition = ANY($1)`, `review_status = 'PENDING'`];
    if (query.agentId) { args.push(query.agentId); where.push(`agent_id = $${args.length}`); }
    if (query.escalationCode) { args.push(query.escalationCode); where.push(`escalation_code = $${args.length}`); }
    if (query.effect) { args.push(query.effect); where.push(`effect = $${args.length}`); }
    const sql = `WHERE ${where.join(' AND ')}`;
    const total = Number((await this.pool.query<{ n: string }>(`SELECT count(*)::int AS n FROM decisions ${sql}`, args)).rows[0].n);
    const rows = (await this.pool.query<DecisionRecord>(
      `SELECT * FROM decisions ${sql} ORDER BY ${SORT[p.sortField] ?? 'at'} ${p.sortDir === 'asc' ? 'ASC' : 'DESC'}, id LIMIT ${p.limit} OFFSET ${p.offset}`, args)).rows;
    const byCode = (await this.pool.query<Row>(
      `SELECT escalation_code, count(*)::int AS n FROM decisions ${sql} GROUP BY escalation_code ORDER BY n DESC`, args)).rows;
    const byAgent = (await this.pool.query<Row>(
      `SELECT agent_id, agent_name, count(*)::int AS n, min(at) AS oldest FROM decisions ${sql} GROUP BY agent_id, agent_name ORDER BY n DESC`, args)).rows;
    return {
      success: true, data: rows.map(decisionApi),
      meta: {
        page: p.page, limit: p.limit, total,
        byCode: byCode.map((r) => ({ code: r.escalation_code || 'NONE', decisions: r.n })),
        byAgent: byAgent.map((r) => ({ agentId: r.agent_id, name: r.agent_name, decisions: r.n, oldest: r.oldest ? new Date(r.oldest).toISOString() : null })),
        oldest: rows.length ? decisionApi(rows[0]).at : null,
      },
    };
  }

  /** The reference lists the console filters by, so the two can never drift apart. */
  @RequirePerm('agents.view') @Get('meta')
  meta() {
    return { dispositions: DISPOSITIONS, reviewStatuses: REVIEW_STATUSES, pending: PENDING_DISPOSITIONS };
  }

  /** One decision with the weighted factors behind it, and the verdict a human recorded on it. */
  @RequirePerm('agents.view') @Get(':id')
  async get(@Param('id') id: string) {
    const r = await this.pool.query<DecisionRecord>('SELECT * FROM decisions WHERE id::text = $1', [id]);
    if (!r.rows[0]) throw notFound('Decision not found');
    const d = r.rows[0];
    const [superseding, superseded] = await Promise.all([
      this.pool.query<DecisionRecord>('SELECT * FROM decisions WHERE supersedes_id = $1 ORDER BY at', [d.id]),
      d.supersedes_id ? this.pool.query<DecisionRecord>('SELECT * FROM decisions WHERE id = $1', [d.supersedes_id]) : Promise.resolve({ rows: [] as DecisionRecord[] }),
    ]);
    return {
      ...decisionApi(d),
      /* The factor weights are what makes the record explainable: a reviewer sees which inputs carried the
       * conclusion and how far, not only what the conclusion was. */
      factorTotal: (d.factors ?? []).reduce((s: number, f: Row) => s + (Number(f.contribution) || 0), 0),
      review: superseding.rows[0] ? decisionApi(superseding.rows[0]) : null,
      supersedes: superseded.rows[0] ? decisionApi(superseded.rows[0]) : null,
      openForReview: isOpenForReview(d),
    };
  }

  /**
   * A human accepts or overturns a decision. Overturning without a reason is refused; the original row is left
   * exactly as the agent wrote it and the verdict is recorded as a superseding row.
   */
  @RequirePerm('agents.review') @Post(':id/review')
  async review(@Param('id') id: string, @Body(zod(reviewBody)) body: z.infer<typeof reviewBody>, @CurrentUser() user: Principal) {
    const reason = body.reason.trim();
    if (!body.accept && !reason) throw badRequest('Overturning a decision requires a reason');
    return withTx(this.pool, async (c) => {
      const r = await c.query<DecisionRecord>('SELECT * FROM decisions WHERE id::text = $1 FOR UPDATE', [id]);
      const original = r.rows[0];
      if (!original) throw notFound('Decision not found');
      if (original.supersedes_id) throw conflict('This row records a review outcome and cannot itself be reviewed');
      if (!isOpenForReview(original)) throw conflict('This decision has already been reviewed');
      const entity = await reviewDecision(c, this.env, original, { accept: body.accept, reason, reviewer: { id: user.id, name: user.name } }, {
        actor: { id: user.id, name: user.name, kind: 'user' },
      });
      await this.audit.record(c, {
        action: body.accept ? 'AI_DECISION_ACCEPTED' : 'AI_DECISION_OVERRIDDEN', entity: 'AiDecision', entityId: original.id,
        entityLabel: `${original.agent_name}: ${original.action}${body.accept ? '' : ` — ${reason}`}`,
        before: decisionApi(original), after: entity, note: reason || 'Accepted on review',
      });
      return entity;
    });
  }
}
