import { Inject, Injectable } from '@nestjs/common';
import { EVENTS } from '@maritime/contracts';
import { enqueue, eventFromContext } from './events/outbox';
import type { Queryable } from './db';
import { getContext } from './context';

export interface AuditActor { id: string; name: string; email?: string; kind: string }
export interface AuditEntry { action: string; entity: string; entityId?: string | number | null; entityLabel?: string | null; before?: unknown; after?: unknown; note?: string; /** Explicit actor for flows that run before a principal exists (login, password reset links). */ actor?: AuditActor }
const SECRET_KEYS = new Set(['passwordHash', 'password_hash', 'password', 'secret', 'apiKey', 'api_key', 'smtpPassword']);
export function stripSecrets<T>(v: T): T {
  if (Array.isArray(v)) return v.map(stripSecrets) as unknown as T;
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) if (!SECRET_KEYS.has(k)) out[k] = stripSecrets(val);
    return out as T;
  }
  return v;
}

/** Every mutating endpoint records actor, action, entity and before/after state; the ledger service stores it append-only. */
@Injectable()
export class AuditClient {
  constructor(@Inject('KIT_SERVICE_NAME') private readonly source: string) {}
  async record(client: Queryable, entry: AuditEntry): Promise<void> {
    const ctx = getContext();
    const event = eventFromContext(this.source, EVENTS.audit.recorded, {
      action: entry.action, entity: entry.entity, entityId: entry.entityId == null ? null : String(entry.entityId), entityLabel: entry.entityLabel ?? null,
      before: stripSecrets(entry.before ?? null), after: stripSecrets(entry.after ?? null), note: entry.note ?? null,
      actor: entry.actor ?? ctx?.actor ?? { id: 'system', name: 'system', kind: 'system' }, ip: ctx?.ip ?? null, at: new Date().toISOString(), service: this.source,
    }, { subject: `${entry.entity}:${entry.entityId ?? ''}` });
    await enqueue(client, event);
  }
}
