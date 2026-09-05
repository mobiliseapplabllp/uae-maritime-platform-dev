import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, KIT_BUS, KIT_ENV, KIT_POOL, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';
import type { Env } from './env';
import { projectSnapshot, upsertInspection } from './subjects';
import { prepareDraft, publishDraft, type DraftKind, type DraftRecord } from './drafts';

/* What the assistant learns from the rest of the platform.
 *
 * Read models: the ships, calls, invoices, surveys, incidents and instruments the tool surface reads on a user's
 * behalf, and the legislation register the retrieval corpus is built from. Consumption is idempotent through the
 * inbox, and a published notice is folded into the corpus as it arrives so an answer can cite it the same day.
 *
 * And one thing the assistant does unasked: when a survey closes, it drafts the report — and, where deficiencies
 * were raised, the notice — from the record within minutes, and publishes each as prepared. The survey desk
 * records the drafts against the survey as the machine's first draft; an officer reads, edits and issues. Nothing
 * is issued from here. */

export interface Deps { env: Env; audit: AuditClient }

/** The assistant's own hand, on drafts it prepares without being asked. */
const ASSISTANT = { id: 'ai-assistant', name: 'Assistant', kind: 'system' as const };

async function draftOnClose(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<number> {
  const d = (event.data ?? {}) as Record<string, any>;
  const entity = d.inspection ?? null;
  if (entity?.id) await upsertInspection(c, entity); // the closed event carries the survey as closed, ahead of its read-model twin
  const id = String(d.inspectionId ?? entity?.id ?? '');
  if (!id) return 0;
  const kinds: DraftKind[] = ['INSPECTION_SUMMARY', ...(Number(d.totalFindings ?? entity?.totalFindings ?? 0) > 0 ? ['DEFICIENCY_NOTICE' as const] : [])];
  let made = 0;
  for (const kind of kinds) {
    const already = await c.query('SELECT 1 FROM drafts WHERE kind = $1 AND subject_type = $2 AND subject_id = $3', [kind, 'Inspection', id]);
    if (already.rowCount) continue;
    const prepared = await prepareDraft(c, { kind, subjectId: id }, ASSISTANT.name);
    if (!prepared) continue;
    const r = await c.query<DraftRecord>(
      `INSERT INTO drafts(kind, subject_type, subject_id, subject_label, title, body, citations, facts, language, status, engine, prepared_by_id, prepared_by)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'en','DRAFT',$9,$10,$11) RETURNING *`,
      [kind, prepared.subjectType, id, prepared.subjectLabel, prepared.title, prepared.body, JSON.stringify(prepared.citations), JSON.stringify(prepared.facts), deps.env.COMPLETION_PROFILE, ASSISTANT.id, ASSISTANT.name]);
    const draft = await publishDraft(c, deps.env, r.rows[0], { actor: ASSISTANT });
    await deps.audit.record(c, { action: 'AI_DRAFT_PREPARED', entity: 'AiDraft', entityId: r.rows[0].id, entityLabel: draft.title, after: { kind, subject: draft.subjectLabel, trigger: event.type }, note: 'Drafted on the survey closing; not issued', actor: ASSISTANT });
    made += 1;
  }
  return made;
}

export async function applyEvent(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<void> {
  if (event.source === deps.env.SERVICE_NAME) return;
  if (event.type === EVENTS.inspection.closed) { await draftOnClose(c, deps, event); return; }
  await projectSnapshot(c, event);
}

export const SUBJECTS = [subjectFor(EVENTS.readModel.upserted), subjectFor(EVENTS.readModel.deleted), subjectFor(EVENTS.inspection.closed)];

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
