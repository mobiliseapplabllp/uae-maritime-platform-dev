import { DEFAULT_RISK_WEIGHTS } from '@maritime/contracts';
import type { Queryable } from '@maritime/service-kit';
import { certApi, type CertApi, type CertRow, type VesselRow } from './vessels';

/* The explainable vessel risk model.
 *
 * Every point traces to a record, so a score can be argued with: each factor carries the evidence sentence
 * the surveyor would check it against. Weights are policy, kept in the settings table and audited on every
 * change; raising one factor lowers the relative influence of the rest because the total is normalised. */

const YEAR = 365 * 86_400_000;
const MONTH = 30 * 86_400_000;
export const WEIGHT_KEYS = Object.keys(DEFAULT_RISK_WEIGHTS) as (keyof typeof DEFAULT_RISK_WEIGHTS)[];
export const WEIGHT_MAX = 50;
export type RiskWeights = Record<string, number>;
export interface RiskFactor { key: string; label: string; points: number; max: number; evidence: string }
export interface RiskRow { vesselId: string; name: string; imo: string; type: string; flag: string; built: number | null; agent: string; score: number; band: 'LOW' | 'MEDIUM' | 'HIGH'; factors: RiskFactor[] }
export interface InspectionFact { vessel_id: string; result: string | null; detention: boolean; open_findings: number; closed_at: Date | null }

export const bandOf = (score: number): RiskRow['band'] => (score >= 60 ? 'HIGH' : score >= 35 ? 'MEDIUM' : 'LOW');

export async function loadWeights(c: Queryable): Promise<RiskWeights> {
  const r = await c.query<{ value: RiskWeights }>(`SELECT value FROM ships_settings WHERE key = 'riskWeights'`);
  return { ...DEFAULT_RISK_WEIGHTS, ...(r.rows[0]?.value ?? {}) };
}
export async function saveWeights(c: Queryable, weights: RiskWeights): Promise<void> {
  await c.query(`INSERT INTO ships_settings(key, value) VALUES ('riskWeights', $1) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [JSON.stringify(weights)]);
}

/** Agent fleet performance: the share of an agent's inspections that ended badly, across the whole fleet they represent. */
export function agentStats(vessels: VesselRow[], byVessel: Map<string, InspectionFact[]>) {
  const out = new Map<string, { inspections: number; bad: number }>();
  for (const v of vessels) {
    const ins = byVessel.get(v.id) ?? [];
    const s = out.get(v.agent_code) ?? { inspections: 0, bad: 0 };
    s.inspections += ins.length;
    s.bad += ins.filter((i) => i.detention || i.result === 'DEFICIENCIES').length;
    out.set(v.agent_code, s);
  }
  return out;
}

/** One ship's score, decomposed. `certs` is her certificate list with expiry states already derived. */
export function scoreVessel(v: VesselRow, certs: CertApi[], ins: InspectionFact[], agents: Map<string, { inspections: number; bad: number }>, weights: RiskWeights, now = new Date()): RiskRow {
  const factors: RiskFactor[] = [];
  const add = (key: string, label: string, ratio: number, evidence: string) => {
    const weight = weights[key] ?? 0;
    factors.push({ key, label, points: Math.round(Math.min(1, Math.max(0, ratio)) * weight * 10) / 10, max: weight, evidence });
  };

  const age = now.getUTCFullYear() - (v.built ?? now.getUTCFullYear());
  add('age', 'Vessel age', age >= 25 ? 1 : age >= 15 ? 0.6 : age >= 10 ? 0.3 : 0.1, `${age} years (built ${v.built ?? '—'})`);

  const expired = certs.filter((c) => c.status === 'EXPIRED').length;
  const expiring = certs.filter((c) => c.status === 'EXPIRING').length;
  add('certificates', 'Statutory certificates', expired ? 1 : expiring ? 0.5 : 0, expired ? `${expired} expired` : expiring ? `${expiring} expiring within the warning window` : 'all valid');

  const openDef = ins.reduce((s, i) => s + (Number(i.open_findings) || 0), 0);
  add('deficiencies', 'Open deficiencies', openDef / 3, `${openDef} open finding(s)`);

  const t = now.getTime();
  const detained = ins.some((i) => i.detention && i.closed_at && t - new Date(i.closed_at).getTime() < 2 * YEAR);
  const defHistory = ins.some((i) => i.result === 'DEFICIENCIES' && i.closed_at && t - new Date(i.closed_at).getTime() < YEAR);
  add('detentions', 'Detention history', detained ? 1 : defHistory ? 0.4 : 0, detained ? 'detained within 24 months' : defHistory ? 'deficiencies within 12 months' : 'clean 24-month record');

  const lastClosed = ins.filter((i) => i.closed_at).sort((a, b) => new Date(b.closed_at!).getTime() - new Date(a.closed_at!).getTime())[0];
  const gapMonths = lastClosed ? (t - new Date(lastClosed.closed_at!).getTime()) / MONTH : 24;
  add('inspectionGap', 'Time since inspection', gapMonths / 12, lastClosed ? `${Math.round(gapMonths)} month(s) since ${lastClosed.result || 'last inspection'}` : 'never inspected here');

  const ag = agents.get(v.agent_code) ?? { inspections: 0, bad: 0 };
  add('agentPerformance', 'Agent fleet record', ag.inspections ? ag.bad / ag.inspections : 0.3, ag.inspections ? `${ag.bad}/${ag.inspections} adverse across agent fleet` : 'no fleet history');

  const maxTotal = WEIGHT_KEYS.reduce((s, k) => s + (weights[k] ?? 0), 0) || 1;
  const raw = factors.reduce((s, f) => s + f.points, 0);
  const score = Math.round((raw / maxTotal) * 100);
  return { vesselId: v.id, name: v.name, imo: v.imo, type: v.type, flag: v.flag, built: v.built, agent: v.agent_code, score, band: bandOf(score), factors: factors.sort((a, b) => b.points - a.points) };
}

/** The whole active fleet, scored and ordered highest first. */
export function scoreFleet(vessels: VesselRow[], certsByVessel: Map<string, CertApi[]>, inspections: InspectionFact[], weights: RiskWeights, now = new Date()): RiskRow[] {
  const byVessel = new Map<string, InspectionFact[]>();
  for (const i of inspections) { const l = byVessel.get(i.vessel_id) ?? []; l.push(i); byVessel.set(i.vessel_id, l); }
  const agents = agentStats(vessels, byVessel);
  return vessels.map((v) => scoreVessel(v, certsByVessel.get(v.id) ?? [], byVessel.get(v.id) ?? [], agents, weights, now)).sort((a, b) => b.score - a.score);
}

/** The whole active fleet scored from the records this service holds — shared by the register list and the risk screens. */
export async function computeScores(c: Queryable, windowDays: number, now = new Date()): Promise<{ rows: RiskRow[]; weights: RiskWeights }> {
  const weights = await loadWeights(c);
  const vessels = (await c.query<VesselRow>(`SELECT * FROM vessels WHERE status = 'ACTIVE'`)).rows;
  const certRows = (await c.query<CertRow>('SELECT * FROM vessel_certificates')).rows;
  const certs = new Map<string, CertApi[]>();
  for (const r of certRows) { const l = certs.get(r.vessel_id) ?? []; l.push(certApi(r, now, windowDays)); certs.set(r.vessel_id, l); }
  const ins = (await c.query<InspectionFact>('SELECT vessel_id, result, detention, open_findings, closed_at FROM inspections')).rows;
  return { rows: scoreFleet(vessels, certs, ins, weights, now), weights };
}
