/* Drift detection by Population Stability Index.
 *
 * PSI is the measure supervisors and model risk teams already read, which matters more here than a more
 * sensitive statistic would: a number an auditor recognises and can argue with beats a better number nobody
 * can interpret. It compares the distribution of a feature now against the distribution it had when the
 * version was accepted, and the conventional reading of the result is fixed — under 0.1 the population is
 * stable, 0.1 to 0.25 has moved enough to look at, 0.25 and above has moved enough to act on.
 *
 * The subtlety that makes or breaks a PSI implementation is that the observed sample must be bucketed with
 * the *baseline's* edges. Recomputing quantiles on the new data compares each period against itself and
 * reports stability no matter how far the inputs have moved — the failure mode where drift monitoring
 * quietly reports nothing forever. `applyBins` therefore takes the baseline and never derives its own.
 */

export type Verdict = 'STABLE' | 'MODERATE' | 'SIGNIFICANT' | 'INSUFFICIENT';

export interface NumericBin { lo: number; hi: number; share: number }
export interface CategoricalBin { value: string; share: number }
export type Distribution =
  | { kind: 'numeric'; bins: NumericBin[]; count: number }
  | { kind: 'categorical'; bins: CategoricalBin[]; count: number };

/** Never divide by, or take the log of, an empty bucket: a category absent from one side is common. */
const EPS = 1e-4;
const OTHER = '(other)';

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** Quantile of an already-sorted array, by linear interpolation. */
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos); const hi = Math.ceil(pos);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/**
 * Builds the reference distribution for one feature. Numeric features are cut at quantiles rather than at
 * even widths, so a skewed feature — nearly every maritime measure is skewed — still gets buckets that hold
 * comparable numbers of observations. Degenerate cuts are collapsed, because a constant feature would
 * otherwise produce buckets of zero width that every later observation falls outside of.
 */
export function summarise(values: unknown[], opts: { buckets?: number; maxCategories?: number } = {}): Distribution {
  const buckets = Math.max(2, opts.buckets ?? 10);
  const maxCategories = Math.max(2, opts.maxCategories ?? 12);
  const numbers = values.filter(isNumber);
  const count = values.length;

  if (numbers.length >= Math.max(1, values.length / 2)) {
    const sorted = [...numbers].sort((a, b) => a - b);
    const edges: number[] = [];
    for (let i = 0; i <= buckets; i += 1) edges.push(quantile(sorted, i / buckets));
    const unique = edges.filter((e, i) => i === 0 || e > edges[i - 1]);
    if (unique.length < 2) return { kind: 'numeric', bins: [{ lo: sorted[0] ?? 0, hi: sorted[0] ?? 0, share: 1 }], count };
    const bins: NumericBin[] = [];
    for (let i = 0; i < unique.length - 1; i += 1) {
      const lo = unique[i]; const hi = unique[i + 1];
      const last = i === unique.length - 2;
      const n = sorted.filter((v) => v >= lo && (last ? v <= hi : v < hi)).length;
      bins.push({ lo, hi, share: n / sorted.length });
    }
    return { kind: 'numeric', bins, count };
  }

  const tally = new Map<string, number>();
  for (const v of values) { const k = String(v ?? ''); tally.set(k, (tally.get(k) ?? 0) + 1); }
  const ordered = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const kept = ordered.slice(0, maxCategories);
  const rest = ordered.slice(maxCategories).reduce((s, [, n]) => s + n, 0);
  const bins: CategoricalBin[] = kept.map(([value, n]) => ({ value, share: n / Math.max(1, count) }));
  if (rest) bins.push({ value: OTHER, share: rest / Math.max(1, count) });
  return { kind: 'categorical', bins, count };
}

/** Buckets an observed sample using the baseline's own edges. The whole method depends on this. */
export function applyBins(baseline: Distribution, values: unknown[]): number[] {
  if (baseline.kind === 'numeric') {
    const numbers = values.filter(isNumber);
    const total = Math.max(1, numbers.length);
    return baseline.bins.map((b, i) => {
      const last = i === baseline.bins.length - 1;
      const first = i === 0;
      // The outer buckets are open-ended: a value below the baseline's minimum still belongs somewhere, and
      // dropping it would hide exactly the shift drift detection exists to find.
      const n = numbers.filter((v) => (first ? v < b.hi || v <= b.lo : v >= b.lo) && (last ? true : v < b.hi)).length;
      return n / total;
    });
  }
  const total = Math.max(1, values.length);
  const seen = values.map((v) => String(v ?? ''));
  const named = new Set(baseline.bins.map((b) => b.value).filter((v) => v !== OTHER));
  return baseline.bins.map((b) => {
    const n = b.value === OTHER ? seen.filter((v) => !named.has(v)).length : seen.filter((v) => v === b.value).length;
    return n / total;
  });
}

/** Population Stability Index between a baseline's shares and an observed sample's shares. */
export function psi(baseShares: number[], observedShares: number[]): number {
  let total = 0;
  for (let i = 0; i < baseShares.length; i += 1) {
    const b = Math.max(baseShares[i] ?? 0, EPS);
    const o = Math.max(observedShares[i] ?? 0, EPS);
    total += (o - b) * Math.log(o / b);
  }
  return Math.round(total * 10000) / 10000;
}

export interface Thresholds { moderate: number; significant: number }
export const verdictFor = (value: number, t: Thresholds): Exclude<Verdict, 'INSUFFICIENT'> =>
  (value >= t.significant ? 'SIGNIFICANT' : value >= t.moderate ? 'MODERATE' : 'STABLE');

export interface FeatureDrift { feature: string; psi: number; verdict: Exclude<Verdict, 'INSUFFICIENT'>; baselineBins: number; observed: number[] }
export interface DriftResult { verdict: Verdict; maxPsi: number; sampleSize: number; features: FeatureDrift[] }

/**
 * Compares an observed window against a captured baseline, feature by feature, and takes the worst.
 *
 * The verdict is the maximum rather than the mean on purpose: one input that has moved a long way is a
 * problem even when nine others have not, and averaging is how that gets hidden.
 */
export function compare(
  baseline: { features: Record<string, Distribution>; output?: Distribution },
  observed: { features: Record<string, unknown[]>; output?: unknown[] },
  opts: { minSample: number; thresholds: Thresholds },
): DriftResult {
  const sampleSize = Math.max(0, ...Object.values(observed.features).map((v) => v.length), observed.output?.length ?? 0);
  if (sampleSize < opts.minSample) return { verdict: 'INSUFFICIENT', maxPsi: 0, sampleSize, features: [] };

  const features: FeatureDrift[] = [];
  for (const [name, dist] of Object.entries(baseline.features)) {
    const values = observed.features[name];
    if (!values || !values.length) continue;
    const shares = applyBins(dist, values);
    const value = psi(dist.bins.map((b) => b.share), shares);
    features.push({ feature: name, psi: value, verdict: verdictFor(value, opts.thresholds), baselineBins: dist.bins.length, observed: shares.map((s) => Math.round(s * 10000) / 10000) });
  }
  if (baseline.output && observed.output?.length) {
    const shares = applyBins(baseline.output, observed.output);
    const value = psi(baseline.output.bins.map((b) => b.share), shares);
    features.push({ feature: '(output)', psi: value, verdict: verdictFor(value, opts.thresholds), baselineBins: baseline.output.bins.length, observed: shares.map((s) => Math.round(s * 10000) / 10000) });
  }
  if (!features.length) return { verdict: 'INSUFFICIENT', maxPsi: 0, sampleSize, features };
  const maxPsi = Math.max(...features.map((f) => f.psi));
  return { verdict: verdictFor(maxPsi, opts.thresholds), maxPsi, sampleSize, features: features.sort((a, b) => b.psi - a.psi) };
}
