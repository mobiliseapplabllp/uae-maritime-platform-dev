import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { type PageQuery } from '@maritime/contracts';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, escapeLike, paged, parsePage, zod, type Principal } from '@maritime/service-kit';
import type { Env } from './env';
import { instrumentApi, type InstrumentRow } from './instruments';
import { recordAcknowledgement } from './legislation.controller';
import { acksOf, fullInstrument } from './read';
import { maySeeAcknowledgements } from './scope';

/* The notice board, as the people the notices are addressed to see it.
 *
 * The register (under /legislation) is the librarian's view: everything, in every status. This is the
 * reader's view: what is in force, and what this particular person still owes a receipt on. The
 * outstanding list is the recipient class of each instrument minus the receipts already recorded, so
 * a circular addressed to one department never appears on anybody else's desk. */

const ackBody = z.object({ note: z.string().trim().max(400).default('') });
const BOARD_TYPES = ['CIRCULAR', 'NOTICE', 'ORDER'];

@Controller('notices')
export class NoticesController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  /** What is in force and addressed to the desk: circulars, notices and orders, newest first. */
  @RequirePerm('legislation.view') @Get()
  async board(@Query() query: PageQuery & { type?: string; ackRequired?: string }, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: '-issuedDate', sortable: ['issuedDate', 'refNo', 'title', 'type'], maxLimit: 200 });
    const where = ["status = 'IN_FORCE'", '(expiry_date IS NULL OR expiry_date > now())']; const args: unknown[] = [];
    if (query.type) { args.push(query.type); where.push(`type = $${args.length}`); } else { args.push(BOARD_TYPES); where.push(`type = ANY($${args.length})`); }
    if (query.ackRequired !== undefined && query.ackRequired !== '') { args.push(String(query.ackRequired) === 'true'); where.push(`ack_required = $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(ref_no ILIKE $${args.length} OR title ILIKE $${args.length} OR summary ILIKE $${args.length})`); }
    const w = `WHERE ${where.join(' AND ')}`;
    const sort = p.sortField === 'refNo' ? 'ref_no' : p.sortField === 'issuedDate' ? 'issued_date' : p.sortField;
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM legal_instruments ${w}`, args);
    const rows = await this.pool.query<InstrumentRow>(`SELECT * FROM legal_instruments ${w} ORDER BY ${sort} ${p.sortDir}, ref_no LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    // the board is published; the roll of who has read each notice is not
    const acks = maySeeAcknowledgements(user.scope) ? await acksOf(this.pool, rows.rows.map((r) => r.id)) : new Map();
    return paged(rows.rows.map((r) => instrumentApi(r, { acknowledgedBy: acks.get(r.id) ?? [] })), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  /* Everything in force that requires this person's acknowledgement and has not had it: the recipient
   * class is matched against the local staff roll, so a person outside the class is never asked. A
   * person the roll has not heard of yet sees the instruments addressed to everybody. */
  @RequirePerm('legislation.view') @Get('pending')
  async pending(@CurrentUser() user?: Principal) {
    const r = await this.pool.query<{ id: string; ref_no: string; title: string; title_ar: string | null; type: string; category: string; issued_date: Date; effective_date: Date | null; ack_due_days: number | null }>(
      `SELECT i.id, i.ref_no, i.title, i.title_ar, i.type, i.category, i.issued_date, i.effective_date, i.ack_due_days
         FROM legal_instruments i
        WHERE i.status = 'IN_FORCE' AND i.ack_required
          AND (i.expiry_date IS NULL OR i.expiry_date > now())
          AND NOT EXISTS (SELECT 1 FROM instrument_acknowledgements a WHERE a.instrument_id = i.id AND a.user_id = $1)
          AND (i.ack_class = 'ALL_STAFF'
               OR EXISTS (SELECT 1 FROM users u WHERE u.id = $1 AND u.active
                            AND ((i.ack_class = 'ROLE' AND lower(u.role_name) = lower(i.ack_class_value))
                              OR (i.ack_class = 'DEPARTMENT' AND lower(u.department) = lower(i.ack_class_value)))))
        ORDER BY i.issued_date DESC`,
      [user?.id ?? '']);
    const due = (row: { effective_date: Date | null; issued_date: Date; ack_due_days: number | null }) =>
      new Date(new Date(row.effective_date ?? row.issued_date).getTime() + (row.ack_due_days ?? this.env.ACK_DUE_DAYS) * 86_400_000).toISOString();
    return r.rows.map((x) => ({
      id: x.id, refNo: x.ref_no, title: x.title, titleAr: x.title_ar, type: x.type, category: x.category,
      issuedDate: x.issued_date.toISOString(), effectiveDate: x.effective_date ? x.effective_date.toISOString() : null,
      dueBy: due(x), overdue: new Date(due(x)).getTime() < Date.now(),
    }));
  }

  /** Record this person's receipt. Idempotent: a second receipt changes nothing and is not an error. */
  @RequirePerm('legislation.view') @Post(':id/acknowledge')
  async acknowledge(@Param('id') id: string, @Body(zod(ackBody)) b: z.infer<typeof ackBody>, @CurrentUser() user?: Principal) {
    return recordAcknowledgement(this.pool, this.env, this.audit, id, b.note, user, (c, row) => fullInstrument(c, row));
  }
}
