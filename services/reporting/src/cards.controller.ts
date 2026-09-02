import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { Pool } from 'pg';
import { KIT_POOL, notFound } from '@maritime/service-kit';
import { certStatus, many, nf, one } from './queries';

/* Entity hover-cards — compact people/asset summaries shown on hover anywhere in the UI. One endpoint, one shape per type. */
interface Line { label: string; value: string | null; kind?: 'since' }
interface HoverCard { kind: string; title: string; subtitle: string; link?: string; lines: Line[]; chips: { label: string; tone: string }[] }
const ACTIVE = "('ANNOUNCED','CONFIRMED','AT_ANCHORAGE','BERTHED')";

@Controller('cards')
export class CardsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool) {}
  private readonly types: Record<string, (id: string) => Promise<HoverCard | null>> = {
    user: async (id) => {
      const u = await one<{ id: string; name: string; email: string; designation: string | null; role_name: string | null; phone: string | null; active: boolean; last_login_at: Date | null }>(this.pool, 'SELECT * FROM rm_users WHERE id::text = $1', [id]);
      if (!u) return null;
      return { kind: 'user', title: u.name, subtitle: u.designation || u.role_name || '', lines: [{ label: 'Role', value: u.role_name || '—' }, { label: 'Email', value: u.email }, { label: 'Phone', value: u.phone || '—' }, { label: 'Last sign-in', value: u.last_login_at ? u.last_login_at.toISOString() : null, kind: 'since' }], chips: [{ label: u.active === false ? 'Disabled' : 'Active', tone: u.active === false ? 'default' : 'success' }] };
    },
    vessel: async (id) => {
      const v = await one<{ id: string; name: string; imo: string; type: string; flag: string | null; owner: string | null; agent_name: string | null; agent_code: string | null; dwt: string | null; loa: string | null; status: string }>(this.pool, 'SELECT * FROM rm_vessels WHERE id::text = $1', [id]);
      if (!v) return null;
      const call = await one<{ status: string; vcn: string; berth_code: string | null }>(this.pool, `SELECT status, vcn, berth_code FROM rm_port_calls WHERE vessel_id = $1 AND status IN ${ACTIVE} ORDER BY eta DESC LIMIT 1`, [v.id]);
      const certs = await many<{ expiry_date: Date }>(this.pool, 'SELECT expiry_date FROM rm_vessel_certificates WHERE vessel_id = $1', [v.id]);
      const alerts = certs.filter((c) => certStatus(c.expiry_date) !== 'VALID').length;
      const situation = !call ? 'No active call' : call.status === 'BERTHED' ? `Berthed at ${call.berth_code || '—'} (${call.vcn})` : call.status === 'AT_ANCHORAGE' ? `At anchorage (${call.vcn})` : `Inbound — ${call.status.toLowerCase()} (${call.vcn})`;
      return { kind: 'vessel', title: v.name, subtitle: `IMO ${v.imo} · ${v.type} · ${v.flag || '—'} flag`, link: `/vessels/${v.id}`, lines: [{ label: 'Now', value: situation }, { label: 'Owner', value: v.owner || '—' }, { label: 'Agent', value: v.agent_name || v.agent_code || '—' }, { label: 'DWT / LOA', value: `${nf(Number(v.dwt || 0))} MT · ${v.loa || '—'} m` }], chips: [{ label: v.status, tone: v.status === 'ACTIVE' ? 'success' : 'default' }, ...(alerts ? [{ label: `${alerts} cert alert${alerts > 1 ? 's' : ''}`, tone: 'warning' }] : [])] };
    },
    seafarer: async (id) => {
      const s = await one<{ id: string; name: string; rank: string; cdc_no: string; current_vessel_name: string | null; nationality: string | null; seafarer_id_no: string | null; phone: string | null; status: string; cert_alerts: number }>(this.pool, 'SELECT * FROM rm_seafarers WHERE id::text = $1', [id]);
      if (!s) return null;
      const alerts = Number(s.cert_alerts);
      return { kind: 'seafarer', title: s.name, subtitle: `${s.rank} · CDC ${s.cdc_no}`, link: `/seafarers/${s.id}`, lines: [{ label: 'On board', value: s.current_vessel_name || 'Ashore' }, { label: 'Nationality', value: s.nationality || '—' }, { label: 'Seafarer ID', value: s.seafarer_id_no || '—' }, { label: 'Phone', value: s.phone || '—' }], chips: [{ label: s.status.replace(/_/g, ' '), tone: s.status === 'ACTIVE' ? 'success' : 'default' }, ...(alerts ? [{ label: `${alerts} cert alert${alerts > 1 ? 's' : ''}`, tone: 'warning' }] : [])] };
    },
    berth: async (id) => {
      const b = await one<{ id: string; code: string; name: string; terminal: string; berth_type: string; loa_max: string | null; draft_max: string | null; status: string }>(this.pool, 'SELECT * FROM rm_berths WHERE id::text = $1 OR code = $1', [id]);
      if (!b) return null;
      const call = await one<{ vessel_name: string; vcn: string }>(this.pool, "SELECT vessel_name, vcn FROM rm_port_calls WHERE berth_id = $1 AND status = 'BERTHED' LIMIT 1", [b.id]);
      return { kind: 'berth', title: `${b.code} — ${b.name}`, subtitle: b.terminal, lines: [{ label: 'Type', value: b.berth_type }, { label: 'Max LOA / draft', value: `${b.loa_max || '—'} m · ${b.draft_max || '—'} m` }, { label: 'Alongside', value: call ? `${call.vessel_name} (${call.vcn})` : 'Free' }], chips: [{ label: b.status, tone: b.status === 'OPERATIONAL' ? 'success' : 'warning' }, { label: call ? 'Occupied' : 'Free', tone: call ? 'info' : 'default' }] };
    },
    agent: async (code) => {
      const a = await one<{ id: string; code: string; name: string; address: string | null; tax_id: string | null }>(this.pool, 'SELECT * FROM rm_companies WHERE code = $1 OR id::text = $1', [String(code).toUpperCase()]);
      if (!a) return null;
      const n = await one<{ n: string }>(this.pool, `SELECT count(*) AS n FROM rm_port_calls WHERE agent_code = $1 AND status IN ${ACTIVE}`, [a.code]);
      return { kind: 'agent', title: a.name, subtitle: `Shipping agent · ${a.code}`, link: `/companies/${a.id}`, lines: [{ label: 'Address', value: a.address || '—' }, { label: 'Tax id', value: a.tax_id || '—' }, { label: 'Active calls', value: String(Number(n?.n ?? 0)) }], chips: [{ label: 'Licensed', tone: 'success' }] };
    },
    company: async (id) => this.types.agent(id),
    incident: async (id) => {
      const i = await one<{ id: string; number: string; title: string; type: string; severity: string; status: string; reported_at: Date; assigned_to_name: string | null }>(this.pool, 'SELECT * FROM rm_incidents WHERE id::text = $1', [id]);
      if (!i) return null;
      return { kind: 'incident', title: i.number, subtitle: i.title, link: `/incidents/${i.id}`, lines: [{ label: 'Type', value: i.type.replace(/_/g, ' ') }, { label: 'Case officer', value: i.assigned_to_name || 'Unassigned' }, { label: 'Reported', value: i.reported_at.toISOString(), kind: 'since' }], chips: [{ label: i.severity, tone: ['HIGH', 'CRITICAL'].includes(i.severity) ? 'error' : i.severity === 'MEDIUM' ? 'warning' : 'default' }, { label: i.status.replace(/_/g, ' '), tone: ['RESOLVED', 'CLOSED'].includes(i.status) ? 'success' : 'info' }] };
    },
  };
  @Get(':type/:id')
  async get(@Param('type') type: string, @Param('id') id: string) {
    const fn = this.types[type]; if (!fn) throw notFound(`Unknown card type "${type}"`);
    const card = await fn(id).catch(() => null);
    if (!card) throw notFound('Record not found');
    return card;
  }
}
