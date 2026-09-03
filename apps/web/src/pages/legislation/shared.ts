/* Notices & Circulars constants and the client-side mirror of the publication governance rules (enforced server-side). */
import { INSTRUMENT_TYPES } from '@maritime/contracts';
import type { Option, SessionUser } from '../../types';
import { hasPerm } from '../../utils/perms';
import { INSTRUMENT_STATUS_META } from '../../utils/status';
import type { LegalInstrument } from './types';

export const TYPE_OPTIONS: Option[] = INSTRUMENT_TYPES.map((t) => ({ value: t, label: t }));
export const STATUS_OPTIONS: Option[] = Object.entries(INSTRUMENT_STATUS_META).map(([value, m]) => ({ value, label: m.label }));
export const hasAcknowledged = (row: Pick<LegalInstrument, 'acknowledgedBy'>, userId?: string | null) => (row.acknowledgedBy || []).some((a) => String(a.userId) === String(userId));
/** Acknowledgment is offered on an in-force instrument that requires it and that this user has not yet acknowledged. */
export const canAcknowledge = (row: Pick<LegalInstrument, 'ackRequired' | 'status' | 'acknowledgedBy'>, userId?: string | null) => !!row.ackRequired && row.status === 'IN_FORCE' && !hasAcknowledged(row, userId);
export type ApprovalVerdict = { ok: true } | { ok: false; reason: 'NOT_DRAFT' | 'NO_PERM' | 'NO_DRAFTER' | 'SELF' };
/** Who may put a draft in force: an approver who is not the drafter — holding the permission is necessary but not sufficient. */
export function approvalVerdict(row: Pick<LegalInstrument, 'status' | 'draftedById'>, user: SessionUser | null | undefined): ApprovalVerdict {
  if (row.status !== 'DRAFT') return { ok: false, reason: 'NOT_DRAFT' };
  if (!hasPerm(user, 'legislation.approve')) return { ok: false, reason: 'NO_PERM' };
  if (!row.draftedById) return { ok: false, reason: 'NO_DRAFTER' };
  if (String(row.draftedById) === String(user?.id)) return { ok: false, reason: 'SELF' };
  return { ok: true };
}
