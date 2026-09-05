import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { IntegrationClient, KIT_ENV, KIT_LOGGER, KIT_POOL, KIT_SETTINGS, SettingsClient, type AppLogger } from '@maritime/service-kit';
import type { Env } from './env';

/*
 * A notification addressed to one person can also reach their inbox and their phone. Whether it does is a platform
 * setting (Settings → Notifications), the sending goes through the messaging adapter like every other counterpart,
 * and each attempt is recorded whatever happened to it — a recipient without an address, a hub that was down and
 * a counterpart that refused are three different rows, not one silence.
 */
export interface DeliveryContact { email?: string | null; phone?: string | null }
export interface DeliveryRow { id: string; notification_id: string | null; channel: 'email' | 'sms'; recipient: string; status: 'sent' | 'failed' | 'skipped'; message_id: string; call_id: string | null; mode: string; error: string | null; created_at: Date }
interface Prefs { emailEnabled: boolean; smsEnabled: boolean }

export const deliveryApi = (d: DeliveryRow) => ({ id: d.id, notificationId: d.notification_id, channel: d.channel, recipient: d.recipient, status: d.status, messageId: d.message_id, callId: d.call_id, mode: d.mode, error: d.error, createdAt: d.created_at.toISOString() });

@Injectable()
export class DeliveryService {
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, @Inject(KIT_LOGGER) private readonly log: AppLogger,
    @Inject(KIT_SETTINGS) private readonly settings: SettingsClient, private readonly hub: IntegrationClient,
  ) {}

  /** What the platform's settings say about sending outside itself; a settings service that is down means "as seeded". */
  async prefs(): Promise<Prefs> {
    const v = await this.settings.get<Partial<Prefs>>('notifications', {});
    return { emailEnabled: v.emailEnabled ?? true, smsEnabled: v.smsEnabled ?? false };
  }

  /** The contact for an account, from the identity service on the service token; nobody when it does not know them. */
  async contactOf(userId: string): Promise<DeliveryContact | null> {
    try {
      const res = await fetch(`${this.env.IDENTITY_URL.replace(/\/+$/, '')}/internal/principals/${encodeURIComponent(userId)}`, { headers: { 'x-service-token': this.env.SERVICE_TOKEN }, signal: AbortSignal.timeout(3000) });
      if (!res.ok) return null;
      const body = await res.json() as { data?: { email?: string; phone?: string } };
      return body.data ? { email: body.data.email ?? null, phone: body.data.phone ?? null } : null;
    } catch (e) { this.log.warn({ err: (e as Error).message, userId }, 'contact lookup failed'); return null; }
  }

  /** Sends what the settings allow to the addresses the person has, and records every attempt. */
  async deliver(n: { id: string; title: string; body: string; link?: string | null; severity: string }, contact: DeliveryContact | null): Promise<DeliveryRow[]> {
    const prefs = await this.prefs();
    const out: DeliveryRow[] = [];
    const record = async (channel: 'email' | 'sms', recipient: string, status: DeliveryRow['status'], extra: { messageId?: string; callId?: string; mode?: string; error?: string } = {}) => {
      const r = await this.pool.query<DeliveryRow>(
        'INSERT INTO deliveries(notification_id, channel, recipient, status, message_id, call_id, mode, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [n.id, channel, recipient, status, extra.messageId ?? '', extra.callId ?? null, extra.mode ?? '', extra.error ?? null]);
      out.push(r.rows[0]);
    };
    const send = async (channel: 'email' | 'sms', recipient: string, operation: 'sendEmail' | 'sendSms', payload: Record<string, unknown>) => {
      const res = await this.hub.tryCall<{ messageId?: string }>('messaging', operation, payload, { idempotencyKey: `notification:${n.id}:${channel}`, correlationId: `notification:${n.id}` });
      if (res.status === 'unavailable') { await record(channel, recipient, 'skipped', { error: res.error }); return; }
      if (res.status !== 'ok') { await record(channel, recipient, 'failed', { callId: res.callId, mode: res.mode, error: res.error ?? `call ${res.status}` }); return; }
      await record(channel, recipient, 'sent', { messageId: String(res.data?.messageId ?? ''), callId: res.callId, mode: res.mode });
    };
    if (prefs.emailEnabled) {
      if (contact?.email) await send('email', contact.email, 'sendEmail', { to: contact.email, subject: n.title, body: n.body || n.title, link: n.link ?? undefined, severity: n.severity });
      else await record('email', '', 'skipped', { error: 'no email address on the account' });
    }
    if (prefs.smsEnabled) {
      if (contact?.phone) await send('sms', contact.phone, 'sendSms', { to: contact.phone, body: `${n.title}${n.body ? ` — ${n.body}` : ''}`.slice(0, 480) });
      else await record('sms', '', 'skipped', { error: 'no phone number on the account' });
    }
    return out;
  }
}
