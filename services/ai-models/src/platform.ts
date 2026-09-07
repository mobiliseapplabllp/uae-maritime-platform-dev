/*
 * The model platform is the registry; this server is the fitter. Every artefact this server holds is reported to the
 * registry as a training run and a version carrying the metrics that were actually measured — so the registry's
 * governance (validation, approval, deployment) is exercised on a fit that happened, never on a number typed in.
 */
export interface TrainedReport {
  version: number; artifactRef: string; framework: string; featureSet: string;
  params: Record<string, unknown>; metrics: Record<string, unknown>;
  datasetRef: string; datasetRows: number; note: string; initiatedBy: string;
  startedAt: string; finishedAt: string;
}
export type RegistryOutcome =
  | { ok: true; version: number; status: string; trainingRunId: string; created: boolean }
  | { ok: false; error: string; httpStatus?: number };

export class PlatformClient {
  constructor(private readonly baseUrl: string, private readonly serviceToken: string, private readonly timeoutMs = 10_000) {}
  async trained(key: string, report: TrainedReport): Promise<RegistryOutcome> {
    const url = `${this.baseUrl.replace(/\/+$/, '')}/ai-platform/internal/models/${encodeURIComponent(key)}/trained`;
    let res: Response;
    try {
      res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', 'x-service-token': this.serviceToken }, body: JSON.stringify(report), signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (e) { return { ok: false, error: `model platform unreachable: ${(e as Error).message}` }; }
    let body: { data?: { version: number; status: string; trainingRunId: string; created: boolean }; message?: string } = {};
    try { body = (await res.json()) as typeof body; } catch { return { ok: false, error: `model platform answered ${res.status} without JSON`, httpStatus: res.status }; }
    if (!res.ok || !body.data) return { ok: false, error: body.message ?? `model platform answered ${res.status}`, httpStatus: res.status };
    return { ok: true, ...body.data };
  }
}
