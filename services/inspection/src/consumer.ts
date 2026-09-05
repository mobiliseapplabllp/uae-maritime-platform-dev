import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import { EVENTS, subjectFor, type EventEnvelope } from '@maritime/contracts';
import { AuditClient, KIT_BUS, KIT_ENV, KIT_POOL, LOOKUP_SUBJECTS, applyLookupEvent, withInbox, type EventBus, type Subscription } from '@maritime/service-kit';
import type { Env } from './env';
import { inspectionApi, publishInspection, type FindingRow, type InspectionRow, type Row } from './inspections';
import { findingApi } from './inspections';
import { projectSnapshot, refreshOpenInspections } from './subjects';
import { draftNotice, draftReport, routeRecommendation, sweepOverdueFindings } from './smart';

/* What the survey desk learns from the rest of the platform.
 *
 * Ships and calls are projected into local snapshots so the register renders and validates from one database.
 * When a ship's particulars change, the open surveys against her are corrected and republished — closed ones
 * are left alone, because a closed survey records what was found on the day, not what is true now.
 * Consumption is idempotent through the inbox: a redelivered event changes nothing twice. */

export interface Deps { env: Env; audit: AuditClient }

async function findingsOf(c: PoolClient, id: string) {
  const r = await c.query<FindingRow>('SELECT * FROM findings WHERE inspection_id = $1 ORDER BY seq', [id]);
  return r.rows.map(findingApi);
}

/* The Smart Inspection agent's judgement of a ship, kept as the latest per ship so a survey planned against her carries it. */
async function rememberAgentJudgement(c: PoolClient, event: EventEnvelope): Promise<boolean> {
  const d = (event.data ?? {}) as Row;
  if (event.type !== EVENTS.ai.decisionRecorded || d.agentId !== 'a5_smart_inspection') return false;
  const decision: Row = d.decision ?? {};
  const vesselId = d.entityId ?? decision.entityId;
  if (!vesselId || String(d.entityType ?? decision.entityType ?? 'Vessel') !== 'Vessel') return false;
  const out: Row = decision.output ?? {};
  const codes = Array.isArray(out.predictedDeficiencies) ? (out.predictedDeficiencies as Row[]).map((p) => String(p.code ?? p)).filter(Boolean) : [];
  await c.query(`INSERT INTO vessel_predictions(vessel_id, decision_id, agent_id, predicted_at, risk_score, band, predicted_codes, dossier) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (vessel_id) DO UPDATE SET decision_id = EXCLUDED.decision_id, agent_id = EXCLUDED.agent_id, predicted_at = EXCLUDED.predicted_at, risk_score = EXCLUDED.risk_score, band = EXCLUDED.band, predicted_codes = EXCLUDED.predicted_codes, dossier = EXCLUDED.dossier, updated_at = now()
    WHERE vessel_predictions.predicted_at <= EXCLUDED.predicted_at`,
    [String(vesselId), d.decisionId ?? decision.id ?? null, String(d.agentId), decision.createdAt ?? decision.at ?? event.time, out.riskScore == null ? null : Number(out.riskScore), String(out.band ?? ''), JSON.stringify(codes), out.dossier ? JSON.stringify(out.dossier) : null]);
  return true;
}
/* A draft the assistant prepared on a survey: the report, or the deficiency notice, first written by the machine. */
async function recordAssistantDraft(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<boolean> {
  const d = (event.data ?? {}) as Row;
  if (event.type !== EVENTS.ai.draftPrepared || String(d.subjectType ?? '') !== 'Inspection') return false;
  const kind = String(d.kind ?? '');
  if (kind !== 'INSPECTION_SUMMARY' && kind !== 'DEFICIENCY_NOTICE') return false;
  const draft: Row = d.draft ?? {};
  const r = await c.query<InspectionRow>('SELECT * FROM inspections WHERE id::text = $1 OR number = $1 FOR UPDATE', [String(d.subjectId ?? '')]);
  const i = r.rows[0];
  if (!i) return true;
  const draftedAt = new Date(draft.createdAt ?? event.time);
  const by = { id: null, name: String(d.preparedBy ?? 'Assistant') };
  if (kind === 'INSPECTION_SUMMARY') {
    const dup = await c.query('SELECT 1 FROM inspection_reports WHERE inspection_id = $1 AND draft_id = $2', [i.id, String(d.draftId)]);
    if (dup.rowCount) return true;
    await draftReport(c, deps.env, i, { source: 'AI', draftId: String(d.draftId), title: String(d.title ?? draft.title ?? ''), summary: String(draft.facts?.summary ?? ''), body: String(draft.body ?? ''), by, at: draftedAt }, { cause: event });
  } else {
    const dup = await c.query('SELECT 1 FROM inspection_notices WHERE inspection_id = $1 AND draft_id = $2', [i.id, String(d.draftId)]);
    if (dup.rowCount) return true;
    const findings = await c.query<{ id: string }>(`SELECT id FROM findings WHERE inspection_id = $1 AND status = 'OPEN'`, [i.id]);
    await draftNotice(c, deps.env, i, { kind: i.detention ? 'DETENTION' : 'DEFICIENCY', source: 'AI', draftId: String(d.draftId), subject: String(d.title ?? draft.title ?? ''), body: String(draft.body ?? ''), findingIds: findings.rows.map((f) => f.id), by, at: draftedAt }, { cause: event });
  }
  return true;
}

export async function applyEvent(c: PoolClient, deps: Deps, event: EventEnvelope): Promise<void> {
  if (await applyLookupEvent(c, event)) return; // deficiency codes, action codes and regimes
  if (await rememberAgentJudgement(c, event)) return;
  if (await recordAssistantDraft(c, deps, event)) return;
  // our own recommendation coming back off the bus is the proof it reached the officers who subscribe to it
  if (event.type === EVENTS.inspection.restrictionRecommended) { const d = (event.data ?? {}) as Row; if (d.recommendationId) await routeRecommendation(c, String(d.recommendationId), new Date(), event.id); return; }
  if (event.type === EVENTS.scheduler.sweepFindings) {
    const swept = await sweepOverdueFindings(c, deps.env, new Date(), event);
    if (swept.inspections) await deps.audit.record(c, { action: 'FINDINGS_OVERDUE_SWEEP', entity: 'Inspection', entityId: 'sweep', entityLabel: 'Overdue findings sweep', after: swept, actor: { id: 'scheduler', name: 'Scheduler', kind: 'system' } });
    return;
  }
  const relevant = await projectSnapshot(c, event);
  if (!relevant) return;
  const d = (event.data ?? {}) as Row;
  const vessel: Row = d.entity ?? (d.vesselId ? { id: d.vesselId, name: d.name, imo: d.imo } : {});
  if (d.kind !== 'vessel' && event.type !== EVENTS.mdm.vesselUpserted) return;
  if (!vessel.id) return;
  const changed = await refreshOpenInspections(c, vessel);
  if (!changed.length) return;
  await deps.audit.record(c, {
    action: 'VESSEL_REFRESHED', entity: 'Inspection', entityId: changed[0], entityLabel: String(vessel.name ?? ''),
    after: { vesselId: vessel.id, name: vessel.name, imo: vessel.imo, inspections: changed.length },
    note: 'Open surveys corrected from the ship register', actor: { id: 'ships', name: 'Ships', kind: 'system' },
  });
  for (const id of changed) {
    const r = await c.query<InspectionRow>('SELECT * FROM inspections WHERE id = $1', [id]);
    const row = r.rows[0];
    if (row) await publishInspection(c, deps.env, row, { findings: await findingsOf(c, row.id) }, { cause: event });
  }
}

/** The read-model snapshot for a survey, rebuilt without a request — used by the seed and by replays. */
export async function snapshotOf(c: PoolClient, id: string) {
  const r = await c.query<InspectionRow>('SELECT * FROM inspections WHERE id = $1', [id]);
  return r.rows[0] ? inspectionApi(r.rows[0], { findings: await findingsOf(c, id) }) : null;
}

export const SUBJECTS = [
  subjectFor(EVENTS.readModel.upserted), subjectFor(EVENTS.readModel.deleted), subjectFor(EVENTS.mdm.vesselUpserted), ...LOOKUP_SUBJECTS,
  subjectFor(EVENTS.ai.decisionRecorded), subjectFor(EVENTS.ai.draftPrepared), subjectFor(EVENTS.inspection.restrictionRecommended), subjectFor(EVENTS.scheduler.sweepFindings),
];

@Injectable()
export class InspectionConsumer implements OnModuleInit, OnModuleDestroy {
  private sub?: Subscription;
  constructor(@Inject(KIT_BUS) private readonly bus: EventBus, @Inject(KIT_POOL) private readonly pool: Pool, @Inject(KIT_ENV) private readonly env: Env, private readonly audit: AuditClient) {}
  async onModuleInit() { this.sub = await this.bus.subscribe('inspection-consumer', SUBJECTS, (e) => this.handle(e)); }
  async onModuleDestroy() { await this.sub?.stop(); }
  async handle(event: EventEnvelope) { await withInbox(this.pool, event, (c) => applyEvent(c, { env: this.env, audit: this.audit }, event)); }
}
