import { Inject, Injectable, UnauthorizedException, ForbiddenException, HttpException } from '@nestjs/common';
import bcrypt from 'bcryptjs';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Pool } from 'pg';
import { passwordProblems } from '@maritime/contracts';
import { KIT_ENV, KIT_POOL, KIT_LOGGER, AuditClient, signHS256, verifyJwt, withTx, badRequest, type AppLogger } from '@maritime/service-kit';
import { UsersRepo, toSafe, type UserRow } from '../users/users.repo';
import type { Env } from '../env';

/** Pre-computed hash so an unknown account costs the same time as a wrong password. */
const DUMMY_HASH = bcrypt.hashSync('timing-equalised-dummy-password', 10);
const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
/** Equal-length digest comparison, so no secret is compared byte-by-byte with an early exit. */
const sameSecret = (a: string, b: string) => timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'));
export interface Session { user: ReturnType<typeof toSafe>; token: string; refreshToken: string }

@Injectable()
export class AuthService {
  constructor(
    @Inject(KIT_ENV) private readonly env: Env,
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_LOGGER) private readonly log: AppLogger,
    private readonly users: UsersRepo,
    private readonly audit: AuditClient,
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

  async login(email: string, password: string, ip?: string): Promise<Session> {
    const identity = email.toLowerCase();
    await this.throttleCheck(identity);
    if (this.env.AUTH_MODE === 'keycloak') return this.loginKeycloak(identity, password);
    const user = await this.users.byEmail(identity);
    const ok = await bcrypt.compare(password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok) { await this.throttleFail(identity); throw new UnauthorizedException('Invalid email or password'); }
    if (!user.active) { await this.throttleFail(identity); throw new ForbiddenException('Account is inactive'); }
    await this.throttleClear(identity);
    return this.issueSession(user, ip);
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
    await this.pool.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
    return { user: toSafe(user), token: tok.access_token, refreshToken: tok.refresh_token };
  }

  private async issueSession(user: UserRow, ip?: string): Promise<Session> {
    const token = signHS256({ sub: user.id, name: user.name, email: user.email, typ: 'access' }, this.env.JWT_SECRET, { expiresInSec: await this.sessionSeconds(), issuer: this.env.JWT_ISSUER });
    const refresh = signHS256({ sub: user.id, typ: 'refresh', jti: randomBytes(12).toString('hex') }, this.env.JWT_SECRET, { expiresInSec: this.env.JWT_REFRESH_EXPIRES_IN_SEC, issuer: this.env.JWT_ISSUER });
    await withTx(this.pool, async (c) => {
      await c.query('INSERT INTO refresh_tokens(user_id, token_hash, expires_at) VALUES ($1, $2, now() + ($3::int * interval \'1 second\'))', [user.id, sha256(refresh), this.env.JWT_REFRESH_EXPIRES_IN_SEC]);
      await c.query('UPDATE users SET last_login_at = now() WHERE id = $1', [user.id]);
      await this.audit.record(c, { action: 'LOGIN', entity: 'User', entityId: user.id, entityLabel: user.email, note: ip ?? undefined, actor: { id: user.id, name: user.name, email: user.email, kind: 'user' } });
    });
    return { user: toSafe(user), token, refreshToken: refresh };
  }
  private async sessionSeconds(): Promise<number> { return this.env.JWT_EXPIRES_IN_SEC; }

  async refresh(refreshToken: string): Promise<Session> {
    if (this.env.AUTH_MODE === 'keycloak') return this.refreshKeycloak(refreshToken);
    let claims;
    try { claims = await verifyJwt(refreshToken, { hsSecret: this.env.JWT_SECRET, issuer: this.env.JWT_ISSUER }); } catch { throw new UnauthorizedException('Invalid refresh token'); }
    if (claims.typ !== 'refresh') throw new UnauthorizedException('Not a refresh token');
    const row = await this.pool.query<{ id: string; revoked_at: Date | null; expires_at: Date }>('SELECT id, revoked_at, expires_at FROM refresh_tokens WHERE token_hash = $1', [sha256(refreshToken)]);
    const rt = row.rows[0];
    if (!rt || rt.revoked_at || rt.expires_at.getTime() < Date.now()) throw new UnauthorizedException('Refresh token revoked or expired');
    const user = await this.users.byId(String(claims.sub));
    if (!user || !user.active) throw new UnauthorizedException('Session no longer valid');
    await this.pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE id = $1', [rt.id]); // rotation
    return this.issueSession(user);
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
    return { user: toSafe(user), token: tok.access_token, refreshToken: tok.refresh_token };
  }

  async logout(userId: string, refreshToken?: string) {
    if (refreshToken) await this.pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE token_hash = $1 AND user_id = $2', [sha256(refreshToken), userId]);
    else await this.pool.query('UPDATE refresh_tokens SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
    return { revoked: true };
  }

  async changePassword(userId: string, currentPassword: string, newPassword: string) {
    if (this.env.AUTH_MODE === 'keycloak') throw badRequest('Passwords are managed by the identity provider');
    const user = await this.users.byId(userId);
    if (!user || !user.password_hash || !(await bcrypt.compare(currentPassword, user.password_hash))) throw new UnauthorizedException('Current password is incorrect');
    // Checked after the current password so an unauthenticated caller learns nothing about the policy
    // or about which accounts exist by probing this endpoint.
    const problems = passwordProblems(newPassword, { email: user.email, name: user.name });
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
