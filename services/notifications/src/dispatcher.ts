import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { EVENTS, STREAM_PREFIX, type EventEnvelope } from '@maritime/contracts';
import { KIT_BUS, KIT_POOL, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';

/** Turns selected domain events into notifications. Rules are data so the studio can extend them later. */
export const RULES: Array<{ type: string; audiencePerm: string; severity: string; title: (d: Record<string, unknown>) => string; body?: (d: Record<string, unknown>) => string; link?: (d: Record<string, unknown>) => string }> = [
  { type: EVENTS.identity.roleChanged, audiencePerm: 'roles.view', severity: 'info', title: (d) => `Role updated: ${d.name}`, body: () => 'Permission matrix changed; it applies on the next request.', link: () => '/admin/roles' },
  { type: EVENTS.mdm.settingsChanged, audiencePerm: 'settings.view', severity: 'info', title: (d) => `Settings changed: ${d.key}`, link: () => '/admin/settings' },
  { type: EVENTS.ports.berthed, audiencePerm: 'portcalls.view', severity: 'success', title: (d) => `${d.vesselName} berthed at ${d.berthCode}`, link: (d) => `/port-calls/${d.portCallId}` },
  { type: EVENTS.inspection.detention, audiencePerm: 'inspections.view', severity: 'error', title: (d) => `Detention: ${d.vesselName}`, link: (d) => `/inspections/${d.inspectionId}` },
  { type: EVENTS.maritimeCentre.incidentOpened, audiencePerm: 'incidents.view', severity: 'error', title: (d) => `${d.severity} incident: ${d.title}`, link: (d) => `/incidents/${d.incidentId}` },
  { type: EVENTS.instruments.suspended, audiencePerm: 'facilities.view', severity: 'warning', title: (d) => `Instrument suspended: ${d.number}`, link: (d) => `/facilities/${d.instrumentId}` },
  { type: EVENTS.instruments.revoked, audiencePerm: 'facilities.view', severity: 'error', title: (d) => `Instrument revoked: ${d.number} — ${d.entityName}`, body: (d) => String(d.note ?? ''), link: (d) => `/facilities/${d.instrumentId}` },
  { type: EVENTS.instruments.issued, audiencePerm: 'facilities.view', severity: 'success', title: (d) => `${d.typeLabel ?? 'Instrument'} issued: ${d.number} — ${d.entityName}`, link: (d) => `/facilities/${d.instrumentId}` },
  { type: EVENTS.instruments.endorsementRefused, audiencePerm: 'certificates.view', severity: 'error', title: (d) => `Certificate not endorsed: ${d.number} — ${d.entityName}`, body: (d) => `${d.kind} survey by ${d.surveyor}: ${d.remarks ?? ''}`, link: (d) => `/facilities/${d.instrumentId}` },
  { type: EVENTS.instruments.expiring, audiencePerm: 'facilities.view', severity: 'warning', title: (d) => `${d.typeLabel ?? 'Instrument'} ${d.number} expires in ${d.daysLeft} days — ${d.entityName}`, link: (d) => `/facilities/${d.instrumentId}` },
  { type: EVENTS.workflow.requestDecided, audiencePerm: 'services.view', severity: 'info', title: (d) => `Application ${d.requestNo} ${String(d.outcome).toLowerCase()}`, link: (d) => `/services/requests/${d.requestId}` },
  { type: EVENTS.ships.vesselRegistered, audiencePerm: 'registry.view', severity: 'success', title: (d) => `Registry granted: ${d.vesselName}`, link: (d) => `/registry/${d.registrationId}` },
  { type: EVENTS.facilities.accreditationDue, audiencePerm: 'facilities.view', severity: 'warning', title: (d) => `${d.scheme ?? d.category} accreditation of ${d.companyName} ends in ${d.daysLeft} days`, link: (d) => `/companies/${d.companyId}` },
  { type: EVENTS.facilities.accreditationExpired, audiencePerm: 'facilities.view', severity: 'error', title: (d) => `${d.scheme ?? d.category} accreditation of ${d.companyName} has expired`, link: (d) => `/companies/${d.companyId}` },
  { type: EVENTS.facilities.accreditationRenewed, audiencePerm: 'facilities.view', severity: 'success', title: (d) => `${d.scheme ?? d.category} accreditation renewed — ${d.companyName} (cycle ${d.cycleNo})`, link: (d) => `/companies/${d.companyId}` },
  { type: EVENTS.facilities.visitCompleted, audiencePerm: 'facilities.view', severity: 'info', title: (d) => `Visit ${d.number} completed — ${d.subjectName}: ${String(d.result ?? '').toLowerCase().replace('_', ' ')}`, body: (d) => (Number(d.findings) ? `${d.findings} finding(s) raised as obligations` : ''), link: (d) => `/companies/${d.subjectId}` },
  { type: EVENTS.ai.decisionRecorded, audiencePerm: 'agents.view', severity: 'info', title: (d) => `Agent ${d.agentId} recorded a decision (${d.disposition})`, link: () => '/agents/decisions' },
  // the crew desk: a list sent back to the agent, a provider's accreditation moving, a programme withdrawn
  { type: EVENTS.seafarers.crewListQueried, audiencePerm: 'seafarers.view', severity: 'warning', title: (d) => `Crew list ${d.number} queried — ${d.vesselName}`, body: (d) => String(d.note ?? ''), link: (d) => `/seafarers/crew-lists/${d.crewListId}` },
  { type: EVENTS.seafarers.metAccreditationChanged, audiencePerm: 'seafarers.view', severity: 'info', title: (d) => `MET accreditation ${String(d.status ?? '').toLowerCase()} — ${d.name}`, body: (d) => String(d.reason ?? ''), link: (d) => `/seafarers/met/${d.institutionId}` },
  { type: EVENTS.seafarers.programmeWithdrawn, audiencePerm: 'seafarers.view', severity: 'info', title: (d) => `Programme withdrawn — ${d.title} at ${d.name}`, body: (d) => String(d.reason ?? ''), link: (d) => `/seafarers/met/${d.institutionId}` },
];

@Injectable()
export class Dispatcher implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('notifications-dispatcher', [`${STREAM_PREFIX}.>`], (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) {
    const rule = RULES.find((r) => r.type === event.type); if (!rule) return;
    const d = (event.data ?? {}) as Record<string, unknown>;
    await withInbox(this.pool, event, async (c) => {
      await c.query('INSERT INTO notifications(title, body, severity, link, audience_perm, source, event_type) VALUES ($1,$2,$3,$4,$5,$6,$7)', [rule.title(d), rule.body?.(d) ?? '', rule.severity, rule.link?.(d) ?? null, rule.audiencePerm, event.source, event.type]);
    });
  }
}
