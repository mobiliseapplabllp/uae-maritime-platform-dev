import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import { ServiceOnly } from '@maritime/service-kit';
import { UsersRepo, toPrincipal } from '../users/users.repo';

/** Service-to-service principal resolution used by every other service's auth guard. */
@Controller('internal')
export class InternalController {
  constructor(private readonly users: UsersRepo) {}
  @ServiceOnly() @Get('principals/:sub')
  async principal(@Param('sub') sub: string) {
    let row = await this.users.bySubject(sub);
    if (!row && sub.includes('@')) row = await this.users.byEmail(sub);
    if (!row) throw new NotFoundException('Unknown principal');
    return toPrincipal(row);
  }
}
