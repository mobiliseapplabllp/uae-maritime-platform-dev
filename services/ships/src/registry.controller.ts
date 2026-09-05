import { Body, Controller, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { z } from 'zod';
import type { Pool } from 'pg';
import type { PageQuery } from '@maritime/contracts';
import { AuditClient, CurrentUser, KIT_ENV, KIT_POOL, RequirePerm, badRequest, conflict, escapeLike, notFound, paged, parsePage, scopeWhere, withTx, zod, type Principal } from '@maritime/service-kit';
import type { Env } from './env';
import { findVessel, type VesselRow } from './vessels';
import { REGISTRATION_SCOPE } from './scope';
import { dischargeEncumbrance, issueTranscript, liveCaveats, masterRecord, recordTransaction, registerEncumbrance, transactionApi, transactionTypes, transactionsFor, verifyTranscript, type TransactionRow } from './transactions';
import { kindRules } from './registry';

/* The register as one record per ship, and the ledger the registrar writes against it directly.
 *
 * A registration journey is an application the registrar decides; what is here needs no journey: a mortgage
 * the parties have executed is registered on production of the deed, a discharge on production of the
 * release, a caveat on a claimant's notice, a transcript on request. Each is a transaction of a kind the
 * `registryTransactionType` master marks as direct, and each is refused unless the ship holds an entry. */

const text = (max: number) => z.string().trim().max(max);
const transactionSchema = z.object({ type: text(40).min(1), particulars: z.record(z.unknown()).default({}), notes: text(2000).default('') });
const encumbranceSchema = z.object({ kind: z.enum(['MORTGAGE', 'LIEN', 'CHARGE']).default('MORTGAGE'), holder: text(200).min(1), amount: z.coerce.number().min(0).default(0), currency: text(8).optional(), registeredOn: z.string().nullable().optional(), reference: text(120).default(''), notes: text(1000).default('') });
const dischargeSchema = z.object({ dischargedOn: z.string().nullable().optional(), reference: text(120).optional(), notes: text(1000).default('') });
const transcriptSchema = z.object({ purpose: text(300).default('') });
const ENTRY_STATES = ['PROVISIONAL', 'REGISTERED', 'BAREBOAT_IN', 'BAREBOAT_OUT'];

@Controller()
export class RegistryController {
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}

  private async vessel(c: Pool | import('pg').PoolClient, id: string, user: Principal): Promise<VesselRow> {
    const v = await findVessel(c, id, user.scope);
    if (!v) throw notFound('Vessel not found');
    return v;
  }
  private entered(v: VesselRow, what: string) { if (!ENTRY_STATES.includes(v.registry_state)) throw conflict(`${v.name} holds no registry entry to ${what} against`); }

  /** The kinds of transaction the ledger takes, and which the registrar records directly. */
  @RequirePerm('registry.view') @Get('registry/transaction-types')
  async types() { return transactionTypes(this.pool); }

  /** The whole ledger across the register — worst-first is by date. */
  @RequirePerm('registry.view') @Get('registry/transactions')
  async ledger(@Query() query: PageQuery & { type?: string; vesselId?: string; from?: string; to?: string }, @CurrentUser() user: Principal) {
    const p = parsePage(query, { defaultSort: '-recordedOn', sortable: ['recordedOn', 'number', 'type', 'vesselName'], maxLimit: 500 });
    const where: string[] = []; const args: unknown[] = [];
    const add = (sql: (i: number) => string, value: unknown) => { args.push(value); where.push(sql(args.length)); };
    if (query.type) add((i) => `type = $${i}`, query.type);
    if (query.vesselId) add((i) => `vessel_id::text = $${i}`, query.vesselId);
    if (query.from) add((i) => `recorded_on >= $${i}`, new Date(query.from));
    if (query.to) add((i) => `recorded_on <= $${i}`, new Date(`${query.to}T23:59:59Z`));
    if (p.q) add((i) => `(number ILIKE $${i} OR vessel_name ILIKE $${i} OR official_number ILIKE $${i} OR application_no ILIKE $${i})`, `%${escapeLike(p.q)}%`);
    scopeWhere(user.scope, where, args, REGISTRATION_SCOPE);
    const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const col: Record<string, string> = { recordedOn: 'recorded_on', number: 'number', type: 'type', vesselName: 'vessel_name' };
    const total = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM registry_transactions ${w}`, args);
    const rows = await this.pool.query<TransactionRow>(`SELECT * FROM registry_transactions ${w} ORDER BY ${col[p.sortField]} ${p.sortDir}, number DESC LIMIT ${p.limit} OFFSET ${p.offset}`, args);
    return paged(rows.rows.map(transactionApi), { total: Number(total.rows[0].n), page: p.page, limit: p.limit });
  }

  /** The master record: everything the register holds on one ship, assembled from the entry and the ledger. */
  @RequirePerm('registry.view', 'vessels.view') @Get('vessels/:id/registry')
  async record(@Param('id') id: string, @CurrentUser() user: Principal) { return masterRecord(this.pool, this.env, await this.vessel(this.pool, id, user)); }

  @RequirePerm('registry.view', 'vessels.view') @Get('vessels/:id/registry/transactions')
  async transactions(@Param('id') id: string, @CurrentUser() user: Principal) {
    const v = await this.vessel(this.pool, id, user);
    return { vesselId: v.id, vesselName: v.name, officialNumber: v.official_number, transactions: await transactionsFor(this.pool, v.id), caveats: (await liveCaveats(this.pool, v.id)).length };
  }

  /* A direct transaction. Mortgages and discharges keep the encumbrance register in step; a caveat withdrawal
   * names the caveat it lifts; a change of manager is written onto the ship. Anything else the master marks
   * direct is recorded with its particulars as given. */
  @RequirePerm('registry.assess', 'registry.grant') @Post('vessels/:id/registry/transactions')
  async recordDirect(@Param('id') id: string, @Body(zod(transactionSchema)) b: z.infer<typeof transactionSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => {
      const v = await this.vessel(c, id, user);
      const type = (await transactionTypes(c)).find((t) => t.code === b.type);
      if (!type) throw badRequest(`"${b.type}" is not an active entry of the registryTransactionType master`, { category: 'registryTransactionType' });
      if (!type.direct) throw conflict(`${type.label} is recorded by granting the application that carries it, not directly`);
      this.entered(v, type.label.toLowerCase());
      const p = b.particulars as Record<string, unknown>;
      if (b.type === 'MORTGAGE_REGISTRATION') {
        const parsed = encumbranceSchema.parse(p);
        const done = await registerEncumbrance(c, this.env, this.audit, v, { ...parsed, notes: b.notes }, user);
        return { transaction: transactionApi(done.transaction), encumbranceId: done.encumbrance.id };
      }
      if (b.type === 'MORTGAGE_DISCHARGE') {
        const encumbranceId = String(p.encumbranceId ?? '');
        if (!encumbranceId) throw badRequest('A discharge names the charge it releases (particulars.encumbranceId)');
        const done = await dischargeEncumbrance(c, this.env, this.audit, v, encumbranceId, { ...dischargeSchema.parse(p), notes: b.notes }, user);
        return { transaction: transactionApi(done.transaction), encumbranceId: done.encumbrance.id };
      }
      if (b.type === 'CAVEAT_WITHDRAWAL') {
        const live = await liveCaveats(c, v.id);
        const target = live.find((t) => t.id === p.caveatId || t.number === p.caveatNo);
        if (!target) throw badRequest('A withdrawal names a caveat that is lodged (particulars.caveatId or caveatNo)');
        const row = await recordTransaction(c, this.env, this.audit, v, { type: b.type, particulars: { caveatId: target.id, caveatNo: target.number, ...p }, notes: b.notes, by: user });
        return { transaction: transactionApi(row) };
      }
      if (b.type === 'CAVEAT' && !p.lodgedBy) throw badRequest('A caveat records who lodged it (particulars.lodgedBy)');
      if (b.type === 'CHANGE_OF_MANAGER') {
        if (!p.manager) throw badRequest('A change of manager names the new manager (particulars.manager)');
        await c.query('UPDATE vessels SET manager = $2, updated_at = now() WHERE id = $1', [v.id, String(p.manager)]);
      }
      if (b.type === 'TRANSCRIPT') { const t = await issueTranscript(c, this.env, this.audit, v, user, String(p.purpose ?? b.notes ?? '')); return { transaction: null, transcript: t }; }
      const row = await recordTransaction(c, this.env, this.audit, v, { type: b.type, particulars: p, notes: b.notes, by: user });
      return { transaction: transactionApi(row) };
    });
  }

  /** An attested transcript of registry: numbered, sealed with a digest of the register as it stands, and recorded on the ledger. */
  @RequirePerm('registry.assess', 'registry.grant') @Post('vessels/:id/registry/transcripts')
  async transcript(@Param('id') id: string, @Body(zod(transcriptSchema)) b: z.infer<typeof transcriptSchema>, @CurrentUser() user: Principal) {
    return withTx(this.pool, async (c) => { const v = await this.vessel(c, id, user); this.entered(v, 'issue a transcript'); return issueTranscript(c, this.env, this.audit, v, user, b.purpose); });
  }
  /** Whether a transcript number still attests the register as it stands. */
  @RequirePerm('registry.view', 'vessels.view') @Get('vessels/:id/registry/transcripts/:no')
  async verify(@Param('id') id: string, @Param('no') no: string, @CurrentUser() user: Principal) {
    return verifyTranscript(this.pool, await this.vessel(this.pool, id, user), this.env.JURISDICTION, no);
  }
  /** The variants the register offers today, as the master declares them. */
  @RequirePerm('registry.view') @Get('registry/kinds')
  async kinds() { return [...(await kindRules(this.pool)).values()]; }
}
