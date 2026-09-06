import { Inject, Injectable } from '@nestjs/common';
import type { Pool } from 'pg';
import { EVENTS } from '@maritime/contracts';
import { IntegrationClient, KIT_ENV, KIT_LOGGER, KIT_POOL, KIT_SETTINGS, SettingsClient, enqueue, eventFromContext, smtpSend, type AppLogger, type SmtpConfig } from '@maritime/service-kit';
import type { Env } from './env';

/*
 * A notification addressed to one person can also reach their inbox and their phone. Whether it does is a platform
 * setting (Settings → Notifications), the sending goes through the messaging adapter like every other counterpart,
 * and each attempt is recorded whatever happened to it — a recipient without an address, a hub that was down and
 * a counterpart that refused are three different rows, not one silence.
 */
export interface DeliveryContact { email?: string | null; phone?: string | null }
export interface DeliveryRow { id: string; notification_id: string | null; channel: 'email' | 'sms'; recipient: string; status: 'sent' | 'failed' | 'skipped'; message_id: string; call_id: string | null; mode: string; error: string | null; created_at: Date }
interface Prefs { emailEnabled: boolean; smsEnabled: boolean; escalationHours: number }
interface NoticeRow { id: string; title: string; body: string; severity: string; link: string | null; audience_perm: string | null; user_id: string | null; created_at: Date }
export interface Holder { id: string; name: string; email: string; phone: string }

export const deliveryApi = (d: DeliveryRow) => ({ id: d.id, notificationId: d.notification_id, channel: d.channel, recipient: d.recipient, status: d.status, messageId: d.message_id, callId: d.call_id, mode: d.mode, error: d.error, createdAt: d.created_at.toISOString() });

/** How long the relay is left alone after it refused a connection: the adapter carries the mail meanwhile. */
const RELAY_BACKOFF_MS = 5 * 60_000;

@Injectable()
export class DeliveryService {
  /** When the relay last refused, and until when it is bypassed. */
  private relayDownUntil = 0;
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, @Inject(KIT_LOGGER) private readonly log: AppLogger,
    @Inject(KIT_SETTINGS) private readonly settings: SettingsClient, private readonly hub: IntegrationClient,
  ) {}

  /** What the platform's settings say about sending outside itself; a settings service that is down means "as seeded". */
  async prefs(): Promise<Prefs> {
    const v = await this.settings.get<Partial<Prefs>>('notifications', {});
    const hours = Number(v.escalationHours);
    return { emailEnabled: v.emailEnabled ?? true, smsEnabled: v.smsEnabled ?? false, escalationHours: Number.isFinite(hours) && hours >= 0 ? hours : 4 };
  }

  /** The platform's own relay, from Settings → SMTP; nothing when no host is set, in which case email goes through the messaging adapter. */
  async smtp(): Promise<(SmtpConfig & { from: string }) | null> {
    const v = await this.settings.get<Record<string, unknown>>('smtp', {});
    const host = String(v.host ?? '').trim();
    if (!host) return null;
    const org = await this.settings.get<Record<string, unknown>>('org', {});
    const secure = !(v.secure === false || String(v.secure).toLowerCase() === 'false');
    const port = Number(v.port) > 0 ? Number(v.port) : secure ? 465 : 587;
    const from = String(v.from ?? '').trim() || (org.contactEmail ? `${String(org.portName ?? 'Maritime Platform')} <${String(org.contactEmail)}>` : `notifications@${host.replace(/^smtp\./, '')}`);
    return { host, port, secure, user: String(v.user ?? '').trim() || undefined, password: String(v.password ?? '') || undefined, from, timeoutMs: 8000 };
  }

  /** The active accounts holding a permission, from the identity service; nobody when it cannot say. */
  async holdersOf(perm: string, limit = 25): Promise<Holder[]> {
    try {
      const res = await fetch(`${this.env.IDENTITY_URL.replace(/\/+$/, '')}/internal/principals?perm=${encodeURIComponent(perm)}&limit=${limit}`, { headers: { 'x-service-token': this.env.SERVICE_TOKEN }, signal: AbortSignal.timeout(3000) });
      if (!res.ok) return [];
      const body = await res.json() as { data?: { items?: Holder[] } };
      return Array.isArray(body.data?.items) ? body.data.items : [];
    } catch (e) { this.log.warn({ err: (e as Error).message, perm }, 'holder lookup failed'); return []; }
  }

  private emailText(n: { title: string; body: string; link?: string | null }) {
    const link = n.link ? (n.link.startsWith('http') ? n.link : `${this.env.PORTAL_URL.replace(/\/+$/, '')}${n.link}`) : '';
    return `${n.body || n.title}${link ? `\n\nOpen in the portal: ${link}` : ''}`;
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

  /** Sends what the settings allow to the addresses the person has, and records every attempt. A tag keeps one notice's
   *  sends to different people apart at the adapter, which would otherwise fold them into one idempotent call. */
  async deliver(n: { id: string; title: string; body: string; link?: string | null; severity: string }, contact: DeliveryContact | null, opts: { tag?: string } = {}): Promise<DeliveryRow[]> {
    const prefs = await this.prefs();
    const out: DeliveryRow[] = [];
    const tag = opts.tag ? `:${opts.tag}` : '';
    const record = async (channel: 'email' | 'sms', recipient: string, status: DeliveryRow['status'], extra: { messageId?: string; callId?: string; mode?: string; error?: string } = {}) => {
      const r = await this.pool.query<DeliveryRow>(
        'INSERT INTO deliveries(notification_id, channel, recipient, status, message_id, call_id, mode, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *',
        [n.id, channel, recipient, status, extra.messageId ?? '', extra.callId ?? null, extra.mode ?? '', extra.error ?? null]);
      out.push(r.rows[0]);
    };
    const send = async (channel: 'email' | 'sms', recipient: string, operation: 'sendEmail' | 'sendSms', payload: Record<string, unknown>) => {
      const res = await this.hub.tryCall<{ messageId?: string }>('messaging', operation, payload, { idempotencyKey: `notification:${n.id}:${channel}${tag}`, correlationId: `notification:${n.id}` });
      if (res.status === 'unavailable') { await record(channel, recipient, 'skipped', { error: res.error }); return; }
      if (res.status !== 'ok') { await record(channel, recipient, 'failed', { callId: res.callId, mode: res.mode, error: res.error ?? `call ${res.status}` }); return; }
      await record(channel, recipient, 'sent', { messageId: String(res.data?.messageId ?? ''), callId: res.callId, mode: res.mode });
    };
    if (prefs.emailEnabled) {
      if (!contact?.email) await record('email', '', 'skipped', { error: 'no email address on the account' });
      else {
        /* The platform's own relay first, when Settings → SMTP names one; the messaging adapter otherwise. A relay that refuses
         * is recorded once and left alone for five minutes, so an outage costs one failed row and not one per email. */
        const smtp = await this.smtp();
        let relayed = false;
        if (smtp && Date.now() >= this.relayDownUntil) {
          try {
            const r = await smtpSend(smtp, { to: contact.email, subject: n.title, text: this.emailText(n), from: smtp.from });
            await record('email', contact.email, 'sent', { messageId: r.messageId, mode: 'smtp' }); relayed = true;
          } catch (e) {
            this.relayDownUntil = Date.now() + RELAY_BACKOFF_MS;
            this.log.warn({ err: (e as Error).message, host: smtp.host }, 'mail relay refused; the messaging adapter carries email for five minutes');
            await record('email', contact.email, 'failed', { mode: 'smtp', error: (e as Error).message });
          }
        }
        if (!relayed) await send('email', contact.email, 'sendEmail', { to: contact.email, subject: n.title, body: n.body || n.title, link: n.link ?? undefined, severity: n.severity });
      }
    }
    if (prefs.smsEnabled) {
      if (contact?.phone) await send('sms', contact.phone, 'sendSms', { to: contact.phone, body: `${n.title}${n.body ? ` — ${n.body}` : ''}`.slice(0, 480) });
      else await record('sms', '', 'skipped', { error: 'no phone number on the account' });
    }
    return out;
  }

  /**
   * The escalation sweep. A critical notice nobody has read inside the escalation window is sent on — to the person it was
   * addressed to, or to everyone holding the audience permission — by the channels the settings allow, and marked so it is
   * escalated once. Zero hours switches escalation off.
   */
  async escalate(now = new Date()): Promise<{ hours: number; escalated: number; recipients: number; items: { id: string; title: string; audience: string; recipients: number }[] }> {
    const prefs = await this.prefs();
    const hours = prefs.escalationHours;
    const none = { hours, escalated: 0, recipients: 0, items: [] as { id: string; title: string; audience: string; recipients: number }[] };
    if (!(hours > 0)) return none;
    const due = await this.pool.query<NoticeRow>(
      `SELECT n.* FROM notifications n
        WHERE n.severity = 'error' AND n.escalated_at IS NULL
          AND n.created_at < $1::timestamptz - ($2::text || ' hours')::interval AND n.created_at > $1::timestamptz - interval '48 hours'
          AND NOT EXISTS (SELECT 1 FROM notification_reads r WHERE r.notification_id = n.id AND (n.user_id IS NULL OR r.user_id = n.user_id))
        ORDER BY n.created_at LIMIT 50`, [now, String(hours)]);
    const items: { id: string; title: string; audience: string; recipients: number }[] = [];
    let recipients = 0;
    for (const n of due.rows) {
      const holders: Holder[] = n.user_id
        ? [{ id: n.user_id, name: '', email: '', phone: '', ...(await this.contactOf(n.user_id) ?? {}) } as Holder]
        : n.audience_perm ? await this.holdersOf(n.audience_perm) : [];
      let sent = 0;
      for (const h of holders) {
        const rows = await this.deliver({ id: n.id, title: `Escalated: ${n.title}`, body: n.body, link: n.link, severity: n.severity }, { email: h.email || null, phone: h.phone || null }, { tag: `esc:${h.id}` });
        if (rows.some((r) => r.status === 'sent')) sent += 1;
      }
      await this.pool.query('UPDATE notifications SET escalated_at = $2 WHERE id = $1', [n.id, now]);
      await enqueue(this.pool, eventFromContext(this.env.SERVICE_NAME, EVENTS.notifications.escalated, {
        notificationId: n.id, title: n.title, severity: n.severity, audiencePerm: n.audience_perm, userId: n.user_id, hours, recipients: holders.length, reached: sent,
      }, { subject: n.id, actor: { id: 'scheduler', name: 'Scheduler', kind: 'system' } }));
      recipients += holders.length;
      items.push({ id: n.id, title: n.title, audience: n.user_id ? 'user' : n.audience_perm ?? '', recipients: holders.length });
    }
    if (items.length) this.log.info({ hours, escalated: items.length, recipients }, 'unread critical notices escalated');
    return { hours, escalated: items.length, recipients, items };
  }
}
