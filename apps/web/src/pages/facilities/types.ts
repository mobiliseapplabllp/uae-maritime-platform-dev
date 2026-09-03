/* Port Companies API contract — the company directory (mdm) and the subject-agnostic instrument register (instruments service). */
import type { InstrumentClass, LicenseStatus, SubjectKind } from '@maritime/contracts';

export type { InstrumentClass, LicenseStatus, SubjectKind };
export type CompanyCategory = 'AGENCY' | 'TERMINAL_OPERATOR' | 'SERVICE_PROVIDER' | 'SUPPLIER' | 'INSTITUTE';
export type CompanyStatus = 'ACTIVE' | 'SUSPENDED' | 'BLACKLISTED' | 'INACTIVE';
/** GET /companies */
export interface Company {
  id: string; code: string; name: string; nameAr?: string | null; category: CompanyCategory; types: string[]; contactName: string; contactEmail: string; contactPhone: string; taxId: string; registrationNo: string;
  address: string; status: CompanyStatus; onboardedAt?: string | null; rating: number; real?: boolean; recordStatus?: string; createdAt?: string; updatedAt?: string;
}
/** Every issue check returns { check, passed, blocking, detail }; only a failed blocking check stops issue. */
export interface Check { check: string; passed: boolean; blocking: boolean; detail: string }
export interface HistoryEntry { from: string; to: string; at: string; by: string; note?: string }
export type AuditResult = 'SATISFACTORY' | 'OBSERVATIONS' | 'NON_CONFORMITY';
export interface LicenceAudit { date: string; auditorId?: string | null; auditor: string; result: AuditResult; remarks?: string }
export type EndorsementKind = 'ANNUAL' | 'INTERMEDIATE' | 'RENEWAL' | 'ADDITIONAL';
export type EndorsementResult = 'ENDORSED' | 'ENDORSED_WITH_CONDITIONS' | 'NOT_ENDORSED';
export interface Endorsement { kind: EndorsementKind; anniversary: string; completedOn: string; surveyor: string; organisation?: string; place?: string; result: EndorsementResult; remarks?: string }
export interface Verification { signed: boolean; valid: boolean; keyId: string | null; signedAt: string | null; reason: string }
export interface Signature { alg: string; keyId: string; value?: string; signedAt: string; verification?: Verification }
/** GET /licenses — one register row. */
export interface Licence {
  id: string; licenseNo: string; subjectKind: SubjectKind; subjectId: string | null; subjectRef?: string | null; subjectModel?: string | null; instrumentClass: InstrumentClass; classLabel: string;
  entityName: string; entityType: string; typeLabel: string; typeLabelAr?: string | null; status: LicenseStatus; issueChecks: Check[];
  contactPerson: string; phone: string; email: string; address: string; taxId: string; appliedDate: string; issueDate: string | null; expiryDate: string | null; conditions: string;
  performanceRating: number; audits: LicenceAudit[]; endorsements: Endorsement[]; signature?: Signature | null; history: HistoryEntry[]; issuer: string; requestId?: string | null; requestNo?: string | null; createdAt: string; updatedAt: string;
}
export type WindowState = 'ENDORSED' | 'OVERDUE' | 'DUE' | 'SCHEDULED';
export interface SurveyWindow { kind: EndorsementKind; anniversary: string; dueFrom: string; dueTo: string; completedOn?: string | null; surveyor?: string; result?: string; state: WindowState }
export interface EndorsementState { schedule: SurveyWindow[]; overdue: number; due: number; refused: number; next: SurveyWindow | null }
/** GET /licenses/:id — the row plus whether it is in force, where it stands against its survey schedule and whether its signature still matches. */
export interface LicenceDetail extends Licence { statutory: boolean; nonExpiring: boolean; convention: string; certificateName: string; inForce: boolean; forceReason: string; endorsementState: EndorsementState | null }
/** GET /licenses/:id/checks — the issue checks as they stand today. */
export interface ChecksResult { subjectKind: SubjectKind; subjectId: string | null; subjectLinked: boolean; checks: Check[]; blocking: number; canIssue: boolean }
/** GET /licenses/:id/endorsements */
export interface EndorsementsView { statutory: boolean; convention?: string; regime?: { annual: boolean; intermediate: boolean } | null; schedule: SurveyWindow[]; next?: SurveyWindow | null; overdue?: number; due?: number; refused?: number; recorded: Endorsement[]; inForce: boolean; reason: string }
export interface LicenceTypeMeta { value: string; label: string; labelAr?: string | null; instrumentClass: InstrumentClass; classLabel: string; statutory: boolean; termMonths: number; convention?: string | null; surveyRegime?: unknown; certificateName?: string | null }
/** GET /licenses/meta */
export interface LicenceMeta { subjectKinds: SubjectKind[]; classes: InstrumentClass[]; licenseTypes: string[]; typesBySubject: Record<string, string[]>; statuses: LicenseStatus[]; transitions: Record<string, string[]>; endorsementKinds: EndorsementKind[]; endorsementResults: EndorsementResult[]; statutoryTypes: string[]; types: LicenceTypeMeta[] }
/** POST /licenses */
export interface ApplicationPayload { subjectKind: SubjectKind; subjectRef?: string | null; entityType: string; entityName?: string; contactPerson?: string; phone?: string; email?: string; address?: string; taxId?: string; conditions?: string }
/** POST /licenses/:id/transition */
export interface TransitionPayload { to: LicenseStatus; note?: string; expiryDate?: string | null; override?: boolean }
/** POST /licenses/:id/audits */
export interface AuditPayload { date: string; auditor: string; result: AuditResult; remarks?: string }
/** POST /licenses/:id/endorsements */
export interface EndorsePayload { kind: EndorsementKind; completedOn?: string; surveyor?: string; organisation?: string; place?: string; result: EndorsementResult; remarks?: string; anniversary?: string }
export interface BerthOption { id: string; code: string; name?: string; terminal?: string }
