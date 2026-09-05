import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { KIT_POOL } from '@maritime/service-kit';

/** Whether a session family still has a living refresh token: sign-out, revocation and the idle window all end it. */
@Injectable()
export class SessionsRepo {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool) {}
  async alive(userId: string, family: string): Promise<boolean> {
    if (!/^[0-9a-f-]{36}$/i.test(family)) return false;
    const r = await this.pool.query('SELECT 1 FROM refresh_tokens WHERE user_id = $1 AND family = $2 AND revoked_at IS NULL AND expires_at > now() LIMIT 1', [userId, family]);
    return (r.rowCount ?? 0) > 0;
  }
}
