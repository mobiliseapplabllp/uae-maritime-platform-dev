import type { SeriesKey } from '../../theme';
import type { ResourceType, ScheduleKind } from './types';

/** Berth-type accents shared by the planner lanes and the quay twin. */
export const TERM_COLOR: Record<string, string> = { CONTAINER: '#056A73', BULK: '#9C6412', MULTIPURPOSE: '#3B6FB6', LIQUID: '#BD3861', RORO: '#75479C', SPM: '#2C6E52', COAL: '#5A4632' };
/** Vessel-type lookup code → categorical chart series (fixed order, never re-ranked). */
const TYPE_GROUP: Record<string, SeriesKey> = { CONT: 'container', BULK: 'dryBulk', GEN: 'other', RORO: 'other', TANK: 'liquid', OSV: 'other' };
export const seriesOf = (vesselType?: string | null): SeriesKey => TYPE_GROUP[vesselType || ''] || 'other';
export const KIND_META: Record<ScheduleKind, { label: string; color: string }> = {
  ARRIVAL: { label: 'Arrival', color: '#0B74B0' }, BERTHING: { label: 'Berthing', color: '#056A73' }, SAILING: { label: 'Sailing (planned)', color: '#9C6412' }, SAILED: { label: 'Sailed', color: '#5A6B78' },
};
export const RESOURCE_ORDER: ResourceType[] = ['TUG', 'PILOT_LAUNCH', 'MOORING_BOAT', 'PILOT', 'SURVEY_LAUNCH'];
export const RESOURCE_TYPE_LABELS: Record<ResourceType, string> = { TUG: 'Tugs', PILOT_LAUNCH: 'Pilot launches', MOORING_BOAT: 'Mooring boats', PILOT: 'Pilots', SURVEY_LAUNCH: 'Survey launch' };
