import { PORTCALL_TRANSITIONS, type PortCallStatus } from '@maritime/contracts';

export const SERVICE_TYPES = ['PILOTAGE', 'TUGS', 'FRESH_WATER', 'GARBAGE', 'ANCHORAGE', 'MOORING', 'OTHER'];
export const PURPOSES = ['Discharge', 'Loading', 'Discharge + Loading', 'Bunkering', 'Crew change'];
export const CARGO_UNITS = ['MT', 'TEU', 'UNITS'];
const CLOSED: string[] = ['SAILED', 'CANCELLED'];
/** Sailed and cancelled calls are read-only operational record. */
export const isClosed = (status: string) => CLOSED.includes(status);

export interface NextAction { to: PortCallStatus; label: string; danger: boolean }
const ACTION_LABEL: Record<PortCallStatus, string> = { ANNOUNCED: 'Announce', CONFIRMED: 'Confirm call', AT_ANCHORAGE: 'Arrived at anchorage', BERTHED: 'Berth vessel', SAILED: 'Sail vessel', CANCELLED: 'Cancel' };
/** Lifecycle buttons offered on a call — driven by the declared transition table, enforced server-side. */
export const nextActions = (status: PortCallStatus): NextAction[] => (PORTCALL_TRANSITIONS[status] || []).map((to) => ({ to, label: ACTION_LABEL[to], danger: to === 'CANCELLED' }));
