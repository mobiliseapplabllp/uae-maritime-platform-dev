import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Pool } from 'pg';
import { hasPerm } from '@maritime/contracts';
import { CurrentUser, KIT_POOL, KIT_SEARCH, type Principal, type ScopeOptions, type SearchAdapter, type SearchIndex } from '@maritime/service-kit';
import { many, money } from './queries';
import { INDEXES } from './indexes';
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
 *
 * Matching and authorisation are separate steps, always in that order. The search driver — PostgreSQL here,
 * OpenSearch where one is deployed — returns candidate identifiers and knows nothing about who is asking.
 * Those identifiers then go through the same visibility clause every other query uses, and the rows come
 * back from PostgreSQL. Nothing reaches a user that the database did not just re-authorise.
 */
@Controller('search')
export class SearchController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_SEARCH) private readonly search: SearchAdapter) {}

  @Get()
  async global(@Query('q') qRaw: string | undefined, @CurrentUser() user: Principal) {
    const q = String(qRaw || '').trim();
    if (q.length < 2) return { groups: [], q };
    const LIMIT = 5;
    /*
     * Candidates are asked for far more generously than the five results a group shows, because the driver
     * ranks by relevance and the visibility clause then removes whatever the reader may not see. A shipping
     * agent searching a common word would otherwise get an empty group whose top matches all belonged to
     * other companies. Identifiers are cheap to fetch, so the window is wide.
     *
     * It is a wide window and not a guarantee: a match ranked below the window is not returned. The
     * alternative — pushing tenancy into the search index — would trade that for two copies of the
     * boundary, which is the worse failure.
     */
    const CANDIDATES = 120;
    const jobs: Promise<{ type: string; label: string; items: unknown[] }>[] = [];

    /**
     * `sql` is a template taking the candidate identifiers as $1 and the row limit as $2; the visibility
     * clause and any parameters it needs are appended after those two, and the template says where the
     * clause goes. Ordering replays the driver's ranking, so relevance survives the authorisation step.
     */
    const add = <R>(perm: string, scope: ScopeOptions, type: string, label: string, index: SearchIndex, sql: (vis: string) => string, map: (r: R) => unknown, extra: string[] = []) => {
      if (!hasPerm(user.perms, perm)) return;
      jobs.push((async () => {
        const hits = await this.search.match({ index, q, limit: CANDIDATES });
        if (!hits.length) return { type, label, items: [] };
        const ids = hits.map((h) => h.id);
        const clauses = [visible(user, scope), ...extra];
        const rows = await many<R>(this.pool, sql(clauses.join(' AND ')), [ids, LIMIT]);
        return { type, label, items: rows.map(map) };
      })());
    };

    /** Every group narrows the candidate set the same way, so the shape is written once. */
    const from = (table: string, columns: string) =>
      (vis: string) => `SELECT ${columns} FROM ${table} WHERE id::text = ANY($1::text[]) AND ${vis} ORDER BY array_position($1::text[], id::text) LIMIT $2`;

    add<{ id: string; name: string; imo: string; type: string }>('vessels.view', VESSEL_SCOPE, 'vessel', 'Vessels', INDEXES.vessels,
      from('rm_vessels', 'id, name, imo, type'),
      (v) => ({ id: v.id, label: v.name, sub: `IMO ${v.imo} · ${v.type}`, to: `/vessels/${v.id}` }));
    add<{ id: string; vcn: string; vessel_name: string; status: string }>('portcalls.view', CALL_SCOPE, 'call', 'Port calls', INDEXES.portCalls,
      from('rm_port_calls', 'id, vcn, vessel_name, status'),
      (c) => ({ id: c.id, label: c.vcn, sub: `${c.vessel_name} · ${c.status}`, to: `/port-calls/${c.id}` }));
    add<{ id: string; name: string; rank: string; cdc_no: string }>('seafarers.view', SEAFARER_SCOPE, 'seafarer', 'Seafarers', INDEXES.seafarers,
      from('rm_seafarers', 'id, name, rank, cdc_no'),
      (s) => ({ id: s.id, label: s.name, sub: `${s.rank} · CDC ${s.cdc_no}`, to: `/seafarers/${s.id}` }));
    add<{ id: string; name: string; name_ar: string | null; code: string; category: string | null }>('facilities.view', COMPANY_SCOPE, 'company', 'Companies', INDEXES.companies,
      from('rm_companies', 'id, name, name_ar, code, category'),
      (c) => ({ id: c.id, label: c.name, labelAr: c.name_ar, sub: `${c.code} · ${String(c.category || '').replace(/_/g, ' ')}`, to: `/companies/${c.id}` }));
    add<{ id: string; number: string; title: string; severity: string; status: string }>('incidents.view', INCIDENT_SCOPE, 'incident', 'Incidents', INDEXES.incidents,
      from('rm_incidents', 'id, number, title, severity, status'),
      (i) => ({ id: i.id, label: `${i.number} — ${i.title}`, sub: `${i.severity} · ${i.status}`, to: `/incidents/${i.id}` }));
    add<{ id: string; number: string; total: string; status: string }>('invoices.view', INVOICE_SCOPE, 'invoice', 'Invoices', INDEXES.invoices,
      from('rm_invoices', 'id, number, total, status'),
      (i) => ({ id: i.id, label: i.number, sub: `${money(Number(i.total))} · ${i.status}`, to: `/invoices/${i.id}` }));
    // Legislation is public to the industry once it is in force, and invisible before: a draft notice is not
    // law, and the register itself does not publish one.
    const publication = seesUnpublished(user) ? [] : [`status = ANY('{${PUBLISHED_STATUSES.join(',')}}')`];
    add<{ id: string; ref_no: string; title: string; title_ar: string | null; status: string }>('legislation.view', LEGISLATION_SCOPE, 'notice', 'Notices & circulars', INDEXES.legalInstruments,
      from('rm_legal_instruments', 'id, ref_no, title, title_ar, status'),
      (n) => ({ id: n.id, label: `${n.ref_no} — ${n.title}`, labelAr: n.title_ar, sub: n.status, to: '/legislation' }), publication);
    add<{ id: string; number: string; entity_name: string; status: string }>('facilities.view', INSTRUMENT_SCOPE, 'licence', 'Licences', INDEXES.instruments,
      from('rm_instruments', 'id, number, entity_name, status'),
      (l) => ({ id: l.id, label: l.number, sub: `${l.entity_name} · ${l.status}`, to: `/facilities/${l.id}` }));
    add<{ id: string; name: string; email: string; designation: string | null }>('users.view', USER_SCOPE, 'user', 'Users', INDEXES.users,
      from('rm_users', 'id, name, email, designation'),
      (u) => ({ id: u.id, label: u.name, sub: `${u.designation || ''} · ${u.email}`, to: '/admin/users' }));

    const groups = (await Promise.all(jobs)).filter((g) => g.items.length);
    return { groups, q, driver: this.search.driver };
  }
}
