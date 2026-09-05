import { getJurisdiction, VESSEL_STATUTORY_CERT_TYPES, COMPANY_STATUTORY_CERT_TYPES, ENDORSEMENT_KINDS, ENDORSEMENT_RESULTS, instrumentClassOf, numberPrefixOf, validityMonthsOf, type SubjectKind, type InstrumentClass, type LicenseStatus } from '@maritime/contracts';
import { Prng, D, HIST_START, MONTH, stableId, iso, yearOf, makeSeries, addMonths } from './prng';
import { check, hist, type WorldCheck, type WorldHistoryEntry } from './common';
import type { WorldUser } from './people';
import type { WorldCompany, WorldBerth } from './organisations';
import type { WorldVessel } from './vessels';
import { isOfficerRank, type WorldSeafarer } from './crew';
import type { WorldRegistryEntry } from './registry';

export type EndorsementKind = (typeof ENDORSEMENT_KINDS)[number];
export type EndorsementResult = (typeof ENDORSEMENT_RESULTS)[number];
export interface WorldLicenceAudit { date: string; auditorId: string | null; auditor: string; result: 'SATISFACTORY' | 'OBSERVATIONS' | 'NON_CONFORMITY'; remarks: string }
export interface WorldEndorsement { kind: EndorsementKind; anniversary: string; completedOn: string; surveyor: string; organisation: string; place: string; result: EndorsementResult; remarks: string }
/** One regulated-instrument record, whatever it is issued against. The signature is left null: signing happens in the instruments service at issue. */
export interface WorldLicence {
  id: string; licenseNo: string; subjectKind: SubjectKind; subjectId: string | null; subjectModel: 'Company' | 'Vessel' | 'Seafarer' | 'Berth' | null; instrumentClass: InstrumentClass;
  entityName: string; entityType: string; typeLabel: string; typeLabelAr?: string; status: LicenseStatus; issueChecks: WorldCheck[]; contactPerson: string; phone: string; email: string; address: string; taxId: string;
  /* Who holds the instrument, as a code rather than a name. `entityName` says what it is issued against —
   * a ship, a seafarer, a berth — which is not the same question. A seafarer's certificate is held by the
   * seafarer and by no company, so this is empty there, and empty means nobody rather than everybody. */
  holderCode: string;
  appliedDate: string; issueDate: string | null; expiryDate: string | null; conditions: string; performanceRating: number; audits: WorldLicenceAudit[]; endorsements: WorldEndorsement[]; signature: null; history: WorldHistoryEntry[];
}

/** English and Arabic labels for every instrument type the engine issues. */
export const INSTRUMENT_TYPE_LABEL: Record<string, [string, string]> = {
  CARGO_SHIP_SAFETY_CONSTRUCTION: ['Cargo Ship Safety Construction Certificate', 'شهادة سلامة بناء سفينة البضائع'], CARGO_SHIP_SAFETY_EQUIPMENT: ['Cargo Ship Safety Equipment Certificate', 'شهادة سلامة معدات سفينة البضائع'],
  CARGO_SHIP_SAFETY_RADIO: ['Cargo Ship Safety Radio Certificate', 'شهادة سلامة الراديو لسفينة البضائع'], INTERNATIONAL_LOAD_LINE: ['Load Line Certificate', 'شهادة خط الشحن'], IOPP_CERTIFICATE: ['IOPP Certificate', 'الشهادة الدولية لمنع التلوث الزيتي'],
  IAPP_CERTIFICATE: ['IAPP Certificate', 'الشهادة الدولية لمنع تلوث الهواء'], SEWAGE_POLLUTION_PREVENTION: ['ISPP Certificate', 'الشهادة الدولية لمنع التلوث بمياه الصرف'], SAFETY_MANAGEMENT_CERTIFICATE: ['Safety Management Certificate', 'شهادة الإدارة الآمنة'],
  SHIP_SECURITY_CERTIFICATE: ['International Ship Security Certificate', 'الشهادة الدولية لأمن السفينة'], MARITIME_LABOUR_CERTIFICATE: ['Maritime Labour Certificate', 'شهادة العمل البحري'], TONNAGE_CERTIFICATE: ['Tonnage Certificate', 'شهادة الحمولة'],
  MINIMUM_SAFE_MANNING_DOCUMENT: ['Minimum Safe Manning Document', 'وثيقة الحد الأدنى للتطقيم الآمن'], CIVIL_LIABILITY_CERTIFICATE: ['Civil Liability (CLC) Certificate', 'شهادة المسؤولية المدنية عن أضرار التلوث الزيتي'], CONTINUOUS_SYNOPSIS_RECORD: ['Continuous Synopsis Record', 'السجل الموجز المستمر'],
  EXEMPTION_CERTIFICATE: ['Exemption Certificate', 'شهادة إعفاء'], CERTIFICATE_OF_OWNERSHIP: ['Certificate of Ownership', 'شهادة الملكية'], BALLAST_WATER_MANAGEMENT: ['Ballast Water Management Certificate', 'شهادة إدارة مياه الصابورة'],
  ANTI_FOULING_SYSTEM: ['Anti-Fouling System Certificate', 'شهادة نظام مكافحة الحشف'], BUNKER_LIABILITY_CERTIFICATE: ['Bunker Civil Liability Certificate', 'شهادة المسؤولية المدنية عن تلوث زيت الوقود'], WRECK_REMOVAL_LIABILITY: ['Wreck Removal Liability Certificate', 'شهادة المسؤولية عن إزالة الحطام'],
  DOCUMENT_OF_COMPLIANCE: ['Document of Compliance', 'وثيقة الامتثال'],
  NAVIGATION_LICENCE: ['Navigation Licence', 'رخصة الملاحة'], FOREIGN_VESSEL_PERMIT: ['Foreign Vessel Permit', 'تصريح سفينة أجنبية'], VESSEL_NOC: ['Vessel Movement No Objection Certificate', 'شهادة عدم ممانعة لحركة السفينة'],
  CERTIFICATE_OF_COMPETENCY: ['Certificate of Competency', 'شهادة الكفاءة'], CERTIFICATE_OF_PROFICIENCY: ['Certificate of Proficiency', 'شهادة الإتقان'], FLAG_STATE_ENDORSEMENT: ['Flag State Endorsement', 'اعتماد دولة العلم'],
  CERTIFICATE_OF_RECEIPT_OF_APPLICATION: ['Certificate of Receipt of Application', 'شهادة استلام الطلب'], SEAMAN_CARD: ['Seafarer Identity Card', 'بطاقة هوية البحار'], GMDSS_CERTIFICATE: ['GMDSS Operator Certificate', 'شهادة مشغل النظام العالمي للاستغاثة والسلامة البحرية'],
  MEDICAL_FITNESS_CERTIFICATE: ['Medical Fitness Certificate', 'شهادة اللياقة الطبية'], ISPS_STATEMENT_OF_COMPLIANCE: ['Port Facility Statement of Compliance (ISPS)', 'بيان امتثال المرفق المينائي'],
  MET_INSTITUTION_ACCREDITATION: ['Maritime Training Institution Accreditation', 'اعتماد مؤسسة التعليم والتدريب البحري'], MET_PROGRAMME_APPROVAL: ['Training Programme Approval', 'اعتماد برنامج تدريبي'],
  SHIPPING_AGENCY: ['Shipping Agency Licence', 'رخصة وكالة ملاحية'], BUNKER_SUPPLIER: ['Bunker Supplier Licence', 'رخصة مورد وقود السفن'], SHIP_CHANDLER: ['Ship Chandler Licence', 'رخصة تموين السفن'], REPAIR_YARD: ['Ship Repair Yard Licence', 'رخصة حوض إصلاح السفن'],
  MANNING_AGENCY: ['Manning Agency Licence', 'رخصة وكالة تطقيم'], MARINE_SURVEYOR: ['Marine Surveyor Approval', 'اعتماد مساح بحري'], TRAINING_INSTITUTE: ['Training Institute Licence', 'رخصة معهد تدريب'], PORT_FACILITY_ISPS: ['Port Facility Operator (ISPS) Licence', 'رخصة مشغل مرفق مينائي'],
  STEVEDORE: ['Stevedoring Licence', 'رخصة الشحن والتفريغ'], DIVING_CONTRACTOR: ['Diving Contractor Licence', 'رخصة مقاول غوص'], SHIP_MANAGEMENT: ['Ship Management Company Licence', 'رخصة شركة إدارة سفن'], MARINA_OR_JETTY: ['Marina or Jetty Operator Licence', 'رخصة مشغل مرسى أو رصيف'],
  RECOGNISED_ORGANISATION: ['Recognised Organisation Authorisation', 'تفويض هيئة معترف بها'], COMPASS_CALIBRATION: ['Magnetic Compass Adjuster Approval', 'اعتماد ضابط البوصلة المغناطيسية'], LSA_SERVICING: ['Life-Saving Appliance Servicing Station Approval', 'اعتماد محطة صيانة معدات إنقاذ الأرواح'],
  FFA_SERVICING: ['Fire-Fighting Appliance Servicing Station Approval', 'اعتماد محطة صيانة معدات مكافحة الحريق'], SMALL_VESSEL_SURVEY: ['Small Vessel Survey Approval', 'اعتماد مساحة السفن الصغيرة'], PEST_CONTROL: ['Vessel Pest Control and Deratting Approval', 'اعتماد مكافحة الآفات وإبادة القوارض في السفن'],
  TOWAGE_CERTIFICATION: ['Towage Operator Licence', 'رخصة مشغل قطر'],
};

/* B2 — statutory certificates run a survey regime, not a plain expiry: a certificate whose annual survey window has closed unendorsed is not in force whatever its expiry says. */
export const STATUTORY_TYPES: string[] = [...VESSEL_STATUTORY_CERT_TYPES, ...COMPANY_STATUTORY_CERT_TYPES];
export const CERT_LABEL: Record<string, string> = Object.fromEntries(STATUTORY_TYPES.map((t) => [t, INSTRUMENT_TYPE_LABEL[t][0]]));
export const CONVENTION: Record<string, string> = {
  CARGO_SHIP_SAFETY_CONSTRUCTION: 'SOLAS 1974, chapter I', CARGO_SHIP_SAFETY_EQUIPMENT: 'SOLAS 1974, chapter I', CARGO_SHIP_SAFETY_RADIO: 'SOLAS 1974, chapter I', INTERNATIONAL_LOAD_LINE: 'International Convention on Load Lines 1966',
  IOPP_CERTIFICATE: 'MARPOL Annex I', IAPP_CERTIFICATE: 'MARPOL Annex VI', SEWAGE_POLLUTION_PREVENTION: 'MARPOL Annex IV', SAFETY_MANAGEMENT_CERTIFICATE: 'ISM Code', SHIP_SECURITY_CERTIFICATE: 'ISPS Code',
  MARITIME_LABOUR_CERTIFICATE: 'Maritime Labour Convention 2006', TONNAGE_CERTIFICATE: 'International Convention on Tonnage Measurement of Ships 1969', MINIMUM_SAFE_MANNING_DOCUMENT: 'SOLAS chapter V, regulation 14', DOCUMENT_OF_COMPLIANCE: 'ISM Code',
  CIVIL_LIABILITY_CERTIFICATE: 'CLC 1992', CONTINUOUS_SYNOPSIS_RECORD: 'SOLAS chapter XI-1, regulation 5', EXEMPTION_CERTIFICATE: 'SOLAS 1974, chapter I', CERTIFICATE_OF_OWNERSHIP: 'National maritime law', BALLAST_WATER_MANAGEMENT: 'BWM Convention 2004',
  ANTI_FOULING_SYSTEM: 'AFS Convention 2001', BUNKER_LIABILITY_CERTIFICATE: 'Bunker Convention 2001', WRECK_REMOVAL_LIABILITY: 'Nairobi WRC 2007',
};
export const SURVEY_REGIME: Record<string, { annual: boolean; intermediate: boolean }> = {
  CARGO_SHIP_SAFETY_CONSTRUCTION: { annual: true, intermediate: true }, CARGO_SHIP_SAFETY_EQUIPMENT: { annual: true, intermediate: true }, CARGO_SHIP_SAFETY_RADIO: { annual: true, intermediate: false }, INTERNATIONAL_LOAD_LINE: { annual: true, intermediate: false },
  IOPP_CERTIFICATE: { annual: true, intermediate: true }, IAPP_CERTIFICATE: { annual: true, intermediate: true }, SEWAGE_POLLUTION_PREVENTION: { annual: false, intermediate: false }, SAFETY_MANAGEMENT_CERTIFICATE: { annual: false, intermediate: true },
  SHIP_SECURITY_CERTIFICATE: { annual: false, intermediate: true }, MARITIME_LABOUR_CERTIFICATE: { annual: false, intermediate: true }, TONNAGE_CERTIFICATE: { annual: false, intermediate: false }, MINIMUM_SAFE_MANNING_DOCUMENT: { annual: false, intermediate: false },
  DOCUMENT_OF_COMPLIANCE: { annual: true, intermediate: false }, CIVIL_LIABILITY_CERTIFICATE: { annual: false, intermediate: false }, CONTINUOUS_SYNOPSIS_RECORD: { annual: false, intermediate: false }, EXEMPTION_CERTIFICATE: { annual: false, intermediate: false },
  CERTIFICATE_OF_OWNERSHIP: { annual: false, intermediate: false }, BALLAST_WATER_MANAGEMENT: { annual: true, intermediate: true }, ANTI_FOULING_SYSTEM: { annual: false, intermediate: false }, BUNKER_LIABILITY_CERTIFICATE: { annual: false, intermediate: false }, WRECK_REMOVAL_LIABILITY: { annual: false, intermediate: false },
};
const NON_EXPIRING = new Set(['TONNAGE_CERTIFICATE', 'MINIMUM_SAFE_MANNING_DOCUMENT', 'CONTINUOUS_SYNOPSIS_RECORD']);
export const isStatutory = (type: string) => STATUTORY_TYPES.includes(type);
export const nonExpiring = (type: string) => NON_EXPIRING.has(type);
// class sets the default term; a few types carry their own from the convention or the medical standard
const TERM_OVERRIDE: Record<string, number> = { MEDICAL_FITNESS_CERTIFICATE: 24, CIVIL_LIABILITY_CERTIFICATE: 12, BUNKER_LIABILITY_CERTIFICATE: 12, WRECK_REMOVAL_LIABILITY: 12, EXEMPTION_CERTIFICATE: 12 };
export const termMonthsOf = (type: string) => TERM_OVERRIDE[type] ?? validityMonthsOf(type);

export interface SurveyWindow { kind: 'ANNUAL' | 'INTERMEDIATE'; anniversary: Date; dueFrom: Date; dueTo: Date }
/** An annual survey is due on the anniversary and may be held three months either side; the intermediate stands in the same relation to the second or third anniversary. */
export function endorsementSchedule(type: string, issueDate: string | Date | null, expiryDate: string | Date | null): SurveyWindow[] {
  const regime = SURVEY_REGIME[type]; if (!regime || !issueDate) return [];
  const issued = new Date(issueDate); const expires = expiryDate ? new Date(expiryDate) : addMonths(issued, 60);
  const termYears = Math.round((expires.getTime() - issued.getTime()) / (MONTH * 12)); if (termYears < 2) return [];
  const out: SurveyWindow[] = [];
  if (regime.annual) for (let y = 1; y < termYears; y++) { const a = addMonths(issued, y * 12); out.push({ kind: 'ANNUAL', anniversary: a, dueFrom: addMonths(a, -3), dueTo: addMonths(a, 3) }); }
  if (regime.intermediate) out.push({ kind: 'INTERMEDIATE', anniversary: addMonths(issued, 30), dueFrom: addMonths(issued, 24), dueTo: addMonths(issued, 36) });
  return out.sort((a, b) => a.anniversary.getTime() - b.anniversary.getTime());
}
type StatutoryLike = { status: string; entityType: string; issueDate: string | null; expiryDate: string | null; endorsements: WorldEndorsement[] };
/** Where a certificate stands against its schedule: an endorsement is overdue once its window closed with nothing recorded against it. */
export function endorsementState(doc: StatutoryLike, now: Date) {
  const recorded = doc.endorsements ?? [];
  const done = (kind: string, anniversary: Date) => recorded.find((e) => e.kind === kind && e.completedOn && Math.abs(new Date(e.anniversary || e.completedOn).getTime() - anniversary.getTime()) < MONTH * 4 && e.result !== 'NOT_ENDORSED');
  const schedule = endorsementSchedule(doc.entityType, doc.issueDate, doc.expiryDate).map((s) => {
    const hit = done(s.kind, s.anniversary); const overdue = !hit && s.dueTo.getTime() < now.getTime(); const open = !hit && !overdue && s.dueFrom.getTime() <= now.getTime();
    return { ...s, completedOn: hit?.completedOn ?? null, surveyor: hit?.surveyor ?? '', result: hit?.result ?? '', state: hit ? 'ENDORSED' : overdue ? 'OVERDUE' : open ? 'DUE' : 'SCHEDULED' };
  });
  return { schedule, overdue: schedule.filter((s) => s.state === 'OVERDUE').length, due: schedule.filter((s) => s.state === 'DUE').length, next: schedule.find((s) => s.state === 'DUE' || s.state === 'SCHEDULED') ?? null, refused: recorded.filter((e) => e.result === 'NOT_ENDORSED').length };
}
/** Whether an instrument is in force, tested in the order a port state control officer applies them: status, expiry, then the survey schedule. */
export function forceState(doc: StatutoryLike, now: Date): { inForce: boolean; reason: string } {
  if (doc.status !== 'ISSUED') return { inForce: false, reason: `Instrument is ${doc.status.toLowerCase()}` };
  if (doc.expiryDate && new Date(doc.expiryDate).getTime() < now.getTime()) return { inForce: false, reason: 'Expired' };
  if (!isStatutory(doc.entityType)) return { inForce: true, reason: 'In force' };
  const st = endorsementState(doc, now);
  if (st.refused) return { inForce: false, reason: 'A survey was carried out and the certificate not endorsed' };
  if (st.overdue) return { inForce: false, reason: `${st.overdue} survey endorsement(s) overdue` };
  return { inForce: true, reason: 'In force' };
}

const SHIP_CERTS = ['SAFETY_MANAGEMENT_CERTIFICATE', 'SHIP_SECURITY_CERTIFICATE', 'INTERNATIONAL_LOAD_LINE', 'IOPP_CERTIFICATE', 'MARITIME_LABOUR_CERTIFICATE', 'TONNAGE_CERTIFICATE', 'MINIMUM_SAFE_MANNING_DOCUMENT'];
const ISSUED_LIKE = new Set<string>(['ISSUED', 'SUSPENDED', 'REVOKED']);

/** The polymorphic instrument register: company licences, ISPS statements, MET accreditation, vessel instruments, seafarer certificates and the statutory certificates of the ships on the register. */
export function buildLicences(rng: Prng, profile: string, companies: WorldCompany[], vessels: WorldVessel[], seafarers: WorldSeafarer[], berths: WorldBerth[], registry: WorldRegistryEntry[], users: WorldUser[], now: Date): WorldLicence[] {
  const j = getJurisdiction(profile); const ae = j.code === 'AE'; const histDays = Math.floor((now.getTime() - HIST_START.getTime()) / D);
  const surveyors = users.filter((u) => u.roleName === 'Marine Surveyor' && /surveyor/i.test(u.designation)).slice(0, 3);
  const vById = new Map(vessels.map((v) => [v.id, v])); const out: WorldLicence[] = [];
  const base = (p: Partial<WorldLicence> & Pick<WorldLicence, 'subjectKind' | 'entityName' | 'entityType' | 'status' | 'appliedDate'>): WorldLicence => ({
    id: '', licenseNo: '', subjectId: null, subjectModel: null, instrumentClass: instrumentClassOf(p.entityType), typeLabel: INSTRUMENT_TYPE_LABEL[p.entityType]?.[0] ?? p.entityType, typeLabelAr: ae ? INSTRUMENT_TYPE_LABEL[p.entityType]?.[1] : undefined,
    issueChecks: [], contactPerson: '', phone: '', email: '', address: '', taxId: '', holderCode: '', issueDate: null, expiryDate: null, conditions: '', performanceRating: 0, audits: [], endorsements: [], signature: null, history: [], ...p });
  // roll a term forward from its first issue so nothing is trading on a lapsed instrument
  const roll = (issued: Date, months: number) => { let termStart = issued; const renewals: Date[] = []; while (termStart.getTime() + months * MONTH < now.getTime()) { termStart = new Date(termStart.getTime() + months * MONTH); renewals.push(termStart); } return { termStart, renewals, expiry: new Date(termStart.getTime() + months * MONTH) }; };
  const lifecycle = (status: LicenseStatus, applied: Date, issued: Date | null, by: string, what: string, renewals: Date[] = []): WorldHistoryEntry[] => {
    const h = [hist('', 'APPLIED', applied, by, 'Application received')];
    if (status !== 'APPLIED') h.push(hist('APPLIED', 'UNDER_REVIEW', applied.getTime() + 4 * D, 'Registry'));
    if (issued) h.push(hist('UNDER_REVIEW', 'ISSUED', issued, 'Registry', `${what} issued`));
    renewals.forEach((r) => h.push(hist('ISSUED', 'ISSUED', r, 'Registry', `${what} renewed for a further term`)));
    if (status === 'SUSPENDED') h.push(hist('ISSUED', 'SUSPENDED', now.getTime() - 20 * D, 'Registry', 'Repeated safety violations — gear certification lapsed'));
    if (status === 'REVOKED') h.push(hist('ISSUED', 'SUSPENDED', now.getTime() - 75 * D, 'Registry', 'Suspended after a non-conformity audit'), hist('SUSPENDED', 'REVOKED', now.getTime() - 32 * D, 'Registry', 'Revoked — remediation not evidenced within the suspension period'));
    if (status === 'REJECTED') h.push(hist('UNDER_REVIEW', 'REJECTED', applied.getTime() + 24 * D, 'Registry', 'Premises inspection failed'));
    return h;
  };
  // company licences, MET accreditation and the ISPS statements: one register, three subject kinds
  let k = 0;
  for (const c of companies.filter((x) => !x.real)) {
    const types = [...c.types, ...(c.category === 'INSTITUTE' ? ['MET_INSTITUTION_ACCREDITATION', 'MET_PROGRAMME_APPROVAL'] : [])];
    for (const type of types) {
      const status: LicenseStatus = c.status === 'SUSPENDED' ? 'SUSPENDED' : c.status === 'INACTIVE' || c.status === 'BLACKLISTED' ? 'REVOKED' : k % 11 === 4 ? 'UNDER_REVIEW' : k % 13 === 6 ? 'APPLIED' : k % 17 === 9 ? 'REJECTED' : 'ISSUED';
      const established = ISSUED_LIKE.has(status); const applied = new Date(now.getTime() - (established ? rng.int(380, histDays) : rng.int(20, 180)) * D);
      const issued = established ? new Date(applied.getTime() + 30 * D) : null; const months = termMonthsOf(type); const term = issued ? roll(issued, months) : null; const auditor = surveyors[k % surveyors.length];
      out.push(base({ subjectKind: type.startsWith('MET_') ? 'MET_INSTITUTION' : 'COMPANY', subjectId: c.id, subjectModel: 'Company', entityName: c.name, entityType: type, holderCode: c.code, status, contactPerson: c.contactName, phone: c.contactPhone, email: c.contactEmail, address: c.address, taxId: c.taxId,
        appliedDate: iso(applied), issueDate: issued ? iso(issued) : null, expiryDate: term ? iso(term.expiry) : null, conditions: status === 'ISSUED' ? 'Valid within port limits; subject to annual safety audit.' : '', performanceRating: established ? c.rating : 0,
        issueChecks: issued ? [check('Company is on the directory and not blacklisted', true, true, 'In good standing')] : [],
        audits: status === 'REVOKED' ? [{ date: iso(now.getTime() - 140 * D), auditorId: auditor.id, auditor: auditor.name, result: 'OBSERVATIONS', remarks: 'Calibration certificates due for renewal' }, { date: iso(now.getTime() - 80 * D), auditorId: auditor.id, auditor: auditor.name, result: 'NON_CONFORMITY', remarks: 'Deliveries made with uncalibrated meters; suspension recommended' }]
          : issued ? [{ date: iso(now.getTime() - 90 * D), auditorId: auditor.id, auditor: auditor.name, result: c.rating >= 4 ? 'SATISFACTORY' : c.rating >= 3 ? 'OBSERVATIONS' : 'NON_CONFORMITY', remarks: 'Annual audit' }] : [],
        history: lifecycle(status, applied, issued, c.contactName, INSTRUMENT_TYPE_LABEL[type]?.[0] ?? 'Licence', term?.renewals) }));
      k += 1;
    }
  }
  berths.filter((b) => b.status === 'OPERATIONAL').slice(0, 8).forEach((b, i) => {
    const op = companies.find((c) => c.category === 'TERMINAL_OPERATOR' && (/Container/.test(b.terminal) ? c.code === 'CTO' : /Liquid|SPM/.test(b.terminal) ? c.code === 'LTO' : c.code === 'BTO'));
    const status: LicenseStatus = i === 5 ? 'UNDER_REVIEW' : i === 7 ? 'APPLIED' : 'ISSUED'; const applied = new Date(now.getTime() - (status === 'ISSUED' ? rng.int(400, histDays) : rng.int(20, 120)) * D);
    const issued = status === 'ISSUED' ? new Date(applied.getTime() + 45 * D) : null; const term = issued ? roll(issued, 60) : null;
    out.push(base({ subjectKind: 'PORT_FACILITY', subjectId: b.id, subjectModel: 'Berth', entityName: `${b.name} (${b.code})`, entityType: 'ISPS_STATEMENT_OF_COMPLIANCE', holderCode: op?.code ?? '', status, contactPerson: op?.contactName ?? '', email: op?.contactEmail ?? '', address: b.terminal,
      appliedDate: iso(applied), issueDate: issued ? iso(issued) : null, expiryDate: term ? iso(term.expiry) : null, conditions: status === 'ISSUED' ? 'Valid for the facility as described in the approved Port Facility Security Plan.' : '',
      issueChecks: issued ? [check('Port facility is operational', true, false, `Facility status is ${b.status}`)] : [], history: lifecycle(status, applied, issued, op?.contactName ?? 'PFSO', 'Statement of compliance', term?.renewals) }));
  });
  // vessel instruments — issued against the fictional fleet only; the documented liner callers carry no issued instruments
  vessels.filter((v) => !v.real).forEach((v, i) => {
    const kinds = [v.flag === j.code ? 'NAVIGATION_LICENCE' : 'FOREIGN_VESSEL_PERMIT', ...(i % 5 === 2 ? ['VESSEL_NOC'] : [])];
    for (const type of kinds) {
      const applied = new Date(now.getTime() - rng.int(40, Math.min(histDays, 900)) * D); const issued = new Date(applied.getTime() + rng.int(6, 20) * D); const term = roll(issued, termMonthsOf(type));
      out.push(base({ subjectKind: 'VESSEL', subjectId: v.id, subjectModel: 'Vessel', entityName: `${v.name} (IMO ${v.imo})`, entityType: type, holderCode: v.agentCode, status: 'ISSUED', contactPerson: v.agentCode,
        appliedDate: iso(applied), issueDate: iso(term.termStart), expiryDate: iso(term.expiry), conditions: type === 'VESSEL_NOC' ? 'Valid for the declared movement only.' : 'Valid within port limits and the approach channel.',
        issueChecks: [check('Vessel is on the active register', true, true, 'Active'), check('Statutory certificates in force', true, true, 'No expired certificate at issue'), check('Class docking survey current', true, false, 'Docking within the class cycle')],
        history: lifecycle('ISSUED', applied, term.termStart, v.agentCode, INSTRUMENT_TYPE_LABEL[type][0], term.renewals) }));
    }
  });
  // seafarer certificates and endorsements on the same engine
  seafarers.forEach((s, i) => {
    const officer = isOfficerRank(s.rank); const kinds: string[] = [];
    if (officer && i % 2 === 0) kinds.push('CERTIFICATE_OF_COMPETENCY'); if (officer && i % 6 === 1) kinds.push('FLAG_STATE_ENDORSEMENT'); if (!officer && i % 4 === 0) kinds.push('CERTIFICATE_OF_PROFICIENCY');
    if (i % 7 === 1) kinds.push('MEDICAL_FITNESS_CERTIFICATE'); if (i % 9 === 3) kinds.push('SEAMAN_CARD'); if (/Master|Officer/.test(s.rank) && officer && i % 5 === 2) kinds.push('GMDSS_CERTIFICATE');
    const expired = s.certificates.filter((c) => new Date(c.expiryDate).getTime() < now.getTime()); const medical = s.certificates.find((c) => /medical/i.test(c.certType));
    kinds.forEach((type, kk) => {
      const status: LicenseStatus = kk === 0 && i % 17 === 5 ? 'UNDER_REVIEW' : kk === 0 && i % 23 === 9 ? 'APPLIED' : 'ISSUED';
      const applied = new Date(now.getTime() - (status === 'ISSUED' ? rng.int(30, Math.min(histDays, 1200)) : rng.int(5, 40)) * D); const issued = status === 'ISSUED' ? new Date(applied.getTime() + rng.int(7, 21) * D) : null; const term = issued ? roll(issued, termMonthsOf(type)) : null;
      out.push(base({ subjectKind: 'SEAFARER', subjectId: s.id, subjectModel: 'Seafarer', entityName: `${s.name} (CDC ${s.cdcNo})`, entityType: type, status, contactPerson: s.name, phone: s.phone, email: s.email,
        appliedDate: iso(applied), issueDate: term ? iso(term.termStart) : null, expiryDate: term ? iso(term.expiry) : null, conditions: type === 'CERTIFICATE_OF_COMPETENCY' ? `Capacity: ${s.rank}. Limitations: none.` : '',
        issueChecks: [check('Seafarer documents in force', expired.length === 0, true, expired.length ? `${expired.length} expired: ${expired.map((c) => c.certType).join(', ')}` : `${s.certificates.length} documents, none expired`),
          check('Medical fitness certificate valid', !!medical && new Date(medical.expiryDate).getTime() >= now.getTime(), true, medical ? `Medical valid to ${medical.expiryDate.slice(0, 10)}` : 'No medical fitness certificate on record')],
        history: lifecycle(status, applied, term?.termStart ?? null, s.name, INSTRUMENT_TYPE_LABEL[type][0], term?.renewals) }));
    });
  });
  // B2 — statutory certificates of the ships on the register, each carrying the survey endorsements its convention requires
  const onRegister = registry.filter((r) => r.state === 'REGISTERED' || r.state === 'PROVISIONAL');
  const ROs = ae ? ['TASNEEF', 'Lloyd\'s Register', 'DNV', 'Bureau Veritas', 'ClassNK'] : ['Indian Register of Shipping', 'Lloyd\'s Register', 'DNV', 'Bureau Veritas', 'ClassNK'];
  const places = ae ? ['Khalifa Port', 'Jebel Ali', 'Fujairah', 'Singapore', 'Colombo'] : ['Harbour', 'Nhava Sheva', 'Mumbai', 'Kochi', 'Singapore'];
  const endorse = (kind: EndorsementKind, anniversary: Date, completedOn: Date, ro: string, remarks: string): WorldEndorsement => ({ kind, anniversary: iso(anniversary), completedOn: iso(completedOn), surveyor: rng.pick(surveyors).name, organisation: ro, place: rng.pick(places), result: 'ENDORSED', remarks });
  const surveysFor = (type: string, term: { termStart: Date; renewals: Date[]; expiry: Date }, ro: string, lapsed: boolean): WorldEndorsement[] => {
    const out2: WorldEndorsement[] = [];
    if (term.renewals.length) out2.push(endorse('RENEWAL', term.termStart, new Date(term.termStart.getTime() - rng.int(0, 20) * D), ro, 'Renewal survey — certificate reissued for a further term'));
    endorsementSchedule(type, term.termStart, term.expiry).forEach((sv, si) => {
      const closed = sv.dueTo.getTime() < now.getTime(); const open = sv.dueFrom.getTime() <= now.getTime() && !closed;
      if (lapsed && si >= 1) return;                       // this ship let its surveys slip
      if (!closed && !(open && si % 2 === 0)) return;      // record every closed window, and the open ones attended to
      out2.push(endorse(sv.kind, sv.anniversary, new Date(sv.anniversary.getTime() - rng.int(0, 40) * D), ro, ''));
    });
    return out2;
  };
  onRegister.forEach((r, vi) => {
    const v = vById.get(r.vesselId)!; const lapsed = vi === 1; // one ship is left with its schedule slipped, so the register has a live example of a certificate that reads valid on its face and is not
    [...SHIP_CERTS, ...(vi % 2 === 0 ? ['IAPP_CERTIFICATE', 'BALLAST_WATER_MANAGEMENT'] : [])].forEach((type, ci) => {
      const months = termMonthsOf(type); const first = new Date(now.getTime() - (lapsed ? rng.int(900, 1500) : rng.int(200, 3000)) * D); const term = roll(first, months);
      const applied = new Date(first.getTime() - rng.int(14, 40) * D); const ro = ROs[(vi + ci) % ROs.length];
      out.push(base({ subjectKind: 'VESSEL', subjectId: v.id, subjectModel: 'Vessel', entityName: `${v.name} (IMO ${v.imo})`, entityType: type, holderCode: v.agentCode, status: 'ISSUED', contactPerson: v.manager,
        appliedDate: iso(applied), issueDate: iso(term.termStart), expiryDate: iso(term.expiry), conditions: `Issued under ${CONVENTION[type]}. Subject to the survey endorsements recorded on this certificate.`,
        issueChecks: [check('Vessel is on the active register', true, true, `Official number ${r.officialNumber}`), check('Statutory certificates in force', true, true, 'No expired certificate at issue'), check('Class docking survey current', true, false, 'Docking within the class cycle')],
        endorsements: surveysFor(type, term, ro, lapsed), history: lifecycle('ISSUED', applied, term.termStart, v.owner, CERT_LABEL[type], term.renewals) }));
    });
  });
  // the Document of Compliance is issued to the company operating the ship, not to the ship — the plainest demonstration that one engine issues against whatever the instrument is about
  [...new Set(onRegister.map((r) => vById.get(r.vesselId)!.manager).filter(Boolean))].slice(0, 4).forEach((manager, i) => {
    const first = new Date(now.getTime() - rng.int(300, 3000) * D); const term = roll(first, 60); const applied = new Date(first.getTime() - rng.int(30, 60) * D);
    out.push(base({ subjectKind: 'COMPANY', entityName: manager, entityType: 'DOCUMENT_OF_COMPLIANCE', status: 'ISSUED', contactPerson: 'Designated Person Ashore',
      holderCode: companies.find((c) => c.name === manager)?.code ?? '',
      appliedDate: iso(applied), issueDate: iso(term.termStart), expiryDate: iso(term.expiry), conditions: 'Issued under the ISM Code for the ship types listed on the certificate.',
      issueChecks: [check('Company is on the directory and not blacklisted', true, true, 'In good standing')], endorsements: surveysFor('DOCUMENT_OF_COMPLIANCE', term, ROs[i % ROs.length], false),
      history: lifecycle('ISSUED', applied, term.termStart, manager, 'Document of Compliance', term.renewals) }));
  });
  // number each register in its own chronological series per year
  const seq = makeSeries();
  out.sort((a, b) => a.appliedDate.localeCompare(b.appliedDate)).forEach((d) => { const key = `${numberPrefixOf(d.entityType)}-${yearOf(d.appliedDate)}`; d.licenseNo = `${key}-${seq(key)}`; d.id = stableId('licence', d.licenseNo); });
  return out;
}
