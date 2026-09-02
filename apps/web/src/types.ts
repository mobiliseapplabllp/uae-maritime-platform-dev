import type { TenancyScope } from '@maritime/contracts';

export interface SessionRole { id: string; name: string; permissions: string[] }
export interface SessionUser {
  id: string; name: string; email: string; designation?: string; department?: string; phone?: string; active: boolean;
  kind: 'user' | 'agent' | 'service'; scope: TenancyScope; role: SessionRole; perms: string[]; lastLoginAt?: string | null;
}
export interface Session { user: SessionUser; token: string; refreshToken: string }
export interface Meta { total?: number; page?: number; limit?: number; unread?: number; defaults?: Record<string, unknown>; [k: string]: unknown }
export interface Envelope<T> { success: true; data: T; meta?: Meta }
export type Tone = 'default' | 'success' | 'warning' | 'error' | 'info';
export interface StatCardData { label: string; value: string | number; sub?: string; tone?: Tone }
export interface Column<R = any> { key: string; label: string; render?: (row: R) => React.ReactNode; sortable?: boolean; align?: 'left' | 'right' | 'center'; width?: number | string; mono?: boolean; noExport?: boolean; exportValue?: (row: R) => unknown }
export interface Option { value: string; label: string }
export interface FieldSpec { name: string; label: string; type?: 'text' | 'number' | 'select' | 'multiline' | 'date' | 'datetime' | 'switch' | 'autocomplete' | 'password' | 'email'; options?: Option[]; required?: boolean; cols?: number; disabled?: boolean; placeholder?: string; helper?: string; rows?: number }
export interface Notification { id: string; title: string; body?: string; severity?: 'info' | 'success' | 'warning' | 'error'; link?: string | null; read: boolean; createdAt: string }
