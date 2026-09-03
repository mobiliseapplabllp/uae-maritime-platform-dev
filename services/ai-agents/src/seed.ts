import { join } from 'node:path';
import { buildWorld, stableId, type WorldAgentConfig, type WorldAiDecision, type WorldVessel } from '@maritime/world';
import { createDb, runMigrations, withTx, type Queryable } from '@maritime/service-kit';
import { env } from './env';
import { SEED_DEF_BY_ID, type Row } from './registry';
import { effectOf, requestCohort, vesselCohort } from './runtime';
import {
  upsertCertificate, upsertIncident, upsertInspection, upsertInstrument, upsertInvoice, upsertLegalInstrument,
  upsertPortCall, upsertServiceDefinition, upsertServiceRequest, upsertVessel,
} from './subjects';

/* Seeds the agent layer from the shared world.
 *
 * The register starts with the seven mandated agents and the analytics workforce at the latitude the governance
 * committee last set, each carrying the record of how it got there. The decision register starts with the
 * decisions those agents have already recorded over the world's own ships, applications and instruments — which
 * is what gives the console, the escalation queue and the drift and bias reports something true to read on a
 * first run. Every write is an upsert on the world's stable id, so re-seeding is safe. */

/** The review state a seeded outcome corresponds to; the disposition itself is left exactly as recorded. */
function reviewStatusOf(d: WorldAiDecision): string {
  switch (d.disposition) {
    case 'AUTO_APPLIED': return 'AUTO';
    case 'APPROVED_BY_HUMAN': return 'REVIEWED';
    case 'OVERRIDDEN': case 'REJECTED_BY_HUMAN': return 'OVERRIDDEN';
    default: return 'PENDING';
  }
}
/** Why a seeded decision was not applied, expressed in the codes the runtime uses. */
function escalationCodeOf(d: WorldAiDecision): string {
  if (d.disposition === 'ESCALATED') return /below threshold/i.test(d.escalationReason) ? 'BELOW_THRESHOLD' : 'OUTSIDE_AUTONOMY';
  if (d.disposition === 'AWAITING_REVIEW') return 'OUTSIDE_AUTONOMY';
  return '';
}

export async function seedAiAgents(databaseUrl: string, profile = 'AE') {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });
  const now = new Date(world.now);
  const vesselById = new Map(world.vessels.map((v) => [v.id, v]));
  const requestById = new Map(world.serviceRequests.map((r) => [r.id, r]));
  const defaultRole = (a: WorldAgentConfig) => a.role || 'Agent';

  const counts = await withTx(pool, async (c) => {
    /* the facts the agents reason over — projected here at seed time exactly as the read-model events would */
    for (const v of world.vessels) await upsertVessel(c, v as unknown as Row);
    for (const cert of world.vesselCertificates) await upsertCertificate(c, cert as unknown as Row);
    for (const i of world.inspections) await upsertInspection(c, i as unknown as Row);
    for (const l of world.licences) await upsertInstrument(c, { ...(l as unknown as Row), number: l.licenseNo });
    for (const i of world.incidents) await upsertIncident(c, i as unknown as Row);
    for (const inv of world.invoices) await upsertInvoice(c, inv as unknown as Row);
    for (const call of world.portCalls) await upsertPortCall(c, call as unknown as Row);
    for (const d of world.serviceDefinitions) await upsertServiceDefinition(c, d as unknown as Row);
    for (const r of world.serviceRequests) await upsertServiceRequest(c, r as unknown as Row);
    for (const li of world.legalInstruments) await upsertLegalInstrument(c, li as unknown as Row);

    let changes = 0;
    for (const a of world.agentConfigs) {
      const def = SEED_DEF_BY_ID.get(a.agentId);
      await c.query(`INSERT INTO agents(id, agent_id, name, name_ar, description, description_ar, role, domain, mandated, trigger_kind, trigger_subjects,
          cadence, cron, timezone, autonomy_level, confidence_threshold, requires_confirmation, max_actions_per_hour, escalate_to, enabled, suspended,
          suspended_reason, suspended_by, suspended_at, last_run_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)
        ON CONFLICT (agent_id) DO UPDATE SET name = EXCLUDED.name, name_ar = EXCLUDED.name_ar, description = EXCLUDED.description,
          description_ar = EXCLUDED.description_ar, role = EXCLUDED.role, domain = EXCLUDED.domain, mandated = EXCLUDED.mandated,
          trigger_kind = EXCLUDED.trigger_kind, trigger_subjects = EXCLUDED.trigger_subjects, cadence = EXCLUDED.cadence, cron = EXCLUDED.cron,
          timezone = EXCLUDED.timezone, autonomy_level = EXCLUDED.autonomy_level, confidence_threshold = EXCLUDED.confidence_threshold,
          requires_confirmation = EXCLUDED.requires_confirmation, max_actions_per_hour = EXCLUDED.max_actions_per_hour, escalate_to = EXCLUDED.escalate_to,
          enabled = EXCLUDED.enabled, suspended = EXCLUDED.suspended, suspended_reason = EXCLUDED.suspended_reason, suspended_by = EXCLUDED.suspended_by,
          suspended_at = EXCLUDED.suspended_at, updated_at = now()`,
        [a.id, a.agentId, a.name, a.nameAr ?? '', def?.description ?? '', def?.descriptionAr ?? '', defaultRole(a), a.domain, def?.mandated ?? false,
          def?.triggerKind ?? (a.schedule.cadence === 'EVENT' ? 'EVENT' : 'SCHEDULE'), def?.triggerSubjects ?? [],
          a.schedule.cadence, a.schedule.cron, a.schedule.timezone, a.autonomyLevel, a.confidenceThreshold,
          def?.requiresConfirmation ?? true, a.maxActionsPerHour, a.escalateTo, a.enabled, a.suspended,
          a.suspendedReason, a.suspendedBy, a.suspendedAt, a.stats.lastRunAt]);
      await c.query('DELETE FROM agent_changes WHERE agent_id = $1', [a.agentId]);
      for (const ch of a.changes) {
        await c.query('INSERT INTO agent_changes(agent_id, field, from_value, to_value, at, by_id, by, reason) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [a.agentId, ch.field, ch.from, ch.to, ch.at, '', ch.by, ch.reason]);
        changes += 1;
      }
    }

    /* The escalation queue as a working desk rather than a backlog nobody has touched: part of it has been
     * closed by a reviewer, which is what gives agreement, drift and the high-risk false-positive rate anything
     * to measure on a first run. Which ones is a fixed function of position, so a re-seed reproduces it exactly. */
    const reviewers = world.users.filter((u) => ['Super Admin', 'Harbour Master', 'Registrar of Ships'].includes(u.roleName) && u.login);
    const closed: { decision: WorldAiDecision; accept: boolean; reviewer: { id: string; name: string } }[] = [];
    let escalatedSeen = 0;

    let applied = 0; let pending = 0;
    for (const d of world.aiDecisions as WorldAiDecision[]) {
      const judgement = { action: d.action, subjectType: d.subjectType, subjectId: d.subjectId, subjectLabel: d.subjectLabel, inputs: d.inputs, output: d.output, explanation: d.explanation, factors: d.factors, confidence: d.confidence };
      const effect = effectOf(d.agentId, judgement);
      const reviewStatus = reviewStatusOf(d);
      const wasApplied = d.disposition === 'AUTO_APPLIED' || d.disposition === 'APPROVED_BY_HUMAN';
      if (wasApplied) applied += 1; else if (reviewStatus === 'PENDING') pending += 1;
      if (reviewStatus === 'PENDING' && reviewers.length) {
        const n = escalatedSeen; escalatedSeen += 1;
        // a third of the queue has been worked, and about one in four of those was overturned
        if (n % 3 === 0) closed.push({ decision: d, accept: n % 12 !== 0, reviewer: { id: reviewers[n % reviewers.length].id, name: reviewers[n % reviewers.length].name } });
      }
      const cohort = cohortFor(d, vesselById, requestById, now);
      await c.query(`INSERT INTO decisions(id, agent_id, agent_name, action, effect, entity_type, entity_id, entity_label, inputs, output, explanation, factors,
          confidence, autonomy_level, threshold, disposition, review_status, escalation_code, escalation_reason, applied, reviewed_by_id, reviewed_by, reviewed_at,
          override_reason, model_key, model_version, latency_ms, cohort, at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29)
        ON CONFLICT (id) DO UPDATE SET agent_id = EXCLUDED.agent_id, agent_name = EXCLUDED.agent_name, action = EXCLUDED.action, effect = EXCLUDED.effect,
          entity_type = EXCLUDED.entity_type, entity_id = EXCLUDED.entity_id, entity_label = EXCLUDED.entity_label, inputs = EXCLUDED.inputs, output = EXCLUDED.output,
          explanation = EXCLUDED.explanation, factors = EXCLUDED.factors, confidence = EXCLUDED.confidence, autonomy_level = EXCLUDED.autonomy_level,
          threshold = EXCLUDED.threshold, disposition = EXCLUDED.disposition, review_status = EXCLUDED.review_status, escalation_code = EXCLUDED.escalation_code,
          escalation_reason = EXCLUDED.escalation_reason, applied = EXCLUDED.applied, reviewed_by_id = EXCLUDED.reviewed_by_id, reviewed_by = EXCLUDED.reviewed_by,
          reviewed_at = EXCLUDED.reviewed_at, override_reason = EXCLUDED.override_reason, model_key = EXCLUDED.model_key, model_version = EXCLUDED.model_version,
          latency_ms = EXCLUDED.latency_ms, cohort = EXCLUDED.cohort, at = EXCLUDED.at`,
        [d.id, d.agentId, d.agentName, d.action, effect, d.subjectType, d.subjectId, d.subjectLabel,
          JSON.stringify(d.inputs ?? {}), JSON.stringify(d.output ?? {}), d.explanation, JSON.stringify(d.factors ?? []),
          d.confidence, d.autonomyLevel, d.threshold, d.disposition, reviewStatus, escalationCodeOf(d), d.escalationReason, wasApplied,
          d.reviewedById, d.reviewedBy, d.reviewedAt, d.overrideReason, d.modelId, d.modelVersion, d.latencyMs, JSON.stringify(cohort), d.at]);
    }

    let reviewed = 0; let overturned = 0;
    for (const { decision, accept, reviewer } of closed) {
      const at = new Date(Math.min(now.getTime(), new Date(decision.at).getTime() + 6 * 3_600_000)).toISOString();
      const outcome = accept ? 'APPROVED_BY_HUMAN' : 'OVERRIDDEN';
      const status = accept ? 'REVIEWED' : 'OVERRIDDEN';
      // the verdict is a row of its own pointing back at the conclusion it reviewed; the original is never rewritten
      await c.query(`INSERT INTO decisions(id, agent_id, agent_name, action, effect, entity_type, entity_id, entity_label, inputs, output, explanation, factors,
          confidence, autonomy_level, threshold, disposition, review_status, applied, reviewed_by_id, reviewed_by, reviewed_at, override_reason,
          supersedes_id, model_key, model_version, cohort, at)
        SELECT $1, agent_id, agent_name, action, effect, entity_type, entity_id, entity_label, inputs, output, explanation, factors,
          confidence, autonomy_level, threshold, $3, $4, $5, $6, $7, $8, $9, id, model_key, model_version, cohort, $8
        FROM decisions WHERE id = $2
        ON CONFLICT (id) DO NOTHING`,
        [stableId('verdict', decision.id), decision.id, outcome, status, accept, reviewer.id, reviewer.name, at,
          accept ? '' : 'Reviewed against the file: the conclusion did not hold on the evidence the officer had']);
      await c.query('UPDATE decisions SET superseded = true, review_status = $2, reviewed_by_id = $3, reviewed_by = $4, reviewed_at = $5 WHERE id = $1',
        [decision.id, status, reviewer.id, reviewer.name, at]);
      reviewed += 1; if (!accept) overturned += 1;
      if (accept) applied += 1; pending -= 1;
    }

    return {
      profile: world.profile, agents: world.agentConfigs.length, mandated: world.agentConfigs.filter((a) => SEED_DEF_BY_ID.get(a.agentId)?.mandated).length,
      agentChanges: changes, decisions: world.aiDecisions.length, applied, pendingReview: pending, reviewed, overturned,
      vessels: world.vessels.length, certificates: world.vesselCertificates.length, inspections: world.inspections.length,
      instruments: world.licences.length, incidents: world.incidents.length, invoices: world.invoices.length, portCalls: world.portCalls.length,
      serviceRequests: world.serviceRequests.length, serviceDefinitions: world.serviceDefinitions.length, legalInstruments: world.legalInstruments.length,
    };
  });
  await pool.end();
  return counts;
}

/** The dimensions a seeded decision's subject actually carries, so the bias audit has cohorts on a first run. */
function cohortFor(d: WorldAiDecision, vessels: Map<string, WorldVessel>, requests: Map<string, Row>, now: Date): Row {
  if (d.subjectType === 'Vessel') { const v = vessels.get(d.subjectId); return v ? vesselCohort(v, now) : {}; }
  if (d.subjectType === 'ServiceRequest') { const r = requests.get(d.subjectId); return r ? requestCohort(r as never) : {}; }
  if (d.subjectType === 'Instrument') return { instrumentType: String((d.inputs ?? {}).type ?? 'UNKNOWN') };
  if (d.subjectType === 'Situation') return { scope: 'NATIONAL' };
  return {};
}

export type SeedCounts = Awaited<ReturnType<typeof seedAiAgents>>;
export type { Queryable };

if (require.main === module) {
  const e = env();
  seedAiAgents(e.DATABASE_URL, e.JURISDICTION).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
