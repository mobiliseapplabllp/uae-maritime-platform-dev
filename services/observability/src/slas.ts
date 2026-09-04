import { urlOf, serviceByName } from '@maritime/contracts';
import type { Env } from './env';
import type { ProbeResult } from './probes';

/* Service levels are measured as synthetic transactions: the monitor performs the same request a
 * real client performs, through the gateway, and times the whole path — edge, service, database.
 * That is what a user actually experiences, as opposed to a per-service health check which can be
 * green while the path through it is broken.
 *
 * Every probe here is a side-effect-free read. A sign-in probe using deliberately wrong credentials
 * would be a tidy way to prove the identity path, but it writes to login_attempts — a security audit
 * table — and would count against rate limiting. A monitor must not alter what it measures, so the
 * identity path is covered by its service probe instead. */

export interface SlaDefinition {
  key: string;
  label: string;
  /** The capability's owning area, for grouping in the UI. */
  domain: string;
  path: string;
  /** Statuses that mean the capability is working. */
  okStatus: number[];
  /** The service level: a slower response is a degradation, not an outage. */
  targetMs: number;
}

export const SLA_DEFINITIONS: SlaDefinition[] = [
  { key: 'sla.licence-verification', label: 'Licence verification', domain: 'Instruments', path: '/api/public/verify/OBSERVABILITY-PROBE', okStatus: [200, 404], targetMs: 400 },
  { key: 'sla.signing-key', label: 'Certificate signing key', domain: 'Instruments', path: '/api/public/signing-key', okStatus: [200], targetMs: 250 },
  { key: 'sla.jurisdiction', label: 'Jurisdiction configuration', domain: 'Master data', path: '/api/jurisdiction', okStatus: [200], targetMs: 300 },
  { key: 'sla.platform-health', label: 'Platform aggregate health', domain: 'Edge', path: '/api/health', okStatus: [200], targetMs: 1500 },
];

export async function probeSla(def: SlaDefinition, env: Env): Promise<ProbeResult> {
  const gw = serviceByName('gateway');
  const base = gw ? urlOf(gw, process.env) : 'http://127.0.0.1:5200';
  const url = `${base}${def.path}`;
  const t0 = Date.now();
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(env.OBSERVABILITY_PROBE_TIMEOUT_MS), headers: { 'user-agent': 'maritime-observability' } });
    await res.arrayBuffer().catch(() => undefined);
    const latencyMs = Date.now() - t0;
    const up = def.okStatus.includes(res.status);
    return {
      target: def.key,
      up,
      latencyMs,
      detail: { label: def.label, domain: def.domain, path: def.path, status: res.status, targetMs: def.targetMs, withinTarget: up && latencyMs <= def.targetMs },
      error: up ? undefined : `unexpected status ${res.status}`,
    };
  } catch (e) {
    return { target: def.key, up: false, latencyMs: null, detail: { label: def.label, domain: def.domain, path: def.path, targetMs: def.targetMs, withinTarget: false }, error: (e as Error).message };
  }
}
