import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, KIT_BUS, KIT_ENV, KIT_POOL, LOOKUP_SUBJECTS, applyLookupEvent, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';
import type { Env } from './env';
import { projectSnapshot, republishSeafarer } from './subjects';
import { backfillVocabulary } from './vocab';
import { ACCREDITATION_EVENTS, applyAccreditationEvent, applyMetInstrument, publishInstitution, refreshInstitutionIdentity } from './met';
import { applyMsmdInstrument } from './manning';

/* What the crew desk learns from the rest of the platform.
 *
 *   The fleet it signs crew on to, and the port calls a crew list is lodged against, as read-model snapshots.
 *   The certificates of competency and proficiency the instrument register issued against a seafarer, merged
 *   read-only onto the record. The minimum safe manning document issued against a ship, written onto its scale.
 *   The accreditation and programme-approval instruments raised against a training provider, and the
 *   accreditation cycle the facilities service runs for it, mirrored onto the MET register.
 *   The masters, into this service's lookup mirror — and, when the rank or document masters change, the code
 *   column re-derived on rows that were written under labels alone.
 *
 * Consumption is idempotent through the inbox, so a redelivered event changes nothing twice. */

export interface Deps { env: Env; audit: AuditClient }
type Row = Record<string, any>;

export async function applyEvent(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<void> {
  if (await applyLookupEvent(c, event)) {
    const category = String((event.data as Row)?.category ?? '');
    if (category === 'seafarerRank' || category === 'seafarerCertType') await backfillVocabulary(c);
    return;
  }
  if (ACCREDITATION_EVENTS.includes(event.type)) { await applyAccreditationEvent(c, deps.env, deps.audit, event); return; }
  if (event.type === EVENTS.mdm.companyUpserted) {
    const d = (event.data ?? {}) as Row;
    const row = await refreshInstitutionIdentity(c, { id: d.companyId, code: d.code, name: d.name, nameAr: d.nameAr, ...(d.company ?? {}) });
    if (row) await publishInstitution(c, deps.env, row, { cause: event });
    return;
  }
  const d = (event.data ?? {}) as Row;
  if (event.type === EVENTS.readModel.upserted && d.kind === 'company' && d.entity?.id) {
    const row = await refreshInstitutionIdentity(c, d.entity);
    if (row) await publishInstitution(c, deps.env, row, { cause: event });
    return;
  }
  if (event.type === EVENTS.readModel.upserted && d.kind === 'instrument' && event.source !== deps.env.SERVICE_NAME) {
    const e: Row = d.entity ?? {};
    if (await applyMetInstrument(c, deps.env, deps.audit, e, event)) return;
    if (await applyMsmdInstrument(c, deps.env, deps.audit, e, event)) return;
  }
  const seafarerId = await projectSnapshot(c, deps.env, event);
  if (!seafarerId) return;
  const e = ((event.data ?? {}) as Row).entity ?? {};
  await deps.audit.record(c, {
    action: 'INSTRUMENT_MIRRORED', entity: 'Seafarer', entityId: seafarerId, entityLabel: `${e.entityName ?? ''} — ${e.typeLabel ?? e.entityType ?? ''}`,
    after: { number: e.number ?? e.licenseNo, status: e.status, expiryDate: e.expiryDate, instrumentId: e.id },
    note: 'Instrument mirrored from the instrument register', actor: { id: 'instruments', name: 'Instruments', kind: 'system' },
  });
  await republishSeafarer(c, deps.env, seafarerId, event);
}

export const SUBJECTS = [
  subjectFor(EVENTS.readModel.upserted), subjectFor(EVENTS.readModel.deleted), subjectFor(EVENTS.mdm.vesselUpserted), subjectFor(EVENTS.mdm.companyUpserted),
  ...ACCREDITATION_EVENTS.map(subjectFor), ...LOOKUP_SUBJECTS,
];

@Injectable()
export class SeafarersConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('seafarers-consumer', SUBJECTS, (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) { await withInbox(this.pool, event, (c) => applyEvent(c, { env: this.env, audit: this.audit }, event)); }
}
