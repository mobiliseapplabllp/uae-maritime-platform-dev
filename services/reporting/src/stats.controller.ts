import { Controller, Get, Inject, Param } from '@nestjs/common';
import type { Pool } from 'pg';
import { hasPerm } from '@maritime/contracts';
import { CurrentUser, KIT_CACHE, KIT_ENV, KIT_POOL, forbidden, notFound, scopedKey, type BaseEnv, type Cache, type Principal } from '@maritime/service-kit';
import { D, H, card, certStatus, count, many, money, monthYear, dayMonthYear, nf, one, type Card } from './queries';
import {
  BERTH_SCOPE, CALL_SCOPE, CERTIFICATE_SCOPE, CHECKLIST_SCOPE, INCIDENT_SCOPE, INSPECTION_SCOPE,
  INSTRUMENT_SCOPE, INVOICE_SCOPE, LEGISLATION_SCOPE, REGISTRATION_SCOPE, RESOURCE_SCOPE, SEAFARER_SCOPE,
  TARIFF_SCOPE, USER_SCOPE, VESSEL_SCOPE, from,
} from './scope';

type Compute = (pool: Pool, user: Principal) => Promise<Card[]>;
const avgH = (rows: { a: Date | null; b: Date | null }[]) => (rows.length ? Math.round(rows.reduce((s, r) => s + (new Date(r.b!).getTime() - new Date(r.a!).getTime()), 0) / rows.length / H * 10) / 10 : 0);

/** Per-module stat cards — the eight small numbers shown at the top of every page. Each scope checks its own permission. */
export const SCOPES: Record<string, { perm: string; compute: Compute }> = {
  portcalls: { perm: 'portcalls.view', compute: async (pool, user) => {
    const now = new Date(); const yearStart = new Date(now.getFullYear(), 0, 1); const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
    const active = await many<{ status: string; eta: Date }>(pool, `SELECT status, eta FROM ${from(user, 'rm_port_calls', CALL_SCOPE)} WHERE status IN ('ANNOUNCED','CONFIRMED','AT_ANCHORAGE','BERTHED')`);
    const sailed30 = await many<{ ata: Date | null; atb: Date | null; atd: Date | null }>(pool, `SELECT ata, atb, atd FROM ${from(user, 'rm_port_calls', CALL_SCOPE)} WHERE status = 'SAILED' AND atd >= $1`, [new Date(now.getTime() - 30 * D)]);
    const turn = avgH(sailed30.filter((c) => c.ata && c.atd).map((c) => ({ a: c.ata, b: c.atd })));
    const wait = avgH(sailed30.filter((c) => c.ata && c.atb).map((c) => ({ a: c.ata, b: c.atb })));
    const [total, sailedTotal, ytd, first, mtd] = await Promise.all([
      count(pool, `SELECT count(*) AS n FROM ${from(user, 'rm_port_calls', CALL_SCOPE)}`), count(pool, `SELECT count(*) AS n FROM ${from(user, 'rm_port_calls', CALL_SCOPE)} WHERE status = 'SAILED'`),
      count(pool, `SELECT count(*) AS n FROM ${from(user, 'rm_port_calls', CALL_SCOPE)} WHERE status = 'SAILED' AND atd >= $1`, [yearStart]),
      one<{ atd: Date }>(pool, `SELECT atd FROM ${from(user, 'rm_port_calls', CALL_SCOPE)} WHERE status = 'SAILED' ORDER BY atd LIMIT 1`),
      one<{ mt: string; teu: string }>(pool, `SELECT COALESCE(sum(cargo_mt),0) AS mt, COALESCE(sum(teu),0) AS teu FROM ${from(user, 'rm_port_calls', CALL_SCOPE)} WHERE status = 'SAILED' AND atd >= $1`, [monthStart]),
    ]);
    const mt = Number(mtd?.mt ?? 0); const teu = Number(mtd?.teu ?? 0);
    const mmt = mt >= 1e6 ? `${(mt / 1e6).toFixed(2)} M MT` : `${nf(mt)} MT`;
    return [
      card('At berth', active.filter((c) => c.status === 'BERTHED').length, 'working cargo now', 'success'),
      card('At anchorage', active.filter((c) => c.status === 'AT_ANCHORAGE').length, 'awaiting berth', 'warning'),
      card('Expected 72 h', active.filter((c) => ['ANNOUNCED', 'CONFIRMED'].includes(c.status) && c.eta > now && c.eta < new Date(now.getTime() + 72 * H)).length, 'announced + confirmed'),
      card('Avg turnaround', `${turn} h`, 'sailed calls, 30 days'),
      card('Total port calls', nf(total), `on record since ${monthYear(first?.atd)}`),
      card('Calls sailed', nf(sailedTotal), `${nf(ytd)} in ${now.getFullYear()}`),
      card('Cargo this month', mmt, teu ? `${nf(teu)} TEU handled` : 'across all commodities'),
      card('Avg pre-berthing wait', `${wait} h`, 'anchorage to berth, 30 days', wait > 24 ? 'warning' : 'default'),
    ];
  } },
  berths: { perm: 'portcalls.view', compute: async (pool, user) => {
    const berths = await many<{ id: string; status: string; loa_max: string; draft_max: string; outages: { from: string; days: number }[] }>(pool, `SELECT id, status, loa_max, draft_max, outages FROM ${from(user, 'rm_berths', BERTH_SCOPE)}`);
    const berthed = await many<{ berth_id: string }>(pool, `SELECT berth_id FROM ${from(user, 'rm_port_calls', CALL_SCOPE)} WHERE status = 'BERTHED'`);
    const op = berths.filter((b) => b.status === 'OPERATIONAL'); const occ = new Set(berthed.map((c) => c.berth_id)).size;
    const since12 = Date.now() - 365 * D;
    const out12 = berths.flatMap((b) => b.outages.filter((o) => new Date(o.from).getTime() >= since12));
    const outDays = Math.round(out12.reduce((s, o) => s + (o.days || 0), 0));
    const avail = berths.length ? Math.max(0, Math.round((1 - outDays / (berths.length * 365)) * 1000) / 10) : 100;
    return [
      card('Berths', berths.length, `${berths.length - op.length} under maintenance`), card('Occupied now', occ, 'vessels alongside', 'success'),
      card('Occupancy', `${op.length ? Math.round((occ / op.length) * 100) : 0}%`, 'of operational berths'), card('Free & operational', op.length - occ, 'ready for allocation'),
      card('Longest quay', `${Math.max(0, ...berths.map((b) => Number(b.loa_max) || 0))} m`, 'max LOA accepted'), card('Deepest berth', `${Math.max(0, ...berths.map((b) => Number(b.draft_max) || 0))} m`, 'max declared draft'),
      card('Outages (12 m)', out12.length, `${outDays} days lost`, out12.length ? 'warning' : 'success'), card('Berth availability', `${avail}%`, 'operational time, 12 months', avail < 95 ? 'warning' : 'success'),
    ];
  } },
  registry: { perm: 'registry.view', compute: async (pool, user) => {
    const now = new Date();
    const rows = await many<{ kind: string; status: string; submitted_at: Date | null; closed_at: Date | null; due_at: Date | null }>(pool, `SELECT kind, status, submitted_at, closed_at, due_at FROM ${from(user, 'rm_registrations', REGISTRATION_SCOPE)}`);
    const fleet = await many<{ registry_state: string; registry: { certificateExpiresOn?: string } }>(pool, `SELECT registry_state, registry FROM ${from(user, 'rm_vessels', VESSEL_SCOPE)}`);
    const certs = await many<{ statutory: boolean; in_force: boolean; signed: boolean }>(pool, `SELECT statutory, in_force, signed FROM ${from(user, 'rm_instruments', INSTRUMENT_SCOPE)} WHERE status = 'ISSUED' AND instrument_class = 'CERTIFICATE'`);
    const open = rows.filter((r) => !['GRANTED', 'REJECTED', 'WITHDRAWN'].includes(r.status));
    const breached = open.filter((r) => r.due_at && r.due_at < now);
    const closed = rows.filter((r) => r.closed_at && r.submitted_at);
    const avgDays = closed.length ? Math.round((closed.reduce((s, r) => s + (r.closed_at!.getTime() - r.submitted_at!.getTime()), 0) / closed.length / D) * 10) / 10 : 0;
    const registered = fleet.filter((v) => v.registry_state === 'REGISTERED').length;
    const provisional = fleet.filter((v) => v.registry_state === 'PROVISIONAL');
    const lapsing = provisional.filter((v) => v.registry.certificateExpiresOn && new Date(v.registry.certificateExpiresOn) < new Date(now.getTime() + 60 * D)).length;
    const statutory = certs.filter((c) => c.statutory); const notInForce = statutory.filter((c) => !c.in_force);
    return [
      card('On the register', registered, `${fleet.length - registered - provisional.length} ships not registered here`),
      card('Provisional entries', provisional.length, lapsing ? `${lapsing} certificate(s) lapse inside 60 days` : 'none lapsing soon', lapsing ? 'warning' : 'default'),
      card('Open applications', open.length, `${rows.length} transactions on record`),
      card('Past due', breached.length, breached.length ? 'beyond the registry SLA' : 'all inside SLA', breached.length ? 'warning' : 'success'),
      card('Granted', rows.filter((r) => r.status === 'GRANTED').length, `${rows.filter((r) => r.status === 'REJECTED').length} refused`),
      card('Avg decision time', `${avgDays} d`, 'submission to decision'),
      card('Statutory certificates', statutory.length, `${certs.filter((c) => c.signed).length} of ${certs.length} instruments signed`),
      card('Not in force', notInForce.length, notInForce.length ? 'survey endorsement overdue or refused' : 'every certificate current', notInForce.length ? 'warning' : 'success'),
    ];
  } },
  vessels: { perm: 'vessels.view', compute: async (pool, user) => {
    const vessels = await many<{ id: string; name: string; status: string; built: number | null; type: string; liner: boolean; next_dry_dock: Date | null; alerts: string }>(pool, `SELECT v.*, (SELECT count(*) FROM ${from(user, 'rm_vessel_certificates', CERTIFICATE_SCOPE, 'c')} WHERE c.vessel_id = v.id AND c.expiry_date < now() + interval '30 days') AS alerts FROM ${from(user, 'rm_vessels', VESSEL_SCOPE, 'v')}`);
    const calls = await many<{ vessel_id: string; n: string }>(pool, `SELECT vessel_id, count(*) AS n FROM ${from(user, 'rm_port_calls', CALL_SCOPE)} GROUP BY vessel_id ORDER BY n DESC`);
    const callCount = calls.reduce((s, c) => s + Number(c.n), 0);
    const topV = calls[0] ? vessels.find((v) => v.id === calls[0].vessel_id) : null;
    const active = vessels.filter((v) => v.status === 'ACTIVE');
    const dueDock = vessels.filter((v) => v.next_dry_dock && v.next_dry_dock < new Date(Date.now() + 182 * D)).length;
    const year = new Date().getFullYear();
    const avgAge = active.length ? Math.round(active.reduce((s, v) => s + (year - (v.built || year)), 0) / active.length) : 0;
    const alerts = active.filter((v) => Number(v.alerts) > 0).length;
    return [
      card('Active vessels', active.length, `${vessels.length - active.length} inactive`), card('Certificate alerts', alerts, 'vessels needing review', alerts ? 'warning' : 'success'),
      card('Average age', `${avgAge} yrs`, 'active fleet'), card('Vessel types', new Set(active.map((v) => v.type)).size, 'in the registry'),
      card('Calls on record', nf(callCount), 'by these vessels'), card('Busiest caller', topV ? topV.name : '—', topV ? `${calls[0].n} calls` : ''),
      card('Dry dock ≤6 m', dueDock, 'class survey window', dueDock ? 'warning' : 'success'), card('Liner callers', vessels.filter((v) => v.liner).length, 'documented scheduled services'),
    ];
  } },
  certificates: { perm: 'certificates.view', compute: async (pool, user) => {
    const rows = await many<{ vessel_id: string; cert_type: string; expiry_date: Date }>(pool, `SELECT c.vessel_id, c.cert_type, c.expiry_date FROM ${from(user, 'rm_vessel_certificates', CERTIFICATE_SCOPE, 'c')} JOIN ${from(user, 'rm_vessels', VESSEL_SCOPE, 'v')} ON v.id = c.vessel_id WHERE v.status = 'ACTIVE'`);
    const now = new Date(); const st = rows.map((r) => certStatus(r.expiry_date, now));
    const vessels = new Set(rows.map((r) => r.vessel_id)).size;
    return [
      card('Certificates', rows.length, 'across active fleet'), card('Valid', st.filter((x) => x === 'VALID').length, '', 'success'),
      card('Expiring ≤30 d', st.filter((x) => x === 'EXPIRING').length, 'plan renewals', 'warning'), card('Expired', st.filter((x) => x === 'EXPIRED').length, 'immediate action', 'error'),
      card('Vessels covered', vessels, 'active fleet'), card('Certificate types', new Set(rows.map((r) => r.cert_type)).size, 'distinct instruments'),
      card('Avg per vessel', vessels ? Math.round(rows.length / vessels * 10) / 10 : 0, 'certificates held'),
      card('Renewals ≤90 d', rows.filter((r) => r.expiry_date > now && r.expiry_date < new Date(now.getTime() + 90 * D)).length, 'plan survey slots'),
    ];
  } },
  seafarers: { perm: 'seafarers.view', compute: async (pool, user) => {
    const sf = await many<{ current_vessel_id: string | null; cert_alerts: number; sea_service_days: number; service_records: number; rank: string; nationality: string | null }>(pool, `SELECT current_vessel_id, cert_alerts, sea_service_days, service_records, rank, nationality FROM ${from(user, 'rm_seafarers', SEAFARER_SCOPE)}`);
    const avgDays = sf.length ? Math.round(sf.reduce((s, x) => s + Number(x.sea_service_days), 0) / sf.length) : 0;
    const alerts = sf.filter((x) => Number(x.cert_alerts) > 0).length;
    return [
      card('Registered', sf.length, 'seafarers on the roll'), card('On board', sf.filter((x) => x.current_vessel_id).length, 'currently assigned', 'success'),
      card('Certificate alerts', alerts, 'medical / STCW review', alerts ? 'warning' : 'success'), card('Avg sea service', `${nf(avgDays)} d`, 'per seafarer'),
      card('Service records', nf(sf.reduce((s, x) => s + Number(x.service_records), 0)), 'contracts on file'), card('Ranks represented', new Set(sf.map((x) => x.rank)).size, 'across the roll'),
      card('Ashore', sf.filter((x) => !x.current_vessel_id).length, 'available for assignment'), card('Nationalities', new Set(sf.map((x) => x.nationality).filter(Boolean)).size, 'on the register'),
    ];
  } },
  legislation: { perm: 'legislation.view', compute: async (pool, user) => {
    const ins = await many<{ status: string; type: string; issued_date: Date | null; ack_required: boolean; acknowledged_by: { userId: string }[] }>(pool, `SELECT status, type, issued_date, ack_required, acknowledged_by FROM ${from(user, 'rm_legal_instruments', LEGISLATION_SCOPE)}`);
    const yearStart = new Date(new Date().getFullYear(), 0, 1);
    const pendingMine = ins.filter((i) => i.ack_required && i.status === 'IN_FORCE' && !i.acknowledged_by.some((a) => a.userId === user.id)).length;
    return [
      card('In force', ins.filter((i) => i.status === 'IN_FORCE').length, 'instruments'), card('Issued this year', ins.filter((i) => i.issued_date && i.issued_date >= yearStart).length, 'circulars & notices'),
      card('Need acknowledgment', ins.filter((i) => i.ack_required && i.status === 'IN_FORCE').length, 'organisation-wide'), card('Pending — you', pendingMine, 'awaiting your acknowledgment', pendingMine ? 'warning' : 'success'),
      card('Total register', ins.length, 'acts, rules, notices, circulars'), card('Superseded', ins.filter((i) => i.status === 'SUPERSEDED').length, 'replaced by later issues'),
      card('Withdrawn', ins.filter((i) => i.status === 'WITHDRAWN').length, 'no longer in effect'), card('Instrument types', new Set(ins.map((i) => i.type)).size, 'in the register'),
    ];
  } },
  facilities: { perm: 'facilities.view', compute: async (pool, user) => {
    const lic = await many<{ status: string; expiry_date: Date | null; entity_type: string; applied_date: Date | null; performance_rating: string | null; audits: number }>(pool, `SELECT status, expiry_date, entity_type, applied_date, performance_rating, audits FROM ${from(user, 'rm_instruments', INSTRUMENT_SCOPE)} WHERE subject_kind IN ('COMPANY','PORT_FACILITY','MET_INSTITUTION')`);
    const applied = lic.map((l) => l.applied_date).filter(Boolean) as Date[];
    const rated = lic.filter((l) => Number(l.performance_rating) > 0);
    const avgRate = rated.length ? Math.round(rated.reduce((s, l) => s + Number(l.performance_rating), 0) / rated.length * 10) / 10 : 0;
    const soon = lic.filter((l) => l.status === 'ISSUED' && l.expiry_date && l.expiry_date < new Date(Date.now() + 90 * D)).length;
    return [
      card('Issued', lic.filter((l) => l.status === 'ISSUED').length, 'active licences', 'success'), card('In pipeline', lic.filter((l) => ['APPLIED', 'UNDER_REVIEW'].includes(l.status)).length, 'applied / under review'),
      card('Suspended / revoked', lic.filter((l) => ['SUSPENDED', 'REVOKED'].includes(l.status)).length, 'enforcement actions', 'warning'), card('Expiring ≤90 d', soon, 'renewals due', soon ? 'warning' : 'success'),
      card('Licences on record', lic.length, `since ${applied.length ? monthYear(new Date(Math.min(...applied.map((d) => d.getTime())))) : '—'}`), card('Categories', new Set(lic.map((l) => l.entity_type)).size, 'classes of operator'),
      card('Avg rating', avgRate ? `${avgRate} / 5` : '—', 'performance across issued'), card('Audits logged', nf(lic.reduce((s, l) => s + Number(l.audits), 0)), 'annual safety audits'),
    ];
  } },
  inspections: { perm: 'inspections.view', compute: async (pool, user) => {
    const now = new Date();
    const ins = await many<{ status: string; result: string | null; detention: boolean; closed_at: Date | null; started_at: Date | null; open_findings: number; total_findings: number }>(pool, `SELECT status, result, detention, closed_at, started_at, open_findings, total_findings FROM ${from(user, 'rm_inspections', INSPECTION_SCOPE)}`);
    const started = ins.map((i) => i.started_at).filter(Boolean) as Date[];
    const closed = ins.filter((i) => i.status === 'CLOSED');
    const detRate = closed.length ? Math.round(closed.filter((i) => i.detention).length / closed.length * 1000) / 10 : 0;
    const satPct = closed.length ? Math.round(closed.filter((i) => i.result === 'SATISFACTORY').length / closed.length * 100) : 0;
    const totalF = ins.reduce((s, i) => s + Number(i.total_findings), 0); const openF = ins.reduce((s, i) => s + Number(i.open_findings), 0);
    return [
      card('Open inspections', ins.filter((i) => i.status !== 'CLOSED').length, 'planned + in progress'), card('Closed this month', ins.filter((i) => i.closed_at && i.closed_at >= new Date(now.getFullYear(), now.getMonth(), 1)).length, ''),
      card('Open findings', openF, 'deficiencies to rectify', openF ? 'warning' : 'success'), card('Detentions YTD', ins.filter((i) => i.detention && i.closed_at && i.closed_at >= new Date(now.getFullYear(), 0, 1)).length, '', 'error'),
      card('Inspections on record', nf(ins.length), `since ${started.length ? monthYear(new Date(Math.min(...started.map((d) => d.getTime())))) : '—'}`), card('Detention rate', `${detRate}%`, 'of closed inspections', detRate > 8 ? 'warning' : 'success'),
      card('Findings raised', nf(totalF), `${nf(totalF - openF)} rectified`), card('Satisfactory', `${satPct}%`, 'closed with no deficiency', 'success'),
    ];
  } },
  incidents: { perm: 'incidents.view', compute: async (pool, user) => {
    const now = new Date();
    const inc = await many<{ status: string; severity: string; closed_at: Date | null; reported_at: Date; type: string }>(pool, `SELECT status, severity, closed_at, reported_at, type FROM ${from(user, 'rm_incidents', INCIDENT_SCOPE)}`);
    const done = inc.filter((i) => i.closed_at);
    const closePct = inc.length ? Math.round(inc.filter((i) => i.status === 'CLOSED').length / inc.length * 100) : 0;
    const avgClose = done.length ? Math.round(done.reduce((s, i) => s + (i.closed_at!.getTime() - i.reported_at.getTime()), 0) / done.length / D * 10) / 10 : 0;
    const first = inc.length ? monthYear(new Date(Math.min(...inc.map((i) => i.reported_at.getTime())))) : '—';
    return [
      card('Open / unacknowledged', inc.filter((i) => ['OPEN', 'ACKNOWLEDGED'].includes(i.status)).length, 'awaiting response', 'error'), card('In response', inc.filter((i) => ['RESPONDING', 'MONITORING'].includes(i.status)).length, 'assets tasked', 'warning'),
      card('Closed this month', inc.filter((i) => i.closed_at && i.closed_at >= new Date(now.getFullYear(), now.getMonth(), 1)).length, '', 'success'), card('High severity YTD', inc.filter((i) => ['HIGH', 'CRITICAL'].includes(i.severity) && i.reported_at >= new Date(now.getFullYear(), 0, 1)).length, 'high + critical'),
      card('Cases on record', nf(inc.length), `since ${first}`), card('Closed', nf(inc.filter((i) => i.status === 'CLOSED').length), `${closePct}% of all cases`, 'success'),
      card('Near misses', nf(inc.filter((i) => i.type === 'NEAR_MISS').length), 'reported — a good sign'), card('Avg close time', avgClose ? `${avgClose} d` : '—', 'report to closure'),
    ];
  } },
  invoices: { perm: 'invoices.view', compute: async (pool, user) => {
    const now = new Date();
    const inv = await many<{ status: string; total: string; issued_at: Date | null; paid_at: Date | null }>(pool, `SELECT status, total, issued_at, paid_at FROM ${from(user, 'rm_invoices', INVOICE_SCOPE)}`);
    const issued = inv.filter((i) => i.issued_at);
    const billedAll = issued.reduce((s, i) => s + Number(i.total), 0); const collected = inv.filter((i) => i.paid_at).reduce((s, i) => s + Number(i.total), 0);
    const collPct = billedAll ? Math.round(collected / billedAll * 1000) / 10 : 0;
    const billedYtd = issued.filter((i) => i.issued_at! >= new Date(now.getFullYear(), 0, 1)).reduce((s, i) => s + Number(i.total), 0);
    const out = inv.filter((i) => i.status === 'ISSUED'); const overdue = out.filter((i) => i.issued_at && now.getTime() - i.issued_at.getTime() > 30 * D);
    const first = issued.length ? monthYear(new Date(Math.min(...issued.map((i) => i.issued_at!.getTime())))) : '—';
    return [
      card('Outstanding', money(out.reduce((s, i) => s + Number(i.total), 0)), `${out.length} issued invoices`, 'warning'), card('Overdue >30 d', overdue.length, money(overdue.reduce((s, i) => s + Number(i.total), 0)), overdue.length ? 'error' : 'success'),
      card('Drafts', inv.filter((i) => i.status === 'DRAFT').length, 'awaiting issue'), card('Collected MTD', money(inv.filter((i) => i.paid_at && i.paid_at >= new Date(now.getFullYear(), now.getMonth(), 1)).reduce((s, i) => s + Number(i.total), 0)), '', 'success'),
      card('Invoices raised', nf(inv.length), `since ${first}`), card('Billed to date', money(billedAll), 'issued + paid, all years'),
      card('Collection rate', `${collPct}%`, 'of everything billed', collPct >= 95 ? 'success' : 'warning'), card('Billed YTD', money(billedYtd), `${now.getFullYear()} to date`),
    ];
  } },
  risk: { perm: 'risk.view', compute: async (pool, user) => {
    const rows = await many<{ score: string; band: string }>(pool, `SELECT (registry->>'riskScore') AS score, (registry->>'riskBand') AS band FROM ${from(user, 'rm_vessels', VESSEL_SCOPE)} WHERE status = 'ACTIVE'`);
    const scored = rows.filter((r) => r.score !== null);
    const avg = scored.length ? Math.round(scored.reduce((s, r) => s + Number(r.score), 0) / scored.length) : 0;
    return [card('High risk', scored.filter((r) => r.band === 'HIGH').length, 'priority targets', 'error'), card('Medium risk', scored.filter((r) => r.band === 'MEDIUM').length, '', 'warning'), card('Low risk', scored.filter((r) => r.band === 'LOW').length, '', 'success'), card('Fleet average', avg, 'score across active fleet')];
  } },
  masters: { perm: 'masters.view', compute: async (pool, user) => {
    const [b, lk, t, c, craft] = await Promise.all([count(pool, `SELECT count(*) AS n FROM ${from(user, 'rm_berths', BERTH_SCOPE)}`), one<{ n: string; cats: string }>(pool, 'SELECT COALESCE(sum(entries),0) AS n, count(*) AS cats FROM rm_lookup_counts'), one<{ n: string; revs: string }>(pool, `SELECT count(*) FILTER (WHERE active) AS n, COALESCE(sum(jsonb_array_length(revisions)),0) AS revs FROM ${from(user, 'rm_tariffs', TARIFF_SCOPE)}`), one<{ n: string; qs: string }>(pool, `SELECT count(*) AS n, COALESCE(sum(items),0) AS qs FROM ${from(user, 'rm_checklists', CHECKLIST_SCOPE)}`), count(pool, `SELECT count(*) AS n FROM ${from(user, 'rm_resources', RESOURCE_SCOPE)}`)]);
    return [card('Berths', b), card('Lookup entries', nf(Number(lk?.n))), card('Active tariffs', Number(t?.n ?? 0)), card('Checklist templates', Number(c?.n ?? 0)), card('Reference categories', Number(lk?.cats ?? 0), 'distinct lookup sets'), card('Tariff revisions', nf(Number(t?.revs)), 'rate changes published'), card('Checklist questions', nf(Number(c?.qs)), 'across all templates'), card('Marine craft', craft, 'tugs, launches, pilots')];
  } },
  users: { perm: 'users.view', compute: async (pool, user) => {
    const users = await many<{ active: boolean; last_login_at: Date | null; department: string | null; role_name: string | null }>(pool, `SELECT active, last_login_at, department, role_name FROM ${from(user, 'rm_users', USER_SCOPE)}`);
    const dormant = users.filter((u) => u.last_login_at && Date.now() - u.last_login_at.getTime() > 90 * D).length;
    return [
      card('Users', users.length, 'accounts'), card('Active', users.filter((u) => u.active).length, '', 'success'), card('Disabled', users.filter((u) => !u.active).length, ''),
      card('Signed in ≤7 d', users.filter((u) => u.last_login_at && Date.now() - u.last_login_at.getTime() < 7 * D).length, 'recent activity'),
      card('Departments', new Set(users.map((u) => u.department).filter(Boolean)).size, 'represented'), card('Roles in use', new Set(users.map((u) => u.role_name).filter(Boolean)).size, 'distinct permission sets'),
      card('Never signed in', users.filter((u) => !u.last_login_at).length, 'accounts pending first use'), card('Dormant >90 d', dormant, 'candidates for review', dormant ? 'warning' : 'success'),
    ];
  } },
  tariffs: { perm: 'tariffs.view', compute: async (pool, user) => {
    const items = await many<{ code: string; category: string; unit: string; active: boolean; revisions: { effectiveFrom: string; changePct: number }[] }>(pool, `SELECT code, category, unit, active, revisions FROM ${from(user, 'rm_tariffs', TARIFF_SCOPE)}`);
    const revs = items.flatMap((t) => t.revisions.map((r) => ({ ...r, code: t.code })));
    const dated = revs.filter((r) => r.effectiveFrom).sort((a, b) => new Date(a.effectiveFrom).getTime() - new Date(b.effectiveFrom).getTime());
    const last = dated[dated.length - 1]; const rises = revs.filter((r) => typeof r.changePct === 'number');
    const avgRise = rises.length ? Math.round((rises.reduce((s, r) => s + r.changePct, 0) / rises.length) * 10) / 10 : 0;
    return [
      card('Tariff items', items.length, 'published schedule'), card('Active', items.filter((t) => t.active !== false).length, 'currently chargeable', 'success'),
      card('Rate revisions', nf(revs.length), `published since ${dated.length ? new Date(dated[0].effectiveFrom).getFullYear() : '—'}`), card('Last revision', last ? dayMonthYear(last.effectiveFrom) : '—', last ? `${last.code} ${last.changePct > 0 ? '+' : ''}${last.changePct}%` : ''),
      card('Avg revision', `${avgRise > 0 ? '+' : ''}${avgRise}%`, 'per published change'), card('Marine services', items.filter((t) => t.category === 'MARINE').length, 'pilotage, towage, dues'),
      card('Cargo tariffs', items.filter((t) => t.category === 'CARGO').length, 'handling & storage'), card('Charging units', new Set(items.map((t) => t.unit)).size, 'distinct bases of charge'),
    ];
  } },
  marine: { perm: 'portcalls.view', compute: async (pool, user) => {
    const now = Date.now();
    const craft = await many<{ status: string; jobs: { at: string; hours: number }[]; outages: { from: string; days: number }[] }>(pool, `SELECT status, jobs, outages FROM ${from(user, 'rm_resources', RESOURCE_SCOPE)}`);
    const jobs = craft.flatMap((r) => r.jobs); const dated = jobs.filter((j) => j.at).map((j) => new Date(j.at).getTime());
    const j30 = jobs.filter((j) => j.at && new Date(j.at).getTime() >= now - 30 * D).length; const hours = jobs.reduce((s, j) => s + (j.hours || 0), 0);
    const outDays = craft.reduce((s, r) => s + r.outages.filter((o) => new Date(o.from).getTime() >= now - 365 * D).reduce((t, o) => t + (o.days || 0), 0), 0);
    const avail = craft.length ? Math.max(0, Math.round((1 - outDays / (craft.length * 365)) * 1000) / 10) : 100;
    return [
      card('Craft & pilots', craft.length, 'on the port roster'), card('Available', craft.filter((r) => r.status === 'AVAILABLE').length, 'ready to task', 'success'),
      card('Tasked now', craft.filter((r) => r.status === 'TASKED').length, 'on a job', 'warning'), card('Maintenance', craft.filter((r) => r.status === 'MAINTENANCE').length, 'survey or repair'),
      card('Jobs on record', nf(jobs.length), `since ${dated.length ? monthYear(new Date(Math.min(...dated))) : '—'}`), card('Assist hours', nf(Math.round(hours)), 'logged across the fleet'),
      card('Jobs (30 d)', nf(j30), 'recent taskings'), card('Fleet availability', `${avail}%`, `${Math.round(outDays)} craft-days lost, 12 m`, avail < 95 ? 'warning' : 'success'),
    ];
  } },
  audit: { perm: 'audit.view', compute: async (pool) => {
    const now = new Date(); const dayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()); const d7 = new Date(now.getTime() - 7 * D); const d30 = new Date(now.getTime() - 30 * D);
    const [total, first, today, week, active, logins, changes, top] = await Promise.all([
      count(pool, 'SELECT count(*) AS n FROM rm_audit_activity'), one<{ at: Date }>(pool, 'SELECT min(at) AS at FROM rm_audit_activity'),
      count(pool, 'SELECT count(*) AS n FROM rm_audit_activity WHERE at >= $1', [dayStart]), count(pool, 'SELECT count(*) AS n FROM rm_audit_activity WHERE at >= $1', [d7]),
      count(pool, 'SELECT count(DISTINCT actor_id) AS n FROM rm_audit_activity WHERE at >= $1 AND actor_id IS NOT NULL', [d30]), count(pool, "SELECT count(*) AS n FROM rm_audit_activity WHERE action = 'LOGIN' AND at >= $1", [d30]),
      count(pool, "SELECT count(*) AS n FROM rm_audit_activity WHERE action IN ('CREATE','UPDATE','DELETE') AND at >= $1", [d30]),
      many<{ entity: string; n: string }>(pool, 'SELECT entity, count(*) AS n FROM rm_audit_activity GROUP BY entity ORDER BY n DESC'),
    ]);
    return [
      card('Entries', nf(total), `since ${monthYear(first?.at)}`), card('Today', nf(today), 'recorded so far'), card('Last 7 days', nf(week), 'rolling week'), card('Active users', active, 'left a trail in 30 days'),
      card('Entities covered', top.length, 'modules under audit'), card('Sign-ins (30 d)', nf(logins), 'authenticated sessions'), card('Changes (30 d)', nf(changes), 'create, update, delete'), card('Most-touched', top[0]?.entity ?? '—', top[0] ? `${nf(Number(top[0].n))} entries` : ''),
    ];
  } },
};

/** Stat strips are re-read on every page open and change only when a projection lands, so they are cached. */
export const STATS_CACHE_PREFIX = 'stats';

@Controller('stats')
export class StatsController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_CACHE) private readonly cache: Cache, @Inject(KIT_ENV) private readonly env: BaseEnv) {}
  @Get(':scope')
  async get(@Param('scope') scope: string, @CurrentUser() user: Principal) {
    const s = SCOPES[scope]; if (!s) throw notFound(`Unknown stats scope "${scope}"`);
    /* The permission is checked before the cache is consulted, not after: a cached answer must never be the
     * thing that decides whether a reader was allowed to ask. */
    if (!hasPerm(user.perms, s.perm)) throw forbidden('Missing permission: ' + s.perm);
    /* The key carries the reader's scope and permissions, so one tenant's numbers cannot be served to
     * another. See `scopedKey` — the scope is hashed into the key rather than trusted to the caller. */
    const key = scopedKey(user, STATS_CACHE_PREFIX, scope);
    const cards = await this.cache.wrap(key, this.env.CACHE_TTL_SEC, () => s.compute(this.pool, user));
    return { cards };
  }
}
