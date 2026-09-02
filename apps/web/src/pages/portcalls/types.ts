/* Vessel-call API contract for the ports service. Populated refs become flat *Id / *Name fields; nested
 * objects appear only where the reference detail endpoints returned them. */
import type { PortCallStatus } from '@maritime/contracts';

export type { PortCallStatus };
export interface VesselRef { id: string; name: string; imo: string; type?: string; flag?: string; grt?: number; dwt?: number; loa?: number; maxDraft?: number; status?: string }
export interface BerthRef { id: string; code: string; name?: string; terminal?: string; berthType?: string }
export interface PortCallService { id: string; type: string; tariffCode?: string; description?: string; qty: number; unit?: string; at?: string | null; remarks?: string }
export type CargoOperation = 'DISCHARGE' | 'LOAD';
export type CargoUnit = 'MT' | 'TEU' | 'UNITS';
export interface CargoOp { id: string; cargoType: string; operation: CargoOperation; qty: number; unit: CargoUnit; qtyMT: number; gangs?: number; startedAt?: string | null; completedAt?: string | null; remarks?: string }
export interface StatusHistoryEntry { from: string; to: string; at: string; by: string; note?: string }
/** GET /port-calls — one list row. */
export interface PortCallRow {
  id: string; vcn: string; status: PortCallStatus; vesselId: string; vesselName: string; vesselImo?: string; vesselType?: string; vesselFlag?: string;
  berthId?: string | null; berthCode?: string | null; berthTerminal?: string | null; agentCode?: string; agentName?: string; purpose?: string;
  eta: string; etb?: string | null; etd?: string | null; ata?: string | null; atb?: string | null; atd?: string | null; createdAt?: string;
}
/** GET /port-calls/:id — the call with its vessel and berth. */
export interface PortCall extends PortCallRow {
  vessel: VesselRef; berth?: BerthRef | null; prevPort?: string; nextPort?: string; draftArrival?: number | null; draftDeparture?: number | null;
  crew?: { count?: number; master?: string }; remarks?: string; detention?: boolean; services: PortCallService[]; cargoOps: CargoOp[]; statusHistory: StatusHistoryEntry[];
}
/** POST /port-calls */
export interface AnnouncePayload { vesselId: string; eta: string; etd?: string; agentCode?: string; purpose?: string; prevPort?: string; nextPort?: string; remarks?: string }
/** POST /port-calls/:id/transition */
export interface TransitionPayload { to: PortCallStatus; at?: string; berthId?: string; note?: string }
/** POST /port-calls/:id/services */
export interface ServicePayload { type: string; tariffCode?: string; description?: string; qty: number; unit?: string; at?: string; remarks?: string }
/** POST/PUT /port-calls/:id/cargo[/:opId] */
export interface CargoPayload { cargoType: string; operation: CargoOperation; qty: number; unit: CargoUnit; gangs?: number; startedAt?: string; completedAt?: string; remarks?: string }
export interface VesselOption { id: string; name: string; imo: string }
export interface LookupOption { id: string; code: string; label: string }
export interface BerthOption { id: string; code: string; terminal: string; loaMax: number; draftMax: number; status?: string }
export interface TariffOption { id: string; code: string; name: string; rate: number; unit: string }
/** GET /port-calls/:id/sof */
export interface SofEvent { at: string; event: string; detail?: string }
export interface SofData { call: { id: string; vcn: string; agentCode?: string; agentName?: string; vessel?: VesselRef | null; berth?: BerthRef | null }; events: SofEvent[] }
/** GET / POST /port-calls/:id/pda — tax heads are jurisdiction-neutral (taxRate / taxAmount). */
export interface PdaLine { code: string; description: string; unit: string; qty: number; rate: number; amount: number }
export interface Pda { number: string; lines: PdaLine[]; subtotal: number; taxRate: number; taxAmount: number; total: number; basis?: { grt: number; plannedDays: number; tugs: number }; generatedAt: string; generatedBy?: string }
export interface PdaVariance { lines: { code: string; estimated: number; actual: number; delta: number }[]; estimatedTotal: number; actualTotal: number; delta: number; invoiceNumber: string }
export interface PdaData { call?: { vcn: string; vessel?: VesselRef | null; agentName?: string; eta?: string }; pda: Pda | null; variance: PdaVariance | null }
