import { randomUUID } from 'node:crypto';

/** Domain event subjects. Streams carry `maritime.<subject>`; consumers subscribe by prefix. */
export const EVENTS = {
  identity: { roleChanged: 'identity.role.changed', userChanged: 'identity.user.changed' },
  mdm: { goldenUpdated: 'mdm.golden.updated', lookupChanged: 'mdm.lookup.changed', settingsChanged: 'mdm.settings.changed', companyUpserted: 'mdm.company.upserted', vesselUpserted: 'mdm.vessel.upserted' },
  audit: { recorded: 'audit.recorded' },
  notifications: { notified: 'notifications.notified' },
  workflow: { requestSubmitted: 'workflow.request.submitted', requestDecided: 'workflow.request.decided', definitionPromoted: 'workflow.definition.promoted' },
  instruments: { issued: 'instruments.instrument.issued', revoked: 'instruments.instrument.revoked', suspended: 'instruments.instrument.suspended' },
  ships: { vesselRegistered: 'ships.vessel.registered', certIssued: 'ships.certificate.issued', registryClosed: 'ships.registry.closed' },
  seafarers: { certificateIssued: 'seafarers.certificate.issued', endorsed: 'seafarers.endorsed', seaServiceVerified: 'seafarers.sea-service.verified' },
  legislation: { instrumentPublished: 'legislation.instrument.published', instrumentWithdrawn: 'legislation.instrument.withdrawn' },
  maritimeCentre: { alertRaised: 'maritime-centre.alert.raised', positionUpdated: 'maritime-centre.position.updated', incidentOpened: 'maritime-centre.incident.opened', restrictionProposed: 'maritime-centre.restriction.proposed' },
  inspection: { closed: 'inspection.inspection.closed', deficiency: 'inspection.deficiency.raised', detention: 'inspection.detention.ordered', riskScored: 'inspection.risk.scored' },
  ports: { portCallScheduled: 'ports.portcall.scheduled', berthed: 'ports.portcall.berthed', socIssued: 'ports.soc.issued' },
  facilities: { licenceIssued: 'facilities.licence.issued', licenceSuspended: 'facilities.licence.suspended' },
  revenue: { invoiceIssued: 'revenue.invoice.issued', paymentReceived: 'revenue.payment.received' },
  integration: { externalSyncCompleted: 'integration.external-sync.completed' },
  scheduler: { slaBreached: 'scheduler.sla.breached', jobCompleted: 'scheduler.job.completed' },
  ai: { draftPrepared: 'ai.draft.prepared', decisionRecorded: 'ai.decision.recorded' },
} as const;

export const STREAM_NAME = 'MARITIME';
export const STREAM_PREFIX = 'maritime';
export const subjectFor = (type: string): string => `${STREAM_PREFIX}.${type}`;

export interface Actor { id: string; name?: string; email?: string; kind?: 'user' | 'agent' | 'system' }

/** CloudEvents-style envelope with correlation and causation ids. */
export interface EventEnvelope<T = unknown> {
  specversion: '1.0';
  id: string;
  type: string;
  source: string;
  subject?: string;
  time: string;
  datacontenttype: 'application/json';
  correlationid: string;
  causationid?: string;
  actor?: Actor;
  scope?: unknown;
  schemaversion: number;
  data: T;
}

export function makeEvent<T>(input: {
  type: string; source: string; data: T; subject?: string; correlationId?: string; causationId?: string; actor?: Actor; scope?: unknown; schemaVersion?: number;
}): EventEnvelope<T> {
  return {
    specversion: '1.0',
    id: randomUUID(),
    type: input.type,
    source: input.source,
    subject: input.subject,
    time: new Date().toISOString(),
    datacontenttype: 'application/json',
    correlationid: input.correlationId ?? randomUUID(),
    causationid: input.causationId,
    actor: input.actor,
    scope: input.scope,
    schemaversion: input.schemaVersion ?? 1,
    data: input.data,
  };
}
