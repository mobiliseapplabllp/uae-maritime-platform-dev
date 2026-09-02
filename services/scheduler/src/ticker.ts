import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool } from 'pg';
import { KIT_ENV, KIT_LOGGER, KIT_POOL, type AppLogger } from '@maritime/service-kit';
import type { Env } from './env';
import { SCHEDULER_LOCK_KEY, fireJob, type JobRow } from './jobs';
import { isValidCron } from './cron';

export interface TickResult { fired: number; failed: number; skipped: boolean; at: Date }

/** The firing loop. One ticker across every replica wins the session advisory lock; the others skip the tick. Due jobs are fired inside one transaction with their outbox events and run records. */
@Injectable()
export class Ticker implements OnModuleInit, OnModuleDestroy {
  lastTickAt: Date | null = null;
  lastTickFired = 0;
  lockHeld = false;
  private timer?: NodeJS.Timeout;
  private running = false;
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, @Inject(KIT_LOGGER) private readonly log: AppLogger) {}
  onModuleInit() {
    if (this.env.SCHEDULER_TICK_MS > 0) { this.timer = setInterval(() => void this.tick(), this.env.SCHEDULER_TICK_MS); this.timer.unref?.(); }
  }
  onModuleDestroy() { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  async tick(now = new Date()): Promise<TickResult> {
    if (this.running) return { fired: 0, failed: 0, skipped: true, at: now };
    this.running = true;
    const client = await this.pool.connect();
    try {
      const lock = await client.query<{ ok: boolean }>('SELECT pg_try_advisory_lock($1) AS ok', [SCHEDULER_LOCK_KEY]);
      if (!lock.rows[0].ok) { this.lockHeld = false; return { fired: 0, failed: 0, skipped: true, at: now }; }
      this.lockHeld = true;
      try {
        await client.query('BEGIN');
        const due = await client.query<JobRow>('SELECT * FROM jobs WHERE enabled AND next_run_at IS NOT NULL AND next_run_at <= $1 ORDER BY next_run_at, key FOR UPDATE SKIP LOCKED', [now]);
        let fired = 0; let failed = 0;
        for (const job of due.rows) {
          await client.query('SAVEPOINT job');
          try { await fireJob(client, this.env.SERVICE_NAME, job, { trigger: 'SCHEDULE', now, scheduledFor: job.next_run_at }); fired++; }
          catch (e) {
            await client.query('ROLLBACK TO SAVEPOINT job');
            failed++;
            const message = (e as Error).message ?? String(e);
            this.log.error({ err: e, job: job.key }, 'job failed to fire');
            await client.query('INSERT INTO job_runs(job_key, scheduled_for, fired_at, trigger, status, event_type, error) VALUES ($1,$2,$3,$4,$5,$6,$7)', [job.key, job.next_run_at, now, 'SCHEDULE', 'FAILED', job.event_type, message.slice(0, 1000)]);
            const retryable = isValidCron(job.cron);
            await client.query('UPDATE jobs SET last_run_at = $2, last_status = $3, last_error = $4, enabled = $5, next_run_at = $6, updated_at = now() WHERE key = $1',
              [job.key, now, 'FAILED', message.slice(0, 1000), retryable, retryable ? new Date(now.getTime() + 5 * 60_000) : null]);
          }
          await client.query('RELEASE SAVEPOINT job');
        }
        await client.query('COMMIT');
        this.lastTickAt = now; this.lastTickFired = fired;
        if (fired || failed) this.log.info({ fired, failed }, 'scheduler tick');
        return { fired, failed, skipped: false, at: now };
      } catch (e) { await client.query('ROLLBACK').catch(() => undefined); throw e; }
      finally { await client.query('SELECT pg_advisory_unlock($1)', [SCHEDULER_LOCK_KEY]).catch(() => undefined); this.lockHeld = false; }
    } catch (e) {
      this.log.warn({ err: e }, 'scheduler tick failed');
      return { fired: 0, failed: 0, skipped: true, at: now };
    } finally { client.release(); this.running = false; }
  }
}
