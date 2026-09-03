import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, KIT_BUS, KIT_ENV, KIT_POOL, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';
import type { Env } from './env';
import { projectSnapshot } from './subjects';

/* What the assistant learns from the rest of the platform.
 *
 * Only read models: the ships, calls, invoices, surveys, incidents and instruments the tool surface reads on a
 * user's behalf, and the legislation register the retrieval corpus is built from. Consumption is idempotent
 * through the inbox, and a published notice is folded into the corpus as it arrives so an answer can cite it
 * the same day. */

export interface Deps { env: Env; audit: AuditClient }

export async function applyEvent(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<void> {
  if (event.source === deps.env.SERVICE_NAME) return;
  await projectSnapshot(c, event);
}

export const SUBJECTS = [subjectFor(EVENTS.readModel.upserted), subjectFor(EVENTS.readModel.deleted)];

@Injectable()
export class AssistantConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(
    @Inject(KIT_BUS) private readonly bus: EventBus,
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    private readonly audit: AuditClient,
  ) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('ai-assistant-consumer', SUBJECTS, (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) { await withInbox(this.pool, event, (c) => applyEvent(c, { env: this.env, audit: this.audit }, event)); }
}
