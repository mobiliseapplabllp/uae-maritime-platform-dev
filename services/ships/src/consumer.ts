import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, KIT_BUS, KIT_ENV, KIT_POOL, KIT_SETTINGS, LOOKUP_SUBJECTS, SettingsClient, applyLookupEvent, enqueue, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';
import { makeEvent } from '@maritime/contracts';
import type { Env } from './env';
import { projectSnapshot, republishVessel } from './subjects';

/* What the ship register learns from the rest of the platform.
 *
 * Calls, inspections, incidents, crew and AIS fixes are projected into local snapshots so the ship record
 * renders from one database. The statutory certificates this administration issued arrive from the
 * instrument register and are merged onto the ship's own certificate list — the one case where an inbound
 * event changes a record this service owns, so it is audited and republished like any other write.
 * Consumption is idempotent through the inbox: a redelivered event changes nothing twice. */

export interface Deps { env: Env; audit: AuditClient; settings?: SettingsClient }

/** The certificate expiry digest: every ship with a certificate running out inside the window is announced once per sweep, one event
 * per ship with the list on it. The window is Ships → settings' certificate window — the same one that turns a certificate EXPIRING on the
 * register — with the job's own payload and the environment behind it. */
export async function digestCertificates(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<number> {
  const payload = (event.data ?? {}) as { windowDays?: unknown };
  const s = deps.settings ? await deps.settings.moduleGet('ships', { certExpiringDays: 0 }) : { certExpiringDays: 0 };
  const windowDays = Number(s.certExpiringDays) || Number(payload.windowDays) || deps.env.CERT_EXPIRING_DAYS;
  const rows = await c.query<{ vessel_id: string; name: string; imo: string; cert_type: string; number: string; expiry_date: Date }>(
    `SELECT v.id AS vessel_id, v.name, v.imo, ct.cert_type, ct.number, ct.expiry_date FROM vessel_certificates ct JOIN vessels v ON v.id = ct.vessel_id
     WHERE ct.expiry_date >= now() AND ct.expiry_date <= now() + ($1 || ' days')::interval AND v.status <> 'INACTIVE' ORDER BY v.name, ct.expiry_date`, [String(windowDays)]);
  const byVessel = new Map<string, { vesselId: string; vesselName: string; imo: string; certificates: { certType: string; number: string; expiryDate: string; daysLeft: number }[] }>();
  const now = Date.now();
  for (const r of rows.rows) {
    const v = byVessel.get(r.vessel_id) ?? { vesselId: r.vessel_id, vesselName: r.name, imo: r.imo, certificates: [] };
    v.certificates.push({ certType: r.cert_type, number: r.number, expiryDate: new Date(r.expiry_date).toISOString(), daysLeft: Math.max(0, Math.ceil((new Date(r.expiry_date).getTime() - now) / 86_400_000)) });
    byVessel.set(r.vessel_id, v);
  }
  for (const v of byVessel.values()) {
    await enqueue(c, makeEvent({ type: EVENTS.ships.certExpiring, source: deps.env.SERVICE_NAME, subject: v.vesselId, correlationId: event.correlationid, causationId: event.id, data: { ...v, windowDays, count: v.certificates.length } }));
  }
  return byVessel.size;
}

export async function applyEvent(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<void> {
  if (event.type === EVENTS.scheduler.digestCertificates) { await digestCertificates(c, deps, event); return; }
  if (await applyLookupEvent(c, event)) return; // the registration variants, transaction types, amendment types and closure grounds
  const vesselId = await projectSnapshot(c, deps.env, event);
  if (!vesselId) return;
  const e = (event.data ?? {}) as Record<string, any>;
  const cert = e.entity ?? {};
  await deps.audit.record(c, {
    action: 'CERT_MIRRORED', entity: 'Vessel', entityId: vesselId, entityLabel: `${cert.vesselName ?? ''} — ${cert.certType ?? ''}`,
    after: { number: cert.number, expiryDate: cert.expiryDate, instrumentId: cert.instrumentId, inForce: cert.inForce },
    note: 'Statutory certificate mirrored from the instrument register', actor: { id: 'instruments', name: 'Instruments', kind: 'system' },
  });
  await republishVessel(c, deps.env, vesselId, event);
}

export const SUBJECTS = [
  subjectFor(EVENTS.scheduler.digestCertificates),
  subjectFor(EVENTS.readModel.upserted), subjectFor(EVENTS.readModel.deleted),
  subjectFor(EVENTS.mdm.companyUpserted), subjectFor(EVENTS.maritimeCentre.positionUpdated),
  ...LOOKUP_SUBJECTS,
];

@Injectable()
export class ShipsConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient, @Inject(KIT_SETTINGS) private readonly settings: SettingsClient) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('ships-consumer', SUBJECTS, (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) { await withInbox(this.pool, event, (c) => applyEvent(c, { env: this.env, audit: this.audit, settings: this.settings }, event)); }
}
