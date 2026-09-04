import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { Pool } from 'pg';
import { hasPerm } from '@maritime/contracts';
import { CurrentUser, KIT_POOL, notFound, type Principal } from '@maritime/service-kit';
import { certStatus, many, nf, one } from './queries';
import { BERTH_SCOPE, CALL_SCOPE, COMPANY_SCOPE, INCIDENT_SCOPE, SEAFARER_SCOPE, USER_SCOPE, VESSEL_SCOPE, visible } from './scope';

/* Entity hover-cards — compact people/asset summaries shown on hover anywhere in the UI. One endpoint, one
 * shape per type.
 *
 * A card is a record disclosure like any other, so each type names the permission that opens it and the
 * policy that bounds it: the card must not show a reader something the register it summarises would refuse.
 * Both are declared beside the query rather than left to the caller, because the caller is a hover. */
interface Line { label: string; value: string | null; kind?: 'since' }
interface HoverCard { kind: string; title: string; subtitle: string; link?: string; lines: Line[]; chips: { label: string; tone: string }[] }
const ACTIVE = "('ANNOUNCED','CONFIRMED','AT_ANCHORAGE','BERTHED')";
/** Any one of these permissions opens the card. */
type Card = { perms: string[]; load: (user: Principal, id: string) => Promise<HoverCard | null> };

@Controller('cards')
export class CardsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool) {}
  private readonly types: Record<string, Card> = {
    user: { perms: ['users.view'], load: async (user, id) => {
      const args: unknown[] = [id]; const vis = visible(user, USER_SCOPE);
      const u = await one<{ id: string; name: string; email: string; designation: string | null; role_name: string | null; phone: string | null; active: boolean; last_login_at: Date | null }>(this.pool, `SELECT * FROM rm_users WHERE id::text = $1 AND ${vis}`, args);
      if (!u) return null;
      return { kind: 'user', title: u.name, subtitle: u.designation || u.role_name || '', lines: [{ label: 'Role', value: u.role_name || '—' }, { label: 'Email', value: u.email }, { label: 'Phone', value: u.phone || '—' }, { label: 'Last sign-in', value: u.last_login_at ? u.last_login_at.toISOString() : null, kind: 'since' }], chips: [{ label: u.active === false ? 'Disabled' : 'Active', tone: u.active === false ? 'default' : 'success' }] };
    } },
    vessel: { perms: ['vessels.view'], load: async (user, id) => {
      const args: unknown[] = [id]; const vis = visible(user, VESSEL_SCOPE);
      const v = await one<{ id: string; name: string; imo: string; type: string; flag: string | null; owner: string | null; agent_name: string | null; agent_code: string | null; dwt: string | null; loa: string | null; status: string }>(this.pool, `SELECT * FROM rm_vessels WHERE id::text = $1 AND ${vis}`, args);
      if (!v) return null;
      // The situation line reads the call register, which is partitioned on its own terms.
      const cargs: unknown[] = [v.id]; const cvis = visible(user, CALL_SCOPE);
      const call = await one<{ status: string; vcn: string; berth_code: string | null }>(this.pool, `SELECT status, vcn, berth_code FROM rm_port_calls WHERE vessel_id = $1 AND status IN ${ACTIVE} AND ${cvis} ORDER BY eta DESC LIMIT 1`, cargs);
      const certs = await many<{ expiry_date: Date }>(this.pool, 'SELECT expiry_date FROM rm_vessel_certificates WHERE vessel_id = $1', [v.id]);
      const alerts = certs.filter((c) => certStatus(c.expiry_date) !== 'VALID').length;
      const situation = !call ? 'No active call' : call.status === 'BERTHED' ? `Berthed at ${call.berth_code || '—'} (${call.vcn})` : call.status === 'AT_ANCHORAGE' ? `At anchorage (${call.vcn})` : `Inbound — ${call.status.toLowerCase()} (${call.vcn})`;
      return { kind: 'vessel', title: v.name, subtitle: `IMO ${v.imo} · ${v.type} · ${v.flag || '—'} flag`, link: `/vessels/${v.id}`, lines: [{ label: 'Now', value: situation }, { label: 'Owner', value: v.owner || '—' }, { label: 'Agent', value: v.agent_name || v.agent_code || '—' }, { label: 'DWT / LOA', value: `${nf(Number(v.dwt || 0))} MT · ${v.loa || '—'} m` }], chips: [{ label: v.status, tone: v.status === 'ACTIVE' ? 'success' : 'default' }, ...(alerts ? [{ label: `${alerts} cert alert${alerts > 1 ? 's' : ''}`, tone: 'warning' }] : [])] };
    } },
    seafarer: { perms: ['seafarers.view'], load: async (user, id) => {
      const args: unknown[] = [id]; const vis = visible(user, SEAFARER_SCOPE);
      const s = await one<{ id: string; name: string; rank: string; cdc_no: string; current_vessel_name: string | null; nationality: string | null; seafarer_id_no: string | null; phone: string | null; status: string; cert_alerts: number }>(this.pool, `SELECT * FROM rm_seafarers WHERE id::text = $1 AND ${vis}`, args);
      if (!s) return null;
      const alerts = Number(s.cert_alerts);
      return { kind: 'seafarer', title: s.name, subtitle: `${s.rank} · CDC ${s.cdc_no}`, link: `/seafarers/${s.id}`, lines: [{ label: 'On board', value: s.current_vessel_name || 'Ashore' }, { label: 'Nationality', value: s.nationality || '—' }, { label: 'Seafarer ID', value: s.seafarer_id_no || '—' }, { label: 'Phone', value: s.phone || '—' }], chips: [{ label: s.status.replace(/_/g, ' '), tone: s.status === 'ACTIVE' ? 'success' : 'default' }, ...(alerts ? [{ label: `${alerts} cert alert${alerts > 1 ? 's' : ''}`, tone: 'warning' }] : [])] };
    } },
    berth: { perms: ['masters.view', 'portcalls.view'], load: async (user, id) => {
      const args: unknown[] = [id]; const vis = visible(user, BERTH_SCOPE);
      const b = await one<{ id: string; code: string; name: string; terminal: string; berth_type: string; loa_max: string | null; draft_max: string | null; status: string }>(this.pool, `SELECT * FROM rm_berths WHERE (id::text = $1 OR code = $1) AND ${vis}`, args);
      if (!b) return null;
      const cargs: unknown[] = [b.id]; const cvis = visible(user, CALL_SCOPE);
      const call = await one<{ vessel_name: string; vcn: string }>(this.pool, `SELECT vessel_name, vcn FROM rm_port_calls WHERE berth_id = $1 AND status = 'BERTHED' AND ${cvis} LIMIT 1`, cargs);
      return { kind: 'berth', title: `${b.code} — ${b.name}`, subtitle: b.terminal, lines: [{ label: 'Type', value: b.berth_type }, { label: 'Max LOA / draft', value: `${b.loa_max || '—'} m · ${b.draft_max || '—'} m` }, { label: 'Alongside', value: call ? `${call.vessel_name} (${call.vcn})` : 'Free' }], chips: [{ label: b.status, tone: b.status === 'OPERATIONAL' ? 'success' : 'warning' }, { label: call ? 'Occupied' : 'Free', tone: call ? 'info' : 'default' }] };
    } },
    agent: { perms: ['facilities.view'], load: async (user, code) => {
      const args: unknown[] = [String(code).toUpperCase()]; const vis = visible(user, COMPANY_SCOPE);
      const a = await one<{ id: string; code: string; name: string; address: string | null; tax_id: string | null }>(this.pool, `SELECT * FROM rm_companies WHERE (code = $1 OR id::text = $1) AND ${vis}`, args);
      if (!a) return null;
      const cargs: unknown[] = [a.code]; const cvis = visible(user, CALL_SCOPE);
      const n = await one<{ n: string }>(this.pool, `SELECT count(*) AS n FROM rm_port_calls WHERE agent_code = $1 AND status IN ${ACTIVE} AND ${cvis}`, cargs);
      return { kind: 'agent', title: a.name, subtitle: `Shipping agent · ${a.code}`, link: `/companies/${a.id}`, lines: [{ label: 'Address', value: a.address || '—' }, { label: 'Tax id', value: a.tax_id || '—' }, { label: 'Active calls', value: String(Number(n?.n ?? 0)) }], chips: [{ label: 'Licensed', tone: 'success' }] };
    } },
    incident: { perms: ['incidents.view'], load: async (user, id) => {
      const args: unknown[] = [id]; const vis = visible(user, INCIDENT_SCOPE);
      const i = await one<{ id: string; number: string; title: string; type: string; severity: string; status: string; reported_at: Date; assigned_to_name: string | null }>(this.pool, `SELECT * FROM rm_incidents WHERE id::text = $1 AND ${vis}`, args);
      if (!i) return null;
      return { kind: 'incident', title: i.number, subtitle: i.title, link: `/incidents/${i.id}`, lines: [{ label: 'Type', value: i.type.replace(/_/g, ' ') }, { label: 'Case officer', value: i.assigned_to_name || 'Unassigned' }, { label: 'Reported', value: i.reported_at.toISOString(), kind: 'since' }], chips: [{ label: i.severity, tone: ['HIGH', 'CRITICAL'].includes(i.severity) ? 'error' : i.severity === 'MEDIUM' ? 'warning' : 'default' }, { label: i.status.replace(/_/g, ' '), tone: ['RESOLVED', 'CLOSED'].includes(i.status) ? 'success' : 'info' }] };
    } },
  };
  @Get(':type/:id')
  async get(@CurrentUser() user: Principal, @Param('type') type: string, @Param('id') id: string) {
    // A company card is the agent card under the name the company screens use.
    const card = this.types[type === 'company' ? 'agent' : type];
    if (!card) throw notFound(`Unknown card type "${type}"`);
    // Out of permission answers the same as out of scope and the same as absent: a hover must not become a
    // way to learn that a record exists.
    if (!card.perms.some((p) => hasPerm(user.perms, p))) throw notFound('Record not found');
    const out = await card.load(user, id).catch(() => null);
    if (!out) throw notFound('Record not found');
    return out;
  }
}
