/* Ship-registration API contract — the shapes the ships service returns for the registry screens. */
export type RegistrationKind = 'PERMANENT' | 'PROVISIONAL' | 'AMENDMENT' | 'DELETION';
export type RegistrationStatus = 'DRAFT' | 'SUBMITTED' | 'UNDER_SCRUTINY' | 'CARVING_NOTE_ISSUED' | 'SURVEY_COMPLETE' | 'APPROVED' | 'GRANTED' | 'REJECTED' | 'WITHDRAWN';
export type RegistryState = 'UNREGISTERED' | 'PROVISIONAL' | 'REGISTERED' | 'CLOSED';
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
  status: RegistrationStatus; checks?: RegistryCheck[]; assignedTo?: string; officialNumber?: string; certificateNo?: string; grantedOn?: string | null; grantedBy?: string; certificateExpiresOn?: string | null;
  fee?: { amount: number; currency: string; paid: boolean }; decision?: { outcome: 'GRANTED' | 'REJECTED' | ''; by?: string; at?: string; reason?: string };
  submittedAt?: string | null; dueAt?: string | null; closedAt?: string | null; history: HistoryEntry[]; slaBreached: boolean; createdAt?: string;
}
export interface RegistrationDetailData extends Registration {
  vessel?: { id: string; name: string; imo: string; flag: string; grt: number; type: string; status: string; registry?: RegistryEntry } | null;
  requiredEvidence: EvidenceRequirement[]; shareLedger: ShareLedger;
}
export interface RegistrationChecks { applicationNo: string; kind: RegistrationKind; checks: RegistryCheck[]; blocked: RegistryCheck[] }
/** GET /registrations/reference — the jurisdiction's registry profile (registrar, statute, ports of registry, share rules, fees and evidence per journey). */
export interface RegistryReference {
  registrar: string; statute: string; nationalityRule: string; portsOfRegistry: { code: string; name: string; state?: string; default?: boolean }[]; defaultPort: string;
  shareRules: { denominator: number; maxOwners: number; confirmed: boolean; sources: string[] };
  kinds: { kind: RegistrationKind; slaDays: number; fee: number; currency: string; evidence: EvidenceRequirement[] }[]; provisionalValidityMonths: number;
}
/** GET /vessels/:id/transcript — the transcript of registry, assembled from the granted applications. */
export interface Transcript {
  vessel: { id: string; name: string; imo: string; flag: string; type: string; grt: number; built?: number }; registry: RegistryEntry; registrar: string;
  portOfRegistry: { code: string; name: string } | null; firstRegistered: string | null; tonnage: Tonnage | null; owners: RegisteredOwner[]; shareLedger: ShareLedger; encumbrances: Encumbrance[];
  closure: { reason?: string; newFlag?: string; certificateNo?: string; effectiveOn?: string | null } | null;
  entries: { applicationNo: string; kind: RegistrationKind; certificateNo?: string; grantedOn?: string | null; grantedBy?: string; note?: string }[];
}
