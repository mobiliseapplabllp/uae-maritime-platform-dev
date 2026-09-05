import { Injectable } from '@nestjs/common';
import type { JwtClaims, Principal, PrincipalResolver } from '@maritime/service-kit';
import { UsersRepo, toPrincipal } from '../users/users.repo';
import { SessionsRepo } from './sessions.repo';

/**
 * The identity service resolves principals from its own tables: permissions are read on every request, so matrix edits
 * apply immediately, and a token that names its session is refused once that session has ended.
 */
@Injectable()
export class LocalPrincipalResolver implements PrincipalResolver {
  constructor(private readonly users: UsersRepo, private readonly sessions: SessionsRepo) {}
  async resolve(claims: JwtClaims): Promise<Principal | null> {
    const sub = String(claims.sub ?? '');
    let row = sub ? await this.users.bySubject(sub) : null;
    if (!row && typeof claims.email === 'string') row = await this.users.byEmail(claims.email);
    if (!row && typeof claims.preferred_username === 'string') row = await this.users.byEmail(claims.preferred_username);
    if (!row) return null;
    if (claims.sid && !(await this.sessions.alive(row.id, String(claims.sid)))) return null;
    return toPrincipal(row);
  }
}
