import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { hasPerm, NOTIFICATION_SEVERITIES, WILDCARD } from '@maritime/contracts';
import { KIT_POOL, CurrentUser, ServiceOnly, zod, notFound, type Principal, getContext } from '@maritime/service-kit';

interface Row { id: string; title: string; title_ar: string | null; body: string; body_ar: string | null; severity: string; link: string | null; audience_perm: string | null; user_id: string | null; source: string; event_type: string | null; created_at: Date; read_at: Date | null }
const toApi = (r: Row, lang: string) => ({ id: r.id, title: lang === 'ar' && r.title_ar ? r.title_ar : r.title, body: lang === 'ar' && r.body_ar ? r.body_ar : r.body, severity: r.severity, link: r.link, audiencePerm: r.audience_perm, source: r.source, eventType: r.event_type, createdAt: r.created_at, read: !!r.read_at });
const createSchema = z.object({ title: z.string().min(1).max(200), titleAr: z.string().max(200).optional().nullable(), body: z.string().max(2000).optional().default(''), bodyAr: z.string().max(2000).optional().nullable(), severity: z.enum(NOTIFICATION_SEVERITIES).optional().default('info'), link: z.string().max(300).optional().nullable(), audiencePerm: z.string().max(60).optional().nullable(), userId: z.string().max(80).optional().nullable(), source: z.string().max(60).optional().default('system'), eventType: z.string().max(120).optional().nullable() });

/** Permission-audience fan-out: a notification addressed to `dashboard.view` reaches everyone who holds it; per-user rows reach one person. */
@Controller('notifications')
export class NotificationsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool) {}
  private audienceClause(user: Principal, args: unknown[]): string {
    args.push(user.id);
    const userIdx = args.length;
    if (hasPerm(user.perms, WILDCARD)) return `(n.user_id IS NULL OR n.user_id = $${userIdx})`;
    args.push(user.perms);
    return `((n.audience_perm = ANY($${args.length}::text[]) AND n.user_id IS NULL) OR n.user_id = $${userIdx})`;
  }
  @Get()
  async list(@CurrentUser() user: Principal, @Query('limit') limit?: string) {
    const lang = getContext()?.language ?? 'en';
    const args: unknown[] = []; const aud = this.audienceClause(user, args);
    const n = Math.min(100, Math.max(1, Number(limit) || 30));
    const rows = await this.pool.query<Row>(`SELECT n.*, r.read_at FROM notifications n LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = $1 WHERE ${aud} ORDER BY n.created_at DESC LIMIT ${n}`, args);
    const unread = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM notifications n LEFT JOIN notification_reads r ON r.notification_id = n.id AND r.user_id = $1 WHERE ${aud} AND r.read_at IS NULL`, args);
    return { items: rows.rows.map((r) => toApi(r, lang)), unread: Number(unread.rows[0].n) };
  }
  @Post(':id/read')
  async markRead(@CurrentUser() user: Principal, @Param('id') id: string) {
    const exists = await this.pool.query('SELECT 1 FROM notifications WHERE id = $1', [id]); if (!exists.rowCount) throw notFound('Notification not found');
    await this.pool.query('INSERT INTO notification_reads(notification_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [id, user.id]);
    return { read: true };
  }
  @Post('read-all')
  async readAll(@CurrentUser() user: Principal) {
    const args: unknown[] = []; const aud = this.audienceClause(user, args);
    const r = await this.pool.query(`INSERT INTO notification_reads(notification_id, user_id) SELECT n.id, $1 FROM notifications n WHERE ${aud} ON CONFLICT DO NOTHING`, args);
    return { marked: r.rowCount ?? 0 };
  }
  /** Other services create notifications through this endpoint or by publishing events the dispatcher consumes. */
  @ServiceOnly() @Post('internal')
  async create(@Body(zod(createSchema)) b: z.infer<typeof createSchema>) {
    const r = await this.pool.query<Row>('INSERT INTO notifications(title, title_ar, body, body_ar, severity, link, audience_perm, user_id, source, event_type) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *, NULL::timestamptz AS read_at',
      [b.title, b.titleAr ?? null, b.body, b.bodyAr ?? null, b.severity, b.link ?? null, b.audiencePerm ?? (b.userId ? null : 'dashboard.view'), b.userId ?? null, b.source, b.eventType ?? null]);
    return toApi(r.rows[0], 'en');
  }
}
