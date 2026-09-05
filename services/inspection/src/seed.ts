import { join } from 'node:path';
import { geoFor, buildWorld, stableId, type WorldChecklistTemplate, type WorldInspection } from '@maritime/world';
import { createDb, runMigrations, seedLookupMirror, withTx, type Queryable } from '@maritime/service-kit';
import { env } from './env';
import { upsertPortCall, upsertVessel } from './subjects';
import { DETAINABLE_ACTION, scoreChecklist, type ChecklistAnswer, type Row } from './inspections';
import { mark, upsertSubject } from './smart';

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
  const e = env();
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile });
  const tplById = new Map(world.checklistTemplates.map((t) => [t.id, t]));
  const callById = new Map(world.portCalls.map((c) => [c.id, c]));
  const userByName = new Map(world.users.map((u) => [u.name, u]));

  const counts = await withTx(pool, async (c) => {
    for (const v of world.vessels) await upsertVessel(c, { id: v.id, imo: v.imo, name: v.name, type: v.type, flag: v.flag, grt: v.grt, built: v.built, agentCode: v.agentCode, status: v.status, real: v.real });
    /* The call's port is what a survey inherits its tenancy from, so the seed stamps it exactly as the
     * read-model event would. A call with no berth is not yet any port's, and stays shared. */
    const homePort = geoFor(world.profile).portCode;
    for (const call of world.portCalls) await upsertPortCall(c, { id: call.id, vcn: call.vcn, vesselId: call.vesselId, status: call.status, berthCode: call.berthCode, eta: call.eta, atb: call.atb, atd: call.atd, scopePort: call.berthCode ? homePort : '' });
    const lookups = await seedLookupMirror(c, world.lookups);
    /* The subjects other regimes apply to, as their registers publish them: the companies, the port facilities (the berths) and the training institutions. */
    for (const co of world.companies) await upsertSubject(c, 'COMPANY', { id: co.id, code: co.code, name: co.name, status: co.status, detail: { nameAr: co.nameAr, category: co.category, types: co.types } });
    for (const b of world.berths) await upsertSubject(c, 'PORT_FACILITY', { id: b.id, code: b.code, name: b.name, status: b.status, detail: { nameAr: b.nameAr, terminal: b.terminal, berthType: b.berthType } });
    for (const m of world.metInstitutions) await upsertSubject(c, 'MET_INSTITUTION', { id: m.id, code: m.code, name: m.name, status: m.status, detail: { nameAr: m.nameAr, institutionType: m.institutionType, city: m.city, accreditation: m.accreditationStatus } });

    for (const t of world.checklistTemplates) {
      await c.query(`INSERT INTO checklist_templates(id, name, inspection_type, description, items, active, version, pass_score_pct) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name, inspection_type = EXCLUDED.inspection_type, description = EXCLUDED.description, items = EXCLUDED.items,
          active = EXCLUDED.active, version = EXCLUDED.version, pass_score_pct = EXCLUDED.pass_score_pct, updated_at = now()`,
        [t.id, t.name, t.inspectionType, t.description, JSON.stringify(t.items), t.active, t.version, t.passScorePct]);
    }

    const series = new Map<string, number>();
    let findings = 0; let detentions = 0; let smartRows = 0;
    const priorBySubject = new Map<string, number>();
    for (const i of world.inspections as WorldInspection[]) {
      const tpl = i.templateId ? tplById.get(i.templateId) : undefined;
      const call = i.portCallId ? callById.get(i.portCallId) : undefined;
      const vessel = i.vesselId ? world.vessels.find((v) => v.id === i.vesselId) : undefined;
      const checklist = answersOf(tpl, i.checklist);
      const passMark = tpl?.passScorePct ?? 80;
      const score = scoreChecklist(checklist, passMark);
      const sm = i.smart;
      const closed = i.status === 'CLOSED';
      /* What the close-out classified the survey as, by the same rule the service applies when it closes one. */
      const severity = !closed ? '' : i.detention ? 'CRITICAL' : i.findings.length >= 4 ? 'MAJOR' : i.findings.length ? 'MINOR' : 'NONE';
      const recommendation = !closed ? '' : i.detention ? 'DETAIN' : i.findings.length >= 4 ? 'RESTRICT' : i.findings.length ? 'RECTIFY' : 'NONE';
      const subjectKey = `${i.subjectKind}:${i.subjectId}`; const prior = priorBySubject.get(subjectKey) ?? 0;
      const dossier = sm.dossierPreparedAt ? { seeded: true, source: sm.dossierSource, preparedAt: sm.dossierPreparedAt, subject: { kind: i.subjectKind, id: i.subjectId, name: i.subjectName, imo: vessel?.imo, flag: vessel?.flag, type: vessel?.type }, portCall: call ? { id: call.id, vcn: call.vcn, berthCode: call.berthCode } : null, history: { inspections: prior, openFindings: [], recurringCodes: [] }, prediction: sm.prediction ? { source: sm.prediction.source, band: sm.prediction.band, riskScore: sm.prediction.riskScore, predictedCodes: sm.prediction.predictedCodes } : null, checklist: { templateId: i.templateId, questions: checklist.length, critical: checklist.filter((x) => x.critical).length } } : null;
      /* A survey the desk raised in an earlier run may hold this number under another id; the world's survey replaces it, so a re-seed lands the same world. */
      await c.query('DELETE FROM detentions WHERE inspection_id IN (SELECT id FROM inspections WHERE number = $1 AND id <> $2)', [i.number, i.id]);
      await c.query('DELETE FROM inspections WHERE number = $1 AND id <> $2', [i.number, i.id]);
      await c.query(`INSERT INTO inspections(id, number, vessel_id, vessel_name, vessel_imo, vessel_flag, vessel_type, port_call_id, vcn, type, template_id, template_version,
          inspector_id, inspector, planned_at, started_at, closed_at, status, result, score_pct, pass_score_pct, critical_fail, detention, checklist, remarks, created_at,
          subject_kind, subject_id, subject_name, dossier, dossier_prepared_at, dossier_source, severity, recommendation)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32,$33,$34)
        ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, vessel_id = EXCLUDED.vessel_id, vessel_name = EXCLUDED.vessel_name, vessel_imo = EXCLUDED.vessel_imo,
          vessel_flag = EXCLUDED.vessel_flag, vessel_type = EXCLUDED.vessel_type, port_call_id = EXCLUDED.port_call_id, vcn = EXCLUDED.vcn, type = EXCLUDED.type,
          template_id = EXCLUDED.template_id, template_version = EXCLUDED.template_version, inspector_id = EXCLUDED.inspector_id, inspector = EXCLUDED.inspector,
          planned_at = EXCLUDED.planned_at, started_at = EXCLUDED.started_at, closed_at = EXCLUDED.closed_at, status = EXCLUDED.status, result = EXCLUDED.result,
          score_pct = EXCLUDED.score_pct, pass_score_pct = EXCLUDED.pass_score_pct, critical_fail = EXCLUDED.critical_fail, detention = EXCLUDED.detention,
          checklist = EXCLUDED.checklist, remarks = EXCLUDED.remarks, created_at = EXCLUDED.created_at, subject_kind = EXCLUDED.subject_kind, subject_id = EXCLUDED.subject_id,
          subject_name = EXCLUDED.subject_name, dossier = EXCLUDED.dossier, dossier_prepared_at = EXCLUDED.dossier_prepared_at, dossier_source = EXCLUDED.dossier_source,
          severity = EXCLUDED.severity, recommendation = EXCLUDED.recommendation, updated_at = now()`,
        [i.id, i.number, i.vesselId, i.vesselName, vessel?.imo ?? '', vessel?.flag ?? '', vessel?.type ?? '', call?.id ?? null, i.vcn ?? '', i.type,
          i.templateId, tpl?.version ?? null, i.inspectorId, i.inspector, i.plannedAt, i.startedAt, i.closedAt, i.status, i.result ?? '',
          closed ? i.scorePct ?? score.pct : null, passMark, score.criticalFail, i.detention, JSON.stringify(checklist), i.remarks ?? '', i.plannedAt,
          i.subjectKind, i.subjectId, i.subjectName, dossier ? JSON.stringify(dossier) : null, sm.dossierPreparedAt, sm.dossierSource, severity, recommendation]);
      noteSeries(series, i.number);
      priorBySubject.set(subjectKey, prior + (closed ? 1 : 0));

      /* The survey's timeline and the Smart Inspection records, dated as the world says they happened. Every row carries a
       * seed event id, so a re-seed adds nothing twice. */
      const ref = { id: i.id, number: i.number };
      const ev = (k: string) => `seed:${i.number}:${k}`;
      await mark(c, ref, 'PLANNED', i.plannedAt, 'DESK', { regime: i.type, subjectKind: i.subjectKind }, ev('planned'));
      if (i.startedAt) await mark(c, ref, 'STARTED', i.startedAt, 'DESK', {}, ev('started'));
      if (closed && i.closedAt) await mark(c, ref, 'CLOSED', i.closedAt, 'DESK', { findings: i.findings.length, open: i.findings.filter((f) => f.status === 'OPEN').length, result: i.result, severity, recommendation }, ev('closed'));
      if (sm.dossierPreparedAt) await mark(c, ref, 'DOSSIER_PREPARED', sm.dossierPreparedAt, sm.dossierSource, { prior }, ev('dossier'));
      if (sm.prediction) {
        const p = sm.prediction;
        await c.query(`INSERT INTO inspection_predictions(id, inspection_id, source, predicted_at, risk_score, band, predicted_codes, basis, scored_at, outcome, correlated) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
          ON CONFLICT (inspection_id) DO UPDATE SET source = EXCLUDED.source, predicted_at = EXCLUDED.predicted_at, risk_score = EXCLUDED.risk_score, band = EXCLUDED.band, predicted_codes = EXCLUDED.predicted_codes, basis = EXCLUDED.basis, scored_at = EXCLUDED.scored_at, outcome = EXCLUDED.outcome, correlated = EXCLUDED.correlated, updated_at = now()`,
          [stableId('prediction', i.number), i.id, p.source, p.predictedAt, p.riskScore, p.band, JSON.stringify(p.predictedCodes), JSON.stringify({ seeded: true, rule: p.source === 'A5' ? 'agent' : 'history' }), p.scoredAt, p.scoredAt ? JSON.stringify({ findings: i.findings.length, codes: i.findings.map((f) => f.deficiencyCode), matched: p.predictedCodes.filter((code) => i.findings.some((f) => f.deficiencyCode === code)), result: i.result }) : null, p.correlated]);
        await mark(c, ref, 'PREDICTION_RECORDED', p.predictedAt, p.source, { band: p.band, riskScore: p.riskScore, codes: p.predictedCodes }, ev('predicted'));
        if (p.scoredAt) await mark(c, ref, 'PREDICTION_SCORED', p.scoredAt, p.source, { correlated: p.correlated, band: p.band, findings: i.findings.length }, ev('scored'));
        smartRows += 1;
      }
      if (sm.report) {
        const rp = sm.report; const rid = stableId('report', i.number);
        await c.query(`INSERT INTO inspection_reports(id, inspection_id, version, source, status, title, summary, body, severity, recommendation, drafted_at, drafted_by, issued_at, issued_by) VALUES ($1,$2,1,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
          ON CONFLICT (id) DO UPDATE SET source = EXCLUDED.source, status = EXCLUDED.status, title = EXCLUDED.title, body = EXCLUDED.body, severity = EXCLUDED.severity, recommendation = EXCLUDED.recommendation, drafted_at = EXCLUDED.drafted_at, drafted_by = EXCLUDED.drafted_by, issued_at = EXCLUDED.issued_at, issued_by = EXCLUDED.issued_by, updated_at = now()`,
          [rid, i.id, rp.source, rp.issuedAt ? 'ISSUED' : 'DRAFT', `Inspection report — ${i.number}`, `${i.type} inspection of ${i.subjectName}: ${i.result.toLowerCase()}, ${i.findings.length} deficiencies.`,
            [`INSPECTION REPORT — ${i.number}`, '', `Subject: ${i.subjectName}`, `Regime: ${i.type}`, `Result: ${i.result}`, `Deficiencies raised: ${i.findings.length}`, ...i.findings.map((f, n) => `${n + 1}. ${f.deficiencyCode} — ${f.description}`), '', rp.source === 'AI' ? 'First draft prepared by the assistant from the inspection record.' : 'Written by the inspecting officer.'].join('\n'),
            severity, recommendation, rp.draftedAt, rp.source === 'AI' ? 'Assistant' : i.inspector, rp.issuedAt, rp.issuedAt ? i.inspector : '']);
        await mark(c, ref, 'REPORT_DRAFTED', rp.draftedAt, rp.source, { reportId: rid, version: 1 }, ev('report'));
        if (rp.issuedAt) await mark(c, ref, 'REPORT_ISSUED', rp.issuedAt, rp.source, { reportId: rid, version: 1 }, ev('report-issued'));
        smartRows += 1;
      }
      if (sm.notice) {
        const no = sm.notice; const nid = stableId('notice', i.number); const year = no.draftedAt.slice(0, 4); const nSeries = `${e.NOTICE_PREFIX}-${year}`;
        const n = (series.get(nSeries) ?? 0) + 1; series.set(nSeries, n);
        const number = `${nSeries}-${String(n).padStart(4, '0')}`;
        await c.query(`INSERT INTO inspection_notices(id, inspection_id, number, kind, source, status, addressed_to, subject, body, finding_ids, drafted_at, drafted_by, issued_at, issued_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (id) DO UPDATE SET number = EXCLUDED.number, kind = EXCLUDED.kind, source = EXCLUDED.source, status = EXCLUDED.status, body = EXCLUDED.body, drafted_at = EXCLUDED.drafted_at, issued_at = EXCLUDED.issued_at, updated_at = now()`,
          [nid, i.id, number, i.detention ? 'DETENTION' : 'DEFICIENCY', no.source, no.issuedAt ? 'ISSUED' : 'DRAFT', i.subjectName, `${i.detention ? 'Notice of detention' : 'Deficiency notice'} — ${i.number}`,
            [`${i.detention ? 'NOTICE OF DETENTION' : 'DEFICIENCY NOTICE'} — ${i.number}`, '', `To: ${i.subjectName}`, '', 'The following deficiencies are to be rectified within the period stated:', ...i.findings.map((f, k) => `${k + 1}. ${f.deficiencyCode} — ${f.description} (by ${f.dueDate.slice(0, 10)})`)].join('\n'),
            JSON.stringify(i.findings.map((_, ix) => stableId('finding', `${i.number}:${ix + 1}`))), no.draftedAt, no.source === 'AI' ? 'Assistant' : i.inspector, no.issuedAt, no.issuedAt ? i.inspector : '']);
        await mark(c, ref, 'NOTICE_DRAFTED', no.draftedAt, no.source, { noticeId: nid, number, minutesAfterClose: i.closedAt ? Math.round((new Date(no.draftedAt).getTime() - new Date(i.closedAt).getTime()) / 60_000) : null }, ev('notice'));
        if (no.issuedAt) await mark(c, ref, 'NOTICE_ISSUED', no.issuedAt, no.source, { noticeId: nid, number }, ev('notice-issued'));
        smartRows += 1;
      }
      if (sm.recommendation) {
        const rc = sm.recommendation; const rcid = stableId('recommendation', i.number);
        await c.query(`INSERT INTO restriction_recommendations(id, inspection_id, kind, source, grounds, finding_codes, recommended_at, recommended_by, routed_at, routed_to, decided_at, decided_by, decision, decision_note, detention_id, status) VALUES ($1,$2,$3,'RULES',$4,$5,$6,'Severity rules',$7,$8,$9,$10,$11,$12,$13,$14)
          ON CONFLICT (id) DO UPDATE SET kind = EXCLUDED.kind, grounds = EXCLUDED.grounds, finding_codes = EXCLUDED.finding_codes, recommended_at = EXCLUDED.recommended_at, routed_at = EXCLUDED.routed_at, decided_at = EXCLUDED.decided_at, decided_by = EXCLUDED.decided_by, decision = EXCLUDED.decision, detention_id = EXCLUDED.detention_id, status = EXCLUDED.status, updated_at = now()`,
          [rcid, i.id, rc.kind, rc.kind === 'DETENTION' ? `Detainable deficiencies found on ${i.type} inspection ${i.number}` : `${i.findings.length} deficiencies open at close of ${i.number}`, JSON.stringify(i.findings.map((f) => f.deficiencyCode)),
            rc.recommendedAt, rc.routedAt, rc.routedAt ? 'inspections.close' : '', rc.decidedAt, rc.decidedAt ? 'Harbour Master' : '', rc.decision, rc.decidedAt ? 'Decided on the recommendation as routed' : '', i.detention ? stableId('detention', i.number) : null, rc.decision || 'PENDING']);
        await mark(c, ref, 'RESTRICTION_RECOMMENDED', rc.recommendedAt, 'RULES', { recommendationId: rcid, kind: rc.kind }, ev('recommended'));
        if (rc.routedAt) await mark(c, ref, 'RESTRICTION_ROUTED', rc.routedAt, 'BUS', { recommendationId: rcid, via: 'bus' }, ev('routed'));
        if (rc.decidedAt) await mark(c, ref, 'RESTRICTION_DECIDED', rc.decidedAt, 'DESK', { recommendationId: rcid, decision: rc.decision }, ev('decided'));
        smartRows += 1;
      }

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
      profile: world.profile, templates: world.checklistTemplates.length, inspections: world.inspections.length, findings, detentions, smartRows,
      subjects: world.companies.length + world.berths.length + world.metInstitutions.length,
      vessels: world.vessels.length, portCalls: world.portCalls.length,
      lookups, series: series.size,
    };
  });
  await pool.end();
  return counts;
}

if (require.main === module) {
  const e = env();
  seedInspection(e.DATABASE_URL, e.JURISDICTION).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
