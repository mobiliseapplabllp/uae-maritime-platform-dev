/* Ship-registration constants, pure helpers and the transaction chip shared by the registry screens. */
import { Chip } from '@mui/material';
import type { StatusMeta } from '../../utils/status';
import { useLookups } from '../../hooks/useLookups';
import type { EvidenceItem, EvidenceRequirement, RegistrationStatus } from './types';

export const REG_STATUS_META: StatusMeta = {
  DRAFT: { label: 'Draft', color: 'default' }, SUBMITTED: { label: 'Submitted', color: 'info' }, UNDER_SCRUTINY: { label: 'Under scrutiny', color: 'info' },
  CARVING_NOTE_ISSUED: { label: 'Carving note issued', color: 'warning' }, SURVEY_COMPLETE: { label: 'Survey complete', color: 'warning' },
  APPROVED: { label: 'Approved', color: 'success' }, GRANTED: { label: 'Granted', color: 'success' }, REJECTED: { label: 'Refused', color: 'error' }, WITHDRAWN: { label: 'Withdrawn', color: 'default' },
};
/* A colour per variant the screens know; a variant added in Data Studio gets the neutral one. The labels come from the master through `useLookups('registrationKind')`. */
export const KIND_COLOR: Record<string, string> = { PERMANENT: '#2C6E52', PROVISIONAL: '#8A5A10', AMENDMENT: '#3B6FB6', DELETION: '#96322C', BAREBOAT_IN: '#06737E', BAREBOAT_OUT: '#75479C', UNDER_CONSTRUCTION: '#5A6B78', TEMPORARY_PASS: '#B3452E', RE_REGISTRATION: '#2C6E52' };
/** The English print form of a variant the master has not labelled yet. */
export const KIND_FALLBACK: Record<string, string> = { PERMANENT: 'Permanent registration', PROVISIONAL: 'Provisional certificate', AMENDMENT: 'Amendment to the entry', DELETION: 'Closure of registry' };
export const REGISTRY_STATE_META: StatusMeta = { REGISTERED: { label: 'Registered', color: 'success' }, PROVISIONAL: { label: 'Provisional', color: 'warning' }, BAREBOAT_IN: { label: 'Bareboat charter in', color: 'info' }, BAREBOAT_OUT: { label: 'Chartered out', color: 'warning' }, CLOSED: { label: 'Registry closed', color: 'error' }, UNREGISTERED: { label: 'Not on this register', color: 'default' } };
export const words = (s?: string | null) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
export const kindLabel = (kind: string) => KIND_FALLBACK[kind] || words(kind);
/** The variant labels as the master declares them, in the interface language. */
export function useKindLabels() { const l = useLookups('registrationKind'); return (kind: string) => (l.byCode.has(kind) ? l.label(kind) : kindLabel(kind)); }

// Which move an officer can make next, and what to call it in the button.
export const NEXT: Record<RegistrationStatus, [RegistrationStatus, string][]> = {
  DRAFT: [['SUBMITTED', 'Lodge the application']],
  SUBMITTED: [['UNDER_SCRUTINY', 'Take up for scrutiny'], ['REJECTED', 'Refuse']],
  UNDER_SCRUTINY: [['CARVING_NOTE_ISSUED', 'Issue the carving and marking note'], ['APPROVED', 'Approve'], ['REJECTED', 'Refuse']],
  CARVING_NOTE_ISSUED: [['SURVEY_COMPLETE', 'Close the survey'], ['REJECTED', 'Refuse']],
  SURVEY_COMPLETE: [['APPROVED', 'Approve'], ['REJECTED', 'Refuse']],
  APPROVED: [], GRANTED: [], REJECTED: [], WITHDRAWN: [],
};
/** The moves offered on a file: only a variant the master marks for carving is carved and surveyed, so those steps never appear on an amendment, a closure or a charter. */
export const nextMoves = (status: string, carving: boolean) => (NEXT[status as RegistrationStatus] || []).filter(([to]) => carving || !['CARVING_NOTE_ISSUED', 'SURVEY_COMPLETE'].includes(to));
/** Mandatory documents the file does not yet carry. */
export const missingMandatory = (required: EvidenceRequirement[], evidence: Pick<EvidenceItem, 'key'>[]) => { const held = new Set(evidence.map((e) => e.key)); return required.filter((r) => r.mandatory && !held.has(r.key)); };

export const KindChip = ({ kind }: { kind: string }) => {
  const label = useKindLabels();
  const color = KIND_COLOR[kind] || '#5b7180';
  return <Chip size="small" label={label(kind)} sx={{ height: 21, fontSize: 11, color, borderColor: color }} variant="outlined" />;
};
