import { EVENTS, type Actor } from '@maritime/contracts';
import { enqueue, eventFromContext, getContext, type Queryable } from '@maritime/service-kit';
import { isValidTimeZone, nextRun, parseCron, CronError } from './cron';

export const SCHEDULER_LOCK_KEY = 7331;
export const SCHEDULER_ACTOR: Actor = { id: 'scheduler', name: 'scheduler', kind: 'system' };

export interface JobRow {
  id: string; key: string; name: string; name_ar: string | null; cron: string; timezone: string; event_type: string; payload: Record<string, unknown>; enabled: boolean;
  next_run_at: Date | null; last_run_at: Date | null; last_status: string | null; last_error: string | null; runs: number; owner: string; created_at: Date; updated_at: Date;
}
export interface RunRow { id: string; job_key: string; scheduled_for: Date | null; fired_at: Date; trigger: string; status: string; event_id: string | null; event_type: string; error: string | null; triggered_by: Actor | null }
export interface JobDefinition { key: string; name: string; nameAr?: string | null; cron: string; timezone?: string; eventType: string; payload?: Record<string, unknown>; enabled?: boolean; owner?: string }

export const jobToApi = (r: JobRow) => ({ key: r.key, name: r.name, nameAr: r.name_ar, cron: r.cron, timezone: r.timezone, eventType: r.event_type, payload: r.payload, enabled: r.enabled, nextRunAt: r.next_run_at, lastRunAt: r.last_run_at, lastStatus: r.last_status, lastError: r.last_error, runs: r.runs, owner: r.owner, createdAt: r.created_at, updatedAt: r.updated_at });
export const runToApi = (r: RunRow) => ({ id: Number(r.id), jobKey: r.job_key, scheduledFor: r.scheduled_for, firedAt: r.fired_at, trigger: r.trigger, status: r.status, eventId: r.event_id, eventType: r.event_type, error: r.error, triggeredBy: r.triggered_by });

/** The platform's standing jobs. Each fires one event; the owning service consumes it. Times are Asia/Dubai. */
export const SEED_JOBS: JobDefinition[] = [
  { key: 'notification-escalation', name: 'Unread critical notices — escalation', nameAr: 'تصعيد التنبيهات الحرجة غير المقروءة', cron: '*/30 * * * *', eventType: EVENTS.scheduler.escalateNotifications, payload: {}, owner: 'notifications' },
  { key: 'audit-retention', name: 'Audit ledger retention', nameAr: 'فترة الاحتفاظ بسجل التدقيق', cron: '45 2 * * *', eventType: EVENTS.scheduler.sweepAuditRetention, payload: {}, owner: 'audit-ledger' },
  { key: 'certificate-expiry-digest', name: 'Certificate expiry digest', nameAr: 'ملخص انتهاء صلاحية الشهادات', cron: '0 7 * * *', eventType: EVENTS.scheduler.digestCertificates, payload: { windowDays: 30 }, owner: 'ships' },
  { key: 'licence-renewal-reminders', name: 'Licence renewal reminders', nameAr: 'تذكيرات تجديد التراخيص', cron: '0 7 * * *', eventType: EVENTS.scheduler.remindersLicences, payload: { reminderDays: [60, 30, 7] }, owner: 'instruments' },
  { key: 'invoice-overdue-digest', name: 'Invoice overdue digest', nameAr: 'ملخص الفواتير المتأخرة', cron: '0 8 * * 1', eventType: EVENTS.scheduler.digestInvoices, payload: {}, owner: 'revenue' },
  { key: 'sla-breach-sweep', name: 'SLA breach sweep', nameAr: 'مسح تجاوزات اتفاقية مستوى الخدمة', cron: '*/15 * * * *', eventType: EVENTS.scheduler.sweepSla, payload: {}, owner: 'workflow' },
  { key: 'ais-gap-sweep', name: 'AIS gap sweep', nameAr: 'مسح انقطاع إشارات نظام التعرف الآلي', cron: '*/5 * * * *', eventType: EVENTS.scheduler.sweepAis, payload: { gapMinutes: 30 }, owner: 'maritime-centre' },
  { key: 'decision-escalation', name: 'Decision escalation', nameAr: 'تصعيد القرارات المعلقة', cron: '0 * * * *', eventType: EVENTS.scheduler.sweepDecisions, payload: {}, owner: 'ai-agents' },
  { key: 'document-retention', name: 'Document retention sweep', nameAr: 'مسح فترة الاحتفاظ بالوثائق', cron: '30 2 * * *', eventType: EVENTS.scheduler.sweepRetention, payload: {}, owner: 'documents' },
  { key: 'audit-verify', name: 'Audit chain verification', nameAr: 'التحقق من سلسلة سجل التدقيق', cron: '0 3 * * *', eventType: EVENTS.scheduler.verifyAudit, payload: {}, owner: 'audit-ledger' },
  { key: 'accreditation-renewal-sweep', name: 'Accreditation renewal sweep', nameAr: 'مسح تجديد الاعتمادات', cron: '15 7 * * *', eventType: EVENTS.scheduler.sweepAccreditations, payload: {}, owner: 'facilities' },
  { key: 'imo-source-poll', name: 'IMO source monitoring', nameAr: 'رصد مصادر المنظمة البحرية الدولية', cron: '30 */6 * * *', eventType: EVENTS.scheduler.pollImoSources, payload: {}, owner: 'legislation' },
  { key: 'finding-overdue-sweep', name: 'Overdue deficiency sweep', nameAr: 'مسح أوجه القصور المتأخرة', cron: '0 6 * * *', eventType: EVENTS.scheduler.sweepFindings, owner: 'inspection' },
  // the surveillance picture: read the AIS/LRIT feed through the integration hub every couple of minutes
  { key: 'ais-positions-poll', name: 'AIS/LRIT feed read', nameAr: 'قراءة تغذية AIS/LRIT', cron: '*/2 * * * *', eventType: EVENTS.scheduler.pollAisPositions, payload: {}, owner: 'maritime-centre' },
  // the long-range picture: the LRIT data centre holds a report per ship every six hours, so it is read on the half hour
  { key: 'lrit-positions-poll', name: 'LRIT data centre read', nameAr: 'قراءة مركز بيانات التعرف والتتبع بعيد المدى', cron: '*/30 * * * *', eventType: EVENTS.scheduler.pollLritPositions, payload: {}, owner: 'maritime-centre' },
  // the models: fitted again each week on the records that have accrued, as drafts for a person to approve
  { key: 'model-retraining', name: 'Model retraining', nameAr: 'إعادة تدريب النماذج', cron: '0 4 * * 1', eventType: EVENTS.scheduler.retrainModels, payload: {}, owner: 'ai-models' },
  // accounts: who still holds what, every quarter; and a daily look for accounts nobody has used
  { key: 'access-review-open', name: 'Access review — open the quarterly cycle', nameAr: 'مراجعة الصلاحيات — فتح الدورة الفصلية', cron: '0 6 1 */3 *', eventType: EVENTS.scheduler.openAccessReview, owner: 'identity-access' },
  { key: 'dormant-account-sweep', name: 'Dormant account sweep', nameAr: 'مسح الحسابات الخاملة', cron: '20 5 * * *', eventType: EVENTS.scheduler.sweepDormant, owner: 'identity-access' },
];

export function validateSchedule(cron: string, timezone: string): void {
  parseCron(cron);
  if (!isValidTimeZone(timezone)) throw new CronError(`unknown time zone "${timezone}"`);
}

/** Creates or updates a job by key. The next run is recomputed only when the schedule changed, so a redeploy never re-fires or postpones a job. */
export async function upsertJob(client: Queryable, def: JobDefinition, defaultTimezone: string, now = new Date()): Promise<JobRow> {
  const timezone = def.timezone ?? defaultTimezone;
  validateSchedule(def.cron, timezone);
  const next = nextRun(def.cron, now, timezone);
  const r = await client.query<JobRow>(
    `INSERT INTO jobs(key, name, name_ar, cron, timezone, event_type, payload, enabled, next_run_at, owner)
     VALUES ($1, $2, $3, $4, $5, $6, $7, coalesce($8::boolean, true), $9, $10)
     ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, name_ar = coalesce(EXCLUDED.name_ar, jobs.name_ar), cron = EXCLUDED.cron, timezone = EXCLUDED.timezone, event_type = EXCLUDED.event_type, payload = EXCLUDED.payload,
       enabled = coalesce($8::boolean, jobs.enabled), owner = EXCLUDED.owner,
       next_run_at = CASE WHEN jobs.cron = EXCLUDED.cron AND jobs.timezone = EXCLUDED.timezone AND jobs.next_run_at IS NOT NULL AND jobs.enabled THEN jobs.next_run_at ELSE EXCLUDED.next_run_at END,
       updated_at = now()
     RETURNING *`,
    [def.key, def.name, def.nameAr ?? null, parseCron(def.cron).expr, timezone, def.eventType, JSON.stringify(def.payload ?? {}), def.enabled ?? null, next, def.owner ?? 'platform']);
  return r.rows[0];
}

/** Fires one job: the event goes into the outbox in the same transaction as the run record; scheduled firings advance the next run from now, so a backlog of missed runs fires exactly once. */
export async function fireJob(client: Queryable, source: string, job: JobRow, opts: { trigger: 'SCHEDULE' | 'MANUAL'; now: Date; scheduledFor: Date | null }): Promise<{ run: RunRow; eventId: string; nextRunAt: Date | null }> {
  const actor = opts.trigger === 'SCHEDULE' ? SCHEDULER_ACTOR : getContext()?.actor ?? SCHEDULER_ACTOR;
  const data = { ...job.payload, jobKey: job.key, jobName: job.name, trigger: opts.trigger, scheduledFor: opts.scheduledFor ? new Date(opts.scheduledFor).toISOString() : null, firedAt: opts.now.toISOString() };
  const event = eventFromContext(source, job.event_type, data, { subject: job.key, actor });
  await enqueue(client, event);
  const run = await client.query<RunRow>('INSERT INTO job_runs(job_key, scheduled_for, fired_at, trigger, status, event_id, event_type, triggered_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
    [job.key, opts.scheduledFor, opts.now, opts.trigger, 'FIRED', event.id, job.event_type, JSON.stringify(actor)]);
  const nextRunAt = opts.trigger === 'SCHEDULE' ? nextRun(job.cron, opts.now, job.timezone) : job.next_run_at;
  await client.query('UPDATE jobs SET last_run_at = $2, last_status = $3, last_error = NULL, runs = runs + 1, next_run_at = $4, updated_at = now() WHERE key = $1', [job.key, opts.now, 'FIRED', nextRunAt]);
  return { run: run.rows[0], eventId: event.id, nextRunAt };
}

/* The daily digests fire at the hour Settings → Notifications names. The minute and the day fields are the job's own;
 * only the hour follows the setting, so a weekly digest stays weekly and a quarter-past sweep stays quarter past. */
export const DIGEST_JOBS = ['certificate-expiry-digest', 'licence-renewal-reminders', 'invoice-overdue-digest', 'finding-overdue-sweep', 'accreditation-renewal-sweep'] as const;
export const withHour = (cron: string, hour: number) => { const f = cron.trim().split(/\s+/); if (f.length !== 5) return cron; f[1] = String(Math.min(23, Math.max(0, Math.round(hour)))); return f.join(' '); };
export async function applyDigestHour(client: Queryable, hour: number, defaultTimezone: string, now = new Date()): Promise<string[]> {
  if (!Number.isFinite(hour)) return [];
  const rows = await client.query<JobRow>('SELECT * FROM jobs WHERE key = ANY($1)', [[...DIGEST_JOBS]]);
  const changed: string[] = [];
  for (const job of rows.rows) {
    const cron = withHour(job.cron, hour); if (cron === job.cron) continue;
    await upsertJob(client, { key: job.key, name: job.name, nameAr: job.name_ar, cron, timezone: job.timezone, eventType: job.event_type, payload: job.payload, enabled: job.enabled, owner: job.owner }, defaultTimezone, now);
    changed.push(job.key);
  }
  return changed;
}
