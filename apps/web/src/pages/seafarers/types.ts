/* Crew module API contract — the shapes the seafarers service returns for the crew screens. Field names follow the shared world model. */
import type { CertStatus } from '../vessels/types';

export type { CertStatus };
export type SeafarerStatus = 'ACTIVE' | 'SHORE_LEAVE' | 'SIGNED_OFF' | 'SUSPENDED';
export interface SeafarerCertificate { id: string; certType: string; grade?: string; number?: string; issuer?: string; issueDate?: string | null; expiryDate: string; remarks?: string; status: CertStatus }
export interface SeaServiceRecord { id: string; vesselId?: string | null; vesselName: string; imo?: string; rank: string; from: string; to: string; verified: boolean; remarks?: string }
/** GET /seafarers — one register row; the certificate summary and the sea-day total are computed server-side. */
export interface SeafarerRow {
  id: string; cdcNo: string; seafarerId?: string; seafarerIdLabel?: string; nationalId?: string; nationalIdLabel?: string; name: string; dob?: string | null; nationality?: string; rank: string;
  phone?: string; email?: string; status: SeafarerStatus; currentVesselId?: string | null; currentVesselName?: string | null; signedOnAt?: string | null; remarks?: string; certAlerts: number; totalSeaDays: number;
  /** The licensed recruitment and placement service holding the engagement; null for a direct engagement. */
  manningAgentCode?: string; manningAgentName?: string; manningAgent?: { code: string; name: string } | null;
}
/** GET /seafarers/:id — the record with its documents and service history. */
export interface Seafarer extends SeafarerRow { certificates: SeafarerCertificate[]; seaService: SeaServiceRecord[] }
/** GET /seafarers/dashboard */
export interface CrewDashboardData {
  kpis: { roll: number; onboard: number; ashore: number; medicalIssues: number; avgSeaDays: number; medicalWindow: number };
  byRank: { rank: string; count: number }[]; funnel: { expired: number; d30: number; d90: number; valid: number };
  alertList: { id: string; name: string; rank: string; vessel: string; alerts: number }[];
}
/** POST /seafarers/:id/sign-on — a 422 carries the failed document checks. */
export interface SignOnPayload { vesselId: string; rank?: string; override?: boolean; overrideReason?: string }
export interface SignOnGate { failures: string[] }
export interface SignOffResult { signedOff: boolean; seaServiceDays: number }
/** POST/PUT /seafarers/:id/certificates[/:certId] */
export interface CertificatePayload { certType: string; grade?: string; number?: string; issuer?: string; issueDate?: string; expiryDate: string; remarks?: string }
/** POST /seafarers/:id/service */
export interface SeaServicePayload { vesselName: string; imo?: string; rank: string; from: string; to: string; verified?: boolean; remarks?: string }
export interface VesselOption { id: string; name: string; imo: string }
/** GET /audit?entity=Seafarer&entityId=:id — the change trail shown on the record. */
export interface AuditEntry { id: string; at: string; action: string; entity?: string; entityLabel?: string | null; note?: string | null; actor: { id: string; name: string; email?: string; kind?: string } }
