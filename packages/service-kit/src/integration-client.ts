/**
 * The one way a service reaches an external system: through the integration hub, on the service token. The hub owns
 * the adapter registry, the counterpart's address and credentials, the retry policy, the idempotency ledger and the
 * dead-letter queue — a caller names an adapter and an operation and gets an outcome, never a URL.
 */
export interface IntegrationOutcome<T = unknown> {
  callId: string; adapter: string; operation: string;
  status: 'ok' | 'failed' | 'dead'; mode: 'stub' | 'live';
  httpStatus: number | null; attempts: number; durationMs: number;
  data: T; error?: string; replayed?: boolean;
}
export interface IntegrationCallOptions { idempotencyKey?: string; correlationId?: string; timeoutMs?: number }

/** Thrown when the hub itself cannot be reached or answers outside its contract — distinct from a counterpart failing, which is an outcome. */
export class HubUnavailable extends Error { constructor(message: string, override readonly cause?: unknown) { super(message); this.name = 'HubUnavailable'; } }

export class IntegrationClient {
  constructor(private readonly hubUrl: string, private readonly serviceToken: string, private readonly defaultTimeoutMs = 15_000) {}

  async call<T = unknown>(adapter: string, operation: string, payload: Record<string, unknown> = {}, opts: IntegrationCallOptions = {}): Promise<IntegrationOutcome<T>> {
    const url = `${this.hubUrl.replace(/\/+$/, '')}/internal/call/${encodeURIComponent(adapter)}`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': this.serviceToken },
        body: JSON.stringify({ operation, payload, idempotencyKey: opts.idempotencyKey, correlationId: opts.correlationId }),
        signal: AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs),
      });
    } catch (e) { throw new HubUnavailable(`integration hub unreachable: ${(e as Error).message}`, e); }
    const text = await res.text();
    let parsed: { data?: IntegrationOutcome<T>; message?: string } = {};
    try { parsed = JSON.parse(text); } catch { throw new HubUnavailable(`integration hub answered ${res.status} with a body that is not JSON`); }
    if (!res.ok) throw new HubUnavailable(parsed.message ?? `integration hub answered ${res.status}`);
    if (!parsed.data || typeof parsed.data !== 'object') throw new HubUnavailable('integration hub answered without an outcome');
    return parsed.data;
  }

  /** A call whose failure is an outcome the caller records, not an exception it has to catch. */
  async tryCall<T = unknown>(adapter: string, operation: string, payload: Record<string, unknown> = {}, opts: IntegrationCallOptions = {}): Promise<IntegrationOutcome<T> | { status: 'unavailable'; error: string }> {
    try { return await this.call<T>(adapter, operation, payload, opts); }
    catch (e) { return { status: 'unavailable', error: (e as Error).message }; }
  }
}
