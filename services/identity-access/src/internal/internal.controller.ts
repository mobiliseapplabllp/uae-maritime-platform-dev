import { BadRequestException, Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import { ServiceOnly } from '@maritime/service-kit';
import { UsersRepo, toPrincipal } from '../users/users.repo';
import { SessionsRepo } from '../auth/sessions.repo';

/** Service-to-service principal resolution used by every other service's auth guard. */
@Controller('internal')
export class InternalController {
  constructor(private readonly users: UsersRepo, private readonly sessions: SessionsRepo) {}
  /** The active accounts holding a permission — who an audience notice reaches when the notifications service escalates it. */
  @ServiceOnly() @Get('principals')
  async holders(@Query('perm') perm?: string, @Query('limit') limit?: string) {
    const p = String(perm ?? '').trim();
    if (!p) throw new BadRequestException('perm is required');
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    const items = await this.users.holdersOf(p, n);
    return { perm: p, items, total: items.length };
  }
  /** With a session id the answer is for that session: an ended session resolves to nobody, whatever the token says. */
  @ServiceOnly() @Get('principals/:sub')
  async principal(@Param('sub') sub: string, @Query('sid') sid?: string) {
    let row = await this.users.bySubject(sub);
    if (!row && sub.includes('@')) row = await this.users.byEmail(sub);
    if (!row) throw new NotFoundException('Unknown principal');
    if (sid && !(await this.sessions.alive(row.id, sid))) throw new NotFoundException('Session ended');
    return toPrincipal(row);
  }
}
