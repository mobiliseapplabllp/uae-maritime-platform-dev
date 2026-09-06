import { Body, Controller, Get, Inject, Put, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import { DEFAULT_RISK_WEIGHTS, EVENTS } from '@maritime/contracts';
import { CurrentUser, notFound, visibleTo, type Principal, AuditClient, KIT_ENV, KIT_POOL, RequirePerm, badRequest, enqueue, eventFromContext, paged, withTx, zod, KIT_SETTINGS, SettingsClient } from '@maritime/service-kit';
import { RISK_SCOPE } from './scope';
import type { Env } from './env';
import { iso, type Row } from './vessels';
import { WEIGHT_KEYS, WEIGHT_MAX, computeScores, loadWeights, saveWeights } from './risk';

/* The risk screens: the register of scored ships, the boarding-target list drawn from it, and the model
 * weights themselves — policy, so every change is audited and the scores are recomputed from it live. */

const weightsBody = z.object(Object.fromEntries(WEIGHT_KEYS.map((k) => [k, z.coerce.number().min(0).max(WEIGHT_MAX).optional()]))).strict();
const ACTIVE_CALLS = ['ANNOUNCED', 'CONFIRMED', 'AT_ANCHORAGE', 'BERTHED'];

@Controller('risk')
export class RiskController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient, @Inject(KIT_SETTINGS) private readonly settings: SettingsClient) {}
  /* Scoring the fleet reads every ship, certificate and inspection. Ships → settings says how long a scoring stays good for
   * (0 scores on every request); the certificate window is the same one the register uses. A weights change starts afresh. */
  private memo: { at: number; window: number; value: Awaited<ReturnType<typeof computeScores>> } | null = null;
  private async scored() {
    const s = await this.settings.moduleGet('ships', { certExpiringDays: this.env.CERT_EXPIRING_DAYS, riskRefreshMinutes: 0 });
    const window = Number(s.certExpiringDays) || this.env.CERT_EXPIRING_DAYS; const ttl = Math.max(0, Number(s.riskRefreshMinutes) || 0) * 60_000;
    if (this.memo && ttl && this.memo.window === window && Date.now() - this.memo.at < ttl) return { ...this.memo.value, computedAt: new Date(this.memo.at).toISOString(), cached: true };
    const value = await computeScores(this.pool, window); this.memo = { at: Date.now(), window, value };
    return { ...value, computedAt: new Date(this.memo.at).toISOString(), cached: false };
  }

  /** Every active ship with her live, factor-decomposed score; the weights in force travel in `meta`. */
  @RequirePerm('risk.view') @Get('scores')
  async scores(@CurrentUser() user: Principal, @Query('band') band?: string) {
    /* The risk register is how the administration ranks who it distrusts — detentions, deficiencies, agent
     * performance. It scores the whole fleet or it scores nothing; there is no partial view of a ranking. */
    if (!visibleTo(user.scope, {}, RISK_SCOPE)) return paged([], { total: 0, page: 1, limit: 1 });
    const { rows, weights, computedAt, cached } = await this.scored();
    const out = band ? rows.filter((r) => r.band === band) : rows;
    return paged(out, { total: out.length, page: 1, limit: out.length, weights, computedAt, cached });
  }

  /** Ships in port or inbound, ordered by risk — where surveyor hours should go. */
  @RequirePerm('risk.view') @Get('targeting')
  async targeting(@CurrentUser() user: Principal) {
    if (!visibleTo(user.scope, {}, RISK_SCOPE)) return paged([], { total: 0, page: 1, limit: 1 });
    const { rows } = await this.scored();
    const byVessel = new Map(rows.map((r) => [r.vesselId, r]));
    const calls = await this.pool.query<Row>('SELECT id, vcn, vessel_id, status, eta, berth_code FROM port_calls WHERE status = ANY($1) ORDER BY eta', [ACTIVE_CALLS]);
    const list = calls.rows
      .map((c) => ({ callId: c.id, vcn: c.vcn, status: c.status, eta: iso(c.eta), berth: c.berth_code ?? null, vesselId: c.vessel_id, vessel: byVessel.get(c.vessel_id)?.name ?? '', risk: byVessel.get(c.vessel_id) ?? null }))
      .filter((x) => x.risk)
      .sort((a, b) => (b.risk!.score - a.risk!.score));
    return paged(list, { total: list.length, page: 1, limit: list.length, computedAt: new Date().toISOString() });
  }

  @RequirePerm('risk.view') @Get('weights')
  async weights(@CurrentUser() user: Principal) {
    if (!visibleTo(user.scope, {}, RISK_SCOPE)) throw notFound('Not found');
    return loadWeights(this.pool);
  }

  /** Weights are policy: a change is recorded against the officer's name and the scores move with it. */
  @RequirePerm('risk.manage') @Put('weights')
  async updateWeights(@Body(zod(weightsBody)) body: Record<string, number | undefined>) {
    this.memo = null;
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
