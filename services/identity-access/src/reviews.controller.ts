import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { KIT_ENV, KIT_POOL, AuditClient, CurrentUser, RequirePerm, zod, withTx, type Principal } from '@maritime/service-kit';
import { closeCycle, cycleApi, cycleById, decideItem, itemApi, listCycles, listItems, openCycle, sweepDormant } from './reviews';
import { UsersRepo } from './users/users.repo';
import { PolicyService } from './policy';
import type { Env } from './env';

const decideSchema = z.object({ decision: z.enum(['CONFIRMED', 'REVOKED']), note: z.string().max(500).optional().default('') });
const noteSchema = z.object({ note: z.string().max(500).optional().default('') });

@Controller('access-reviews')
export class ReviewsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient, private readonly users: UsersRepo, private readonly policy: PolicyService) {}
  private get deps() { return { env: this.env, audit: this.audit, users: this.users }; }
  private actor(me: Principal) { return { id: me.id, name: me.name, email: me.email }; }

  @RequirePerm('users.view') @Get()
  async list() { return (await listCycles(this.pool)).map(cycleApi); }
  @RequirePerm('users.manage') @Post()
  async open(@CurrentUser() me: Principal) {
    const policy = await this.policy.get();
    return withTx(this.pool, async (c) => { const r = await openCycle(c, this.deps, policy, this.actor(me)); return { ...cycleApi(r.cycle), created: r.created }; });
  }
  /** Runs the dormancy sweep now, with the policy as it stands. */
  @RequirePerm('users.manage') @Post('dormant-sweep')
  async sweep() { const policy = await this.policy.get(); return withTx(this.pool, async (c) => ({ ...(await sweepDormant(c, this.deps, policy)), action: policy.dormantAction, dormantAfterDays: policy.dormantAfterDays })); }
  @RequirePerm('users.view') @Get(':id')
  async get(@Param('id') id: string, @Query() q: { decision?: string; q?: string; dormant?: string; privileged?: string }) {
    const cyc = await cycleById(this.pool, id);
    const items = await listItems(this.pool, cyc.id, { decision: q.decision, q: q.q, dormant: q.dormant === 'true', privileged: q.privileged === 'true' });
    return { ...cycleApi(cyc), items: items.map(itemApi) };
  }
  @RequirePerm('users.manage') @Post(':id/items/:itemId')
  decide(@Param('id') id: string, @Param('itemId') itemId: string, @Body(zod(decideSchema)) body: z.infer<typeof decideSchema>, @CurrentUser() me: Principal) {
    return withTx(this.pool, async (c) => itemApi(await decideItem(c, this.deps, id, itemId, body.decision, this.actor(me), body.note)));
  }
  @RequirePerm('users.manage') @Post(':id/close')
  close(@Param('id') id: string, @Body(zod(noteSchema)) body: z.infer<typeof noteSchema>, @CurrentUser() me: Principal) {
    return withTx(this.pool, async (c) => cycleApi(await closeCycle(c, this.deps, id, this.actor(me), body.note)));
  }
}
