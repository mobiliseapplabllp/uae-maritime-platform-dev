/* Fleet Manager API contract — the shapes the ships service returns for the vessel screens. */
export type CertStatus = 'VALID' | 'EXPIRING' | 'EXPIRED';
export type RegistryState = 'UNREGISTERED' | 'PROVISIONAL' | 'REGISTERED' | 'CLOSED';
export interface Lookup { id: string; category: string; code: string; label: string; active?: boolean }
export interface VesselCertificate { id: string; certType: string; number?: string; issuer?: string; issueDate?: string | null; expiryDate: string; remarks?: string; status: CertStatus }
export interface VesselRegistryEntry { state: RegistryState; officialNumber?: string; portOfRegistry?: string; certificateNo?: string; registeredOn?: string | null; certificateExpiresOn?: string | null; closedOn?: string | null; closureReason?: string }
export interface Vessel {
  id: string; name: string; imo: string; mmsi?: string; callSign?: string; flag: string; type: string; built?: number; dwt?: number; grt: number; loa?: number; beam?: number; maxDraft?: number;
  owner?: string; operator?: string; manager?: string; agent?: string; agentName?: string; classSociety?: string; piClub?: string; portOfRegistry?: string; yard?: string;
  engine?: { maker?: string; model?: string; powerKW?: number }; serviceSpeedKn?: number; teuCapacity?: number; lastDryDock?: string | null; nextDryDock?: string | null; liner?: boolean;
  status: 'ACTIVE' | 'INACTIVE'; registry?: VesselRegistryEntry; certificates: VesselCertificate[];
}
export interface RecentCall { id: string; vcn: string; status: string; eta: string; atd?: string | null; berthCode?: string; berthName?: string; terminal?: string }
export interface RecentInspection { id: string; number: string; type: string; status: string; result?: string; findings?: { status: string }[]; plannedAt: string }
export interface RecentIncident { id: string; number: string; title: string; type: string; severity: string; status: string; reportedAt: string; closedAt?: string | null }
export interface CrewOnBoard { id: string; name: string; rank: string; cdcNo?: string; nationality?: string; status?: string; certAlerts: number }
export interface Position { lat: number; lon: number; speed: number; course: number; navStatus: string; receivedAt: string }
export interface ClassStatus { checkedAt: string; checkedBy?: string; mode: string; society: string; class: string; status: string; surveysDue: { kind: string; dueBy: string }[]; conditions: unknown[]; certificates: { kind: string; no: string; issued?: string; expires?: string; status?: string }[] }
export interface VesselDetailData extends Vessel {
  classStatus?: ClassStatus | null; recentCalls: RecentCall[]; recentInspections: RecentInspection[]; recentIncidents: RecentIncident[]; crewOnBoard: CrewOnBoard[]; lastPosition: Position | null }
export interface Voyage { callId: string; vcn: string; fromPort: string; toPort: string; arrived?: string | null; sailed?: string | null; berth: string; terminal: string; purpose?: string; cargo: string; portDays: number | null }
export interface VoyagesData { voyages: Voyage[]; lanes: { port: string; calls: number }[] }
export interface MovementEvent { at: string; vcn: string; event: string; note?: string }
export interface MovementsData { position: Position | null; events: MovementEvent[] }
export interface FleetDashboardData {
  kpis: { fleet: number; inactive: number; inPort: number; inbound: number; atAnchor: number; avgAge: number; totalDwt: number };
  byType: { type: string; count: number }[]; byFlag: { flag: string; count: number }[]; byClass: { cls: string; count: number }[]; ageBands: { band: string; count: number }[];
  certs: { valid: number; expiring: number; expired: number }; certAlertVessels: { id: string; name: string; type: string; alerts: number }[];
}
export type SurveyEventType = 'ANNUAL' | 'INTERMEDIATE' | 'SPECIAL' | 'DRY_DOCK';
export type SurveyStatus = 'OVERDUE' | 'WINDOW_OPEN' | 'PLANNED';
export interface SurveyEvent { type: SurveyEventType; due: string; window: { from: string; to: string }; status: SurveyStatus }
export interface SurveyLane { vessel: { id: string; name: string; imo: string; type: string; classSociety?: string; lastDryDock?: string | null }; events: SurveyEvent[] }
export interface SurveyPlannerData { horizonMonths: number; from: string; to: string; lanes: SurveyLane[] }
/** One row of /vessels/certificates/all — the ship's certificate joined to the instrument register where this administration issued it. */
export interface FleetCertificateRow {
  vesselId: string; vesselName: string; imo: string; certId: string; certType: string; number?: string; issuer?: string; issueDate?: string | null; expiryDate: string; status: CertStatus;
  instrumentId: string | null; onRegister: boolean; signed: boolean; inForce: boolean | null; forceReason: string; endorsementsOverdue: number;
}
