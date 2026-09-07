import type { Pool, PoolClient } from 'pg';
import { getJurisdiction } from '@maritime/contracts';
import { declaredKinds, featureSetOf, type FeatureSet, type ModelDef } from './catalogue';
import { inferSchema, type FeatureSpec, type Row } from './gbdt';
import type { Env } from './env';

/*
 * A dataset is read, never stored as rows: each fit reads the records this server holds — projected from the same
 * read-model events every other service consumes — and builds its rows on the way. What is kept is the description of
 * what a fit saw (how many rows, how many positives, the schema, a sample), so a version can say what it was fitted on.
 */
export interface DatasetStats { rows: number; positives: number | null; labelMean: number; labelStd: number }
export interface Dataset {
  def: ModelDef; featureSet: FeatureSet; rows: Row[]; declared: Record<string, 'num' | 'cat'>;
  schema: FeatureSpec[]; stats: DatasetStats; sample: Row[]; builtAt: Date;
}
type Q = Pool | PoolClient;

const r3 = (n: number) => Math.round(n * 1000) / 1000;
const stats = (rows: Row[], task: ModelDef['task']): DatasetStats => {
  const n = rows.length || 1;
  const mean = rows.reduce((s, r) => s + r.label, 0) / n;
  const std = Math.sqrt(rows.reduce((s, r) => s + (r.label - mean) ** 2, 0) / n);
  return { rows: rows.length, positives: task === 'CLASSIFICATION' ? rows.filter((r) => r.label > 0.5).length : null, labelMean: r3(mean), labelStd: r3(std) };
};
const keep = (features: Record<string, unknown>, names: string[]) => Object.fromEntries(names.map((n) => [n, features[n] ?? null]));

/** Closed boardings of fictional ships, each with the ship as it stood on the day and its history before it. */
async function targetingRows(q: Q, env: Env): Promise<{ features: Record<string, unknown>; label: number }[]> {
  const r = await q.query<{ ship_age_years: number | null; days_since_last: string | null; prior_deficiencies: string; prior_detentions: string; ship_type: string; home_flag: boolean; label: boolean }>(
    `WITH insp AS (
       SELECT i.id, i.vessel_id, COALESCE(i.planned_at, i.closed_at) AS at, i.closed_at, i.detention, i.total_findings, v.type AS ship_type, v.flag, v.built
       FROM rm_inspections i JOIN rm_vessels v ON v.id = i.vessel_id
       WHERE i.subject_kind = 'VESSEL' AND i.status = 'CLOSED' AND i.closed_at IS NOT NULL AND v.real = false)
     SELECT CASE WHEN a.built IS NULL THEN NULL ELSE EXTRACT(YEAR FROM a.at)::int - a.built END AS ship_age_years,
       (SELECT EXTRACT(EPOCH FROM (a.at - max(b.closed_at))) / 86400 FROM insp b WHERE b.vessel_id = a.vessel_id AND b.closed_at < a.at) AS days_since_last,
       (SELECT COALESCE(sum(b.total_findings), 0) FROM insp b WHERE b.vessel_id = a.vessel_id AND b.closed_at < a.at) AS prior_deficiencies,
       (SELECT count(*) FROM insp b WHERE b.vessel_id = a.vessel_id AND b.closed_at < a.at AND b.detention) AS prior_detentions,
       a.ship_type, upper(a.flag) = upper($1) AS home_flag,
       (a.detention OR a.total_findings >= $2) AS label
     FROM insp a ORDER BY a.at, a.id`, [env.JURISDICTION, env.TARGETING_POSITIVE_FINDINGS]);
  return r.rows.map((x) => ({
    features: { shipAgeYears: x.ship_age_years, daysSinceLastInspection: x.days_since_last === null ? null : Math.round(Number(x.days_since_last)), priorDeficiencies: Number(x.prior_deficiencies), priorDetentions: Number(x.prior_detentions), shipType: x.ship_type || null, homeFlag: x.home_flag ? 'home' : 'foreign' },
    label: x.label ? 1 : 0,
  }));
}

/** Port calls that reached a berth, each as it was announced, labelled with the hours it then waited. */
async function arrivalRows(q: Q, env: Env): Promise<{ features: Record<string, unknown>; label: number }[]> {
  const tz = getJurisdiction(env.JURISDICTION).timezone;
  const r = await q.query<{ ship_type: string | null; agent_code: string; eta_hour: number; eta_weekday: number; queue_ahead: string; teu: number; cargo_mt: string; prev_port: string; hours: string }>(
    `SELECT COALESCE(NULLIF(p.vessel_type, ''), v.type) AS ship_type, p.agent_code, EXTRACT(HOUR FROM (p.eta AT TIME ZONE $1))::int AS eta_hour, EXTRACT(DOW FROM (p.eta AT TIME ZONE $1))::int AS eta_weekday,
       (SELECT count(*) FROM rm_port_calls q WHERE q.id <> p.id AND q.eta >= p.eta - interval '24 hours' AND q.eta < p.eta) AS queue_ahead,
       p.teu, p.cargo_mt, p.prev_port, LEAST($2::numeric, GREATEST(0, EXTRACT(EPOCH FROM (p.atb - p.eta)) / 3600)) AS hours
     FROM rm_port_calls p LEFT JOIN rm_vessels v ON v.id = p.vessel_id
     WHERE p.eta IS NOT NULL AND p.atb IS NOT NULL AND p.status IN ('BERTHED', 'SAILED') ORDER BY p.eta, p.id`, [tz, env.ETA_LABEL_MAX_HOURS]);
  return r.rows.map((x) => ({
    features: { shipType: x.ship_type || null, agentCode: x.agent_code || null, etaHour: x.eta_hour, etaWeekday: String(x.eta_weekday), queueAhead: Number(x.queue_ahead), teu: Number(x.teu), cargoMt: Math.round(Number(x.cargo_mt)), prevPort: x.prev_port || null },
    label: Math.round(Number(x.hours) * 100) / 100,
  }));
}

const READERS: Record<string, (q: Q, env: Env) => Promise<{ features: Record<string, unknown>; label: number }[]>> = {
  'inspection-targeting': targetingRows,
  'eta-prediction': arrivalRows,
};

/** The rows a model would be fitted on now, on one of its feature sets. */
export async function buildDataset(q: Q, env: Env, def: ModelDef, featureSet?: string): Promise<Dataset> {
  const set = featureSetOf(def, featureSet);
  if (!set) throw new Error(`model ${def.key} has no feature set "${featureSet}"`);
  const reader = READERS[def.key];
  if (!reader) throw new Error(`no reader for model ${def.key}`);
  const all = await reader(q, env);
  const rows: Row[] = all.map((r) => ({ features: keep(r.features, set.features), label: r.label }));
  const declared = declaredKinds(def, set);
  return { def, featureSet: set, rows, declared, schema: rows.length ? inferSchema(rows, declared) : [], stats: stats(rows, def.task), sample: rows.slice(-20), builtAt: new Date() };
}

/** Writes the description of a dataset and answers its id. */
export async function recordDataset(c: PoolClient, d: Dataset, note = ''): Promise<string> {
  const r = await c.query<{ id: string }>(
    `INSERT INTO datasets(model_key, built_at, rows, positives, label_mean, label_std, feature_schema, sample, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
    [d.def.key, d.builtAt, d.stats.rows, d.stats.positives, d.stats.labelMean, d.stats.labelStd, JSON.stringify(d.schema), JSON.stringify(d.sample), note || `${d.featureSet.name}: ${d.featureSet.note}`]);
  return r.rows[0].id;
}

export const datasetApi = (d: Dataset) => ({
  model: d.def.key, featureSet: d.featureSet.name, features: d.featureSet.features, ...d.stats, schema: d.schema, sample: d.sample, builtAt: d.builtAt, label: d.def.label, unit: d.def.unit ?? null,
});
