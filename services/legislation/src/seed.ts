import { join } from 'node:path';
import { buildWorld, stableId, type WorldLegalInstrument } from '@maritime/world';
import { createDb, runMigrations, seedLookupMirror, withTx, type Queryable } from '@maritime/service-kit';
import { env } from './env';
import { REF_PREFIX, stampPublic, type InstrumentRow } from './instruments';
import { upsertUser } from './subjects';

/* Seeds the register from the shared world: the conventions the administration is party to, its acts
 * and rules, the circulars reissued year on year as supersession chains, the notices and orders the
 * harbour desk publishes, the drafts still waiting on an approver, and the receipts already collected
 * against the mandatory ones. The staff roll the outstanding lists are computed against is seeded here
 * too, so the notice board works before any event arrives.
 *
 * Idempotent: every write is an upsert on the world's stable id, both sides of every supersession are
 * written, and the reference-number series are advanced past the seeded numbers so the next reference
 * the register allocates can never collide with one of them. */

async function advance(c: Queryable, series: string, value: number) {
  await c.query('INSERT INTO numbering_series(series, last_value) VALUES ($1,$2) ON CONFLICT (series) DO UPDATE SET last_value = GREATEST(numbering_series.last_value, EXCLUDED.last_value)', [series, value]);
}
/** `CIRC-14/2026` → the series `CIRC-2026` at 14. Anything else (SOLAS-74, MARPOL-73/78) is not an allocated number. */
export function seriesOf(refNo: string): { series: string; value: number } | null {
  const m = /^(.+)-(\d{1,4})\/(\d{4})$/.exec(refNo);
  if (!m) return null;
  return { series: `${m[1]}-${m[3]}`, value: Number(m[2]) };
}
/** Which class an instrument's acknowledgement is addressed to. The world marks the requirement; the register decides the audience. */
function ackClassOf(i: WorldLegalInstrument): { cls: string; value: string } {
  if (!i.ackRequired) return { cls: 'ALL_STAFF', value: '' };
  if (i.category === 'Security') return { cls: 'ROLE', value: 'Security Officer' };
  return { cls: 'ALL_STAFF', value: '' };
}

export async function seedLegislation(databaseUrl: string, profile = 'AE') {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });
  const byRef = new Map(world.legalInstruments.map((i) => [i.refNo, i]));

  const counts = await withTx(pool, async (c) => {
    const lookups = await seedLookupMirror(c, world.lookups);
    for (const u of world.users) await upsertUser(c, { id: u.id, name: u.name, email: u.email, roleName: u.roleName, designation: u.designation, department: u.department, active: u.active });

    let acknowledgements = 0;
    for (const i of world.legalInstruments) {
      const ack = ackClassOf(i);
      await c.query(
        `INSERT INTO legal_instruments(id, ref_no, title, title_ar, type, category, status, issued_by, issued_date, effective_date, summary, body, tags,
           supersedes, ack_required, ack_class, ack_class_value, drafted_by_id, drafted_by, approved_by_id, approved_by, approved_at, source_note, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)
         ON CONFLICT (id) DO UPDATE SET ref_no = EXCLUDED.ref_no, title = EXCLUDED.title, title_ar = EXCLUDED.title_ar, type = EXCLUDED.type, category = EXCLUDED.category,
           status = EXCLUDED.status, issued_by = EXCLUDED.issued_by, issued_date = EXCLUDED.issued_date, effective_date = EXCLUDED.effective_date, summary = EXCLUDED.summary,
           body = EXCLUDED.body, tags = EXCLUDED.tags, supersedes = EXCLUDED.supersedes, ack_required = EXCLUDED.ack_required, ack_class = EXCLUDED.ack_class,
           ack_class_value = EXCLUDED.ack_class_value, drafted_by_id = EXCLUDED.drafted_by_id, drafted_by = EXCLUDED.drafted_by, approved_by_id = EXCLUDED.approved_by_id,
           approved_by = EXCLUDED.approved_by, approved_at = EXCLUDED.approved_at, source_note = EXCLUDED.source_note, created_at = EXCLUDED.created_at, updated_at = now()`,
        [i.id, i.refNo, i.title, i.titleAr ?? null, i.type, i.category, i.status, i.issuedBy, i.issuedDate, i.effectiveDate, i.summary, i.body, JSON.stringify(i.tags),
          i.supersedes, i.ackRequired, ack.cls, ack.value, i.draftedById, i.draftedBy, i.approvedById, i.approvedBy, i.approvedAt, i.sourceNote,
          i.approvedAt ?? i.issuedDate]);

      /* A reviewed and cleared chain is only claimed where the world says two different people signed
       * the instrument off — a convention adopted in 1974 has no review minute to record. */
      if (i.approvedById && i.draftedById !== i.approvedById && i.type !== 'CONVENTION') {
        await c.query(
          `UPDATE legal_instruments SET reviewed_by_id = $2, reviewed_by = $3, reviewed_at = $4, review_note = $5,
             cleared_by_id = $2, cleared_by = $3, cleared_at = $4, clearance_note = $6 WHERE id = $1 AND reviewed_at IS NULL`,
          [i.id, i.approvedById, i.approvedBy, i.approvedAt, 'Reviewed against the register before publication', 'Cleared for publication']);
      }

      for (const a of i.acknowledgedBy) {
        const user = world.users.find((u) => u.id === a.userId);
        await c.query(
          `INSERT INTO instrument_acknowledgements(id, instrument_id, user_id, name, role_name, at) VALUES ($1,$2,$3,$4,$5,$6)
           ON CONFLICT (instrument_id, user_id) DO UPDATE SET name = EXCLUDED.name, role_name = EXCLUDED.role_name, at = EXCLUDED.at`,
          [stableId('ack', `${i.refNo}:${a.userId}`), i.id, a.userId, a.name, user?.roleName ?? '', a.at]);
        acknowledgements += 1;
      }
    }

    // both sides of every supersession chain, plus the link row that records the act itself
    let links = 0;
    for (const i of world.legalInstruments) {
      if (!i.supersedes) continue;
      const previous = byRef.get(i.supersedes);
      if (!previous) continue;
      await c.query('UPDATE legal_instruments SET superseded_by = $2, updated_at = now() WHERE id = $1', [previous.id, i.refNo]);
      await c.query(
        `INSERT INTO instrument_links(id, from_id, to_id, from_ref, to_ref, kind, note, by_id, by, at) VALUES ($1,$2,$3,$4,$5,'SUPERSEDES',$6,$7,$8,$9)
         ON CONFLICT (from_id, kind, coalesce(to_id::text, to_ref)) DO UPDATE SET note = EXCLUDED.note, at = EXCLUDED.at`,
        [stableId('link', `${i.refNo}:supersedes:${previous.refNo}`), i.id, previous.id, i.refNo, previous.refNo,
          `${previous.refNo} replaced by ${i.refNo}`, i.approvedById, i.approvedBy, i.issuedDate]);
      links += 1;
    }

    // the portal's columns on every seeded instrument: slug, content hash, publication date
    for (const row of (await c.query<InstrumentRow>('SELECT * FROM legal_instruments')).rows) await stampPublic(c, row);

    const series = new Map<string, number>();
    for (const i of world.legalInstruments) {
      const s = seriesOf(i.refNo);
      if (s) series.set(s.series, Math.max(series.get(s.series) ?? 0, s.value));
    }
    // every type the register can allocate against carries a series for the current year, even where the world seeded none; the prefixes are the type master's
    const year = new Date(world.now).getUTCFullYear();
    const prefixes = new Set<string>([...Object.values(REF_PREFIX), ...world.lookups.filter((l) => l.category === 'legalInstrumentType').map((l) => String(l.meta.refPrefix ?? '')).filter(Boolean)]);
    for (const prefix of prefixes) if (!series.has(`${prefix}-${year}`)) series.set(`${prefix}-${year}`, 0);
    for (const [key, n] of series) await advance(c, key, n);

    /* The IMO watch: what the monitored sources produced over the last year and what the desk did with each
     * item, plus a poll state per source that says the source has been read and when it is next due. */
    const instrumentByRef = new Map(world.legalInstruments.map((i) => [i.refNo, i.id]));
    for (const w of world.imoWatch) {
      await c.query(`INSERT INTO imo_watch_items(id, source, body, series, reference, title, subject, published_on, entry_into_force, url, status, assessment, assessed_by_id, assessed_by, assessed_at, due_on, instrument_id, instrument_ref, first_seen_at, last_seen_at, seen_count, raw)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$19,1,$20)
        ON CONFLICT (id) DO UPDATE SET title = EXCLUDED.title, subject = EXCLUDED.subject, published_on = EXCLUDED.published_on, entry_into_force = EXCLUDED.entry_into_force, url = EXCLUDED.url, status = EXCLUDED.status, assessment = EXCLUDED.assessment,
          assessed_by_id = EXCLUDED.assessed_by_id, assessed_by = EXCLUDED.assessed_by, assessed_at = EXCLUDED.assessed_at, due_on = EXCLUDED.due_on, instrument_id = EXCLUDED.instrument_id, instrument_ref = EXCLUDED.instrument_ref, updated_at = now()`,
        [w.id, w.source, w.body, w.series, w.reference, w.title, w.subject, w.publishedOn, w.entryIntoForce, w.url, w.status, w.assessment, w.assessedById, w.assessedBy, w.assessedAt, w.dueOn, w.instrumentRef ? instrumentByRef.get(w.instrumentRef) ?? null : null, w.instrumentRef, w.firstSeenAt, JSON.stringify({ seeded: true })]);
    }
    const now = new Date(world.now);
    for (const src of world.lookups.filter((l) => l.category === 'imoSource')) {
      const items = world.imoWatch.filter((w) => w.source === src.code);
      const hours = Number(src.meta.pollHours) || 24;
      const last = new Date(now.getTime() - (hours / 2) * 3_600_000);
      await c.query(`INSERT INTO imo_source_polls(source, last_polled_at, last_status, last_error, last_items, new_items, next_due_at, polls, mode) VALUES ($1,$2,'OK','',$3,0,$4,$5,'stub')
        ON CONFLICT (source) DO UPDATE SET last_polled_at = EXCLUDED.last_polled_at, last_status = 'OK', last_error = '', last_items = EXCLUDED.last_items, next_due_at = EXCLUDED.next_due_at, polls = EXCLUDED.polls, mode = EXCLUDED.mode, updated_at = now()`,
        [src.code, last, items.length, new Date(last.getTime() + hours * 3_600_000), Math.max(1, Math.round(365 * 24 / hours))]);
    }

    return {
      profile: world.profile, lookups, instruments: world.legalInstruments.length, acknowledgements, supersessions: links, imoWatch: world.imoWatch.length,
      users: world.users.length, series: series.size,
      inForce: world.legalInstruments.filter((i) => i.status === 'IN_FORCE').length,
      drafts: world.legalInstruments.filter((i) => i.status === 'DRAFT').length,
      mandatory: world.legalInstruments.filter((i) => i.ackRequired).length,
    };
  });
  await pool.end();
  return counts;
}

if (require.main === module) {
  const e = env();
  seedLegislation(e.DATABASE_URL, e.JURISDICTION).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
