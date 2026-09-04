import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { Pool } from 'pg';
import { CurrentUser, KIT_POOL, RequirePerm, notFound, type Principal } from '@maritime/service-kit';
import { CARGO_GROUP, many, monthKey, monthLabel, profile } from './queries';
import {
  BERTH_SCOPE, CALL_SCOPE, CERTIFICATE_SCOPE, INCIDENT_SCOPE, INSPECTION_SCOPE, INSTRUMENT_SCOPE,
  INVOICE_SCOPE, LEGISLATION_SCOPE, SEAFARER_SCOPE, TARIFF_SCOPE, USER_SCOPE, VESSEL_SCOPE, from,
} from './scope';

/** MIS report (monthly traffic, cargo, revenue, compliance) and the report library (catalogue of saved reports run over the read models). */
interface ReportDef { key: string; name: string; name_ar: string | null; category: string; description: string; perm: string; params: { name: string; label: string; type: string; default?: unknown }[]; columns: { key: string; label: string; align?: string }[]; query_key: string }
/** A report runs over the read models, so like every other reporting surface it runs as somebody. */
type Runner = (pool: Pool, params: Record<string, string>, user: Principal) => Promise<Record<string, unknown>[]>;
const months = (n: number) => { const now = new Date(); return Array.from({ length: n }, (_, i) => { const d = new Date(now.getFullYear(), now.getMonth() - (n - 1 - i), 1); return { key: monthKey(d), label: monthLabel(d), start: d }; }); };

export const RUNNERS: Record<string, Runner> = {
  portCallsByMonth: async (pool, p, user) => many(pool, `SELECT to_char(date_trunc('month', COALESCE(atd, eta)), 'YYYY-MM') AS month, count(*) AS calls, count(*) FILTER (WHERE status = 'SAILED') AS sailed, round(avg(EXTRACT(EPOCH FROM (atd - ata)) / 3600) FILTER (WHERE atd IS NOT NULL AND ata IS NOT NULL)::numeric, 1) AS avg_turnaround_h, sum(cargo_mt) AS cargo_mt, sum(teu) AS teu FROM ${from(user, 'rm_port_calls', CALL_SCOPE)} WHERE COALESCE(atd, eta) >= now() - ($1 || ' months')::interval GROUP BY 1 ORDER BY 1`, [p.months || '12']),
  cargoByCommodity: async (pool, p, user) => many(pool, `SELECT o->>'cargoType' AS commodity, sum((o->>'qtyMT')::numeric) AS cargo_mt, count(*) AS operations FROM ${from(user, 'rm_port_calls', CALL_SCOPE)}, jsonb_array_elements(cargo_ops) o WHERE status = 'SAILED' AND atd >= now() - ($1 || ' months')::interval GROUP BY 1 ORDER BY 2 DESC`, [p.months || '12']),
  berthOccupancy: async (pool, _p, user) => many(pool, `SELECT b.code, b.terminal, b.berth_type, count(c.id) AS calls_12m, round(COALESCE(sum(EXTRACT(EPOCH FROM (c.atd - c.atb)) / 3600), 0)::numeric, 0) AS hours_alongside, round((COALESCE(sum(EXTRACT(EPOCH FROM (c.atd - c.atb)) / 3600), 0) / (365 * 24) * 100)::numeric, 1) AS occupancy_pct FROM ${from(user, 'rm_berths', BERTH_SCOPE, 'b')} LEFT JOIN ${from(user, 'rm_port_calls', CALL_SCOPE, 'c')} ON c.berth_id = b.id AND c.status = 'SAILED' AND c.atd >= now() - interval '12 months' GROUP BY b.id ORDER BY b.terminal, b.code`),
  vesselCalls: async (pool, p, user) => many(pool, `SELECT v.name, v.imo, v.type, v.flag, count(c.id) AS calls, max(c.atd) AS last_call FROM ${from(user, 'rm_vessels', VESSEL_SCOPE, 'v')} LEFT JOIN ${from(user, 'rm_port_calls', CALL_SCOPE, 'c')} ON c.vessel_id = v.id AND COALESCE(c.atd, c.eta) >= now() - ($1 || ' months')::interval GROUP BY v.id ORDER BY calls DESC, v.name`, [p.months || '12']),
  agentPerformance: async (pool, p, user) => many(pool, `SELECT agent_code, agent_name, count(*) AS calls, round(avg(EXTRACT(EPOCH FROM (atb - ata)) / 3600) FILTER (WHERE atb IS NOT NULL AND ata IS NOT NULL)::numeric, 1) AS avg_wait_h, round(avg(EXTRACT(EPOCH FROM (atd - ata)) / 3600) FILTER (WHERE atd IS NOT NULL AND ata IS NOT NULL)::numeric, 1) AS avg_turnaround_h FROM ${from(user, 'rm_port_calls', CALL_SCOPE)} WHERE COALESCE(atd, eta) >= now() - ($1 || ' months')::interval GROUP BY 1, 2 ORDER BY calls DESC`, [p.months || '12']),
  revenueByMonth: async (pool, p, user) => many(pool, `SELECT to_char(date_trunc('month', COALESCE(issued_at, created_at)), 'YYYY-MM') AS month, count(*) AS invoices, sum(subtotal) AS subtotal, sum(tax_amount) AS tax, sum(total) AS total, sum(total) FILTER (WHERE paid_at IS NOT NULL) AS collected FROM ${from(user, 'rm_invoices', INVOICE_SCOPE)} WHERE status IN ('ISSUED','PAID') AND COALESCE(issued_at, created_at) >= now() - ($1 || ' months')::interval GROUP BY 1 ORDER BY 1`, [p.months || '12']),
  outstandingInvoices: async (pool, _p, user) => many(pool, `SELECT number, vessel_name, bill_to_name, total, issued_at, EXTRACT(DAY FROM now() - issued_at)::int AS days_outstanding FROM ${from(user, 'rm_invoices', INVOICE_SCOPE)} WHERE status = 'ISSUED' ORDER BY issued_at`),
  inspectionSummary: async (pool, p, user) => many(pool, `SELECT type, count(*) AS inspections, count(*) FILTER (WHERE status = 'CLOSED') AS closed, count(*) FILTER (WHERE detention) AS detentions, sum(total_findings) AS findings, sum(open_findings) AS open_findings, round(avg(score_pct)::numeric, 1) AS avg_score FROM ${from(user, 'rm_inspections', INSPECTION_SCOPE)} WHERE COALESCE(closed_at, planned_at) >= now() - ($1 || ' months')::interval GROUP BY 1 ORDER BY 1`, [p.months || '12']),
  detentions: async (pool, p, user) => many(pool, `SELECT number, vessel_name, type, inspector, closed_at, total_findings FROM ${from(user, 'rm_inspections', INSPECTION_SCOPE)} WHERE detention AND closed_at >= now() - ($1 || ' months')::interval ORDER BY closed_at DESC`, [p.months || '12']),
  certificateExpiry: async (pool, p, user) => many(pool, `SELECT v.name AS vessel, v.imo, c.cert_type, c.number, c.issuer, c.expiry_date FROM ${from(user, 'rm_vessel_certificates', CERTIFICATE_SCOPE, 'c')} JOIN ${from(user, 'rm_vessels', VESSEL_SCOPE, 'v')} ON v.id = c.vessel_id WHERE c.expiry_date < now() + ($1 || ' days')::interval ORDER BY c.expiry_date`, [p.days || '90']),
  incidentSummary: async (pool, p, user) => many(pool, `SELECT category, type, severity, count(*) AS cases, count(*) FILTER (WHERE status = 'CLOSED') AS closed, round(avg(EXTRACT(EPOCH FROM (closed_at - reported_at)) / 86400) FILTER (WHERE closed_at IS NOT NULL)::numeric, 1) AS avg_close_days FROM ${from(user, 'rm_incidents', INCIDENT_SCOPE)} WHERE reported_at >= now() - ($1 || ' months')::interval GROUP BY 1, 2, 3 ORDER BY cases DESC`, [p.months || '12']),
  crewRoster: async (pool, _p, user) => many(pool, `SELECT name, rank, cdc_no, nationality, status, current_vessel_name, cert_alerts FROM ${from(user, 'rm_seafarers', SEAFARER_SCOPE)} ORDER BY current_vessel_name NULLS LAST, rank`),
  licenceRegister: async (pool, _p, user) => many(pool, `SELECT number, entity_name, entity_type, subject_kind, status, issue_date, expiry_date, performance_rating FROM ${from(user, 'rm_instruments', INSTRUMENT_SCOPE)} WHERE subject_kind IN ('COMPANY','PORT_FACILITY','MET_INSTITUTION') ORDER BY expiry_date NULLS LAST`),
  noticesRegister: async (pool, _p, user) => many(pool, `SELECT ref_no, title, type, status, issued_date, ack_required, jsonb_array_length(acknowledged_by) AS acknowledgments FROM ${from(user, 'rm_legal_instruments', LEGISLATION_SCOPE)} ORDER BY issued_date DESC NULLS LAST`),
  userActivity: async (pool, _p, user) => many(pool, `SELECT name, email, role_name, department, active, last_login_at FROM ${from(user, 'rm_users', USER_SCOPE)} ORDER BY last_login_at DESC NULLS LAST`),
  auditSummary: async (pool, p) => many(pool, "SELECT entity, action, count(*) AS entries, max(at) AS last_at FROM rm_audit_activity WHERE at >= now() - ($1 || ' days')::interval GROUP BY 1, 2 ORDER BY entries DESC", [p.days || '30']),
  tariffSchedule: async (pool, _p, user) => many(pool, `SELECT code, name, category, unit, rate, active, jsonb_array_length(revisions) AS revisions FROM ${from(user, 'rm_tariffs', TARIFF_SCOPE)} ORDER BY category, code`),
};

@Controller('reports')
export class ReportsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool) {}

  @RequirePerm('reports.view') @Get('catalog')
  async catalog() { return many<ReportDef>(this.pool, 'SELECT * FROM report_definitions ORDER BY category, name'); }

  @RequirePerm('reports.view') @Get('run/:key')
  async run(@CurrentUser() user: Principal, @Param('key') key: string, @Query() query: Record<string, string>) {
    const def = (await many<ReportDef>(this.pool, 'SELECT * FROM report_definitions WHERE key = $1', [key]))[0];
    if (!def || !RUNNERS[def.query_key]) throw notFound('Unknown report');
    const params: Record<string, string> = {};
    for (const p of def.params) {
      const raw = query[p.name] ?? p.default;
      if (raw === undefined) continue;
      if (p.type === 'number') { const n = Number(raw); params[p.name] = String(Number.isFinite(n) ? Math.min(Math.max(Math.round(n), 1), 3650) : Number(p.default ?? 12)); }
      else params[p.name] = String(raw).replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40);
    }
    const rows = await RUNNERS[def.query_key](this.pool, params, user);
    return { report: def, params, rows, generatedAt: new Date().toISOString(), currency: profile().currency.code };
  }

  /** The MIS report: monthly traffic, cargo by group, revenue and compliance for the requested window. */
  @RequirePerm('reports.view') @Get('mis')
  async mis(@CurrentUser() user: Principal, @Query('months') m?: string) {
    const n = Math.min(36, Math.max(3, Number(m) || 12));
    const window = months(n); const start = window[0].start;
    const [calls, invoices, inspections, incidents] = await Promise.all([
      many<{ atd: Date; cargo_ops: { cargoType: string; qtyMT: number; qty: number; unit: string }[]; ata: Date | null; atb: Date | null }>(this.pool, `SELECT atd, ata, atb, cargo_ops FROM ${from(user, 'rm_port_calls', CALL_SCOPE)} WHERE status = 'SAILED' AND atd >= $1`, [start]),
      many<{ at: Date; total: string; paid: boolean }>(this.pool, `SELECT COALESCE(issued_at, created_at) AS at, total, (paid_at IS NOT NULL) AS paid FROM ${from(user, 'rm_invoices', INVOICE_SCOPE)} WHERE status IN ('ISSUED','PAID') AND COALESCE(issued_at, created_at) >= $1`, [start]),
      many<{ closed_at: Date; detention: boolean; total_findings: number }>(this.pool, `SELECT closed_at, detention, total_findings FROM ${from(user, 'rm_inspections', INSPECTION_SCOPE)} WHERE status = 'CLOSED' AND closed_at >= $1`, [start]),
      many<{ reported_at: Date; severity: string }>(this.pool, `SELECT reported_at, severity FROM ${from(user, 'rm_incidents', INCIDENT_SCOPE)} WHERE reported_at >= $1`, [start]),
    ]);
    const rows = window.map((w) => ({ key: w.key, month: w.label, calls: 0, cargoMT: 0, teu: 0, container: 0, dryBulk: 0, liquid: 0, other: 0, avgTurnaroundH: 0, avgWaitH: 0, revenue: 0, collected: 0, inspections: 0, detentions: 0, findings: 0, incidents: 0, highIncidents: 0, _turn: [] as number[], _wait: [] as number[] }));
    const byKey = new Map(rows.map((r) => [r.key, r]));
    for (const c of calls) { const r = byKey.get(monthKey(c.atd)); if (!r) continue; r.calls += 1; for (const o of c.cargo_ops) { const g = CARGO_GROUP[o.cargoType] || 'other'; r[g] += o.qtyMT || 0; r.cargoMT += o.qtyMT || 0; if (o.unit === 'TEU') r.teu += o.qty; } if (c.ata && c.atd) r._turn.push((c.atd.getTime() - c.ata.getTime()) / 3600000); if (c.ata && c.atb) r._wait.push((c.atb.getTime() - c.ata.getTime()) / 3600000); }
    for (const i of invoices) { const r = byKey.get(monthKey(i.at)); if (!r) continue; r.revenue += Number(i.total); if (i.paid) r.collected += Number(i.total); }
    for (const i of inspections) { const r = byKey.get(monthKey(i.closed_at)); if (!r) continue; r.inspections += 1; if (i.detention) r.detentions += 1; r.findings += Number(i.total_findings); }
    for (const i of incidents) { const r = byKey.get(monthKey(i.reported_at)); if (!r) continue; r.incidents += 1; if (['HIGH', 'CRITICAL'].includes(i.severity)) r.highIncidents += 1; }
    const out = rows.map(({ _turn, _wait, ...r }) => ({ ...r, avgTurnaroundH: _turn.length ? Math.round(_turn.reduce((a, b) => a + b, 0) / _turn.length * 10) / 10 : 0, avgWaitH: _wait.length ? Math.round(_wait.reduce((a, b) => a + b, 0) / _wait.length * 10) / 10 : 0 }));
    const totals = out.reduce((t, r) => ({ calls: t.calls + r.calls, cargoMT: t.cargoMT + r.cargoMT, teu: t.teu + r.teu, revenue: t.revenue + r.revenue, collected: t.collected + r.collected, inspections: t.inspections + r.inspections, detentions: t.detentions + r.detentions, incidents: t.incidents + r.incidents }), { calls: 0, cargoMT: 0, teu: 0, revenue: 0, collected: 0, inspections: 0, detentions: 0, incidents: 0 });
    const benchmarks = Object.entries(profile().benchmarks).map(([key, b]) => ({ key, value: b.value, confirmed: b.confirmed, source: b.source }));
    return { months: n, rows: out, totals, currency: profile().currency.code, benchmarks, generatedAt: new Date().toISOString() };
  }
}
