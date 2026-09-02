import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Pool } from 'pg';
import { hasPerm } from '@maritime/contracts';
import { CurrentUser, KIT_POOL, escapeLike, type Principal } from '@maritime/service-kit';
import { many, money } from './queries';

/** Global search — one query across every register the signed-in role can see. Powers the Ctrl+K palette. */
@Controller('search')
export class SearchController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool) {}
  @Get()
  async global(@Query('q') qRaw: string | undefined, @CurrentUser() user: Principal) {
    const q = String(qRaw || '').trim();
    if (q.length < 2) return { groups: [], q };
    const like = `%${escapeLike(q)}%`; const LIMIT = 5;
    const jobs: Promise<{ type: string; label: string; items: unknown[] }>[] = [];
    const add = <R>(perm: string, type: string, label: string, sql: string, map: (r: R) => unknown) => {
      if (!hasPerm(user.perms, perm)) return;
      jobs.push(many<R>(this.pool, sql, [like, LIMIT]).then((rows) => ({ type, label, items: rows.map(map) })));
    };
    add('vessels.view', 'vessel', 'Vessels', 'SELECT id, name, imo, type FROM rm_vessels WHERE name ILIKE $1 OR imo ILIKE $1 OR call_sign ILIKE $1 ORDER BY name LIMIT $2', (v: { id: string; name: string; imo: string; type: string }) => ({ id: v.id, label: v.name, sub: `IMO ${v.imo} · ${v.type}`, to: `/vessels/${v.id}` }));
    add('portcalls.view', 'call', 'Port calls', 'SELECT id, vcn, vessel_name, status FROM rm_port_calls WHERE vcn ILIKE $1 ORDER BY eta DESC LIMIT $2', (c: { id: string; vcn: string; vessel_name: string; status: string }) => ({ id: c.id, label: c.vcn, sub: `${c.vessel_name} · ${c.status}`, to: `/port-calls/${c.id}` }));
    add('seafarers.view', 'seafarer', 'Seafarers', 'SELECT id, name, rank, cdc_no FROM rm_seafarers WHERE name ILIKE $1 OR cdc_no ILIKE $1 OR seafarer_id_no ILIKE $1 ORDER BY name LIMIT $2', (s: { id: string; name: string; rank: string; cdc_no: string }) => ({ id: s.id, label: s.name, sub: `${s.rank} · CDC ${s.cdc_no}`, to: `/seafarers/${s.id}` }));
    add('facilities.view', 'company', 'Companies', 'SELECT id, name, code, category FROM rm_companies WHERE name ILIKE $1 OR code ILIKE $1 ORDER BY name LIMIT $2', (c: { id: string; name: string; code: string; category: string | null }) => ({ id: c.id, label: c.name, sub: `${c.code} · ${String(c.category || '').replace(/_/g, ' ')}`, to: `/companies/${c.id}` }));
    add('incidents.view', 'incident', 'Incidents', 'SELECT id, number, title, severity, status FROM rm_incidents WHERE number ILIKE $1 OR title ILIKE $1 ORDER BY reported_at DESC LIMIT $2', (i: { id: string; number: string; title: string; severity: string; status: string }) => ({ id: i.id, label: `${i.number} — ${i.title}`, sub: `${i.severity} · ${i.status}`, to: `/incidents/${i.id}` }));
    add('invoices.view', 'invoice', 'Invoices', 'SELECT id, number, total, status FROM rm_invoices WHERE number ILIKE $1 ORDER BY created_at DESC LIMIT $2', (i: { id: string; number: string; total: string; status: string }) => ({ id: i.id, label: i.number, sub: `${money(Number(i.total))} · ${i.status}`, to: `/invoices/${i.id}` }));
    add('legislation.view', 'notice', 'Notices & circulars', 'SELECT id, ref_no, title, status FROM rm_legal_instruments WHERE ref_no ILIKE $1 OR title ILIKE $1 ORDER BY issued_date DESC NULLS LAST LIMIT $2', (n: { id: string; ref_no: string; title: string; status: string }) => ({ id: n.id, label: `${n.ref_no} — ${n.title}`, sub: n.status, to: '/legislation' }));
    add('facilities.view', 'licence', 'Licences', 'SELECT id, number, entity_name, status FROM rm_instruments WHERE number ILIKE $1 OR entity_name ILIKE $1 ORDER BY number LIMIT $2', (l: { id: string; number: string; entity_name: string; status: string }) => ({ id: l.id, label: l.number, sub: `${l.entity_name} · ${l.status}`, to: `/facilities/${l.id}` }));
    add('users.view', 'user', 'Users', 'SELECT id, name, email, designation FROM rm_users WHERE name ILIKE $1 OR email ILIKE $1 ORDER BY name LIMIT $2', (u: { id: string; name: string; email: string; designation: string | null }) => ({ id: u.id, label: u.name, sub: `${u.designation || ''} · ${u.email}`, to: '/admin/users' }));
    const groups = (await Promise.all(jobs)).filter((g) => g.items.length);
    return { groups, q };
  }
}
