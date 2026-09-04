import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Pool } from 'pg';
import { hasPerm } from '@maritime/contracts';
import { CurrentUser, KIT_POOL, escapeLike, type Principal, type ScopeOptions } from '@maritime/service-kit';
import { many, money } from './queries';
import {
  CALL_SCOPE, COMPANY_SCOPE, INCIDENT_SCOPE, INSTRUMENT_SCOPE, INVOICE_SCOPE, LEGISLATION_SCOPE,
  PUBLISHED_STATUSES, SEAFARER_SCOPE, USER_SCOPE, VESSEL_SCOPE, seesUnpublished, visible,
} from './scope';

/**
 * Global search — one query across every register the signed-in role can see. Powers the Ctrl+K palette.
 *
 * Two things bound a group: the permission that opens it, and the tenancy predicate of the register it
 * searches. The permission alone is not enough — an agent holding `vessels.view` holds it over their own
 * ships, and a palette that answered from the whole read model would hand them the national register one
 * keystroke at a time.
 */
@Controller('search')
export class SearchController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool) {}
  @Get()
  async global(@Query('q') qRaw: string | undefined, @CurrentUser() user: Principal) {
    const q = String(qRaw || '').trim();
    if (q.length < 2) return { groups: [], q };
    const like = `%${escapeLike(q)}%`; const LIMIT = 5;
    const jobs: Promise<{ type: string; label: string; items: unknown[] }>[] = [];
    /**
     * `sql` is a template taking the search term as $1 and the row limit as $2; the visibility clause and any
     * parameters it needs are appended after those two, and the template says where the clause goes.
     */
    const add = <R>(perm: string, scope: ScopeOptions, type: string, label: string, sql: (vis: string) => string, map: (r: R) => unknown, extra: string[] = []) => {
      if (!hasPerm(user.perms, perm)) return;
      const args: unknown[] = [like, LIMIT];
      const clauses = [visible(user, scope), ...extra];
      jobs.push(many<R>(this.pool, sql(clauses.join(' AND ')), args).then((rows) => ({ type, label, items: rows.map(map) })));
    };
    add<{ id: string; name: string; imo: string; type: string }>('vessels.view', VESSEL_SCOPE, 'vessel', 'Vessels',
      (vis) => `SELECT id, name, imo, type FROM rm_vessels WHERE (name ILIKE $1 OR imo ILIKE $1 OR call_sign ILIKE $1) AND ${vis} ORDER BY name LIMIT $2`,
      (v) => ({ id: v.id, label: v.name, sub: `IMO ${v.imo} · ${v.type}`, to: `/vessels/${v.id}` }));
    add<{ id: string; vcn: string; vessel_name: string; status: string }>('portcalls.view', CALL_SCOPE, 'call', 'Port calls',
      (vis) => `SELECT id, vcn, vessel_name, status FROM rm_port_calls WHERE vcn ILIKE $1 AND ${vis} ORDER BY eta DESC LIMIT $2`,
      (c) => ({ id: c.id, label: c.vcn, sub: `${c.vessel_name} · ${c.status}`, to: `/port-calls/${c.id}` }));
    add<{ id: string; name: string; rank: string; cdc_no: string }>('seafarers.view', SEAFARER_SCOPE, 'seafarer', 'Seafarers',
      (vis) => `SELECT id, name, rank, cdc_no FROM rm_seafarers WHERE (name ILIKE $1 OR cdc_no ILIKE $1 OR seafarer_id_no ILIKE $1) AND ${vis} ORDER BY name LIMIT $2`,
      (s) => ({ id: s.id, label: s.name, sub: `${s.rank} · CDC ${s.cdc_no}`, to: `/seafarers/${s.id}` }));
    add<{ id: string; name: string; code: string; category: string | null }>('facilities.view', COMPANY_SCOPE, 'company', 'Companies',
      (vis) => `SELECT id, name, code, category FROM rm_companies WHERE (name ILIKE $1 OR code ILIKE $1) AND ${vis} ORDER BY name LIMIT $2`,
      (c) => ({ id: c.id, label: c.name, sub: `${c.code} · ${String(c.category || '').replace(/_/g, ' ')}`, to: `/companies/${c.id}` }));
    add<{ id: string; number: string; title: string; severity: string; status: string }>('incidents.view', INCIDENT_SCOPE, 'incident', 'Incidents',
      (vis) => `SELECT id, number, title, severity, status FROM rm_incidents WHERE (number ILIKE $1 OR title ILIKE $1) AND ${vis} ORDER BY reported_at DESC LIMIT $2`,
      (i) => ({ id: i.id, label: `${i.number} — ${i.title}`, sub: `${i.severity} · ${i.status}`, to: `/incidents/${i.id}` }));
    add<{ id: string; number: string; total: string; status: string }>('invoices.view', INVOICE_SCOPE, 'invoice', 'Invoices',
      (vis) => `SELECT id, number, total, status FROM rm_invoices WHERE number ILIKE $1 AND ${vis} ORDER BY created_at DESC LIMIT $2`,
      (i) => ({ id: i.id, label: i.number, sub: `${money(Number(i.total))} · ${i.status}`, to: `/invoices/${i.id}` }));
    // Legislation is public to the industry once it is in force, and invisible before: a draft notice is not
    // law, and the register itself does not publish one.
    const publication = seesUnpublished(user) ? [] : [`status = ANY('{${PUBLISHED_STATUSES.join(',')}}')`];
    add<{ id: string; ref_no: string; title: string; status: string }>('legislation.view', LEGISLATION_SCOPE, 'notice', 'Notices & circulars',
      (vis) => `SELECT id, ref_no, title, status FROM rm_legal_instruments WHERE (ref_no ILIKE $1 OR title ILIKE $1) AND ${vis} ORDER BY issued_date DESC NULLS LAST LIMIT $2`,
      (n) => ({ id: n.id, label: `${n.ref_no} — ${n.title}`, sub: n.status, to: '/legislation' }), publication);
    add<{ id: string; number: string; entity_name: string; status: string }>('facilities.view', INSTRUMENT_SCOPE, 'licence', 'Licences',
      (vis) => `SELECT id, number, entity_name, status FROM rm_instruments WHERE (number ILIKE $1 OR entity_name ILIKE $1) AND ${vis} ORDER BY number LIMIT $2`,
      (l) => ({ id: l.id, label: l.number, sub: `${l.entity_name} · ${l.status}`, to: `/facilities/${l.id}` }));
    add<{ id: string; name: string; email: string; designation: string | null }>('users.view', USER_SCOPE, 'user', 'Users',
      (vis) => `SELECT id, name, email, designation FROM rm_users WHERE (name ILIKE $1 OR email ILIKE $1) AND ${vis} ORDER BY name LIMIT $2`,
      (u) => ({ id: u.id, label: u.name, sub: `${u.designation || ''} · ${u.email}`, to: '/admin/users' }));
    const groups = (await Promise.all(jobs)).filter((g) => g.items.length);
    return { groups, q };
  }
}
