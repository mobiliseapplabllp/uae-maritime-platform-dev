/** What an adapter declares about itself. The registry is the single place that says which external
 *  systems the platform integrates with, and the stub fixtures beside it are the recorded contract. */
export interface AdapterOperation {
  /** Operation key, e.g. `verifyIdentity`. Stub fixtures are named after it. */
  key: string;
  summary: string;
  /** HTTP method and path template against the counterpart, e.g. GET /v1/identity/{emiratesId}. */
  method: 'GET' | 'POST' | 'PUT' | 'PATCH';
  path: string;
  /** Fields the caller must supply. Checked before a call leaves the platform, so a malformed
   *  request is a 400 from us rather than an unexplained rejection from the counterpart. */
  required: string[];
  /** Whether a repeat with the same idempotency key must return the recorded result rather than
   *  call again. True for anything that changes state on the far side. */
  idempotent: boolean;
}

export interface AdapterDefinition {
  key: string;
  name: string;
  nameAr: string;
  /** The organisation on the other end, named as the RFP names it. */
  counterpart: string;
  /** RFP or TAD reference this integration satisfies, so an adapter can be traced to its commitment. */
  reference: string;
  baseUrlEnv: string;
  defaultBaseUrl: string;
  /** SOAP counterparts get an envelope wrapper; the RFP allows SOAP only where one is mandated. */
  protocol: 'rest' | 'soap';
  operations: AdapterOperation[];
}

export interface CallRequest {
  adapter: string;
  operation: string;
  payload?: Record<string, unknown>;
  idempotencyKey?: string;
  correlationId?: string;
}

export interface CallOutcome {
  callId: string;
  adapter: string;
  operation: string;
  status: 'ok' | 'failed' | 'dead';
  mode: 'stub' | 'live';
  httpStatus: number | null;
  attempts: number;
  durationMs: number;
  data: unknown;
  error?: string;
  /** True when the result came from a previous call with the same idempotency key. */
  replayed?: boolean;
}
