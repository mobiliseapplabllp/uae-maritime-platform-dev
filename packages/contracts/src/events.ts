import { randomUUID } from 'node:crypto';

/** Domain event subjects. Streams carry `maritime.<subject>`; consumers subscribe by prefix. */
export const EVENTS = {
  identity: { roleChanged: 'identity.role.changed', userChanged: 'identity.user.changed' },
  mdm: { goldenUpdated: 'mdm.golden.updated', lookupChanged: 'mdm.lookup.changed', settingsChanged: 'mdm.settings.changed', companyUpserted: 'mdm.company.upserted', vesselUpserted: 'mdm.vessel.upserted' },
  audit: { recorded: 'audit.recorded' },
  notifications: { notified: 'notifications.notified' },
  documents: { uploaded: 'documents.document.uploaded', scanned: 'documents.document.scanned', deleted: 'documents.document.deleted', legalHoldChanged: 'documents.document.legal-hold-changed', purged: 'documents.document.purged' },
  workflow: {
    requestSubmitted: 'workflow.request.submitted', requestDecided: 'workflow.request.decided', definitionPromoted: 'workflow.definition.promoted',
    // added by the service engine: every request mutation and every definition lifecycle step is an event
    requestCreated: 'workflow.request.created', requestTransitioned: 'workflow.request.transitioned', requestIssued: 'workflow.request.issued',
    requestNotify: 'workflow.request.notify', requestAssigned: 'workflow.request.assigned', requestDocument: 'workflow.request.document',
    requestNoted: 'workflow.request.noted', requestSlaBreached: 'workflow.request.sla-breached', requestInstrumentLinked: 'workflow.request.instrument-linked',
    definitionCreated: 'workflow.definition.created', definitionUpdated: 'workflow.definition.updated', definitionReviewRequested: 'workflow.definition.review-requested',
    definitionApproved: 'workflow.definition.approved', definitionPublished: 'workflow.definition.published', definitionRetired: 'workflow.definition.retired',
  },
  rules: { rulesetCreated: 'rules.ruleset.created', versionDrafted: 'rules.ruleset.drafted', versionUpdated: 'rules.ruleset.updated', published: 'rules.ruleset.published', retired: 'rules.ruleset.retired' },
  instruments: {
    applied: 'instruments.instrument.applied', issued: 'instruments.instrument.issued', reinstated: 'instruments.instrument.reinstated', rejected: 'instruments.instrument.rejected',
    suspended: 'instruments.instrument.suspended', revoked: 'instruments.instrument.revoked', updated: 'instruments.instrument.updated', deleted: 'instruments.instrument.deleted',
    audited: 'instruments.instrument.audited', endorsed: 'instruments.instrument.endorsed', endorsementRefused: 'instruments.instrument.endorsement-refused', expiring: 'instruments.instrument.expiring',
  },
  ships: {
    vesselRegistered: 'ships.vessel.registered', certIssued: 'ships.certificate.issued', registryClosed: 'ships.registry.closed',
    // added by the ships service: every change to a ship, to its certificate list and to its file with the registrar
    vesselCreated: 'ships.vessel.created', vesselUpdated: 'ships.vessel.updated', vesselDeleted: 'ships.vessel.deleted',
    certUpdated: 'ships.certificate.updated', certDeleted: 'ships.certificate.deleted',
    registrationLodged: 'ships.registration.lodged', registrationUpdated: 'ships.registration.updated', registrationTransitioned: 'ships.registration.transitioned',
    registrationGranted: 'ships.registration.granted', registrationDeleted: 'ships.registration.deleted',
    registryUpdated: 'ships.registry.updated', riskWeightsChanged: 'ships.risk.weights-changed',
  },
  seafarers: {
    certificateIssued: 'seafarers.certificate.issued', endorsed: 'seafarers.endorsed', seaServiceVerified: 'seafarers.sea-service.verified',
    // added by the seafarers service: the register itself, the document list, the service book and crew changes
    created: 'seafarers.seafarer.created', updated: 'seafarers.seafarer.updated', deleted: 'seafarers.seafarer.deleted',
    certificateUpdated: 'seafarers.certificate.updated', certificateDeleted: 'seafarers.certificate.deleted',
    seaServiceAdded: 'seafarers.sea-service.added', seaServiceDeleted: 'seafarers.sea-service.deleted',
    signedOn: 'seafarers.signed-on', signedOff: 'seafarers.signed-off',
  },
  legislation: {
    instrumentPublished: 'legislation.instrument.published', instrumentWithdrawn: 'legislation.instrument.withdrawn',
    // added by the legislation service: the drafting, review, clearance and approval chain, the register's own changes and the acknowledgement roll
    instrumentDrafted: 'legislation.instrument.drafted', instrumentUpdated: 'legislation.instrument.updated', instrumentDeleted: 'legislation.instrument.deleted',
    instrumentReviewed: 'legislation.instrument.reviewed', instrumentCleared: 'legislation.instrument.cleared', instrumentSuperseded: 'legislation.instrument.superseded',
    instrumentLinked: 'legislation.instrument.linked', instrumentUnlinked: 'legislation.instrument.unlinked', instrumentAttached: 'legislation.instrument.attached',
    acknowledgementRecorded: 'legislation.acknowledgement.recorded', acknowledgementRequested: 'legislation.acknowledgement.requested',
  },
  maritimeCentre: {
    alertRaised: 'maritime-centre.alert.raised', positionUpdated: 'maritime-centre.position.updated', incidentOpened: 'maritime-centre.incident.opened', restrictionProposed: 'maritime-centre.restriction.proposed',
    // added by the maritime-centre service: every change to a case file, to the threads hanging off it, and to the surveillance picture
    incidentUpdated: 'maritime-centre.incident.updated', incidentTransitioned: 'maritime-centre.incident.transitioned', incidentAssigned: 'maritime-centre.incident.assigned',
    incidentResolved: 'maritime-centre.incident.resolved', incidentClosed: 'maritime-centre.incident.closed', incidentDeleted: 'maritime-centre.incident.deleted',
    incidentCommLogged: 'maritime-centre.incident.comm-logged', incidentTaskAdded: 'maritime-centre.incident.task-added', incidentTaskUpdated: 'maritime-centre.incident.task-updated',
    incidentDocumentAdded: 'maritime-centre.incident.document-added', incidentNoted: 'maritime-centre.incident.noted',
    alertAcknowledged: 'maritime-centre.alert.acknowledged', restrictionDecided: 'maritime-centre.restriction.decided',
  },
  inspection: {
    closed: 'inspection.inspection.closed', deficiency: 'inspection.deficiency.raised', detention: 'inspection.detention.ordered', riskScored: 'inspection.risk.scored',
    // added by the inspection service: every step of a survey, its findings, its detention and the checklist templates it is worked from
    planned: 'inspection.inspection.planned', updated: 'inspection.inspection.updated', started: 'inspection.inspection.started', deleted: 'inspection.inspection.deleted',
    detentionReleased: 'inspection.detention.released', deficiencyUpdated: 'inspection.deficiency.updated', deficiencyRectified: 'inspection.deficiency.rectified', deficiencyWithdrawn: 'inspection.deficiency.withdrawn',
    checklistScored: 'inspection.checklist.scored', templateCreated: 'inspection.template.created', templateUpdated: 'inspection.template.updated', templateActivated: 'inspection.template.activated', templateDeleted: 'inspection.template.deleted',
  },
  ports: {
    portCallScheduled: 'ports.portcall.scheduled', berthed: 'ports.portcall.berthed', socIssued: 'ports.soc.issued',
    // added by the ports service: every lifecycle step of a call, and the estate and marine-craft changes the harbour desk makes
    confirmed: 'ports.portcall.confirmed', anchored: 'ports.portcall.anchored', sailed: 'ports.portcall.sailed', cancelled: 'ports.portcall.cancelled',
    updated: 'ports.portcall.updated', deleted: 'ports.portcall.deleted', berthChanged: 'ports.berth.changed', berthOutageRecorded: 'ports.berth.outage-recorded', resourceChanged: 'ports.resource.changed',
  },
  facilities: {
    licenceIssued: 'facilities.licence.issued', licenceSuspended: 'facilities.licence.suspended',
    // added by the facilities service: the regulated-company overlay on the golden record, the port-facility register and the compliance record kept on both
    companyRegistered: 'facilities.company.registered', companyUpdated: 'facilities.company.updated', companyDeleted: 'facilities.company.deleted',
    companyStatusChanged: 'facilities.company.status-changed', companySuspended: 'facilities.company.suspended', companyBlacklisted: 'facilities.company.blacklisted',
    companyAudited: 'facilities.company.audited', companyRated: 'facilities.company.rated',
    facilityRegistered: 'facilities.facility.registered', facilityUpdated: 'facilities.facility.updated', facilityDeleted: 'facilities.facility.deleted',
    facilityIspsChanged: 'facilities.facility.isps-changed', facilityAudited: 'facilities.facility.audited',
    obligationRaised: 'facilities.obligation.raised', obligationCleared: 'facilities.obligation.cleared', renewalDue: 'facilities.renewal.due',
  },
  revenue: {
    invoiceIssued: 'revenue.invoice.issued', paymentReceived: 'revenue.payment.received',
    // added by the revenue service: the rest of the invoice lifecycle, the overdue sweep and rate-card changes
    invoiceDrafted: 'revenue.invoice.drafted', invoiceUpdated: 'revenue.invoice.updated', invoicePaid: 'revenue.invoice.paid', invoiceCancelled: 'revenue.invoice.cancelled', invoiceDeleted: 'revenue.invoice.deleted', invoiceOverdue: 'revenue.invoice.overdue', tariffChanged: 'revenue.tariff.changed',
  },
  integration: { externalSyncCompleted: 'integration.external-sync.completed' },
  scheduler: { slaBreached: 'scheduler.sla.breached', jobCompleted: 'scheduler.job.completed', sweepSla: 'scheduler.sweep.sla', digestCertificates: 'scheduler.digest.certificates', remindersLicences: 'scheduler.reminders.licences', digestInvoices: 'scheduler.digest.invoices', sweepAis: 'scheduler.sweep.ais', sweepDecisions: 'scheduler.sweep.decisions', sweepRetention: 'scheduler.sweep.retention', verifyAudit: 'scheduler.verify.audit' },
  ai: { draftPrepared: 'ai.draft.prepared', decisionRecorded: 'ai.decision.recorded' },
  /** Read-model snapshots: every domain service publishes the API-shaped record after each change so reporting and search stay current. data = { kind, entity } / { kind, id }. */
  readModel: { upserted: 'readmodel.upserted', deleted: 'readmodel.deleted' },
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
