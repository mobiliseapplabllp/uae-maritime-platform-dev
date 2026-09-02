import { getJurisdiction, DEFAULT_RISK_WEIGHTS } from '@maritime/contracts';
import { Prng, D, H, stableId, iso } from './prng';
import { imoCheck, type WorldVessel } from './vessels';
import type { WorldUser } from './people';
import type { WorldVesselCertificate } from './certificates';
import type { WorldInspection } from './inspection';
import { forceState, type WorldLicence } from './instruments';
import type { WorldServiceDefinition, WorldServiceRequest } from './services';
import type { WorldLegalInstrument } from './legislation';
import type { WorldIncident } from './incidents';

export type AutonomyLevel = 'SUPERVISED' | 'ASSISTED' | 'AUTONOMOUS';
export type Disposition = 'AUTO_APPLIED' | 'ESCALATED' | 'AWAITING_REVIEW' | 'APPROVED_BY_HUMAN' | 'OVERRIDDEN' | 'REJECTED_BY_HUMAN';
/** A3 — per-agent autonomy: supervised (every recommendation reviewed), assisted (acts above the threshold, escalates below), autonomous (acts and notifies). */
export interface WorldAgentConfig {
  id: string; agentId: string; name: string; nameAr?: string; role: string; domain: number; enabled: boolean; autonomyLevel: AutonomyLevel; confidenceThreshold: number; maxActionsPerHour: number; escalateTo: string;
  schedule: { cadence: 'EVENT' | 'HOURLY' | 'DAILY' | 'WEEKLY'; cron: string; timezone: string }; suspended: boolean; suspendedReason: string; suspendedBy: string; suspendedAt: string | null;
  stats: { decisions: number; autoApplied: number; escalated: number; overridden: number; avgConfidence: number; lastRunAt: string | null }; changes: { field: string; from: string; to: string; at: string; by: string; reason: string }[];
}
export interface WorldAiFactor { factor: string; weight: number; value: string; contribution: number }
/** The append-only record of one AI decision: inputs, output, reasoning, confidence, the autonomy in force and what a human did with it. */
export interface WorldAiDecision {
  id: string; agentId: string; agentName: string; action: string; subjectType: string; subjectId: string; subjectLabel: string; inputs: Record<string, unknown>; output: Record<string, unknown>; explanation: string; factors: WorldAiFactor[];
  confidence: number; autonomyLevel: AutonomyLevel; threshold: number; disposition: Disposition; escalationReason: string; reviewedById: string | null; reviewedBy: string; reviewedAt: string | null; overrideReason: string; supersedesId: string | null;
  modelId: string; modelVersion: string; latencyMs: number; at: string;
}
export interface AgentContext { users: WorldUser[]; vessels: WorldVessel[]; vesselCertificates: WorldVesselCertificate[]; inspections: WorldInspection[]; licences: WorldLicence[]; serviceDefinitions: WorldServiceDefinition[]; serviceRequests: WorldServiceRequest[]; legalInstruments: WorldLegalInstrument[]; incidents: WorldIncident[] }

// agentId, name, Arabic name, role, domain, autonomy, threshold, cadence, cron. Autonomy starts conservative: only the agents that read rather than decide begin above supervision.
const AGENT_DEFS: [string, string, string, string, number, AutonomyLevel, number, WorldAgentConfig['schedule']['cadence'], string][] = [
  ['collector', 'Harbour Collector', 'جامع بيانات الميناء', 'Ingestion', 4, 'AUTONOMOUS', 0.8, 'HOURLY', '0 * * * *'], ['curator', 'Facts Curator', 'منسق الحقائق', 'Data', 4, 'AUTONOMOUS', 0.8, 'HOURLY', '15 * * * *'],
  ['sentinel', 'Berth Sentinel', 'حارس الأرصفة', 'Monitoring', 4, 'ASSISTED', 0.85, 'EVENT', ''], ['auditor', 'Marine Auditor', 'المدقق البحري', 'Assessment', 5, 'ASSISTED', 0.88, 'DAILY', '0 6 * * *'],
  ['planner', 'Berth Planner', 'مخطط الأرصفة', 'Planning', 4, 'SUPERVISED', 0.9, 'EVENT', ''], ['analyst', 'Trade Analyst', 'محلل التجارة', 'Analysis', 4, 'ASSISTED', 0.85, 'WEEKLY', '0 7 * * 1'],
  ['examiner', 'QA Examiner', 'فاحص الجودة', 'Quality', 5, 'AUTONOMOUS', 0.75, 'EVENT', ''], ['validator', 'QA Validator', 'مدقق الجودة', 'Quality', 5, 'AUTONOMOUS', 0.75, 'EVENT', ''],
  ['supervisor', 'Duty Officer', 'ضابط المناوبة', 'Orchestration', 4, 'SUPERVISED', 0.92, 'HOURLY', '30 * * * *'],
  ['a1_document_intelligence', 'Document Intelligence Agent', 'وكيل ذكاء الوثائق', 'Document validation', 1, 'ASSISTED', 0.85, 'EVENT', ''], ['a2_vessel_compliance', 'Vessel Compliance Agent', 'وكيل امتثال السفن', 'Compliance monitoring', 1, 'ASSISTED', 0.8, 'DAILY', '0 5 * * *'],
  ['a3_service_processing', 'Service Processing Agent', 'وكيل معالجة الخدمات', 'Service adjudication', 1, 'SUPERVISED', 0.9, 'EVENT', ''], ['a4_customer_guidance', 'Customer Guidance Agent', 'وكيل إرشاد المتعاملين', 'Applicant guidance', 1, 'AUTONOMOUS', 0.75, 'EVENT', ''],
  ['a5_smart_inspection', 'Smart Inspection Agent', 'وكيل التفتيش الذكي', 'Inspection targeting', 5, 'ASSISTED', 0.82, 'DAILY', '0 4 * * *'], ['a6_regulatory_intelligence', 'Regulatory Intelligence Agent', 'وكيل الذكاء التنظيمي', 'Regulatory analysis', 3, 'ASSISTED', 0.8, 'DAILY', '30 6 * * *'],
  ['a7_maritime_intelligence', 'National Maritime Intelligence Agent', 'وكيل الاستخبارات البحرية الوطنية', 'Situational intelligence', 4, 'AUTONOMOUS', 0.78, 'HOURLY', '45 * * * *'],
];
const WORKFORCE_ACTION: Record<string, [string, string]> = {
  sentinel: ['Flagged sustained waiting-time rise at the container terminal', 'Waiting time rose to 26.4 h against a 12-week baseline of 17.1 h.'],
  auditor: ['Scored terminal service against benchmark', 'Berth-day output 14,900 MT against the published major-port benchmark.'],
  analyst: ['Identified cargo mix shift', 'Container share moved 4.2 points against the trailing year.'],
  examiner: ['Rejected a draft finding as unsupported', 'Cited figure did not reconcile with the source panel.'],
  collector: ['Rebuilt operational panels', 'Four panels refreshed from the latest snapshot.'],
  curator: ['Curated a fact for the analysis pack', 'Figure reconciled against the source panel.'],
  planner: ['Proposed a berth window allocation', 'Window fits declared LOA and draft with 40 minutes clearance.'],
  validator: ['Validated a generated narrative', 'Every cited figure traced to the panel that produced it.'],
  supervisor: ['Sequenced an agent run', 'Collector completed; handed to Curator with fresh data.'],
};

/* The seven mandated agents as pure judgements: what each was given, what it concluded, why, the weighted factors behind it and how confident it is. */
interface Judgement { action: string; subjectType: string; subjectId: string; subjectLabel: string; inputs: Record<string, unknown>; output: Record<string, unknown>; explanation: string; factors: WorldAiFactor[]; confidence: number }
const clamp01 = (n: number) => Math.max(0, Math.min(1, n));
const round = (n: number, p = 2) => Math.round(n * 10 ** p) / 10 ** p;
const days = (from: string | Date, to: Date) => Math.round((to.getTime() - new Date(from).getTime()) / D);
const factor = (name: string, weight: number, value: string | number, contribution: number): WorldAiFactor => ({ factor: name, weight, value: String(value), contribution: round(contribution, 3) });

export function documentIntelligence(req: WorldServiceRequest, def: WorldServiceDefinition | undefined, vessel: WorldVessel | undefined, certs: WorldVesselCertificate[], now: Date): Judgement {
  const required = def?.requiredDocuments ?? []; const byKey = new Map(req.documents.map((d) => [d.key, d]));
  const missing = required.filter((r) => r.mandatory && !byKey.has(r.key)); const present = required.filter((r) => byKey.has(r.key)); const unverified = present.filter((r) => !byKey.get(r.key)!.verified);
  const completeness = required.length ? present.length / required.length : 1; const verifiedShare = present.length ? (present.length - unverified.length) / present.length : 1;
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  if (vessel) checks.push({ name: 'IMO check digit', ok: imoCheck(vessel.imo.slice(0, 6)) === vessel.imo[6], detail: vessel.imo });
  if (certs.length) checks.push({ name: 'Date coherence', ok: certs.every((c) => c.issueDate <= c.expiryDate && c.issueDate <= iso(now)), detail: `${certs.length} certificates read` });
  const failed = checks.filter((c) => !c.ok); const integrity = checks.length ? (checks.length - failed.length) / checks.length : 1; const clean = !missing.length && !failed.length;
  return { action: clean ? 'Validated the submitted documents' : 'Flagged a document problem', subjectType: 'ServiceRequest', subjectId: req.id, subjectLabel: req.requestNo, inputs: { service: req.serviceCode, requiredDocuments: required.length, lodged: req.documents.length },
    output: { complete: !missing.length, missing: missing.map((m) => m.label), unverified: unverified.map((u) => u.label), failedChecks: failed.map((c) => `${c.name}: ${c.detail}`) },
    explanation: clean ? `All ${required.length} required documents are on file and every integrity check passed.${unverified.length ? ` ${unverified.length} document(s) await verification.` : ''}`
      : [missing.length ? `${missing.length} mandatory document(s) missing: ${missing.map((m) => m.label).join(', ')}` : '', failed.length ? `${failed.length} integrity check(s) failed: ${failed.map((c) => c.name).join(', ')}` : ''].filter(Boolean).join('. '),
    factors: [factor('Required documents present', 0.45, `${present.length}/${required.length}`, 0.45 * completeness), factor('Documents verified', 0.25, `${present.length - unverified.length}/${present.length}`, 0.25 * verifiedShare), factor('Integrity checks passed', 0.3, `${checks.length - failed.length}/${checks.length}`, 0.3 * integrity)],
    confidence: round(clamp01(0.45 * completeness + 0.25 * verifiedShare + 0.3 * integrity), 3) };
}
export function vesselCompliance(v: WorldVessel, certs: WorldVesselCertificate[], inspections: WorldInspection[], instruments: WorldLicence[], now: Date): Judgement {
  const w = DEFAULT_RISK_WEIGHTS; const age = now.getUTCFullYear() - v.built;
  const expired = certs.filter((c) => c.state === 'EXPIRED').length; const expiring = certs.filter((c) => c.state === 'EXPIRING').length;
  const findings = inspections.reduce((t, i) => t + i.findings.length, 0); const detentions = inspections.filter((i) => i.result === 'DETAINED').length;
  const last = inspections.map((i) => i.startedAt ?? i.plannedAt).sort().pop(); const gapDays = last ? days(last, now) : 400;
  const notInForce = instruments.map((i) => ({ i, f: forceState(i, now) })).filter((x) => !x.f.inForce);
  const parts: [string, number, string, number][] = [['Vessel age', w.age, `${age} yrs`, clamp01(age / 25)], ['Certificate standing', w.certificates, `${expired} expired · ${expiring} expiring`, certs.length ? clamp01((expired + expiring * 0.4) / certs.length) : 0.5],
    ['Deficiency history', w.deficiencies, `${findings} across ${inspections.length} inspections`, inspections.length ? clamp01(findings / (inspections.length * 5)) : 0], ['Detentions', w.detentions, String(detentions), inspections.length ? clamp01((detentions / inspections.length) * 3) : 0],
    ['Inspection gap', w.inspectionGap, `${gapDays} days`, clamp01(gapDays / 365)], ['Instruments not in force', w.agentPerformance, `${notInForce.length}/${instruments.length}`, instruments.length ? clamp01(notInForce.length / instruments.length) : 0]];
  const score = Math.round(parts.reduce((t, p) => t + p[1] * p[3], 0)); const band = score >= 60 ? 'HIGH' : score >= 35 ? 'MEDIUM' : 'LOW';
  const evidence = clamp01((inspections.length / 6) * 0.5 + (certs.length / 8) * 0.3 + (instruments.length ? 0.2 : 0)); // confidence reflects how much evidence stood behind the score, not the arithmetic
  return { action: notInForce.length ? 'Flagged a certificate not in force' : 'Rescored vessel compliance', subjectType: 'Vessel', subjectId: v.id, subjectLabel: `${v.name} (IMO ${v.imo})`, inputs: { certificates: certs.length, inspections: inspections.length, instruments: instruments.length },
    output: { score, band, expired, expiring, notInForce: notInForce.map((x) => `${x.i.entityType}: ${x.f.reason}`) },
    explanation: notInForce.length ? `${notInForce.length} instrument(s) are not in force — ${notInForce[0].f.reason}. Composite compliance risk ${score}/100 (${band.toLowerCase()}).` : `Composite compliance risk ${score}/100 (${band.toLowerCase()}) from ${inspections.length} inspections and ${certs.length} certificates.`,
    factors: parts.map((p) => factor(p[0], p[1], p[2], p[1] * p[3])), confidence: round(0.55 + 0.4 * evidence, 3) };
}
export function serviceProcessing(req: WorldServiceRequest, def: WorldServiceDefinition | undefined, subjectOnRecord: boolean, priors: number): Judgement {
  const gates: { gate: string; passed: boolean; detail: string }[] = []; const push = (gate: string, passed: boolean, detail: string) => gates.push({ gate, passed, detail });
  const required = def?.requiredDocuments ?? []; const byKey = new Map(req.documents.map((d) => [d.key, d]));
  const missing = required.filter((r) => r.mandatory && !byKey.has(r.key)); push('Mandatory documents on file', missing.length === 0, missing.length ? `missing ${missing.map((m) => m.label).join(', ')}` : `${required.length} on file`);
  const unverified = required.filter((r) => byKey.has(r.key) && !byKey.get(r.key)!.verified); push('Documents verified', unverified.length === 0, unverified.length ? `${unverified.length} awaiting verification` : 'all verified');
  push('Subject on record', subjectOnRecord, subjectOnRecord ? req.subjectLabel : 'subject not found on the register');
  push('Fee settled', req.fee.paid || !def?.fee.amount, req.fee.paid ? 'paid' : def?.fee.amount ? 'outstanding' : 'no fee');
  push('No open compliance hold', true, 'none');
  const firstTime = priors === 0; push('Applicant has prior history', !firstTime, firstTime ? 'first application from this applicant' : `${priors} prior applications`);
  const blocking = gates.filter((g) => !g.passed && g.gate !== 'Applicant has prior history'); const passedCount = gates.filter((g) => g.passed).length;
  return { action: blocking.length ? 'Held an application at a gate' : 'Adjudicated an application as eligible', subjectType: 'ServiceRequest', subjectId: req.id, subjectLabel: `${req.requestNo} — ${req.serviceName}`, inputs: { service: req.serviceCode, status: req.status, stage: req.currentStage },
    output: { eligible: blocking.length === 0, gates, recommendation: blocking.length ? 'ESCALATE' : 'APPROVE' },
    explanation: blocking.length ? `Held at ${blocking.length} gate(s): ${blocking.map((g) => `${g.gate} — ${g.detail}`).join('; ')}.` : `All ${gates.length} eligibility gates pass${firstTime ? ', but this is a first-time applicant so it is put to an officer' : ' — eligible for zero-touch issue'}.`,
    factors: gates.map((g) => factor(g.gate, round(1 / gates.length, 2), g.passed ? 'pass' : 'fail', g.passed ? 1 / gates.length : 0)), confidence: round(clamp01(passedCount / gates.length - (firstTime ? 0.15 : 0)), 3) };
}
export function customerGuidance(req: WorldServiceRequest, def: WorldServiceDefinition | undefined, now: Date): Judgement {
  const stages = def?.stages ?? []; const idx = stages.findIndex((s) => s.key === req.currentStage); const next = idx >= 0 && idx < stages.length - 1 ? stages[idx + 1] : null;
  const sla = def?.slaDays ?? 0; const elapsed = days(req.submittedAt ?? req.createdAt, now); const remaining = sla ? sla - elapsed : null;
  const byKey = new Map(req.documents.map((d) => [d.key, d])); const outstanding = (def?.requiredDocuments ?? []).filter((r) => r.mandatory && !byKey.has(r.key)).map((r) => r.label);
  const message = req.status === 'ISSUED' ? `Your ${req.serviceName} has been issued. The instrument is on the register and can be verified publicly.`
    : req.status === 'REJECTED' ? `This application was refused. ${req.decision?.reason || 'The reason is recorded on the file.'}`
      : outstanding.length ? `We are waiting on ${outstanding.length} document(s): ${outstanding.join(', ')}. The application resumes as soon as they are lodged.`
        : `Your application is at the ${req.currentStage || 'first'} stage${next ? `, and moves to ${next.label} next` : ''}.${remaining != null ? ` The service level allows ${sla} days; ${remaining >= 0 ? `${remaining} remain` : `it is ${-remaining} days over`}.` : ''}`;
  return { action: req.status === 'INFO_REQUESTED' || outstanding.length ? 'Told an applicant what is outstanding' : 'Answered an application status enquiry', subjectType: 'ServiceRequest', subjectId: req.id, subjectLabel: req.requestNo,
    inputs: { status: req.status, stage: req.currentStage, slaDays: sla, elapsedDays: elapsed }, output: { message, outstanding, nextStage: next?.label ?? null, slaRemainingDays: remaining }, explanation: message,
    factors: [factor('Application state known', 0.4, req.status, 0.4), factor('Service definition matched', 0.3, def?.code ?? 'none', def ? 0.3 : 0), factor('Outstanding items identified', 0.3, String(outstanding.length), 0.3)], confidence: round(def ? 0.92 : 0.55, 3) };
}
export function smartInspection(v: WorldVessel, certs: WorldVesselCertificate[], inspections: WorldInspection[], instruments: WorldLicence[], now: Date): Judgement {
  const compliance = vesselCompliance(v, certs, inspections, instruments, now); const score = compliance.output.score as number; const band = String(compliance.output.band);
  const counts = new Map<string, number>(); inspections.forEach((i) => i.findings.forEach((f) => counts.set(f.deficiencyCode, (counts.get(f.deficiencyCode) ?? 0) + 1)));
  const predicted = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([code, n]) => ({ code, priorOccurrences: n }));
  const last = inspections.map((i) => i.startedAt ?? i.plannedAt).sort().pop(); const gapDays = last ? days(last, now) : 400; const target = score >= 55 || gapDays > 180;
  return { action: target ? 'Selected a vessel for boarding' : 'Assessed a vessel as not requiring boarding', subjectType: 'Vessel', subjectId: v.id, subjectLabel: `${v.name} (IMO ${v.imo})`, inputs: { priorInspections: inspections.length, daysSinceLast: gapDays },
    output: { board: target, riskScore: score, band, predictedDeficiencies: predicted, dossier: { vessel: v.name, imo: v.imo, flag: v.flag, type: v.type, built: v.built, classSociety: v.classSociety, expiredCertificates: compliance.output.expired, openFindings: inspections.reduce((t, i) => t + i.findings.filter((f) => f.status === 'OPEN').length, 0) } },
    explanation: target ? `Boarding recommended: risk ${score}/100 (${band.toLowerCase()}), ${gapDays} days since the last inspection.${predicted.length ? ` Prior history points at ${predicted.map((p) => p.code).join(', ')}.` : ''}` : `No boarding recommended: risk ${score}/100 and inspected ${gapDays} days ago.`,
    factors: [...compliance.factors, factor('Time since last inspection', 10, `${gapDays} days`, clamp01(gapDays / 365) * 10)], confidence: round(clamp01(0.5 + (inspections.length / 8) * 0.45), 3) };
}
const STOP = new Set(['the', 'of', 'and', 'for', 'a', 'an', 'in', 'on', 'at', 'to', 'by', 'port', 'vessel', 'ship']);
// abbreviations are short enough to match inside ordinary words, so only whole words longer than three letters count
const overlapWords = (a: string, b: string) => { const norm = (s: string) => new Set(s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3 && !STOP.has(w))); const A = norm(a); const B = norm(b); let n = 0; A.forEach((w) => { if (B.has(w)) n += 1; }); return n; };
export function regulatoryIntelligence(instrument: WorldLegalInstrument, all: WorldLegalInstrument[], services: WorldServiceDefinition[], now: Date): Judgement {
  const replaced = all.filter((i) => instrument.supersedes && i.refNo === instrument.supersedes); const replacedBy = all.filter((i) => i.supersedes === instrument.refNo);
  const sameSubject = all.filter((i) => i.id !== instrument.id && i.status === 'IN_FORCE' && i.type === instrument.type && i.category === instrument.category && overlapWords(i.title, instrument.title) >= 2);
  const affected = services.filter((s) => overlapWords(s.name, instrument.title) >= 1 || instrument.tags.some((t) => s.code.toLowerCase().includes(t.toLowerCase())));
  const ageDays = days(instrument.effectiveDate ?? instrument.issuedDate, now); const isNew = ageDays >= 0 && ageDays <= 30; const linked = replaced.length > 0 || replacedBy.length > 0;
  const conflict = sameSubject.length > 0 && !linked; const broken = instrument.status === 'SUPERSEDED' && replacedBy.length === 0; const ref = (i: WorldLegalInstrument) => i.refNo;
  return { action: conflict ? 'Flagged a possible regulatory conflict' : broken ? 'Flagged a superseded instrument with no replacement recorded' : isNew ? 'Analysed a newly effective instrument' : 'Reviewed an instrument in force',
    subjectType: 'Instrument', subjectId: instrument.id, subjectLabel: `${instrument.refNo} — ${instrument.title}`, inputs: { type: instrument.type, status: instrument.status, effectiveDate: instrument.effectiveDate },
    output: { newlyEffective: isNew, supersedes: replaced.map(ref), supersededBy: replacedBy.map(ref), possibleConflicts: sameSubject.map(ref), affectedServices: affected.map((s) => s.code), acknowledgementRequired: instrument.ackRequired },
    explanation: conflict ? `In force alongside ${sameSubject.length} other instrument(s) on the same subject with no supersession recorded — ${sameSubject.map(ref).join(', ')}. A gap or conflict may exist.`
      : broken ? 'Marked superseded but no replacing instrument names it, so the chain is broken and "which version applies?" cannot be answered from the register.'
        : `${isNew ? `Effective ${ageDays} days ago. ` : ''}${replaced.length ? `Supersedes ${replaced.map(ref).join(', ')}. ` : ''}${replacedBy.length ? `Superseded by ${replacedBy.map(ref).join(', ')}. ` : ''}Bears on ${affected.length} service(s)${affected.length ? `: ${affected.slice(0, 4).map((s) => s.code).join(', ')}` : ''}.`,
    factors: [factor('Recency', 0.3, `${ageDays} days`, isNew ? 0.3 : 0.1), factor('Supersession chain intact', 0.3, linked ? 'linked' : broken ? 'broken' : conflict ? 'not recorded' : 'none needed', linked ? 0.3 : broken || conflict ? 0 : 0.2),
      factor('Services affected', 0.25, String(affected.length), clamp01(affected.length / 4) * 0.25), factor('Competing instruments', 0.15, String(sameSubject.length), 0.15)],
    confidence: round(clamp01(0.55 + (affected.length ? 0.2 : 0) + (linked ? 0.15 : 0) + 0.1), 3) };
}
export function maritimeIntelligence(vessels: WorldVessel[], certs: WorldVesselCertificate[], incidents: WorldIncident[], inspections: WorldInspection[], now: Date): Judgement {
  const open = incidents.filter((i) => !['RESOLVED', 'CLOSED'].includes(i.status)); const severe = open.filter((i) => ['HIGH', 'CRITICAL'].includes(i.severity));
  const expiredCerts = certs.filter((c) => c.state === 'EXPIRED'); const vesselsWithExpired = new Set(expiredCerts.map((c) => c.vesselId)).size;
  const detentions90 = inspections.filter((i) => i.result === 'DETAINED' && days(i.startedAt ?? i.plannedAt, now) <= 90).length;
  const anomalies = [severe.length ? `${severe.length} open incident(s) at high or critical severity` : '', vesselsWithExpired ? `${vesselsWithExpired} vessel(s) carrying an expired certificate` : '', detentions90 >= 3 ? `${detentions90} detentions in the last 90 days` : ''].filter(Boolean);
  const level = severe.length >= 3 || detentions90 >= 5 ? 'ELEVATED' : anomalies.length ? 'WATCH' : 'NORMAL';
  return { action: level === 'NORMAL' ? 'Published the maritime situation report' : `Raised the maritime picture to ${level.toLowerCase()}`, subjectType: 'Situation', subjectId: 'national', subjectLabel: 'National maritime picture',
    inputs: { vessels: vessels.length, openIncidents: open.length, inspections: inspections.length }, output: { level, openIncidents: open.length, severeIncidents: severe.length, vesselsWithExpiredCertificates: vesselsWithExpired, expiredCertificates: expiredCerts.length, detentionsLast90Days: detentions90, anomalies },
    explanation: anomalies.length ? `Picture at ${level}: ${anomalies.join('; ')}.` : `Picture normal: ${open.length} open incidents, no certificate or detention concentrations.`,
    factors: [factor('Severe open incidents', 0.35, String(severe.length), clamp01(severe.length / 3) * 0.35), factor('Vessels with expired certificates', 0.35, String(vesselsWithExpired), clamp01(vesselsWithExpired / 5) * 0.35), factor('Recent detentions', 0.3, String(detentions90), clamp01(detentions90 / 5) * 0.3)],
    confidence: round(clamp01(0.7 + (vessels.length ? 0.2 : 0) + (inspections.length ? 0.1 : 0)), 3) };
}

/** The roster with its autonomy settings, and a decision register: the analytics workforce round-robin plus the seven mandated agents run over the world's own records. */
export function buildAgents(rng: Prng, profile: string, ctx: AgentContext, now: Date): { agentConfigs: WorldAgentConfig[]; aiDecisions: WorldAiDecision[] } {
  const j = getJurisdiction(profile); const ae = j.code === 'AE';
  const agentConfigs: WorldAgentConfig[] = AGENT_DEFS.map(([agentId, name, nameAr, role, domain, autonomyLevel, confidenceThreshold, cadence, cron]) => ({
    id: stableId('agent', agentId), agentId, name, nameAr: ae ? nameAr : undefined, role, domain, enabled: true, autonomyLevel, confidenceThreshold, maxActionsPerHour: 100, escalateTo: 'agents.review',
    schedule: { cadence, cron, timezone: j.timezone }, suspended: false, suspendedReason: '', suspendedBy: '', suspendedAt: null, stats: { decisions: 0, autoApplied: 0, escalated: 0, overridden: 0, avgConfidence: 0, lastRunAt: null },
    // latitude moves in both directions: an agent that has earned it is widened, one whose decisions carry statutory weight is narrowed back
    changes: [autonomyLevel === 'SUPERVISED' ? { field: 'autonomyLevel', from: 'ASSISTED', to: 'SUPERVISED', at: iso(now.getTime() - rng.int(30, 200) * D), by: 'AI Governance Committee', reason: 'Narrowed pending review — decisions in this class carry statutory consequence' }
      : { field: 'autonomyLevel', from: 'SUPERVISED', to: autonomyLevel, at: iso(now.getTime() - rng.int(30, 200) * D), by: 'AI Governance Committee', reason: 'Raised after accuracy review — agreement rate sustained above target' }],
  }));
  const byId = new Map(agentConfigs.map((c) => [c.agentId, c])); const reviewers = ctx.users.filter((u) => ['Super Admin', 'Harbour Master', 'Registrar of Ships'].includes(u.roleName) && u.login);
  const aiDecisions: WorldAiDecision[] = [];
  const record = (agentId: string, jd: Judgement, at: Date, modelId: string) => {
    const cfg = byId.get(agentId)!; const i = aiDecisions.length;
    const disposition: Disposition = cfg.autonomyLevel === 'AUTONOMOUS' ? 'AUTO_APPLIED' : cfg.autonomyLevel === 'ASSISTED' ? (jd.confidence >= cfg.confidenceThreshold ? 'AUTO_APPLIED' : 'ESCALATED') : i % 7 === 0 ? 'AWAITING_REVIEW' : i % 11 === 0 ? 'OVERRIDDEN' : 'APPROVED_BY_HUMAN';
    const reviewer = disposition === 'APPROVED_BY_HUMAN' || disposition === 'OVERRIDDEN' ? rng.pick(reviewers) : null;
    aiDecisions.push({ id: stableId('decision', `${agentId}:${i}`), agentId, agentName: cfg.name, action: jd.action, subjectType: jd.subjectType, subjectId: jd.subjectId, subjectLabel: jd.subjectLabel, inputs: jd.inputs, output: jd.output, explanation: jd.explanation, factors: jd.factors,
      confidence: jd.confidence, autonomyLevel: cfg.autonomyLevel, threshold: cfg.confidenceThreshold, disposition, escalationReason: disposition === 'ESCALATED' ? `Confidence ${jd.confidence} below threshold ${cfg.confidenceThreshold}` : '',
      reviewedById: reviewer?.id ?? null, reviewedBy: reviewer?.name ?? '', reviewedAt: reviewer ? iso(Math.min(now.getTime(), at.getTime() + rng.int(1, 48) * H)) : null, overrideReason: disposition === 'OVERRIDDEN' ? 'Local works already accounted for the variance' : '',
      supersedesId: null, modelId, modelVersion: '2026-08', latencyMs: rng.int(400, 3200), at: iso(at) });
  };
  // the analytics workforce: every agent on the roster carries a decision history
  const roster = Object.keys(WORKFORCE_ACTION); const panels = ae ? ['CT-4', 'CT-1', 'West Basin', 'Liquid Terminal', 'Khalifa Port'] : ['CT3', 'CT1', 'CT4', 'West Basin', 'Port'];
  for (let i = 0; i < 180; i++) {
    const agentId = roster[i % roster.length]; const [action, explanation] = WORKFORCE_ACTION[agentId]; const confidence = Math.round((0.62 + rng.next() * 0.36) * 100) / 100;
    record(agentId, { action, subjectType: 'Panel', subjectId: '', subjectLabel: rng.pick(panels), inputs: { window: '12 months' }, output: { flagged: true }, explanation,
      factors: [factor('Deviation from baseline', 0.5, 'above', 0.5), factor('Persistence', 0.3, '3 consecutive weeks', 0.3), factor('Sample size', 0.2, 'sufficient', 0.2)], confidence }, new Date(now.getTime() - rng.int(1, 300) * D), 'panel-analytics');
  }
  // the seven mandated agents run over the records themselves — the gates that actually fired, the certificates actually found out of force, the boarding targets actually selected
  const defById = new Map(ctx.serviceDefinitions.map((d) => [d.id, d])); const vById = new Map(ctx.vessels.map((v) => [v.id, v])); const fleet = ctx.vessels.filter((v) => !v.real);
  const certsOf = (id: string) => ctx.vesselCertificates.filter((c) => c.vesselId === id); const inspOf = (id: string) => ctx.inspections.filter((i) => i.vesselId === id); const instOf = (id: string) => ctx.licences.filter((l) => l.subjectId === id && l.subjectKind === 'VESSEL');
  const recent = () => new Date(now.getTime() - rng.int(1, 72) * H);
  const open = ctx.serviceRequests.filter((r) => ['SUBMITTED', 'UNDER_ASSESSMENT', 'INFO_REQUESTED'].includes(r.status)).slice(0, 24);
  for (const r of open) { const v = r.subjectKind === 'VESSEL' && r.subjectId ? vById.get(r.subjectId) : undefined; record('a1_document_intelligence', documentIntelligence(r, defById.get(r.serviceId), v, v ? certsOf(v.id) : [], now), recent(), 'doc-intelligence'); }
  for (const v of fleet) record('a2_vessel_compliance', vesselCompliance(v, certsOf(v.id), inspOf(v.id), instOf(v.id), now), recent(), 'compliance-score');
  for (const r of open) record('a3_service_processing', serviceProcessing(r, defById.get(r.serviceId), !!r.subjectId, ctx.serviceRequests.filter((x) => x.id !== r.id && x.applicant.name === r.applicant.name).length), recent(), 'eligibility-gates');
  ctx.serviceRequests.filter((_, i) => i % 15 === 0).slice(0, 14).forEach((r) => record('a4_customer_guidance', customerGuidance(r, defById.get(r.serviceId), now), recent(), 'guidance'));
  for (const v of fleet) record('a5_smart_inspection', smartInspection(v, certsOf(v.id), inspOf(v.id), instOf(v.id), now), recent(), 'inspection-targeting');
  ctx.legalInstruments.filter((i) => i.type !== 'CONVENTION').slice(-22).forEach((i) => record('a6_regulatory_intelligence', regulatoryIntelligence(i, ctx.legalInstruments, ctx.serviceDefinitions, now), recent(), 'reg-intelligence'));
  record('a7_maritime_intelligence', maritimeIntelligence(fleet, ctx.vesselCertificates, ctx.incidents, ctx.inspections, now), new Date(now.getTime() - 20 * 60000), 'situation');
  for (const a of agentConfigs) { // roll the recorded dispositions into each agent's rolling stats
    const mine = aiDecisions.filter((d) => d.agentId === a.agentId);
    a.stats = { decisions: mine.length, autoApplied: mine.filter((d) => d.disposition === 'AUTO_APPLIED').length, escalated: mine.filter((d) => d.disposition === 'ESCALATED').length, overridden: mine.filter((d) => d.disposition === 'OVERRIDDEN').length,
      avgConfidence: mine.length ? Math.round((mine.reduce((s, d) => s + d.confidence, 0) / mine.length) * 1000) / 1000 : 0, lastRunAt: mine.map((d) => d.at).sort().pop() ?? null };
  }
  return { agentConfigs, aiDecisions: aiDecisions.sort((a, b) => a.at.localeCompare(b.at)) };
}
