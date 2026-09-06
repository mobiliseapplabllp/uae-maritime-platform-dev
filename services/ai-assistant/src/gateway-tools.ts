import type { Citation, ToolContext, ToolDef, ToolOutcome } from './tools';

/* The tool surface in gateway mode: the only way the assistant reads a record is a call to the tool gateway,
 * made as the person asking, with their own token. The gateway checks the caller, the tool and the person's
 * permission before it touches a service, logs every call, and the service checks the permission again. What
 * comes back is the platform's own API shape, which each tool here turns into findings a reader can use and
 * citations that open the record.
 *
 * Tools are still chosen from the question alone. Nothing retrieved can add a tool to the plan. */

type Row = Record<string, any>;
const cite = (id: string, label: string, kind: string, ref: string, link: string): Citation => ({ id, label, kind, ref, link });
const dateOnly = (v: unknown) => (v ? String(v).slice(0, 10) : '—');
const num = (v: unknown, digits = 0) => (v == null || v === '' || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('en-AE', { maximumFractionDigits: digits, minimumFractionDigits: digits }));
const money = (v: unknown, currency = 'AED') => `${currency} ${num(v)}`;
const lower = (v: unknown) => String(v ?? '').toLowerCase().replace(/_/g, ' ');
const NAME_STOP = new Set(['what', 'where', 'which', 'about', 'vessel', 'vessels', 'ship', 'ships', 'status', 'tell', 'show', 'find', 'give', 'does', 'have', 'that', 'this', 'with', 'from', 'call', 'calls', 'port', 'company', 'companies', 'notice', 'notices', 'circular', 'seafarer', 'crew', 'application', 'applications', 'when', 'many', 'list', 'open', 'latest', 'recent',
  'invoice', 'invoices', 'overdue', 'outstanding', 'certificate', 'certificates', 'expiring', 'expired', 'inspection', 'inspections', 'incident', 'incidents', 'licence', 'license', 'permit', 'risk', 'berth', 'berthed', 'arrival', 'arrivals', 'expected', 'schedule', 'today', 'there', 'their', 'please', 'could', 'would', 'should', 'currently', 'being', 'been']);
/** The words a name is likely made of: a run of capitalised words first (a ship, a company, a person); otherwise the longer words the stop list does not claim. */
const nameTerms = (question: string) => {
  const proper = question.replace(/[?!.,;:]/g, ' ').split(/\s+/).filter(Boolean);
  const runs: string[][] = []; let run: string[] = [];
  proper.forEach((w, i) => { const cap = /^[A-Z][A-Za-z0-9'-]*$/.test(w) && !(i === 0 && NAME_STOP.has(w.toLowerCase())) && !NAME_STOP.has(w.toLowerCase()); if (cap) run.push(w); else { if (run.length) runs.push(run); run = []; } });
  if (run.length) runs.push(run);
  const best = runs.sort((a, b) => b.length - a.length)[0];
  if (best && best.join('').length > 3) return best.map((w) => w.toLowerCase()).slice(0, 4);
  return question.toLowerCase().split(/[^a-z0-9؀-ۿ]+/).filter((w) => w.length > 3 && !NAME_STOP.has(w)).slice(0, 4);
};
const IMO = /\b(?:imo\s*)?(\d{7})\b/i;
const VCN = /\b([A-Z]{2,4}[-/]\d{4}[-/]\d{3,6})\b/;
const INVOICE_NO = /\b((?:MAR\/)?INV[\/-]\d{4}[\/-]\d{3,6}|INV-?\d{4,})\b/i;
const LICENCE = /\b([A-Z]{2,5}(?:-[A-Z0-9]{2,6}){1,3}-\d{3,6})\b/;
const APPLICATION = /\b(SR-\d{4}-\d{4,6})\b/i;
const NONE: ToolOutcome = { findings: [], citations: [], data: {} };

type Outcome = { ok: true; data: any; items: Row[]; meta?: Row } | { ok: false; reason: string; code?: string };
/** One call through the gateway. A refusal or a failure is an answer too: it comes back as a reason, never as an exception. */
async function call(ctx: ToolContext, tool: string, args: Record<string, unknown> = {}): Promise<Outcome> {
  if (!ctx.gateway) return { ok: false, reason: 'the tool gateway is not configured' };
  try {
    const r = await ctx.gateway.run('assistant', tool, args, { userToken: ctx.userToken, cause: 'assistant' });
    if (r.outcome !== 'OK') return { ok: false, reason: r.reason ?? r.outcome, code: r.code };
    const data = r.data as any;
    const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    return { ok: true, data, items, meta: data?.meta };
  } catch (err) { return { ok: false, reason: (err as Error).message }; }
}
const unavailable = (label: string, r: { reason: string }): ToolOutcome => ({ findings: [`${label} could not be read through the tool gateway (${r.reason}).`], citations: [], data: {} });

export const GATEWAY_TOOLS: ToolDef[] = [
  {
    name: 'vessel.lookup', label: 'Vessel register', permission: 'vessels.view',
    description: 'Reads a ship from the register through the gateway: her particulars, her standing and her current call.',
    wants: (q) => /\b(vessels?|ships?|imo|fleet|flag|tonnage|mv|mt)\b/i.test(q) || IMO.test(q),
    async run(ctx, question) {
      const imo = question.match(IMO)?.[1]; const terms = nameTerms(question);
      if (!imo && !terms.length) return NONE;
      const r = await call(ctx, 'ships.search', { q: imo ?? terms.join(' '), limit: 3 });
      if (!r.ok) return unavailable('The vessel register', r);
      const findings: string[] = []; const citations: Citation[] = [];
      for (const v of r.items.slice(0, 3)) {
        let situation = 'no active call on the schedule';
        const c = await call(ctx, 'ops.port_calls', { vessel: v.imo ?? v.name, active: 'true', limit: 1 });
        const pc = c.ok ? c.items[0] : undefined;
        if (pc) situation = pc.status === 'BERTHED' ? `berthed at ${pc.berthCode ?? 'a berth'} on call ${pc.vcn}` : `${lower(pc.status)} on call ${pc.vcn}${pc.eta ? ` (ETA ${dateOnly(pc.eta)})` : ''}`;
        findings.push(`**${v.name}** (IMO ${v.imo}, ${v.flag || 'flag not recorded'}, ${v.type || 'type not recorded'}, built ${v.built || '—'}) is ${lower(v.status || 'on the register')} and ${situation}.${v.riskBand ? ` Risk band ${v.riskBand}${v.riskScore != null ? ` (${v.riskScore}/100)` : ''}.` : ''}`);
        citations.push(cite(v.id, v.name, 'vessel', String(v.imo ?? ''), `/vessels/${v.id}`));
      }
      return { findings, citations, data: { vessels: r.items } };
    },
  },
  {
    name: 'portcall.lookup', label: 'Port calls', permission: 'portcalls.view',
    description: 'Reads the call schedule through the gateway: what is alongside, at anchorage and expected.',
    wants: (q) => /\b(port ?calls?|vcn|arrivals?|arriving|expected|berths?|berthed|alongside|anchorage|sailed|schedule|waiting|busy|harbour)\b/i.test(q),
    async run(ctx, question) {
      const vcn = question.match(VCN)?.[1];
      if (vcn) {
        const r = await call(ctx, 'ops.port_calls', { q: vcn, limit: 1 });
        if (!r.ok) return unavailable('The call schedule', r);
        const c = r.items[0];
        if (!c) return { findings: [`No call numbered ${vcn} is on the schedule.`], citations: [], data: {} };
        return { findings: [`Call **${c.vcn}** — ${c.vesselName} is ${lower(c.status)}${c.berthCode ? ` at ${c.berthCode}` : ''}, ETA ${dateOnly(c.eta)}${c.agentName ? `, agent ${c.agentName}` : ''}.`], citations: [cite(c.id, `Call ${c.vcn}`, 'portCall', c.vcn, `/port-calls/${c.id}`)], data: { call: c } };
      }
      const d = await call(ctx, 'ops.dashboard');
      if (!d.ok) return unavailable('The harbour dashboard', d);
      const k = d.data?.kpis ?? {}; const arrivals: Row[] = Array.isArray(d.data?.arrivals) ? d.data.arrivals.slice(0, 5) : [];
      return {
        findings: [
          `The harbour holds ${num(k.inPort)} vessel(s) in port and ${num(k.atAnchorage)} at anchorage, with ${num(k.expected72h)} expected in the next 72 hours; berth occupancy ${num(k.berthOccupancyPct)}%, average waiting ${num(k.avgWaitingHrs, 1)} h and turnaround ${num(k.avgTurnaroundHrs, 1)} h over 30 days.`,
          ...(arrivals.length ? [`Next expected: ${arrivals.map((c) => `${c.vesselName ?? c.vessel ?? '—'} (${c.vcn ?? '—'}, ETA ${dateOnly(c.eta)})`).join('; ')}.`] : []),
        ],
        citations: [cite('ops-dashboard', 'Harbour dashboard', 'dashboard', '', '/ops/overview'), ...arrivals.filter((c) => c.id).map((c) => cite(c.id, `Call ${c.vcn} — ${c.vesselName ?? ''}`, 'portCall', c.vcn ?? '', `/port-calls/${c.id}`))],
        data: { kpis: k, arrivals },
      };
    },
  },
  {
    name: 'invoice.summary', label: 'Billing', permission: 'invoices.view',
    description: 'Reads the receivables position through the gateway: billed, collected, outstanding and overdue.',
    wants: (q) => /\b(invoices?|billing|bills?|revenue|outstanding|receivables?|payments?|paid|due|overdue|dso|tariff charge)\b/i.test(q),
    async run(ctx, question) {
      const number = question.match(INVOICE_NO)?.[1];
      if (number) {
        const r = await call(ctx, 'finance.invoices', { q: number, limit: 1 });
        if (!r.ok) return unavailable('The invoice register', r);
        const i = r.items[0];
        if (!i) return { findings: [`No invoice numbered ${number} is on the ledger.`], citations: [], data: {} };
        return { findings: [`Invoice **${i.number}** to ${i.billTo?.name ?? 'the party on the file'} is ${lower(i.status)} for ${money(i.total, i.currency)}${i.issuedAt ? `, issued ${dateOnly(i.issuedAt)}` : ''}${i.dueAt ? `, due ${dateOnly(i.dueAt)}` : ''}${i.paidAt ? `, settled ${dateOnly(i.paidAt)}` : ''}.`], citations: [cite(i.id, `Invoice ${i.number}`, 'invoice', i.number, `/invoices/${i.id}`)], data: { invoice: i } };
      }
      const d = await call(ctx, 'finance.dashboard');
      if (!d.ok) return unavailable('The receivables dashboard', d);
      const k = d.data?.kpis ?? {}; const cur = d.data?.currency ?? 'AED';
      return {
        findings: [
          `Receivables: ${money(k.outstanding, cur)} outstanding across ${num(k.openInvoices)} open invoice(s), of which ${money(k.overdueAmount, cur)} on ${num(k.overdueCount)} overdue; days sales outstanding ${num(k.dsoDays, 1)} and collection effectiveness ${num(k.ceiPct)}%.`,
          `Billed ${money(k.billedMtd, cur)} and collected ${money(k.collectedMtd, cur)} so far this month; ${num(k.remindersDue)} reminder(s) due.`,
        ],
        citations: [cite('invoices', 'Receivables dashboard', 'dashboard', '', '/invoices/overview')], data: { kpis: k },
      };
    },
  },
  {
    name: 'inspection.summary', label: 'Inspections', permission: 'inspections.view',
    description: 'Reads the inspection record through the gateway: open surveys, deficiencies and detentions.',
    wants: (q) => /\b(inspections?|inspect\w*|surveys?|deficienc\w*|detentions?|detained|psc|port state)\b/i.test(q),
    async run(ctx) {
      const d = await call(ctx, 'inspect.dashboard');
      if (!d.ok) return unavailable('The inspection dashboard', d);
      const k = d.data?.kpis ?? {};
      const recent = await call(ctx, 'inspect.list', { limit: 4 });
      const rows = recent.ok ? recent.items : [];
      return {
        findings: [
          `${num(k.open)} inspection(s) are open and ${num(k.closedYtd)} closed this year; ${num(k.openFindings)} deficiencies outstanding, ${num(k.avgFindings, 1)} findings per inspection on average and a detention rate of ${num(k.detentionRatePct, 1)}%.`,
          ...(rows.length ? [`Most recent: ${rows.map((i) => `${i.number} on ${i.vesselName ?? i.subjectName ?? '—'} — ${lower(i.result || i.status)}`).join('; ')}.`] : []),
        ],
        citations: [cite('inspections', 'Inspection dashboard', 'dashboard', '', '/inspections/overview'), ...rows.map((i) => cite(i.id, `${i.number} — ${i.vesselName ?? i.subjectName ?? ''}`, 'inspection', i.number, `/inspections/${i.id}`))],
        data: { kpis: k, recent: rows },
      };
    },
  },
  {
    name: 'incident.open', label: 'Incidents', permission: 'incidents.view',
    description: 'Reads the incident desk through the gateway: what is open and how severe it is.',
    wants: (q) => /\b(incidents?|casualt\w*|collisions?|pollution|spills?|grounding|fire|emergenc\w*|sar)\b/i.test(q),
    async run(ctx) {
      const r = await call(ctx, 'incidents.list', { status: 'OPEN', limit: 6 });
      if (!r.ok) return unavailable('The incident desk', r);
      const d = await call(ctx, 'incidents.dashboard'); const k = d.ok ? d.data?.kpis ?? {} : {};
      if (!r.items.length) return { findings: ['No incidents are open on the desk.'], citations: [cite('incidents', 'Incident desk', 'incident', '', '/incidents')], data: { open: [] } };
      return {
        findings: [`${num(k.open ?? r.meta?.total ?? r.items.length)} incident(s) are open${k.highOpen != null ? `, ${num(k.highOpen)} of them high or critical` : ''}: ${r.items.map((i) => `${i.number} — ${i.title} (${lower(i.severity)}, ${lower(i.status)})`).join('; ')}.${k.mttrHrs != null ? ` Mean time to resolve ${num(k.mttrHrs, 1)} h.` : ''}`],
        citations: r.items.map((i) => cite(i.id, `${i.number} — ${i.title}`, 'incident', i.number, `/incidents/${i.id}`)),
        data: { open: r.items, kpis: k },
      };
    },
  },
  {
    name: 'certificate.expiring', label: 'Certificates', permission: 'certificates.view',
    description: 'Reads the certificate position across the fleet through the gateway: what has lapsed and what is about to.',
    wants: (q) => /\b(certificat\w*|expir\w*|lapsed|renewals?|valid\w*|in force)\b/i.test(q),
    async run(ctx) {
      const r = await call(ctx, 'ships.certificates', { expiringDays: 90 });
      if (!r.ok) return unavailable('The certificate register', r);
      const attention = r.items.filter((c) => c.status && c.status !== 'VALID').slice(0, 8);
      const byStatus: Record<string, number> = {}; for (const c of r.items) byStatus[c.status ?? 'UNKNOWN'] = (byStatus[c.status ?? 'UNKNOWN'] ?? 0) + 1;
      return {
        findings: [
          `Certificates expiring within 90 days or already lapsed: ${num(r.meta?.total ?? r.items.length)} (${Object.entries(byStatus).map(([s, n]) => `${n} ${lower(s)}`).join(', ')}).`,
          ...(attention.length ? [`Needing attention: ${attention.map((c) => `${c.vesselName} — ${c.certType} ${lower(c.status)} ${dateOnly(c.expiryDate)}`).join('; ')}.`] : []),
        ],
        citations: attention.slice(0, 5).map((c) => cite(c.certId ?? `${c.vesselId}-${c.certType}`, `${c.vesselName} — ${c.certType}`, 'vesselCertificate', c.number ?? c.certType, c.vesselId ? `/vessels/${c.vesselId}` : '/certificates')),
        data: { byStatus, attention },
      };
    },
  },
  {
    name: 'instrument.verify', label: 'Instruments', permission: 'facilities.view',
    description: 'Verifies a licence, permit or accreditation number against the instrument register through the gateway.',
    wants: (q) => /\b(licen[cs]es?|instruments?|permits?|accreditations?|verify|verification|noc)\b/i.test(q) || LICENCE.test(q),
    async run(ctx, question) {
      const no = question.match(LICENCE)?.[1];
      if (!no) {
        const r = await call(ctx, 'facil.licences_expiring', { days: 60 });
        if (!r.ok) return unavailable('The instrument register', r);
        const rows = r.items.slice(0, 5);
        return { findings: [`${num(r.meta?.total ?? r.items.length)} instrument(s) expire within 60 days${rows.length ? `: ${rows.map((i) => `${i.licenseNo ?? i.number} (${i.entityName ?? i.subjectName ?? '—'}, ${dateOnly(i.expiryDate)})`).join('; ')}` : ''}.`], citations: [cite('instruments', 'Licences and permits', 'instrument', '', '/companies/licences')], data: { expiring: rows } };
      }
      const r = await call(ctx, 'facil.licences', { q: no, limit: 1 });
      if (!r.ok) return unavailable('The instrument register', r);
      const i = r.items.find((x) => String(x.licenseNo ?? x.number ?? '').toUpperCase() === no.toUpperCase()) ?? r.items[0];
      if (!i) return { findings: [`No instrument numbered ${no} is on the register.`], citations: [], data: {} };
      return { findings: [`Instrument **${i.licenseNo ?? i.number}** (${i.typeLabel ?? i.entityType ?? i.instrumentClass}) issued to ${i.entityName ?? i.subjectName ?? '—'} is ${lower(i.status)}${i.inForce === false ? ' and not in force' : i.inForce ? ' and in force' : ''}, valid ${dateOnly(i.issueDate)} to ${dateOnly(i.expiryDate)}.`], citations: [cite(i.id, `Instrument ${i.licenseNo ?? i.number}`, 'instrument', String(i.licenseNo ?? i.number), '/companies/licences')], data: { instrument: i } };
    },
  },
  {
    name: 'risk.top', label: 'Risk intelligence', permission: 'risk.view',
    description: 'Reads the calls carrying the highest composite risk through the gateway.',
    wants: (q) => /\b(risks?|high[- ]risk|targets?|targeting|scores?|band|priority)\b/i.test(q),
    async run(ctx) {
      const r = await call(ctx, 'ships.risk_targeting');
      if (!r.ok) return unavailable('Risk targeting', r);
      const top = [...r.items].filter((x) => x.risk?.score != null).sort((a, b) => Number(b.risk.score) - Number(a.risk.score)).slice(0, 5);
      if (!top.length) return { findings: ['No call on the schedule carries a composite risk score yet.'], citations: [], data: { top: [] } };
      return {
        findings: [`Highest composite risk on the schedule: ${top.map((x) => `${x.vessel ?? x.risk.name} (${x.risk.score}/100, ${x.risk.band}, call ${x.vcn})`).join('; ')}.`],
        citations: top.map((x) => cite(x.vesselId ?? x.callId, x.vessel ?? x.risk.name, 'vessel', String(x.risk.imo ?? ''), x.vesselId ? `/vessels/${x.vesselId}` : '/risk')),
        data: { top },
      };
    },
  },
  {
    name: 'kpi.overview', label: 'Command centre', permission: 'dashboard.view',
    description: 'Reads every module\'s headline figures through the gateway.',
    wants: (q) => /\b(overview|summary|position|situation|how many|status of the port|kpi|today|current|headline|everything)\b/i.test(q),
    async run(ctx) {
      const r = await call(ctx, 'mis.module_strip');
      if (!r.ok) return unavailable('The Command Centre', r);
      const mods: Row[] = Array.isArray(r.data?.modules) ? r.data.modules : [];
      const fmt = (k: Row) => k.format === 'money' ? money(k.value) : k.format === 'hours' ? `${num(k.value, 1)} h` : k.format === 'pct' ? `${num(k.value)}%` : num(k.value);
      const LABEL: Record<string, string> = { ops: 'Harbour', ships: 'Fleet', crew: 'Crew', legis: 'Notices', incidents: 'Incidents', inspect: 'Inspections', facil: 'Companies', services: 'Service Desk', finance: 'Billing', mis: 'MIS', masters: 'Data Studio', agents: 'AI agents', admin: 'Administration' };
      return {
        findings: mods.filter((m) => Array.isArray(m.kpis) && m.kpis.length).map((m) => `${LABEL[m.key] ?? m.key}: ${m.kpis.map((k: Row) => `${k.label} ${fmt(k)}`).join(', ')}.`),
        citations: [cite('dashboard', 'Command centre', 'dashboard', '', '/')], data: { modules: mods },
      };
    },
  },
  {
    name: 'crew.overview', label: 'Crew', permission: 'seafarers.view',
    description: 'Reads the seafarer roll through the gateway, or one seafarer by name.',
    wants: (q) => /\b(seafarer|crew|master|chief engineer|officer on board|rank|coc|stcw|seaman|manning|sign[- ]?on|sign[- ]?off)\b/i.test(q),
    async run(ctx, question) {
      const terms = nameTerms(question.replace(/\b(seafarer|crew|master|chief|engineer|rank|manning)\b/gi, ''));
      if (terms.length) {
        const r = await call(ctx, 'crew.search', { q: terms.join(' '), limit: 3 });
        if (r.ok && r.items.length) return { findings: r.items.map((s) => `**${s.name}**, ${s.rank ?? '—'} (${s.nationality ?? '—'}), is ${lower(s.status ?? 'on the roll')}${s.currentVesselName ? ` on board ${s.currentVesselName}` : ''}.`), citations: r.items.map((s) => cite(s.id, s.name, 'seafarer', String(s.seafarerId ?? s.cdcNo ?? ''), `/seafarers/${s.id}`)), data: { seafarers: r.items } };
      }
      const d = await call(ctx, 'crew.dashboard');
      if (!d.ok) return unavailable('The crew dashboard', d);
      const k = d.data?.kpis ?? {};
      return { findings: [`The roll holds ${num(k.roll)} seafarers: ${num(k.onboard)} on board and ${num(k.ashore)} ashore, ${num(k.medicalIssues)} with a medical certificate issue.`], citations: [cite('crew', 'Crew dashboard', 'dashboard', '', '/seafarers/overview')], data: { kpis: k } };
    },
  },
  {
    name: 'notices.lookup', label: 'Notices and circulars', permission: 'legislation.view',
    description: 'Reads the register of instruments through the gateway: a notice by subject, or the register\'s standing.',
    wants: (q) => /\b(notices?|circulars?|regulations?|legislation|laws?|decrees?|resolutions?|requirements?|acknowledg\w*)\b/i.test(q),
    async run(ctx, question) {
      const terms = nameTerms(question.replace(/\b(notice|circular|regulation|legislation|instrument|requirement)s?\b/gi, ''));
      if (terms.length) {
        const r = await call(ctx, 'legis.instruments', { q: terms.join(' '), limit: 3 });
        if (r.ok && r.items.length) return { findings: r.items.map((n) => `**${n.refNo}** — ${n.title} (${lower(n.type)}, ${lower(n.status)}${n.issuedDate ? `, issued ${dateOnly(n.issuedDate)}` : ''}).${n.summary ? ` ${String(n.summary).slice(0, 200)}` : ''}`), citations: r.items.map((n) => cite(n.id, `${n.refNo} — ${n.title}`, 'legislation', n.refNo, `/legislation/${n.id}`)), data: { instruments: r.items } };
      }
      const d = await call(ctx, 'legis.dashboard');
      if (!d.ok) return unavailable('The register of instruments', d);
      const k = d.data?.kpis ?? {};
      return { findings: [`${num(k.inForce)} instrument(s) are in force and ${num(k.drafts)} in draft; ${num(k.ackRequired)} require acknowledgement, with ${num(k.ackOutstanding)} acknowledgement(s) outstanding (${num(k.ackCompliancePct)}% compliance).`], citations: [cite('legislation', 'Legislation dashboard', 'dashboard', '', '/legislation/overview')], data: { kpis: k } };
    },
  },
  {
    name: 'companies.lookup', label: 'Port companies', permission: 'facilities.view',
    description: 'Reads the company directory through the gateway: a company by name, or the directory\'s standing.',
    wants: (q) => /\b(compan(y|ies)|agents?|agenc(y|ies)|stevedor\w*|bunker\w*|chandlers?|operators?|licensees?|contractors?)\b/i.test(q),
    async run(ctx, question) {
      const terms = nameTerms(question.replace(/\b(compan(y|ies)|agents?|agency|operators?)\b/gi, ''));
      if (terms.length) {
        const r = await call(ctx, 'facil.companies', { q: terms.join(' '), limit: 3 });
        if (r.ok && r.items.length) return { findings: r.items.map((c) => `**${c.name}** (${lower(c.category)}, ${c.city ?? '—'}) is ${lower(c.status)}${Array.isArray(c.types) && c.types.length ? `; licensed for ${c.types.map(lower).join(', ')}` : ''}.`), citations: r.items.map((c) => cite(c.id, c.name, 'company', c.code ?? '', `/companies/${c.id}`)), data: { companies: r.items } };
      }
      const d = await call(ctx, 'facil.dashboard');
      if (!d.ok) return unavailable('The company directory', d);
      const k = d.data?.kpis ?? {};
      return { findings: [`${num(k.companies)} companies are on the directory: ${num(k.active)} active and ${num(k.suspended)} suspended; ${num(k.dueForRenewal)} licence(s) due for renewal and ${num(k.openObligations)} obligation(s) open; average rating ${num(k.averageRating, 1)}.`], citations: [cite('companies', 'Companies dashboard', 'dashboard', '', '/companies/overview')], data: { kpis: k } };
    },
  },
  {
    name: 'services.lookup', label: 'Service Desk', permission: 'services.view',
    description: 'Reads the Service Desk through the gateway: an application by number, or the desk\'s standing.',
    wants: (q) => /\b(applications?|service requests?|service desk|sla|backlog|breached|apply|applicants?)\b/i.test(q) || APPLICATION.test(q),
    async run(ctx, question) {
      const no = question.match(APPLICATION)?.[1];
      if (no) {
        const r = await call(ctx, 'services.applications', { q: no, limit: 1 });
        if (!r.ok) return unavailable('The Service Desk', r);
        const a = r.items[0];
        if (!a) return { findings: [`No application numbered ${no} is on the desk.`], citations: [], data: {} };
        return { findings: [`Application **${a.number}** — ${a.definitionName} for ${a.subjectName ?? a.subjectKind ?? 'the subject on file'} is ${lower(a.status)}${a.assignedTo ? `, with ${a.assignedTo}` : ''}${a.dueAt ? `, due ${dateOnly(a.dueAt)}` : ''}.`], citations: [cite(a.id, `Application ${a.number}`, 'serviceRequest', a.number, `/services/requests/${a.id}`)], data: { application: a } };
      }
      const d = await call(ctx, 'services.dashboard');
      if (!d.ok) return unavailable('The Service Desk dashboard', d);
      const x = d.data ?? {}; const desk = x.desk ?? {};
      return { findings: [`The Service Desk holds ${num(x.open)} open application(s), ${num(x.breached)} past their service level; ${num(x.slaCompliance ?? desk.withinSlaPct90d)}% decided within the service level and ${num(x.avgDecisionDays ?? desk.avgDecisionDays90d, 1)} days to a decision on average.`], citations: [cite('services', 'Service Desk dashboard', 'dashboard', '', '/services/overview')], data: { kpis: { open: x.open, breached: x.breached, slaCompliance: x.slaCompliance, avgDecisionDays: x.avgDecisionDays } } };
    },
  },
  {
    name: 'admin.overview', label: 'Administration', permission: 'users.view',
    description: 'Reads the access posture through the gateway: accounts, second-factor coverage, dormancy, approvals.',
    wants: (q) => /\b(user accounts?|accounts|mfa|second factor|two[- ]step|dormant|privileged|access review|approvals? pending|four eyes)\b/i.test(q),
    async run(ctx) {
      const d = await call(ctx, 'admin.dashboard');
      if (!d.ok) return unavailable('The access posture', d);
      const k = d.data?.kpis ?? {};
      return { findings: [`${num(k.users)} accounts, ${num(k.active)} active; second-factor coverage ${num(k.mfaCoveragePct)}% of those required, ${num(k.privilegedWithoutMfa)} privileged account(s) without one; ${num(k.dormant)} dormant against the ${num(k.dormantDays)}-day rule and ${num(k.changesPending)} change(s) awaiting a second person.`], citations: [cite('admin', 'Access posture', 'dashboard', '', '/admin/overview')], data: { kpis: k } };
    },
  },
  {
    name: 'masters.quality', label: 'Data Studio', permission: 'masters.view',
    description: 'Reads master-data quality through the gateway.',
    wants: (q) => /\b(data quality|master data|masters|duplicates?|golden record|reference data|completeness)\b/i.test(q),
    async run(ctx) {
      const d = await call(ctx, 'masters.dashboard');
      if (!d.ok) return unavailable('Data Studio', d);
      const k = d.data?.kpis ?? {};
      return { findings: [`Master data scores ${num(k.qualityScore)}/100 (grade ${k.grade ?? '—'}): ${num(k.masters)} masters with ${num(k.entries)} entries, ${num(k.arabicPct)}% bilingual, ${num(k.duplicates)} duplicate(s) and ${num(k.invalid)} invalid; golden vessels ${num(k.vesselCompletenessPct)}% and companies ${num(k.companyCompletenessPct)}% complete.`], citations: [cite('masters', 'Data Studio dashboard', 'dashboard', '', '/masters/overview')], data: { kpis: k } };
    },
  },
  {
    name: 'platform.health', label: 'Platform', permission: 'platform.view',
    description: 'Reads the platform\'s standing through the gateway: services up, targets, open platform incidents.',
    wants: (q) => /\b(platform (status|health)|services? (up|down)|uptime|is the platform|outage|availability)\b/i.test(q),
    async run(ctx) {
      const d = await call(ctx, 'platform.status');
      if (!d.ok) return unavailable('Platform status', d);
      const s = d.data?.summary ?? {};
      return { findings: [`The platform is ${lower(s.status ?? 'unknown')}: ${num(s.servicesUp)} of ${num(s.services)} services up, ${num(s.targetsUp)} of ${num(s.targets)} monitored targets reachable, ${num(s.openIncidents)} platform incident(s) open.`], citations: [cite('platform', 'Platform status', 'dashboard', '', '/platform')], data: { summary: s } };
    },
  },
  {
    name: 'nmc.where', label: 'Live traffic', permission: 'nmc.view',
    description: 'Finds a vessel in the live traffic picture through the gateway.',
    wants: (q) => /\b(where is|position of|track|live traffic|ais|underway|at anchor|heading|speed)\b/i.test(q),
    async run(ctx, question) {
      const imo = question.match(IMO)?.[1]; const terms = nameTerms(question.replace(/\b(where|position|track|live|traffic|heading|speed)\b/gi, ''));
      const q = imo ?? terms.join(' ');
      if (!q) return NONE;
      const r = await call(ctx, 'nmc.targets', { q });
      if (!r.ok) return unavailable('Live traffic', r);
      const rows = r.items.slice(0, 3);
      if (!rows.length) return { findings: [`No target matching "${q}" is in the live picture.`], citations: [], data: {} };
      return { findings: rows.map((t) => `**${t.name}** (MMSI ${t.mmsi}${t.imo ? `, IMO ${t.imo}` : ''}) is ${lower(t.navStatus ?? 'underway')} at ${num(t.lat, 3)}, ${num(t.lon, 3)}, ${num(t.sog, 1)} kn${t.destination ? `, bound for ${t.destination}` : ''}; position ${num(t.ageMinutes)} minute(s) old.`), citations: rows.map((t) => cite(String(t.mmsi), t.name, 'target', String(t.mmsi), '/traffic')), data: { targets: rows } };
    },
  },
];
