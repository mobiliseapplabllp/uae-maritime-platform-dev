import { createHash } from 'node:crypto';

/* Serving.
 *
 * Two providers behind one interface. `stub` computes an answer from the features it was given, so the
 * pipelines are exercisable, demonstrable and testable with no model server anywhere; `live` calls the
 * configured endpoint. The same rule as the integration hub's adapters: a stub that returns a defensible
 * answer is worth building, a stub that throws is not, because nothing downstream of it can be developed.
 *
 * Every path through here is timed and every path is recorded, including the ones that fail. A timeout is
 * the single most useful inference to have a record of, and it is the one an implementation that only logs
 * successes throws away.
 */

export type ModelTask = 'CLASSIFICATION' | 'REGRESSION' | 'RANKING' | 'EXTRACTION' | 'VISION' | 'SPEECH' | 'EMBEDDING' | 'GENERATION';

export interface InferRequest {
  modelKey: string;
  task: ModelTask;
  version: number;
  features: Record<string, unknown>;
  /** Named outputs an extraction or vision request wants back. */
  fields?: string[];
  subject?: string;
}
export interface InferResult { output: Record<string, unknown>; confidence: number }

export interface ServingProvider {
  readonly mode: 'stub' | 'live';
  infer(req: InferRequest, signal: AbortSignal): Promise<InferResult>;
}

/** A stable number in [0,1) from any input — the same features always produce the same answer. */
function unit(...parts: unknown[]): number {
  const h = createHash('sha256').update(parts.map((p) => JSON.stringify(p ?? null)).join('|')).digest();
  return h.readUInt32BE(0) / 0x1_0000_0000;
}

const numericOf = (features: Record<string, unknown>): number[] =>
  Object.values(features).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

/**
 * The development provider. Answers are derived from the features rather than drawn at random, so a request
 * that changes an input changes the output in the direction a reader would expect, and a demonstration
 * shows a model responding to evidence rather than a dice roll.
 */
export class StubProvider implements ServingProvider {
  readonly mode = 'stub' as const;
  async infer(req: InferRequest): Promise<InferResult> {
    const nums = numericOf(req.features);
    const base = unit(req.modelKey, req.version, req.features);
    switch (req.task) {
      case 'CLASSIFICATION':
      case 'RANKING': {
        // Weighted toward the evidence: a request carrying larger numbers scores higher, with the hash
        // supplying only the spread between otherwise identical inputs.
        const signal = nums.length ? Math.min(1, nums.reduce((s, n) => s + Math.abs(n), 0) / (nums.length * 100)) : 0;
        const score = Math.round((0.65 * signal + 0.35 * base) * 1000) / 1000;
        return { output: { score, label: score >= 0.66 ? 'HIGH' : score >= 0.33 ? 'MEDIUM' : 'LOW' }, confidence: Math.round((0.6 + base * 0.35) * 1000) / 1000 };
      }
      case 'REGRESSION': {
        const mean = nums.length ? nums.reduce((s, n) => s + n, 0) / nums.length : 0;
        const value = Math.round((mean * (0.85 + base * 0.3)) * 100) / 100;
        return { output: { value }, confidence: Math.round((0.55 + base * 0.4) * 1000) / 1000 };
      }
      case 'EMBEDDING': {
        const dims = 8;
        const vector = Array.from({ length: dims }, (_, i) => Math.round((unit(req.features, i) * 2 - 1) * 1000) / 1000);
        return { output: { vector, dims }, confidence: 1 };
      }
      case 'EXTRACTION':
      case 'VISION': {
        const fields = req.fields?.length ? req.fields : ['documentType', 'referenceNumber', 'issuedDate'];
        const extracted: Record<string, { value: string; confidence: number }> = {};
        for (const f of fields) {
          const supplied = req.features[f];
          extracted[f] = {
            value: supplied === undefined || supplied === null ? `${f}-unreadable` : String(supplied),
            // A field the caller supplied is one the pipeline can be confident about; one it had to invent
            // is reported as low confidence rather than passed off as read.
            confidence: supplied === undefined || supplied === null ? Math.round(unit(f, base) * 400) / 1000 : Math.round((0.82 + unit(f, base) * 0.15) * 1000) / 1000,
          };
        }
        const confidences = Object.values(extracted).map((e) => e.confidence);
        return { output: { fields: extracted, pages: Number(req.features.pages ?? 1) }, confidence: Math.round((confidences.reduce((s, c) => s + c, 0) / Math.max(1, confidences.length)) * 1000) / 1000 };
      }
      case 'SPEECH': {
        const seconds = Number(req.features.durationSec ?? 0);
        const spoken = String(req.features.transcriptHint ?? '');
        return {
          output: { transcript: spoken || '(no speech detected)', language: String(req.features.language ?? 'en'), durationSec: seconds, words: spoken ? spoken.trim().split(/\s+/).length : 0 },
          confidence: spoken ? Math.round((0.78 + base * 0.18) * 1000) / 1000 : 0.1,
        };
      }
      case 'GENERATION':
      default:
        return { output: { text: String(req.features.prompt ?? '').slice(0, 500) }, confidence: Math.round((0.5 + base * 0.3) * 1000) / 1000 };
    }
  }
}

/** Calls a deployed model server over HTTP. The endpoint is configuration, never a value from a request. */
export class HttpProvider implements ServingProvider {
  readonly mode = 'live' as const;
  constructor(private readonly endpoint: string, private readonly token?: string, private readonly fetchImpl: typeof fetch = fetch) {}
  async infer(req: InferRequest, signal: AbortSignal): Promise<InferResult> {
    const headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (this.token) headers.authorization = `Bearer ${this.token}`;
    const res = await this.fetchImpl(`${this.endpoint.replace(/\/+$/, '')}/v1/models/${encodeURIComponent(req.modelKey)}/infer`, {
      method: 'POST', headers, signal,
      body: JSON.stringify({ version: req.version, task: req.task, features: req.features, fields: req.fields }),
    });
    if (!res.ok) throw new Error(`Model server answered ${res.status}`);
    const body = (await res.json()) as { output?: Record<string, unknown>; confidence?: number };
    return { output: body.output ?? {}, confidence: typeof body.confidence === 'number' ? body.confidence : 0 };
  }
}

export type ServeStatus = 'OK' | 'TIMEOUT' | 'ERROR';
export interface ServeOutcome { status: ServeStatus; latencyMs: number; withinSla: boolean; output: Record<string, unknown>; confidence: number; error?: string }

/**
 * Runs one inference under the latency budget.
 *
 * The budget is enforced rather than measured. A model server that has stopped answering would otherwise
 * hold the caller's request open for as long as its own timeout allows, and the commitment the platform
 * made is about what the caller experiences, not about what the model eventually managed.
 */
export async function serve(provider: ServingProvider, req: InferRequest, slaMs: number): Promise<ServeOutcome> {
  const started = process.hrtime.bigint();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), slaMs);
  const elapsed = () => Number(process.hrtime.bigint() - started) / 1e6;
  try {
    const result = await provider.infer(req, controller.signal);
    const latencyMs = Math.round(elapsed());
    return { status: 'OK', latencyMs, withinSla: latencyMs <= slaMs, output: result.output, confidence: result.confidence };
  } catch (err) {
    const latencyMs = Math.round(elapsed());
    const aborted = controller.signal.aborted;
    return {
      status: aborted ? 'TIMEOUT' : 'ERROR',
      latencyMs, withinSla: false, output: {}, confidence: 0,
      error: aborted ? `Exceeded the ${slaMs} ms budget` : err instanceof Error ? err.message : String(err),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** Percentiles over a latency sample, for the serving report. Nearest-rank, so every value shown is a real one. */
export function percentiles(latencies: number[]): { p50: number; p95: number; p99: number; max: number } {
  if (!latencies.length) return { p50: 0, p95: 0, p99: 0, max: 0 };
  const sorted = [...latencies].sort((a, b) => a - b);
  const at = (p: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
  return { p50: at(50), p95: at(95), p99: at(99), max: sorted[sorted.length - 1] };
}
