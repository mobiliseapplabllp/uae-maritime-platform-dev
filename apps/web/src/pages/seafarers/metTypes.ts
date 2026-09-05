/* Phase 3 crew-domain contracts: the MET register, the safe manning scale, the FAL-5 crew list and the foreign
 * seafarer ledger, as the seafarers service returns them. Field names follow the service's API shapes. */

export type AccreditationStatus = 'NONE' | 'CURRENT' | 'DUE' | 'EXPIRED' | 'SUSPENDED' | 'WITHDRAWN';
export type InstitutionStatus = 'ACTIVE' | 'SUSPENDED' | 'CLOSED';
export type ProgrammeStatus = 'PENDING' | 'APPROVED' | 'SUSPENDED' | 'WITHDRAWN';
export interface Programme {
  id: string; institutionId: string; programme: string; title: string; regulation: string; seatsPerIntake: number; intakesPerYear: number; seatsPerYear: number;
  status: ProgrammeStatus; statusReason: string; approvalNo: string; instrumentId: string | null; approvedOn: string | null; expiresOn: string | null; expired: boolean; remarks: string;
}
export interface Institution {
  id: string; companyId: string; code: string; name: string; nameAr: string; institutionType: string; city: string; address: string; contactName: string; contactEmail: string; contactPhone: string;
  status: InstitutionStatus; statusReason: string;
  accreditation: { status: AccreditationStatus; reason: string; instrumentId: string | null; instrumentNo: string; cycleId: string | null; cycleNo: number; from: string | null; until: string | null; daysLeft: number | null };
  accredited: boolean; instructors: number; capacity: number; simulators: string[]; qualitySystem: string; establishedOn: string | null; remarks: string;
  programmes: Programme[]; programmeCount: number; approvedProgrammes: number; pendingProgrammes: number; suspendedProgrammes: number; seatsPerYear: number; createdAt: string; updatedAt: string;
}
export interface MetDashboard {
  kpis: { institutions: number; accredited: number; due: number; expired: number; suspended: number; unaccredited: number; programmes: number; approved: number; pending: number; suspendedProgrammes: number; seatsPerYear: number; instructors: number; simulatorCentres: number; programmesOffered: number; programmesInMaster: number };
  byType: { institutionType: string; institutions: number; accredited: number }[];
  byProgramme: { programme: string; title: string; titleAr: string | null; regulation: string; simulator: boolean; providers: number; seatsPerYear: number }[];
  attention: { id: string; code: string; name: string; accreditationStatus: AccreditationStatus; daysLeft: number | null; suspendedProgrammes: number; pendingProgrammes: number; reason: string }[];
  generatedAt: string;
}
export interface MetReference { institutionTypes: { code: string; label: string; labelAr: string | null }[]; programmes: { code: string; label: string; labelAr: string | null; regulation: string; hours: number | null; simulator: boolean }[]; schemes: string[]; institutionStatuses: InstitutionStatus[]; accreditationStatuses: AccreditationStatus[]; programmeStatuses: ProgrammeStatus[] }

export interface ScaleRow { rankCode: string; rank: string; count: number; cocGrade: string; cocGradeLabel: string; notes: string }
export interface ManningCheck { rows: { rankCode: string; rank: string; required: number; listed: number; shortfall: number }[]; required: number; listed: number; shortfalls: number; ok: boolean; unscheduled: { rankCode: string; rank: string; listed: number }[] }
export interface ManningScale {
  id: string | null; vesselId: string; vesselName: string; imo: string; msmdNo: string; instrumentId: string | null; issuedOn: string | null; expiresOn: string | null; tradingArea: string; tradingAreaLabel: string;
  rows: ScaleRow[]; total: number; officers: number; recorded: boolean; documented: boolean; remarks: string; recordedBy: string; compliance: ManningCheck | null; onBoard?: { id: string; name: string; rank: string; rankCode: string }[]; createdAt: string | null; updatedAt: string | null;
}
export interface ScalePayload { tradingArea: string; msmdNo?: string; issuedOn?: string | null; expiresOn?: string | null; remarks?: string; rows: { rank: string; count: number; cocGrade?: string; notes?: string }[] }

export type ListStatus = 'RECEIVED' | 'CHECKED' | 'CLEARED' | 'QUERIED';
export type LineMatch = 'REGISTER' | 'FOREIGN' | 'UNREGISTERED_NATIONAL';
export interface CrewLine {
  id: string; seq: number; familyName: string; givenNames: string; name: string; rank: string; rankCode: string; nationality: string; dob: string | null; pob: string; gender: string;
  idType: string; idNumber: string; idExpiry: string | null; cdcNo: string; match: LineMatch; seafarerId: string | null; foreignId: string | null; issues: string[];
}
export interface Checks {
  manning: ManningCheck | null; scaleRecorded: boolean; msmdNo: string;
  documents: { seq: number; name: string; rank: string; failures: string[] }[]; identity: { seq: number; name: string; issue: string }[]; endorsements: { seq: number; name: string; rank: string; issue: string }[];
  unregisteredNationals: { seq: number; name: string; rank: string }[]; unknownRanks: { seq: number; name: string; rank: string }[];
  declaration: { declared: number | null; listed: number; matches: boolean | null }; nationalFlag: boolean; summary: string[]; ok: boolean; checkedAt: string;
}
export interface CrewList {
  id: string; number: string; vcn: string; portCallId: string | null; vesselId: string; vesselName: string; imo: string; port: string; movement: 'ARRIVAL' | 'DEPARTURE'; date: string; source: string; sourceLabel: string;
  agentCode: string; agentName: string; submittedBy: string; declaredCrew: number | null; rowCount: number; matched: number; foreignCount: number; flagged: number; status: ListStatus;
  checks: Checks | null; ok: boolean | null; checkedAt: string | null; checkedBy: string; decidedAt: string | null; decidedBy: string; decisionNote: string; remarks: string; rows?: CrewLine[]; createdAt: string; updatedAt: string;
}
export interface CrewLinePayload { familyName: string; givenNames: string; rank: string; nationality: string; dob?: string | null; pob?: string; gender?: string; idType?: string; idNumber: string; idExpiry?: string | null; cdcNo?: string }
export interface CrewListPayload { vcn?: string; vesselId?: string; movement: 'ARRIVAL' | 'DEPARTURE'; date?: string | null; source: string; declaredCrew?: number | null; remarks?: string; rows: CrewLinePayload[] }
export interface CrewListDashboard {
  kpis: { lists: number; last30Days: number; received: number; checked: number; cleared: number; queried: number; passing: number; shortOfManning: number; unregisteredNationals: number; linesRead: number; registerMatched: number; foreignLines: number; ledger: number; ledgerWatch: number; ledgerReconciled: number; repeatAppearances: number };
  bySource: { source: string; label: string; lists: number }[];
  attention: { id: string; number: string; vesselName: string; vcn: string; date: string; status: ListStatus; summary: string[] }[];
  generatedAt: string;
}
export interface CrewListReference { sources: { code: string; label: string; labelAr: string | null }[]; tradingAreas: { code: string; label: string; labelAr: string | null }[]; statuses: ListStatus[]; movements: string[]; matches: LineMatch[]; ledgerStatuses: string[]; strictClearance: boolean; watchAppearances: number }

export type LedgerStatus = 'LEDGER' | 'WATCH' | 'RECONCILED' | 'REGISTERED';
export interface ForeignSeafarer {
  id: string; idType: string; idNumber: string; familyName: string; givenNames: string; name: string; nationality: string; dob: string | null; idExpiry: string | null; idExpired: boolean; cdcNo: string;
  lastRank: string; lastRankCode: string; firstSeenAt: string; lastSeenAt: string; appearances: number; vessels: { vesselId: string; vesselName: string; vcn: string; date: string; rank: string }[]; distinctVessels: number;
  status: LedgerStatus; statusReason: string; reconciledSeafarerId: string | null; reconciledAt: string | null; reconciledBy: string;
  endorsement: { number: string; issuer: string; expiryDate: string | null; valid: boolean } | null; remarks: string; createdAt: string; updatedAt: string;
  appearanceList?: { crewListId: string; number: string; vcn: string; vesselName: string; date: string; rank: string; issues: string[]; listStatus: ListStatus }[];
}
