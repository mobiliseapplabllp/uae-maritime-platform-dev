import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, KIT_BUS, KIT_ENV, KIT_POOL, LOOKUP_SUBJECTS, applyLookupEvent, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';
import type { Env } from './env';
import { publishInstrument, type InstrumentRow, type Row } from './instruments';
import { projectSnapshot } from './subjects';
import { acksOf } from './read';
import { IMO_FEED } from './feed.token';
import { pollSources, type SourceFeed } from './imo';

/* What the register learns from the rest of the platform.
 *
 * Who is on the staff roll: an instrument that requires acknowledgement is addressed to a class of people,
 * and the size of that class changes when somebody joins, moves department or is deactivated — which
 * changes what is outstanding. When the roll moves, the in-force instruments whose class it affects are
 * republished so reporting's acknowledgement figures follow, and nothing else in the register is touched:
 * the text of an instrument is not a function of the staff list.
 *
 * The masters, into this service's mirror: the instrument types with their series and their standing on
 * the public portal, the link kinds, and the IMO sources the watch reads. And the scheduler's tick for the
 * watch itself, which reads every source that is due through the integration hub.
 *
 * Consumption is idempotent through the inbox, so a redelivered event changes nothing twice. */

export interface Deps { env: Env; audit: AuditClient; feed?: SourceFeed }

/** The mandatory instruments a change to this person's roll entry could affect. */
async function affected(c: PoolClient, user: Row): Promise<InstrumentRow[]> {
  const r = await c.query<InstrumentRow>(
    `SELECT * FROM legal_instruments
      WHERE ack_required AND status = 'IN_FORCE'
        AND (ack_class = 'ALL_STAFF'
          OR (ack_class = 'ROLE' AND lower(ack_class_value) = lower($1))
          OR (ack_class = 'DEPARTMENT' AND lower(ack_class_value) = lower($2)))
      ORDER BY issued_date DESC`,
    [String(user.roleName ?? user.role?.name ?? user.role_name ?? ''), String(user.department ?? '')]);
  return r.rows;
}

export async function applyEvent(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<void> {
  if (await applyLookupEvent(c, event)) return;
  if (event.type === EVENTS.scheduler.pollImoSources) {
    if (deps.feed) await pollSources(c, deps.env, deps.audit, deps.feed, { cause: event });
    return;
  }
  const relevant = await projectSnapshot(c, event);
  if (!relevant) return;
  const d = (event.data ?? {}) as Row;
  const user: Row = d.entity ?? d.user ?? (d.id ? { id: d.id } : {});
  if (!user.id) return;
  const rows = await affected(c, user);
  if (!rows.length) return;
  await deps.audit.record(c, {
    action: 'ROLL_REFRESHED', entity: 'LegalInstrument', entityId: rows[0].id, entityLabel: rows[0].ref_no,
    after: { userId: user.id, name: user.name ?? null, instruments: rows.length },
    note: 'Acknowledgement roll refreshed from the staff register', actor: { id: 'identity-access', name: 'Identity', kind: 'system' },
  });
  for (const row of rows) {
    const acks = (await acksOf(c, [row.id])).get(row.id) ?? [];
    await publishInstrument(c, deps.env, row, { acknowledgedBy: acks }, { cause: event });
  }
}

export const SUBJECTS = [subjectFor(EVENTS.readModel.upserted), subjectFor(EVENTS.readModel.deleted), subjectFor(EVENTS.identity.userChanged), subjectFor(EVENTS.scheduler.pollImoSources), ...LOOKUP_SUBJECTS];

@Injectable()
export class LegislationConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, @Inject(IMO_FEED) private readonly feed: SourceFeed, private readonly audit: AuditClient) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('legislation-consumer', SUBJECTS, (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) { await withInbox(this.pool, event, (c) => applyEvent(c, { env: this.env, audit: this.audit, feed: this.feed }, event)); }
}
