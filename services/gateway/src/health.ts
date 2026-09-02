import type { ResolvedService } from './routes';

export type UpstreamStatus = 'ok' | 'down';
export interface ServiceHealth { name: string; url: string; status: UpstreamStatus }
export interface AggregatedHealth { status: 'ok' | 'degraded'; services: ServiceHealth[] }

/** Probes `<url>/health` of every upstream in parallel with a short timeout. */
export async function aggregateHealth(services: ResolvedService[], timeoutMs: number): Promise<AggregatedHealth> {
  const results = await Promise.all(
    services.map(async (s): Promise<ServiceHealth> => {
      try {
        const res = await fetch(`${s.url}/health`, { signal: AbortSignal.timeout(timeoutMs), headers: { 'user-agent': 'maritime-gateway/health' } });
        await res.arrayBuffer().catch(() => undefined);
        return { name: s.name, url: s.url, status: res.ok ? 'ok' : 'down' };
      } catch {
        return { name: s.name, url: s.url, status: 'down' };
      }
    }),
  );
  return { status: results.every((r) => r.status === 'ok') ? 'ok' : 'degraded', services: results };
}
