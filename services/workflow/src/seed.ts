import { join } from 'node:path';
import { buildWorld, type World, type WorldServiceDefinition, type WorldServiceRequest } from '@maritime/world';
import { getJurisdiction, instrumentClassOf, validityMonthsOf } from '@maritime/contracts';
import { createDb, runMigrations, withTx } from '@maritime/service-kit';
import { env } from './env';
import { parseContent, validateContent, type DefinitionContent, type FieldType } from './schema';
import { defaultWorkflow, CATEGORY_AR, OWNER_MODULE_BY_DOMAIN } from './defaults';
import { normaliseDefinition } from './rules/engine';
import type { RequestDocument, TimelineEntry } from './engine';

const FIELD_TYPE: Record<string, FieldType> = { text: 'text', number: 'number', date: 'date', select: 'select', checkbox: 'boolean', textarea: 'text' };
const D = 86_400_000;
const eligibilityFor = (d: WorldServiceDefinition) => (d.category === 'Registration' ? 'eligibility.registration' : d.code === 'SEAFARER-COC' ? 'eligibility.coc' : null);
/** The world's catalogue entry as definition content: its form, checklist, fee lines (backed by the rules service's fee set), SLA and the default workflow for its kind. */
export function contentFor(d: WorldServiceDefinition, currency: string): DefinitionContent {
  const stage = Object.fromEntries(d.stages.map((s) => [s.key, s.slaDays]));
  return parseContent({
    form: { fields: d.formFields.map((f) => ({ key: f.key, label: f.label, labelAr: f.labelAr ?? null, type: FIELD_TYPE[f.type] ?? 'text', required: f.required, options: f.options, help: f.help, multiline: f.type === 'textarea', section: 'Application' })), sections: [{ key: 'Application', label: 'Application details', labelAr: 'بيانات الطلب' }] },
    documents: d.requiredDocuments.map((x) => ({ code: x.key, label: x.label, labelAr: x.labelAr ?? null, required: x.mandatory, docType: 'PDF', acceptedFormats: x.acceptedFormats })),
    fees: { ruleSetKey: d.feeLines.length ? `fee.${d.key}` : null, lines: d.feeLines.map((l) => ({ code: l.code, description: l.label, descriptionAr: l.labelAr ?? null, amount: l.amount, taxable: true })), currency },
    sla: { days: d.slaDays, ruleSetKey: null },
    workflow: defaultWorkflow({ issuesInstrument: d.issuesInstrument || null, eligibilityRuleSetKey: eligibilityFor(d), stageDays: { screening: stage.SCREENING, technical: stage.TECHNICAL, approval: stage.APPROVAL } }),
    outputs: { instrumentType: d.issuesInstrument || null, instrumentClass: d.issuesInstrument ? instrumentClassOf(d.issuesInstrument) : null, validityMonths: d.issuesInstrument ? validityMonthsOf(d.issuesInstrument) : null,
      notifications: [{ on: 'submit', audience: 'staff', template: 'request.submitted' }, { on: 'approve', audience: 'applicant', template: 'request.approved' }, ...(d.issuesInstrument ? [{ on: 'issue', audience: 'applicant' as const, template: 'request.issued' }] : [])], templates: d.issuesInstrument ? [`instrument.${d.issuesInstrument.toLowerCase()}`] : [] },
  });
}
const ACTION: Record<string, string> = { ':DRAFT': 'create', 'DRAFT:SUBMITTED': 'submit', 'SUBMITTED:UNDER_ASSESSMENT': 'start_assessment', 'UNDER_ASSESSMENT:INFO_REQUESTED': 'request_info', 'INFO_REQUESTED:UNDER_ASSESSMENT': 'provide_info', 'UNDER_ASSESSMENT:APPROVED': 'approve', 'UNDER_ASSESSMENT:REJECTED': 'reject', 'APPROVED:ISSUED': 'issue' };
const actionFor = (from: string, to: string) => ACTION[`${from}:${to}`] ?? (to === 'WITHDRAWN' ? 'withdraw' : to.toLowerCase());
/** What the eligibility checks look at, taken from the register the subject lives in. */
function subjectAttributes(world: World, r: WorldServiceRequest): Record<string, unknown> {
  const j = getJurisdiction(world.profile);
  if (r.subjectKind === 'VESSEL') { const v = world.vessels.find((x) => x.id === r.subjectId); return v ? { imo: v.imo, flag: v.flag, type: v.type, grt: v.grt, dwt: v.dwt, loa: v.loa, built: v.built, classSociety: v.classSociety, owner: v.owner, ownerNationality: v.flag === j.code ? j.name : 'Foreign' } : {}; }
  if (r.subjectKind === 'SEAFARER') { const s = world.seafarers.find((x) => x.id === r.subjectId); const med = s?.certificates.find((c) => /Medical/i.test(c.certType)); return s ? { cdcNo: s.cdcNo, rank: s.rank, nationality: s.nationality, dob: s.dob, medicalExpiry: med?.expiryDate ?? null, status: s.status } : {}; }
  if (r.subjectKind === 'PORT_FACILITY') { const b = world.berths.find((x) => x.id === r.subjectId); return b ? { code: b.code, terminal: b.terminal, berthType: b.berthType, status: b.status } : {}; }
  const c = world.companies.find((x) => x.id === r.subjectId); return c ? { code: c.code, category: c.category, types: c.types, status: c.status, rating: c.rating } : {};
}
const STUDIO_DRAFTS: Record<string, 'DRAFT' | 'IN_REVIEW'> = { 'REG-PROVISIONAL': 'DRAFT', 'SEAFARER-COC': 'IN_REVIEW', 'VESSEL-NAV-LIC': 'DRAFT' };

/** Seeds the catalogue (a published v1 in DEV, UAT and PROD per world service, plus a few studio drafts), the request register in its seeded states with timelines, and the rule-set mirror. Idempotent. */
export async function seedWorkflow(databaseUrl: string, profile?: string) {
  const { pool } = createDb(databaseUrl);
  await runMigrations(pool, join(__dirname, '..', 'migrations'));
  const world = buildWorld({ profile }); const j = getJurisdiction(world.profile); const currency = j.currency.code;
  const publishedAt = new Date(new Date(world.histStart).getTime() + 30 * D);
  const counts = await withTx(pool, async (c) => {
    let definitions = 0; let versions = 0; let drafts = 0; let requests = 0; let ruleSets = 0;
    const idByCode = new Map<string, string>();
    for (const d of world.serviceDefinitions) {
      const content = contentFor(d, currency);
      const errors = validateContent(content).filter((p) => p.severity === 'ERROR');
      if (errors.length) throw new Error(`Seed definition ${d.code} is invalid: ${errors.map((e) => `${e.path}: ${e.message}`).join('; ')}`);
      const s = await c.query<{ id: string; inserted: boolean }>(
        `INSERT INTO service_definitions(id, key, code, name, name_ar, category, category_ar, domain, subject_kind, description, description_ar, owner_module, issues_instrument, auto_approvable, current_version, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,1,'PUBLISHED','seed')
         ON CONFLICT (key) DO UPDATE SET name = EXCLUDED.name, name_ar = EXCLUDED.name_ar, category = EXCLUDED.category, category_ar = EXCLUDED.category_ar, description = EXCLUDED.description, updated_at = now() RETURNING id, (xmax = 0) AS inserted`,
        [d.id, d.key, d.code, d.name, d.nameAr ?? null, d.category, CATEGORY_AR[d.category] ?? null, d.domain, d.subjectKind, d.description, null, OWNER_MODULE_BY_DOMAIN[d.domain] ?? 'workflow', d.issuesInstrument || null, d.autoApprovable]);
      const id = s.rows[0].id; idByCode.set(d.code, id); if (s.rows[0].inserted) definitions += 1;
      const existing = await c.query('SELECT 1 FROM service_definition_versions WHERE definition_id = $1 LIMIT 1', [id]);
      if (existing.rowCount) continue;
      const cols = [JSON.stringify(content.form), JSON.stringify(content.documents), JSON.stringify(content.fees), JSON.stringify(content.sla), JSON.stringify(content.workflow), JSON.stringify(content.outputs)];
      for (const [envName, from] of [['DEV', null], ['UAT', 'v1:DEV'], ['PROD', 'v1:UAT']] as const) {
        await c.query(`INSERT INTO service_definition_versions(definition_id, version, environment, status, form, documents, fees, sla, workflow, outputs, change_note, created_by, submitted_by, approved_by, published_by, published_at, promoted_from, created_at)
          VALUES ($1, 1, $2, 'PUBLISHED', $3, $4, $5, $6, $7, $8, $9, 'seed', 'seed', 'seed', 'seed', $10, $11, $10)`, [id, envName, ...cols, `Catalogue release — ${d.name}`, publishedAt, from]);
        versions += 1;
      }
      const draft = STUDIO_DRAFTS[d.code];
      if (draft) {
        const next = { ...content, form: { ...content.form, fields: [...content.form.fields, { key: 'remarks', label: 'Remarks for the assessor', labelAr: 'ملاحظات للمقيّم', type: 'text' as const, required: false, options: [], validation: {}, section: 'Application', help: 'Anything the assessor should know', helpAr: null, multiline: true, entityKind: null }] }, sla: { ...content.sla, days: Math.max(1, content.sla.days - 1) } };
        await c.query(`INSERT INTO service_definition_versions(definition_id, version, environment, status, form, documents, fees, sla, workflow, outputs, change_note, created_by, submitted_by, promoted_from) VALUES ($1, 2, 'DEV', $2, $3, $4, $5, $6, $7, $8, $9, 'seed', $10, 'v1:PROD')`,
          [id, draft, JSON.stringify(next.form), JSON.stringify(next.documents), JSON.stringify(next.fees), JSON.stringify(next.sla), JSON.stringify(next.workflow), JSON.stringify(next.outputs), 'Studio draft — remarks field and a shorter SLA', draft === 'IN_REVIEW' ? 'seed' : null]);
        versions += 1; drafts += 1;
      }
    }
    const defByCode = new Map(world.serviceDefinitions.map((d) => [d.code, d]));
    const maxSeq = new Map<string, number>();
    for (const r of world.serviceRequests) {
      const d = defByCode.get(r.serviceCode)!; const definitionId = idByCode.get(r.serviceCode)!;
      const m = /^SR-(\d{4})-(\d+)$/.exec(r.requestNo); if (m) maxSeq.set(m[1], Math.max(maxSeq.get(m[1]) ?? 0, Number(m[2])));
      const open = ['SUBMITTED', 'UNDER_ASSESSMENT', 'INFO_REQUESTED'].includes(r.status);
      const lines = d.feeLines.map((l) => ({ code: l.code, description: l.label, descriptionAr: l.labelAr ?? null, unit: 'application', qty: 1, rate: l.amount, amount: l.amount, taxable: true }));
      const subtotalM = lines.reduce((s, l) => s + Math.round(l.amount * 100), 0); const taxM = Math.round((subtotalM * j.tax.ratePct) / 100);
      const fees = r.submittedAt ? { lines, subtotal: subtotalM / 100, taxRatePct: j.tax.ratePct, taxAmount: taxM / 100, total: (subtotalM + taxM) / 100, currency, ruleSetKey: d.feeLines.length ? `fee.${d.key}` : null, ruleSetVersion: d.feeLines.length ? 1 : null, computedAt: r.submittedAt } : {};
      const payment = r.submittedAt ? { status: subtotalM === 0 ? 'NOT_REQUIRED' : r.fee.paid ? 'PAID' : 'DUE', amount: (subtotalM + taxM) / 100, currency, paidAt: r.fee.paidAt, reference: r.fee.reference } : {};
      const documents: RequestDocument[] = r.documents.map((x) => ({ code: x.key, documentId: null, name: x.fileName, uploadedAt: x.uploadedAt, verified: x.verified, verifiedBy: x.verified ? x.verifiedBy : null, verifiedAt: x.verifiedAt, notes: x.notes }));
      const timeline: TimelineEntry[] = r.timeline.map((h) => ({ from: h.from, to: h.to, action: actionFor(h.from, h.to), at: h.at, by: { id: null, name: h.by }, note: h.note }));
      const issued = r.status === 'ISSUED' ? { id: r.issuedInstrumentId, number: r.issuedInstrumentNo, type: d.issuesInstrument || null, class: d.issuesInstrument ? instrumentClassOf(d.issuesInstrument) : null, status: 'ISSUED', requestedAt: r.closedAt, issuedAt: r.closedAt } : null;
      const ins = await c.query(
        `INSERT INTO service_requests(id, number, definition_id, definition_key, definition_name, definition_name_ar, definition_version, environment, category, domain, subject_kind, subject_id, subject_name, subject, applicant, status, current_state, form_data, documents, fees, payment, assignee, checks, sla_due_at, sla_breached, sla_breached_at, submitted_at, decided_at, closed_at, issued_instrument, timeline, created_by, created_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,1,'PROD',$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30,$31,$32) ON CONFLICT (number) DO NOTHING`,
        [r.id, r.requestNo, definitionId, d.key, d.name, d.nameAr ?? null, d.category, d.domain, r.subjectKind, r.subjectId, r.subjectLabel, JSON.stringify(subjectAttributes(world, r)), JSON.stringify(r.applicant), r.status, r.status, JSON.stringify(r.formData), JSON.stringify(documents), JSON.stringify(fees), JSON.stringify(payment),
          r.assignedToId ? JSON.stringify({ userId: r.assignedToId, name: r.assignedTo }) : null, JSON.stringify(r.checks), r.dueAt, false, null, r.submittedAt, r.decision?.at ?? null, r.closedAt, issued ? JSON.stringify(issued) : null, JSON.stringify(timeline), r.applicant.userId ?? 'seed', r.createdAt, r.closedAt ?? r.submittedAt ?? r.createdAt]);
      requests += ins.rowCount ?? 0;
    }
    for (const [year, seq] of maxSeq) await c.query('INSERT INTO numbering_series(series, last_value) VALUES ($1, $2) ON CONFLICT (series) DO UPDATE SET last_value = GREATEST(numbering_series.last_value, EXCLUDED.last_value)', [`sr:${year}`, seq]);
    for (const rs of world.ruleSets) {
      await c.query('INSERT INTO rule_set_cache(key, kind, version, definition, parameters) VALUES ($1, $2, 1, $3, $4) ON CONFLICT (key) DO UPDATE SET kind = EXCLUDED.kind, definition = EXCLUDED.definition, parameters = EXCLUDED.parameters, updated_at = now()', [rs.key, rs.kind, JSON.stringify(normaliseDefinition(rs.kind, rs.definition)), JSON.stringify(rs.parameters)]);
      ruleSets += 1;
    }
    return { definitions, versions, drafts, requests, ruleSets, profile: world.profile };
  });
  await pool.end();
  return counts;
}
if (require.main === module) {
  const e = env();
  seedWorkflow(e.DATABASE_URL).then((c) => console.log('SEED COMPLETE', c)).catch((err) => { console.error(err); process.exit(1); });
}
