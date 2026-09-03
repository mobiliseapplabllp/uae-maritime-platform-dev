/* Incident Desk constants and pure helpers — lifecycle labels, thread colours, the case timeline and the 5×5 matrix bands. */
import { INCIDENT_CATEGORIES, INCIDENT_SEVERITY, INCIDENT_SOURCES, INCIDENT_STATUS, INCIDENT_TRANSITIONS, INCIDENT_TYPES, type IncidentStatus } from '@maritime/contracts';
import { titleCase } from '../../utils/format';
import type { Incident } from './types';

export const CATEGORIES: readonly string[] = INCIDENT_CATEGORIES;
export const TYPES: readonly string[] = INCIDENT_TYPES;
export const SEVERITIES: readonly string[] = INCIDENT_SEVERITY;
export const SOURCES: readonly string[] = INCIDENT_SOURCES;
export const STATUSES: readonly string[] = INCIDENT_STATUS;
export const SEV_ORDER = ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'] as const;
/** Severity palette, one hue per band — never re-ranked between light and dark. */
export const SEV_COLORS = {
  light: { LOW: '#0797A5', MEDIUM: '#B98A2F', HIGH: '#C14F33', CRITICAL: '#7E2213' },
  dark: { LOW: '#2FA6AE', MEDIUM: '#B8892B', HIGH: '#D0644A', CRITICAL: '#F0937A' },
} as const;
export const CHANNEL_COLOR: Record<string, string> = { VHF: '#0B4F8A', PHONE: '#2C6E52', EMAIL: '#8A5A2B', PORTAL: '#5A6B78', PATROL: '#9C6412', CCTV: '#75479C', AIS: '#0797A5' };
export const TRANSITION_LABEL: Record<string, string> = { ACKNOWLEDGED: 'Acknowledge', RESPONDING: 'Start response', MONITORING: 'Move to monitoring', RESOLVED: 'Resolve', CLOSED: 'Close case' };
export const REOPEN_FROM: readonly string[] = ['RESOLVED', 'CLOSED'];
export const DIRECTIONS = ['IN', 'OUT', 'INTERNAL'] as const;
export const DOC_TYPES = ['REPORT', 'PHOTO', 'STATEMENT', 'SAMPLE', 'PERMIT', 'CCTV', 'OTHER'];
export const RCA_CATEGORIES = ['Human factor', 'Equipment', 'Procedure', 'Weather', 'External'];

/** A case is live until it is resolved or closed; threads stay open while it is live. */
export const isLive = (status: string) => !REOPEN_FROM.includes(status);
/** The successors the declared lifecycle allows from a status — the same table the service enforces. */
export const transitionsFor = (status: string): IncidentStatus[] => INCIDENT_TRANSITIONS[status as IncidentStatus] ?? [];
/** RESPONDING from a resolved or closed case is a reopen, not a fresh response. */
export const isReopen = (from: string, to: string) => REOPEN_FROM.includes(from) && to === 'RESPONDING';
export const transitionLabel = (from: string, to: string) => (isReopen(from, to) ? 'Reopen' : TRANSITION_LABEL[to] || titleCase(to));
export const directionLabel = (d: string) => (d === 'IN' ? 'Received' : d === 'OUT' ? 'Sent' : 'Internal note');
export const docSize = (kb: number) => (kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`);

export interface TimelineEntry { at: string; kind: 'STATUS' | 'LOG' | 'DOC'; who: string; text: string }
/** Status changes, log entries and attachments merged into one thread, newest first. */
export function buildTimeline(inc: Pick<Incident, 'statusHistory' | 'log' | 'documents'>): TimelineEntry[] {
  const rows: TimelineEntry[] = [
    ...(inc.statusHistory || []).map((h) => ({ at: h.at, kind: 'STATUS' as const, who: h.by, text: `${h.from || 'New'} → ${h.to}${h.note ? ` — ${h.note}` : ''}` })),
    ...(inc.log || []).map((l) => ({ at: l.at, kind: 'LOG' as const, who: l.by, text: l.entry })),
    ...(inc.documents || []).map((d) => ({ at: d.at, kind: 'DOC' as const, who: d.uploadedBy, text: `Attached ${d.name}` })),
  ];
  return rows.sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime());
}

/* 5×5 likelihood × consequence matrix — the classic HSE heatmap. */
export const CONSEQ = ['Negligible', 'Minor', 'Moderate', 'Major', 'Catastrophic'];
export const LIKELY = ['Rare', 'Unlikely', 'Possible', 'Likely', 'Almost certain'];
export function matrixBand(likelihood: number, consequence: number) {
  const score = likelihood * consequence;
  if (score >= 15) return '#B3452E';
  if (score >= 8) return '#C77B2E';
  if (score >= 4) return '#C7A62E';
  return '#3D8361';
}
