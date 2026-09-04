import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { NATIONAL_SCOPE, EVENTS, makeEvent, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, KIT_BUS, KIT_ENV, KIT_POOL, enqueue, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';
import type { Env } from './env';
import { facilityApi, publishCompany, type CompanyRow, type FacilityRow, type Row } from './directory';
import { projectSnapshot } from './subjects';
import { raiseObligation } from './compliance';
import { loadCompany } from './read';

/* What the port-companies desk learns from the rest of the platform.
 *
 * The instrument register belongs to the instruments service and is never called synchronously: its
 * records arrive as read-model snapshots, and the desk reacts to what they say. A licence coming into
 * force against a company or a facility on this register is announced as `facilities.licence.issued`;
 * one being suspended is announced as `facilities.licence.suspended` and raises an obligation against
 * the subject, because a suspended licence is something the holder has to put right.
 *
 * The harbour estate owns a berth's particulars and master data owns a company's identity; both are
 * refreshed here without ever touching this service's own overlay — the standing, the rating, the ISPS
 * position and the audits are decisions taken here and are not a function of another service's row.
 * Consumption is idempotent through the inbox, so a redelivered event changes nothing twice. */

export interface Deps { env: Env; audit: AuditClient }
const REGULATED_KINDS = ['COMPANY', 'PORT_FACILITY', 'MET_INSTITUTION'];

/** The subject an instrument is held by, if this register knows it. */
async function subjectOf(c: PoolClient, instrument: Row): Promise<{ kind: 'COMPANY' | 'FACILITY'; id: string; name: string } | null> {
  const id = instrument.subjectId ? String(instrument.subjectId) : '';
  if (!id) return null;
  const company = await c.query<{ id: string; name: string }>('SELECT id, name FROM companies WHERE id = $1', [id]);
  if (company.rows[0]) return { kind: 'COMPANY', id: company.rows[0].id, name: company.rows[0].name };
  const facility = await c.query<{ id: string; name: string }>('SELECT id, name FROM port_facilities WHERE id = $1', [id]);
  if (facility.rows[0]) return { kind: 'FACILITY', id: facility.rows[0].id, name: facility.rows[0].name };
  return null;
}

async function announce(c: PoolClient, env: Env, type: string, data: Row, cause: EventEnvelope, subject: string) {
  await enqueue(c, makeEvent({ type, source: env.SERVICE_NAME, data, subject, correlationId: cause.correlationid, causationId: cause.id, actor: cause.actor }));
}

export async function applyEvent(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<void> {
  const result = await projectSnapshot(c, event);
  if (!result.kind) return;
  const entity = (result.entity ?? {}) as Row;

  if (result.kind === 'instrument') {
    if (!REGULATED_KINDS.includes(String(entity.subjectKind ?? ''))) return;
    const subject = await subjectOf(c, entity);
    if (!subject) return;
    const was = result.before?.status ?? '';
    const now = String(entity.status ?? '');
    if (now === was) return;
    const payload = {
      instrumentId: entity.id, licenceNo: entity.number ?? entity.licenseNo ?? '', subjectKind: subject.kind, subjectId: subject.id, subjectName: subject.name,
      entityType: entity.entityType ?? '', typeLabel: entity.typeLabel ?? '', instrumentClass: entity.instrumentClass ?? 'LICENCE',
      issueDate: entity.issueDate ?? null, expiryDate: entity.expiryDate ?? null, previousStatus: was || null, status: now,
    };
    if (now === 'ISSUED') await announce(c, deps.env, EVENTS.facilities.licenceIssued, payload, event, subject.id);
    if (now === 'SUSPENDED') {
      await announce(c, deps.env, EVENTS.facilities.licenceSuspended, payload, event, subject.id);
      await raiseObligation(c, deps.env, deps.audit, subject, {
        kind: 'CONDITION', title: `${payload.typeLabel || 'Instrument'} ${payload.licenceNo} suspended`,
        detail: 'The suspension is to be answered before the instrument can be reinstated.', sourceRef: String(payload.licenceNo || entity.id),
      });
    }
    return;
  }

  if (result.kind === 'berth') {
    const r = await c.query<FacilityRow>('SELECT * FROM port_facilities WHERE id = $1', [String(entity.id)]);
    const row = r.rows[0];
    if (!row) return;
    await deps.audit.record(c, {
      action: 'ESTATE_REFRESHED', entity: 'PortFacility', entityId: row.id, entityLabel: row.name,
      after: { code: row.code, terminal: row.terminal, loaMax: row.loa_max, draftMax: row.draft_max, status: row.status },
      note: 'Physical particulars corrected from the harbour estate', actor: { id: 'ports', name: 'Ports', kind: 'system' },
    });
    await announce(c, deps.env, EVENTS.facilities.facilityUpdated, {
      facilityId: row.id, code: row.code, name: row.name, facilityType: row.facility_type, operatorId: row.operator_id,
      operatorName: row.operator_name, ispsStatus: row.isps_status, status: row.status, facility: facilityApi(row), source: 'ports',
    }, event, row.id);
    return;
  }

  if (result.kind === 'company') {
    const row = await loadCompany(c, String(entity.id), NATIONAL_SCOPE).catch(() => null);
    if (!row) return;
    await publishCompany(c, deps.env, row as CompanyRow, {}, { cause: event });
  }
}

export const SUBJECTS = [subjectFor(EVENTS.readModel.upserted), subjectFor(EVENTS.readModel.deleted), subjectFor(EVENTS.mdm.companyUpserted)];

@Injectable()
export class FacilitiesConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('facilities-consumer', SUBJECTS, (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) { await withInbox(this.pool, event, (c) => applyEvent(c, { env: this.env, audit: this.audit }, event)); }
}
