import { Inject, Injectable, UnauthorizedException, ConflictException, HttpException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import type { Pool } from 'pg';
import { EVENTS } from '@maritime/contracts';
import { KIT_ENV, KIT_POOL, AuditClient, withTx, enqueue, eventFromContext, badRequest, generateTotpSecret, generateRecoveryCodes, otpauthUri, verifyTotp, type Queryable } from '@maritime/service-kit';
import { UsersRepo, type UserRow } from '../users/users.repo';
import { SecretBox, sha256hex } from './secrets';
import type { Env } from '../env';

/**
 * The second factor: an authenticator app on the person's own device.
 *
 * Enrolment is two steps so a secret nobody scanned is never activated: setup hands out the secret and the URI, and
 * activation proves the app produces the right code before the account starts demanding one. A code is accepted once
 * — the step it came from is remembered, and the same code offered again is a replay and is refused. Recovery codes
 * are shown once and stored hashed; each one works once.
 */
@Injectable()
export class MfaService {
  private readonly box: SecretBox;
  constructor(@Inject(KIT_ENV) private readonly env: Env, @Inject(KIT_POOL) private readonly pool: Pool, private readonly users: UsersRepo, private readonly audit: AuditClient) {
    this.box = new SecretBox(env.MFA_KEY ?? env.JWT_SECRET);
  }

  private async throttleCheck(identity: string) {
    const r = await this.pool.query<{ locked_until: Date | null }>('SELECT locked_until FROM login_attempts WHERE identity = $1', [identity]);
    if (r.rows[0]?.locked_until && r.rows[0].locked_until.getTime() > Date.now()) throw new HttpException({ success: false, message: 'Too many failed attempts. Try again later.' }, 429);
  }
  private async throttleFail(identity: string) {
    const windowMs = this.env.LOGIN_WINDOW_MIN * 60_000;
    await this.pool.query(
      `INSERT INTO login_attempts(identity, failures, first_failure_at) VALUES ($1, 1, now())
       ON CONFLICT (identity) DO UPDATE SET
         failures = CASE WHEN login_attempts.first_failure_at < now() - ($2::int * interval '1 millisecond') THEN 1 ELSE login_attempts.failures + 1 END,
         first_failure_at = CASE WHEN login_attempts.first_failure_at < now() - ($2::int * interval '1 millisecond') THEN now() ELSE login_attempts.first_failure_at END,
         locked_until = CASE WHEN (CASE WHEN login_attempts.first_failure_at < now() - ($2::int * interval '1 millisecond') THEN 1 ELSE login_attempts.failures + 1 END) >= $3 THEN now() + ($2::int * interval '1 millisecond') ELSE NULL END`,
      [identity, windowMs, this.env.LOGIN_MAX_ATTEMPTS]);
  }
  private async throttleClear(identity: string) { await this.pool.query('DELETE FROM login_attempts WHERE identity = $1', [identity]); }

  /** Step one: a fresh secret the app can scan. Nothing about the account changes until a code proves the scan. */
  async setup(user: UserRow): Promise<{ secret: string; otpauthUri: string; issuer: string; account: string }> {
    const secret = generateTotpSecret();
    await this.pool.query('UPDATE users SET mfa_pending_secret = $1, updated_at = now() WHERE id = $2', [this.box.seal(secret), user.id]);
    return { secret, otpauthUri: otpauthUri(this.env.MFA_ISSUER, user.email, secret), issuer: this.env.MFA_ISSUER, account: user.email };
  }

  /** Step two: the first code from the app activates the factor and mints the recovery codes, shown this once. */
  async activate(user: UserRow, code: string): Promise<{ recoveryCodes: string[] }> {
    if (!user.mfa_pending_secret) throw badRequest('Start the setup first');
    const secret = this.box.open(user.mfa_pending_secret);
    const step = verifyTotp(secret, code);
    if (step === null) { await this.throttleFail(`mfa:${user.email.toLowerCase()}`); throw new UnauthorizedException('That code is not right. Check the time on your device and try the next code.'); }
    const codes = generateRecoveryCodes();
    await withTx(this.pool, async (c) => {
      await c.query('UPDATE users SET mfa_secret = $1, mfa_pending_secret = NULL, mfa_enrolled_at = now(), mfa_last_step = $2, mfa_recovery = $3, updated_at = now() WHERE id = $4',
        [this.box.seal(secret), step, codes.map(sha256hex), user.id]);
      await this.audit.record(c, { action: 'MFA_ENROLLED', entity: 'User', entityId: user.id, entityLabel: user.email, actor: { id: user.id, name: user.name, email: user.email, kind: 'user' } });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.identity.mfaChanged, { userId: user.id, email: user.email, enrolled: true }));
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.identity.userChanged, { userId: user.id, change: 'mfa' }));
    });
    await this.throttleClear(`mfa:${user.email.toLowerCase()}`);
    return { recoveryCodes: codes };
  }

  /** The check at sign-in: the app's code, or one of the recovery codes. Either way, once. */
  async verify(user: UserRow, code: string): Promise<'totp' | 'recovery'> {
    const identity = `mfa:${user.email.toLowerCase()}`;
    await this.throttleCheck(identity);
    if (!user.mfa_secret || !user.mfa_enrolled_at) throw new UnauthorizedException('Two-step verification is not set up on this account');
    const given = String(code ?? '').trim().toLowerCase();
    const step = verifyTotp(this.box.open(user.mfa_secret), given, { notBefore: user.mfa_last_step == null ? null : Number(user.mfa_last_step) });
    if (step !== null) {
      await this.pool.query('UPDATE users SET mfa_last_step = $1 WHERE id = $2', [step, user.id]);
      await this.throttleClear(identity);
      return 'totp';
    }
    const hash = sha256hex(given.replace(/\s+/g, ''));
    if ((user.mfa_recovery ?? []).includes(hash)) {
      await withTx(this.pool, async (c) => {
        await c.query('UPDATE users SET mfa_recovery = array_remove(mfa_recovery, $1) WHERE id = $2', [hash, user.id]);
        await this.audit.record(c, { action: 'MFA_RECOVERY_USED', entity: 'User', entityId: user.id, entityLabel: user.email, actor: { id: user.id, name: user.name, email: user.email, kind: 'user' } });
      });
      await this.throttleClear(identity);
      return 'recovery';
    }
    await this.throttleFail(identity);
    throw new UnauthorizedException('That code is not right');
  }

  /** New recovery codes, replacing whatever was left; the person proves the password first. */
  async regenerateRecovery(user: UserRow, password: string): Promise<{ recoveryCodes: string[] }> {
    if (!user.password_hash || !(await bcrypt.compare(password, user.password_hash))) throw new UnauthorizedException('Current password is incorrect');
    if (!user.mfa_enrolled_at) throw badRequest('Two-step verification is not set up');
    const codes = generateRecoveryCodes();
    await withTx(this.pool, async (c) => {
      await c.query('UPDATE users SET mfa_recovery = $1, updated_at = now() WHERE id = $2', [codes.map(sha256hex), user.id]);
      await this.audit.record(c, { action: 'MFA_RECOVERY_RESET', entity: 'User', entityId: user.id, entityLabel: user.email, actor: { id: user.id, name: user.name, email: user.email, kind: 'user' } });
    });
    return { recoveryCodes: codes };
  }

  /** A person may switch the factor off only where their role does not require it; the password is asked for again. */
  async disable(user: UserRow, password: string): Promise<void> {
    if (!user.password_hash || !(await bcrypt.compare(password, user.password_hash))) throw new UnauthorizedException('Current password is incorrect');
    if (user.role_mfa_required) throw new ConflictException('Your role requires two-step verification; an administrator can reset it if you have lost your device');
    await this.clear(this.pool, user, { id: user.id, name: user.name, email: user.email, kind: 'user' }, 'MFA_DISABLED');
  }

  /** An administrator's reset: the person enrols again at their next sign-in, and every session they hold ends now. */
  async reset(user: UserRow, by: { id: string; name: string; email?: string }): Promise<void> {
    await withTx(this.pool, async (c) => {
      await this.clear(c, user, { ...by, kind: 'user' }, 'MFA_RESET');
      await this.users.revokeSessions(user.id, c);
    });
  }
  private async clear(c: Queryable, user: UserRow, actor: { id: string; name: string; email?: string; kind: 'user' | 'system' }, action: string) {
    await c.query('UPDATE users SET mfa_secret = NULL, mfa_pending_secret = NULL, mfa_enrolled_at = NULL, mfa_last_step = NULL, mfa_recovery = $1, mfa_due_at = NULL, updated_at = now() WHERE id = $2', [[], user.id]);
    await this.audit.record(c, { action, entity: 'User', entityId: user.id, entityLabel: user.email, actor });
    await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.identity.mfaChanged, { userId: user.id, email: user.email, enrolled: false }));
    await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.identity.userChanged, { userId: user.id, change: 'mfa' }));
  }
}
