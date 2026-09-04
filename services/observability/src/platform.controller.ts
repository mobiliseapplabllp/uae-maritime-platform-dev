import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import type { Pool } from 'pg';
import { KIT_ENV, KIT_POOL, Public, RequirePerm, badRequest } from '@maritime/service-kit';
import type { Env } from './env';
import { Collector } from './collector';
import { availability, history, incidents, liveState } from './queries';
import { SLA_DEFINITIONS } from './slas';

const int = (v: unknown, dflt: number, min: number, max: number) => {
  const n = Number(v); return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.trunc(n))) : dflt;
};

@Controller()
export class PlatformController {
  private readonly started = Date.now();
  constructor(
    @Inject(KIT_POOL) private readonly pool: Pool,
    @Inject(KIT_ENV) private readonly env: Env,
    private readonly collector: Collector,
  ) {}

  /** Health carries the collector's heartbeat: a stale lastSweepAt means the loop is stuck even
   *  though the process is answering, which a plain 200 would hide. */
  @Public() @Get('health')
  health() {
    return {
      status: 'ok', service: this.env.SERVICE_NAME,
      uptimeSec: Math.round((Date.now() - this.started) / 1000), time: new Date().toISOString(),
      lastSweepAt: this.collector.lastSweepAt, lastSweep: this.collector.lastSweep, tickMs: this.env.OBSERVABILITY_TICK_MS,
    };
  }

  /** Everything the board needs in one call: live state, a headline count and open incidents. */
  @RequirePerm('platform.view') @Get('platform/status')
  async status() {
    const [targets, open] = await Promise.all([liveState(this.pool), incidents(this.pool, 50, true)]);
    const services = targets.filter((t) => t.kind === 'service');
    return {
      generatedAt: new Date().toISOString(),
      lastSweepAt: this.collector.lastSweepAt,
      tickMs: this.env.OBSERVABILITY_TICK_MS,
      summary: {
        services: services.length,
        servicesUp: services.filter((t) => t.up).length,
        targets: targets.length,
        targetsUp: targets.filter((t) => t.up).length,
        openIncidents: open.length,
        // "Healthy" means every probe is green, including infrastructure and service levels.
        status: targets.every((t) => t.up) ? 'ok' : targets.some((t) => t.kind === 'service' && !t.up) ? 'down' : 'degraded',
      },
      targets, openIncidents: open,
    };
  }

  @RequirePerm('platform.view') @Get('platform/availability')
  async availability(@Query('hours') hours?: string) {
    return availability(this.pool, int(hours, 24, 1, 24 * 90));
  }

  @RequirePerm('platform.view') @Get('platform/history/:target')
  async history(@Param('target') target: string, @Query('granularity') granularity?: string, @Query('limit') limit?: string) {
    const g = granularity === 'day' ? 'day' : 'hour';
    if (!/^[a-z0-9.-]{1,80}$/.test(target)) throw badRequest('unknown target');
    return history(this.pool, target, g, int(limit, g === 'day' ? 30 : 48, 1, 400));
  }

  @RequirePerm('platform.view') @Get('platform/incidents')
  async incidents(@Query('limit') limit?: string, @Query('open') open?: string) {
    return incidents(this.pool, int(limit, 50, 1, 500), open === 'true');
  }

  /** The declared service levels alongside what is currently measured against them. */
  @RequirePerm('platform.view') @Get('platform/slas')
  async slas() {
    const [state, avail] = await Promise.all([liveState(this.pool), availability(this.pool, 24)]);
    const byTarget = new Map(avail.map((a) => [a.target, a]));
    return SLA_DEFINITIONS.map((d) => {
      const live = state.find((s) => s.target === d.key);
      const a = byTarget.get(d.key);
      return {
        key: d.key, label: d.label, domain: d.domain, path: d.path, targetMs: d.targetMs,
        up: live?.up ?? null, latencyMs: live?.latencyMs ?? null,
        withinTarget: (live?.detail as { withinTarget?: boolean } | undefined)?.withinTarget ?? null,
        availability24h: a?.availability ?? null, latencyP95: a?.latencyP95 ?? null,
      };
    });
  }

  /** Who talks to whom, for the topology view: the shared registry plus live state. */
  @RequirePerm('platform.view') @Get('platform/topology')
  async topology() {
    const state = await liveState(this.pool);
    const nodes = state.filter((s) => s.kind !== 'sla').map((s) => ({
      id: s.target, kind: s.kind, category: s.category, up: s.up, latencyMs: s.latencyMs,
    }));
    return { nodes, generatedAt: new Date().toISOString() };
  }
}
