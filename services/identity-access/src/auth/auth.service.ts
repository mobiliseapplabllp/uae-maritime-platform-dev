import { Inject, Injectable, UnauthorizedException, ForbiddenException, HttpException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { EVENTS, passwordProblems } from '@maritime/contracts';
import { KIT_ENV, KIT_POOL, KIT_LOGGER, AuditClient, signHS256, verifyJwt, withTx, badRequest, enqueue, eventFromContext, type AppLogger, type JwtClaims } from '@maritime/service-kit';
import { UsersRepo, toSafe, type UserRow } from '../users/users.repo';
import { PolicyService, type AdminPolicy } from '../policy';
import { MfaService } from '../mfa/mfa.service';
import type { Env } from '../env';

/** Pre-computed hash so an unknown account costs the same time as a wrong password. */
const DUMMY_HASH = bcrypt.hashSync('timing-equalised-dummy-password', 10);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Equal-length digest comparison, so no secret is compared byte-by-byte with an early exit. */
const sameSecret = (a: string, b: string) => timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'));
const MFA_TOKEN_SEC = 5 * 60;

export interface ClientContext { ip?: string; userAgent?: string }
/** A signed-in session, with the policy the client is expected to honour and where the second factor stands. */
export interface Session {
  user: ReturnType<typeof toSafe>; token: string; refreshToken: string; sessionId: string;
  policy: ReturnType<typeof PolicyService.forClient>;
  mfa: { required: boolean; enrolled: boolean; dueAt: string | null };
}
/** The password was right and a second step is needed before a session exists. */
export interface MfaChallenge { mfaRequired: true; mfaToken: string; method: 'totp'; expiresInSec: number }
export interface MfaEnrolment { mfaEnrolmentRequired: true; mfaToken: string; dueAt: string; expiresInSec: number }
export type LoginOutcome = Session | MfaChallenge | MfaEnrolment;

@Injectable()
export class AuthService {
  constructor(
    @Inject(KIT_ENV) private readonly env: Env,
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_LOGGER) private readonly log: AppLogger,
    private readonly users: UsersRepo,
    private readonly audit: AuditClient,
    private readonly policy: PolicyService,
    private readonly mfa: MfaService,
  ) {}

  private async throttleCheck(identity: string) {
    const r = await this.pool.query<{ failures: number; locked_until: Date | null; first_failure_at: Date }>('SELECT failures, locked_until, first_failure_at FROM login_attempts WHERE identity = $1', [identity]);
    const row = r.rows[0];
    if (row?.locked_until && row.locked_until.getTime() > Date.now()) throw new HttpException({ success: false, message: 'Too many failed attempts. Try again later.' }, 429);
  }
  private async throttleFail(identity: string) {
    const windowMs = this.env.LOGIN_WINDOW_MIN * 60_000;
    await this.pool.query(
      `INSERT INTO login_attempts(identity, failures, first_failure_at) VALUES ($1, 1, now())
       ON CONFLICT (identity) DO UPDATE SET
         failures = CASE WHEN login_attempts.first_failure_at < now() - ($2::int * interval '1 millisecond') THEN 1 ELSE login_attempts.failures + 1 END,
         first_failure_at = CASE WHEN login_attempts.first_failure_at < now() - ($2::int * interval '1 millisecond') THEN now() ELSE login_attempts.first_failure_at END,
         locked_until = CASE WHEN (CASE WHEN login_attempts.first_failure_at < now() - ($2::int * interval '1 millisecond') THEN 1 ELSE login_attempts.failures + 1 END) >= $3 THEN now() + ($2::int * interval '1 millisecond') ELSE NULL END`,
      [identity, windowMs, this.env.LOGIN_MAX_ATTEMPTS],
    );
  }
  private async throttleClear(identity: string) { await this.pool.query('DELETE FROM login_attempts WHERE identity = $1', [identity]); }

  /* ------------------------------------------------------------------------------------------- sign-in --- */
  async login(email: string, password: string, ctx: ClientContext = {}): Promise<LoginOutcome> {
    const identity = email.toLowerCase();
    await this.throttleCheck(identity);
    if (this.env.AUTH_MODE === 'keycloak') return this.loginKeycloak(identity, password);
    const user = await this.users.byEmail(identity);
    const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) { await this.throttleFail(identity); throw new UnauthorizedException('Invalid email or password'); }
    if (!user.active) { await this.throttleFail(identity); throw new ForbiddenException('Account is inactive'); }
    await this.throttleClear(identity);
    return this.secondStep(user, ctx);
  }

  /**
   * The password was right. An enrolled account now answers its authenticator; an account in a role that requires one
   * and has none is refused once the policy's deadline has passed, and told the date until then.
   */
  private async secondStep(user: UserRow, ctx: ClientContext): Promise<LoginOutcome> {
    const policy = await this.policy.get();
    if (user.mfa_enrolled_at) return { mfaRequired: true, mfaToken: this.mintMfaToken(user, 'verify'), method: 'totp', expiresInSec: MFA_TOKEN_SEC };
    const from = PolicyService.mfaEnforcedFrom(policy);
    if (user.role_mfa_required && from && from.getTime() <= Date.now()) {
      let due = user.mfa_due_at;
      if (!due) {
        // the clock starts the first time the person signs in after the policy took effect, so nobody is locked out by a date they never saw
        due = new Date(Math.max(from.getTime(), Date.now()) + policy.mfaGraceDays * 86_400_000);
        await this.pool.query('UPDATE users SET mfa_due_at = $1 WHERE id = $2', [due, user.id]);
      }
      if (due.getTime() <= Date.now()) return { mfaEnrolmentRequired: true, mfaToken: this.mintMfaToken(user, 'enrol'), dueAt: due.toISOString(), expiresInSec: MFA_TOKEN_SEC };
      return this.issueSession({ ...user, mfa_due_at: due }, ctx, policy);
    }
    return this.issueSession(user, ctx, policy);
  }

  private mintMfaToken(user: UserRow, purpose: 'verify' | 'enrol'): string {
    return signHS256({ sub: user.id, typ: 'mfa', purpose, jti: randomBytes(8).toString('hex') }, this.env.JWT_SECRET, { expiresInSec: MFA_TOKEN_SEC, issuer: this.env.JWT_ISSUER });
  }
  /** The account an MFA token stands for, or nothing — a token of the wrong purpose is nothing too. */
  async userFromMfaToken(token: string, purpose: 'verify' | 'enrol' | 'any'): Promise<UserRow> {
    let claims: JwtClaims;
    try { claims = await verifyJwt(token, { hsSecret: this.env.JWT_SECRET, issuer: this.env.JWT_ISSUER }); } catch { throw new UnauthorizedException('Start the sign-in again'); }
    if (claims.typ !== 'mfa' || (purpose !== 'any' && claims.purpose !== purpose)) throw new UnauthorizedException('Start the sign-in again');
    const user = await this.users.byId(String(claims.sub));
    if (!user || !user.active) throw new UnauthorizedException('Session no longer valid');
    return user;
  }

  /** Second step, verify: the code from the app or a recovery code completes the sign-in. */
  async completeWithCode(mfaToken: string, code: string, ctx: ClientContext = {}): Promise<Session & { usedRecoveryCode: boolean }> {
    const user = await this.userFromMfaToken(mfaToken, 'verify');
    const how = await this.mfa.verify(user, code);
    const session = await this.issueSession(user, ctx, await this.policy.get());
    return { ...session, usedRecoveryCode: how === 'recovery' };
  }
  /** Second step, enrol: activating the factor during sign-in also completes the sign-in. */
  async completeWithEnrolment(mfaToken: string, code: string, ctx: ClientContext = {}): Promise<Session & { recoveryCodes: string[] }> {
    const user = await this.userFromMfaToken(mfaToken, 'enrol');
    const { recoveryCodes } = await this.mfa.activate(user, code);
    const fresh = (await this.users.byId(user.id))!;
    const session = await this.issueSession(fresh, ctx, await this.policy.get());
    return { ...session, recoveryCodes };
  }

  private async loginKeycloak(email: string, password: string): Promise<Session> {
    const base = this.env.KEYCLOAK_BASE_URL; if (!base) throw new Error('KEYCLOAK_BASE_URL not configured');
    const body = new URLSearchParams({ grant_type: 'password', client_id: this.env.KEYCLOAK_CLIENT_ID, username: email, password, scope: 'openid' });
    if (this.env.KEYCLOAK_CLIENT_SECRET) body.set('client_secret', this.env.KEYCLOAK_CLIENT_SECRET);
    const res = await fetch(`${base}/realms/${this.env.KEYCLOAK_REALM}/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!res.ok) { await this.throttleFail(email); throw new UnauthorizedException('Invalid email or password'); }
    const tok = (await res.json()) as { access_token: string; refresh_token: string };
    const user = await this.users.byEmail(email);
    if (!user || !user.active) throw new ForbiddenException('No active platform account for this identity');
    await this.throttleClear(email);
    await this.pool.query('UPDATE users SET last_login_at = now(), dormant_since = NULL WHERE id = $1', [user.id]);
    const policy = await this.policy.get();
    return { user: toSafe(user), token: tok.access_token, refreshToken: tok.refresh_token, sessionId: '', policy: PolicyService.forClient(policy), mfa: { required: false, enrolled: false, dueAt: null } };
  }

  /* ------------------------------------------------------------------------------------------ sessions --- */
  /** A session is a family of refresh tokens: rotation stays in the family, revocation ends the family. */
  private async issueSession(user: UserRow, ctx: ClientContext, policy: AdminPolicy, family?: string, note: 'LOGIN' | 'REFRESH' = 'LOGIN'): Promise<Session> {
    const sessionId = family ?? randomUUID();
    const token = signHS256({ sub: user.id, name: user.name, email: user.email, typ: 'access', sid: sessionId }, this.env.JWT_SECRET, { expiresInSec: policy.accessTokenMinutes * 60, issuer: this.env.JWT_ISSUER });
    const refresh = signHS256({ sub: user.id, typ: 'refresh', jti: randomBytes(12).toString('hex'), sid: sessionId }, this.env.JWT_SECRET, { expiresInSec: policy.refreshTokenHours * 3600, issuer: this.env.JWT_ISSUER });
    await withTx(this.pool, async (c) => {
      await c.query('INSERT INTO refresh_tokens(user_id, token_hash, expires_at, family, user_agent, ip, last_used_at) VALUES ($1, $2, now() + ($3::int * interval \'1 second\'), $4, $5, $6, now())',
        [user.id, sha256(refresh), policy.refreshTokenHours * 3600, sessionId, (ctx.userAgent ?? '').slice(0, 300), (ctx.ip ?? '').slice(0, 80)]);
      if (note === 'LOGIN') {
        await c.query('UPDATE users SET last_login_at = now(), dormant_since = NULL WHERE id = $1', [user.id]);
        await this.audit.record(c, { action: 'LOGIN', entity: 'User', entityId: user.id, entityLabel: user.email, note: ctx.ip ?? undefined, actor: { id: user.id, name: user.name, email: user.email, kind: 'user' } });
      }
    });
    const from = PolicyService.mfaEnforcedFrom(policy);
    const dueAt = user.mfa_enrolled_at || !user.role_mfa_required ? null : (user.mfa_due_at ? new Date(user.mfa_due_at).toISOString() : (from ? new Date(Math.max(from.getTime(), Date.now()) + policy.mfaGraceDays * 86_400_000).toISOString() : null));
    return { user: toSafe(user), token, refreshToken: refresh, sessionId, policy: PolicyService.forClient(policy), mfa: { required: !!user.role_mfa_required, enrolled: !!user.mfa_enrolled_at, dueAt } };
  }

  async refresh(refreshToken: string, ctx: ClientContext = {}): Promise<Session> {
    if (this.env.AUTH_MODE === 'keycloak') return this.refreshKeycloak(refreshToken);
    let claims: JwtClaims;
    try { claims = await verifyJwt(refreshToken, { hsSecret: this.env.JWT_SECRET, issuer: this.env.JWT_ISSUER }); } catch { throw new UnauthorizedException('Invalid refresh token'); }
    if (claims.typ !== 'refresh') throw new UnauthorizedException('Not a refresh token');
    const row = await this.pool.query<{ id: string; revoked_at: Date | null; expires_at: Date; family: string; last_used_at: Date }>('SELECT id, revoked_at, expires_at, family, last_used_at FROM refresh_tokens WHERE token_hash = $1', [sha256(refreshToken)]);
    const rt = row.rows[0];
    if (!rt || rt.revoked_at || rt.expires_at.getTime() < Date.now()) throw new UnauthorizedException('Refresh token revoked or expired');
    const user = await this.users.byId(String(claims.sub));
    if (!user || !user.active) throw new UnauthorizedException('Session no longer valid');
    const policy = await this.policy.get();
    if (Date.now() - new Date(rt.last_used_at).getTime() > policy.idleTimeoutMinutes * 60_000) {
      // the person has been away longer than the idle window: the whole session ends, and they sign in again
      await this.pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family = $1 AND revoked_at IS NULL', [rt.family]);
      throw new UnauthorizedException('Signed out after inactivity');
    }
    await this.pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [rt.id]); // rotation
    return this.issueSession(user, ctx, policy, rt.family, 'REFRESH');
  }
  private async refreshKeycloak(refreshToken: string): Promise<Session> {
    const base = this.env.KEYCLOAK_BASE_URL!;
    const body = new URLSearchParams({ grant_type: 'refresh_token', client_id: this.env.KEYCLOAK_CLIENT_ID, refresh_token: refreshToken });
    if (this.env.KEYCLOAK_CLIENT_SECRET) body.set('client_secret', this.env.KEYCLOAK_CLIENT_SECRET);
    const res = await fetch(`${base}/realms/${this.env.KEYCLOAK_REALM}/protocol/openid-connect/token`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body });
    if (!res.ok) throw new UnauthorizedException('Refresh failed');
    const tok = (await res.json()) as { access_token: string; refresh_token: string };
    const claims = JSON.parse(Buffer.from(tok.access_token.split('.')[1], 'base64url').toString('utf8')) as { email?: string; preferred_username?: string };
    const user = await this.users.byEmail(String(claims.email ?? claims.preferred_username));
    if (!user || !user.active) throw new UnauthorizedException('Session no longer valid');
    const policy = await this.policy.get();
    return { user: toSafe(user), token: tok.access_token, refreshToken: tok.refresh_token, sessionId: '', policy: PolicyService.forClient(policy), mfa: { required: false, enrolled: false, dueAt: null } };
  }

  async logout(userId: string, refreshToken?: string) {
    if (refreshToken) {
      // signing out ends the whole family the token belongs to, not just the one token in hand
      await this.pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE family = (SELECT family FROM refresh_tokens WHERE token_hash = $1 AND user_id = $2) AND revoked_at IS NULL', [sha256(refreshToken), userId]);
    } else await this.users.revokeSessions(userId);
    return { revoked: true };
  }

  /** The live sessions an account holds: one row per family, described by its latest token. */
  async sessions(userId: string) {
    const r = await this.pool.query<{ family: string; started_at: Date; last_used_at: Date; expires_at: Date; user_agent: string; ip: string }>(
      `SELECT family, min(created_at) AS started_at, max(last_used_at) AS last_used_at, max(expires_at) AS expires_at,
              (array_agg(user_agent ORDER BY created_at DESC))[1] AS user_agent, (array_agg(ip ORDER BY created_at DESC))[1] AS ip
       FROM refresh_tokens WHERE user_id = $1 AND family IS NOT NULL
       GROUP BY family
       HAVING bool_or(revoked_at IS NULL AND expires_at > now())
       ORDER BY max(last_used_at) DESC`, [userId]);
    return r.rows.map((s) => ({ id: s.family, startedAt: s.started_at, lastUsedAt: s.last_used_at, expiresAt: s.expires_at, userAgent: s.user_agent, ip: s.ip, device: describeAgent(s.user_agent) }));
  }
  /** Ends one session (a family) or, with no id, every session the account holds except the one kept. */
  async revokeSession(userId: string, opts: { family?: string; keep?: string; by: { id: string; name: string; email?: string } }) {
    const n = await withTx(this.pool, async (c) => {
      const r = opts.family
        ? await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND family = $2 AND revoked_at IS NULL', [userId, opts.family])
        : await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND ($2::uuid IS NULL OR family <> $2)', [userId, opts.keep ?? null]);
      const u = await this.users.byId(userId, c);
      await this.audit.record(c, { action: 'SESSION_REVOKED', entity: 'User', entityId: userId, entityLabel: u?.email ?? userId, after: { family: opts.family ?? 'all', tokens: r.rowCount ?? 0 }, actor: { ...opts.by, kind: 'user' } });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.identity.sessionRevoked, { userId, family: opts.family ?? null, byId: opts.by.id }));
      return r.rowCount ?? 0;
    });
    return { revoked: n };
  }

  /* ----------------------------------------------------------------------------------------- password --- */
  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (this.env.AUTH_MODE === 'keycloak') throw badRequest('Passwords are managed by the identity provider');
    const user = await this.users.byId(userId);
    if (!user || !user.password_hash || !(await bcrypt.compare(currentPassword, user.password_hash))) throw new UnauthorizedException('Current password is incorrect');
    // Checked after the current password so an unauthenticated caller learns nothing about the policy
    // or about which accounts exist by probing this endpoint.
    const policy = await this.policy.get();
    const problems = passwordProblems(newPassword, { email: user.email, name: user.name }, { minLength: policy.passwordMinLength });
    if (sameSecret(newPassword, currentPassword)) problems.push('New password must differ from the current one');
    if (problems.length) throw badRequest(problems.join('; '));
    const hash = await bcrypt.hash(newPassword, this.env.BCRYPT_ROUNDS);
    await withTx(this.pool, async (c) => {
      await c.query('UPDATE users SET password_hash = $1, updated_at = now() WHERE id = $2', [hash, userId]);
      await c.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
      await this.audit.record(c, { action: 'PASSWORD_CHANGE', entity: 'User', entityId: userId, entityLabel: user.email });
    });
    return { changed: true };
  }
}

/** A short human name for the browser a session came from, from its user agent. */
export function describeAgent(ua: string): string {
  if (!ua) return 'Unknown device';
  const os = /Windows/i.test(ua) ? 'Windows' : /Mac OS X/i.test(ua) ? 'macOS' : /iPhone|iPad/i.test(ua) ? 'iOS' : /Android/i.test(ua) ? 'Android' : /Linux/i.test(ua) ? 'Linux' : '';
  const browser = /Edg\//i.test(ua) ? 'Edge' : /OPR\//i.test(ua) ? 'Opera' : /Chrome\//i.test(ua) ? 'Chrome' : /Safari\//i.test(ua) && !/Chrome/i.test(ua) ? 'Safari' : /Firefox\//i.test(ua) ? 'Firefox' : /node|axios|curl|supertest|playwright/i.test(ua) ? 'API client' : 'Browser';
  return os ? `${browser} on ${os}` : browser;
}
