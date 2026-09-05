import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, KIT_BUS, KIT_ENV, KIT_POOL, LOOKUP_SUBJECTS, applyLookupEvent, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';
import type { Env } from './env';
import { inspectionApi, publishInspection, type FindingRow, type InspectionRow, type Row } from './inspections';
import { findingApi } from './inspections';
import { projectSnapshot, refreshOpenInspections } from './subjects';

/* What the survey desk learns from the rest of the platform.
 *
 * Ships and calls are projected into local snapshots so the register renders and validates from one database.
 * When a ship's particulars change, the open surveys against her are corrected and republished — closed ones
 * are left alone, because a closed survey records what was found on the day, not what is true now.
 * Consumption is idempotent through the inbox: a redelivered event changes nothing twice. */

export interface Deps { env: Env; audit: AuditClient }

async function findingsOf(c: PoolClient, id: string) {
  const r = await c.query<FindingRow>('SELECT * FROM findings WHERE inspection_id = $1 ORDER BY seq', [id]);
  return r.rows.map(findingApi);
}

export async function applyEvent(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<void> {
  if (await applyLookupEvent(c, event)) return; // deficiency codes, action codes and regimes
  const relevant = await projectSnapshot(c, event);
  if (!relevant) return;
  const d = (event.data ?? {}) as Row;
  const vessel: Row = d.entity ?? (d.vesselId ? { id: d.vesselId, name: d.name, imo: d.imo } : {});
  if (d.kind !== 'vessel' && event.type !== EVENTS.mdm.vesselUpserted) return;
  if (!vessel.id) return;
  const changed = await refreshOpenInspections(c, vessel);
  if (!changed.length) return;
  await deps.audit.record(c, {
    action: 'VESSEL_REFRESHED', entity: 'Inspection', entityId: changed[0], entityLabel: String(vessel.name ?? ''),
    after: { vesselId: vessel.id, name: vessel.name, imo: vessel.imo, inspections: changed.length },
    note: 'Open surveys corrected from the ship register', actor: { id: 'ships', name: 'Ships', kind: 'system' },
  });
  for (const id of changed) {
    const r = await c.query<InspectionRow>('SELECT * FROM inspections WHERE id = $1', [id]);
    const row = r.rows[0];
    if (row) await publishInspection(c, deps.env, row, { findings: await findingsOf(c, row.id) }, { cause: event });
  }
}

/** The read-model snapshot for a survey, rebuilt without a request — used by the seed and by replays. */
export async function snapshotOf(c: PoolClient, id: string) {
  const r = await c.query<InspectionRow>('SELECT * FROM inspections WHERE id = $1', [id]);
  return r.rows[0] ? inspectionApi(r.rows[0], { findings: await findingsOf(c, id) }) : null;
}

export const SUBJECTS = [
  subjectFor(EVENTS.readModel.upserted), subjectFor(EVENTS.readModel.deleted), subjectFor(EVENTS.mdm.vesselUpserted), ...LOOKUP_SUBJECTS,
];

@Injectable()
export class InspectionConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('inspection-consumer', SUBJECTS, (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) { await withInbox(this.pool, event, (c) => applyEvent(c, { env: this.env, audit: this.audit }, event)); }
}
