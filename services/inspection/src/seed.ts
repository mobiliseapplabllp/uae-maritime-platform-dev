import { join } from 'node:path';
import { buildWorld, stableId, type WorldChecklistTemplate, type WorldInspection } from '@maritime/world';
import { createDb, runMigrations, withTx, type Queryable } from '@maritime/service-kit';
import { env } from './env';
import { upsertLookup, upsertPortCall, upsertVessel } from './subjects';
import { DETAINABLE_ACTION, scoreChecklist, type ChecklistAnswer, type Row } from './inspections';

/* Seeds the survey desk from the shared world: the versioned checklist templates the builder edits, every survey
 * since 2023 with the sheet its inspector answered, the deficiencies raised on them, and a detention record for
 * each ship that was held. The snapshots other domains own — the fleet, the calls surveys are attached to and the
 * deficiency and action code masters — are seeded here too, so the register is usable before any event arrives.
 * Idempotent: every write is an upsert on the world's stable id, and the numbering series are advanced past the
 * seeded numbers so the next survey planned can never collide with one of them. */

async function advance(c: Queryable, series: string, value: number) {
  await c.query('INSERT INTO numbering_series(series, last_value) VALUES ($1,$2) ON CONFLICT (series) DO UPDATE SET last_value = GREATEST(numbering_series.last_value, EXCLUDED.last_value)', [series, value]);
}
/** `INS-2026-014` → the series `INS-2026` at 14. */
function noteSeries(series: Map<string, number>, value: string) {
  const at = value.lastIndexOf('-');
  if (at < 0) return;
  const key = value.slice(0, at); const n = Number(value.slice(at + 1));
  if (Number.isFinite(n)) series.set(key, Math.max(series.get(key) ?? 0, n));
}
/** The answered sheet carries the weights it was scored against, taken from the template version it was copied from. */
function answersOf(tpl: WorldChecklistTemplate | undefined, answers: { seq: number; text: string; category: string; answer: string; note: string }[]): ChecklistAnswer[] {
  const meta = new Map((tpl?.items ?? []).map((i) => [i.text, i]));
  return answers.map((a) => {
    const m = meta.get(a.text);
    return { seq: a.seq, text: a.text, category: a.category, answer: a.answer ?? '', note: a.note ?? '', weight: m?.weight ?? 1, critical: !!m?.critical, answerType: m?.answerType ?? 'YES_NO_NA' };
  });
}
const severityOf = (actionCode: string, i: number) => (actionCode === DETAINABLE_ACTION ? 'DETAINABLE' : i === 0 ? 'MAJOR' : 'MINOR');

export async function seedInspection(databaseUrl: string, profile = 'AE') {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });
  const tplById = new Map(world.checklistTemplates.map((t) => [t.id, t]));
  const callById = new Map(world.portCalls.map((c) => [c.id, c]));
  const userByName = new Map(world.users.map((u) => [u.name, u]));

  const counts = await withTx(pool, async (c) => {
    for (const v of world.vessels) await upsertVessel(c, { id: v.id, imo: v.imo, name: v.name, type: v.type, flag: v.flag, grt: v.grt, built: v.built, agentCode: v.agentCode, status: v.status, real: v.real });
    for (const call of world.portCalls) await upsertPortCall(c, { id: call.id, vcn: call.vcn, vesselId: call.vesselId, status: call.status, berthCode: call.berthCode, eta: call.eta, atb: call.atb, atd: call.atd });
    for (const l of world.lookups) if (l.category === 'deficiencyCode' || l.category === 'actionCode') await upsertLookup(c, { id: `${l.category}:${l.code}`, ...l } as Row);

    for (const t of world.checklistTemplates) {
      await c.query(`INSERT INTO checklist_templates(id, name, inspection_type, description, items, active, version, pass_score_pct) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, inspection_type = EXCLUDED.inspection_type, description = EXCLUDED.description, items = EXCLUDED.items,
          active = EXCLUDED.active, version = EXCLUDED.version, pass_score_pct = EXCLUDED.pass_score_pct, updated_at = now()`,
        [t.id, t.name, t.inspectionType, t.description, JSON.stringify(t.items), t.active, t.version, t.passScorePct]);
    }

    const series = new Map<string, number>();
    let findings = 0; let detentions = 0;
    for (const i of world.inspections as WorldInspection[]) {
      const tpl = i.templateId ? tplById.get(i.templateId) : undefined;
      const call = i.portCallId ? callById.get(i.portCallId) : undefined;
      const vessel = world.vessels.find((v) => v.id === i.vesselId);
      const checklist = answersOf(tpl, i.checklist);
      const passMark = tpl?.passScorePct ?? 80;
      const score = scoreChecklist(checklist, passMark);
      await c.query(`INSERT INTO inspections(id, number, vessel_id, vessel_name, vessel_imo, vessel_flag, vessel_type, port_call_id, vcn, type, template_id, template_version,
          inspector_id, inspector, planned_at, started_at, closed_at, status, result, score_pct, pass_score_pct, critical_fail, detention, checklist, remarks, created_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)
        ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, vessel_id = EXCLUDED.vessel_id, vessel_name = EXCLUDED.vessel_name, vessel_imo = EXCLUDED.vessel_imo,
          vessel_flag = EXCLUDED.vessel_flag, vessel_type = EXCLUDED.vessel_type, port_call_id = EXCLUDED.port_call_id, vcn = EXCLUDED.vcn, type = EXCLUDED.type,
          template_id = EXCLUDED.template_id, template_version = EXCLUDED.template_version, inspector_id = EXCLUDED.inspector_id, inspector = EXCLUDED.inspector,
          planned_at = EXCLUDED.planned_at, started_at = EXCLUDED.started_at, closed_at = EXCLUDED.closed_at, status = EXCLUDED.status, result = EXCLUDED.result,
          score_pct = EXCLUDED.score_pct, pass_score_pct = EXCLUDED.pass_score_pct, critical_fail = EXCLUDED.critical_fail, detention = EXCLUDED.detention,
          checklist = EXCLUDED.checklist, remarks = EXCLUDED.remarks, created_at = EXCLUDED.created_at, updated_at = now()`,
        [i.id, i.number, i.vesselId, i.vesselName, vessel?.imo ?? '', vessel?.flag ?? '', vessel?.type ?? '', call?.id ?? null, i.vcn ?? '', i.type,
          i.templateId, tpl?.version ?? null, i.inspectorId, i.inspector, i.plannedAt, i.startedAt, i.closedAt, i.status, i.result ?? '',
          i.status === 'CLOSED' ? i.scorePct ?? score.pct : null, passMark, score.criticalFail, i.detention, JSON.stringify(checklist), i.remarks ?? '', i.plannedAt]);
      noteSeries(series, i.number);

      for (const [ix, f] of i.findings.entries()) {
        const id = stableId('finding', `${i.number}:${ix + 1}`);
        await c.query(`INSERT INTO findings(id, inspection_id, seq, deficiency_code, deficiency_label, category, severity, description, action_code, due_date, status, closed_at, created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (id) DO UPDATE SET inspection_id = EXCLUDED.inspection_id, seq = EXCLUDED.seq, deficiency_code = EXCLUDED.deficiency_code, deficiency_label = EXCLUDED.deficiency_label,
            category = EXCLUDED.category, severity = EXCLUDED.severity, description = EXCLUDED.description, action_code = EXCLUDED.action_code, due_date = EXCLUDED.due_date,
            status = EXCLUDED.status, closed_at = EXCLUDED.closed_at, created_at = EXCLUDED.created_at, updated_at = now()`,
          [id, i.id, ix + 1, f.deficiencyCode, f.deficiencyLabel, world.lookups.find((l) => l.category === 'deficiencyCode' && l.code === f.deficiencyCode)?.meta?.category ?? '',
            severityOf(f.actionCode, ix), f.description, f.actionCode, f.dueDate, f.status, f.closedAt, i.startedAt ?? i.plannedAt]);
        findings += 1;
      }

      /* A detained ship carries the order that held her. Every seeded detention is released, because the world's
       * detained surveys are historic — a standing order would leave a ship held with nobody on duty to release her. */
      if (i.detention && i.closedAt) {
        const officer = userByName.get(i.inspector);
        const releasedAt = new Date(new Date(i.closedAt).getTime() + 36 * 3_600_000).toISOString();
        await c.query(`INSERT INTO detentions(id, inspection_id, vessel_id, vessel_name, ordered_at, ordered_by_id, ordered_by, grounds, detainable_codes, released_at, released_by_id, released_by, release_note, status)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (id) DO UPDATE SET inspection_id = EXCLUDED.inspection_id, vessel_id = EXCLUDED.vessel_id, vessel_name = EXCLUDED.vessel_name, ordered_at = EXCLUDED.ordered_at,
            ordered_by_id = EXCLUDED.ordered_by_id, ordered_by = EXCLUDED.ordered_by, grounds = EXCLUDED.grounds, detainable_codes = EXCLUDED.detainable_codes,
            released_at = EXCLUDED.released_at, released_by_id = EXCLUDED.released_by_id, released_by = EXCLUDED.released_by, release_note = EXCLUDED.release_note, status = EXCLUDED.status, updated_at = now()`,
          [stableId('detention', i.number), i.id, i.vesselId, i.vesselName, i.closedAt, officer?.id ?? i.inspectorId, i.inspector,
            `Detainable deficiencies found on ${i.type} inspection ${i.number}`,
            JSON.stringify(i.findings.filter((f) => f.actionCode === DETAINABLE_ACTION).map((f) => f.deficiencyCode)),
            releasedAt, officer?.id ?? i.inspectorId, i.inspector, 'Detainable deficiencies rectified and verified before release', 'RELEASED']);
        detentions += 1;
      }
    }
    for (const [key, n] of series) await advance(c, key, n);

    return {
      profile: world.profile, templates: world.checklistTemplates.length, inspections: world.inspections.length, findings, detentions,
      vessels: world.vessels.length, portCalls: world.portCalls.length,
      lookups: world.lookups.filter((l) => l.category === 'deficiencyCode' || l.category === 'actionCode').length, series: series.size,
    };
  });
  await pool.end();
  return counts;
}

if (require.main === module) {
  const e = env();
  seedInspection(e.DATABASE_URL, e.JURISDICTION).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
