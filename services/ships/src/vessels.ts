import { type TenancyScope, EVENTS, getJurisdiction, makeEvent, type Actor, type EventEnvelope } from '@maritime/contracts';
import { certStatus } from '@maritime/world';
import { scopeWhere, enqueue, eventFromContext, type Queryable, recordScope } from '@maritime/service-kit';
import { VESSEL_SCOPE } from './scope';
import type { Env } from './env';

/* The fleet record and the certificate list that hangs off it.
 *
 * A ship's standing on the national register travels on the same row, but is written only by a granted
 * registration (see registry.ts) — everything here reads it. The certificate list is two things at once:
 * entries the fleet desk keeps by hand, and entries mirrored from the instrument register. The second kind
 * is read-only, because the register, not the ship's own list, is the authority on what it issued. */

export type Row = Record<string, any>;
export const D = 86_400_000;
export const iso = (v: Date | string | null | undefined): string | null => (v == null ? null : new Date(v).toISOString());
export const num = (v: unknown): number | null => (v == null || v === '' ? null : Number(v));
export const round1 = (n: number) => Math.round(n * 10) / 10;

export const VESSEL_TYPES = ['CONT', 'BULK', 'TANK', 'GEN', 'RORO', 'OSV', 'PASS', 'TUG', 'DREDGER', 'OTHER'] as const;
export const VESSEL_STATUS = ['ACTIVE', 'INACTIVE'] as const;

export interface VesselRow {
  /** Tenancy partition, projected into the read models so reporting enforces the same predicate. */ scope_company: string;
  id: string; name: string; imo: string; mmsi: string; call_sign: string; flag: string; type: string; built: number | null;
  dwt: number | null; grt: number; loa: string | number | null; beam: string | number | null; max_draft: string | number | null;
  owner: string; operator: string; manager: string; agent_code: string; class_society: string; pi_club: string; port_of_registry: string; yard: string;
  engine: Row; service_speed_kn: string | number | null; teu_capacity: number | null; last_dry_dock: Date | null; next_dry_dock: Date | null;
  liner: boolean; real: boolean; status: string; remarks: string;
  registry_state: string; official_number: string; registry_port: string; certificate_no: string;
  registered_on: Date | null; certificate_expires_on: Date | null; closed_on: Date | null; closure_reason: string;
  created_at: Date; updated_at: Date;
}
export interface CertRow {
  id: string; vessel_id: string; cert_type: string; number: string; issuer: string; issue_date: Date | null; expiry_date: Date;
  remarks: string; instrument_id: string | null; on_register: boolean; in_force: boolean | null; force_reason: string; signed: boolean;
  endorsements_overdue: number; created_at: Date; updated_at: Date;
}

/** The certificate as the ship's record shows it: the expiry state is derived, never stored. */
export const certApi = (c: CertRow, now = new Date(), windowDays?: number) => ({
  id: c.id, certType: c.cert_type, number: c.number, issuer: c.issuer, issueDate: iso(c.issue_date), expiryDate: iso(c.expiry_date)!,
  remarks: c.remarks, status: certStatus(c.expiry_date, now, windowDays), instrumentId: c.instrument_id,
  onRegister: c.on_register, inForce: c.in_force, forceReason: c.force_reason, signed: c.signed, endorsementsOverdue: c.endorsements_overdue,
  /** An instrument-issued certificate is the register's record of it; the fleet desk may not edit or delete it here. */
  readOnly: !!c.instrument_id,
});
export type CertApi = ReturnType<typeof certApi>;

/** Where the ship stands on the national register, as the registry tab and the transcript read it. */
export function registryOf(v: VesselRow, profile: string) {
  const j = getJurisdiction(profile);
  const port = j.registry.portsOfRegistry.find((p) => p.code === v.registry_port);
  return {
    state: v.registry_state, officialNumber: v.official_number, portOfRegistry: v.registry_port, portOfRegistryName: port?.name ?? '',
    certificateNo: v.certificate_no, registeredOn: iso(v.registered_on), certificateExpiresOn: iso(v.certificate_expires_on),
    closedOn: iso(v.closed_on), closureReason: v.closure_reason,
  };
}

export interface VesselExtras { certificates?: CertApi[]; agentName?: string | null; riskScore?: number | null; riskBand?: string | null }
/** The ship as every screen and every read-model event sees her. */
export function vesselApi(v: VesselRow, profile: string, extra: VesselExtras = {}) {
  return {
    id: v.id, name: v.name, imo: v.imo, mmsi: v.mmsi, callSign: v.call_sign, flag: v.flag, type: v.type, built: v.built,
    dwt: v.dwt, grt: v.grt, loa: num(v.loa), beam: num(v.beam), maxDraft: num(v.max_draft),
    owner: v.owner, operator: v.operator, manager: v.manager, agent: v.agent_code, agentCode: v.agent_code, agentName: extra.agentName ?? null,
    classSociety: v.class_society, piClub: v.pi_club, portOfRegistry: v.port_of_registry, yard: v.yard,
    engine: v.engine ?? {}, serviceSpeedKn: num(v.service_speed_kn), teuCapacity: v.teu_capacity,
    lastDryDock: iso(v.last_dry_dock), nextDryDock: iso(v.next_dry_dock), liner: v.liner, real: v.real, status: v.status, remarks: v.remarks,
    registry: registryOf(v, profile), registryState: v.registry_state,
    riskScore: extra.riskScore ?? null, riskBand: extra.riskBand ?? null,
    certificates: extra.certificates ?? [],
    createdAt: iso(v.created_at), updatedAt: iso(v.updated_at),
  };
}
export type VesselApi = ReturnType<typeof vesselApi>;

/* Every handler that touches one ship comes through here, so the tenancy filter lives here rather than in
 * each of them: a ship another agent acts for is not found rather than found and refused. */
export async function findVessel(c: Queryable, ref: string, scope: TenancyScope): Promise<VesselRow | null> {
  const byId = /^[0-9a-f-]{36}$/i.test(ref);
  const where = [byId ? 'id = $1' : 'imo = $1']; const args: unknown[] = [ref];
  scopeWhere(scope, where, args, VESSEL_SCOPE);
  const r = await c.query<VesselRow>(`SELECT * FROM vessels WHERE ${where.join(' AND ')}`, args);
  return r.rows[0] ?? null;
}
export async function certsOf(c: Queryable, vesselId: string, now = new Date(), windowDays?: number): Promise<CertApi[]> {
  const r = await c.query<CertRow>('SELECT * FROM vessel_certificates WHERE vessel_id = $1 ORDER BY expiry_date', [vesselId]);
  return r.rows.map((x) => certApi(x, now, windowDays));
}
export async function agentNameOf(c: Queryable, code: string): Promise<string | null> {
  if (!code) return null;
  const r = await c.query<{ name: string }>('SELECT name FROM companies WHERE code = $1 LIMIT 1', [code]);
  return r.rows[0]?.name ?? null;
}
/** The ship with everything a read-model event carries. */
export async function vesselEntity(c: Queryable, env: Env, v: VesselRow, extra: Omit<VesselExtras, 'certificates' | 'agentName'> = {}): Promise<VesselApi> {
  return vesselApi(v, env.JURISDICTION, { ...extra, certificates: await certsOf(c, v.id, new Date(), env.CERT_EXPIRING_DAYS), agentName: await agentNameOf(c, v.agent_code) });
}

/** Every ship write publishes the API-shaped snapshot first, then the business event. */
export async function publishVessel(c: Queryable, env: Env, v: VesselRow, opts: { event?: string; data?: Row; cause?: EventEnvelope; actor?: Actor } = {}) {
  const entity = await vesselEntity(c, env, v);
  const mk = <T,>(type: string, data: T) => (opts.cause
    ? makeEvent({ type, source: env.SERVICE_NAME, data, subject: v.id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor })
    : eventFromContext(env.SERVICE_NAME, type, data, { subject: v.id, actor: opts.actor }));
  await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'vessel', entity: { ...entity, scope: recordScope(v) } }));
  if (opts.event) await enqueue(c, mk(opts.event, { vesselId: v.id, imo: v.imo, name: v.name, type: v.type, flag: v.flag, status: v.status, registry: entity.registry, vessel: entity, ...(opts.data ?? {}) }));
  return entity;
}
export async function publishVesselDeleted(c: Queryable, env: Env, v: VesselRow) {
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.deleted, { kind: 'vessel', id: v.id }, { subject: v.id }));
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.ships.vesselDeleted, { vesselId: v.id, imo: v.imo, name: v.name }, { subject: v.id }));
}
/** A certificate change is its own read-model kind as well as a change to the ship. */
export async function publishCertificate(c: Queryable, env: Env, v: VesselRow, cert: CertRow, event: string, data: Row = {}) {
  const entity = certApi(cert, new Date(), env.CERT_EXPIRING_DAYS);
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.upserted, { kind: 'vesselCertificate', entity: { ...entity, vesselId: v.id, vesselName: v.name, imo: v.imo, scope: recordScope(v) } }, { subject: cert.id }));
  await enqueue(c, eventFromContext(env.SERVICE_NAME, event, { vesselId: v.id, vesselName: v.name, imo: v.imo, certificateId: cert.id, certType: cert.cert_type, number: cert.number, expiryDate: iso(cert.expiry_date), status: entity.status, ...data }, { subject: cert.id }));
  await publishVessel(c, env, v);
}
export async function publishCertificateDeleted(c: Queryable, env: Env, v: VesselRow, cert: CertRow) {
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.deleted, { kind: 'vesselCertificate', id: cert.id }, { subject: cert.id }));
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.ships.certDeleted, { vesselId: v.id, vesselName: v.name, certificateId: cert.id, certType: cert.cert_type }, { subject: cert.id }));
  await publishVessel(c, env, v);
}

/* ------------------------------------------------------------------ voyages and movements --- */

export interface CallRow {
  id: string; vcn: string; vessel_id: string; status: string; eta: Date | null; etb: Date | null; etd: Date | null;
  ata: Date | null; atb: Date | null; atd: Date | null; berth_id: string | null; berth_code: string | null; berth_name: string | null;
  terminal: string | null; prev_port: string | null; next_port: string | null; purpose: string | null; cargo_ops: Row[]; status_history: Row[];
}
export const callApi = (c: CallRow) => ({
  id: c.id, vcn: c.vcn, status: c.status, eta: iso(c.eta), etb: iso(c.etb), etd: iso(c.etd), ata: iso(c.ata), atb: iso(c.atb), atd: iso(c.atd),
  berthCode: c.berth_code ?? '', berthName: c.berth_name ?? '', terminal: c.terminal ?? '', prevPort: c.prev_port ?? '', nextPort: c.next_port ?? '',
});
const qty = (n: unknown) => new Intl.NumberFormat('en-AE').format(Number(n) || 0);
/** The voyage ledger: the leg in and the leg out of every sailed call, with the trade lanes they add up to. */
export function voyagesOf(calls: CallRow[]) {
  const voyages = calls.map((c) => ({
    callId: c.id, vcn: c.vcn, fromPort: c.prev_port || '—', toPort: c.next_port || '—', arrived: iso(c.ata), sailed: iso(c.atd),
    berth: c.berth_code || '—', terminal: c.terminal || '—', purpose: c.purpose || '',
    cargo: (c.cargo_ops ?? []).map((o: Row) => `${o.operation === 'LOAD' ? 'Loaded' : 'Discharged'} ${qty(o.qty)} ${o.unit} ${o.cargoType}`).join('; '),
    portDays: c.ata && c.atd ? round1((new Date(c.atd).getTime() - new Date(c.ata).getTime()) / D) : null,
  }));
  const laneCount = new Map<string, number>();
  for (const c of calls) for (const p of [c.prev_port, c.next_port]) if (p) laneCount.set(p, (laneCount.get(p) ?? 0) + 1);
  const lanes = [...laneCount.entries()].map(([port, n]) => ({ port, calls: n })).sort((a, b) => b.calls - a.calls).slice(0, 8);
  return { voyages, lanes };
}
/** The port's own event trail for a ship, newest first. */
export const movementEventsOf = (calls: CallRow[]) => calls
  .flatMap((c) => (c.status_history ?? []).map((h: Row) => ({ at: iso(h.at)!, vcn: c.vcn, event: h.to as string, note: (h.note as string) || '' })))
  .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 40);

/* --------------------------------------------------------------------- survey planner --- */

const MONTH = 30.44 * D;
export type SurveyType = 'ANNUAL' | 'INTERMEDIATE' | 'SPECIAL' | 'DRY_DOCK';
export interface SurveyEvent { type: SurveyType; due: string; window: { from: string; to: string }; status: 'OVERDUE' | 'WINDOW_OPEN' | 'PLANNED' }
/** Class cycle windows: annuals on the anniversary of the last docking, an intermediate at 2.5 years, a special survey and docking at 5. */
export function surveyEvents(v: { built: number | null; last_dry_dock: Date | null }, now = Date.now(), horizonMonths = 24): SurveyEvent[] {
  const horizon = now + horizonMonths * MONTH;
  let anchor = v.last_dry_dock ? new Date(v.last_dry_dock).getTime() : Date.UTC(v.built ?? 2018, 5, 15);
  // roll old anchors forward by five-year cycles so every ship shows the cycle she is actually in
  while (anchor + 60 * MONTH < now) anchor += 60 * MONTH;
  const events: SurveyEvent[] = [];
  const push = (type: SurveyType, due: number, windowMonths: number) => {
    if (due < now - 6 * MONTH || due > horizon) return;
    const from = due - windowMonths * MONTH; const to = due + windowMonths * MONTH;
    events.push({ type, due: new Date(due).toISOString(), window: { from: new Date(from).toISOString(), to: new Date(to).toISOString() }, status: now > to ? 'OVERDUE' : now >= from ? 'WINDOW_OPEN' : 'PLANNED' });
  };
  for (let y = 1; y <= 6; y += 1) push('ANNUAL', anchor + y * 12 * MONTH, 3);
  push('INTERMEDIATE', anchor + 30 * MONTH, 3);
  push('SPECIAL', anchor + 60 * MONTH, 3);
  push('DRY_DOCK', anchor + 60 * MONTH, 2);
  return events.sort((a, b) => a.due.localeCompare(b.due));
}
export const surveyWindow = (now = Date.now(), horizonMonths = 24) => ({ horizonMonths, from: new Date(now - 6 * MONTH).toISOString(), to: new Date(now + horizonMonths * MONTH).toISOString() });

/* ------------------------------------------------------------------- fleet dashboard --- */

export const ageBandOf = (age: number) => (age <= 5 ? '0-5' : age <= 10 ? '6-10' : age <= 15 ? '11-15' : age <= 20 ? '16-20' : '>20');
export const AGE_BANDS = ['0-5', '6-10', '11-15', '16-20', '>20'] as const;
const tally = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
const listOf = <K extends string>(m: Map<string, number>, key: K) => [...m.entries()].map(([v, count]) => ({ [key]: v, count })).sort((a, b) => (b.count as number) - (a.count as number)) as ({ [P in K]: string } & { count: number })[];

/** The vessel module's landing analytics: the fleet mix, its age profile and where its certificates stand. */
export function fleetDashboard(vessels: (VesselRow & { certs: CertApi[] })[], activeCalls: { vessel_id: string; status: string }[], now = new Date()) {
  const fleet = vessels.filter((v) => v.status === 'ACTIVE');
  const byType = new Map<string, number>(); const byFlag = new Map<string, number>(); const byClass = new Map<string, number>();
  const bands = new Map<string, number>(AGE_BANDS.map((b) => [b, 0]));
  let valid = 0; let expiring = 0; let expired = 0;
  const alertVessels: { id: string; name: string; type: string; alerts: number }[] = [];
  for (const v of fleet) {
    tally(byType, v.type); tally(byFlag, v.flag || '—'); tally(byClass, v.class_society || '—');
    tally(bands, ageBandOf(now.getUTCFullYear() - (v.built ?? now.getUTCFullYear())));
    let alerts = 0;
    for (const c of v.certs) {
      if (c.status === 'VALID') valid += 1;
      else if (c.status === 'EXPIRING') { expiring += 1; alerts += 1; }
      else { expired += 1; alerts += 1; }
    }
    if (alerts) alertVessels.push({ id: v.id, name: v.name, type: v.type, alerts });
  }
  alertVessels.sort((a, b) => b.alerts - a.alerts);
  const statuses = activeCalls.map((c) => c.status);
  return {
    kpis: {
      fleet: fleet.length, inactive: vessels.length - fleet.length,
      inPort: statuses.filter((s) => s === 'BERTHED').length,
      inbound: statuses.filter((s) => s === 'ANNOUNCED' || s === 'CONFIRMED').length,
      atAnchor: statuses.filter((s) => s === 'AT_ANCHORAGE').length,
      avgAge: fleet.length ? Math.round(fleet.reduce((s, v) => s + (now.getUTCFullYear() - (v.built ?? now.getUTCFullYear())), 0) / fleet.length) : 0,
      totalDwt: fleet.reduce((s, v) => s + (v.dwt ?? 0), 0),
    },
    byType: listOf(byType, 'type'), byFlag: listOf(byFlag, 'flag'), byClass: listOf(byClass, 'cls'),
    ageBands: AGE_BANDS.map((band) => ({ band, count: bands.get(band) ?? 0 })),
    certs: { valid, expiring, expired },
    certAlertVessels: alertVessels.slice(0, 8),
  };
}

/* ---------------------------------------------------------------- the hover card --- */

/** What the entity hover card shows for a ship — the four facts that answer "which ship is this?". */
export function vesselCard(v: VesselRow, certs: CertApi[], profile: string) {
  const alerts = certs.filter((c) => c.status !== 'VALID').length;
  const reg = registryOf(v, profile);
  return {
    kind: 'vessel', title: v.name, subtitle: `IMO ${v.imo} · ${v.type}${v.flag ? ` · ${v.flag} flag` : ''}`, link: `/vessels/${v.id}`,
    chips: [
      { label: v.status === 'ACTIVE' ? 'Active' : 'Inactive', tone: v.status === 'ACTIVE' ? 'success' : 'default' },
      ...(reg.state !== 'UNREGISTERED' ? [{ label: reg.state === 'CLOSED' ? 'Registry closed' : reg.state === 'PROVISIONAL' ? 'Provisional' : 'Registered', tone: reg.state === 'REGISTERED' ? 'success' : reg.state === 'PROVISIONAL' ? 'warning' : 'error' }] : []),
      ...(alerts ? [{ label: `${alerts} certificate alert${alerts > 1 ? 's' : ''}`, tone: 'warning' }] : []),
    ],
    lines: [
      { label: 'Tonnage', value: `${v.grt} GT${v.dwt ? ` / ${v.dwt} DWT` : ''}` },
      { label: 'Built', value: v.built ? String(v.built) : null },
      { label: 'Class', value: v.class_society || null },
      { label: 'Official no.', value: reg.officialNumber || null },
    ],
  };
}
