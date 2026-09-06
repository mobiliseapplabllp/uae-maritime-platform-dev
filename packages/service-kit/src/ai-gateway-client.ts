/* The client every AI service uses to reach the tool gateway — and, through it, the platform. Nothing in the AI
 * layer calls a platform service directly: a tool runs here, as the person whose token is carried or as the agent
 * the caller is, and a completion goes out here, redacted and fenced by the gateway before any model sees it. */

export type GatewayTier = 'READ' | 'PROPOSE' | 'ACT' | 'INFER';
export interface GatewayTool {
  name: string; module: string; label: string; labelAr: string; description: string; tier: GatewayTier; permission: string; exposure: 'ASSISTANT' | 'AGENT' | 'BOTH';
  input: Record<string, { type: 'string' | 'number' | 'boolean'; description: string; required?: boolean; enum?: string[] }>; triggers: string[]; enabled: boolean; allowed: boolean;
}
export interface GatewayRun {
  callId: string; outcome: 'OK' | 'REFUSED' | 'FAILED' | 'DRY_RUN'; tool: string; tier: GatewayTier; module: string; latencyMs: number;
  code?: string; reason?: string; status?: number; data?: unknown; principal?: { id: string; name: string; kind: string }; request?: { method: string; url: string; body?: unknown };
}
export interface GatewayBlock { marker: string; label: string; kind: string; untrusted?: boolean; text: string }
export interface GatewayCompleteRequest {
  purpose?: string; contract: string; question: string; language: 'en' | 'ar'; grounding: GatewayBlock[]; findings: string[]; refusals: string[];
  history: { role: 'user' | 'assistant'; text: string }[]; temperature?: number;
}
export interface GatewayCompletion {
  outcome: 'OK' | 'REFUSED' | 'FAILED' | 'LOCAL'; provider: string; profile: string; residency: string; latencyMs: number;
  text?: string; code?: string; reason?: string; redactions: number; redactionKinds: Record<string, number>; injection: { score: number; flags: string[] }; fingerprint?: string; tokensIn?: number; tokensOut?: number;
}
export interface GatewayCallOptions { userToken?: string; dryRun?: boolean; decisionId?: string; cause?: string }
export class GatewayUnavailable extends Error { constructor(message: string, override readonly cause?: unknown) { super(message); this.name = 'GatewayUnavailable'; } }

export class AiGatewayClient {
  private catalogueCache = new Map<string, { at: number; tools: GatewayTool[] }>();
  constructor(private readonly url: string, private readonly serviceToken: string, private readonly timeoutMs = 20_000, private readonly catalogueTtlMs = 60_000) {}

  /** The tools as one caller may see them, cached for a minute: a catalogue changes when an administrator changes it, not between two questions. */
  async catalogue(caller: string): Promise<GatewayTool[]> {
    const hit = this.catalogueCache.get(caller);
    if (hit && Date.now() - hit.at < this.catalogueTtlMs) return hit.tools;
    const body = await this.request<{ tools: GatewayTool[] }>('GET', `/ai-gateway/tools/catalogue?caller=${encodeURIComponent(caller)}`);
    this.catalogueCache.set(caller, { at: Date.now(), tools: body.tools });
    return body.tools;
  }
  invalidate() { this.catalogueCache.clear(); }

  /** Runs one tool. The gateway's verdict is the return value, never an exception: a refusal is an answer, and the caller records it as one. */
  run(caller: string, tool: string, args: Record<string, unknown> = {}, opts: GatewayCallOptions = {}): Promise<GatewayRun> {
    return this.request<GatewayRun>('POST', `/ai-gateway/tools/${encodeURIComponent(tool)}/run`, { caller, args, dryRun: opts.dryRun ?? false, decisionId: opts.decisionId, cause: opts.cause }, opts.userToken);
  }

  /** One completion through the configured provider. `LOCAL` means no hosted provider is configured and the caller composes for itself. */
  complete(caller: string, req: GatewayCompleteRequest, opts: { userToken?: string } = {}): Promise<GatewayCompletion> {
    return this.request<GatewayCompletion>('POST', '/ai-gateway/complete', { caller, ...req }, opts.userToken);
  }

  /** The gateway answered but not with a verdict, or did not answer at all: `GatewayUnavailable`, which every caller has a plan for. */
  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, userToken?: string): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.url}${path}`, {
        method, signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'content-type': 'application/json', 'x-service-token': this.serviceToken, ...(userToken ? { 'x-user-token': userToken } : {}) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) { throw new GatewayUnavailable(`The tool gateway did not answer: ${(err as Error).message}`, err); }
    const json = (await res.json().catch(() => ({}))) as { success?: boolean; data?: T; message?: string };
    if (!res.ok || json.success === false || json.data === undefined) throw new GatewayUnavailable(json.message ?? `The tool gateway answered ${res.status}`);
    return json.data;
  }
}
