import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, INSTRUMENT_STATUS, INSTRUMENT_TRANSITIONS, INSTRUMENT_TYPES, type PageQuery } from '@maritime/contracts';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, badRequest, conflict, escapeLike, notFound, paged, parsePage, withTx, zod, type Principal } from '@maritime/service-kit';
import type { Env } from './env';
import {
  ACK_CLASSES, LINK_KINDS, allocateRefNo, ackApi, canApprove, canAcknowledge, canSupersede, canTransition, instrumentApi,
  publishInstrument, publishInstrumentDeleted, registerDashboard,
  type AckRow, type Attachment, type DashboardRow, type InstrumentRow, type LinkRow, type Row,
} from './instruments';
import { acksOf, fullInstrument, loadInstrument, recipientCounts, recipientsIn, recipientsOf, type Q } from './read';

/* Notices and circulars — the legal-instrument register.
 *
 * Status is not an ordinary field here. Moving it goes through the lifecycle table, moving it to in
 * force goes through approval (which compares the approver against the drafter), superseding needs a
 * successor to point at, and withdrawing needs a reason. Everything else — the text, the subject and
 * keyword classification, the effective and expiry dates, the attachments and the reference links —
 * is ordinary editing, and is refused once the instrument is final. */

const text = (max: number) => z.string().trim().max(max);
const dateish = z.union([z.string().trim(), z.null()]).optional();
const body = z.object({
  refNo: text(60).optional(), title: text(400).min(3), titleAr: text(400).nullish(),
  type: z.enum(INSTRUMENT_TYPES), category: text(120).default('General'), status: z.enum(INSTRUMENT_STATUS).optional(),
  issuedBy: text(160).default(''), issuedDate: dateish, effectiveDate: dateish, expiryDate: dateish,
  summary: text(2000).default(''), body: text(60_000).default(''), tags: z.array(text(60)).max(30).default([]),
  supersedes: text(60).default(''), ackRequired: z.coerce.boolean().default(false),
  ackClass: z.enum(ACK_CLASSES).default('ALL_STAFF'), ackClassValue: text(120).default(''), ackDueDays: z.coerce.number().int().min(1).max(365).nullish(),
  sourceNote: text(600).default(''), withdrawalReason: text(600).optional(),
});
const patch = body.partial();
const noteBody = z.object({ note: text(1000).default('') });
const publishBody = z.object({ effectiveDate: dateish, note: text(1000).default('') });
const withdrawBody = z.object({ reason: text(600).min(3), at: dateish });
const supersedeBody = z.object({ successorId: text(80).optional(), successorRef: text(60).optional(), note: text(1000).default('') })
  .refine((b) => !!(b.successorId || b.successorRef), { message: 'A successor instrument is required' });
const ackBody = z.object({ note: text(400).default('') });
const linkBody = z.object({ kind: z.enum(LINK_KINDS), targetId: text(80).optional(), targetRef: text(60).optional(), note: text(600).default('') })
  .refine((b) => !!(b.targetId || b.targetRef), { message: 'A target instrument is required' });
const attachmentBody = z.object({ name: text(200).min(1), kind: text(60).default('DOCUMENT'), documentId: text(80).nullish(), url: text(600).nullish(), sizeBytes: z.coerce.number().int().min(0).nullish() });

const SORT: Record<string, string> = {
  refNo: 'ref_no', title: 'title', type: 'type', category: 'category', status: 'status',
  issuedDate: 'issued_date', effectiveDate: 'effective_date', expiryDate: 'expiry_date', createdAt: 'created_at', updatedAt: 'updated_at',
};
const FINAL = ['SUPERSEDED', 'WITHDRAWN'];
const at = (v: string | null | undefined) => (v == null || v === '' ? null : new Date(v));

@Controller('legislation')
export class LegislationController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  private load(c: Q, id: string, lock = false) { return loadInstrument(c, id, lock); }
  private full(c: Q, row: InstrumentRow) { return fullInstrument(c, row); }
  private async republish(c: PoolClient, row: InstrumentRow, event: string, data: Row = {}) {
    const acks = (await acksOf(c, [row.id])).get(row.id) ?? [];
    return publishInstrument(c, this.env, row, { acknowledgedBy: acks }, { event, data });
  }

  /* -------------------------------------------------------------------------- register --- */

  @RequirePerm('legislation.view') @Get('instruments')
  async list(@Query() query: PageQuery & { type?: string; status?: string; year?: string; subject?: string; category?: string; tag?: string; ackRequired?: string; issuedBy?: string }) {
    const p = parsePage(query, { defaultSort: '-issuedDate', sortable: Object.keys(SORT), maxLimit: 1000 });
    const where: string[] = []; const args: unknown[] = [];
    const add = (sql: (i: number) => string, value: unknown) => { args.push(value); where.push(sql(args.length)); };
    if (query.type) add((i) => `type = $${i}`, query.type);
    if (query.status) add((i) => `status = $${i}`, query.status);
    if (query.year) add((i) => `date_part('year', issued_date) = $${i}`, Number(query.year));
    const subject = query.subject ?? query.category;
    if (subject) add((i) => `lower(category) = lower($${i})`, subject);
    if (query.issuedBy) add((i) => `lower(issued_by) = lower($${i})`, query.issuedBy);
    if (query.tag) add((i) => `tags ? $${i}`, query.tag);
    if (query.ackRequired !== undefined && query.ackRequired !== '') add((i) => `ack_required = $${i}`, String(query.ackRequired) === 'true');
    if (p.q) add((i) => `(ref_no ILIKE $${i} OR title ILIKE $${i} OR coalesce(title_ar,'') ILIKE $${i} OR summary ILIKE $${i} OR body ILIKE $${i} OR category ILIKE $${i} OR tags::text ILIKE $${i})`, `%${escapeLike(p.q)}%`);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM legal_instruments ${w}`, args);
    const rows = await this.pool.query<InstrumentRow>(`SELECT * FROM legal_instruments ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir} NULLS LAST, ref_no LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    const acks = await acksOf(this.pool, rows.rows.map((r) => r.id));
    return paged(rows.rows.map((r) => instrumentApi(r, { acknowledgedBy: acks.get(r.id) ?? [] })), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  /** The subjects, keywords and issuing authorities the register actually holds, for the search filters. */
  @RequirePerm('legislation.view') @Get('meta')
  async meta() {
    const cats = await this.pool.query<{ category: string; n: string }>('SELECT category, count(*) AS n FROM legal_instruments GROUP BY category ORDER BY count(*) DESC, category');
    const issuers = await this.pool.query<{ issued_by: string; n: string }>("SELECT issued_by, count(*) AS n FROM legal_instruments WHERE issued_by <> '' GROUP BY issued_by ORDER BY count(*) DESC, issued_by");
    const tags = await this.pool.query<{ tag: string; n: string }>('SELECT jsonb_array_elements_text(tags) AS tag, count(*) AS n FROM legal_instruments GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT 60');
    const years = await this.pool.query<{ year: string; n: string }>("SELECT date_part('year', issued_date)::int::text AS year, count(*) AS n FROM legal_instruments GROUP BY 1 ORDER BY 1 DESC");
    return {
      types: [...INSTRUMENT_TYPES], statuses: [...INSTRUMENT_STATUS], transitions: INSTRUMENT_TRANSITIONS, linkKinds: [...LINK_KINDS], ackClasses: [...ACK_CLASSES],
      subjects: cats.rows.map((r) => ({ subject: r.category, count: Number(r.n) })),
      issuers: issuers.rows.map((r) => ({ issuedBy: r.issued_by, count: Number(r.n) })),
      keywords: tags.rows.map((r) => ({ tag: r.tag, count: Number(r.n) })),
      years: years.rows.map((r) => ({ year: Number(r.year), count: Number(r.n) })),
    };
  }

  /** The register dashboard: the shape of the library, where the drafts stand and what is still owed. */
  @RequirePerm('legislation.view', 'dashboard.view') @Get('dashboard')
  async dashboard() {
    const counts = await recipientCounts(this.pool);
    const r = await this.pool.query<DashboardRow & { ack_class: string; ack_class_value: string }>(
      `SELECT i.id, i.ref_no, i.title, i.type, i.category, i.status, i.issued_date, i.effective_date, i.expiry_date, i.ack_required,
              i.ack_class, i.ack_class_value, i.reviewed_at, i.cleared_at, i.drafted_by,
              (SELECT count(*) FROM instrument_acknowledgements a WHERE a.instrument_id = i.id) AS acks, 0 AS recipients
         FROM legal_instruments i`);
    const rows = r.rows.map((x) => ({ ...x, acks: Number(x.acks), recipients: x.ack_required ? recipientsIn(counts, x.ack_class, x.ack_class_value) : 0 }));
    return { ...registerDashboard(rows, new Date(), this.env.HORIZON_DAYS), roll: counts.all, generatedAt: new Date().toISOString() };
  }

  @RequirePerm('legislation.view') @Get('instruments/:id')
  async get(@Param('id') id: string) { return this.full(this.pool, await this.load(this.pool, id)); }

  @RequirePerm('legislation.view') @Get('instruments/:id/acknowledgements')
  async acknowledgements(@Param('id') id: string) {
    const row = await this.load(this.pool, id);
    const acknowledged = (await acksOf(this.pool, [row.id])).get(row.id) ?? [];
    const done = new Set(acknowledged.map((a) => a.userId));
    const recipients = row.ack_required ? await recipientsOf(this.pool, row.ack_class, row.ack_class_value) : [];
    const outstanding = recipients.filter((p) => !done.has(p.id));
    const dueDays = row.ack_due_days ?? this.env.ACK_DUE_DAYS;
    const from = row.effective_date ?? row.issued_date;
    return {
      instrumentId: row.id, refNo: row.ref_no, title: row.title, status: row.status, ackRequired: row.ack_required,
      ackClass: row.ack_class, ackClassValue: row.ack_class_value, dueBy: row.ack_required ? new Date(new Date(from).getTime() + dueDays * 86_400_000).toISOString() : null,
      recipients: recipients.length, acknowledged: acknowledged.length, outstandingCount: outstanding.length,
      compliancePct: recipients.length ? Math.round((recipients.filter((p) => done.has(p.id)).length / recipients.length) * 100) : 100,
      acknowledgedBy: acknowledged, outstanding,
    };
  }

  /* ---------------------------------------------------------------------------- drafting --- */

  /* Drafting records who drafted, because approval later has to compare against it. A new instrument
   * starts as a draft unless it is being recorded as an existing one — an authority migrating its
   * library is not "drafting" a convention from 1974. */
  @RequirePerm('legislation.manage') @Post('instruments')
  async create(@Body(zod(body)) b: z.infer<typeof body>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const issued = at(b.issuedDate ?? null) ?? new Date();
      const refNo = b.refNo?.trim() || await allocateRefNo(c, b.type, issued.getUTCFullYear(), this.env.REF_PAD);
      const dupe = await c.query('SELECT id FROM legal_instruments WHERE upper(ref_no) = upper($1)', [refNo]);
      if (dupe.rowCount) throw conflict(`An instrument with reference ${refNo} is already on the register`);
      const status = b.status ?? 'DRAFT';
      const r = await c.query<InstrumentRow>(
        `INSERT INTO legal_instruments(ref_no, title, title_ar, type, category, status, issued_by, issued_date, effective_date, expiry_date, summary, body, tags,
           supersedes, ack_required, ack_class, ack_class_value, ack_due_days, drafted_by_id, drafted_by, source_note,
           approved_by_id, approved_by, approved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING *`,
        [refNo, b.title, b.titleAr ?? null, b.type, b.category, status, b.issuedBy, issued, at(b.effectiveDate ?? null), at(b.expiryDate ?? null), b.summary, b.body, JSON.stringify(b.tags),
          b.supersedes, b.ackRequired, b.ackClass, b.ackClassValue, b.ackDueDays ?? null, user?.id ?? null, user?.name ?? '', b.sourceNote,
          status === 'DRAFT' ? null : user?.id ?? null, status === 'DRAFT' ? '' : user?.name ?? '', status === 'DRAFT' ? null : new Date()]);
      const row = r.rows[0];
      await this.audit.record(c, { action: 'CREATE', entity: 'LegalInstrument', entityId: row.id, entityLabel: row.ref_no, after: instrumentApi(row) });
      return this.republish(c, row, EVENTS.legislation.instrumentDrafted, { draftedBy: row.drafted_by });
    });
  }

  /* Status is not an ordinary field. Moving it goes through the lifecycle rules; moving it to in force
   * goes through approval and moving it to superseded needs a successor, so neither happens here. */
  @RequirePerm('legislation.manage') @Put('instruments/:id')
  async update(@Param('id') id: string, @Body(zod(patch)) b: Partial<z.infer<typeof body>>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await this.load(c, id, true);
      if (FINAL.includes(before.status)) throw conflict(`A ${before.status.toLowerCase()} instrument is a closed record and cannot be edited`);
      const next = b.status && b.status !== before.status ? b.status : null;
      if (next === 'IN_FORCE') throw conflict('An instrument is put in force by approval, not by editing its status');
      if (next === 'SUPERSEDED') throw conflict('An instrument is superseded by naming the instrument that replaces it');
      if (next) {
        const move = canTransition(before.status, next);
        if (!move.ok) throw conflict(move.error);
        if (next === 'WITHDRAWN' && !(b.withdrawalReason ?? '').trim()) throw badRequest('A withdrawal must record a reason');
      }
      if (b.refNo && b.refNo.toUpperCase() !== before.ref_no.toUpperCase()) {
        const dupe = await c.query('SELECT id FROM legal_instruments WHERE upper(ref_no) = upper($1) AND id <> $2', [b.refNo, before.id]);
        if (dupe.rowCount) throw conflict(`An instrument with reference ${b.refNo} is already on the register`);
      }
      const keep = <T,>(v: T | undefined, cur: T) => (v === undefined ? cur : v);
      const r = await c.query<InstrumentRow>(
        `UPDATE legal_instruments SET ref_no=$2, title=$3, title_ar=$4, type=$5, category=$6, status=$7, issued_by=$8, issued_date=$9, effective_date=$10, expiry_date=$11,
           summary=$12, body=$13, tags=$14, supersedes=$15, ack_required=$16, ack_class=$17, ack_class_value=$18, ack_due_days=$19, source_note=$20,
           withdrawn_by_id=$21, withdrawn_by=$22, withdrawn_at=$23, withdrawal_reason=$24, updated_at=now() WHERE id=$1 RETURNING *`,
        [before.id, b.refNo?.trim() || before.ref_no, keep(b.title, before.title), b.titleAr === undefined ? before.title_ar : b.titleAr, keep(b.type, before.type), keep(b.category, before.category),
          next ?? before.status, keep(b.issuedBy, before.issued_by), b.issuedDate === undefined ? before.issued_date : at(b.issuedDate), b.effectiveDate === undefined ? before.effective_date : at(b.effectiveDate),
          b.expiryDate === undefined ? before.expiry_date : at(b.expiryDate), keep(b.summary, before.summary), keep(b.body, before.body), JSON.stringify(b.tags ?? before.tags ?? []),
          keep(b.supersedes, before.supersedes), keep(b.ackRequired, before.ack_required), keep(b.ackClass, before.ack_class), keep(b.ackClassValue, before.ack_class_value),
          b.ackDueDays === undefined ? before.ack_due_days : b.ackDueDays, keep(b.sourceNote, before.source_note),
          next === 'WITHDRAWN' ? user?.id ?? null : before.withdrawn_by_id, next === 'WITHDRAWN' ? user?.name ?? '' : before.withdrawn_by,
          next === 'WITHDRAWN' ? new Date() : before.withdrawn_at, next === 'WITHDRAWN' ? (b.withdrawalReason ?? '').trim() : before.withdrawal_reason]);
      const row = r.rows[0];
      await this.audit.record(c, { action: next ? 'TRANSITION' : 'UPDATE', entity: 'LegalInstrument', entityId: row.id, entityLabel: row.ref_no, before: instrumentApi(before), after: instrumentApi(row) });
      return this.republish(c, row, next === 'WITHDRAWN' ? EVENTS.legislation.instrumentWithdrawn : EVENTS.legislation.instrumentUpdated, next === 'WITHDRAWN' ? { reason: row.withdrawal_reason } : {});
    });
  }

  /** Only a draft can be deleted; anything that has been in force is a record of what the law was. */
  @RequirePerm('legislation.manage') @Delete('instruments/:id')
  async remove(@Param('id') id: string) {
    return withTx(this.pool, async (c) => {
      const row = await this.load(c, id, true);
      if (row.status !== 'DRAFT') throw conflict(`${row.ref_no} has been in force and cannot be deleted — withdraw it instead`);
      await this.audit.record(c, { action: 'DELETE', entity: 'LegalInstrument', entityId: row.id, entityLabel: row.ref_no, before: instrumentApi(row) });
      await c.query('DELETE FROM legal_instruments WHERE id = $1', [row.id]);
      await publishInstrumentDeleted(c, this.env, row);
      return { deleted: true, id: row.id };
    });
  }

  /* -------------------------------------------------------------------------- governance --- */

  /** Review: a second pair of eyes on a draft, recorded on the instrument rather than as a status of its own. */
  @RequirePerm('legislation.manage', 'legislation.approve') @Post('instruments/:id/review')
  async review(@Param('id') id: string, @Body(zod(noteBody)) b: z.infer<typeof noteBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await this.load(c, id, true);
      if (before.status !== 'DRAFT') throw conflict('Only a draft is reviewed; this instrument has already left drafting');
      const r = await c.query<InstrumentRow>('UPDATE legal_instruments SET reviewed_by_id=$2, reviewed_by=$3, reviewed_at=now(), review_note=$4, updated_at=now() WHERE id=$1 RETURNING *',
        [before.id, user?.id ?? null, user?.name ?? '', b.note]);
      const row = r.rows[0];
      await this.audit.record(c, { action: 'REVIEW', entity: 'LegalInstrument', entityId: row.id, entityLabel: row.ref_no, before: { reviewedAt: before.reviewed_at }, after: { reviewedAt: row.reviewed_at, reviewedBy: row.reviewed_by }, note: b.note });
      return this.republish(c, row, EVENTS.legislation.instrumentReviewed, { reviewedBy: row.reviewed_by, note: b.note });
    });
  }

  /** Legal clearance follows review: clearing a draft nobody has read would be a signature on an empty page. */
  @RequirePerm('legislation.approve') @Post('instruments/:id/clearance')
  async clearance(@Param('id') id: string, @Body(zod(noteBody)) b: z.infer<typeof noteBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await this.load(c, id, true);
      if (before.status !== 'DRAFT') throw conflict('Only a draft is cleared; this instrument has already left drafting');
      if (!before.reviewed_at) throw conflict('Legal clearance follows review — this draft has not been reviewed');
      const r = await c.query<InstrumentRow>('UPDATE legal_instruments SET cleared_by_id=$2, cleared_by=$3, cleared_at=now(), clearance_note=$4, updated_at=now() WHERE id=$1 RETURNING *',
        [before.id, user?.id ?? null, user?.name ?? '', b.note]);
      const row = r.rows[0];
      await this.audit.record(c, { action: 'CLEAR', entity: 'LegalInstrument', entityId: row.id, entityLabel: row.ref_no, after: { clearedAt: row.cleared_at, clearedBy: row.cleared_by }, note: b.note });
      return this.republish(c, row, EVENTS.legislation.instrumentCleared, { clearedBy: row.cleared_by, note: b.note });
    });
  }

  /* Put a draft in force. Requires legislation.approve — and requires not being the person who drafted
   * it, which is the separation the permission alone cannot express. */
  @RequirePerm('legislation.approve') @Post('instruments/:id/publish')
  async publish(@Param('id') id: string, @Body(zod(publishBody)) b: z.infer<typeof publishBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await this.load(c, id, true);
      const verdict = canApprove(before, user?.id);
      if (!verdict.ok) throw conflict(verdict.error);
      const effective = at(b.effectiveDate ?? null) ?? before.effective_date ?? new Date();
      const r = await c.query<InstrumentRow>(
        `UPDATE legal_instruments SET status='IN_FORCE', approved_by_id=$2, approved_by=$3, approved_at=now(), effective_date=$4, updated_at=now() WHERE id=$1 RETURNING *`,
        [before.id, user?.id ?? null, user?.name ?? '', effective]);
      const row = r.rows[0];
      await this.audit.record(c, {
        action: 'APPROVE', entity: 'LegalInstrument', entityId: row.id, entityLabel: row.ref_no,
        before: { status: before.status, approvedBy: before.approved_by }, after: { status: row.status, approvedBy: row.approved_by, approvedAt: row.approved_at }, note: b.note,
      });
      return this.republish(c, row, EVENTS.legislation.instrumentPublished, { approvedBy: row.approved_by, effectiveDate: row.effective_date, draftedBy: row.drafted_by });
    });
  }

  /* Supersession replaces one instrument with another and keeps both sides of the link: the superseded
   * instrument names its successor, the successor names what it replaced, and a link row records the
   * act itself so the chain can be walked in either direction. */
  @RequirePerm('legislation.approve') @Post('instruments/:id/supersede')
  async supersede(@Param('id') id: string, @Body(zod(supersedeBody)) b: z.infer<typeof supersedeBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const target = await this.load(c, id, true);
      const s = await c.query<InstrumentRow>('SELECT * FROM legal_instruments WHERE id::text = $1 OR upper(ref_no) = upper($2) FOR UPDATE',
        [b.successorId ?? '00000000-0000-0000-0000-000000000000', b.successorRef ?? b.successorId ?? '']);
      const successor = s.rows[0];
      if (!successor) throw notFound('The superseding instrument is not on the register');
      const verdict = canSupersede(target, successor);
      if (!verdict.ok) throw conflict(verdict.error);
      const t = await c.query<InstrumentRow>("UPDATE legal_instruments SET status='SUPERSEDED', superseded_by=$2, updated_at=now() WHERE id=$1 RETURNING *", [target.id, successor.ref_no]);
      const u = await c.query<InstrumentRow>('UPDATE legal_instruments SET supersedes=$2, updated_at=now() WHERE id=$1 RETURNING *', [successor.id, target.ref_no]);
      await c.query(`INSERT INTO instrument_links(from_id, to_id, from_ref, to_ref, kind, note, by_id, by) VALUES ($1,$2,$3,$4,'SUPERSEDES',$5,$6,$7)
        ON CONFLICT (from_id, kind, coalesce(to_id::text, to_ref)) DO UPDATE SET note = EXCLUDED.note, at = now()`,
        [successor.id, target.id, successor.ref_no, target.ref_no, b.note, user?.id ?? null, user?.name ?? '']);
      await this.audit.record(c, {
        action: 'SUPERSEDE', entity: 'LegalInstrument', entityId: target.id, entityLabel: target.ref_no,
        before: { status: target.status, supersededBy: target.superseded_by }, after: { status: 'SUPERSEDED', supersededBy: successor.ref_no }, note: b.note,
      });
      await this.republish(c, u.rows[0], EVENTS.legislation.instrumentUpdated, { supersedes: target.ref_no });
      return this.republish(c, t.rows[0], EVENTS.legislation.instrumentSuperseded, { supersededBy: successor.ref_no, successorId: successor.id, note: b.note });
    });
  }

  /** Withdrawal takes an instrument out of force and records why; nothing brings it back. */
  @RequirePerm('legislation.approve') @Post('instruments/:id/withdraw')
  async withdraw(@Param('id') id: string, @Body(zod(withdrawBody)) b: z.infer<typeof withdrawBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await this.load(c, id, true);
      const move = canTransition(before.status, 'WITHDRAWN');
      if (!move.ok) throw conflict(move.error);
      const r = await c.query<InstrumentRow>(
        `UPDATE legal_instruments SET status='WITHDRAWN', withdrawn_by_id=$2, withdrawn_by=$3, withdrawn_at=$4, withdrawal_reason=$5, updated_at=now() WHERE id=$1 RETURNING *`,
        [before.id, user?.id ?? null, user?.name ?? '', at(b.at ?? null) ?? new Date(), b.reason]);
      const row = r.rows[0];
      await this.audit.record(c, { action: 'WITHDRAW', entity: 'LegalInstrument', entityId: row.id, entityLabel: row.ref_no, before: { status: before.status }, after: { status: row.status, withdrawnBy: row.withdrawn_by }, note: b.reason });
      return this.republish(c, row, EVENTS.legislation.instrumentWithdrawn, { reason: row.withdrawal_reason, withdrawnBy: row.withdrawn_by });
    });
  }

  /* --------------------------------------------------------------- acknowledgement roll --- */

  @RequirePerm('legislation.view') @Post('instruments/:id/acknowledge')
  async acknowledge(@Param('id') id: string, @Body(zod(ackBody)) b: z.infer<typeof ackBody>, @CurrentUser() user?: Principal) {
    return recordAcknowledgement(this.pool, this.env, this.audit, id, b.note, user, (c, row) => this.full(c, row));
  }

  /* -------------------------------------------------------------- amendments and links --- */

  /** An amendment, a revocation or a plain cross-reference between two instruments. */
  @RequirePerm('legislation.manage') @Post('instruments/:id/links')
  async link(@Param('id') id: string, @Body(zod(linkBody)) b: z.infer<typeof linkBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const from = await this.load(c, id, true);
      if (FINAL.includes(from.status)) throw conflict(`A ${from.status.toLowerCase()} instrument is a closed record and cannot be edited`);
      const t = await c.query<InstrumentRow>('SELECT * FROM legal_instruments WHERE id::text = $1 OR upper(ref_no) = upper($2)',
        [b.targetId ?? '00000000-0000-0000-0000-000000000000', b.targetRef ?? b.targetId ?? '']);
      const to = t.rows[0];
      if (!to) throw notFound('The instrument being referred to is not on the register');
      if (to.id === from.id) throw badRequest('An instrument cannot be linked to itself');
      await c.query(`INSERT INTO instrument_links(from_id, to_id, from_ref, to_ref, kind, note, by_id, by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (from_id, kind, coalesce(to_id::text, to_ref)) DO UPDATE SET note = EXCLUDED.note, at = now()`,
        [from.id, to.id, from.ref_no, to.ref_no, b.kind, b.note, user?.id ?? null, user?.name ?? '']);
      await this.audit.record(c, { action: 'LINK', entity: 'LegalInstrument', entityId: from.id, entityLabel: from.ref_no, after: { kind: b.kind, target: to.ref_no }, note: b.note });
      await this.republish(c, from, EVENTS.legislation.instrumentLinked, { kind: b.kind, targetId: to.id, targetRef: to.ref_no });
      return this.full(c, from);
    });
  }

  @RequirePerm('legislation.manage') @Delete('instruments/:id/links/:linkId')
  async unlink(@Param('id') id: string, @Param('linkId') linkId: string) {
    return withTx(this.pool, async (c) => {
      const from = await this.load(c, id, true);
      const r = await c.query<LinkRow>('DELETE FROM instrument_links WHERE id::text = $1 AND (from_id = $2 OR to_id = $2) RETURNING *', [linkId, from.id]);
      if (!r.rows[0]) throw notFound('Link not found on this instrument');
      await this.audit.record(c, { action: 'UNLINK', entity: 'LegalInstrument', entityId: from.id, entityLabel: from.ref_no, before: { kind: r.rows[0].kind, target: r.rows[0].to_ref } });
      await this.republish(c, from, EVENTS.legislation.instrumentUnlinked, { kind: r.rows[0].kind, targetRef: r.rows[0].to_ref });
      return this.full(c, from);
    });
  }

  /* ------------------------------------------------------------------------ attachments --- */

  @RequirePerm('legislation.manage') @Post('instruments/:id/attachments')
  async attach(@Param('id') id: string, @Body(zod(attachmentBody)) b: z.infer<typeof attachmentBody>, @CurrentUser() user?: Principal) {
    return withTx(this.pool, async (c) => {
      const before = await this.load(c, id, true);
      if (FINAL.includes(before.status)) throw conflict(`A ${before.status.toLowerCase()} instrument is a closed record and cannot be edited`);
      const attachment: Attachment = { id: randomId(), name: b.name, kind: b.kind, documentId: b.documentId ?? null, url: b.url ?? null, sizeBytes: b.sizeBytes ?? null, addedAt: new Date().toISOString(), addedBy: user?.name ?? '' };
      const r = await c.query<InstrumentRow>('UPDATE legal_instruments SET attachments = attachments || $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *', [before.id, JSON.stringify([attachment])]);
      const row = r.rows[0];
      await this.audit.record(c, { action: 'ATTACH', entity: 'LegalInstrument', entityId: row.id, entityLabel: row.ref_no, after: attachment });
      await this.republish(c, row, EVENTS.legislation.instrumentAttached, { attachment });
      return this.full(c, row);
    });
  }

  @RequirePerm('legislation.manage') @Delete('instruments/:id/attachments/:attachmentId')
  async detach(@Param('id') id: string, @Param('attachmentId') attachmentId: string) {
    return withTx(this.pool, async (c) => {
      const before = await this.load(c, id, true);
      const kept = (before.attachments ?? []).filter((a) => a.id !== attachmentId);
      if (kept.length === (before.attachments ?? []).length) throw notFound('Attachment not found on this instrument');
      const r = await c.query<InstrumentRow>('UPDATE legal_instruments SET attachments = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *', [before.id, JSON.stringify(kept)]);
      const row = r.rows[0];
      await this.audit.record(c, { action: 'DETACH', entity: 'LegalInstrument', entityId: row.id, entityLabel: row.ref_no, before: (before.attachments ?? []).find((a) => a.id === attachmentId) });
      await this.republish(c, row, EVENTS.legislation.instrumentAttached, { removed: attachmentId });
      return this.full(c, row);
    });
  }
}

const randomId = () => `att_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36)}`;

/* Recording a receipt is the same act whether it comes from the register screen or from the notice
 * board, so both routes run this. It is idempotent: a second receipt from the same person changes
 * nothing and is not an error. */
export async function recordAcknowledgement(
  pool: Pool, env: Env, audit: AuditClient, id: string, note: string, user: Principal | undefined,
  render: (c: PoolClient, row: InstrumentRow) => Promise<unknown>,
) {
  return withTx(pool, async (c) => {
    const r = await c.query<InstrumentRow>('SELECT * FROM legal_instruments WHERE id::text = $1 OR upper(ref_no) = upper($1) FOR UPDATE', [id]);
    const row = r.rows[0];
    if (!row) throw notFound('Instrument not found');
    const verdict = canAcknowledge(row);
    if (!verdict.ok) throw badRequest(verdict.error);
    if (!user?.id) throw badRequest('An acknowledgement is recorded against a person');
    const ins = await c.query<AckRow>(
      `INSERT INTO instrument_acknowledgements(instrument_id, user_id, name, role_name, note) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (instrument_id, user_id) DO NOTHING RETURNING *`,
      [row.id, user.id, user.name ?? '', user.roleName ?? '', note]);
    if (ins.rows[0]) {
      await audit.record(c, { action: 'ACKNOWLEDGE', entity: 'LegalInstrument', entityId: row.id, entityLabel: row.ref_no, after: { userId: user.id, name: user.name, at: ins.rows[0].at }, note });
      const acks = await c.query<AckRow>('SELECT * FROM instrument_acknowledgements WHERE instrument_id = $1 ORDER BY at', [row.id]);
      await publishInstrument(c, env, row, { acknowledgedBy: acks.rows.map(ackApi) }, {
        event: EVENTS.legislation.acknowledgementRecorded,
        data: { userId: user.id, name: user.name, acknowledgements: acks.rowCount ?? 0 },
      });
    }
    return render(c, row);
  });
}
