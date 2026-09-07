/* Gradient-boosted decision trees, in the platform's own toolchain.
 *
 * The platform's tabular questions — is this arrival worth an inspection, how late will she be — are small, mixed
 * numeric and categorical tables of a few hundred to a few thousand rows. Boosted shallow trees fit them well, fit on
 * a laptop in under a second, and produce an artefact that is plain data: a list of trees a reader can follow. This is
 * the standard construction — a base score, then rounds of a regression tree fitted to the gradient of the loss, each
 * scaled by the learning rate; squared loss for regression, logistic loss with a Newton leaf step for classification.
 * Categorical features split as "is this category or not", numeric ones at a threshold; a value the row does not
 * carry falls to the training median or the unknown category. Everything is deterministic for a seed, so a fit can be
 * repeated and a version audited. */

export type Task = 'CLASSIFICATION' | 'REGRESSION';
export interface FeatureSpec { name: string; kind: 'num' | 'cat'; median?: number; categories?: string[] }
export interface TreeNode { leaf?: number; feature?: number; threshold?: number; category?: number; left?: TreeNode; right?: TreeNode; gain?: number; count?: number }
export interface Model { task: Task; features: FeatureSpec[]; base: number; lr: number; trees: TreeNode[]; rounds: number; depth: number }
export interface TrainParams {
  rounds: number; depth: number; learningRate: number; minLeaf: number; holdout: number; seed: number;
  /** Rounds to keep going without the held-out loss improving before the fit stops and keeps its best round. Zero fits every round. */
  patience?: number;
}
export interface Row { features: Record<string, unknown>; label: number }
export interface Metrics {
  rows: number; trained: number; heldOut: number;
  auc?: number; precision?: number; recall?: number; f1?: number; logLoss?: number; accuracy?: number; positiveRate?: number;
  /** For a targeting model the operating point is a share of arrivals, not a probability: the precision among the top share equal to the base rate, and its lift over boarding at random. */
  precisionAtBaseRate?: number; lift?: number;
  mae?: number; rmse?: number; r2?: number; baselineMae?: number; labelStd?: number;
  confidence: number;
  importance: Record<string, number>;
}

/** A small deterministic generator, so a shuffle is the same shuffle next time. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const num = (v: unknown): number | null => { if (v === null || v === undefined || v === '') return null; const n = typeof v === 'boolean' ? (v ? 1 : 0) : Number(v); return Number.isFinite(n) ? n : null; };
const cat = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const median = (xs: number[]): number => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

/** Reads the feature schema off the rows: a feature is numeric when every value it carries is a number, categorical otherwise. */
export function inferSchema(rows: Row[], declared?: Record<string, 'num' | 'cat'>): FeatureSpec[] {
  const names = new Set<string>();
  for (const r of rows) for (const k of Object.keys(r.features)) names.add(k);
  return [...names].sort().map((name) => {
    const values = rows.map((r) => r.features[name]).filter((v) => v !== null && v !== undefined && v !== '');
    const kind: 'num' | 'cat' = declared?.[name] ?? (values.length && values.every((v) => num(v) !== null && typeof v !== 'string') ? 'num' : 'cat');
    if (kind === 'num') return { name, kind, median: median(values.map((v) => num(v)!)) };
    const categories = [...new Set(values.map(cat))].sort();
    return { name, kind, categories: categories.slice(0, 64) };
  });
}

/** Rows as a numeric matrix: numeric features as themselves (median when missing), categorical as the category index (−1 when unknown). */
export function encode(schema: FeatureSpec[], features: Record<string, unknown>): number[] {
  return schema.map((f) => {
    const v = features[f.name];
    if (f.kind === 'num') { const n = num(v); return n === null ? (f.median ?? 0) : n; }
    const i = (f.categories ?? []).indexOf(cat(v));
    return i;
  });
}

interface Split { feature: number; threshold?: number; category?: number; gain: number; leftIdx: number[]; rightIdx: number[] }

/** The best split of these rows on any feature, by the reduction in squared gradient error (the standard gain). */
function bestSplit(X: number[][], g: number[], h: number[], idx: number[], schema: FeatureSpec[], minLeaf: number): Split | null {
  const G = idx.reduce((s, i) => s + g[i], 0); const H = idx.reduce((s, i) => s + h[i], 0);
  const score = (gs: number, hs: number) => (gs * gs) / (hs + 1e-9);
  const parent = score(G, H);
  let best: Split | null = null;
  for (let f = 0; f < schema.length; f += 1) {
    if (schema[f].kind === 'cat') {
      const cats = schema[f].categories ?? [];
      for (let c = -1; c < cats.length; c += 1) {
        const left = idx.filter((i) => X[i][f] === c); if (left.length < minLeaf || idx.length - left.length < minLeaf) continue;
        const gl = left.reduce((s, i) => s + g[i], 0); const hl = left.reduce((s, i) => s + h[i], 0);
        const gain = score(gl, hl) + score(G - gl, H - hl) - parent;
        if (!best || gain > best.gain) best = { feature: f, category: c, gain, leftIdx: left, rightIdx: idx.filter((i) => X[i][f] !== c) };
      }
      continue;
    }
    // numeric: candidate thresholds at up to 32 quantiles of the values present
    const values = [...new Set(idx.map((i) => X[i][f]))].sort((a, b) => a - b);
    if (values.length < 2) continue;
    const step = Math.max(1, Math.floor(values.length / 32));
    for (let k = step; k < values.length; k += step) {
      const t = (values[k - 1] + values[k]) / 2;
      const left = idx.filter((i) => X[i][f] <= t); if (left.length < minLeaf || idx.length - left.length < minLeaf) continue;
      const gl = left.reduce((s, i) => s + g[i], 0); const hl = left.reduce((s, i) => s + h[i], 0);
      const gain = score(gl, hl) + score(G - gl, H - hl) - parent;
      if (!best || gain > best.gain) best = { feature: f, threshold: t, gain, leftIdx: left, rightIdx: idx.filter((i) => X[i][f] > t) };
    }
  }
  return best && best.gain > 1e-9 ? best : null;
}

function growTree(X: number[][], g: number[], h: number[], idx: number[], schema: FeatureSpec[], depth: number, minLeaf: number, importance: number[]): TreeNode {
  const leaf = (): TreeNode => { const G = idx.reduce((s, i) => s + g[i], 0); const H = idx.reduce((s, i) => s + h[i], 0); return { leaf: -G / (H + 1e-9), count: idx.length }; };
  if (depth <= 0 || idx.length < 2 * minLeaf) return leaf();
  const split = bestSplit(X, g, h, idx, schema, minLeaf);
  if (!split) return leaf();
  importance[split.feature] += split.gain;
  return {
    feature: split.feature, threshold: split.threshold, category: split.category, gain: Math.round(split.gain * 1000) / 1000, count: idx.length,
    left: growTree(X, g, h, split.leftIdx, schema, depth - 1, minLeaf, importance),
    right: growTree(X, g, h, split.rightIdx, schema, depth - 1, minLeaf, importance),
  };
}

function walk(node: TreeNode, x: number[]): number {
  let n = node;
  while (n.leaf === undefined) {
    const v = x[n.feature!];
    const goLeft = n.category !== undefined ? v === n.category : v <= n.threshold!;
    n = goLeft ? n.left! : n.right!;
  }
  return n.leaf;
}
const sigmoid = (z: number) => 1 / (1 + Math.exp(-z));

/** The raw score of a model for an encoded row: log-odds for classification, the value for regression. */
export function rawScore(model: Model, x: number[]): number {
  let s = model.base;
  for (const t of model.trees) s += model.lr * walk(t, x);
  return s;
}
/** A prediction for a row of named features: a probability for classification, the value for regression. */
export function predict(model: Model, features: Record<string, unknown>): number {
  const s = rawScore(model, encode(model.features, features));
  return model.task === 'CLASSIFICATION' ? sigmoid(s) : s;
}

/** Area under the ROC curve by rank: the share of positive–negative pairs the model orders correctly. */
export function auc(scores: number[], labels: number[]): number {
  const pos = scores.filter((_, i) => labels[i] > 0.5); const neg = scores.filter((_, i) => labels[i] <= 0.5);
  if (!pos.length || !neg.length) return 0.5;
  let wins = 0;
  for (const p of pos) for (const n of neg) wins += p > n ? 1 : p === n ? 0.5 : 0;
  return wins / (pos.length * neg.length);
}

export function train(rows: Row[], task: Task, params: TrainParams, declared?: Record<string, 'num' | 'cat'>): { model: Model; metrics: Metrics } {
  if (rows.length < 4) throw new Error(`too few rows to fit (${rows.length})`);
  const schema = inferSchema(rows, declared);
  const rnd = mulberry32(params.seed);
  const order = rows.map((_, i) => i).sort(() => rnd() - 0.5);
  const heldOut = Math.max(1, Math.min(rows.length - 2, Math.round(rows.length * params.holdout)));
  const testIdx = order.slice(0, heldOut); const trainIdx = order.slice(heldOut);
  const X = rows.map((r) => encode(schema, r.features)); const y = rows.map((r) => r.label);
  const yTrain = trainIdx.map((i) => y[i]);
  const mean = yTrain.reduce((s, v) => s + v, 0) / yTrain.length;
  const base = task === 'CLASSIFICATION' ? Math.log(Math.max(1e-6, mean) / Math.max(1e-6, 1 - mean)) : mean;
  const F = rows.map(() => base);
  const trees: TreeNode[] = []; const importance = schema.map(() => 0);
  // The held-out rows also say when to stop: a fit that keeps adding trees after they stopped helping is memorising the
  // fitted rows, and on a few hundred boardings that happens within tens of rounds. The best round is kept.
  const heldOutLoss = () => task === 'CLASSIFICATION'
    ? -testIdx.reduce((s, i) => { const p = Math.min(1 - 1e-9, Math.max(1e-9, sigmoid(F[i]))); return s + (y[i] > 0.5 ? Math.log(p) : Math.log(1 - p)); }, 0) / testIdx.length
    : testIdx.reduce((s, i) => s + (F[i] - y[i]) ** 2, 0) / testIdx.length;
  const patience = params.patience ?? 0;
  let bestLoss = heldOutLoss(); let bestRounds = 0; let since = 0;
  for (let round = 0; round < params.rounds; round += 1) {
    const g: number[] = []; const h: number[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      if (task === 'CLASSIFICATION') { const p = sigmoid(F[i]); g[i] = p - y[i]; h[i] = Math.max(1e-6, p * (1 - p)); }
      else { g[i] = F[i] - y[i]; h[i] = 1; }
    }
    const tree = growTree(X, g, h, trainIdx, schema, params.depth, params.minLeaf, importance);
    if (tree.leaf !== undefined && Math.abs(tree.leaf) < 1e-9) break;
    trees.push(tree);
    for (let i = 0; i < rows.length; i += 1) F[i] += params.learningRate * walk(tree, X[i]);
    const loss = heldOutLoss();
    if (loss < bestLoss - 1e-9) { bestLoss = loss; bestRounds = trees.length; since = 0; } else { since += 1; }
    if (patience > 0 && since >= patience) break;
    if (patience === 0) bestRounds = trees.length;
  }
  if (bestRounds === 0) bestRounds = Math.min(1, trees.length);
  // the scores the metrics are read from are the kept model's, not the last round's
  for (let i = 0; i < rows.length; i += 1) F[i] = base + trees.slice(0, bestRounds).reduce((s, t) => s + params.learningRate * walk(t, X[i]), 0);
  const model: Model = { task, features: schema, base, lr: params.learningRate, trees: trees.slice(0, bestRounds), rounds: bestRounds, depth: params.depth };
  const total = importance.reduce((s, v) => s + v, 0) || 1;
  const imp: Record<string, number> = {};
  schema.forEach((f, i) => { imp[f.name] = Math.round((importance[i] / total) * 1000) / 1000; });
  const metrics = measure(model, X, y, testIdx, trainIdx.length, imp);
  return { model, metrics };
}

function measure(model: Model, X: number[][], y: number[], testIdx: number[], trained: number, importance: Record<string, number>): Metrics {
  const raw = testIdx.map((i) => rawScore(model, X[i])); const labels = testIdx.map((i) => y[i]);
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  if (model.task === 'CLASSIFICATION') {
    const p = raw.map(sigmoid);
    const tp = p.filter((v, i) => v >= 0.5 && labels[i] > 0.5).length; const fp = p.filter((v, i) => v >= 0.5 && labels[i] <= 0.5).length; const fn = p.filter((v, i) => v < 0.5 && labels[i] > 0.5).length;
    const precision = tp + fp ? tp / (tp + fp) : 0; const recall = tp + fn ? tp / (tp + fn) : 0;
    const logLoss = -p.reduce((s, v, i) => s + (labels[i] > 0.5 ? Math.log(Math.max(1e-9, v)) : Math.log(Math.max(1e-9, 1 - v))), 0) / Math.max(1, p.length);
    const a = auc(p, labels);
    const positiveRate = labels.filter((l) => l > 0.5).length / Math.max(1, labels.length);
    const k = Math.max(1, Math.round(labels.length * positiveRate));
    const top = p.map((v, i) => i).sort((i, j) => p[j] - p[i]).slice(0, k);
    const precisionAtBaseRate = top.filter((i) => labels[i] > 0.5).length / k;
    return { rows: X.length, trained, heldOut: testIdx.length, auc: r3(a), precision: r3(precision), recall: r3(recall), precisionAtBaseRate: r3(precisionAtBaseRate), lift: r3(positiveRate ? precisionAtBaseRate / positiveRate : 0), f1: r3(precision + recall ? (2 * precision * recall) / (precision + recall) : 0), logLoss: r3(logLoss), accuracy: r3(p.filter((v, i) => (v >= 0.5) === labels[i] > 0.5).length / Math.max(1, p.length)), positiveRate: r3(positiveRate), confidence: r3(Math.min(0.95, Math.max(0.5, a))), importance };
  }
  const mae = raw.reduce((s, v, i) => s + Math.abs(v - labels[i]), 0) / Math.max(1, raw.length);
  const rmse = Math.sqrt(raw.reduce((s, v, i) => s + (v - labels[i]) ** 2, 0) / Math.max(1, raw.length));
  const mean = labels.reduce((s, v) => s + v, 0) / Math.max(1, labels.length);
  const ss = labels.reduce((s, v) => s + (v - mean) ** 2, 0); const rs = raw.reduce((s, v, i) => s + (v - labels[i]) ** 2, 0);
  const std = Math.sqrt(ss / Math.max(1, labels.length));
  const baselineMae = labels.reduce((s, v) => s + Math.abs(v - mean), 0) / Math.max(1, labels.length);
  return { rows: X.length, trained, heldOut: testIdx.length, mae: r3(mae), rmse: r3(rmse), r2: r3(ss ? 1 - rs / ss : 0), baselineMae: r3(baselineMae), labelStd: r3(std), confidence: r3(Math.min(0.95, Math.max(0.5, 1 - mae / Math.max(1e-6, std)))), importance };
}
