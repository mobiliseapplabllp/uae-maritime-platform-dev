import type { TenancyScope } from '@maritime/contracts';

export interface SessionRole { id: string; name: string; permissions?: string[]; mfaRequired?: boolean }
export interface SessionUser {
  id: string; name: string; email: string; designation?: string; department?: string; phone?: string; active: boolean;
  kind: 'user' | 'agent' | 'service'; scope: TenancyScope; role: SessionRole; perms: string[]; lastLoginAt?: string | null;
  mfa?: { enrolled: boolean; enrolledAt?: string | null; required: boolean; dueAt?: string | null; recoveryCodesLeft?: number };
  dormantSince?: string | null; deactivatedReason?: string; pendingChange?: { id: string; kind: string } | null;
}
/** What the server asks the client to honour: the idle window it enforces at refresh, and the second-factor policy. */
export interface SessionPolicy { accessTokenMinutes: number; idleTimeoutMinutes: number; mfaRequiredFrom: string | null; mfaGraceDays: number }
export interface SessionMfa { required: boolean; enrolled: boolean; dueAt: string | null }
export interface Session { user: SessionUser; token: string; refreshToken: string; sessionId?: string; policy?: SessionPolicy; mfa?: SessionMfa }
/** The password was right and sign-in stopped for the second step. */
export interface MfaChallenge { mfaRequired: true; mfaToken: string; method: 'totp'; expiresInSec: number }
export interface MfaEnrolment { mfaEnrolmentRequired: true; mfaToken: string; dueAt: string; expiresInSec: number }
export type LoginOutcome = Session | MfaChallenge | MfaEnrolment;
export interface Meta { total?: number; page?: number; limit?: number; unread?: number; defaults?: Record<string, unknown>; [k: string]: unknown }
export interface Envelope<T> { success: true; data: T; meta?: Meta }
export type Tone = 'default' | 'success' | 'warning' | 'error' | 'info';
export interface StatCardData { label: string; value: string | number; sub?: string; tone?: Tone }
export interface Column<R = any> { key: string; label: string; render?: (row: R) => React.ReactNode; sortable?: boolean; align?: 'left' | 'right' | 'center'; width?: number | string; mono?: boolean; noExport?: boolean; exportValue?: (row: R) => unknown }
export interface Option { value: string; label: string }
export interface FieldSpec { name: string; label: string; type?: 'text' | 'number' | 'select' | 'multiline' | 'date' | 'datetime' | 'switch' | 'autocomplete' | 'password' | 'email'; options?: Option[]; /** A Data Studio master the options come from, instead of an inline list. */ lookup?: string; required?: boolean; cols?: number; disabled?: boolean; placeholder?: string; helper?: string; rows?: number }
export interface Notification { id: string; title: string; body?: string; severity?: 'info' | 'success' | 'warning' | 'error'; link?: string | null; read: boolean; createdAt: string }
