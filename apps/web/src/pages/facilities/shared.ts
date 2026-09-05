/* Port Companies constants and pure helpers shared by the directory and licence screens. */
import { LICENSE_TRANSITIONS, type LicenseStatus, type SubjectKind } from '@maritime/contracts';
import type { Option } from '../../types';
import type { StatusMeta } from '../../utils/status';
import { titleCase } from '../../utils/format';

/** Company categories are the `companyCategory` master; screens read it through `useLookups`. This is the print-form fallback for a code the master does not know. */
export const categoryLabel = (c: string) => titleCase(c);
export const COMPANY_STATUS_META: StatusMeta = { ACTIVE: { label: 'Active', color: 'success' }, SUSPENDED: { label: 'Suspended', color: 'warning' }, BLACKLISTED: { label: 'Blacklisted', color: 'error' }, INACTIVE: { label: 'Inactive', color: 'default' } };
export const COMPANY_STATUS_OPTIONS: Option[] = Object.entries(COMPANY_STATUS_META).map(([value, m]) => ({ value, label: m.label }));
export const SUBJECT_KIND_LABEL: Record<string, string> = { COMPANY: 'Company', VESSEL: 'Vessel', SEAFARER: 'Seafarer', PORT_FACILITY: 'Port facility', MET_INSTITUTION: 'MET institution' };
/** The subject kinds the Port Companies desk licenses; vessel and seafarer instruments live on their own registers. */
export const FACILITY_KINDS: SubjectKind[] = ['COMPANY', 'PORT_FACILITY', 'MET_INSTITUTION'];
export const SUBJECT_KIND_OPTIONS: Option[] = FACILITY_KINDS.map((k) => ({ value: k, label: SUBJECT_KIND_LABEL[k] }));
export const licLabel = (t: string) => titleCase(t);
export const AUDIT_RESULT_META: StatusMeta = { SATISFACTORY: { label: 'Satisfactory', color: 'success' }, OBSERVATIONS: { label: 'Observations', color: 'warning' }, NON_CONFORMITY: { label: 'Non-conformity', color: 'error' } };
export const WINDOW_STATE_META: StatusMeta = { ENDORSED: { label: 'Endorsed', color: 'success' }, DUE: { label: 'Window open', color: 'warning' }, OVERDUE: { label: 'Overdue', color: 'error' }, SCHEDULED: { label: 'Scheduled', color: 'default' } };
export const ENDORSEMENT_RESULT_META: StatusMeta = { ENDORSED: { label: 'Endorsed', color: 'success' }, ENDORSED_WITH_CONDITIONS: { label: 'Endorsed with conditions', color: 'warning' }, NOT_ENDORSED: { label: 'Not endorsed', color: 'error' } };
export const NEEDS_NOTE: LicenseStatus[] = ['SUSPENDED', 'REVOKED', 'REJECTED'];
export interface LicenceAction { to: LicenseStatus; label: string; danger: boolean; needsNote: boolean }
const label = (from: LicenseStatus, to: LicenseStatus, cls: string) => {
  switch (to) {
    case 'UNDER_REVIEW': return 'Start review';
    case 'ISSUED': return from === 'SUSPENDED' ? 'Reinstate' : `Issue ${cls.toLowerCase()}`;
    case 'REJECTED': return 'Reject';
    case 'SUSPENDED': return 'Suspend';
    case 'REVOKED': return 'Revoke';
    default: return titleCase(to);
  }
};
/** Lifecycle buttons offered on an instrument — driven by the declared transition table, enforced server-side. */
export const nextActions = (status: LicenseStatus, classLabel = 'Licence'): LicenceAction[] => (LICENSE_TRANSITIONS[status] || []).map((to) => ({ to, label: label(status, to, classLabel), danger: NEEDS_NOTE.includes(to), needsNote: NEEDS_NOTE.includes(to) }));
/** The public verification page the certificate QR points at. */
export const verifyPath = (licenseNo: string) => `/verify/${encodeURIComponent(licenseNo)}`;
export const verifyUrl = (licenseNo: string) => `${window.location.origin}${verifyPath(licenseNo)}`;
export const subjectPath = (kind: SubjectKind, id: string | null | undefined) => (!id ? null : kind === 'VESSEL' ? `/vessels/${id}` : kind === 'SEAFARER' ? `/seafarers/${id}` : kind === 'PORT_FACILITY' ? '/masters/berths' : `/companies/${id}`);
