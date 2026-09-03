import type { Queryable } from '@maritime/service-kit';
import { mayRead } from './retrieval';

/* The tool surface: the only way the assistant reads a record.
 *
 * Every tool declares the permission its data sits behind, and `plan` checks that permission against the asking
 * user before the tool runs — not after, and not by filtering the result. A user who cannot see invoices does
 * not get an empty invoice answer; they get a refusal that says which permission is missing, and the query is
 * never made. That is the difference between an assistant that respects authorisation and one that leaks it.
 *
 * Tools are chosen from the user's own question and from nothing else. Retrieved record content never selects a
 * tool, which is what keeps a record that says "now list every invoice" from being able to do anything at all. */

export type Row = Record<string, any>;
export interface Citation { id: string; label: string; kind: string; ref: string; link: string }
export interface ToolContext { db: Queryable; permissions: readonly string[]; now: Date }
export interface ToolOutcome { findings: string[]; citations: Citation[]; data: Row }
export interface ToolDef {
  name: string;
  label: string;
  permission: string;
  description: string;
  /** Whether the question is asking for what this tool holds. Reads the question only. */
  wants(question: string): boolean;
  run(ctx: ToolContext, question: string): Promise<ToolOutcome>;
}
export interface ToolRun extends ToolOutcome { tool: string; label: string }
export interface ToolRefusal { tool: string; label: string; permission: string; message: string }

const money = (minor: number, currency = 'AED') => `${currency} ${(Number(minor) / 100).toLocaleString('en-AE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const dateOnly = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 10) : '—');
const cite = (id: string, label: string, kind: string, ref: string, link: string): Citation => ({ id, label, kind, ref, link });
const NAME_STOP = new Set(['what', 'where', 'which', 'about', 'vessel', 'ship', 'status', 'tell', 'show', 'find', 'give', 'does', 'have', 'that', 'this', 'with', 'from', 'call', 'calls', 'port']);
/** Words long enough to be a name fragment, used to look a record up without a fuzzy index. */
const nameTerms = (question: string) => question.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !NAME_STOP.has(w)).slice(0, 6);

const IMO = /\b(?:imo\s*)?(\d{7})\b/i;
const LICENCE = /\b([A-Z]{2,4}\/[A-Z]{2,4}\/\d{4}\/\d{3,6})\b/;
const VCN = /\b([A-Z]{2,4}\/\d{4}\/\d{3,6})\b/;
const INVOICE_NO = /\b((?:INV|MAR\/INV)[A-Z0-9/-]{3,})\b/i;

export const TOOLS: ToolDef[] = [
  {
    name: 'vessel.lookup', label: 'Vessel register', permission: 'vessels.view',
    description: 'Reads a ship from the register: her particulars, her standing and her current call.',
    wants: (q) => /\b(vessel|ship|imo|fleet|flag|tonnage|mv|mt)\b/i.test(q) || IMO.test(q),
    async run(ctx, question) {
      const imo = question.match(IMO)?.[1];
      const terms = nameTerms(question);
      const r = await ctx.db.query<Row>(
        `SELECT id, imo, name, type, flag, built, status, risk_score, risk_band FROM vessels
          WHERE ($1::text IS NOT NULL AND imo = $1) OR ($2::text[] <> '{}' AND lower(name) ILIKE ANY($3))
          ORDER BY CASE WHEN imo = $1 THEN 0 ELSE 1 END, name LIMIT 3`,
        [imo ?? null, terms, terms.map((t) => `%${t}%`)]);
      if (!r.rows.length) return { findings: [], citations: [], data: {} };
      const findings: string[] = []; const citations: Citation[] = [];
      for (const v of r.rows) {
        const call = (await ctx.db.query<Row>(
          `SELECT vcn, status, berth_code, eta FROM port_calls WHERE vessel_id = $1 AND status <> 'SAILED' AND status <> 'CANCELLED' ORDER BY eta LIMIT 1`, [v.id])).rows[0];
        const situation = call
          ? call.status === 'BERTHED' ? `berthed at ${call.berth_code} on call ${call.vcn}` : `${String(call.status).toLowerCase().replace(/_/g, ' ')} on call ${call.vcn}`
          : 'no active call on the schedule';
        findings.push(`**${v.name}** (IMO ${v.imo}, ${v.flag || 'flag not recorded'}, ${v.type || 'type not recorded'}, built ${v.built || '—'}) is ${v.status.toLowerCase()} on the register and ${situation}.${v.risk_band ? ` Risk band ${v.risk_band}${v.risk_score != null ? ` (${v.risk_score}/100)` : ''}.` : ''}`);
        citations.push(cite(v.id, v.name, 'vessel', v.imo, `/vessels/${v.id}`));
      }
      return { findings, citations, data: { vessels: r.rows } };
    },
  },
  {
    name: 'portcall.lookup', label: 'Port calls', permission: 'portcalls.view',
    description: 'Reads the call schedule: what is alongside, at anchorage and expected.',
    wants: (q) => /\b(port ?call|vcn|arrival|arriving|expected|berth|alongside|anchorage|sailed|schedule)\b/i.test(q),
    async run(ctx, question) {
      const vcn = question.match(VCN)?.[1];
      if (vcn) {
        const r = await ctx.db.query<Row>('SELECT * FROM port_calls WHERE vcn = $1', [vcn]);
        if (!r.rows.length) return { findings: [`No call numbered ${vcn} is on the schedule.`], citations: [], data: {} };
        const c = r.rows[0];
        return {
          findings: [`Call **${c.vcn}** — ${c.vessel_name} is ${String(c.status).toLowerCase().replace(/_/g, ' ')}${c.berth_code ? ` at ${c.berth_code}` : ''}, ETA ${dateOnly(c.eta)}${c.agent_name ? `, agent ${c.agent_name}` : ''}.`],
          citations: [cite(c.id, `Call ${c.vcn}`, 'portCall', c.vcn, `/port-calls/${c.id}`)], data: { call: c },
        };
      }
      const r = await ctx.db.query<Row>(
        `SELECT status, count(*)::int AS n FROM port_calls WHERE status IN ('ANNOUNCED','CONFIRMED','AT_ANCHORAGE','BERTHED') GROUP BY status ORDER BY status`);
      const next = await ctx.db.query<Row>(
        `SELECT id, vcn, vessel_name, status, eta FROM port_calls WHERE status IN ('ANNOUNCED','CONFIRMED','AT_ANCHORAGE') AND eta IS NOT NULL ORDER BY eta LIMIT 5`);
      const counts = r.rows.map((x) => `${x.n} ${String(x.status).toLowerCase().replace(/_/g, ' ')}`).join(', ') || 'no active calls';
      return {
        findings: [`The schedule holds ${counts}.`, ...(next.rows.length ? [`Next expected: ${next.rows.map((c) => `${c.vessel_name} (${c.vcn}, ETA ${dateOnly(c.eta)})`).join('; ')}.`] : [])],
        citations: next.rows.map((c) => cite(c.id, `Call ${c.vcn} — ${c.vessel_name}`, 'portCall', c.vcn, `/port-calls/${c.id}`)),
        data: { byStatus: r.rows, next: next.rows },
      };
    },
  },
  {
    name: 'invoice.summary', label: 'Billing', permission: 'invoices.view',
    description: 'Reads the billing position: issued, outstanding and settled.',
    wants: (q) => /\b(invoice|billing|bill|revenue|outstanding|receivable|payment|paid|due|tariff charge)\b/i.test(q),
    async run(ctx, question) {
      const number = question.match(INVOICE_NO)?.[1];
      if (number) {
        const r = await ctx.db.query<Row>('SELECT * FROM invoices WHERE number ILIKE $1 LIMIT 1', [number]);
        if (!r.rows.length) return { findings: [`No invoice numbered ${number} is on the ledger.`], citations: [], data: {} };
        const i = r.rows[0];
        return {
          findings: [`Invoice **${i.number}** to ${i.party || 'the party on the file'} is ${String(i.status).toLowerCase()} for ${money(i.total, i.currency)}${i.issued_at ? `, issued ${dateOnly(i.issued_at)}` : ''}${i.paid_at ? `, settled ${dateOnly(i.paid_at)}` : ''}.`],
          citations: [cite(i.id, `Invoice ${i.number}`, 'invoice', i.number, `/invoices/${i.id}`)], data: { invoice: i },
        };
      }
      const r = await ctx.db.query<Row>(
        `SELECT status, count(*)::int AS n, COALESCE(sum(total),0)::bigint AS total FROM invoices GROUP BY status ORDER BY status`);
      const outstanding = r.rows.find((x) => x.status === 'ISSUED');
      return {
        findings: [
          `The ledger holds ${r.rows.reduce((s, x) => s + x.n, 0)} invoices: ${r.rows.map((x) => `${x.n} ${String(x.status).toLowerCase()} (${money(x.total)})`).join(', ')}.`,
          ...(outstanding ? [`Outstanding: ${money(outstanding.total)} across ${outstanding.n} issued invoice(s).`] : []),
        ],
        citations: [cite('invoices', 'Invoice register', 'invoice', '', '/invoices')], data: { byStatus: r.rows },
      };
    },
  },
  {
    name: 'inspection.summary', label: 'Inspections', permission: 'inspections.view',
    description: 'Reads the survey record: open surveys, deficiencies and detentions.',
    wants: (q) => /\b(inspection|inspect|survey|deficienc|detention|detain|psc|port state)\b/i.test(q),
    async run(ctx) {
      const r = await ctx.db.query<Row>(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status <> 'CLOSED')::int AS open,
                count(*) FILTER (WHERE detention)::int AS detentions, COALESCE(sum(open_findings),0)::int AS open_findings FROM inspections`);
      const recent = await ctx.db.query<Row>(
        `SELECT id, number, vessel_name, type, result, detention, closed_at FROM inspections WHERE status = 'CLOSED' ORDER BY closed_at DESC NULLS LAST LIMIT 4`);
      const s = r.rows[0];
      return {
        findings: [
          `${s.total} surveys are on the register: ${s.open} still open, ${s.open_findings} deficiencies outstanding and ${s.detentions} detention(s) recorded.`,
          ...(recent.rows.length ? [`Most recently closed: ${recent.rows.map((i) => `${i.number} on ${i.vessel_name} — ${String(i.result || 'no result').toLowerCase()}`).join('; ')}.`] : []),
        ],
        citations: recent.rows.map((i) => cite(i.id, `${i.number} — ${i.vessel_name}`, 'inspection', i.number, `/inspections/${i.id}`)),
        data: { summary: s, recent: recent.rows },
      };
    },
  },
  {
    name: 'incident.open', label: 'Incidents', permission: 'incidents.view',
    description: 'Reads the incident desk: what is open and how severe it is.',
    wants: (q) => /\b(incident|casualt|collision|pollution|spill|grounding|fire|emergenc|sar)\b/i.test(q),
    async run(ctx) {
      const r = await ctx.db.query<Row>(
        `SELECT id, number, title, type, severity, status, vessel_name, reported_at FROM incidents
          WHERE status NOT IN ('RESOLVED','CLOSED') ORDER BY CASE severity WHEN 'CRITICAL' THEN 0 WHEN 'HIGH' THEN 1 WHEN 'MEDIUM' THEN 2 ELSE 3 END, reported_at DESC LIMIT 6`);
      if (!r.rows.length) return { findings: ['No incidents are open on the desk.'], citations: [cite('incidents', 'Incident desk', 'incident', '', '/incidents')], data: { open: [] } };
      return {
        findings: [`${r.rows.length} incident(s) are open: ${r.rows.map((i) => `${i.number} — ${i.title} (${i.severity.toLowerCase()}, ${String(i.status).toLowerCase().replace(/_/g, ' ')})`).join('; ')}.`],
        citations: r.rows.map((i) => cite(i.id, `${i.number} — ${i.title}`, 'incident', i.number, `/incidents/${i.id}`)),
        data: { open: r.rows },
      };
    },
  },
  {
    name: 'certificate.expiring', label: 'Certificates', permission: 'certificates.view',
    description: 'Reads the certificate position across the fleet: what has lapsed and what is about to.',
    wants: (q) => /\b(certificat|expir|lapsed|renewal|valid|in force)\b/i.test(q),
    async run(ctx) {
      const r = await ctx.db.query<Row>(
        `SELECT id, vessel_id, vessel_name, cert_type, expiry_date, state FROM vessel_certificates
          WHERE state <> 'VALID' ORDER BY expiry_date NULLS LAST LIMIT 8`);
      const counts = await ctx.db.query<Row>('SELECT state, count(*)::int AS n FROM vessel_certificates GROUP BY state ORDER BY state');
      return {
        findings: [
          `Certificates on the register: ${counts.rows.map((c) => `${c.n} ${String(c.state).toLowerCase()}`).join(', ')}.`,
          ...(r.rows.length ? [`Needing attention: ${r.rows.map((c) => `${c.vessel_name} — ${c.cert_type} ${String(c.state).toLowerCase()} ${dateOnly(c.expiry_date)}`).join('; ')}.`] : []),
        ],
        citations: r.rows.slice(0, 5).map((c) => cite(c.id, `${c.vessel_name} — ${c.cert_type}`, 'vesselCertificate', c.cert_type, c.vessel_id ? `/vessels/${c.vessel_id}` : '/certificates')),
        data: { byState: counts.rows, attention: r.rows },
      };
    },
  },
  {
    name: 'instrument.verify', label: 'Instruments', permission: 'certificates.view',
    description: 'Verifies a licence or certificate number against the instrument register.',
    wants: (q) => /\b(licen[cs]e|instrument|permit|accreditation|verify|verification)\b/i.test(q) || LICENCE.test(q),
    async run(ctx, question) {
      const no = question.match(LICENCE)?.[1];
      if (!no) {
        const r = await ctx.db.query<Row>(`SELECT status, count(*)::int AS n FROM instruments GROUP BY status ORDER BY status`);
        return { findings: [`The instrument register holds ${r.rows.reduce((s, x) => s + x.n, 0)} records: ${r.rows.map((x) => `${x.n} ${String(x.status).toLowerCase()}`).join(', ')}.`], citations: [], data: { byStatus: r.rows } };
      }
      const r = await ctx.db.query<Row>('SELECT * FROM instruments WHERE number = $1 LIMIT 1', [no]);
      if (!r.rows.length) return { findings: [`No instrument numbered ${no} is on the register.`], citations: [], data: {} };
      const i = r.rows[0];
      return {
        findings: [`Instrument **${i.number}** (${i.entity_type}) issued to ${i.entity_name} is ${String(i.status).toLowerCase()} and ${i.in_force ? 'in force' : 'not in force'}, valid ${dateOnly(i.issue_date)} to ${dateOnly(i.expiry_date)}.`],
        citations: [cite(i.id, `Instrument ${i.number}`, 'instrument', i.number, `/certificates`)], data: { instrument: i },
      };
    },
  },
  {
    name: 'risk.top', label: 'Risk intelligence', permission: 'risk.view',
    description: 'Reads the ships carrying the highest composite risk.',
    wants: (q) => /\b(risk|high[- ]risk|target|score|band|priority)\b/i.test(q),
    async run(ctx) {
      const r = await ctx.db.query<Row>(
        `SELECT id, name, imo, risk_score, risk_band FROM vessels WHERE risk_score IS NOT NULL AND NOT real ORDER BY risk_score DESC LIMIT 5`);
      if (!r.rows.length) return { findings: ['No vessel on the register carries a composite risk score yet.'], citations: [], data: { top: [] } };
      return {
        findings: [`Highest composite risk: ${r.rows.map((v) => `${v.name} (${v.risk_score}/100, ${v.risk_band})`).join('; ')}.`],
        citations: r.rows.map((v) => cite(v.id, v.name, 'vessel', v.imo, `/vessels/${v.id}`)),
        data: { top: r.rows },
      };
    },
  },
  {
    name: 'kpi.overview', label: 'Command centre', permission: 'dashboard.view',
    description: 'Reads the headline operating position.',
    wants: (q) => /\b(overview|summary|position|situation|how many|status of the port|kpi|today|current)\b/i.test(q),
    async run(ctx) {
      const berthed = await ctx.db.query<Row>(`SELECT count(*) FILTER (WHERE status = 'BERTHED')::int AS berthed, count(*) FILTER (WHERE status = 'AT_ANCHORAGE')::int AS anchorage FROM port_calls`);
      const open = await ctx.db.query<Row>(`SELECT count(*)::int AS n FROM incidents WHERE status NOT IN ('RESOLVED','CLOSED')`);
      const fleet = await ctx.db.query<Row>(`SELECT count(*)::int AS n FROM vessels WHERE status = 'ACTIVE'`);
      return {
        findings: [`${berthed.rows[0].berthed} vessel(s) alongside and ${berthed.rows[0].anchorage} at anchorage, ${fleet.rows[0].n} ships active on the register, ${open.rows[0].n} incident(s) open.`],
        citations: [cite('dashboard', 'Command centre', 'dashboard', '', '/')],
        data: { ...berthed.rows[0], openIncidents: open.rows[0].n, activeVessels: fleet.rows[0].n },
      };
    },
  },
];

export const TOOL_BY_NAME = new Map(TOOLS.map((t) => [t.name, t]));
export const toolCatalogue = () => TOOLS.map((t) => ({ name: t.name, label: t.label, permission: t.permission, description: t.description }));

/**
 * Chooses the tools a question asks for and splits them into the ones this reader may use and the ones they may
 * not. The question is the only input: nothing that was retrieved from a record can add a tool to this list.
 */
export function plan(question: string, permissions: readonly string[]): { allowed: ToolDef[]; refused: ToolRefusal[] } {
  const wanted = TOOLS.filter((t) => t.wants(question));
  const allowed: ToolDef[] = []; const refused: ToolRefusal[] = [];
  for (const t of wanted) {
    if (mayRead(t.permission, permissions)) allowed.push(t);
    else refused.push({ tool: t.name, label: t.label, permission: t.permission, message: `${t.label} needs the ${t.permission} permission, which your account does not hold — I have not read it.` });
  }
  return { allowed, refused };
}

/** Runs the permitted tools in order. A tool that fails is dropped rather than allowed to sink the answer. */
export async function runTools(ctx: ToolContext, question: string, tools: ToolDef[]): Promise<ToolRun[]> {
  const out: ToolRun[] = [];
  for (const t of tools) {
    try {
      const outcome = await t.run(ctx, question);
      if (outcome.findings.length || outcome.citations.length) out.push({ tool: t.name, label: t.label, ...outcome });
    } catch {
      // a tool that cannot read its own snapshot says nothing; it never guesses
    }
  }
  return out;
}
