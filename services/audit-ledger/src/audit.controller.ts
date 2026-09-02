import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { Pool } from 'pg';
import type { PageQuery } from '@maritime/contracts';
import { KIT_POOL, RequirePerm, paged, parsePage, escapeLike, notFound } from '@maritime/service-kit';
import { verifyChain } from './ledger';

interface Row { seq: string; event_id: string; at: Date; service: string; actor_id: string; actor_name: string; actor_email: string; actor_kind: string; action: string; entity: string; entity_id: string | null; entity_label: string | null; before: unknown; after: unknown; note: string | null; ip: string | null; correlation_id: string | null; prev_hash: string; hash: string }
const toApi = (r: Row) => ({ id: r.event_id, seq: Number(r.seq), at: r.at, service: r.service, actor: { id: r.actor_id, name: r.actor_name, email: r.actor_email, kind: r.actor_kind }, action: r.action, entity: r.entity, entityId: r.entity_id, entityLabel: r.entity_label, before: r.before, after: r.after, note: r.note, ip: r.ip, correlationId: r.correlation_id, hash: r.hash, prevHash: r.prev_hash });
const SORT: Record<string, string> = { at: 'at', seq: 'seq', action: 'action', entity: 'entity', actor: 'actor_name' };

@Controller('audit')
export class AuditController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool) {}
  @RequirePerm('audit.view') @Get()
  async list(@Query() query: PageQuery & { entity?: string; entityId?: string; action?: string; actor?: string; service?: string; from?: string; to?: string }) {
    const p = parsePage(query, { defaultSort: '-at', sortable: Object.keys(SORT) });
    const where: string[] = []; const args: unknown[] = [];
    const eq = (col: string, v?: string) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
    eq('entity', query.entity); eq('entity_id', query.entityId); eq('action', query.action); eq('service', query.service);
    if (query.actor) { args.push(query.actor); where.push(`(actor_id = $${args.length} OR actor_email = $${args.length})`); }
    if (query.from) { args.push(query.from); where.push(`at >= $${args.length}`); }
    if (query.to) { args.push(query.to); where.push(`at <= $${args.length}`); }
    if (p.q) { args.push(`%${escapeLike(p.q)}%`); where.push(`(actor_name ILIKE $${args.length} OR actor_email ILIKE $${args.length} OR entity ILIKE $${args.length} OR coalesce(entity_label,'') ILIKE $${args.length} OR action ILIKE $${args.length})`); }
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM audit_entries ${w}`, args);
    const rows = await this.pool.query<Row>(`SELECT * FROM audit_entries ${w} ORDER BY ${SORT[p.sortField]} ${p.sortDir}, seq DESC LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(toApi), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }
  @RequirePerm('audit.view') @Get('verify')
  verify(@Query('limit') limit?: string) { return verifyChain(this.pool, Math.min(1_000_000, Number(limit) || 100000)); }
  @RequirePerm('audit.view') @Get('summary')
  async summary() {
    const r = await this.pool.query<{ action: string; n: string }>('SELECT action, count(*) AS n FROM audit_entries GROUP BY action ORDER BY n DESC LIMIT 20');
    const t = await this.pool.query<{ n: string; first: Date | null; last: Date | null }>('SELECT count(*) AS n, min(at) AS first, max(at) AS last FROM audit_entries');
    return { total: Number(t.rows[0].n), first: t.rows[0].first, last: t.rows[0].last, byAction: r.rows.map((x) => ({ action: x.action, count: Number(x.n) })) };
  }
  @RequirePerm('audit.view') @Get(':id')
  async get(@Param('id') id: string) { const r = await this.pool.query<Row>('SELECT * FROM audit_entries WHERE event_id::text = $1 OR seq::text = $1', [id]); if (!r.rows[0]) throw notFound('Audit entry not found'); return toApi(r.rows[0]); }
}
