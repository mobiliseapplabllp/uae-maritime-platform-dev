import { Controller, Get, Inject, Query } from '@nestjs/common';
import type { Pool } from 'pg';
import { KIT_ENV, KIT_POOL, RequirePerm } from '@maritime/service-kit';
import type { Env } from './env';
import { coverage, type CoverageDecision, type CoverageRequest, type CoverageService } from './coverage';
import type { Row } from './registry';

/* The adoption report.
 *
 * It reads three things and joins them here rather than in SQL, because the join is the definition: a service
 * is covered when a decision names it, and both sides of that sentence are rows this service already holds —
 * the catalogue and the requests as read models projected from their owning services, the decisions as its own
 * record of what its agents did.
 *
 * Nothing is written. Coverage is a reading of history, not a state to be kept up to date, so there is no
 * counter to drift out of step with the decisions it counts. */

@Controller('agents/coverage')
export class CoverageController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env) {}

  /** The agentic service rate against the directive's schedule, by domain and service. */
  @RequirePerm('agents.view') @Get()
  async coverage(@Query() query: { windowDays?: string; start?: string }) {
    const [defs, reqs, decs] = await Promise.all([
      this.pool.query<Row>('SELECT code, name, payload FROM service_definitions'),
      this.pool.query<Row>('SELECT id, service_code, submitted_at FROM service_requests'),
      // superseded decisions are the pre-review version of a decision that is still counted through its
      // successor; counting both would report one piece of work twice
      this.pool.query<Row>("SELECT agent_id, disposition, at, entity_id FROM decisions WHERE entity_type = 'ServiceRequest' AND supersedes_id IS NULL"),
    ]);

    const services: CoverageService[] = defs.rows.map((d) => {
      const p = (d.payload ?? {}) as Row;
      return {
        code: String(d.code), name: String(d.name), nameAr: p.nameAr ? String(p.nameAr) : undefined,
        domain: Number(p.domain) || 0, active: p.active !== false,
      };
    });
    const requests: CoverageRequest[] = reqs.rows
      .filter((r) => r.service_code && r.submitted_at)
      .map((r) => ({ id: String(r.id), serviceCode: String(r.service_code), submittedAt: r.submitted_at as string }));
    const decisions: CoverageDecision[] = decs.rows.map((d) => ({
      agentId: String(d.agent_id), disposition: String(d.disposition), at: d.at as string,
      requestId: d.entity_id ? String(d.entity_id) : null,
    }));

    const start = new Date(query.start ?? this.env.COVERAGE_START);
    return coverage(services, requests, decisions, new Date(), {
      windowDays: Number(query.windowDays) || this.env.COVERAGE_WINDOW_DAYS,
      start: Number.isNaN(start.getTime()) ? new Date(this.env.COVERAGE_START) : start,
    });
  }
}
