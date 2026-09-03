/* What the authority is owed about its own agents: how they are performing, whether they are drifting, and
 * whether their outcomes fall unevenly across the dimensions the records carry.
 *
 * Everything here is a pure function over decision rows. That matters twice: the numbers can be tested without a
 * database, and the same functions serve the console, the scheduled monitoring sweep and the service-level
 * report, so the three can never disagree about what "agreement rate" means. */

export type Row = Record<string, any>;

/** One decision as the metrics read it — the agent's own conclusion, with whatever a human later made of it. */
export interface MetricDecision {
  agentId: string;
  agentName?: string;
  disposition: string;
  reviewStatus: string;
  confidence: number;
  autonomyLevel?: string;
  applied?: boolean;
  escalationCode?: string;
  at: string | Date;
  cohort?: Row;
  output?: Row;
}
export interface MetricAgent { agentId: string; name: string; autonomyLevel: string; enabled: boolean; suspended: boolean; mandated?: boolean }

const D = 86_400_000;
const pct = (n: number, d: number) => (d ? Math.round((n / d) * 1000) / 10 : null);
const round = (n: number, p = 3) => Math.round(n * 10 ** p) / 10 ** p;
const ms = (v: string | Date) => new Date(v).getTime();

export const REVIEWED = (d: MetricDecision) => d.reviewStatus === 'REVIEWED' || d.reviewStatus === 'OVERRIDDEN';
export const OVERTURNED = (d: MetricDecision) => d.reviewStatus === 'OVERRIDDEN';
export const PENDING = (d: MetricDecision) => d.reviewStatus === 'PENDING';
export const ESCALATED = (d: MetricDecision) => d.disposition === 'ESCALATED' || d.disposition === 'AWAITING_REVIEW';

/** Agreement between an agent and the humans who looked at its work: reviewed decisions that were not overturned. */
export function agreement(decisions: MetricDecision[]): number | null {
  const reviewed = decisions.filter(REVIEWED);
  return reviewed.length ? pct(reviewed.length - reviewed.filter(OVERTURNED).length, reviewed.length) : null;
}
export const meanConfidence = (decisions: MetricDecision[]): number =>
  (decisions.length ? round(decisions.reduce((s, d) => s + (Number(d.confidence) || 0), 0) / decisions.length) : 0);

/* ------------------------------------------------------------------------ performance --- */

/** The console header and the per-agent series behind it. */
export function performance(agents: MetricAgent[], decisions: MetricDecision[], now: Date, windowDays = 30) {
  const since = now.getTime() - windowDays * D;
  const recent = decisions.filter((d) => ms(d.at) >= since);
  const reviewed = decisions.filter(REVIEWED);
  const auto = decisions.filter((d) => d.disposition === 'AUTO_APPLIED');
  const byAgent = new Map<string, MetricDecision[]>();
  for (const d of decisions) { const l = byAgent.get(d.agentId) ?? []; l.push(d); byAgent.set(d.agentId, l); }
  return {
    agents: agents.length,
    active: agents.filter((a) => a.enabled && !a.suspended).length,
    suspended: agents.filter((a) => a.suspended).length,
    byLevel: ['SUPERVISED', 'ASSISTED', 'AUTONOMOUS'].map((level) => ({ level, count: agents.filter((a) => a.autonomyLevel === level).length })),
    decisions: decisions.length,
    decisions30d: recent.length,
    autoAppliedPct: decisions.length ? Math.round((auto.length / decisions.length) * 100) : 0,
    pendingReview: decisions.filter(PENDING).filter(ESCALATED).length,
    agreementRate: agreement(decisions),
    avgConfidence: meanConfidence(decisions),
    perAgent: agents.map((a) => {
      const mine = byAgent.get(a.agentId) ?? [];
      return {
        agentId: a.agentId, name: a.name, autonomyLevel: a.autonomyLevel, suspended: a.suspended,
        decisions: mine.length,
        autoApplied: mine.filter((d) => d.disposition === 'AUTO_APPLIED').length,
        escalated: mine.filter((d) => d.disposition === 'ESCALATED').length,
        awaitingReview: mine.filter((d) => d.disposition === 'AWAITING_REVIEW').length,
        overridden: mine.filter(OVERTURNED).length,
        pending: mine.filter((d) => PENDING(d) && ESCALATED(d)).length,
        avgConfidence: meanConfidence(mine),
        agreementRate: agreement(mine),
      };
    }),
  };
}

/* ----------------------------------------------------------------------------- drift --- */

export interface DriftBucket { from: string; to: string; decisions: number; reviewed: number; overridden: number; agreementRate: number | null; avgConfidence: number; escalationRate: number | null }
export interface ConfidenceBand { band: string; from: number; to: number; decisions: number; share: number; agreementRate: number | null }

/** Ten-point confidence bands: where an agent's confidence actually sits, and whether reviewers agree there. */
export function confidenceDistribution(decisions: MetricDecision[]): ConfidenceBand[] {
  const bands: ConfidenceBand[] = [];
  for (let i = 0; i < 10; i += 1) {
    const from = round(i / 10, 2); const to = round((i + 1) / 10, 2);
    const inBand = decisions.filter((d) => { const c = Number(d.confidence) || 0; return i === 9 ? c >= from && c <= 1 : c >= from && c < to; });
    bands.push({ band: `${from.toFixed(1)}–${to.toFixed(1)}`, from, to, decisions: inBand.length, share: decisions.length ? Math.round((inBand.length / decisions.length) * 1000) / 10 : 0, agreementRate: agreement(inBand) });
  }
  return bands;
}

const bucket = (decisions: MetricDecision[], from: number, to: number): DriftBucket => {
  const inWindow = decisions.filter((d) => { const t = ms(d.at); return t >= from && t < to; });
  const reviewed = inWindow.filter(REVIEWED);
  return {
    from: new Date(from).toISOString(), to: new Date(to).toISOString(),
    decisions: inWindow.length, reviewed: reviewed.length, overridden: reviewed.filter(OVERTURNED).length,
    agreementRate: agreement(inWindow), avgConfidence: meanConfidence(inWindow),
    escalationRate: inWindow.length ? pct(inWindow.filter(ESCALATED).length, inWindow.length) : null,
  };
};

/**
 * Rolling accuracy and confidence per agent over a window, cut into equal buckets. An agent is called drifting
 * when the latest bucket that a reviewer actually looked at agrees materially less often than the buckets before
 * it — a fall in agreement while the agent stays just as confident is exactly the shape of a model going stale.
 */
export function drift(decisions: MetricDecision[], agents: MetricAgent[], now: Date, opts: { windowDays: number; bucketDays: number; dropPoints?: number }) {
  const end = now.getTime();
  const start = end - opts.windowDays * D;
  const bucketCount = Math.max(1, Math.ceil(opts.windowDays / opts.bucketDays));
  const drop = opts.dropPoints ?? 10;
  const byAgent = new Map<string, MetricDecision[]>();
  for (const d of decisions) { const l = byAgent.get(d.agentId) ?? []; l.push(d); byAgent.set(d.agentId, l); }
  const perAgent = agents.map((a) => {
    const mine = (byAgent.get(a.agentId) ?? []).filter((d) => ms(d.at) >= start);
    const buckets: DriftBucket[] = [];
    for (let i = 0; i < bucketCount; i += 1) {
      const from = start + i * opts.bucketDays * D;
      buckets.push(bucket(mine, from, Math.min(end, from + opts.bucketDays * D)));
    }
    const withReviews = buckets.filter((b) => b.reviewed > 0);
    const latest = withReviews[withReviews.length - 1] ?? null;
    const earlier = withReviews.slice(0, -1);
    const baseline = earlier.length
      ? Math.round((earlier.reduce((s, b) => s + (b.agreementRate ?? 0) * b.reviewed, 0) / earlier.reduce((s, b) => s + b.reviewed, 0)) * 10) / 10
      : null;
    const delta = latest?.agreementRate != null && baseline != null ? Math.round((latest.agreementRate - baseline) * 10) / 10 : null;
    return {
      agentId: a.agentId, name: a.name, autonomyLevel: a.autonomyLevel, suspended: a.suspended,
      decisions: mine.length, reviewed: mine.filter(REVIEWED).length,
      agreementRate: agreement(mine), avgConfidence: meanConfidence(mine),
      baselineAgreement: baseline, latestAgreement: latest?.agreementRate ?? null, agreementDelta: delta,
      /* A single reviewed decision is a story, not a trend: drift is only claimed once the latest bucket has
       * enough reviews to mean something. */
      drifting: delta != null && delta <= -drop && (latest?.reviewed ?? 0) >= 3,
      buckets, confidence: confidenceDistribution(mine),
    };
  });
  return {
    windowDays: opts.windowDays, bucketDays: opts.bucketDays, from: new Date(start).toISOString(), to: new Date(end).toISOString(),
    decisions: decisions.filter((d) => ms(d.at) >= start).length,
    drifting: perAgent.filter((a) => a.drifting).map((a) => a.agentId),
    perAgent,
  };
}

/* ------------------------------------------------------------------------------ bias --- */

export interface BiasCohort {
  value: string; decisions: number; escalationRate: number | null; overrideRate: number | null; autoAppliedRate: number | null;
  avgConfidence: number; escalationDelta: number | null; overrideDelta: number | null; sufficient: boolean; flagged: boolean;
}
export interface BiasDimension { dimension: string; decisions: number; populationEscalationRate: number | null; populationOverrideRate: number | null; cohorts: BiasCohort[]; flagged: string[] }

/**
 * The bias audit. For each dimension the records carry — a ship's flag state, her type, her age band, the class
 * society that surveys her, the service an application was lodged under — the outcomes of one cohort are set
 * against the population's. A cohort whose escalation or override rate departs from the population by more than
 * the configured margin is flagged for a human audit; nothing is asserted about a cohort too small to speak.
 */
export function bias(decisions: MetricDecision[], dimensions: string[], opts: { minCohort: number; flagDeltaPct: number }): { decisions: number; dimensions: BiasDimension[]; flagged: number } {
  const popEscalation = decisions.length ? pct(decisions.filter(ESCALATED).length, decisions.length) : null;
  const reviewedAll = decisions.filter(REVIEWED);
  const popOverride = reviewedAll.length ? pct(reviewedAll.filter(OVERTURNED).length, reviewedAll.length) : null;
  const out: BiasDimension[] = dimensions.map((dimension) => {
    const withValue = decisions.filter((d) => d.cohort && d.cohort[dimension] != null && String(d.cohort[dimension]) !== '');
    const values = [...new Set(withValue.map((d) => String(d.cohort![dimension])))].sort();
    const cohorts: BiasCohort[] = values.map((value) => {
      const mine = withValue.filter((d) => String(d.cohort![dimension]) === value);
      const reviewed = mine.filter(REVIEWED);
      const escalationRate = pct(mine.filter(ESCALATED).length, mine.length);
      const overrideRate = reviewed.length ? pct(reviewed.filter(OVERTURNED).length, reviewed.length) : null;
      const sufficient = mine.length >= opts.minCohort;
      const escalationDelta = escalationRate != null && popEscalation != null ? Math.round((escalationRate - popEscalation) * 10) / 10 : null;
      const overrideDelta = overrideRate != null && popOverride != null ? Math.round((overrideRate - popOverride) * 10) / 10 : null;
      return {
        value, decisions: mine.length, escalationRate, overrideRate,
        autoAppliedRate: pct(mine.filter((d) => d.disposition === 'AUTO_APPLIED').length, mine.length),
        avgConfidence: meanConfidence(mine), escalationDelta, overrideDelta, sufficient,
        flagged: sufficient && ((escalationDelta != null && Math.abs(escalationDelta) > opts.flagDeltaPct) || (overrideDelta != null && Math.abs(overrideDelta) > opts.flagDeltaPct)),
      };
    });
    return {
      dimension, decisions: withValue.length, populationEscalationRate: popEscalation, populationOverrideRate: popOverride,
      cohorts: cohorts.sort((a, b) => b.decisions - a.decisions), flagged: cohorts.filter((c) => c.flagged).map((c) => c.value),
    };
  });
  return { decisions: decisions.length, dimensions: out, flagged: out.reduce((s, d) => s + d.flagged.length, 0) };
}

/* --------------------------------------------------------------------- service levels --- */

/** A decision that called a ship high risk: the compliance score put her in the top band, or targeting boarded her. */
export const isHighRiskCall = (d: MetricDecision) => {
  const o = d.output ?? {};
  return o.board === true || o.band === 'HIGH' || o.level === 'ELEVATED';
};

/**
 * The service levels the RFP measures the AI layer against. The false-positive rate is the one that matters
 * most and is the easiest to fudge, so it is defined narrowly: of the high-risk calls a human actually looked
 * at, the share the human overturned. Calls nobody reviewed are excluded rather than assumed correct.
 */
export function serviceLevels(decisions: MetricDecision[], now: Date, opts: { windowDays: number; agreementTarget: number; falsePositiveCeiling: number }) {
  const since = now.getTime() - opts.windowDays * D;
  const inWindow = decisions.filter((d) => ms(d.at) >= since);
  const reviewed = inWindow.filter(REVIEWED);
  const highRisk = inWindow.filter(isHighRiskCall);
  const highRiskReviewed = highRisk.filter(REVIEWED);
  const falsePositives = highRiskReviewed.filter(OVERTURNED);
  const escalated = inWindow.filter(ESCALATED);
  const agreementRate = agreement(inWindow);
  const falsePositiveRate = highRiskReviewed.length ? pct(falsePositives.length, highRiskReviewed.length) : null;
  const metric = (key: string, label: string, value: number | null, target: number | null, unit: string, meets: boolean | null) => ({ key, label, value, target, unit, meets });
  return {
    windowDays: opts.windowDays, from: new Date(since).toISOString(), to: now.toISOString(),
    decisions: inWindow.length, reviewed: reviewed.length, escalated: escalated.length,
    highRiskCalls: highRisk.length, highRiskReviewed: highRiskReviewed.length, falsePositives: falsePositives.length,
    metrics: [
      metric('agreement', 'Agreement with reviewers', agreementRate, opts.agreementTarget, '%', agreementRate == null ? null : agreementRate >= opts.agreementTarget),
      metric('falsePositiveHighRisk', 'False-positive rate — high-risk vessel scoring', falsePositiveRate, opts.falsePositiveCeiling, '%', falsePositiveRate == null ? null : falsePositiveRate <= opts.falsePositiveCeiling),
      metric('escalation', 'Decisions escalated to a human', pct(escalated.length, inWindow.length), null, '%', null),
      metric('autoApplied', 'Decisions applied without a human', pct(inWindow.filter((d) => d.disposition === 'AUTO_APPLIED').length, inWindow.length), null, '%', null),
      metric('reviewCoverage', 'Escalations a human has closed', escalated.length ? pct(escalated.filter(REVIEWED).length, escalated.length) : null, null, '%', null),
      metric('avgConfidence', 'Mean confidence', meanConfidence(inWindow), null, 'ratio', null),
    ],
  };
}

/** The dimensions the bias audit reads, in the order the console shows them. */
export const BIAS_DIMENSIONS = ['flag', 'vesselType', 'ageBand', 'classSociety', 'serviceCode', 'applicantKind'];
