import { describe, expect, it } from 'vitest';
import { LOOKUP_CATEGORIES } from '@maritime/contracts';
import { buildWorld, isRealLiner, imoCheck, forceState, certStatus, type World } from '../src';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/;
const now = new Date('2026-09-02T12:00:00Z');
const w = buildWorld({ profile: 'AE', now });
const SECTIONS = ['users', 'companies', 'berths', 'vessels', 'portCalls', 'vesselCertificates', 'tariffs', 'checklistTemplates', 'berthOutages', 'resources', 'invoices', 'inspections', 'seafarers', 'legalInstruments', 'licences', 'registrations',
  'serviceDefinitions', 'serviceRequests', 'agentConfigs', 'aiDecisions', 'incidents', 'positions', 'mdaAlerts', 'metInstitutions', 'metProgrammes', 'manningScales', 'crewLists', 'imoWatch'] as const;
const ids = (rows: { id: string }[]) => new Set(rows.map((r) => r.id));
const realIds = new Set(w.vessels.filter((v) => v.real).map((v) => v.id));

describe('world', () => {
  it('makes valid, unique UUIDs in every section', () => {
    for (const s of SECTIONS) { const rows = w[s] as { id: string }[]; expect(rows.length, s).toBeGreaterThan(0); for (const r of rows) expect(r.id, s).toMatch(UUID); expect(ids(rows).size, s).toBe(rows.length); }
  });
  it('is deterministic — two builds are deep-equal', () => { expect(buildWorld({ profile: 'AE', now })).toEqual(w); });
  it('seeds the nine login accounts, staff and a directory of about 130 users with unique emails', () => {
    expect(w.users.filter((u) => u.login)).toHaveLength(9);
    expect(w.users.length).toBeGreaterThanOrEqual(125);
    expect(new Set(w.users.map((u) => u.email)).size).toBe(w.users.length);
    expect(w.users.find((u) => u.email === 'admin@maritime.example')?.roleName).toBe('Super Admin');
    // the second pair of eyes on a model, without which no version can be approved and none can be deployed
    expect(w.users.find((u) => u.email === 'aigov@maritime.example')?.roleName).toBe('AI Governance');
  });
  it('covers every declared master, 24 berths, 20 companies and 31 vessels', () => {
    const categories = new Set(w.lookups.map((l) => l.category));
    expect(categories.size).toBe(LOOKUP_CATEGORIES.length);
    // every master the contract declares has entries, and no entry belongs to a master the contract does not know
    for (const c of LOOKUP_CATEGORIES) expect(categories.has(c.key), c.key).toBe(true);
    for (const cat of categories) expect(LOOKUP_CATEGORIES.some((c) => c.key === cat), cat).toBe(true);
    // one row per (category, code): the mirrors key on it
    expect(new Set(w.lookups.map((l) => `${l.category}:${l.code}`)).size).toBe(w.lookups.length);
    // the six RFP accreditation schemes and the MET institution scheme, each with a cycle
    const schemes = w.lookups.filter((l) => l.category === 'accreditationCategory');
    expect(schemes.map((s) => s.code).sort()).toEqual(['COMPASS_CALIBRATION', 'FFA_SERVICING', 'LSA_SERVICING', 'MET_INSTITUTION', 'PEST_CONTROL', 'SMALL_VESSEL_SURVEY', 'TOWAGE_CERTIFICATION']);
    for (const s of schemes) expect(s.meta).toMatchObject({ cycleMonths: 12, visitsPerCycle: 1 });
    expect(w.berths).toHaveLength(24); expect(w.companies).toHaveLength(20); expect(w.vessels).toHaveLength(31);
    expect(w.vessels.filter((v) => v.real)).toHaveLength(8);
    for (const v of w.vessels) expect(imoCheck(v.imo.slice(0, 6))).toBe(v.imo[6]);
  });
  it('produces multi-year port-call history plus a live snapshot', () => {
    expect(w.portCalls.length).toBeGreaterThan(900);
    expect(w.portCalls.filter((c) => c.status === 'BERTHED').length).toBeGreaterThan(5);
    expect(w.portCalls[0].eta < '2023-02-01').toBe(true);
    expect(isRealLiner('MSC Anna')).toBe(true);
  });
  it('keeps every foreign key resolvable', () => {
    const users = ids(w.users); const vessels = ids(w.vessels); const berths = ids(w.berths); const companies = ids(w.companies); const calls = ids(w.portCalls); const licences = ids(w.licences); const seafarers = ids(w.seafarers);
    const defs = ids(w.serviceDefinitions); const templates = ids(w.checklistTemplates); const agents = new Set(w.agentConfigs.map((a) => a.agentId)); const refNos = new Set(w.legalInstruments.map((i) => i.refNo));
    const subjects: Record<string, Set<string>> = { Company: companies, Vessel: vessels, Seafarer: seafarers, Berth: berths };
    const has = (set: Set<string>, id: string | null | undefined, what: string) => { if (id != null) expect(set.has(id), `${what} ${id}`).toBe(true); };
    for (const c of w.vesselCertificates) { has(vessels, c.vesselId, 'cert.vessel'); has(licences, c.instrumentId, 'cert.instrument'); }
    for (const t of w.tariffs) for (const r of t.revisions) expect(refNos.has(r.circular), r.circular).toBe(true);
    for (const o of w.berthOutages) has(berths, o.berthId, 'outage.berth');
    for (const r of w.resources) { has(users, r.userId, 'resource.user'); for (const j of r.jobs) has(calls, j.portCallId, 'job.call'); }
    for (const i of w.invoices) { has(calls, i.portCallId, 'invoice.call'); has(vessels, i.vesselId, 'invoice.vessel'); has(companies, i.billTo.companyId, 'invoice.billTo'); }
    for (const i of w.inspections) { has(vessels, i.vesselId, 'inspection.vessel'); has(calls, i.portCallId, 'inspection.call'); has(users, i.inspectorId, 'inspection.inspector'); has(templates, i.templateId, 'inspection.template'); }
    for (const s of w.seafarers) { has(vessels, s.currentVesselId, 'seafarer.vessel'); for (const ss of s.seaService) has(vessels, ss.vesselId, 'service.vessel'); }
    for (const i of w.legalInstruments) { has(users, i.draftedById, 'instrument.drafter'); has(users, i.approvedById, 'instrument.approver'); for (const a of i.acknowledgedBy) has(users, a.userId, 'ack.user'); if (i.supersedes) expect(refNos.has(i.supersedes), i.supersedes).toBe(true); }
    for (const l of w.licences) { if (l.subjectId) { expect(l.subjectModel).toBeTruthy(); has(subjects[l.subjectModel!], l.subjectId, `licence.subject ${l.subjectModel}`); } for (const a of l.audits) has(users, a.auditorId, 'audit.auditor'); }
    for (const r of w.registrations) { has(vessels, r.vesselId, 'registration.vessel'); has(users, r.assignedToId, 'registration.assignee'); }
    for (const r of w.registry) has(vessels, r.vesselId, 'registry.vessel');
    for (const r of w.serviceRequests) { has(defs, r.serviceId, 'request.service'); if (r.subjectId) has(subjects[r.subjectModel!], r.subjectId, 'request.subject'); has(licences, r.issuedInstrumentId, 'request.instrument'); has(users, r.applicant.userId, 'request.applicant'); has(users, r.assignedToId, 'request.assignee'); }
    const decisionSubjects = new Set([...vessels, ...ids(w.serviceRequests), ...ids(w.legalInstruments), 'national', '']);
    for (const d of w.aiDecisions) { expect(agents.has(d.agentId)).toBe(true); expect(decisionSubjects.has(d.subjectId), d.subjectId).toBe(true); has(users, d.reviewedById, 'decision.reviewer'); }
    for (const i of w.incidents) { has(vessels, i.vesselId, 'incident.vessel'); has(berths, i.berthId, 'incident.berth'); has(users, i.assignedToId, 'incident.assignee'); for (const t of i.tasks) has(users, t.assigneeId, 'task.assignee'); }
    for (const p of w.positions) has(vessels, p.vesselId, 'position.vessel');
    for (const a of w.mdaAlerts) { has(vessels, a.vesselId, 'alert.vessel'); has(users, a.acknowledgedById, 'alert.ack'); }
  });
  it('gives the documented liner callers clean records everywhere', () => {
    expect(realIds.size).toBe(8);
    for (const c of w.vesselCertificates.filter((c) => realIds.has(c.vesselId))) expect(c.state).toBe('VALID');
    expect(w.inspections.some((i) => realIds.has(i.vesselId))).toBe(false);
    expect(w.invoices.some((i) => realIds.has(i.vesselId))).toBe(false);
    expect(w.incidents.some((i) => i.vesselId && realIds.has(i.vesselId))).toBe(false);
    expect(w.mdaAlerts.some((a) => a.vesselId && realIds.has(a.vesselId))).toBe(false);
    expect(w.licences.some((l) => l.subjectId && realIds.has(l.subjectId))).toBe(false);
    expect(w.registrations.some((r) => realIds.has(r.vesselId))).toBe(false);
    expect(w.registry.some((r) => realIds.has(r.vesselId))).toBe(false);
    expect(w.serviceRequests.some((r) => r.subjectId && realIds.has(r.subjectId))).toBe(false);
    expect(w.aiDecisions.some((d) => realIds.has(d.subjectId))).toBe(false);
    expect(w.seafarers.some((s) => (s.currentVesselId && realIds.has(s.currentVesselId)) || s.seaService.some((x) => x.vesselId && realIds.has(x.vesselId)))).toBe(false);
  });
  it('keeps volumes within the expected ranges', () => {
    const between = (n: number, lo: number, hi: number, what: string) => { expect(n, what).toBeGreaterThanOrEqual(lo); expect(n, what).toBeLessThanOrEqual(hi); };
    between(w.vesselCertificates.length, 380, 420, 'certificates'); expect(w.tariffs).toHaveLength(11); expect(w.checklistTemplates).toHaveLength(8);
    between(w.berthOutages.length, 100, 250, 'outages'); expect(w.resources).toHaveLength(17); between(w.invoices.length, 600, 1100, 'invoices');
    between(w.inspections.length, 140, 230, 'inspections'); expect(w.seafarers).toHaveLength(150); between(w.legalInstruments.length, 55, 70, 'instruments');
    between(w.licences.length, 220, 330, 'licences'); between(w.registrations.length, 18, 24, 'registrations'); expect(w.registry).toHaveLength(23);
    between(w.serviceDefinitions.length, 75, 85, 'definitions'); between(w.serviceRequests.length, 170, 240, 'requests'); expect(w.agentConfigs).toHaveLength(16);
    between(w.aiDecisions.length, 260, 340, 'decisions'); between(w.incidents.length, 110, 125, 'incidents'); between(w.positions.length, 12, 40, 'positions'); expect(w.mdaAlerts).toHaveLength(44);
    const bad = w.vesselCertificates.filter((c) => c.state !== 'VALID').length / w.vesselCertificates.length; between(bad, 0.06, 0.14, 'expiring share');
    expect(w.seafarers.filter((s) => s.currentVesselId).length / w.seafarers.length).toBeCloseTo(0.55, 1);
    expect(w.seafarers.every((s) => s.seaService.length && s.seaService[s.seaService.length - 1].from < '2023-06-01')).toBe(true);
    const months = new Set(w.inspections.filter((i) => i.status === 'CLOSED').map((i) => i.startedAt!.slice(0, 7))); expect(months.size).toBeGreaterThanOrEqual(40);
    expect(w.incidents.filter((i) => !['RESOLVED', 'CLOSED'].includes(i.status)).length).toBeGreaterThanOrEqual(6);
  });
  it('keeps a MET register, a safe manning scale for every active ship and FAL-5 crew lists that read the masters', () => {
    const rankCodes = new Set(w.lookups.filter((l) => l.category === 'seafarerRank').map((l) => l.code));
    const programmes = new Set(w.lookups.filter((l) => l.category === 'metProgramme').map((l) => l.code));
    const sources = new Set(w.lookups.filter((l) => l.category === 'crewListSource').map((l) => l.code));
    const areas = new Set(w.lookups.filter((l) => l.category === 'tradingArea').map((l) => l.code));
    // one provider per company licensed as a training institute; the academy holds the accreditation instrument, the short-course centre does not
    expect(w.metInstitutions).toHaveLength(2);
    expect(w.metInstitutions.filter((m) => m.accreditationInstrumentNo).length).toBe(1);
    for (const m of w.metInstitutions) expect(w.companies.some((c) => c.id === m.companyId)).toBe(true);
    for (const p of w.metProgrammes) { expect(programmes.has(p.programme), p.programme).toBe(true); expect(w.metInstitutions.some((m) => m.id === p.institutionId)).toBe(true); if (p.status === 'APPROVED') expect(p.approvalNo).toBeTruthy(); }
    expect(new Set(w.metProgrammes.map((p) => p.status))).toEqual(new Set(['APPROVED', 'PENDING', 'SUSPENDED', 'WITHDRAWN']));
    // every active fictional ship carries a scale; the ranks and the trading area are master codes
    expect(w.manningScales).toHaveLength(w.vessels.filter((v) => !v.real && v.status === 'ACTIVE').length);
    for (const s of w.manningScales) { expect(areas.has(s.tradingArea)).toBe(true); expect(s.rows.length).toBeGreaterThan(5); for (const r of s.rows) { expect(rankCodes.has(r.rankCode), r.rankCode).toBe(true); expect(r.count).toBeGreaterThan(0); } }
    expect(w.manningScales.filter((s) => s.msmdNo).length).toBeGreaterThan(0);
    // crew lists: recent calls only, every row a master rank, register people carry their id, and the same foreign crew comes back on the same ship
    expect(w.crewLists.length).toBeGreaterThanOrEqual(20);
    const seafarerIds = ids(w.seafarers);
    for (const l of w.crewLists) {
      expect(sources.has(l.source)).toBe(true); expect(w.portCalls.some((p) => p.vcn === l.vcn)).toBe(true); expect(l.rows.length).toBeGreaterThan(5);
      for (const r of l.rows) { expect(rankCodes.has(r.rankCode), `${l.vcn} ${r.rank}`).toBe(true); if (r.seafarerId) expect(seafarerIds.has(r.seafarerId)).toBe(true); expect(r.idNumber).toBeTruthy(); }
    }
    const foreignKeys = w.crewLists.flatMap((l) => l.rows.filter((r) => !r.seafarerId).map((r) => r.idNumber));
    expect(new Set(foreignKeys).size).toBeLessThan(foreignKeys.length);
    expect(w.crewLists.some((l) => l.declaredCrew !== l.rows.length)).toBe(true);
  });
  it('bills with the reference invoice maths and the jurisdiction tax', () => {
    for (const i of w.invoices) {
      expect(i.taxName).toBe('VAT'); expect(i.taxRatePct).toBe(5); expect(i.currency).toBe('AED'); expect(i.billTo.taxIdLabel).toBe('TRN'); expect(i.billTo.taxId).toContain('(sample)');
      expect(Math.round((i.subtotal + i.taxAmount) * 100)).toBe(Math.round(i.total * 100));
      expect(Math.round(i.lines.reduce((s, l) => s + Math.round(l.amount * 100), 0))).toBe(Math.round(i.subtotal * 100));
      for (const l of i.lines) expect(l.amount).toBe(Math.round(l.qty * l.rate * 100) / 100);
      if (i.status === 'PAID') expect(i.paidAt).toBeTruthy(); if (i.status === 'DRAFT') expect(i.issuedAt).toBeNull();
    }
    expect(new Set(w.invoices.map((i) => i.status))).toEqual(new Set(['DRAFT', 'ISSUED', 'PAID', 'CANCELLED']));
    expect(w.invoices.every((i) => i.number.startsWith('MAR/INV/'))).toBe(true);
  });
  it('runs the statutory survey regime so a few certificates are not in force, and mirrors them onto the ships', () => {
    const statutory = w.licences.filter((l) => l.endorsements.length || l.entityType === 'DOCUMENT_OF_COMPLIANCE');
    expect(statutory.length).toBeGreaterThan(80);
    const notInForce = statutory.filter((l) => !forceState(l, now).inForce);
    expect(notInForce.length).toBeGreaterThanOrEqual(1); expect(notInForce.length).toBeLessThan(statutory.length * 0.2);
    expect(w.licences.some((l) => l.endorsements.some((e) => e.kind === 'RENEWAL'))).toBe(true);
    expect(w.licences.every((l) => l.signature === null)).toBe(true);
    const mirrored = w.vesselCertificates.filter((c) => c.instrumentId); expect(mirrored.length).toBeGreaterThan(60);
    for (const c of mirrored) { const l = w.licences.find((x) => x.id === c.instrumentId)!; expect(c.number).toBe(l.licenseNo); expect(c.expiryDate).toBe(l.expiryDate); }
    expect(certStatus(new Date(now.getTime() - 1), now)).toBe('EXPIRED');
  });
  it('keeps the registers coherent', () => {
    expect(w.registry.filter((r) => r.state === 'REGISTERED')).toHaveLength(14); expect(w.registry.filter((r) => r.state === 'PROVISIONAL')).toHaveLength(1);
    const numbers = w.registrations.filter((r) => r.officialNumber).map((r) => Number(r.officialNumber)); expect(new Set(numbers).size).toBe(numbers.length); expect(Math.min(...numbers)).toBe(700001);
    expect(new Set(w.registrations.map((r) => r.kind))).toEqual(new Set(['PERMANENT', 'PROVISIONAL', 'AMENDMENT', 'DELETION']));
    expect(w.registrations.filter((r) => r.kind === 'DELETION' && r.status === 'APPROVED').every((r) => !w.invoices.some((i) => i.vesselId === r.vesselId && i.status === 'ISSUED'))).toBe(true);
    for (const r of w.serviceRequests.filter((x) => x.status === 'ISSUED')) expect(r.issuedInstrumentId).toBeTruthy();
    for (const i of w.legalInstruments) { if (i.status !== 'DRAFT') expect(i.approvedById).not.toBe(i.draftedById); else expect(i.approvedById).toBeNull(); }
    expect(w.legalInstruments.filter((i) => i.ackRequired).every((i) => i.acknowledgedBy.length > 0)).toBe(true);
    expect(w.legalInstruments.every((i) => i.titleAr)).toBe(true); expect(w.serviceDefinitions.every((d) => d.nameAr)).toBe(true);
    expect(w.seafarers.every((s) => s.cdcNo && s.seafarerId && s.nationalId.endsWith('(sample)'))).toBe(true);
    expect(w.resources.filter((r) => r.type === 'PILOT').every((r) => r.userId)).toBe(true); expect(w.resources.reduce((s, r) => s + r.jobs.length, 0)).toBeGreaterThan(5000);
    expect(new Set(w.aiDecisions.map((d) => d.disposition)).size).toBeGreaterThanOrEqual(4); expect(w.agentConfigs.every((a) => a.stats.decisions > 0)).toBe(true);
    expect(w.positions.some((p) => p.navStatus === 'RESTRICTED')).toBe(true); expect(w.mdaAlerts.filter((a) => !a.acknowledged)).toHaveLength(6);
  });
  it('switches jurisdiction by profile and still builds every section for IN', () => {
    const inw: World = buildWorld({ profile: 'IN', now });
    expect(inw.settings.find((s) => s.key === 'billing')?.value.taxName).toBe('GST');
    expect(w.settings.find((s) => s.key === 'billing')?.value.taxName).toBe('VAT');
    for (const s of SECTIONS) expect((inw[s] as unknown[]).length, s).toBeGreaterThan(0);
    expect(inw.invoices[0].taxRatePct).toBe(18); expect(inw.invoices[0].currency).toBe('INR'); expect(inw.invoices[0].number.startsWith('REF/INV/')).toBe(true);
    expect(inw.registry.filter((r) => r.state === 'REGISTERED')).toHaveLength(14); expect(Math.min(...inw.registrations.filter((r) => r.officialNumber).map((r) => Number(r.officialNumber)))).toBe(900001);
    expect(inw.legalInstruments.some((i) => i.refNo === 'MSA-1958')).toBe(true); expect(inw.legalInstruments.every((i) => i.titleAr === undefined)).toBe(true);
    expect(inw.seafarers.every((s) => s.seafarerIdLabel === 'INDoS')).toBe(true);
    expect(inw.companies.every((c) => c.nameAr === undefined)).toBe(true);
  });

  it('places every seafarer with a licensed manning agency, or names none at all', () => {
    // The register partitions on the recruitment and placement service, so the world has to state one — and
    // has to state more than one agency, or "an agency sees its own crew" is indistinguishable from national.
    const agencies = w.companies.filter((c) => c.types.includes('MANNING_AGENCY')).map((c) => c.code);
    expect(agencies.length).toBeGreaterThan(1);
    const placed = w.seafarers.filter((s) => s.manningAgentCode);
    const direct = w.seafarers.filter((s) => !s.manningAgentCode);
    expect(placed.length).toBeGreaterThan(direct.length);
    expect(direct.length, 'no seafarer is engaged directly, which is the other lawful route').toBeGreaterThan(0);
    for (const s of placed) {
      expect(agencies, `${s.name} names an agency that is not licensed`).toContain(s.manningAgentCode);
      expect(s.manningAgentName).toBeTruthy();
    }
    // every agency actually holds placements, so no reader is scoped to an empty set by accident
    for (const code of agencies) expect(placed.filter((s) => s.manningAgentCode === code).length, code).toBeGreaterThan(0);
  });

  it('gives the two external logins disjoint tenancies', () => {
    const agent = w.users.find((u) => u.email === 'agent@maritime.example')!;
    const crewing = w.users.find((u) => u.email === 'crewing@maritime.example')!;
    expect(agent.scope).toEqual({ level: 'COMPANY', companies: ['GSS'] });
    expect(crewing.scope).toEqual({ level: 'COMPANY', companies: ['MCA'] });
    expect(crewing.roleName).toBe('Manning Agent');
    // the manning agency the demo signs in as is one that actually placed somebody
    expect(w.seafarers.filter((s) => s.manningAgentCode === 'MCA').length).toBeGreaterThan(0);
  });
  /* Bilingual search is only as good as the register behind it. The Arabic analysis chain, the trigram
   * index and the search seam were all in place while `name_ar` was null on every company row, so a
   * search in Arabic matched nothing and the failure was invisible — the query was correct, the data
   * was empty. This holds the data. */
  it('carries an Arabic name on every company and berth of the Emirati register', () => {
    const arabic = /^[\u0600-\u06FF\u0750-\u077F0-9\s\u060C\u061F.\u0640\u2014\u2013-]+$/;
    expect(w.companies).toHaveLength(20);
    for (const c of w.companies) {
      expect(c.nameAr, c.code).toBeTruthy();
      expect(arabic.test(c.nameAr!), `${c.code}: ${c.nameAr}`).toBe(true);
    }
    for (const b of w.berths) {
      expect(b.nameAr, b.code).toBeTruthy();
      expect(arabic.test(b.nameAr), `${b.code}: ${b.nameAr}`).toBe(true);
    }
    // distinct names, so a search does not collapse the estate into one result
    expect(new Set(w.companies.map((c) => c.nameAr)).size).toBe(w.companies.length);
    expect(new Set(w.berths.map((b) => b.nameAr)).size).toBe(w.berths.length);
  });
});
