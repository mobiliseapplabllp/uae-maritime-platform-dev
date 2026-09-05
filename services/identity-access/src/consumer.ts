import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, KIT_BUS, KIT_ENV, KIT_POOL, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';
import { openCycle, sweepDormant } from './reviews';
import { UsersRepo } from './users/users.repo';
import { PolicyService } from './policy';
import type { Env } from './env';

export const SUBJECTS = [subjectFor(EVENTS.scheduler.openAccessReview), subjectFor(EVENTS.scheduler.sweepDormant)];

/** The scheduler's two standing jobs for accounts: open the quarterly review, and sweep for dormancy every day. */
export async function applyEvent(c: PoolClient, deps: { env: Env; audit: AuditClient; users: UsersRepo; policy: PolicyService }, event: EventEnvelope): Promise<void> {
  const policy = await deps.policy.get();
  if (event.type === EVENTS.scheduler.openAccessReview) { await openCycle(c, deps, policy, { id: 'scheduler', name: 'Access review schedule' }); return; }
  if (event.type === EVENTS.scheduler.sweepDormant) { await sweepDormant(c, deps, policy); return; }
}

@Injectable()
export class IdentityConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient, private readonly users: UsersRepo, private readonly policy: PolicyService) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('identity-consumer', SUBJECTS, (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  private async handle(event: EventEnvelope) { await withInbox(this.pool, event, (c) => applyEvent(c, { env: this.env, audit: this.audit, users: this.users, policy: this.policy }, event)); }
}
