/* Harbour-operations API contract — quay twin, day schedule, berth window plan and the marine craft board. */
import type { PortCallStatus } from '@maritime/contracts';

/** GET /ops/twin */
export interface TwinOccupant { callId: string; vcn: string; vesselId: string; vessel: string; type?: string; loa?: number; atb?: string | null; etd?: string | null; cargo?: string }
export interface TwinBerth { id: string; code: string; name: string; terminal: string; berthType: string; loaMax: number; draftMax: number; status: string; occupiedBy: TwinOccupant | null }
export interface TwinAnchored { callId: string; vcn: string; vesselId: string; vessel: string; type?: string; loa?: number; since?: string | null; etb?: string | null }
export interface TwinInbound { callId: string; vcn: string; vesselId: string; vessel: string; type?: string; loa?: number; eta: string; status: PortCallStatus }
export interface TwinData { berths: TwinBerth[]; anchorage: TwinAnchored[]; inbound: TwinInbound[] }

/** GET /ops/schedule?days= */
export type ScheduleKind = 'ARRIVAL' | 'BERTHING' | 'SAILING' | 'SAILED';
export interface ScheduleEvent { callId: string; vcn: string; vesselId: string; vessel: string; type?: string; berth: string; agent?: string; status: PortCallStatus; kind: ScheduleKind; at: string; planned: boolean }
export interface ScheduleData { from: string; to: string; events: ScheduleEvent[] }

/** GET /ops/berth-plan?from=&days= */
export interface PlanBerth { id: string; code: string; name: string; terminal: string; berthType: string; status: string; loaMax: number; draftMax: number }
export interface PlanVessel { name: string; loa?: number; type?: string }
export interface PlanBlock { id: string; vcn: string; berthId: string; status: PortCallStatus; vessel: PlanVessel | null; start: string; end: string | null; actual: boolean }
export interface PlanConflict { a: string; b: string; berthId: string }
export interface PlanUnallocated { id: string; vcn: string; eta: string; status: PortCallStatus; vessel: PlanVessel | null }
export interface BerthPlan { window: { from: string; to: string; days: number }; berths: PlanBerth[]; blocks: PlanBlock[]; conflicts: PlanConflict[]; unallocated: PlanUnallocated[] }

/** GET /ops/resources — one digest per craft; the jobs array never leaves the server. */
export type ResourceType = 'TUG' | 'PILOT_LAUNCH' | 'MOORING_BOAT' | 'PILOT' | 'SURVEY_LAUNCH';
export type ResourceStatus = 'AVAILABLE' | 'TASKED' | 'MAINTENANCE' | 'OFF_DUTY';
export interface CraftRef { id: string; code: string; name: string; type: ResourceType; spec?: string }
export interface ServiceDigest { jobs: number; hours: number; windowJobs: number; windowHours: number; jobs30d: number; lastJobAt: string | null; outages: number; outageDays: number; availabilityPct: number }
export interface MarineResource extends CraftRef { status: ResourceStatus; currentTask?: string; master?: string; contact?: string; remarks?: string; service: ServiceDigest }
/** PUT /ops/resources/:id */
export interface ResourceStatusPayload { status: ResourceStatus; currentTask?: string }

export interface MonthPoint { month: string; label: string; jobs: number; hours: number }
export interface KindTotal { kind: string; jobs: number; hours: number }
/** GET /ops/resources/:id/history?page=&limit=&kind= — meta carries { total, page, limit, kinds } */
export interface ResourceJob { id: string; at: string; endedAt?: string | null; kind: string; vcn?: string; vesselName?: string; berth?: string; hours: number; remarks?: string }
export interface ResourceOutage { id: string; from: string; to: string; reason: string; days: number }
export interface ResourceHistory {
  resource: CraftRef & { status: ResourceStatus; master?: string; contact?: string; remarks?: string };
  summary: {
    window: { from: string; to: string; months: number }; jobs: number; hours: number; avgHours: number; avgJobsPerMonth: number; outageDays: number; availabilityPct: number;
    busiestMonth: MonthPoint | null; lifetime: { jobs: number; hours: number; firstJobAt: string | null; lastJobAt: string | null; outages: number; outageDays: number }; series: MonthPoint[]; byKind: KindTotal[];
  };
  outages: ResourceOutage[]; jobs: ResourceJob[];
}
export interface HistoryMeta { total: number; page: number; limit: number; kinds: string[] }

/** GET /ops/resources/utilisation?months= */
export interface FleetCraft extends CraftRef { status: ResourceStatus; jobs: number; hours: number; jobsAllTime: number; hoursAllTime: number; outageDays: number; availabilityPct: number; lastJobAt: string | null }
export interface FleetUtilisationData {
  window: { from: string; to: string; months: number };
  totals: { craft: number; jobs: number; hours: number; jobsAllTime: number; hoursAllTime: number; avgJobsPerMonth: number; avgHoursPerJob: number; outageDays: number; availabilityPct: number };
  series: MonthPoint[]; byKind: KindTotal[]; byType: { type: ResourceType; craft: number; jobs: number; hours: number }[]; craft: FleetCraft[];
}
