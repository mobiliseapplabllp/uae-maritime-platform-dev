/* Contracts are shared by the Node services and the browser build, so nothing here may reach for a
 * Node built-in: `crypto` is a global in both, and the manual v4 assembly is a defensive fallback. */
const randomUUID = (): string => {
  const c = globalThis.crypto;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};

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
    // the registry ledger: every transaction against an entry, and the attested transcripts issued from it
    registryTransaction: 'ships.registry.transaction', transcriptIssued: 'ships.registry.transcript',
    registryUpdated: 'ships.registry.updated', riskWeightsChanged: 'ships.risk.weights-changed',
  },
  seafarers: {
    certificateIssued: 'seafarers.certificate.issued', endorsed: 'seafarers.endorsed', seaServiceVerified: 'seafarers.sea-service.verified',
    // added by the seafarers service: the register itself, the document list, the service book and crew changes
    created: 'seafarers.seafarer.created', updated: 'seafarers.seafarer.updated', deleted: 'seafarers.seafarer.deleted',
    certificateUpdated: 'seafarers.certificate.updated', certificateDeleted: 'seafarers.certificate.deleted',
    seaServiceAdded: 'seafarers.sea-service.added', seaServiceDeleted: 'seafarers.sea-service.deleted',
    signedOn: 'seafarers.signed-on', signedOff: 'seafarers.signed-off',
    // the MET register, the safe manning scale, the FAL-5 crew list and the foreign seafarer ledger
    metInstitutionRegistered: 'seafarers.met.institution.registered', metInstitutionUpdated: 'seafarers.met.institution.updated', metAccreditationChanged: 'seafarers.met.accreditation.changed',
    programmeApproved: 'seafarers.met.programme.approved', programmeChanged: 'seafarers.met.programme.changed', programmeWithdrawn: 'seafarers.met.programme.withdrawn',
    manningScaleRecorded: 'seafarers.manning.recorded',
    crewListReceived: 'seafarers.crew-list.received', crewListChecked: 'seafarers.crew-list.checked', crewListCleared: 'seafarers.crew-list.cleared', crewListQueried: 'seafarers.crew-list.queried',
    foreignRecorded: 'seafarers.foreign.recorded', foreignReconciled: 'seafarers.foreign.reconciled',
  },
  legislation: {
    instrumentPublished: 'legislation.instrument.published', instrumentWithdrawn: 'legislation.instrument.withdrawn',
    // added by the legislation service: the drafting, review, clearance and approval chain, the register's own changes and the acknowledgement roll
    instrumentDrafted: 'legislation.instrument.drafted', instrumentUpdated: 'legislation.instrument.updated', instrumentDeleted: 'legislation.instrument.deleted',
    instrumentReviewed: 'legislation.instrument.reviewed', instrumentCleared: 'legislation.instrument.cleared', instrumentSuperseded: 'legislation.instrument.superseded',
    instrumentLinked: 'legislation.instrument.linked', instrumentUnlinked: 'legislation.instrument.unlinked', instrumentAttached: 'legislation.instrument.attached',
    acknowledgementRecorded: 'legislation.acknowledgement.recorded', acknowledgementRequested: 'legislation.acknowledgement.requested',
    // the IMO watch: what the monitored sources produced, and what the desk decided about each item
    sourcePolled: 'legislation.source.polled', sourceItemReceived: 'legislation.source.item-received', sourceItemAssessed: 'legislation.source.item-assessed',
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
    // the annual accreditation cycle and the inspection visits that feed a company's performance rating
    accreditationOpened: 'facilities.accreditation.opened', accreditationRenewed: 'facilities.accreditation.renewed', accreditationDue: 'facilities.accreditation.due',
    accreditationExpired: 'facilities.accreditation.expired', accreditationSuspended: 'facilities.accreditation.suspended', accreditationWithdrawn: 'facilities.accreditation.withdrawn',
    visitScheduled: 'facilities.visit.scheduled', visitCompleted: 'facilities.visit.completed', visitCancelled: 'facilities.visit.cancelled',
  },
  revenue: {
    invoiceIssued: 'revenue.invoice.issued', paymentReceived: 'revenue.payment.received',
    // added by the revenue service: the rest of the invoice lifecycle, the overdue sweep and rate-card changes
    invoiceDrafted: 'revenue.invoice.drafted', invoiceUpdated: 'revenue.invoice.updated', invoicePaid: 'revenue.invoice.paid', invoiceCancelled: 'revenue.invoice.cancelled', invoiceDeleted: 'revenue.invoice.deleted', invoiceOverdue: 'revenue.invoice.overdue', tariffChanged: 'revenue.tariff.changed',
  },
  integration: { externalSyncCompleted: 'integration.external-sync.completed' },
  scheduler: { slaBreached: 'scheduler.sla.breached', jobCompleted: 'scheduler.job.completed', sweepSla: 'scheduler.sweep.sla', digestCertificates: 'scheduler.digest.certificates', remindersLicences: 'scheduler.reminders.licences', digestInvoices: 'scheduler.digest.invoices', sweepAis: 'scheduler.sweep.ais', sweepDecisions: 'scheduler.sweep.decisions', sweepRetention: 'scheduler.sweep.retention', verifyAudit: 'scheduler.verify.audit', sweepAccreditations: 'scheduler.sweep.accreditations', pollImoSources: 'scheduler.poll.imo-sources' },
  ai: {
    draftPrepared: 'ai.draft.prepared', decisionRecorded: 'ai.decision.recorded',
    // added by the agentic runtime: the escalation the autonomy ladder forced, the human outcome on it, and every change to what an agent is allowed to do
    decisionEscalated: 'ai.decision.escalated', decisionReviewed: 'ai.decision.reviewed', decisionOverridden: 'ai.decision.overridden',
    agentConfigured: 'ai.agent.configured', agentSuspended: 'ai.agent.suspended', agentRan: 'ai.agent.ran',
    // added by the assistant: an answer given from the platform's own records, with the records it cited
    answered: 'ai.assistant.answered', conversationStarted: 'ai.assistant.conversation-started',
    // added by the model platform: the registry lifecycle, and the two things a model can do wrong quietly —
    // answer slower than the platform committed to, and start being asked about a different world than it was fitted to
    modelRegistered: 'ai.model.registered', modelApproved: 'ai.model.approved', modelDeployed: 'ai.model.deployed',
    modelRetired: 'ai.model.retired', modelDrifted: 'ai.model.drifted', inferenceBreached: 'ai.inference.breached',
  },
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
