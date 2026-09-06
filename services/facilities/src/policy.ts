import type { SettingsClient } from '@maritime/service-kit';
import type { Env } from './env';

/** Port Companies → settings laid over the environment: the renewal reminder window and the audit interval. Read at the moment they matter, never captured at boot. */
export async function policyOf(settings: SettingsClient, env: Env): Promise<Env> {
  const s = await settings.moduleGet('facil', { renewalReminderDays: env.RENEWAL_WINDOW_DAYS, auditIntervalMonths: env.AUDIT_INTERVAL_MONTHS });
  return { ...env, RENEWAL_WINDOW_DAYS: Number(s.renewalReminderDays) || env.RENEWAL_WINDOW_DAYS, AUDIT_INTERVAL_MONTHS: Number(s.auditIntervalMonths) || env.AUDIT_INTERVAL_MONTHS };
}
