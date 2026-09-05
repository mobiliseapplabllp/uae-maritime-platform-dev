import { Inject, Injectable } from '@nestjs/common';
import { MODULE_SETTING_DEFAULTS } from '@maritime/contracts';
import { KIT_SETTINGS, type SettingsClient } from '@maritime/service-kit';

/**
 * The security policy an administration sets on the Users & Security settings page. Read at the moment it matters —
 * token lifetimes at sign-in, the idle window at refresh, the deadline at the second-factor check — never captured at
 * boot, so a change on the settings page is live on the next request.
 */
export interface AdminPolicy {
  accessTokenMinutes: number; refreshTokenHours: number; idleTimeoutMinutes: number; passwordMinLength: number; auditRetentionDays: number;
  /** ISO date from which roles that require a second factor must have enrolled; empty means enrolment is encouraged, not enforced. */
  mfaRequiredFrom: string; mfaGraceDays: number;
  dormantAfterDays: number; dormantAction: 'FLAG' | 'DEACTIVATE'; accessReviewDays: number;
  /** A role holding any of these is privileged: granting it, or editing it, takes a second administrator. */
  fourEyesPermissions: string[];
}
const DEFAULTS = MODULE_SETTING_DEFAULTS.admin as unknown as AdminPolicy;
const clamp = (v: unknown, lo: number, hi: number, fallback: number) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.floor(n))) : fallback; };

export function normalisePolicy(raw: Record<string, unknown>): AdminPolicy {
  const from = String(raw.mfaRequiredFrom ?? '').trim();
  return {
    accessTokenMinutes: clamp(raw.accessTokenMinutes, 5, 24 * 60, DEFAULTS.accessTokenMinutes),
    refreshTokenHours: clamp(raw.refreshTokenHours, 1, 30 * 24, DEFAULTS.refreshTokenHours),
    idleTimeoutMinutes: clamp(raw.idleTimeoutMinutes, 5, 24 * 60, DEFAULTS.idleTimeoutMinutes),
    passwordMinLength: clamp(raw.passwordMinLength, 12, 64, DEFAULTS.passwordMinLength),
    auditRetentionDays: clamp(raw.auditRetentionDays, 30, 36500, DEFAULTS.auditRetentionDays),
    mfaRequiredFrom: /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : '',
    mfaGraceDays: clamp(raw.mfaGraceDays, 0, 365, DEFAULTS.mfaGraceDays),
    dormantAfterDays: clamp(raw.dormantAfterDays, 30, 3650, DEFAULTS.dormantAfterDays),
    dormantAction: raw.dormantAction === 'FLAG' ? 'FLAG' : 'DEACTIVATE',
    accessReviewDays: clamp(raw.accessReviewDays, 30, 730, DEFAULTS.accessReviewDays),
    fourEyesPermissions: Array.isArray(raw.fourEyesPermissions) ? raw.fourEyesPermissions.map(String).filter(Boolean) : DEFAULTS.fourEyesPermissions,
  };
}

@Injectable()
export class PolicyService {
  private override: Partial<AdminPolicy> | null = null;
  constructor(@Inject(KIT_SETTINGS) private readonly settings: SettingsClient) {}
  /** Tests and operators' tooling can pin a policy in memory; production reads the settings service. */
  setOverride(o: Partial<AdminPolicy> | null) { this.override = o; }
  async get(): Promise<AdminPolicy> {
    const stored = await this.settings.moduleGet<Record<string, unknown>>('admin', { ...(DEFAULTS as unknown as Record<string, unknown>) });
    return normalisePolicy({ ...stored, ...(this.override ?? {}) });
  }
  /** The part of the policy a signed-in client is told, so the screen can warn before the server acts. */
  static forClient(p: AdminPolicy) { return { accessTokenMinutes: p.accessTokenMinutes, idleTimeoutMinutes: p.idleTimeoutMinutes, mfaRequiredFrom: p.mfaRequiredFrom || null, mfaGraceDays: p.mfaGraceDays }; }
  /** The date from which an unenrolled account in a role that requires a second factor is refused, or null when not enforced. */
  static mfaEnforcedFrom(p: AdminPolicy): Date | null { return p.mfaRequiredFrom ? new Date(`${p.mfaRequiredFrom}T00:00:00.000Z`) : null; }
}
