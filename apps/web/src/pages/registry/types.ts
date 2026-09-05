/* Ship-registration API contract — the shapes the ships service returns for the registry screens. */
/** The variant codes are the `registrationKind` master's; the four the reference product shipped with are named for the screens that special-case them. */
export type RegistrationKind = 'PERMANENT' | 'PROVISIONAL' | 'AMENDMENT' | 'DELETION' | 'BAREBOAT_IN' | 'BAREBOAT_OUT' | 'UNDER_CONSTRUCTION' | 'TEMPORARY_PASS' | 'RE_REGISTRATION' | (string & {});
export type RegistrationStatus = 'DRAFT' | 'SUBMITTED' | 'UNDER_SCRUTINY' | 'CARVING_NOTE_ISSUED' | 'SURVEY_COMPLETE' | 'APPROVED' | 'GRANTED' | 'REJECTED' | 'WITHDRAWN';
export type RegistryState = 'UNREGISTERED' | 'PROVISIONAL' | 'REGISTERED' | 'BAREBOAT_IN' | 'BAREBOAT_OUT' | 'CLOSED';
export interface RegisteredOwner { name: string; address?: string; nationality?: string; shares: number; kind: 'INDIVIDUAL' | 'BODY_CORPORATE' | 'COOPERATIVE_SOCIETY'; pan?: string; cin?: string; companyId?: string | null }
export interface EvidenceItem { id: string; key: string; label?: string; reference?: string; issuedBy?: string; issuedOn?: string | null; fileName?: string; verified: boolean; verifiedBy?: string; verifiedAt?: string | null; createdAt?: string }
export interface EvidenceRequirement { key: string; label: string; mandatory: boolean; when?: string }
export interface Encumbrance { id: string; kind: 'MORTGAGE' | 'LIEN' | 'CHARGE'; holder: string; amount?: number; currency?: string; registeredOn?: string | null; dischargedOn?: string | null; reference?: string }
export interface CarvingNote { number?: string; issuedOn?: string | null; issuedBy?: string; compliedOn?: string | null; surveyor?: string; remarks?: string }
export interface Tonnage { gross?: number; net?: number; measuredBy?: string; certificateNo?: string; measuredOn?: string | null }
export interface RegistryCheck { check: string; passed: boolean; blocking: boolean; detail: string }
export interface HistoryEntry { from?: string; to: string; at: string; by: string; note?: string }
export interface ShareLedger { denominator: number; held: number; balanced: boolean; owners: number; maxOwners: number; withinLimit: boolean }
export interface RegistryEntry { state: RegistryState; officialNumber?: string; portOfRegistry?: string; certificateNo?: string; registeredOn?: string | null; certificateExpiresOn?: string | null; closedOn?: string | null; closureReason?: string }
/** One application to the registrar — list row and detail record share this shape; the detail adds the resolved vessel, evidence requirements and share ledger. */
export interface Registration {
  id: string; applicationNo: string; kind: RegistrationKind; vesselId: string; vesselName: string; imo: string; portOfRegistry: string; portOfRegistryName?: string;
  applicant?: { name: string; email?: string; phone?: string; capacity?: string }; owners: RegisteredOwner[]; tonnage?: Tonnage;
  previousFlag?: string; previousRegistry?: string; previousOfficialNumber?: string; evidence: EvidenceItem[]; encumbrances: Encumbrance[]; carvingNote?: CarvingNote;
  amendment?: { types?: string[]; before?: Record<string, unknown>; after?: Record<string, unknown>; approvalReference?: string };
  deletion?: { reason?: string; newFlag?: string; effectiveOn?: string | null; certificateNo?: string; issuedOn?: string | null };
  /** Variant-specific particulars: the charter for a bareboat in or out, the voyage for a temporary pass, the yard for a ship under construction. */
  particulars?: Record<string, unknown>;
  status: RegistrationStatus; checks?: RegistryCheck[]; assignedTo?: string; officialNumber?: string; certificateNo?: string; grantedOn?: string | null; grantedBy?: string; certificateExpiresOn?: string | null;
  fee?: { amount: number; currency: string; paid: boolean }; decision?: { outcome: 'GRANTED' | 'REJECTED' | ''; by?: string; at?: string; reason?: string };
  submittedAt?: string | null; dueAt?: string | null; closedAt?: string | null; history: HistoryEntry[]; slaBreached: boolean; createdAt?: string;
}
/** What the master says about the variant this file belongs to. */
export interface KindRuleSummary { code: string; label: string; labelAr?: string | null; family: 'FIRST' | 'ALTER' | 'OUT' | 'CLOSE' | 'DOCUMENT'; carving: boolean; issuesCertificate: boolean; validityMonths: number | null; registryState: string | null }
export interface RegistrationDetailData extends Registration {
  rule?: KindRuleSummary | null;
  vessel?: { id: string; name: string; imo: string; flag: string; grt: number; type: string; status: string; registry?: RegistryEntry } | null;
  requiredEvidence: EvidenceRequirement[]; shareLedger: ShareLedger;
}
export interface RegistrationChecks { applicationNo: string; kind: RegistrationKind; checks: RegistryCheck[]; blocked: RegistryCheck[] }
/** GET /registrations/reference — the jurisdiction's registry profile (registrar, statute, ports of registry, share rules, fees and evidence per journey). */
export interface RegistryReference {
  registrar: string; statute: string; nationalityRule: string; portsOfRegistry: { code: string; name: string; state?: string; default?: boolean }[]; defaultPort: string;
  shareRules: { denominator: number; maxOwners: number; confirmed: boolean; sources: string[] };
  kinds: { kind: RegistrationKind; label?: string; labelAr?: string | null; family?: string; slaDays: number; fee: number; currency: string; evidence: EvidenceRequirement[]; validityMonths?: number | null; registryState?: string | null; carving?: boolean; series?: string }[]; provisionalValidityMonths: number; registryStates?: string[];
}
/** GET /vessels/:id/transcript — the transcript of registry, assembled from the granted applications. */
export interface Transcript {
  vessel: { id: string; name: string; imo: string; flag: string; type: string; grt: number; built?: number }; registry: RegistryEntry; registrar: string;
  portOfRegistry: { code: string; name: string } | null; firstRegistered: string | null; tonnage: Tonnage | null; owners: RegisteredOwner[]; shareLedger: ShareLedger; encumbrances: Encumbrance[];
  closure: { reason?: string; newFlag?: string; certificateNo?: string; effectiveOn?: string | null } | null;
  entries: { applicationNo: string; kind: RegistrationKind; certificateNo?: string; grantedOn?: string | null; grantedBy?: string; note?: string }[];
}

/* ---- The registry ledger and the master record (ships service, /vessels/:id/registry) ---- */
export interface RegistryTransaction { id: string; number: string; vesselId: string; vesselName: string; officialNumber: string; type: string; registrationId: string | null; applicationNo: string; particulars: Record<string, any>; status: string; recordedOn: string; recordedBy: string; notes: string; digest: string | null }
export interface RegistryEncumbrance { id: string; kind: string; holder: string; amount: number; currency: string; registeredOn: string; dischargedOn: string | null; reference: string; live: boolean; transactionId?: string | null }
export interface TransactionType { code: string; label: string; labelAr: string | null; affectsTitle: boolean; requiresConsent: boolean; direct: boolean; feeCode: string }
export interface TranscriptAttestation { number: string; issuedOn: string; issuedBy: string; registrar: string; purpose: string; digest: string; transactionNo: string }
export interface TranscriptVerification { transcriptNo: string; issuedOn: string | null; issuedBy: string; digest: string; matches: boolean; transactionsSince: number; reason: string }
export interface MasterRecord {
  vessel: { id: string; name: string; imo: string; flag: string; type: string; grt: number; dwt?: number; built?: number; callSign?: string; mmsi?: string; classSociety?: string; owner: string; operator: string; manager: string; status: string };
  registry: RegistryEntry; portOfRegistry: { code: string; name: string } | null; registrar: string; onRegister: boolean; firstRegistered: string | null;
  currentEntry: { applicationNo: string; kind: string; certificateNo: string; grantedOn: string | null; expiresOn: string | null; particulars: Record<string, any> } | null;
  owners: RegisteredOwner[]; shareLedger: ShareLedger; tonnage: Tonnage | null; encumbrances: RegistryEncumbrance[]; dischargedEncumbrances: RegistryEncumbrance[];
  caveats: RegistryTransaction[]; titleBlocked: boolean; closure: { reason?: string; newFlag?: string; certificateNo?: string; effectiveOn?: string | null } | null;
  applications: Registration[]; certificates: { certificateNo: string; kind: string; series: string; grantedOn: string | null; expiresOn: string | null; applicationNo: string }[];
  transactions: RegistryTransaction[]; transcripts: { transcriptNo: string; issuedOn: string; issuedBy: string; purpose: string; digest: string | null }[]; generatedAt: string;
}
