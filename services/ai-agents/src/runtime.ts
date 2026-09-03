import type { PoolClient } from 'pg';
import type { Actor, EventEnvelope } from '@maritime/contracts';
import type { AuditClient } from '@maritime/service-kit';
import {
  customerGuidance, documentIntelligence, maritimeIntelligence, regulatoryIntelligence, serviceProcessing, smartInspection, vesselCompliance,
  type WorldIncident, type WorldInspection, type WorldLegalInstrument, type WorldLicence, type WorldServiceDefinition, type WorldServiceRequest,
  type WorldVessel, type WorldVesselCertificate,
} from '@maritime/world';
import type { Env } from './env';
import type { Effect } from './autonomy';
import { recordDecision, type DecisionApi, type Judgement } from './decisions';
import { type AgentRecord, type Row } from './registry';

/* The runtime: the only part of the agent layer that touches a database.
 *
 * It gathers the records an agent is responsible for from the local snapshots, hands each to the pure judgement
 * that belongs to it, classifies what acting on that judgement would actually do to the world, and passes both
 * to the recorder — which applies the autonomy ladder. Nothing here decides whether a conclusion takes effect;
 * that is deliberately somewhere else, because an agent that could choose its own latitude would not have one. */

export interface RunDeps { env: Env; audit?: AuditClient }
export interface RunOptions { limit?: number; subjectId?: string; cause?: EventEnvelope; actor?: Actor; now?: Date }

const started = () => process.hrtime.bigint();
const elapsed = (t0: bigint) => Number(process.hrtime.bigint() - t0) / 1e6;
const merge = <T,>(payload: Row, extra: Row): T => ({ ...(payload ?? {}), ...extra }) as T;
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

/* ---------------------------------------------------------------- reading the snapshots --- */

async function vesselsFor(c: PoolClient, opts: RunOptions): Promise<WorldVessel[]> {
  const args: unknown[] = [];
  let where = `WHERE NOT real AND status = 'ACTIVE'`;
  if (opts.subjectId) { args.push(opts.subjectId); where = `WHERE id = $${args.length}`; }
  args.push(opts.limit ?? 12);
  const r = await c.query<Row>(`SELECT id, imo, name, type, flag, built, grt, class_society, status, payload FROM vessels ${where} ORDER BY name LIMIT $${args.length}`, args);
  return r.rows.map((v) => merge<WorldVessel>(v.payload, {
    id: v.id, imo: v.imo, name: v.name, type: v.type, flag: v.flag, built: Number(v.built) || 0, grt: Number(v.grt) || 0, classSociety: v.class_society, status: v.status,
  }));
}
async function certificatesOf(c: PoolClient, vesselIds: string[]): Promise<Map<string, WorldVesselCertificate[]>> {
  const out = new Map<string, WorldVesselCertificate[]>();
  if (!vesselIds.length) return out;
  const r = await c.query<Row>('SELECT id, vessel_id, cert_type, issue_date, expiry_date, state, payload FROM vessel_certificates WHERE vessel_id = ANY($1)', [vesselIds]);
  for (const x of r.rows) {
    const cert = merge<WorldVesselCertificate>(x.payload, { id: x.id, vesselId: x.vessel_id, certType: x.cert_type, issueDate: iso(x.issue_date)?.slice(0, 10), expiryDate: iso(x.expiry_date)?.slice(0, 10), state: x.state });
    const list = out.get(x.vessel_id) ?? []; list.push(cert); out.set(x.vessel_id, list);
  }
  return out;
}
async function inspectionsOf(c: PoolClient, vesselIds: string[]): Promise<Map<string, WorldInspection[]>> {
  const out = new Map<string, WorldInspection[]>();
  if (!vesselIds.length) return out;
  const r = await c.query<Row>('SELECT id, number, vessel_id, type, status, result, detention, planned_at, started_at, closed_at, findings, payload FROM inspections WHERE vessel_id = ANY($1)', [vesselIds]);
  for (const x of r.rows) {
    const i = merge<WorldInspection>(x.payload, {
      id: x.id, number: x.number, vesselId: x.vessel_id, type: x.type, status: x.status, result: x.result, detention: x.detention,
      plannedAt: iso(x.planned_at), startedAt: iso(x.started_at), closedAt: iso(x.closed_at), findings: x.findings ?? [],
    });
    const list = out.get(x.vessel_id) ?? []; list.push(i); out.set(x.vessel_id, list);
  }
  return out;
}
async function instrumentsOf(c: PoolClient, vesselIds: string[]): Promise<Map<string, WorldLicence[]>> {
  const out = new Map<string, WorldLicence[]>();
  if (!vesselIds.length) return out;
  const r = await c.query<Row>(`SELECT id, licence_no, entity_type, subject_kind, subject_id, status, issue_date, expiry_date, payload FROM instruments WHERE subject_kind = 'VESSEL' AND subject_id = ANY($1)`, [vesselIds]);
  for (const x of r.rows) {
    const l = merge<WorldLicence>(x.payload, {
      id: x.id, licenseNo: x.licence_no, entityType: x.entity_type, subjectKind: x.subject_kind, subjectId: x.subject_id, status: x.status,
      issueDate: iso(x.issue_date)?.slice(0, 10) ?? null, expiryDate: iso(x.expiry_date)?.slice(0, 10) ?? null,
    });
    const list = out.get(x.subject_id) ?? []; list.push(l); out.set(x.subject_id, list);
  }
  return out;
}
const OPEN_REQUEST = ['SUBMITTED', 'UNDER_ASSESSMENT', 'INFO_REQUESTED'];
async function openRequests(c: PoolClient, opts: RunOptions): Promise<WorldServiceRequest[]> {
  const args: unknown[] = [];
  let where = 'WHERE status = ANY($1)'; args.push(OPEN_REQUEST);
  if (opts.subjectId) { args.length = 0; args.push(opts.subjectId); where = `WHERE id = $1 OR request_no = $1`; }
  args.push(opts.limit ?? 12);
  const r = await c.query<Row>(`SELECT payload FROM service_requests ${where} ORDER BY submitted_at DESC NULLS LAST, request_no LIMIT $${args.length}`, args);
  return r.rows.map((x) => x.payload as WorldServiceRequest).filter((x) => x && x.id);
}
async function definitionsById(c: PoolClient): Promise<Map<string, WorldServiceDefinition>> {
  const r = await c.query<Row>('SELECT id, payload FROM service_definitions');
  return new Map(r.rows.map((x) => [x.id, x.payload as WorldServiceDefinition]));
}
async function priorRequests(c: PoolClient, applicant: string, exceptId: string): Promise<number> {
  if (!applicant) return 0;
  const r = await c.query<{ n: string }>('SELECT count(*)::int AS n FROM service_requests WHERE applicant = $1 AND id <> $2', [applicant, exceptId]);
  return Number(r.rows[0]?.n ?? 0);
}

/* ------------------------------------------------------------------------ the cohorts --- */

/* The dimensions the records themselves carry. They are stored on every decision so outcomes can be compared
 * across cohorts later: a flag state whose ships are escalated far more often than the fleet average is the
 * thing a bias audit is for, and it cannot be found unless the dimension was written down at the time. */
const ageBand = (built: number, now: Date) => {
  const age = built ? now.getUTCFullYear() - built : 0;
  return !built ? 'UNKNOWN' : age <= 5 ? '0-5' : age <= 10 ? '6-10' : age <= 20 ? '11-20' : '20+';
};
export const vesselCohort = (v: WorldVessel, now: Date): Row => ({ flag: v.flag || 'UNKNOWN', vesselType: v.type || 'UNKNOWN', ageBand: ageBand(v.built, now), classSociety: v.classSociety || 'UNKNOWN' });
export const requestCohort = (r: WorldServiceRequest): Row => ({ serviceCode: r.serviceCode || 'UNKNOWN', subjectKind: r.subjectKind || 'NONE', applicantKind: r.applicant?.organisation ? 'ORGANISATION' : 'INDIVIDUAL' });

/* --------------------------------------------------------------------- what it would do --- */

/* An agent's latitude is only meaningful against what the action would actually change. A conclusion that is
 * merely recorded is advisory; one that moves an application forward is reversible; one that puts a licence on
 * the register is not, and no rung on the ladder lets an agent do that alone. */
export function effectOf(agentId: string, judgement: Judgement): Effect {
  const out = judgement.output ?? {};
  switch (agentId) {
    case 'a1_document_intelligence': return out.complete ? 'REVERSIBLE' : 'ADVISORY';
    case 'a2_vessel_compliance': return Array.isArray(out.notInForce) && out.notInForce.length ? 'REVERSIBLE' : 'ADVISORY';
    case 'a3_service_processing': return out.eligible ? 'IRREVERSIBLE' : 'ADVISORY';
    case 'a4_customer_guidance': return 'ADVISORY';
    case 'a5_smart_inspection': return out.board ? 'REVERSIBLE' : 'ADVISORY';
    case 'a6_regulatory_intelligence': return 'ADVISORY';
    case 'a7_maritime_intelligence': return out.level && out.level !== 'NORMAL' ? 'REVERSIBLE' : 'ADVISORY';
    default: return 'ADVISORY';
  }
}

/* ------------------------------------------------------------------------ the runners --- */

type Runner = (c: PoolClient, deps: RunDeps, agent: AgentRecord, opts: RunOptions) => Promise<{ judgement: Judgement; cohort: Row; latencyMs: number }[]>;

const RUNNERS: Record<string, Runner> = {
  /** A1 — every application whose documents are not yet trusted. */
  async a1_document_intelligence(c, _deps, _agent, opts) {
    const now = opts.now ?? new Date();
    const requests = await openRequests(c, opts);
    const defs = await definitionsById(c);
    const vesselIds = requests.map((r) => (r.subjectKind === 'VESSEL' && r.subjectId ? String(r.subjectId) : '')).filter(Boolean);
    const certs = await certificatesOf(c, vesselIds);
    const vessels = new Map((await c.query<Row>('SELECT id, payload FROM vessels WHERE id = ANY($1)', [vesselIds])).rows.map((x) => [x.id, x.payload as WorldVessel]));
    return requests.map((r) => {
      const t0 = started();
      const v = r.subjectKind === 'VESSEL' && r.subjectId ? vessels.get(String(r.subjectId)) : undefined;
      const judgement = documentIntelligence(r, defs.get(String(r.serviceId)), v, v ? certs.get(v.id) ?? [] : [], now);
      return { judgement, cohort: requestCohort(r), latencyMs: elapsed(t0) };
    });
  },
  /** A2 — the registered fleet, rescored against certificates, findings, detentions and instruments. */
  async a2_vessel_compliance(c, _deps, _agent, opts) {
    const now = opts.now ?? new Date();
    const vessels = await vesselsFor(c, opts);
    const ids = vessels.map((v) => v.id);
    const certs = await certificatesOf(c, ids); const inspections = await inspectionsOf(c, ids); const instruments = await instrumentsOf(c, ids);
    return vessels.map((v) => {
      const t0 = started();
      const judgement = vesselCompliance(v, certs.get(v.id) ?? [], inspections.get(v.id) ?? [], instruments.get(v.id) ?? [], now);
      return { judgement, cohort: vesselCohort(v, now), latencyMs: elapsed(t0) };
    });
  },
  /** A3 — applications waiting on a decision, run through the eligibility gates. */
  async a3_service_processing(c, _deps, _agent, opts) {
    const requests = await openRequests(c, opts);
    const defs = await definitionsById(c);
    const out = [];
    for (const r of requests) {
      const t0 = started();
      const priors = await priorRequests(c, r.applicant?.name ?? '', r.id);
      const onRecord = !!r.subjectId;
      out.push({ judgement: serviceProcessing(r, defs.get(String(r.serviceId)), onRecord, priors), cohort: requestCohort(r), latencyMs: elapsed(t0) });
    }
    return out;
  },
  /** A4 — what an applicant is waiting to be told. */
  async a4_customer_guidance(c, _deps, _agent, opts) {
    const now = opts.now ?? new Date();
    const requests = await openRequests(c, opts);
    const defs = await definitionsById(c);
    return requests.map((r) => {
      const t0 = started();
      return { judgement: customerGuidance(r, defs.get(String(r.serviceId)), now), cohort: requestCohort(r), latencyMs: elapsed(t0) };
    });
  },
  /** A5 — boarding targets, with the dossier the boarding party gets. */
  async a5_smart_inspection(c, _deps, _agent, opts) {
    const now = opts.now ?? new Date();
    const vessels = await vesselsFor(c, opts);
    const ids = vessels.map((v) => v.id);
    const certs = await certificatesOf(c, ids); const inspections = await inspectionsOf(c, ids); const instruments = await instrumentsOf(c, ids);
    return vessels.map((v) => {
      const t0 = started();
      return { judgement: smartInspection(v, certs.get(v.id) ?? [], inspections.get(v.id) ?? [], instruments.get(v.id) ?? [], now), cohort: vesselCohort(v, now), latencyMs: elapsed(t0) };
    });
  },
  /** A6 — the register of instruments read for gaps and conflicts. */
  async a6_regulatory_intelligence(c, _deps, _agent, opts) {
    const now = opts.now ?? new Date();
    const all = (await c.query<Row>('SELECT payload FROM legal_instruments')).rows.map((x) => x.payload as WorldLegalInstrument).filter((x) => x && x.id);
    const services = [...(await definitionsById(c)).values()];
    const subset = opts.subjectId ? all.filter((i) => i.id === opts.subjectId || i.refNo === opts.subjectId) : all.filter((i) => i.type !== 'CONVENTION').slice(-(opts.limit ?? 12));
    return subset.map((i) => {
      const t0 = started();
      return { judgement: regulatoryIntelligence(i, all, services, now), cohort: { instrumentType: i.type || 'UNKNOWN', category: i.category || 'UNKNOWN' }, latencyMs: elapsed(t0) };
    });
  },
  /** A7 — one picture over the whole national record. */
  async a7_maritime_intelligence(c, _deps, _agent, opts) {
    const now = opts.now ?? new Date();
    const t0 = started();
    const vessels = (await c.query<Row>('SELECT id, imo, name, type, flag, built, payload FROM vessels WHERE NOT real')).rows
      .map((v) => merge<WorldVessel>(v.payload, { id: v.id, imo: v.imo, name: v.name, type: v.type, flag: v.flag, built: Number(v.built) || 0 }));
    const certs = (await c.query<Row>('SELECT id, vessel_id, cert_type, expiry_date, state FROM vessel_certificates')).rows
      .map((x) => ({ id: x.id, vesselId: x.vessel_id, certType: x.cert_type, expiryDate: iso(x.expiry_date)?.slice(0, 10), state: x.state } as unknown as WorldVesselCertificate));
    const incidents = (await c.query<Row>('SELECT id, number, title, type, severity, status, payload FROM incidents')).rows
      .map((x) => merge<WorldIncident>(x.payload, { id: x.id, number: x.number, title: x.title, type: x.type, severity: x.severity, status: x.status }));
    const inspections = (await c.query<Row>('SELECT id, number, vessel_id, type, status, result, detention, planned_at, started_at, findings, payload FROM inspections')).rows
      .map((x) => merge<WorldInspection>(x.payload, { id: x.id, number: x.number, vesselId: x.vessel_id, type: x.type, status: x.status, result: x.result, detention: x.detention, plannedAt: iso(x.planned_at), startedAt: iso(x.started_at), findings: x.findings ?? [] }));
    return [{ judgement: maritimeIntelligence(vessels, certs, incidents, inspections, now), cohort: { scope: 'NATIONAL' }, latencyMs: elapsed(t0) }];
  },
};

/** The agents that can be run by hand from the console; the analytics workforce runs on its own schedule. */
export const isRunnableAgent = (agentId: string) => Object.prototype.hasOwnProperty.call(RUNNERS, agentId);
export const RUNNABLE_AGENTS = Object.keys(RUNNERS);

/**
 * Run one agent over the records it is responsible for and record what it concluded. Every judgement is recorded
 * whatever its outcome — including the ones the ladder refuses to act on, which is the only way the escalation
 * queue and the drift metrics have anything to read.
 */
export async function runAgent(c: PoolClient, deps: RunDeps, agent: AgentRecord, opts: RunOptions = {}): Promise<DecisionApi[]> {
  const runner = RUNNERS[agent.agent_id];
  if (!runner) return [];
  const results = await runner(c, deps, agent, { ...opts, limit: opts.limit ?? deps.env.RUN_BATCH });
  const out: DecisionApi[] = [];
  for (const r of results) {
    const { decision } = await recordDecision(c, deps.env, {
      agent, judgement: r.judgement, effect: effectOf(agent.agent_id, r.judgement), cohort: r.cohort, latencyMs: r.latencyMs, at: opts.now,
    }, { cause: opts.cause, actor: opts.actor, audit: deps.audit });
    out.push(decision);
  }
  return out;
}
