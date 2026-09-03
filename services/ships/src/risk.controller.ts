import { Body, Controller, Get, Inject, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { DEFAULT_RISK_WEIGHTS, EVENTS } from '@maritime/contracts';
import { AuditClient, KIT_ENV, KIT_POOL, RequirePerm, badRequest, enqueue, eventFromContext, paged, withTx, zod } from '@maritime/service-kit';
import type { Env } from './env';
import { iso, type Row } from './vessels';
import { WEIGHT_KEYS, WEIGHT_MAX, computeScores, loadWeights, saveWeights } from './risk';

/* The risk screens: the register of scored ships, the boarding-target list drawn from it, and the model
 * weights themselves — policy, so every change is audited and the scores are recomputed from it live. */

const weightsBody = z.object(Object.fromEntries(WEIGHT_KEYS.map((k) => [k, z.coerce.number().min(0).max(WEIGHT_MAX).optional()]))).strict();
const ACTIVE_CALLS = ['ANNOUNCED', 'CONFIRMED', 'AT_ANCHORAGE', 'BERTHED'];

@Controller('risk')
export class RiskController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  /** Every active ship with her live, factor-decomposed score; the weights in force travel in `meta`. */
  @RequirePerm('risk.view') @Get('scores')
  async scores(@Query('band') band?: string) {
    const { rows, weights } = await computeScores(this.pool, this.env.CERT_EXPIRING_DAYS);
    const out = band ? rows.filter((r) => r.band === band) : rows;
    return paged(out, { total: out.length, page: 1, limit: out.length, weights, computedAt: new Date().toISOString() });
  }

  /** Ships in port or inbound, ordered by risk — where surveyor hours should go. */
  @RequirePerm('risk.view') @Get('targeting')
  async targeting() {
    const { rows } = await computeScores(this.pool, this.env.CERT_EXPIRING_DAYS);
    const byVessel = new Map(rows.map((r) => [r.vesselId, r]));
    const calls = await this.pool.query<Row>('SELECT id, vcn, vessel_id, status, eta, berth_code FROM port_calls WHERE status = ANY($1) ORDER BY eta', [ACTIVE_CALLS]);
    const list = calls.rows
      .map((c) => ({ callId: c.id, vcn: c.vcn, status: c.status, eta: iso(c.eta), berth: c.berth_code ?? null, vesselId: c.vessel_id, vessel: byVessel.get(c.vessel_id)?.name ?? '', risk: byVessel.get(c.vessel_id) ?? null }))
      .filter((x) => x.risk)
      .sort((a, b) => (b.risk!.score - a.risk!.score));
    return paged(list, { total: list.length, page: 1, limit: list.length, computedAt: new Date().toISOString() });
  }

  @RequirePerm('risk.view') @Get('weights')
  async weights() { return loadWeights(this.pool); }

  /** Weights are policy: a change is recorded against the officer's name and the scores move with it. */
  @RequirePerm('risk.manage') @Put('weights')
  async updateWeights(@Body(zod(weightsBody)) body: Record<string, number | undefined>) {
    const clean: Record<string, number> = {};
    for (const k of WEIGHT_KEYS) if (body[k] !== undefined) clean[k] = Number(body[k]);
    if (!Object.keys(clean).length) throw badRequest('Nothing to update');
    return withTx(this.pool, async (c) => {
      const before = await loadWeights(c);
      const after = { ...DEFAULT_RISK_WEIGHTS, ...before, ...clean };
      await saveWeights(c, after);
      await this.audit.record(c, { action: 'UPDATE', entity: 'Setting', entityId: 'riskWeights', entityLabel: 'Risk model weights', before, after });
      await enqueue(c, eventFromContext(this.env.SERVICE_NAME, EVENTS.ships.riskWeightsChanged, { key: 'riskWeights', before, after }, { subject: 'riskWeights' }));
      return after;
    });
  }
}
