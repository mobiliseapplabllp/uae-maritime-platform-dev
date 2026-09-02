import { Injectable } from '@nestjs/common';
import type { JwtClaims, Principal, PrincipalResolver } from '@maritime/service-kit';
import { UsersRepo, toPrincipal } from '../users/users.repo';

/** The identity service resolves principals from its own tables: permissions are read on every request, so matrix edits apply immediately. */
@Injectable()
export class LocalPrincipalResolver implements PrincipalResolver {
  constructor(private readonly users: UsersRepo) {}
  async resolve(claims: JwtClaims): Promise<Principal | null> {
    const sub = String(claims.sub ?? '');
    let row = sub ? await this.users.bySubject(sub) : null;
    if (!row && typeof claims.email === 'string') row = await this.users.byEmail(claims.email);
    if (!row && typeof claims.preferred_username === 'string') row = await this.users.byEmail(claims.preferred_username);
    return row ? toPrincipal(row) : null;
  }
}
