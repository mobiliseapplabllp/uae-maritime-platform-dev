import { describe, expect, it } from 'vitest';
import { auc, encode, inferSchema, mulberry32, predict, train, type Row, type TrainParams } from '../src/gbdt';

/*
 * The learner itself, on data with a known shape: it must find a signal that is there, say how well it did on rows it
 * did not fit, give the same fit twice for the same seed, and read categories and gaps without guessing.
 */
const params: TrainParams = { rounds: 80, depth: 3, learningRate: 0.15, minLeaf: 3, holdout: 0.25, seed: 11, patience: 15 };

/** A fictional targeting world: risk rises with age and a record, and the type matters; the rest is noise. */
function targeting(n: number, seed: number): Row[] {
  const rnd = mulberry32(seed); const types = ['BULK', 'CONT', 'TANK', 'GEN'];
  return Array.from({ length: n }, () => {
    const age = Math.floor(rnd() * 25); const prior = Math.floor(rnd() * 4); const type = types[Math.floor(rnd() * types.length)];
    const z = -3 + 0.14 * age + 0.7 * prior + (type === 'BULK' ? 0.6 : type === 'CONT' ? -0.5 : 0);
    const p = 1 / (1 + Math.exp(-z));
    return { features: { shipAgeYears: age, priorDetentions: prior, shipType: type, noise: Math.floor(rnd() * 100) }, label: rnd() < p ? 1 : 0 };
  });
}
/** A fictional wait: hours grow with the queue and the type, with an hour-of-day bump and noise. */
function waits(n: number, seed: number): Row[] {
  const rnd = mulberry32(seed); const types = ['BULK', 'CONT', 'TANK'];
  return Array.from({ length: n }, () => {
    const queue = Math.floor(rnd() * 8); const type = types[Math.floor(rnd() * 3)]; const hour = Math.floor(rnd() * 24);
    const y = 3 + 1.5 * queue + (type === 'TANK' ? 7 : type === 'BULK' ? 5 : 0) + (hour >= 22 || hour < 5 ? 2 : 0) + (rnd() - 0.5) * 3;
    return { features: { queueAhead: queue, shipType: type, etaHour: hour }, label: Math.round(y * 100) / 100 };
  });
}

describe('gradient-boosted trees', () => {
  it('finds the signal in a classification, measures it on held-out rows only, and ranks the features that carried it', () => {
    const { model, metrics } = train(targeting(600, 1), 'CLASSIFICATION', params);
    expect(metrics.auc).toBeGreaterThan(0.7);
    expect(metrics.heldOut).toBe(150); expect(metrics.trained).toBe(450); expect(metrics.rows).toBe(600);
    expect(metrics.confidence).toBeGreaterThanOrEqual(0.5); expect(metrics.confidence).toBeLessThanOrEqual(0.95);
    // the operating point of a targeting model: boarding the top share equal to the base rate beats boarding at random
    expect(metrics.lift).toBeGreaterThan(1.3); expect(metrics.precisionAtBaseRate).toBeGreaterThan(metrics.positiveRate!);
    const imp = metrics.importance;
    expect(imp.shipAgeYears + imp.priorDetentions + imp.shipType).toBeGreaterThan(imp.noise);
    expect(Object.values(imp).reduce((s, v) => s + v, 0)).toBeCloseTo(1, 1);
    // and the answer moves with the evidence
    const young = predict(model, { shipAgeYears: 2, priorDetentions: 0, shipType: 'CONT', noise: 50 });
    const old = predict(model, { shipAgeYears: 23, priorDetentions: 3, shipType: 'BULK', noise: 50 });
    expect(old).toBeGreaterThan(young + 0.3);
    expect(young).toBeGreaterThanOrEqual(0); expect(old).toBeLessThanOrEqual(1);
  });
  it('fits a regression and beats predicting the mean', () => {
    const { model, metrics } = train(waits(500, 2), 'REGRESSION', params);
    expect(metrics.r2).toBeGreaterThan(0.7);
    expect(metrics.mae!).toBeLessThan(metrics.baselineMae! * 0.6);
    const quiet = predict(model, { queueAhead: 0, shipType: 'CONT', etaHour: 12 });
    const busy = predict(model, { queueAhead: 7, shipType: 'TANK', etaHour: 23 });
    expect(busy - quiet).toBeGreaterThan(10);
  });
  it('stops when the held-out rows stop improving and keeps the best round, unless told to fit every round', () => {
    const rows = targeting(300, 5);
    const early = train(rows, 'CLASSIFICATION', { ...params, rounds: 400, patience: 10 });
    const full = train(rows, 'CLASSIFICATION', { ...params, rounds: 400, patience: 0 });
    expect(early.model.rounds).toBeLessThan(full.model.rounds); expect(full.model.rounds).toBe(400);
    expect(early.model.trees).toHaveLength(early.model.rounds);
    expect(early.metrics.logLoss!).toBeLessThanOrEqual(full.metrics.logLoss! + 1e-9);
  });
  it('is deterministic for a seed and differs for another', () => {
    const rows = targeting(200, 3);
    const a = train(rows, 'CLASSIFICATION', params); const b = train(rows, 'CLASSIFICATION', params); const c = train(rows, 'CLASSIFICATION', { ...params, seed: 12 });
    expect(JSON.stringify(a.model)).toBe(JSON.stringify(b.model));
    expect(a.metrics).toEqual(b.metrics);
    expect(JSON.stringify(c.model)).not.toBe(JSON.stringify(a.model));
  });
  it('reads the schema from the rows or the declaration, stands the median in for a gap, and marks an unknown category', () => {
    const rows: Row[] = [
      { features: { a: 1, k: 'x', d: '7' }, label: 0 }, { features: { a: 3, k: 'y', d: '9' }, label: 1 }, { features: { a: 5, k: 'x', d: '' }, label: 1 }, { features: { a: null, k: 'z', d: '3' }, label: 0 },
    ];
    const schema = inferSchema(rows, { d: 'num' });
    expect(schema.map((f) => `${f.name}:${f.kind}`)).toEqual(['a:num', 'd:num', 'k:cat']);
    expect(schema.find((f) => f.name === 'a')!.median).toBe(3);
    expect(schema.find((f) => f.name === 'k')!.categories).toEqual(['x', 'y', 'z']);
    expect(encode(schema, { a: undefined, d: '9', k: 'y' })).toEqual([3, 9, 1]);
    expect(encode(schema, { a: 2, d: null, k: 'never-seen' })).toEqual([2, 7, -1]);
  });
  it('refuses to fit on almost nothing, and ranks by AUC as the share of pairs in the right order', () => {
    expect(() => train(targeting(3, 4), 'CLASSIFICATION', params)).toThrow(/too few rows/);
    expect(auc([0.9, 0.8, 0.2, 0.1], [1, 1, 0, 0])).toBe(1);
    expect(auc([0.1, 0.2, 0.8, 0.9], [1, 1, 0, 0])).toBe(0);
    expect(auc([0.5, 0.5, 0.5], [1, 0, 1])).toBe(0.5);
  });
});
