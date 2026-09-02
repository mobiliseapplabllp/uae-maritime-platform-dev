/** Response envelopes shared by every service and consumed unchanged by the web and mobile clients. */
export interface ApiSuccess<T> { success: true; data: T; meta?: PageMeta }
export interface ApiFailure { success: false; message: string; data?: unknown }
export type ApiResponse<T> = ApiSuccess<T> | ApiFailure;
export interface PageMeta { total: number; page: number; limit: number }
export interface PageQuery { page?: number | string; limit?: number | string; sort?: string; q?: string; [k: string]: unknown }
export const DEFAULT_PAGE_LIMIT = 20;
export const MAX_PAGE_LIMIT = 100;
