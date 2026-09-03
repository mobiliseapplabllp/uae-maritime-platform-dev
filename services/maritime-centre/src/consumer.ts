import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, KIT_BUS, KIT_ENV, KIT_POOL, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';
import type { Env } from './env';
import { LIVE_STATUS, publishIncident, type CommRow, type DocRow, type HistoryRow, type IncidentRow, type LogRow, type Row, type TaskRow } from './incidents';
import { projectSnapshot, refreshOpenIncidents, upsertPositionFromEvent } from './subjects';
import { publishPosition, type PositionRow, type VesselFacts } from './tracking';

/* What the centre learns from the rest of the platform.
 *
 * Ships and berths are projected into local snapshots so the desk and the picture render from one database, and
 * live cases naming a renamed ship are corrected and republished. AIS fixes arriving on the bus from another
 * feed are folded into the picture exactly as an ingested fix would be, and republished as a position snapshot
 * so the ship register can show her last known position. Consumption is idempotent through the inbox. */

export interface Deps { env: Env; audit: AuditClient }

/** Sequential by design: the consumer holds one client for the whole inbox transaction. */
async function caseFileOf(c: PoolClient, id: string) {
  const comms = await c.query<CommRow>('SELECT * FROM incident_comms WHERE incident_id = $1 ORDER BY at', [id]);
  const tasks = await c.query<TaskRow>('SELECT * FROM incident_tasks WHERE incident_id = $1 ORDER BY created_at', [id]);
  const documents = await c.query<DocRow>('SELECT * FROM incident_documents WHERE incident_id = $1 ORDER BY at', [id]);
  const log = await c.query<LogRow>('SELECT * FROM incident_log WHERE incident_id = $1 ORDER BY at', [id]);
  const history = await c.query<HistoryRow>('SELECT * FROM incident_status_history WHERE incident_id = $1 ORDER BY at', [id]);
  return { comms: comms.rows, tasks: tasks.rows, documents: documents.rows, log: log.rows, history: history.rows };
}

export async function applyEvent(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<void> {
  const d = (event.data ?? {}) as Row;

  // a fix from another feed: the picture takes it, and the ship register hears about it from us
  if (event.type === EVENTS.maritimeCentre.positionUpdated && event.source !== deps.env.SERVICE_NAME) {
    const vesselId = await upsertPositionFromEvent(c, d);
    if (!vesselId) return;
    const p = await c.query<PositionRow>('SELECT * FROM positions WHERE vessel_id = $1', [vesselId]);
    const v = await c.query<VesselFacts>('SELECT id, name, imo, type, flag, status FROM vessels WHERE id = $1', [vesselId]);
    if (p.rows[0]) await publishPosition(c, deps.env, p.rows[0], v.rows[0]);
    return;
  }

  const kind = await projectSnapshot(c, event);
  if (kind !== 'vessel') return;
  const vessel: Row = d.entity ?? { id: d.vesselId, name: d.name };
  if (!vessel.id) return;
  const changed = await refreshOpenIncidents(c, vessel, LIVE_STATUS);
  if (!changed.length) return;
  await deps.audit.record(c, {
    action: 'VESSEL_REFRESHED', entity: 'Incident', entityId: changed[0], entityLabel: String(vessel.name ?? ''),
    after: { vesselId: vessel.id, name: vessel.name, incidents: changed.length },
    note: 'Live case files corrected from the ship register', actor: { id: 'ships', name: 'Ships', kind: 'system' },
  });
  for (const id of changed) {
    const r = await c.query<IncidentRow>('SELECT * FROM incidents WHERE id = $1', [id]);
    const row = r.rows[0];
    if (row) await publishIncident(c, deps.env, row, await caseFileOf(c, row.id), { cause: event });
  }
}

export const SUBJECTS = [
  subjectFor(EVENTS.readModel.upserted), subjectFor(EVENTS.readModel.deleted),
  subjectFor(EVENTS.mdm.vesselUpserted), subjectFor(EVENTS.maritimeCentre.positionUpdated),
];

@Injectable()
export class MaritimeCentreConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('maritime-centre-consumer', SUBJECTS, (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) { await withInbox(this.pool, event, (c) => applyEvent(c, { env: this.env, audit: this.audit }, event)); }
}
