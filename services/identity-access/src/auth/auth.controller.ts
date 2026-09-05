import { Body, Controller, Delete, Get, Inject, Param, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import type { Request } from 'express';
import { PASSWORD_MAX } from '@maritime/contracts';
import { Public, CurrentUser, zod, TOKEN_VERIFIER, PRINCIPAL_RESOLVER, badRequest, type Principal, type TokenVerifier, type PrincipalResolver } from '@maritime/service-kit';
import { AuthService } from './auth.service';
import { MfaService } from '../mfa/mfa.service';
import { PolicyService } from '../policy';
import { UsersRepo, toSafe, type UserRow } from '../users/users.repo';

const loginSchema = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });
const refreshSchema = z.object({ refreshToken: z.string().min(10) });
const changeSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().max(PASSWORD_MAX) });
const logoutSchema = z.object({ refreshToken: z.string().optional() });
const mfaVerifySchema = z.object({ mfaToken: z.string().min(10), code: z.string().min(4).max(20) });
const mfaSetupSchema = z.object({ mfaToken: z.string().min(10).optional() });
const mfaActivateSchema = z.object({ mfaToken: z.string().min(10).optional(), code: z.string().min(6).max(8) });
const passwordOnly = z.object({ password: z.string().min(1).max(PASSWORD_MAX) });
const ctxOf = (req: Request) => ({ ip: req.ip, userAgent: req.header('user-agent') ?? '' });

@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService, private readonly users: UsersRepo, private readonly mfa: MfaService, private readonly policy: PolicyService,
    @Inject(TOKEN_VERIFIER) private readonly verifier: TokenVerifier, @Inject(PRINCIPAL_RESOLVER) private readonly resolver: PrincipalResolver,
  ) {}
  @Public() @Post('login')
  login(@Body(zod(loginSchema)) body: z.infer<typeof loginSchema>, @Req() req: Request) { return this.auth.login(body.email, body.password, ctxOf(req)); }
  @Public() @Post('refresh')
  refresh(@Body(zod(refreshSchema)) body: z.infer<typeof refreshSchema>, @Req() req: Request) { return this.auth.refresh(body.refreshToken, ctxOf(req)); }
  @Get('me')
  async me(@CurrentUser() user: Principal) { const row = await this.users.byId(user.id); return row ? toSafe(row) : null; }
  @Post('change-password')
  change(@CurrentUser() user: Principal, @Body(zod(changeSchema)) body: z.infer<typeof changeSchema>) { return this.auth.changePassword(user.id, body.currentPassword, body.newPassword); }
  @Post('logout')
  logout(@CurrentUser() user: Principal, @Body(zod(logoutSchema)) body: z.infer<typeof logoutSchema>) { return this.auth.logout(user.id, body.refreshToken); }

  /* ----------------------------------------------------------------------------------- second factor --- */
  /** The second step of sign-in: the authenticator's code, or a recovery code. */
  @Public() @Post('mfa/verify')
  verify(@Body(zod(mfaVerifySchema)) body: z.infer<typeof mfaVerifySchema>, @Req() req: Request) { return this.auth.completeWithCode(body.mfaToken, body.code, ctxOf(req)); }

  /**
   * Setup runs from a signed-in session (the security page) or from the sign-in screen with the enrolment token a
   * refused sign-in handed out, so an account past its deadline can still get in — by enrolling.
   */
  @Public() @Post('mfa/setup')
  async setup(@Body(zod(mfaSetupSchema)) body: z.infer<typeof mfaSetupSchema>, @Req() req: Request) {
    const user = await this.userFor(req, body.mfaToken);
    return this.mfa.setup(user);
  }
  @Public() @Post('mfa/activate')
  async activate(@Body(zod(mfaActivateSchema)) body: z.infer<typeof mfaActivateSchema>, @Req() req: Request) {
    if (body.mfaToken) return this.auth.completeWithEnrolment(body.mfaToken, body.code, ctxOf(req));
    const user = await this.userFor(req);
    return this.mfa.activate(user, body.code);
  }
  @Get('mfa')
  async status(@CurrentUser() me: Principal) {
    const user = (await this.users.byId(me.id))!;
    const policy = await this.policy.get();
    return { ...toSafe(user).mfa, enforcedFrom: policy.mfaRequiredFrom || null, graceDays: policy.mfaGraceDays };
  }
  @Post('mfa/recovery-codes')
  async recovery(@CurrentUser() me: Principal, @Body(zod(passwordOnly)) body: z.infer<typeof passwordOnly>) { return this.mfa.regenerateRecovery((await this.users.byId(me.id))!, body.password); }
  @Post('mfa/disable')
  async disable(@CurrentUser() me: Principal, @Body(zod(passwordOnly)) body: z.infer<typeof passwordOnly>) { await this.mfa.disable((await this.users.byId(me.id))!, body.password); return { disabled: true }; }

  /* ---------------------------------------------------------------------------------------- sessions --- */
  @Get('sessions')
  sessions(@CurrentUser() me: Principal) { return this.auth.sessions(me.id); }
  @Delete('sessions/:id')
  revokeOne(@CurrentUser() me: Principal, @Param('id') id: string) { return this.auth.revokeSession(me.id, { family: id, by: me }); }
  /** Ends every other session; `keep` names the one to stay signed in on. */
  @Delete('sessions')
  revokeAll(@CurrentUser() me: Principal, @Body(zod(z.object({ keep: z.string().uuid().optional() }))) body: { keep?: string }) { return this.auth.revokeSession(me.id, { keep: body.keep, by: me }); }

  /** A signed-in caller by their bearer token, or the account an MFA token names. */
  private async userFor(req: Request, mfaToken?: string): Promise<UserRow> {
    if (mfaToken) return this.auth.userFromMfaToken(mfaToken, 'any');
    const auth = req.header('authorization') || '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!token) throw badRequest('Sign in, or pass the token the sign-in screen gave you');
    const claims = await this.verifier.verify(token);
    if (claims.typ !== 'access') throw badRequest('Sign in, or pass the token the sign-in screen gave you');
    const principal = await this.resolver.resolve(claims, token);
    if (!principal || !principal.active) throw badRequest('Session no longer valid');
    const user = await this.users.byId(principal.id);
    if (!user) throw badRequest('Session no longer valid');
    return user;
  }
}
