/** Declared state machines, enforced server-side. A transition table maps each state to its allowed successors. */
export type TransitionTable<S extends string> = Record<S, S[]>;

export function canTransition<S extends string>(table: TransitionTable<S>, from: S, to: S): boolean {
  const next = table[from];
  return Array.isArray(next) && next.includes(to);
}

export const PORTCALL_STATUS = ['ANNOUNCED', 'CONFIRMED', 'AT_ANCHORAGE', 'BERTHED', 'SAILED', 'CANCELLED'] as const;
export type PortCallStatus = (typeof PORTCALL_STATUS)[number];
export const PORTCALL_TRANSITIONS: TransitionTable<PortCallStatus> = {
  ANNOUNCED: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['AT_ANCHORAGE', 'BERTHED', 'CANCELLED'],
  AT_ANCHORAGE: ['BERTHED', 'CANCELLED'],
  BERTHED: ['SAILED'],
  SAILED: [],
  CANCELLED: [],
};

export const INSPECTION_TYPES = ['PSC', 'FSI', 'ISM', 'ISPS', 'MLC'] as const;
export const INSPECTION_STATUS = ['PLANNED', 'IN_PROGRESS', 'CLOSED'] as const;
export const INSPECTION_RESULTS = ['SATISFACTORY', 'DEFICIENCIES', 'DETAINED'] as const;

export const INVOICE_STATUS = ['DRAFT', 'ISSUED', 'PAID', 'CANCELLED'] as const;

export const INSTRUMENT_TYPES = ['ACT', 'RULES', 'CIRCULAR', 'NOTICE', 'ORDER', 'CONVENTION'] as const;
export const INSTRUMENT_STATUS = ['DRAFT', 'IN_FORCE', 'SUPERSEDED', 'WITHDRAWN'] as const;
export type InstrumentStatus = (typeof INSTRUMENT_STATUS)[number];
/** An instrument's life is a one-way street: a draft is put in force, an in-force instrument is superseded or withdrawn. */
export const INSTRUMENT_TRANSITIONS: TransitionTable<InstrumentStatus> = {
  DRAFT: ['IN_FORCE', 'WITHDRAWN'],
  IN_FORCE: ['SUPERSEDED', 'WITHDRAWN'],
  SUPERSEDED: [],
  WITHDRAWN: [],
};

export const LICENSE_STATUS = ['APPLIED', 'UNDER_REVIEW', 'ISSUED', 'REJECTED', 'SUSPENDED', 'REVOKED'] as const;
export type LicenseStatus = (typeof LICENSE_STATUS)[number];
export const LICENSE_TRANSITIONS: TransitionTable<LicenseStatus> = {
  APPLIED: ['UNDER_REVIEW', 'REJECTED'],
  UNDER_REVIEW: ['ISSUED', 'REJECTED'],
  ISSUED: ['SUSPENDED', 'REVOKED'],
  SUSPENDED: ['ISSUED', 'REVOKED'], // ISSUED here = reinstated
  REJECTED: [],
  REVOKED: [],
};

/** The service-request lifecycle — every service in the catalogue runs this same path. */
export const REQUEST_STATUS = ['DRAFT', 'SUBMITTED', 'UNDER_ASSESSMENT', 'INFO_REQUESTED', 'APPROVED', 'REJECTED', 'ISSUED', 'WITHDRAWN'] as const;
export type RequestStatus = (typeof REQUEST_STATUS)[number];
export const REQUEST_TRANSITIONS: TransitionTable<RequestStatus> = {
  DRAFT: ['SUBMITTED', 'WITHDRAWN'],
  SUBMITTED: ['UNDER_ASSESSMENT', 'WITHDRAWN'],
  UNDER_ASSESSMENT: ['INFO_REQUESTED', 'APPROVED', 'REJECTED'],
  INFO_REQUESTED: ['UNDER_ASSESSMENT', 'WITHDRAWN'],
  APPROVED: ['ISSUED'],
  REJECTED: [],
  ISSUED: [],
  WITHDRAWN: [],
};

export const REGISTRATION_KINDS = ['PROVISIONAL', 'PERMANENT', 'AMENDMENT', 'DELETION', 'BAREBOAT_IN', 'BAREBOAT_OUT', 'UNDER_CONSTRUCTION', 'RE_REGISTRATION'] as const;
export const REGISTRATION_STATUS = ['DRAFT', 'SUBMITTED', 'UNDER_SCRUTINY', 'CARVING_NOTE_ISSUED', 'SURVEY_COMPLETE', 'APPROVED', 'GRANTED', 'REJECTED', 'WITHDRAWN'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUS)[number];
export const REGISTRATION_TRANSITIONS: TransitionTable<RegistrationStatus> = {
  DRAFT: ['SUBMITTED', 'WITHDRAWN'],
  SUBMITTED: ['UNDER_SCRUTINY', 'REJECTED', 'WITHDRAWN'],
  UNDER_SCRUTINY: ['CARVING_NOTE_ISSUED', 'APPROVED', 'REJECTED'],
  CARVING_NOTE_ISSUED: ['SURVEY_COMPLETE', 'REJECTED'],
  SURVEY_COMPLETE: ['APPROVED', 'REJECTED'],
  APPROVED: ['GRANTED'],
  GRANTED: [],
  REJECTED: [],
  WITHDRAWN: [],
};
/** Where a ship stands on the flag's register. A bareboat charter in takes a foreign ship onto the flag for the charter; one out suspends a registered ship's entry while she flies the charterer's flag. */
export const REGISTRY_STATES = ['UNREGISTERED', 'PROVISIONAL', 'REGISTERED', 'BAREBOAT_IN', 'BAREBOAT_OUT', 'CLOSED'] as const;
/** The states in which a ship is a ship of this flag today. */
export const ON_REGISTER_STATES = ['PROVISIONAL', 'REGISTERED', 'BAREBOAT_IN'] as const;
export const livesOnRegister = (state: string | null | undefined): boolean => (ON_REGISTER_STATES as readonly string[]).includes(String(state ?? ''));
export const DELETION_REASONS = ['SOLD_FOREIGN', 'TRANSFER_OF_REGISTRY', 'BROKEN_UP', 'TOTAL_LOSS', 'MISSING', 'CEASED_TO_QUALIFY'] as const;
export const AMENDMENT_TYPES = ['NAME', 'OWNERSHIP', 'PORT_OF_REGISTRY', 'TONNAGE', 'ALTERATION', 'MANAGER', 'MORTGAGE'] as const;

export const INCIDENT_CATEGORIES = ['MARINE', 'HSE', 'SECURITY', 'ENVIRONMENT', 'EQUIPMENT', 'PERSONNEL', 'CARGO', 'NAVIGATION'] as const;
export const INCIDENT_TYPES = ['SAR', 'POLLUTION', 'OIL_SPILL', 'SECURITY_BREACH', 'CASUALTY', 'MEDICAL_EVAC', 'NEAR_MISS',
  'FIRE', 'COLLISION', 'GROUNDING', 'PERSONNEL_INJURY', 'EQUIPMENT_FAILURE', 'CARGO_DAMAGE', 'NAV_HAZARD', 'MOORING_FAILURE'] as const;
export const INCIDENT_STATUS = ['OPEN', 'ACKNOWLEDGED', 'RESPONDING', 'MONITORING', 'RESOLVED', 'CLOSED'] as const;
export type IncidentStatus = (typeof INCIDENT_STATUS)[number];
export const INCIDENT_SEVERITY = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
export const INCIDENT_PRIORITIES = ['P1', 'P2', 'P3', 'P4'] as const;
export const INCIDENT_SOURCES = ['VHF', 'PHONE', 'EMAIL', 'PATROL', 'PORTAL', 'CCTV', 'AIS'] as const;
export const INCIDENT_TRANSITIONS: TransitionTable<IncidentStatus> = {
  OPEN: ['ACKNOWLEDGED', 'RESPONDING'],
  ACKNOWLEDGED: ['RESPONDING', 'RESOLVED'],
  RESPONDING: ['MONITORING', 'RESOLVED'],
  MONITORING: ['RESPONDING', 'RESOLVED'],
  RESOLVED: ['CLOSED', 'RESPONDING'], // RESPONDING here = reopened
  CLOSED: ['RESPONDING'],
};

/** Golden-record lifecycle for master data (proposed → reviewed → published → superseded). */
export const GOLDEN_RECORD_STATUS = ['PROPOSED', 'REVIEWED', 'PUBLISHED', 'SUPERSEDED'] as const;
export type GoldenRecordStatus = (typeof GOLDEN_RECORD_STATUS)[number];
export const GOLDEN_RECORD_TRANSITIONS: TransitionTable<GoldenRecordStatus> = {
  PROPOSED: ['REVIEWED', 'SUPERSEDED'],
  REVIEWED: ['PUBLISHED', 'PROPOSED', 'SUPERSEDED'],
  PUBLISHED: ['SUPERSEDED'],
  SUPERSEDED: [],
};

/** Service-definition lifecycle for the low-code engine. */
export const DEFINITION_STATUS = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'PROMOTED', 'RETIRED'] as const;
export type DefinitionStatus = (typeof DEFINITION_STATUS)[number];
export const DEFINITION_TRANSITIONS: TransitionTable<DefinitionStatus> = {
  DRAFT: ['IN_REVIEW', 'RETIRED'],
  IN_REVIEW: ['APPROVED', 'DRAFT'],
  APPROVED: ['PROMOTED', 'DRAFT'],
  PROMOTED: ['RETIRED'],
  RETIRED: [],
};

/** Service-definition *version* lifecycle of the low-code engine, per environment; a version is promoted DEV → UAT → PROD and published in each. */
export const DEFINITION_ENVIRONMENTS = ['DEV', 'UAT', 'PROD'] as const;
export type DefinitionEnvironment = (typeof DEFINITION_ENVIRONMENTS)[number];
export const DEFINITION_VERSION_STATUS = ['DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'RETIRED'] as const;
export type DefinitionVersionStatus = (typeof DEFINITION_VERSION_STATUS)[number];
export const DEFINITION_VERSION_TRANSITIONS: TransitionTable<DefinitionVersionStatus> = {
  DRAFT: ['IN_REVIEW', 'RETIRED'],
  IN_REVIEW: ['APPROVED', 'DRAFT'],
  APPROVED: ['PUBLISHED', 'DRAFT'],
  PUBLISHED: ['RETIRED'],
  RETIRED: [],
};
export const WORKFLOW_STATE_KINDS = ['START', 'TASK', 'DECISION', 'END'] as const;
export const WORKFLOW_EFFECT_TYPES = ['computeFee', 'issueInstrument', 'notify', 'setField', 'requireDocuments', 'callService'] as const;
export const REQUEST_OPEN_STATUS: readonly RequestStatus[] = ['SUBMITTED', 'UNDER_ASSESSMENT', 'INFO_REQUESTED'];
export const REQUEST_CLOSED_STATUS: readonly RequestStatus[] = ['APPROVED', 'REJECTED', 'ISSUED', 'WITHDRAWN'];

/** Rule sets of the rules service: eligibility and validation checks, fee schedules and SLA clocks, each versioned. */
export const RULE_SET_KINDS = ['ELIGIBILITY', 'VALIDATION', 'FEE', 'SLA'] as const;
export type RuleSetKind = (typeof RULE_SET_KINDS)[number];
export const RULE_VERSION_STATUS = ['DRAFT', 'PUBLISHED', 'RETIRED'] as const;
export type RuleVersionStatus = (typeof RULE_VERSION_STATUS)[number];
export const RULE_VERSION_TRANSITIONS: TransitionTable<RuleVersionStatus> = {
  DRAFT: ['PUBLISHED', 'RETIRED'],
  PUBLISHED: ['RETIRED'],
  RETIRED: [],
};
