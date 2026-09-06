import type { Pool } from 'pg';
import type { Principal, ScopeOptions } from '@maritime/service-kit';
import { one } from './queries';
import {
  CALL_SCOPE, CERTIFICATE_SCOPE, COMPANY_SCOPE, CREW_LIST_SCOPE, DECISION_SCOPE, INCIDENT_SCOPE, INSPECTION_SCOPE, INSTRUMENT_SCOPE, INVOICE_SCOPE, LEGISLATION_SCOPE,
  REGISTRATION_SCOPE, SEAFARER_SCOPE, USER_SCOPE, VESSEL_SCOPE, from,
} from './scope';

/* The Command Centre's module strip: two or three headline numbers per module, read from this service's read models
 * under the reader's scope, so the home page can put every module's state in front of the officer with one call.
 * The web decides which tiles to show from the reader's permissions; this answers for all of them. */
export const REQUEST_SCOPE: ScopeOptions = { columns: ['company'] };
export type KpiFormat = 'count' | 'money' | 'hours' | 'pct';
export interface StripKpi { label: string; value: number; format?: KpiFormat; tone?: 'default' | 'success' | 'warning' | 'error' }
export interface StripModule { key: string; kpis: StripKpi[] }
const n = (v: unknown) => Number(v ?? 0) || 0;
const r1 = (v: unknown) => Math.round(n(v) * 10) / 10;
const warn = (v: number): StripKpi['tone'] => (v > 0 ? 'warning' : 'default');
const bad = (v: number): StripKpi['tone'] => (v > 0 ? 'error' : 'default');

export async function moduleStrip(pool: Pool, user: Principal): Promise<{ modules: StripModule[]; generatedAt: string }> {
  const t = <T>(sql: string) => one<T>(pool, sql);
  const [ops, ships, certs, regs, crew, lists, legis, incidents, inspections, companies, licences, requests, invoices, reports, masters, decisions, users] = await Promise.all([
    t<{ in_port: string; anchored: string; expected: string; wait: string | null }>(`SELECT count(*) FILTER (WHERE status = 'BERTHED') AS in_port, count(*) FILTER (WHERE status = 'AT_ANCHORAGE') AS anchored,
        count(*) FILTER (WHERE status IN ('ANNOUNCED','CONFIRMED') AND eta > now() AND eta <= now() + interval '72 hours') AS expected,
        avg(EXTRACT(EPOCH FROM (atb - ata)) / 3600) FILTER (WHERE atb >= now() - interval '30 days' AND ata IS NOT NULL) AS wait FROM ${from(user, 'rm_port_calls', CALL_SCOPE)}`),
    t<{ vessels: string }>(`SELECT count(*) FILTER (WHERE status = 'ACTIVE') AS vessels FROM ${from(user, 'rm_vessels', VESSEL_SCOPE)}`),
    t<{ flagged: string }>(`SELECT count(*) FILTER (WHERE in_force AND expiry_date <= now() + interval '30 days') AS flagged FROM ${from(user, 'rm_vessel_certificates', CERTIFICATE_SCOPE)}`),
    t<{ open: string }>(`SELECT count(*) FILTER (WHERE status NOT IN ('GRANTED','REFUSED','CLOSED','WITHDRAWN')) AS open FROM ${from(user, 'rm_registrations', REGISTRATION_SCOPE)}`),
    t<{ active: string; alerts: string }>(`SELECT count(*) FILTER (WHERE status = 'ACTIVE') AS active, count(*) FILTER (WHERE cert_alerts > 0) AS alerts FROM ${from(user, 'rm_seafarers', SEAFARER_SCOPE)}`),
    t<{ lists: string }>(`SELECT count(*) FILTER (WHERE list_date >= now() - interval '30 days') AS lists FROM ${from(user, 'rm_crew_lists', CREW_LIST_SCOPE)}`),
    t<{ in_force: string; drafts: string; ack: string }>(`SELECT count(*) FILTER (WHERE status = 'IN_FORCE') AS in_force, count(*) FILTER (WHERE status = 'DRAFT') AS drafts, count(*) FILTER (WHERE status = 'IN_FORCE' AND ack_required) AS ack FROM ${from(user, 'rm_legal_instruments', LEGISLATION_SCOPE)}`),
    t<{ open: string; high: string; logged: string }>(`SELECT count(*) FILTER (WHERE status NOT IN ('RESOLVED','CLOSED')) AS open, count(*) FILTER (WHERE status NOT IN ('RESOLVED','CLOSED') AND severity IN ('HIGH','CRITICAL')) AS high,
        count(*) FILTER (WHERE reported_at >= now() - interval '30 days') AS logged FROM ${from(user, 'rm_incidents', INCIDENT_SCOPE)}`),
    t<{ findings: string; detentions: string; closed: string }>(`SELECT coalesce(sum(open_findings) FILTER (WHERE status <> 'CLOSED'), 0) AS findings, count(*) FILTER (WHERE detention AND closed_at >= date_trunc('year', now())) AS detentions,
        count(*) FILTER (WHERE closed_at >= now() - interval '30 days') AS closed FROM ${from(user, 'rm_inspections', INSPECTION_SCOPE)}`),
    t<{ active: string }>(`SELECT count(*) FILTER (WHERE status = 'ACTIVE') AS active FROM ${from(user, 'rm_companies', COMPANY_SCOPE)}`),
    t<{ licences: string; expiring: string }>(`SELECT count(*) FILTER (WHERE status = 'ISSUED' AND subject_kind = 'COMPANY') AS licences,
        count(*) FILTER (WHERE status = 'ISSUED' AND subject_kind = 'COMPANY' AND expiry_date > now() AND expiry_date <= now() + interval '90 days') AS expiring FROM ${from(user, 'rm_instruments', INSTRUMENT_SCOPE)}`),
    t<{ open: string; breached: string; decided: string }>(`SELECT count(*) FILTER (WHERE status IN ('SUBMITTED','UNDER_ASSESSMENT','INFO_REQUESTED')) AS open,
        count(*) FILTER (WHERE status IN ('SUBMITTED','UNDER_ASSESSMENT','INFO_REQUESTED') AND (sla_breached OR sla_due_at < now())) AS breached,
        count(*) FILTER (WHERE decided_at >= now() - interval '30 days') AS decided FROM ${from(user, 'rm_service_requests', REQUEST_SCOPE)}`),
    t<{ outstanding: string; overdue: string; billed: string }>(`SELECT coalesce(sum(total - paid_amount) FILTER (WHERE status = 'ISSUED'), 0) AS outstanding, count(*) FILTER (WHERE status = 'ISSUED' AND due_at < now()) AS overdue,
        coalesce(sum(total) FILTER (WHERE status IN ('ISSUED','PAID') AND coalesce(issued_at, created_at) >= date_trunc('month', now())), 0) AS billed FROM ${from(user, 'rm_invoices', INVOICE_SCOPE)}`),
    t<{ reports: string; categories: string }>('SELECT count(*) AS reports, count(DISTINCT category) AS categories FROM report_definitions'),
    t<{ masters: string; entries: string }>('SELECT count(*) AS masters, coalesce(sum(entries), 0) AS entries FROM rm_lookup_counts'),
    t<{ pending: string; escalated: string; week: string }>(`SELECT count(*) FILTER (WHERE review_status = 'PENDING') AS pending, count(*) FILTER (WHERE disposition = 'ESCALATED' AND review_status = 'PENDING') AS escalated,
        count(*) FILTER (WHERE at >= now() - interval '7 days') AS week FROM ${from(user, 'rm_agent_decisions', DECISION_SCOPE)}`),
    t<{ active: string; today: string; inactive: string }>(`SELECT count(*) FILTER (WHERE active) AS active, count(*) FILTER (WHERE last_login_at >= now() - interval '24 hours') AS today, count(*) FILTER (WHERE NOT active) AS inactive FROM ${from(user, 'rm_users', USER_SCOPE)}`),
  ]);
  const modules: StripModule[] = [
    { key: 'ops', kpis: [{ label: 'In port', value: n(ops.in_port) }, { label: 'At anchorage', value: n(ops.anchored), tone: warn(n(ops.anchored)) }, { label: 'Avg wait, 30 d', value: r1(ops.wait), format: 'hours' }] },
    { key: 'ships', kpis: [{ label: 'Vessels on register', value: n(ships.vessels) }, { label: 'Certificates flagged', value: n(certs.flagged), tone: warn(n(certs.flagged)) }, { label: 'Registrations open', value: n(regs.open) }] },
    { key: 'crew', kpis: [{ label: 'Seafarers active', value: n(crew.active) }, { label: 'Document alerts', value: n(crew.alerts), tone: warn(n(crew.alerts)) }, { label: 'Crew lists, 30 d', value: n(lists.lists) }] },
    { key: 'legis', kpis: [{ label: 'In force', value: n(legis.in_force) }, { label: 'Need acknowledgement', value: n(legis.ack) }, { label: 'Drafts', value: n(legis.drafts) }] },
    { key: 'incidents', kpis: [{ label: 'Open cases', value: n(incidents.open), tone: warn(n(incidents.open)) }, { label: 'High or critical', value: n(incidents.high), tone: bad(n(incidents.high)) }, { label: 'Logged, 30 d', value: n(incidents.logged) }] },
    { key: 'inspect', kpis: [{ label: 'Open deficiencies', value: n(inspections.findings), tone: warn(n(inspections.findings)) }, { label: 'Detentions YTD', value: n(inspections.detentions), tone: bad(n(inspections.detentions)) }, { label: 'Surveys closed, 30 d', value: n(inspections.closed) }] },
    { key: 'facil', kpis: [{ label: 'Companies active', value: n(companies.active) }, { label: 'Licences in force', value: n(licences.licences) }, { label: 'Expiring, 90 d', value: n(licences.expiring), tone: warn(n(licences.expiring)) }] },
    { key: 'services', kpis: [{ label: 'Applications open', value: n(requests.open) }, { label: 'Past service level', value: n(requests.breached), tone: bad(n(requests.breached)) }, { label: 'Decided, 30 d', value: n(requests.decided) }] },
    { key: 'finance', kpis: [{ label: 'Outstanding', value: n(invoices.outstanding), format: 'money' }, { label: 'Overdue invoices', value: n(invoices.overdue), tone: bad(n(invoices.overdue)) }, { label: 'Billed this month', value: n(invoices.billed), format: 'money' }] },
    { key: 'mis', kpis: [{ label: 'Reports', value: n(reports.reports) }, { label: 'Categories', value: n(reports.categories) }] },
    { key: 'masters', kpis: [{ label: 'Masters', value: n(masters.masters) }, { label: 'Values', value: n(masters.entries) }] },
    { key: 'agents', kpis: [{ label: 'Awaiting review', value: n(decisions.pending), tone: warn(n(decisions.pending)) }, { label: 'Escalated', value: n(decisions.escalated), tone: bad(n(decisions.escalated)) }, { label: 'Decisions, 7 d', value: n(decisions.week) }] },
    { key: 'admin', kpis: [{ label: 'Active users', value: n(users.active) }, { label: 'Signed in, 24 h', value: n(users.today) }, { label: 'Inactive', value: n(users.inactive) }] },
  ];
  return { modules, generatedAt: new Date().toISOString() };
}
