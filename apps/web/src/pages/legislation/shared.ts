/* Notices & Circulars constants and the client-side mirror of the publication governance rules (enforced server-side). */
import type { Option, SessionUser } from '../../types';
import { hasPerm } from '../../utils/perms';
import { INSTRUMENT_STATUS_META, type StatusMeta } from '../../utils/status';
import type { ImoItemStatus, LegalInstrument, Standing } from './types';

/** The masters the screens read their options from — a type or a source added in Data Studio appears here without a release. */
export const TYPE_LOOKUP = 'legalInstrumentType';
export const SOURCE_LOOKUP = 'imoSource';
export const LINK_KIND_LOOKUP = 'legalLinkKind';
export const STATUS_OPTIONS: Option[] = Object.entries(INSTRUMENT_STATUS_META).map(([value, m]) => ({ value, label: m.label }));
/** How the portal states the standing of an instrument; the code comes from the service, the colour is the screen's. */
export const STANDING_META: Record<Standing, { color: 'success' | 'warning' | 'error' | 'info' | 'default' }> = { IN_FORCE: { color: 'success' }, NOT_YET_IN_FORCE: { color: 'info' }, EXPIRED: { color: 'warning' }, SUPERSEDED: { color: 'warning' }, WITHDRAWN: { color: 'error' } };
export const IMO_ITEM_STATUS_META: StatusMeta = { NEW: { label: 'New', color: 'warning' }, ASSESSED: { label: 'Assessed', color: 'info' }, TRANSPOSED: { label: 'Transposed', color: 'success' }, DISMISSED: { label: 'Dismissed', color: 'default' } };
export const IMO_ITEM_STATUSES: ImoItemStatus[] = ['NEW', 'ASSESSED', 'TRANSPOSED', 'DISMISSED'];
export const POLL_STATUS_META: StatusMeta = { OK: { label: 'Read', color: 'success' }, FAILED: { label: 'Failed', color: 'error' }, NEVER: { label: 'Never read', color: 'default' } };
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
/** Why an instrument is not on the portal, for the desk: a draft, a type the master keeps off it, or the desk's own switch. */
export function portalAbsence(row: Pick<LegalInstrument, 'status' | 'public' | 'portal'>): 'DRAFT' | 'TYPE' | 'SWITCH' | null {
  if (row.status === 'DRAFT' || !row.portal) return 'DRAFT';
  if (!row.portal.citable) return 'TYPE';
  if (row.public === false) return 'SWITCH';
  return null;
}
/** The web address of a published instrument inside this application, from the slug the service assigned. */
export const lawPath = (slug: string) => `/law/${encodeURIComponent(slug)}`;
