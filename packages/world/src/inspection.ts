import { getJurisdiction, INSPECTION_TYPES } from '@maritime/contracts';
import { Prng, D, H, HIST_START, stableId, iso, yearOf, makeSeries } from './prng';
import type { WorldPortCall } from './operations';
import type { WorldVessel } from './vessels';
import type { WorldUser } from './people';
import type { WorldLookup } from './reference';
import type { WorldBerth, WorldCompany } from './organisations';

export type InspectionType = (typeof INSPECTION_TYPES)[number] | 'HSE' | 'TERMINAL' | 'PFSP' | 'ISM_DOC' | 'ACCREDITATION';
export type InspectionSubjectKind = 'VESSEL' | 'COMPANY' | 'PORT_FACILITY' | 'MET_INSTITUTION';
/* The Smart Inspection record on a survey: the facts the six programme KPIs are measured from.
 *
 * The programme (dossier before boarding, machine-drafted reports and notices, a prediction scored against the
 * findings, restrictions routed inside the hour) started on a day the world knows; before it, surveys were worked
 * on paper — manual reports days later, notices by letter, no prediction. After it the machine's share rises month
 * by month, so the dashboard shows a programme in progress rather than a switch that was flipped. */
export interface WorldInspectionSmart {
  dossierPreparedAt: string | null; dossierSource: 'AUTO' | 'DESK' | '';
  report: { source: 'AI' | 'MANUAL'; draftedAt: string; issuedAt: string | null } | null;
  notice: { source: 'AI' | 'MANUAL'; draftedAt: string; issuedAt: string | null } | null;
  recommendation: { kind: 'DETENTION' | 'RESTRICTION'; recommendedAt: string; routedAt: string | null; decidedAt: string | null; decision: 'APPROVED' | 'REJECTED' | 'DEFERRED' | '' } | null;
  prediction: { source: 'A5' | 'RULES'; predictedAt: string; riskScore: number; band: 'LOW' | 'MEDIUM' | 'HIGH'; predictedCodes: string[]; scoredAt: string | null; correlated: boolean | null } | null;
}
/** The day the Smart Inspection programme went live in the fictional world — fifteen months before the world is built, so the eighteen-month clock is running but not run out. */
export const SMART_PROGRAMME_START = new Date(Date.UTC(2025, 5, 1));
export interface WorldChecklistItem { seq: number; text: string; category: string; answerType: 'YES_NO' | 'YES_NO_NA' | 'TEXT' | 'NUMBER'; weight: number; critical: boolean; guidance: string }
export interface WorldChecklistTemplate { id: string; name: string; inspectionType: string; description: string; items: WorldChecklistItem[]; active: boolean; version: number; passScorePct: number }
export interface WorldFinding { deficiencyCode: string; deficiencyLabel: string; description: string; actionCode: string; dueDate: string; status: 'OPEN' | 'CLOSED'; closedAt: string | null }
export interface WorldChecklistAnswer { seq: number; text: string; category: string; answer: 'YES' | 'NO' | 'NA' | ''; note: string }
export interface WorldInspection {
  id: string; number: string; vesselId: string | null; vesselName: string; portCallId: string | null; vcn: string | null; type: InspectionType; templateId: string | null;
  /** Who or what was inspected: a ship by default, or a company, a port facility or a training institution under a regime that applies to it. */
  subjectKind: InspectionSubjectKind; subjectId: string; subjectName: string;
  inspectorId: string; inspector: string; plannedAt: string; startedAt: string | null; closedAt: string | null; status: 'PLANNED' | 'IN_PROGRESS' | 'CLOSED';
  result: 'SATISFACTORY' | 'DEFICIENCIES' | 'DETAINED' | ''; scorePct: number | null; detention: boolean; checklist: WorldChecklistAnswer[]; findings: WorldFinding[]; remarks: string;
  smart: WorldInspectionSmart;
}

type Row = [string, string, number, boolean, string?];
const items = (rows: Row[]): WorldChecklistItem[] => rows.map(([text, category, weight, critical, guidance], i) => ({ seq: i + 1, text, category, answerType: 'YES_NO_NA', weight, critical, guidance: guidance ?? '' }));
/** Checklist templates for surveys, audits and HSE walks — versioned; a retired template stays on the register as visible history. */
export function buildChecklistTemplates(profile: string): WorldChecklistTemplate[] {
  const j = getJurisdiction(profile);
  const defs: [string, string, string, number, number, boolean, WorldChecklistItem[]][] = [
    ['PSC Initial Inspection', 'PSC', `Initial PSC boarding checklist aligned to ${j.pscRegime.name} practice.`, 85, 3, true, items([
      ['Ship certificates and documents verified', 'Documentation', 3, true, 'Verify originals on board; check endorsements and validity dates.'], ['Crew certificates match safe manning document', 'Documentation', 3, false],
      ['Navigation bridge equipment operational', 'Safety', 2, false], ['Fire doors and dampers close properly', 'Safety', 2, false], ['Lifeboats and davits — condition and launching', 'Safety', 2, false],
      ['Emergency generator starts on load', 'Machinery & MARPOL', 2, true], ['Oily-water separator and 15ppm alarm test', 'Machinery & MARPOL', 2, false], ['Garbage management plan and record book', 'Machinery & MARPOL', 2, false],
      ['Crew accommodation hygiene', 'Machinery & MARPOL', 2, false], ['Mooring arrangement condition', 'Machinery & MARPOL', 2, false]])],
    ['Pre-Berthing Safety Check', 'FSI', 'Marine pre-berthing verification run by the duty berth planner.', 100, 1, true, items([
      ['Arrival draft within berth limit', 'Pre-berthing', 2, true], ['Dangerous goods declaration reviewed', 'Pre-berthing', 2, false], ['Mooring plan agreed with pilot', 'Pre-berthing', 2, false],
      ['Gangway and access arrangement safe', 'Pre-berthing', 2, false], ['Bunker operations notified', 'Pre-berthing', 2, false]])],
    ['MLC On-board Conditions', 'MLC', 'On-board living and working condition verification under MLC 2006.', 80, 1, true, items([
      ['Seafarer employment agreements available', 'MLC', 2, false], ['Wage records up to date', 'MLC', 2, false], ['Rest hour records maintained', 'MLC', 2, true], ['Food and catering standard', 'MLC', 2, false], ['Medical chest inventory complete', 'MLC', 2, false]])],
    ['ISM Safety Management Audit', 'ISM', 'Shipboard verification of the safety management system under the ISM Code.', 85, 1, true, items([
      ['Safety management manual on board and controlled', 'Documentation', 3, true], ['Master\'s review of the SMS completed within the year', 'Documentation', 2, false], ['Non-conformity reports raised and closed out', 'System', 3, false],
      ['Emergency drills held at the required intervals', 'Drills & records', 2, true], ['Designated Person Ashore contact posted and known to crew', 'System', 2, false], ['Planned maintenance system records current', 'Maintenance', 2, false]])],
    ['HSE Walkabout — Terminal', 'HSE', 'Weekly HSE walkabout of a working terminal — housekeeping, PPE, permits, emergency readiness.', 80, 1, true, items([
      ['PPE worn by all personnel in cargo areas', 'PPE & People', 3, true], ['Toolbox talk record available for the shift', 'PPE & People', 2, false], ['Walkways and quay apron clear of obstructions', 'Housekeeping', 2, false],
      ['Spill kits stocked and accessible', 'Emergency readiness', 3, false], ['Fire extinguishers in date and unobstructed', 'Emergency readiness', 3, true], ['Hot-work permits displayed at worksites', 'Permits', 3, true],
      ['Working-at-height controls in place on lashing bridges', 'Permits', 2, false], ['Lighting adequate in working areas (night shift)', 'Housekeeping', 2, false], ['Waste segregation bins not overflowing', 'Housekeeping', 1, false], ['Emergency assembly point signage visible', 'Emergency readiness', 1, false]])],
    ['Terminal Safety Audit — Equipment', 'TERMINAL', 'Quarterly audit of terminal cargo-handling equipment and operator competency.', 85, 2, true, items([
      ['Crane daily inspection log up to date', 'Cranes', 3, true], ['Limit switches and anti-collision tested', 'Cranes', 3, true], ['Wire ropes within discard criteria', 'Cranes', 3, false], ['RTG/ITV seat belts and cameras functional', 'Yard equipment', 2, false],
      ['Operators hold valid competency cards', 'People', 3, true], ['Fuelling area bunded and signed', 'Yard', 2, false], ['Reefer towers earthed and guarded', 'Yard', 2, false], ['Conveyor emergency pull-cords tested', 'Bulk stream', 3, true]])],
    ['ISPS Ship Security Verification', 'ISPS', 'Ship security verification under the ISPS Code — plan, access control, drills and alerting.', 85, 1, true, items([
      ['Ship Security Plan on board and approved', 'Documentation', 3, true], ['Access control maintained at all access points', 'Access control', 3, true], ['Restricted areas marked and secured', 'Access control', 2, false],
      ['Security drills conducted at required intervals', 'Drills & records', 2, false], ['Ship Security Alert System tested and logged', 'Alerting', 3, true]])],
    ['Bunkering Safety Watch', 'FSI', 'Retired — superseded by the Pre-Berthing Safety Check, which absorbed its bunkering items.', 100, 2, false, items([
      ['Bunker checklist agreed with barge master', 'Bunkering', 2, true], ['Scuppers plugged and drip trays in place', 'Bunkering', 2, false]])],
  ];
  return defs.map(([name, inspectionType, description, passScorePct, version, active, list]) => ({ id: stableId('checklist', name), name, inspectionType, description, items: list, active, version, passScorePct }));
}

const scoreOf = (tpl: WorldChecklistTemplate | undefined, answers: WorldChecklistAnswer[]): number | null => {
  const weightOf = new Map((tpl?.items ?? []).map((i) => [i.text, i.weight]));
  let got = 0; let max = 0;
  for (const a of answers) { if (!a.answer || a.answer === 'NA') continue; const w = weightOf.get(a.text) ?? 1; max += w; if (a.answer === 'YES') got += w; }
  return max > 0 ? Math.round((got / max) * 100) : null;
};

/** Three to five surveys a month since 2023 on sailed calls of the fictional fleet, plus the live desk. Documented liner callers are never inspected. */
const NONE: WorldInspectionSmart = { dossierPreparedAt: null, dossierSource: '', report: null, notice: null, recommendation: null, prediction: null };
const MIN = 60_000;
/** The Smart Inspection facts for one closed survey, from where the programme stood on the day it was worked. */
function smartFor(rng: Prng, i: { startedAt: Date; closedAt: Date; detained: boolean; findings: WorldFinding[]; priorCodes: string[] }, now: Date): WorldInspectionSmart {
  const live = i.startedAt.getTime() >= SMART_PROGRAMME_START.getTime();
  const k = Math.max(0, (i.startedAt.getTime() - SMART_PROGRAMME_START.getTime()) / (30.44 * D)); // months into the programme
  const closed = i.closedAt.getTime(); const started = i.startedAt.getTime();
  const codes = i.findings.map((f) => f.deficiencyCode);
  if (!live) {
    // the paper era: a desk-typed report days later, a notice by letter, a detention recommendation walked to the harbour master
    const draftedAt = closed + rng.int(30, 96) * H;
    return {
      dossierPreparedAt: rng.chance(0.15) ? iso(started - rng.int(2, 20) * H) : null, dossierSource: rng.chance(0.15) ? 'DESK' : '',
      report: { source: 'MANUAL', draftedAt: iso(draftedAt), issuedAt: iso(draftedAt + rng.int(4, 30) * H) },
      notice: i.findings.length ? { source: 'MANUAL', draftedAt: iso(closed + rng.int(20, 72) * H), issuedAt: iso(closed + rng.int(72, 120) * H) } : null,
      recommendation: i.detained ? { kind: 'DETENTION', recommendedAt: iso(closed), routedAt: iso(closed + rng.int(90, 300) * MIN), decidedAt: iso(closed + rng.int(5, 9) * H), decision: 'APPROVED' } : null,
      prediction: null,
    };
  }
  const ai = rng.chance(Math.min(0.8, 0.45 + k * 0.025));
  const draftedAt = ai ? closed + rng.int(4, 12) * MIN : closed + rng.int(18, 60) * H;
  const issuedAt = ai ? draftedAt + rng.int(120, 600) * MIN : draftedAt + rng.int(4, 24) * H;
  const noticeAi = i.findings.length ? rng.chance(Math.min(0.85, 0.5 + k * 0.025)) : false;
  const noticeAt = noticeAi ? closed + rng.int(5, 25) * MIN : closed + rng.int(45, 2000) * MIN;
  const band: WorldInspectionSmart['prediction'] extends infer P ? P extends { band: infer B } ? B : never : never = i.detained || i.priorCodes.length >= 3 ? 'HIGH' : i.priorCodes.length >= 1 ? 'MEDIUM' : 'LOW';
  const predicted = [...new Set(i.priorCodes)].slice(0, 3);
  const matched = predicted.some((c) => codes.includes(c));
  const bandAgrees = band === 'LOW' ? codes.length === 0 : codes.length > 0;
  // the model is right about two times in three; the third time the world makes it wrong on purpose
  const correlated = rng.chance(0.68) ? (matched || bandAgrees || rng.chance(0.5)) : !(matched || bandAgrees) && rng.chance(0.3);
  const decidedAt = closed + rng.int(20, 150) * MIN;
  return {
    dossierPreparedAt: rng.chance(Math.min(1, 0.6 + k * 0.03)) ? iso(started - rng.int(1, 18) * H) : null, dossierSource: 'AUTO',
    report: { source: ai ? 'AI' : 'MANUAL', draftedAt: iso(draftedAt), issuedAt: issuedAt <= now.getTime() ? iso(issuedAt) : null },
    notice: i.findings.length ? { source: noticeAi ? 'AI' : 'MANUAL', draftedAt: iso(noticeAt), issuedAt: noticeAt + 6 * H <= now.getTime() ? iso(noticeAt + rng.int(1, 6) * H) : null } : null,
    recommendation: i.detained ? { kind: 'DETENTION', recommendedAt: iso(closed), routedAt: iso(closed + rng.int(1, 9) * MIN), decidedAt: iso(decidedAt), decision: 'APPROVED' }
      : i.findings.length >= 4 ? { kind: 'RESTRICTION', recommendedAt: iso(closed), routedAt: iso(closed + rng.int(1, 9) * MIN), decidedAt: iso(decidedAt), decision: rng.chance(0.7) ? 'APPROVED' : 'REJECTED' } : null,
    prediction: { source: k >= 3 ? 'A5' : 'RULES', predictedAt: iso(started - rng.int(6, 30) * H), riskScore: Math.min(96, 18 + i.priorCodes.length * 11 + (i.detained ? 28 : 0) + rng.int(0, 12)), band, predictedCodes: predicted, scoredAt: iso(closed + 1 * MIN), correlated },
  };
}

export function buildInspections(rng: Prng, portCalls: WorldPortCall[], vessels: WorldVessel[], templates: WorldChecklistTemplate[], users: WorldUser[], lookups: WorldLookup[], now: Date, subjects: { companies?: WorldCompany[]; berths?: WorldBerth[] } = {}): WorldInspection[] {
  const srng = rng.fork('smart');
  const priorByVessel = new Map<string, string[]>();
  const vById = new Map(vessels.map((v) => [v.id, v]));
  const fictional = (id: string) => vById.get(id)?.real === false;
  const inspectors = users.filter((u) => u.roleName === 'Marine Surveyor' && /surveyor/i.test(u.designation)).slice(0, 3);
  const defs = lookups.filter((l) => l.category === 'deficiencyCode'); const actions = ['10', '15', '16', '17'];
  const tplFor = (type: string) => templates.find((t) => t.inspectionType === type && t.active) ?? templates[0];
  const answersFor = (tpl: WorldChecklistTemplate, fill: (ix: number) => WorldChecklistAnswer['answer']): WorldChecklistAnswer[] => tpl.items.map((i, ix) => ({ seq: i.seq, text: i.text, category: i.category, answer: fill(ix), note: '' }));
  const seq = makeSeries(); const numberFor = (d: Date) => `INS-${yearOf(d)}-${seq(String(yearOf(d)), 3)}`;
  const eligible = portCalls.filter((c) => c.status === 'SAILED' && c.atb && fictional(c.vesselId));
  const byMonth = new Map<string, WorldPortCall[]>();
  for (const c of eligible) { const k = c.atb!.slice(0, 7); byMonth.set(k, [...(byMonth.get(k) ?? []), c]); }
  const picked: WorldPortCall[] = [];
  for (let d = new Date(HIST_START); d.getTime() <= now.getTime(); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1))) {
    picked.push(...rng.shuffle(byMonth.get(iso(d).slice(0, 7)) ?? []).slice(0, rng.int(3, 5)));
  }
  picked.sort((a, b) => a.atb!.localeCompare(b.atb!));
  const out: WorldInspection[] = [];
  picked.forEach((call, idx) => {
    const type: InspectionType = rng.chance(0.55) ? 'PSC' : rng.chance(0.5) ? 'FSI' : rng.pick(['ISM', 'MLC', 'ISPS']);
    const tpl = tplFor(type); const startedAt = new Date(new Date(call.atb!).getTime() + 5 * H);
    const detained = idx % 16 === 4; // ~6% detention rate, in line with the regional PSC figure
    const nFind = detained ? rng.int(3, 5) : rng.chance(0.5) ? 0 : rng.int(1, 3);
    const findings: WorldFinding[] = Array.from({ length: nFind }, (_, i2) => {
      const def = defs[(idx + i2 * 3) % defs.length]; const closed = !detained && rng.chance(0.8);
      return { deficiencyCode: def.code, deficiencyLabel: def.label, description: `${def.label} — observed during ${type} inspection`, actionCode: detained && i2 === 0 ? '30' : rng.pick(actions),
        dueDate: iso(startedAt.getTime() + 14 * D), status: closed ? 'CLOSED' : 'OPEN', closedAt: closed ? iso(startedAt.getTime() + rng.int(1, 12) * D) : null };
    });
    const inspector = rng.pick(inspectors); const checklist = answersFor(tpl, () => (rng.chance(0.9) ? 'YES' : 'NO'));
    const number = numberFor(startedAt);
    // a boarding takes four to eleven hours; the paper era's fixed nine-hour day is not what the turnaround KPI should read
    const closedAt = new Date(startedAt.getTime() + srng.int(4, 11) * H);
    const priorCodes = priorByVessel.get(call.vesselId) ?? [];
    const smart = smartFor(srng, { startedAt, closedAt, detained, findings, priorCodes }, now);
    priorByVessel.set(call.vesselId, [...priorCodes, ...findings.map((f) => f.deficiencyCode)].slice(-8));
    out.push({ id: stableId('inspection', number), number, vesselId: call.vesselId, vesselName: call.vesselName, portCallId: call.id, vcn: call.vcn, type, templateId: tpl.id, subjectKind: 'VESSEL', subjectId: call.vesselId, subjectName: call.vesselName,
      inspectorId: inspector.id, inspector: inspector.name,
      plannedAt: iso(startedAt.getTime() - srng.int(12, 48) * H), startedAt: iso(startedAt), closedAt: iso(closedAt), status: 'CLOSED', result: detained ? 'DETAINED' : nFind ? 'DEFICIENCIES' : 'SATISFACTORY',
      scorePct: scoreOf(tpl, checklist), detention: detained, checklist, findings, remarks: '', smart });
  });
  /* Beyond ships: the terminals get an HSE walkabout or an equipment audit every other month, and a regulated company an
   * ISM document-of-compliance audit every quarter — the same engine, a different subject under a regime that applies to it. */
  const facilities = (subjects.berths ?? []); const companies = (subjects.companies ?? []).filter((c) => !c.real && ['AGENCY', 'TERMINAL_OPERATOR', 'SERVICE_PROVIDER'].includes(c.category));
  let month = 0;
  for (let d = new Date(HIST_START); d.getTime() <= now.getTime(); d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)), month += 1) {
    const startedAt = new Date(d.getTime() + srng.int(3, 24) * D + 8 * H);
    if (startedAt.getTime() > now.getTime() - D) break;
    if (month % 2 === 0 && facilities.length) {
      const b = facilities[(month / 2) % facilities.length]; const type: InspectionType = month % 4 === 0 ? 'HSE' : 'TERMINAL';
      const tpl = tplFor(type); const inspector = inspectors[month % inspectors.length];
      const nFind = srng.chance(0.55) ? 0 : srng.int(1, 2);
      const findings: WorldFinding[] = Array.from({ length: nFind }, (_, i2) => { const def = defs[(month + i2 * 5) % defs.length]; const closed = srng.chance(0.85); return { deficiencyCode: def.code, deficiencyLabel: def.label, description: `${def.label} — observed during ${type} inspection of ${b.name}`, actionCode: srng.pick(actions), dueDate: iso(startedAt.getTime() + 21 * D), status: closed ? 'CLOSED' : 'OPEN', closedAt: closed ? iso(startedAt.getTime() + srng.int(2, 18) * D) : null }; });
      const checklist = answersFor(tpl, () => (srng.chance(0.92) ? 'YES' : 'NO')); const number = numberFor(startedAt); const closedAt = new Date(startedAt.getTime() + srng.int(3, 6) * H);
      out.push({ id: stableId('inspection', number), number, vesselId: null, vesselName: '', portCallId: null, vcn: null, type, templateId: tpl.id, subjectKind: 'PORT_FACILITY', subjectId: b.id, subjectName: b.name,
        inspectorId: inspector.id, inspector: inspector.name, plannedAt: iso(startedAt.getTime() - 5 * D), startedAt: iso(startedAt), closedAt: iso(closedAt), status: 'CLOSED', result: nFind ? 'DEFICIENCIES' : 'SATISFACTORY',
        scorePct: scoreOf(tpl, checklist), detention: false, checklist, findings, remarks: '', smart: smartFor(srng, { startedAt, closedAt, detained: false, findings, priorCodes: [] }, now) });
    }
    if (month % 3 === 1 && companies.length) {
      const co = companies[Math.floor(month / 3) % companies.length]; const type: InspectionType = 'ISM_DOC';
      const tpl = tplFor('ISM'); const inspector = inspectors[(month + 1) % inspectors.length];
      const nFind = srng.chance(0.6) ? 0 : 1;
      const findings: WorldFinding[] = nFind ? [{ deficiencyCode: '14104', deficiencyLabel: defs.find((x) => x.code === '14104')?.label ?? 'ISM', description: `Safety management system non-conformity noted at the ${co.name} office audit`, actionCode: '17', dueDate: iso(startedAt.getTime() + 30 * D), status: 'CLOSED', closedAt: iso(startedAt.getTime() + srng.int(5, 25) * D) }] : [];
      const checklist = answersFor(tpl, () => (srng.chance(0.93) ? 'YES' : 'NO')); const number = numberFor(startedAt); const closedAt = new Date(startedAt.getTime() + srng.int(5, 8) * H);
      out.push({ id: stableId('inspection', number), number, vesselId: null, vesselName: '', portCallId: null, vcn: null, type, templateId: tpl.id, subjectKind: 'COMPANY', subjectId: co.id, subjectName: co.name,
        inspectorId: inspector.id, inspector: inspector.name, plannedAt: iso(startedAt.getTime() - 14 * D), startedAt: iso(startedAt), closedAt: iso(closedAt), status: 'CLOSED', result: nFind ? 'DEFICIENCIES' : 'SATISFACTORY',
        scorePct: scoreOf(tpl, checklist), detention: false, checklist, findings, remarks: '', smart: smartFor(srng, { startedAt, closedAt, detained: false, findings, priorCodes: [] }, now) });
    }
  }
  out.sort((a, b) => a.plannedAt.localeCompare(b.plannedAt));
  // the live desk: two boardings in progress, one planned on an expected arrival
  const berthedNow = portCalls.filter((c) => c.status === 'BERTHED' && fictional(c.vesselId));
  berthedNow.slice(0, 2).forEach((call, i) => {
    const type: InspectionType = i === 0 ? 'PSC' : 'MLC'; const tpl = tplFor(type); const number = numberFor(now);
    out.push({ id: stableId('inspection', number), number, vesselId: call.vesselId, vesselName: call.vesselName, portCallId: call.id, vcn: call.vcn, type, templateId: tpl.id, subjectKind: 'VESSEL', subjectId: call.vesselId, subjectName: call.vesselName, inspectorId: inspectors[0].id, inspector: inspectors[0].name,
      plannedAt: iso(now.getTime() - 4 * H), startedAt: iso(now.getTime() - 3 * H), closedAt: null, status: 'IN_PROGRESS', result: '', scorePct: null, detention: false,
      checklist: answersFor(tpl, (ix) => (ix < 4 ? 'YES' : '')),
      findings: i === 0 ? [{ deficiencyCode: '10111', deficiencyLabel: defs.find((d) => d.code === '10111')?.label ?? '', description: 'Passage-plan charts not corrected to latest Notices to Mariners', actionCode: '17', dueDate: iso(now.getTime() + D), status: 'OPEN', closedAt: null }] : [], remarks: '',
      smart: { ...NONE, dossierPreparedAt: iso(now.getTime() - 4 * H), dossierSource: 'AUTO', prediction: { source: 'A5', predictedAt: iso(now.getTime() - 20 * H), riskScore: i === 0 ? 61 : 34, band: i === 0 ? 'HIGH' : 'LOW', predictedCodes: i === 0 ? ['10111', '07105'] : [], scoredAt: null, correlated: null } } });
  });
  const conf = portCalls.find((c) => c.status === 'CONFIRMED' && fictional(c.vesselId));
  if (conf) {
    const tpl = tplFor('FSI'); const number = numberFor(now);
    out.push({ id: stableId('inspection', number), number, vesselId: conf.vesselId, vesselName: conf.vesselName, portCallId: conf.id, vcn: conf.vcn, type: 'FSI', templateId: tpl.id, subjectKind: 'VESSEL', subjectId: conf.vesselId, subjectName: conf.vesselName, inspectorId: inspectors[2 % inspectors.length].id, inspector: inspectors[2 % inspectors.length].name,
      plannedAt: conf.eta, startedAt: null, closedAt: null, status: 'PLANNED', result: '', scorePct: null, detention: false, checklist: answersFor(tpl, () => ''), findings: [], remarks: '',
      smart: { ...NONE, dossierPreparedAt: iso(now.getTime() - 2 * H), dossierSource: 'AUTO', prediction: { source: 'RULES', predictedAt: iso(now.getTime() - 2 * H), riskScore: 27, band: 'LOW', predictedCodes: [], scoredAt: null, correlated: null } } });
  }
  return out;
}
