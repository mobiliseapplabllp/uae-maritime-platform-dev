import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { KIT_BUS, KIT_ENV, KIT_LOGGER, KIT_POOL, withInbox, type AppLogger, type EventBus, type Subscription } from '@maritime/service-kit';
import { CATALOGUE } from './catalogue';
import { buildDataset } from './datasets';
import type { Env } from './env';
import { PlatformClient } from './platform';
import { TrainingRefused, reportToRegistry, runTraining, type ArtefactRow, type RunRow } from './training';

/*
 * What the fitter learns from the rest of the platform: the records it fits on arrive as the same read-model snapshots
 * every other service consumes, kept here as the few columns a feature is read from. The scheduler's retraining event
 * fits each model again when its rows have grown; nothing here changes what is deployed — a new fit is a draft version
 * in the registry until a person approves it.
 */
type Row = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const ts = (v: unknown): Date | null => { if (v === null || v === undefined || v === '') return null; const d = new Date(String(v)); return Number.isNaN(d.getTime()) ? null : d; };

export async function upsertVessel(c: PoolClient, e: Row) {
  await c.query(`INSERT INTO rm_vessels(id, imo, name, type, flag, built, class_society, real) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (id) DO UPDATE SET imo = EXCLUDED.imo, name = EXCLUDED.name, type = EXCLUDED.type, flag = EXCLUDED.flag, built = EXCLUDED.built, class_society = EXCLUDED.class_society, real = EXCLUDED.real, updated_at = now()`,
    [String(e.id), e.imo ?? '', e.name ?? '', e.type ?? '', e.flag ?? '', e.built === null || e.built === undefined ? null : Number(e.built), e.classSociety ?? '', !!e.real]);
}
export async function upsertInspection(c: PoolClient, e: Row) {
  const findings: Row[] = Array.isArray(e.findings) ? e.findings : [];
  await c.query(`INSERT INTO rm_inspections(id, number, vessel_id, type, status, result, detention, planned_at, closed_at, total_findings, subject_kind) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
    ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, vessel_id = EXCLUDED.vessel_id, type = EXCLUDED.type, status = EXCLUDED.status, result = EXCLUDED.result, detention = EXCLUDED.detention,
      planned_at = EXCLUDED.planned_at, closed_at = EXCLUDED.closed_at, total_findings = EXCLUDED.total_findings, subject_kind = EXCLUDED.subject_kind, updated_at = now()`,
    [String(e.id), e.number ?? '', e.vesselId ?? null, e.type ?? '', e.status ?? '', e.result ?? '', !!e.detention, ts(e.plannedAt), ts(e.closedAt), Number(e.totalFindings ?? findings.length) || 0, e.subjectKind ?? 'VESSEL']);
}
export async function upsertPortCall(c: PoolClient, e: Row) {
  const ops: Row[] = Array.isArray(e.cargoOps) ? e.cargoOps : [];
  const teu = ops.filter((o) => o.unit === 'TEU').reduce((s, o) => s + Number(o.qty || 0), 0);
  const cargoMt = ops.reduce((s, o) => s + Number(o.qtyMT || 0), 0);
  await c.query(`INSERT INTO rm_port_calls(id, vcn, vessel_id, vessel_type, agent_code, status, eta, etb, ata, atb, atd, prev_port, teu, cargo_mt) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
    ON CONFLICT (id) DO UPDATE SET vcn = EXCLUDED.vcn, vessel_id = EXCLUDED.vessel_id, vessel_type = EXCLUDED.vessel_type, agent_code = EXCLUDED.agent_code, status = EXCLUDED.status, eta = EXCLUDED.eta, etb = EXCLUDED.etb,
      ata = EXCLUDED.ata, atb = EXCLUDED.atb, atd = EXCLUDED.atd, prev_port = EXCLUDED.prev_port, teu = EXCLUDED.teu, cargo_mt = EXCLUDED.cargo_mt, updated_at = now()`,
    [String(e.id), e.vcn ?? '', e.vesselId ?? '', e.vesselType ?? '', e.agentCode ?? e.agent ?? '', e.status ?? '', ts(e.eta), ts(e.etb), ts(e.ata), ts(e.atb), ts(e.atd), e.prevPort ?? '', teu, cargoMt]);
}
const TABLES: Record<string, string> = { vessel: 'rm_vessels', inspection: 'rm_inspections', portCall: 'rm_port_calls' };
const PROJECT: Record<string, (c: PoolClient, e: Row) => Promise<void>> = { vessel: upsertVessel, inspection: upsertInspection, portCall: upsertPortCall };

export async function applyEvent(c: PoolClient, event: EventEnvelope): Promise<'projected' | 'deleted' | 'retrain' | null> {
  const d = (event.data ?? {}) as Row;
  if (event.type === EVENTS.readModel.upserted && PROJECT[d.kind] && d.entity?.id) { await PROJECT[d.kind](c, d.entity); return 'projected'; }
  if (event.type === EVENTS.readModel.deleted && TABLES[d.kind] && d.id) { await c.query(`DELETE FROM ${TABLES[d.kind]} WHERE id = $1`, [String(d.id)]); return 'deleted'; }
  if (event.type === EVENTS.scheduler.retrainModels) return 'retrain';
  return null;
}

export const SUBJECTS = [subjectFor(EVENTS.readModel.upserted), subjectFor(EVENTS.readModel.deleted), subjectFor(EVENTS.scheduler.retrainModels)];

/**
 * A scheduled retraining fits a model again only when there is materially more to learn from than last time: a fit on
 * the same rows is the same fit, and a registry full of identical drafts tells nobody anything.
 */
export async function retrainGrown(pool: Pool, env: Env, platform: PlatformClient | null, log?: AppLogger): Promise<{ model: string; rows: number; before: number; fitted: boolean; reason: string }[]> {
  const out = [];
  for (const def of CATALOGUE) {
    const now = await buildDataset(pool, env, def);
    const last = await pool.query<{ rows: number }>(`SELECT d.rows FROM training_runs r JOIN datasets d ON d.id = r.dataset_id WHERE r.model_key = $1 AND r.status = 'SUCCEEDED' ORDER BY r.started_at DESC LIMIT 1`, [def.key]);
    const before = last.rows[0]?.rows ?? 0;
    if (now.stats.rows - before < env.RETRAIN_MIN_NEW_ROWS) { out.push({ model: def.key, rows: now.stats.rows, before, fitted: false, reason: `${now.stats.rows - before} new rows, ${env.RETRAIN_MIN_NEW_ROWS} needed` }); continue; }
    try {
      const r = await runTraining(pool, env, platform, { key: def.key, initiatedBy: 'scheduler', note: `Scheduled refit on ${now.stats.rows} rows (${before} at the last fit)` });
      out.push({ model: def.key, rows: now.stats.rows, before, fitted: true, reason: `version ${r.artefact.version}` });
    } catch (e) {
      out.push({ model: def.key, rows: now.stats.rows, before, fitted: false, reason: e instanceof TrainingRefused ? e.message : (e as Error).message });
      log?.warn({ err: e, model: def.key }, 'scheduled refit failed');
    }
  }
  return out;
}

@Injectable()
export class ModelsConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  private readonly platform: PlatformClient;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, @Inject(KIT_LOGGER) private readonly log: AppLogger) {
    this.platform = new PlatformClient(env.AI_PLATFORM_URL, env.SERVICE_TOKEN);
  }
  async onModuleInit() { this.sub = await this.bus.subscribe('ai-models-consumer', SUBJECTS, (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) {
    let outcome: Awaited<ReturnType<typeof applyEvent>> = null;
    await withInbox(this.pool, event, async (c) => { outcome = await applyEvent(c, event); });
    // the refit runs outside the inbox transaction: it reads the projected rows and writes its own records
    if (outcome === 'retrain') { const r = await retrainGrown(this.pool, this.env, this.platform, this.log); this.log.info({ results: r }, 'scheduled retraining considered'); }
  }
}

/**
 * On boot, the registry is told about every artefact this server holds, so a fresh platform carries the measured
 * metrics of the seeded fits from its first page load. The platform may still be coming up, so the attempts are spaced
 * out and stop at the first that lands.
 */
@Injectable()
export class RegistrySync implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private readonly platform: PlatformClient;
  constructor(@Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, @Inject(KIT_LOGGER) private readonly log: AppLogger) {
    this.platform = new PlatformClient(env.AI_PLATFORM_URL, env.SERVICE_TOKEN);
  }
  onModuleInit() { if (this.env.REGISTRY_SYNC_ATTEMPTS > 0) this.attempt(1); }
  onModuleDestroy() { if (this.timer) clearTimeout(this.timer); }
  private attempt(n: number) {
    this.timer = setTimeout(async () => {
      const r = await this.syncAll();
      if (r.failed === 0 || n >= this.env.REGISTRY_SYNC_ATTEMPTS) { this.log.info({ ...r, attempt: n }, 'registry told about the artefacts held here'); return; }
      this.log.warn({ ...r, attempt: n }, 'registry not reached yet; will try again');
      this.attempt(n + 1);
    }, n === 1 ? 1500 : this.env.REGISTRY_SYNC_INTERVAL_MS);
    this.timer.unref();
  }
  async syncAll(): Promise<{ artefacts: number; reported: number; failed: number; error?: string }> {
    const artefacts = await this.pool.query<ArtefactRow>('SELECT * FROM artefacts ORDER BY model_key, version');
    let reported = 0; let error: string | undefined;
    for (const a of artefacts.rows) {
      const run = a.training_run_id ? (await this.pool.query<RunRow>('SELECT * FROM training_runs WHERE id = $1', [a.training_run_id])).rows[0] ?? null : null;
      const rows = run?.dataset_id ? Number((await this.pool.query<{ rows: number }>('SELECT rows FROM datasets WHERE id = $1', [run.dataset_id])).rows[0]?.rows ?? 0) : 0;
      const out = await reportToRegistry(this.pool, this.platform, a, run, { id: run?.dataset_id ?? null, rows });
      if (out.ok) reported += 1; else error = out.error;
    }
    return { artefacts: artefacts.rows.length, reported, failed: artefacts.rows.length - reported, error };
  }
}
