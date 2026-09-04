import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { z } from 'zod';
import type { Request } from 'express';
import { PASSWORD_MAX } from '@maritime/contracts';
import { Public, CurrentUser, zod, type Principal } from '@maritime/service-kit';
import { AuthService } from './auth.service';
import { UsersRepo, toSafe } from '../users/users.repo';

const loginSchema = z.object({ email: z.string().email().max(200), password: z.string().min(1).max(200) });
const refreshSchema = z.object({ refreshToken: z.string().min(10) });
const changeSchema = z.object({ currentPassword: z.string().min(1), newPassword: z.string().max(PASSWORD_MAX) });
const logoutSchema = z.object({ refreshToken: z.string().optional() });

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService, private readonly users: UsersRepo) {}
  @Public() @Post('login')
  login(@Body(zod(loginSchema)) body: z.infer<typeof loginSchema>, @Req() req: Request) { return this.auth.login(body.email, body.password, req.ip); }
  @Public() @Post('refresh')
  refresh(@Body(zod(refreshSchema)) body: z.infer<typeof refreshSchema>) { return this.auth.refresh(body.refreshToken); }
  @Get('me')
  async me(@CurrentUser() user: Principal) { const row = await this.users.byId(user.id); return row ? toSafe(row) : null; }
  @Post('change-password')
  change(@CurrentUser() user: Principal, @Body(zod(changeSchema)) body: z.infer<typeof changeSchema>) { return this.auth.changePassword(user.id, body.currentPassword, body.newPassword); }
  @Post('logout')
  logout(@CurrentUser() user: Principal, @Body(zod(logoutSchema)) body: z.infer<typeof logoutSchema>) { return this.auth.logout(user.id, body.refreshToken); }
}
