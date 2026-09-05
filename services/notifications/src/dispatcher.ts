import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { EVENTS, STREAM_PREFIX, type EventEnvelope } from '@maritime/contracts';
import { KIT_BUS, KIT_POOL, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';

/** Turns selected domain events into notifications. Rules are data so the studio can extend them later. */
export const RULES: Array<{ type: string; audiencePerm: string; severity: string; /** When given, the rule fires only for events it answers true for. */ when?: (d: Record<string, unknown>) => boolean; title: (d: Record<string, unknown>) => string; body?: (d: Record<string, unknown>) => string; link?: (d: Record<string, unknown>) => string }> = [
  { type: EVENTS.identity.roleChanged, audiencePerm: 'roles.view', severity: 'info', title: (d) => `Role updated: ${d.name}`, body: () => 'Permission matrix changed; it applies on the next request.', link: () => '/admin/roles' },
  // integrations: a call that ran out of attempts, and a counterpart pointed somewhere new
  { type: EVENTS.integration.callDead, audiencePerm: 'platform.view', severity: 'error', title: (d) => `Integration call failed: ${d.adapterName ?? d.adapter} · ${d.operation}`, body: (d) => `${d.attempts} attempt(s) — ${d.error}. The call is in the dead-letter queue and can be replayed from Settings → Integrations.`, link: () => '/admin/settings?tab=integrations' },
  { type: EVENTS.integration.adapterChanged, audiencePerm: 'settings.manage', severity: 'warning', when: (d) => String(d.change ?? '').startsWith('mode:'), title: (d) => `${d.name} switched to ${String(d.change).slice(5)} mode`, body: (d) => `By ${d.by}. A live adapter speaks to the real counterpart; a stub answers from the recorded contract.`, link: () => '/admin/settings?tab=integrations' },
  // access controls: a grant waiting for a second administrator, its decision, a review cycle, a dormant account
  { type: EVENTS.identity.changeRequested, audiencePerm: 'users.manage', severity: 'warning', when: (d) => d.kind !== 'ROLE_MATRIX', title: (d) => `Approval needed: ${String(d.kind).toLowerCase().replace('_', ' ')} — ${d.subjectLabel}`, body: (d) => `Requested by ${d.requestedBy}. A second administrator must approve or reject it.`, link: () => '/admin/users?pending=true' },
  { type: EVENTS.identity.changeRequested, audiencePerm: 'roles.manage', severity: 'warning', when: (d) => d.kind === 'ROLE_MATRIX', title: (d) => `Approval needed: role ${d.subjectLabel}`, body: (d) => `Requested by ${d.requestedBy}. A second administrator must approve or reject the change to this privileged role.`, link: () => '/admin/roles' },
  { type: EVENTS.identity.changeDecided, audiencePerm: 'users.view', severity: 'info', title: (d) => `${d.decision === 'APPROVED' ? 'Approved' : d.decision === 'REJECTED' ? 'Rejected' : 'Cancelled'}: ${d.subjectLabel}`, body: (d) => `${String(d.kind).toLowerCase().replace('_', ' ')} requested by ${d.requestedBy}, decided by ${d.decidedBy}.${d.decisionNote ? ` ${d.decisionNote}` : ''}`, link: () => '/admin/users' },
  { type: EVENTS.identity.accessReviewOpened, audiencePerm: 'users.manage', severity: 'warning', title: (d) => `Access review opened: ${d.total} accounts to attest`, body: (d) => `Confirm or revoke every account by ${String(d.dueAt).slice(0, 10)}.`, link: (d) => `/admin/access-reviews/${d.cycleId}` },
  { type: EVENTS.identity.accessReviewClosed, audiencePerm: 'users.view', severity: 'success', title: (d) => `Access review closed: ${d.confirmed} confirmed, ${d.revoked} revoked`, link: () => '/admin/access-reviews' },
  { type: EVENTS.identity.accountDormant, audiencePerm: 'users.manage', severity: 'warning', title: (d) => `${d.action === 'DEACTIVATE' ? 'Deactivated' : 'Dormant'}: ${d.name}`, body: (d) => `${d.email} (${d.roleName}) last signed in ${d.lastLoginAt ? String(d.lastLoginAt).slice(0, 10) : 'never'}.`, link: () => '/admin/users?dormant=true' },
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
  { type: EVENTS.legislation.sourcePolled, audiencePerm: 'legislation.view', severity: 'info', when: (d) => !!d.error || Number(d.newItems) > 0, title: (d) => (d.error ? `IMO watch — ${d.sourceLabel ?? d.source} could not be read` : `IMO watch — ${d.newItems} new document(s) from ${d.sourceLabel ?? d.source}`), body: (d) => String(d.error ?? d.firstTitle ?? ''), link: () => '/legislation/imo' },
  { type: EVENTS.legislation.sourceItemAssessed, audiencePerm: 'legislation.view', severity: 'info', title: (d) => `${d.reference} ${String(d.status).toLowerCase()}${d.instrumentRef ? ` — implemented by ${d.instrumentRef}` : ''}`, link: () => '/legislation/imo' },
  // the survey desk: a restriction the rules recommend goes to the officers who decide it; the decision and the overdue sweep go to the cell
  { type: EVENTS.inspection.restrictionRecommended, audiencePerm: 'inspections.close', severity: 'error', when: (d) => String(d.status ?? 'PENDING') === 'PENDING', title: (d) => `${String(d.kind).charAt(0)}${String(d.kind).slice(1).toLowerCase()} recommended — ${d.subjectName ?? d.vesselName} (${d.number})`, body: (d) => String(d.grounds ?? ''), link: (d) => `/inspections/${d.inspectionId}` },
  { type: EVENTS.inspection.restrictionDecided, audiencePerm: 'inspections.view', severity: 'info', title: (d) => `${String(d.kind).charAt(0)}${String(d.kind).slice(1).toLowerCase()} ${String(d.decision).toLowerCase()} — ${d.subjectName ?? d.vesselName} (${d.number})`, body: (d) => `Decided by ${d.decidedBy} after ${d.minutesToDecide} min`, link: (d) => `/inspections/${d.inspectionId}` },
  { type: EVENTS.inspection.deficiencyOverdue, audiencePerm: 'inspections.view', severity: 'warning', title: (d) => `${d.count} deficiency(ies) overdue — ${d.subjectName ?? d.vesselName} (${d.number})`, link: (d) => `/inspections/${d.inspectionId}` },
  { type: EVENTS.inspection.reportIssued, audiencePerm: 'inspections.view', severity: 'success', title: (d) => `Report issued — ${d.number} (${d.subjectName ?? d.vesselName})`, body: (d) => (d.minutesAfterClose != null ? `${d.minutesAfterClose} min after closing, first drafted ${String(d.source) === 'AI' ? 'by the assistant' : 'by the officer'}` : ''), link: (d) => `/inspections/${d.inspectionId}` },
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
    if (rule.when && !rule.when((event.data ?? {}) as Record<string, unknown>)) return;
    const d = (event.data ?? {}) as Record<string, unknown>;
    await withInbox(this.pool, event, async (c) => {
      await c.query('INSERT INTO notifications(title, body, severity, link, audience_perm, source, event_type) VALUES ($1,$2,$3,$4,$5,$6,$7)', [rule.title(d), rule.body?.(d) ?? '', rule.severity, rule.link?.(d) ?? null, rule.audiencePerm, event.source, event.type]);
    });
  }
}
