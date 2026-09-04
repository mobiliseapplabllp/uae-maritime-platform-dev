import { getJurisdiction, AMENDMENT_TYPES, DELETION_REASONS, VESSEL_STATUTORY_CERT_TYPES, COMPANY_LICENSE_TYPES, type SubjectKind, type RequestStatus, type DefinitionStatus } from '@maritime/contracts';
import { Prng, D, stableId, iso, yearOf, makeSeries } from './prng';
import { hist, type WorldCheck, type WorldHistoryEntry } from './common';
import { usersByRole, userNamed, type WorldUser } from './people';
import type { WorldCompany, WorldBerth } from './organisations';
import type { WorldVessel } from './vessels';
import type { WorldSeafarer } from './crew';
import { INSTRUMENT_TYPE_LABEL, CERT_LABEL, CONVENTION, type WorldLicence } from './instruments';
import { EVIDENCE } from './registry';

export interface WorldServiceField { key: string; label: string; labelAr?: string; type: 'text' | 'number' | 'date' | 'select' | 'checkbox' | 'textarea'; options: string[]; required: boolean; help: string }
export interface WorldServiceDoc { key: string; label: string; labelAr?: string; mandatory: boolean; acceptedFormats: string }
export interface WorldServiceStage { key: string; label: string; labelAr?: string; perm: string; slaDays: number }
export interface WorldFeeLine { code: string; label: string; labelAr?: string; amount: number }
/** A2 — one entry of the service catalogue: a form, a document checklist, fee lines, an SLA and the workflow it runs, all data. */
export interface WorldServiceDefinition {
  id: string; code: string; key: string; name: string; nameAr?: string; domain: number; category: string; description: string; subjectKind: SubjectKind; subjectRequired: boolean; issuesInstrument: string;
  formFields: WorldServiceField[]; requiredDocuments: WorldServiceDoc[]; stages: WorldServiceStage[]; feeLines: WorldFeeLine[]; fee: { amount: number; currency: string }; slaDays: number; autoApprovable: boolean; active: boolean; version: number; status: DefinitionStatus;
}
export interface WorldRequestDoc { key: string; label: string; fileName: string; uploadedAt: string; verified: boolean; verifiedBy: string; verifiedAt: string | null; notes: string }
export interface WorldServiceRequest {
  id: string; requestNo: string; serviceId: string; serviceCode: string; serviceName: string; domain: number; /* `organisationCode` is the tenancy key and `organisation` is the label for it. A name identifies a
   * company to a reader; only the code identifies it to the platform, and a request that carries the name
   * alone cannot be told apart from another company's by anything but string matching. */
  applicant: { userId: string | null; name: string; email: string; phone: string; organisation: string; organisationCode: string };
  subjectKind: SubjectKind; subjectId: string | null; subjectModel: 'Company' | 'Vessel' | 'Seafarer' | 'Berth' | null; subjectLabel: string; formData: Record<string, unknown>; documents: WorldRequestDoc[];
  status: RequestStatus; currentStage: string; assignedToId: string | null; assignedTo: string; checks: WorldCheck[]; decision: { outcome: 'APPROVED' | 'REJECTED'; by: string; at: string; reason: string; automated: boolean } | null;
  issuedInstrumentId: string | null; issuedInstrumentNo: string; fee: { amount: number; currency: string; paid: boolean; paidAt: string | null; reference: string }; createdAt: string; submittedAt: string | null; dueAt: string | null; closedAt: string | null; timeline: WorldHistoryEntry[];
}

type F = [string, string, string, WorldServiceField['type'], boolean, string[]]; // key, label, Arabic label, type, required, options
type Row = [string, string, string, number, string, SubjectKind, string, number, number, number, boolean, string[], F[]]; // code, name, Arabic name, domain, category, subject, instrument, fee AED, fee INR, SLA days, auto-approvable, documents, fields
const ROS = ['TASNEEF', 'Lloyd\'s Register', 'DNV', 'Bureau Veritas', 'ClassNK', 'American Bureau of Shipping'];
const SURVEY_FIELDS: F[] = [['surveyPort', 'Port at which the survey is to be held', 'ميناء إجراء المعاينة', 'text', true, []], ['surveyDate', 'Requested survey date', 'تاريخ المعاينة المطلوب', 'date', true, []], ['recognisedOrganisation', 'Recognised organisation acting for the flag', 'الهيئة المعترف بها', 'select', false, ROS]];
const COMPANY_FIELDS: F[] = [['premises', 'Premises address', 'عنوان المقر', 'text', true, []], ['staffCount', 'Qualified staff', 'عدد الموظفين المؤهلين', 'number', true, []]];
const COMPANY_DOCS = ['Trade licence / registration certificate', 'Professional indemnity or liability cover', 'Key personnel qualifications', 'Premises and equipment inventory'];
const CERT_DOCS: Record<string, string[]> = {
  SAFETY_MANAGEMENT_CERTIFICATE: ['Document of Compliance of the managing company', 'Safety management system manual', 'Internal audit report', 'Master\'s review'],
  SHIP_SECURITY_CERTIFICATE: ['Ship Security Assessment', 'Approved Ship Security Plan', 'SSO appointment and training records', 'Continuous Synopsis Record'],
  INTERNATIONAL_LOAD_LINE: ['Load line survey report', 'Stability booklet', 'Freeboard assignment calculation'], IOPP_CERTIFICATE: ['Oil record book', 'Shipboard Oil Pollution Emergency Plan', 'Oily water separator type approval'],
  MARITIME_LABOUR_CERTIFICATE: ['Declaration of Maritime Labour Compliance Part I', 'Declaration of Maritime Labour Compliance Part II', 'Seafarer employment agreements', 'Accommodation and catering inspection report'],
  TONNAGE_CERTIFICATE: ['Tonnage measurement calculation', 'General arrangement plan', 'Capacity plan'], MINIMUM_SAFE_MANNING_DOCUMENT: ['Manning proposal with watchkeeping arrangement', 'Trading area and voyage pattern', 'Machinery space attendance statement'],
  DOCUMENT_OF_COMPLIANCE: ['Safety management system manual', 'Internal audit programme and reports', 'Designated Person Ashore appointment', 'Fleet list with ship types'],
};
const FEES: Record<string, [number, number, number]> = { // AED, INR, SLA for the generated groups
  statutory: [7500, 30000, 21], company: [12000, 50000, 21],
};
const ROWS: Row[] = [
  ['REG-PROVISIONAL', 'Provisional registration of a ship', 'التسجيل المؤقت للسفينة', 1, 'Registration', 'VESSEL', '', 1500, 15000, 7, false, EVIDENCE.PROVISIONAL.map((e) => e.label), [['acquisitionPlace', 'Place of acquisition', 'مكان الاستحواذ', 'text', true, []]]],
  ['REG-PERMANENT', 'Permanent registration of a ship', 'التسجيل الدائم للسفينة', 1, 'Registration', 'VESSEL', '', 5000, 50000, 30, false, EVIDENCE.PERMANENT.map((e) => e.label), [['previousFlag', 'Previous flag (if any)', 'العلم السابق (إن وجد)', 'text', false, []]]],
  ['REG-AMENDMENT', 'Amendment of registry particulars', 'تعديل بيانات التسجيل', 1, 'Registration', 'VESSEL', '', 1000, 10000, 15, false, EVIDENCE.AMENDMENT.map((e) => e.label), [['amendmentTypes', 'Nature of the alteration', 'طبيعة التعديل', 'select', true, [...AMENDMENT_TYPES]]]],
  ['REG-DELETION', 'Closure of registry (deletion)', 'إغلاق التسجيل (الشطب)', 1, 'Registration', 'VESSEL', '', 500, 5000, 15, false, EVIDENCE.DELETION.map((e) => e.label), [['reason', 'Ground for closure', 'سبب الإغلاق', 'select', true, [...DELETION_REASONS]], ['newFlag', 'Receiving flag', 'العلم المستقبل', 'text', false, []]]],
  ['REG-MORTGAGE', 'Registration of a mortgage', 'تسجيل رهن بحري', 1, 'Registration', 'VESSEL', '', 800, 8000, 10, false, ['Mortgage deed', 'Mortgagee consent', 'Board resolution'], [['holder', 'Mortgagee', 'الدائن المرتهن', 'text', true, []], ['amount', 'Secured amount', 'المبلغ المضمون', 'number', true, []]]],
  ['REG-NAME-APPROVAL', 'Prior approval of a ship name', 'الموافقة المسبقة على اسم السفينة', 1, 'Registration', 'VESSEL', '', 300, 3000, 5, true, ['Application stating the proposed name'], [['proposedName', 'Proposed name', 'الاسم المقترح', 'text', true, []]]],
  ['REG-BAREBOAT-IN', 'Bareboat charter registration (in)', 'تسجيل بعقد إيجار عاري (وارد)', 1, 'Registration', 'VESSEL', '', 3000, 30000, 21, false, ['Bareboat charter party', 'Consent of the underlying registry', 'Consent of registered mortgagees'], [['charterEnds', 'Charter expiry', 'انتهاء عقد الإيجار', 'date', true, []]]],
  ['REG-BAREBOAT-OUT', 'Bareboat charter registration (out)', 'تسجيل بعقد إيجار عاري (صادر)', 1, 'Registration', 'VESSEL', '', 3000, 30000, 21, false, ['Bareboat charter party', 'Consent of registered mortgagees', 'Confirmation from the bareboat registry'], [['bareboatRegistry', 'Bareboat registry', 'سجل الإيجار العاري', 'text', true, []]]],
  ['VESSEL-NAV-LIC', 'Navigation Licence — issue', 'رخصة الملاحة — إصدار', 1, 'Licensing', 'VESSEL', 'NAVIGATION_LICENCE', 2500, 25000, 10, false, ['Certificate of Registry', 'Insurance certificate', 'Class certificate'], [['voyageArea', 'Intended area of operation', 'منطقة التشغيل المقصودة', 'select', true, ['Port limits', 'Coastal', 'International']], ['startDate', 'Requested commencement', 'تاريخ البدء المطلوب', 'date', true, []]]],
  ['VESSEL-FOREIGN-PERMIT', 'Foreign Flag Vessel Permit — coastal trade', 'تصريح سفينة أجنبية — الملاحة الساحلية', 1, 'Licensing', 'VESSEL', 'FOREIGN_VESSEL_PERMIT', 5000, 50000, 7, false, ['Flag state certificate', 'P&I cover note', 'Last port state control report'], [['purpose', 'Purpose of call', 'الغرض من الرسو', 'select', true, ['Cargo', 'Bunkering', 'Repair', 'Layup']], ['durationDays', 'Duration (days)', 'المدة (أيام)', 'number', true, []]]],
  ['VESSEL-NOC', 'Vessel Movement No Objection Certificate', 'شهادة عدم ممانعة لحركة السفينة', 1, 'Licensing', 'VESSEL', 'VESSEL_NOC', 500, 5000, 3, true, ['Movement plan'], [['movementType', 'Movement', 'نوع الحركة', 'select', true, ['Shifting', 'Dry dock', 'Layup', 'Departure']]]],
  ['SEAFARER-COC', 'Certificate of Competency — issue or revalidate', 'شهادة الكفاءة — إصدار أو تجديد', 2, 'Seafarers', 'SEAFARER', 'CERTIFICATE_OF_COMPETENCY', 800, 8000, 14, false, ['Sea service testimonial', 'Medical fitness certificate', 'STCW course certificates', 'Seafarer identity document and passport copy'], [['grade', 'Certificate grade applied for', 'درجة الشهادة المطلوبة', 'select', true, ['Master', 'Chief Mate', 'Officer in Charge of a Navigational Watch', 'Chief Engineer', 'Second Engineer']], ['seaServiceMonths', 'Approved sea service (months)', 'الخدمة البحرية المعتمدة (أشهر)', 'number', true, []]]],
  ['SEAFARER-COP', 'Certificate of Proficiency — issue', 'شهادة الإتقان — إصدار', 2, 'Seafarers', 'SEAFARER', 'CERTIFICATE_OF_PROFICIENCY', 400, 4000, 10, false, ['Course completion certificate', 'Medical fitness certificate'], [['course', 'Course', 'الدورة', 'select', true, ['Basic Safety Training', 'Advanced Fire Fighting', 'Medical First Aid', 'Tanker Familiarisation', 'Ship Security Officer']]]],
  ['SEAFARER-ENDORSEMENT', 'Flag State Endorsement — STCW Regulation I/10', 'اعتماد دولة العلم — اللائحة I/10', 2, 'Seafarers', 'SEAFARER', 'FLAG_STATE_ENDORSEMENT', 500, 5000, 10, false, ['Foreign Certificate of Competency', 'Medical fitness certificate'], [['issuingCountry', 'Issuing administration', 'الإدارة المصدرة', 'text', true, []]]],
  ['SEAFARER-GMDSS', 'GMDSS Operator Certificate — issue', 'شهادة مشغل GMDSS — إصدار', 2, 'Seafarers', 'SEAFARER', 'GMDSS_CERTIFICATE', 400, 4000, 10, false, ['GMDSS course certificate', 'Medical fitness certificate'], [['grade', 'Certificate', 'الشهادة', 'select', true, ['GOC', 'ROC']]]],
  ['SEAFARER-MEDICAL', 'Medical Fitness Certificate — registration', 'شهادة اللياقة الطبية — تسجيل', 2, 'Seafarers', 'SEAFARER', 'MEDICAL_FITNESS_CERTIFICATE', 150, 1500, 3, true, ['Medical examination report from an approved practitioner'], [['practitioner', 'Approved medical practitioner', 'الطبيب المعتمد', 'text', true, []]]],
  ['SEAFARER-SEAMAN-CARD', 'Seafarer Identity Card — issue', 'بطاقة هوية البحار — إصدار', 2, 'Seafarers', 'SEAFARER', 'SEAMAN_CARD', 200, 2000, 7, false, ['Passport copy', 'Photograph', 'Sea service testimonial'], [['deliveryOffice', 'Collection office', 'مكتب الاستلام', 'select', true, ['Abu Dhabi', 'Dubai', 'Fujairah']]]],
  ['SEAFARER-CRA', 'Certificate of Receipt of Application', 'شهادة استلام الطلب', 2, 'Seafarers', 'SEAFARER', 'CERTIFICATE_OF_RECEIPT_OF_APPLICATION', 100, 1000, 2, true, ['Pending application reference'], [['applicationRef', 'Application reference', 'مرجع الطلب', 'text', true, []]]],
  ['SEAFARER-RECORD-BOOK', 'Seafarer record book — issue or replacement', 'سجل خدمة البحار — إصدار أو بدل فاقد', 2, 'Seafarers', 'SEAFARER', '', 200, 2000, 7, false, ['Passport copy', 'Photograph', 'Loss report (replacement only)'], [['reason', 'Reason', 'السبب', 'select', true, ['First issue', 'Replacement — lost', 'Replacement — full']]]],
  ['SEAFARER-SEA-SERVICE', 'Sea service verification', 'التحقق من الخدمة البحرية', 2, 'Seafarers', 'SEAFARER', '', 100, 1000, 7, false, ['Sea service testimonials', 'Record book pages'], [['months', 'Months claimed', 'الأشهر المطالب بها', 'number', true, []]]],
  ['MET-APPROVAL', 'Maritime Training Institute — accreditation', 'اعتماد معهد التدريب البحري', 2, 'Accreditation', 'MET_INSTITUTION', 'MET_INSTITUTION_ACCREDITATION', 20000, 200000, 45, false, ['Registration certificate', 'Quality Standards System manual', 'Instructor qualifications', 'Facility and simulator inventory'], [['programmes', 'Courses offered', 'الدورات المقدمة', 'textarea', true, []]]],
  ['MET-PROGRAMME', 'Training programme — approval', 'اعتماد برنامج تدريبي', 2, 'Accreditation', 'MET_INSTITUTION', 'MET_PROGRAMME_APPROVAL', 5000, 50000, 30, false, ['Course syllabus and assessment scheme', 'Instructor qualifications'], [['programme', 'Programme', 'البرنامج', 'text', true, []], ['seats', 'Seats per intake', 'المقاعد لكل دفعة', 'number', true, []]]],
  ['LEGIS-CONSULTATION', 'Comment on a draft instrument', 'التعليق على مسودة صك تشريعي', 3, 'Legislation', 'COMPANY', '', 0, 0, 30, false, ['Position paper'], [['instrumentRef', 'Draft instrument reference', 'مرجع المسودة', 'text', true, []], ['comment', 'Comment', 'التعليق', 'textarea', true, []]]],
  ['LEGIS-INTERPRETATION', 'Request for regulatory clarification', 'طلب توضيح تنظيمي', 3, 'Legislation', 'COMPANY', '', 0, 0, 21, false, ['Statement of the question'], [['instrumentRef', 'Instrument reference', 'مرجع الصك', 'text', true, []], ['question', 'Question', 'السؤال', 'textarea', true, []]]],
  ['NMC-INCIDENT-REPORT', 'Marine incident or casualty report', 'بلاغ حادث أو واقعة بحرية', 4, 'Maritime centre', 'VESSEL', '', 0, 0, 1, true, ['Master\'s report', 'Photographs'], [['occurredAt', 'Date and time of occurrence', 'تاريخ ووقت الواقعة', 'date', true, []], ['description', 'Description', 'الوصف', 'textarea', true, []]]],
  ['NMC-DRILL-NOTICE', 'Notification of a SAR or security drill', 'إخطار بتمرين بحث وإنقاذ أو تمرين أمني', 4, 'Maritime centre', 'COMPANY', '', 0, 0, 3, true, ['Drill plan'], [['drillDate', 'Drill date', 'تاريخ التمرين', 'date', true, []], ['area', 'Area', 'المنطقة', 'text', true, []]]],
  ['NMC-NAV-WARNING', 'Request for a navigational warning', 'طلب إصدار تحذير ملاحي', 4, 'Maritime centre', 'COMPANY', '', 0, 0, 2, false, ['Works description and positions'], [['from', 'From', 'من', 'date', true, []], ['to', 'To', 'إلى', 'date', true, []]]],
  ['NMC-RESTRICTED-AREA', 'Permit for works in a restricted area', 'تصريح أعمال في منطقة مقيدة', 4, 'Maritime centre', 'COMPANY', '', 1000, 10000, 10, false, ['Method statement', 'Craft particulars', 'Insurance cover'], [['area', 'Area', 'المنطقة', 'text', true, []], ['craft', 'Craft engaged', 'الوحدات المستخدمة', 'textarea', true, []]]],
  ['INSP-PSC-REINSPECTION', 'Re-inspection after detention', 'إعادة التفتيش بعد الاحتجاز', 5, 'Inspection', 'VESSEL', '', 2000, 20000, 2, false, ['Rectification evidence', 'Class confirmation'], [['inspectionNo', 'Inspection number', 'رقم التفتيش', 'text', true, []]]],
  ['INSP-FSI-SURVEY', 'Flag state inspection request', 'طلب تفتيش دولة العلم', 5, 'Inspection', 'VESSEL', '', 1500, 15000, 7, false, ['Last inspection report'], [['port', 'Port', 'الميناء', 'text', true, []], ['date', 'Requested date', 'التاريخ المطلوب', 'date', true, []]]],
  ['INSP-ISM-AUDIT', 'ISM audit request', 'طلب تدقيق ISM', 5, 'Inspection', 'COMPANY', '', 3000, 30000, 14, false, ['Internal audit report', 'Fleet list'], [['auditType', 'Audit', 'نوع التدقيق', 'select', true, ['Initial', 'Annual', 'Intermediate', 'Renewal']]]],
  ['INSP-MLC-INSPECTION', 'MLC inspection request', 'طلب تفتيش اتفاقية العمل البحري', 5, 'Inspection', 'VESSEL', '', 1500, 15000, 10, false, ['DMLC Part II', 'Crew list'], [['port', 'Port', 'الميناء', 'text', true, []]]],
  ['PORT-ISPS-SOC', 'Port Facility Statement of Compliance — ISPS', 'بيان امتثال المرفق المينائي — ISPS', 6, 'Security', 'PORT_FACILITY', 'ISPS_STATEMENT_OF_COMPLIANCE', 15000, 150000, 30, false, ['Port Facility Security Assessment', 'Port Facility Security Plan', 'PFSO appointment letter'], [['facilityTypes', 'Vessel types served', 'أنواع السفن المخدومة', 'text', true, []]]],
  ['PORT-PFSP-APPROVAL', 'Port Facility Security Plan — approval', 'اعتماد خطة أمن المرفق المينائي', 6, 'Security', 'PORT_FACILITY', '', 5000, 50000, 30, false, ['Port Facility Security Assessment', 'Draft Port Facility Security Plan'], [['revision', 'Plan revision', 'مراجعة الخطة', 'text', true, []]]],
  ['PORT-PFSO-APPOINTMENT', 'PFSO appointment — notification', 'إخطار تعيين ضابط أمن المرفق', 6, 'Security', 'PORT_FACILITY', '', 0, 0, 5, true, ['PFSO training certificate', 'Appointment letter'], [['pfsoName', 'PFSO name', 'اسم ضابط أمن المرفق', 'text', true, []]]],
  ['PORT-CALL-CLEARANCE', 'Pre-arrival port clearance', 'التخليص المسبق للوصول', 6, 'Port services', 'VESSEL', '', 250, 2500, 1, true, ['FAL general declaration', 'Crew list', 'Dangerous goods manifest'], [['eta', 'ETA', 'الوقت المتوقع للوصول', 'date', true, []], ['lastPort', 'Last port', 'الميناء الأخير', 'text', true, []]]],
  ['PORT-DG-PERMIT', 'Dangerous goods handling permit', 'تصريح مناولة البضائع الخطرة', 6, 'Port services', 'VESSEL', '', 800, 8000, 2, false, ['Dangerous goods manifest', 'Stowage plan'], [['imdgClasses', 'IMDG classes', 'فئات IMDG', 'text', true, []]]],
  ['PORT-BUNKER-PERMIT', 'Bunkering operation permit', 'تصريح عملية التزود بالوقود', 6, 'Port services', 'VESSEL', '', 300, 3000, 1, true, ['Bunker delivery plan', 'Supplier licence reference'], [['supplier', 'Licensed supplier', 'المورد المرخص', 'text', true, []], ['quantityMt', 'Quantity (MT)', 'الكمية (طن)', 'number', true, []]]],
];
const stagesFor = (sla: number, ae: boolean): WorldServiceStage[] => [
  { key: 'SCREENING', label: 'Completeness screening', labelAr: ae ? 'فحص الاكتمال' : undefined, perm: 'services.assess', slaDays: Math.max(1, Math.round(sla * 0.2)) },
  { key: 'TECHNICAL', label: 'Technical assessment', labelAr: ae ? 'التقييم الفني' : undefined, perm: 'services.assess', slaDays: Math.max(1, Math.round(sla * 0.5)) },
  { key: 'APPROVAL', label: 'Approval', labelAr: ae ? 'الاعتماد' : undefined, perm: 'services.approve', slaDays: Math.max(1, Math.round(sla * 0.3)) },
];

/** The catalogue: the reference's 22 services plus the registration journeys, every statutory certificate and every licensed entity type of the contracts — about 80 in all. */
export function buildServiceDefinitions(profile: string): WorldServiceDefinition[] {
  const j = getJurisdiction(profile); const ae = j.code === 'AE';
  const rows: Row[] = [...ROWS,
    ...[...VESSEL_STATUTORY_CERT_TYPES, 'DOCUMENT_OF_COMPLIANCE'].map((t): Row => [`CERT-${t === 'DOCUMENT_OF_COMPLIANCE' ? 'DOC' : t.replace(/_/g, '-')}`, `${CERT_LABEL[t]} — issue or renew`, `${INSTRUMENT_TYPE_LABEL[t][1]} — إصدار أو تجديد`, 1, 'Certification',
      t === 'DOCUMENT_OF_COMPLIANCE' ? 'COMPANY' : 'VESSEL', t, FEES.statutory[0], FEES.statutory[1], FEES.statutory[2], false, CERT_DOCS[t] ?? ['Survey report', 'Previous certificate', 'Class status report'],
      t === 'DOCUMENT_OF_COMPLIANCE' ? [['fleetSize', 'Ships in the fleet', 'عدد السفن في الأسطول', 'number', true, []], ['shipTypes', 'Ship types operated', 'أنواع السفن المشغلة', 'textarea', true, []]] : SURVEY_FIELDS]),
    ...COMPANY_LICENSE_TYPES.filter((t) => t !== 'DOCUMENT_OF_COMPLIANCE').map((t): Row => [`FAC-${t.replace(/_/g, '-')}`, `${INSTRUMENT_TYPE_LABEL[t][0]} — application`, `${INSTRUMENT_TYPE_LABEL[t][1]} — طلب`, 7, 'Licensing', 'COMPANY', t, FEES.company[0], FEES.company[1], FEES.company[2], false, COMPANY_DOCS, COMPANY_FIELDS]),
  ];
  return rows.map(([code, name, nameAr, domain, category, subjectKind, issuesInstrument, feeAed, feeInr, slaDays, autoApprovable, docs, fields]) => {
    const fee = ae ? feeAed : feeInr; const app = Math.round(fee * 0.3);
    return {
      id: stableId('service', code), code, key: code.toLowerCase().replace(/-/g, '.'), name, nameAr: ae ? nameAr : undefined, domain, category, subjectKind, subjectRequired: true, issuesInstrument,
      description: CONVENTION[issuesInstrument] ? `${name}, issued under ${CONVENTION[issuesInstrument]}.` : `${name} under the authority's ${subjectKind.replace(/_/g, ' ').toLowerCase()} mandate.`,
      formFields: fields.map(([key, label, labelAr, type, required, options]) => ({ key, label, labelAr: ae ? labelAr : undefined, type, options, required, help: '' })),
      requiredDocuments: docs.map((d, i) => ({ key: `doc${i + 1}`, label: d, labelAr: undefined, mandatory: i < 2, acceptedFormats: 'PDF, JPG, PNG' })),
      stages: stagesFor(slaDays, ae), feeLines: fee ? [{ code: 'APP', label: 'Application fee', labelAr: ae ? 'رسم الطلب' : undefined, amount: app }, { code: 'ISS', label: 'Issue fee', labelAr: ae ? 'رسم الإصدار' : undefined, amount: fee - app }] : [],
      fee: { amount: fee, currency: j.currency.code }, slaDays, autoApprovable, active: true, version: 1, status: 'PROMOTED',
    };
  });
}

/** ~200 applications: every issued instrument has the application it came from, and a live desk of open, refused and withdrawn work. */
export function buildServiceRequests(rng: Prng, profile: string, defs: WorldServiceDefinition[], licences: WorldLicence[], users: WorldUser[], companies: WorldCompany[], vessels: WorldVessel[], seafarers: WorldSeafarer[], berths: WorldBerth[], now: Date): WorldServiceRequest[] {
  const j = getJurisdiction(profile); const currency = j.currency.code;
  const agentUser = usersByRole(users, 'Shipping Agent')[0]; const registrar = usersByRole(users, 'Registrar of Ships')[0]; const surveyor = usersByRole(users, 'Marine Surveyor')[0]; const approver = usersByRole(users, 'Approver')[0]; const pfso = userNamed(users, /PFSO/) ?? registrar;
  const byCode = new Map(companies.map((c) => [c.code, c])); const vById = new Map(vessels.map((v) => [v.id, v])); const sById = new Map(seafarers.map((s) => [s.id, s])); const cById = new Map(companies.map((c) => [c.id, c])); const bById = new Map(berths.map((b) => [b.id, b]));
  const assignee = (kind: SubjectKind) => (kind === 'VESSEL' ? registrar : kind === 'SEAFARER' ? surveyor : kind === 'PORT_FACILITY' ? pfso : approver ?? registrar);
  const applicantFor = (kind: SubjectKind, id: string | null): WorldServiceRequest['applicant'] => {
    if (kind === 'VESSEL') { const v = id ? vById.get(id) : undefined; const agent = v ? byCode.get(v.agentCode) : undefined; return { userId: agentUser?.id ?? null, name: agentUser?.name ?? 'Agent', email: agentUser?.email ?? '', phone: agentUser?.phone ?? '', organisation: agent?.name ?? '', organisationCode: agent?.code ?? '' }; }
    if (kind === 'SEAFARER') { const s = id ? sById.get(id) : undefined; // a seafarer applies for themselves: there is no company behind them, and so no company may read it
    return { userId: null, name: s?.name ?? '', email: s?.email ?? '', phone: s?.phone ?? '', organisation: 'Self', organisationCode: '' }; }
    if (kind === 'PORT_FACILITY') { const b = id ? bById.get(id) : undefined; const op = companies.find((c) => c.category === 'TERMINAL_OPERATOR' && (/Container/.test(b?.terminal ?? '') ? c.code === 'CTO' : /Liquid|SPM/.test(b?.terminal ?? '') ? c.code === 'LTO' : c.code === 'BTO')); return { userId: null, name: op?.contactName ?? 'PFSO', email: op?.contactEmail ?? '', phone: op?.contactPhone ?? '', organisation: op?.name ?? '', organisationCode: op?.code ?? '' }; }
    const c = id ? cById.get(id) : undefined; return { userId: null, name: c?.contactName ?? 'Designated Person Ashore', email: c?.contactEmail ?? '', phone: c?.contactPhone ?? '', organisation: c?.name ?? '', organisationCode: c?.code ?? '' };
  };
  const docsFor = (def: WorldServiceDefinition, at: Date, verified: boolean): WorldRequestDoc[] => def.requiredDocuments.map((d) => ({ key: d.key, label: d.label, fileName: `${d.key}.pdf`, uploadedAt: iso(at), verified, verifiedBy: verified ? 'Registry' : '', verifiedAt: verified ? iso(at.getTime() + 2 * D) : null, notes: '' }));
  const out: WorldServiceRequest[] = [];
  const push = (def: WorldServiceDefinition, kind: SubjectKind, subjectId: string | null, subjectModel: WorldServiceRequest['subjectModel'], subjectLabel: string, status: RequestStatus, created: Date, submitted: Date | null, closed: Date | null, formData: Record<string, unknown>, instrument?: WorldLicence) => {
    const app = applicantFor(kind, subjectId); const who = assignee(kind);
    const timeline: WorldHistoryEntry[] = [hist('', 'DRAFT', created, app.name, 'Application started')];
    if (submitted) timeline.push(hist('DRAFT', 'SUBMITTED', submitted, app.name, 'Application lodged'));
    if (submitted && !['SUBMITTED', 'DRAFT'].includes(status) && status !== 'WITHDRAWN') timeline.push(hist('SUBMITTED', 'UNDER_ASSESSMENT', submitted.getTime() + D, who.name));
    if (status === 'INFO_REQUESTED') timeline.push(hist('UNDER_ASSESSMENT', 'INFO_REQUESTED', submitted!.getTime() + 2 * D, who.name, 'Insurance certificate illegible — please resubmit'));
    if (status === 'WITHDRAWN') timeline.push(hist(submitted ? 'SUBMITTED' : 'DRAFT', 'WITHDRAWN', closed ?? created, app.name, 'Withdrawn by the applicant'));
    if (status === 'REJECTED') timeline.push(hist('UNDER_ASSESSMENT', 'REJECTED', closed!, who.name, 'Evidence incomplete at the date of assessment'));
    if (status === 'APPROVED' || status === 'ISSUED') timeline.push(hist('UNDER_ASSESSMENT', 'APPROVED', new Date(closed!.getTime() - D), who.name, 'Assessment satisfactory'));
    if (status === 'ISSUED') timeline.push(hist('APPROVED', 'ISSUED', closed!, who.name, instrument ? `${instrument.licenseNo} issued` : 'Instrument issued'));
    const decided = status === 'ISSUED' || status === 'APPROVED' || status === 'REJECTED';
    out.push({ id: '', requestNo: '', serviceId: def.id, serviceCode: def.code, serviceName: def.name, domain: def.domain, applicant: app, subjectKind: kind, subjectId, subjectModel, subjectLabel, formData,
      documents: docsFor(def, submitted ?? created, status === 'ISSUED' || status === 'APPROVED'), status, currentStage: status === 'DRAFT' || status === 'SUBMITTED' ? 'SCREENING' : status === 'UNDER_ASSESSMENT' || status === 'INFO_REQUESTED' ? 'TECHNICAL' : 'APPROVAL',
      assignedToId: status === 'DRAFT' ? null : who.id, assignedTo: status === 'DRAFT' ? '' : who.name, checks: instrument?.issueChecks ?? [],
      decision: decided ? { outcome: status === 'REJECTED' ? 'REJECTED' : 'APPROVED', by: who.name, at: iso(closed!), reason: status === 'REJECTED' ? 'Evidence incomplete at the date of assessment' : '', automated: def.autoApprovable && status !== 'REJECTED' } : null,
      issuedInstrumentId: instrument?.id ?? null, issuedInstrumentNo: instrument?.licenseNo ?? '', fee: { amount: def.fee.amount, currency, paid: status === 'ISSUED' || status === 'APPROVED', paidAt: status === 'ISSUED' || status === 'APPROVED' ? iso(submitted ?? created) : null, reference: status === 'ISSUED' ? `RCPT/${yearOf(submitted ?? created)}/${1000 + out.length}` : '' },
      createdAt: iso(created), submittedAt: submitted ? iso(submitted) : null, dueAt: submitted ? iso(submitted.getTime() + def.slaDays * D) : null, closedAt: closed ? iso(closed) : null, timeline });
  };
  // the applications behind the issued instruments, so the desk shows the route a certificate actually took
  const defByInstrument = new Map(defs.filter((d) => d.issuesInstrument).map((d) => [d.issuesInstrument, d])); let statutorySeen = 0; let seafarerSeen = 0;
  for (const l of licences) {
    if (!['ISSUED', 'SUSPENDED', 'REVOKED'].includes(l.status) || !l.issueDate || !l.subjectId) continue;
    const def = defByInstrument.get(l.entityType); if (!def) continue;
    // the desk keeps the first eighteen statutory surveys and every second seafarer certificate; the rest predate the portal
    if (l.subjectKind === 'VESSEL' && CERT_LABEL[l.entityType]) { statutorySeen += 1; if (statutorySeen > 18) continue; }
    if (l.subjectKind === 'SEAFARER') { seafarerSeen += 1; if (seafarerSeen % 2 === 0) continue; }
    const submitted = new Date(l.appliedDate); const issuedAt = l.history.find((h) => h.to === 'ISSUED')?.at ?? l.issueDate;
    push(def, l.subjectKind, l.subjectId, l.subjectModel, l.entityName, 'ISSUED', new Date(submitted.getTime() - D), submitted, new Date(issuedAt), CERT_LABEL[l.entityType] ? { surveyPort: rng.pick(['Khalifa Port', 'Jebel Ali', 'Fujairah']), surveyDate: l.issueDate, recognisedOrganisation: rng.pick(ROS) } : { note: 'Lodged through the portal' }, l);
  }
  // the live desk across every domain
  const pool: RequestStatus[] = ['DRAFT', 'SUBMITTED', 'SUBMITTED', 'UNDER_ASSESSMENT', 'UNDER_ASSESSMENT', 'INFO_REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'UNDER_ASSESSMENT'];
  const fleet = vessels.filter((v) => !v.real); const fictionalCos = companies.filter((c) => !c.real); const operational = berths.filter((b) => b.status === 'OPERATIONAL');
  const openDefs = defs.filter((d) => !CERT_LABEL[d.issuesInstrument] || d.domain !== 1);
  for (let k = 0; k < 72; k++) {
    const def = openDefs[(k * 7) % openDefs.length]; const status = pool[k % pool.length]; const kind = def.subjectKind;
    const [subjectId, subjectModel, subjectLabel]: [string, WorldServiceRequest['subjectModel'], string] = kind === 'VESSEL' ? (() => { const v = rng.pick(fleet); return [v.id, 'Vessel', `${v.name} (IMO ${v.imo})`] as [string, 'Vessel', string]; })()
      : kind === 'SEAFARER' ? (() => { const s = rng.pick(seafarers); return [s.id, 'Seafarer', `${s.name} (CDC ${s.cdcNo})`] as [string, 'Seafarer', string]; })()
      : kind === 'PORT_FACILITY' ? (() => { const b = rng.pick(operational); return [b.id, 'Berth', `${b.name} (${b.code})`] as [string, 'Berth', string]; })()
      : (() => { const c = kind === 'MET_INSTITUTION' ? (fictionalCos.find((x) => x.category === 'INSTITUTE') ?? rng.pick(fictionalCos)) : rng.pick(fictionalCos); return [c.id, 'Company', c.name] as [string, 'Company', string]; })();
    const closedStatus = ['APPROVED', 'REJECTED', 'WITHDRAWN'].includes(status);
    // open work is recent, with a couple deliberately past due so the SLA breach path has something in it; closed work spreads across the history
    const submitted = status === 'DRAFT' ? null : closedStatus ? new Date(now.getTime() - rng.int(25, 500) * D) : new Date(now.getTime() - rng.int(1, Math.round(def.slaDays * 1.4)) * D);
    const created = new Date((submitted ?? new Date(now.getTime() - rng.int(1, 5) * D)).getTime() - D);
    const closed = closedStatus ? new Date((submitted ?? created).getTime() + rng.int(3, def.slaDays + 6) * D) : null;
    push(def, kind, subjectId, subjectModel, subjectLabel, status, created, submitted, closed, Object.fromEntries(def.formFields.map((f) => [f.key, f.type === 'number' ? rng.int(1, 12) : f.type === 'select' ? f.options[0] ?? '' : f.type === 'date' ? iso(now.getTime() + rng.int(1, 30) * D) : 'As stated in the application'])));
  }
  const seq = makeSeries();
  out.sort((a, b) => (a.submittedAt ?? a.createdAt).localeCompare(b.submittedAt ?? b.createdAt)).forEach((r) => { const y = yearOf(r.submittedAt ?? r.createdAt); r.requestNo = `SR-${y}-${seq(String(y), 5)}`; r.id = stableId('request', r.requestNo); });
  return out;
}
