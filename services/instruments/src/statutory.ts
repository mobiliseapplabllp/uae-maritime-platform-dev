import { endorsementSchedule, endorsementState, forceState as baseForceState, isStatutory, nonExpiring, termMonthsOf, CERT_LABEL, CONVENTION, SURVEY_REGIME, INSTRUMENT_TYPE_LABEL, type WorldEndorsement } from '@maritime/world';

/* Statutory certificates run a survey regime, not a plain expiry: a certificate whose annual survey window closed unendorsed is not in force whatever its expiry says. The schedule, state and force rules are shared with the world so seed and service cannot drift; this module adds what the API returns. */
export type StatutoryDoc = { status: string; entityType: string; issueDate: string | null; expiryDate: string | null; endorsements: WorldEndorsement[] };
export type EndorsementState = ReturnType<typeof endorsementState>;
export interface ForceState { inForce: boolean; reason: string; endorsements: EndorsementState | null }
/** Whether an instrument is in force, tested in the order a port state control officer applies them: status, expiry, then the survey schedule. */
export function forceState(doc: StatutoryDoc, now = new Date()): ForceState {
  const f = baseForceState(doc, now);
  return { ...f, endorsements: isStatutory(doc.entityType) ? endorsementState(doc, now) : null };
}
export { endorsementSchedule, endorsementState, isStatutory, nonExpiring, termMonthsOf, CERT_LABEL, CONVENTION, SURVEY_REGIME, INSTRUMENT_TYPE_LABEL };
export const typeLabel = (type: string, ar = false): string => INSTRUMENT_TYPE_LABEL[type]?.[ar ? 1 : 0] ?? INSTRUMENT_TYPE_LABEL[type]?.[0] ?? type.replace(/_/g, ' ');
/** "LICENCE" reads as shouting in user-facing copy; sentence-case it. */
export const classLabel = (k: string | null | undefined) => { const c = k || 'LICENCE'; return c.charAt(0) + c.slice(1).toLowerCase(); };
