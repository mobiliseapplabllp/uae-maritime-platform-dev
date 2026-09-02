/* Ship-registration constants, pure helpers and the transaction chip shared by the registry screens. */
import { Chip } from '@mui/material';
import type { StatusMeta } from '../../utils/status';
import type { EvidenceItem, EvidenceRequirement, RegistrationKind, RegistrationStatus } from './types';

export const REG_STATUS_META: StatusMeta = {
  DRAFT: { label: 'Draft', color: 'default' }, SUBMITTED: { label: 'Submitted', color: 'info' }, UNDER_SCRUTINY: { label: 'Under scrutiny', color: 'info' },
  CARVING_NOTE_ISSUED: { label: 'Carving note issued', color: 'warning' }, SURVEY_COMPLETE: { label: 'Survey complete', color: 'warning' },
  APPROVED: { label: 'Approved', color: 'success' }, GRANTED: { label: 'Granted', color: 'success' }, REJECTED: { label: 'Refused', color: 'error' }, WITHDRAWN: { label: 'Withdrawn', color: 'default' },
};
export const KIND_META: Record<RegistrationKind, { label: string; short: string; color: string }> = {
  PERMANENT: { label: 'Permanent registration', short: 'Permanent', color: '#2C6E52' },
  PROVISIONAL: { label: 'Provisional certificate', short: 'Provisional', color: '#8A5A10' },
  AMENDMENT: { label: 'Amendment to the entry', short: 'Amendment', color: '#3B6FB6' },
  DELETION: { label: 'Closure of registry', short: 'Closure', color: '#96322C' },
};
export const REGISTRY_STATE_META: StatusMeta = { REGISTERED: { label: 'Registered', color: 'success' }, PROVISIONAL: { label: 'Provisional', color: 'warning' }, CLOSED: { label: 'Registry closed', color: 'error' }, UNREGISTERED: { label: 'Not on this register', color: 'default' } };
export const kindLabel = (kind: string) => KIND_META[kind as RegistrationKind]?.label || kind;

// Which move an officer can make next, and what to call it in the button.
export const NEXT: Record<RegistrationStatus, [RegistrationStatus, string][]> = {
  DRAFT: [['SUBMITTED', 'Lodge the application']],
  SUBMITTED: [['UNDER_SCRUTINY', 'Take up for scrutiny'], ['REJECTED', 'Refuse']],
  UNDER_SCRUTINY: [['CARVING_NOTE_ISSUED', 'Issue the carving and marking note'], ['APPROVED', 'Approve'], ['REJECTED', 'Refuse']],
  CARVING_NOTE_ISSUED: [['SURVEY_COMPLETE', 'Close the survey'], ['REJECTED', 'Refuse']],
  SURVEY_COMPLETE: [['APPROVED', 'Approve'], ['REJECTED', 'Refuse']],
  APPROVED: [], GRANTED: [], REJECTED: [], WITHDRAWN: [],
};
export const words = (s?: string | null) => String(s || '').replace(/_/g, ' ').toLowerCase().replace(/^./, (c) => c.toUpperCase());
/** The moves offered on a file: only a first registration is carved and surveyed, so those steps never appear on an amendment or a closure. */
export const nextMoves = (status: string, kind: string) => (NEXT[status as RegistrationStatus] || []).filter(([to]) => kind === 'PERMANENT' || !['CARVING_NOTE_ISSUED', 'SURVEY_COMPLETE'].includes(to));
/** Mandatory documents the file does not yet carry. */
export const missingMandatory = (required: EvidenceRequirement[], evidence: Pick<EvidenceItem, 'key'>[]) => { const held = new Set(evidence.map((e) => e.key)); return required.filter((r) => r.mandatory && !held.has(r.key)); };

export const KindChip = ({ kind }: { kind: string }) => {
  const m = KIND_META[kind as RegistrationKind] || { short: kind, color: '#5b7180' };
  return <Chip size="small" label={m.short} sx={{ height: 21, fontSize: 11, color: m.color, borderColor: m.color }} variant="outlined" />;
};
