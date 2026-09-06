import { INSTRUMENT_CLASS_BY_TYPE, LICENSE_TYPES_BY_SUBJECT, SUBJECT_KINDS, type SubjectKind } from '@maritime/contracts';
import type { AiGatewayClient } from '@maritime/service-kit';
import type { Citation, Row } from './tools';

/* Drafting a service definition for the Service Studio.
 *
 * An officer describes a service in plain language — who applies, what they must lodge, what it costs, how long
 * a decision takes, what is issued and for how long — and the composer turns that into the definition the
 * runtime executes: key and code, names in both languages, subject kind, category and domain, the document
 * checklist, the fee lines, the service level, the outputs. The standard workflow (submit → screening →
 * assessment → decision → issue) applies unless the definition later says otherwise.
 *
 * Nothing is invented and nothing is created here. Every value the composer inferred says which words it read
 * it from; every value it could not infer is listed as a gap with its default, so the person reviewing the
 * proposal knows what to fill in. The Studio creates the definition as a DEV draft only when that person says
 * so, through the runtime's own create path, and review, approval, publication and promotion apply unchanged.
 *
 * An existing definition may serve as the template — named, or found in the catalogue by the words the two
 * share — and is read through the tool gateway as the officer asking, never from the assistant's own tables. */

export interface DefinitionDraftInput { description: string; name?: string; basedOn?: string; subjectKind?: string; category?: string; language?: 'en' | 'ar' }
export interface DefinitionDraftReader { gateway?: AiGatewayClient; userToken?: string }

export interface DraftField { key: string; label: string; labelAr: string; type: 'text' | 'number' | 'date' | 'select' | 'boolean'; required: boolean; options: string[]; section: string; help: string; helpAr?: string | null; multiline: boolean; lookup?: string | null }
export interface DraftDocument { code: string; label: string; labelAr: string; required: boolean; docType: string; acceptedFormats: string }
export interface DraftFeeLine { code: string; description: string; descriptionAr: string; amount: number; taxable: boolean }
export interface DraftContent {
  form: { fields: DraftField[]; sections: { key: string; label: string; labelAr: string }[] };
  documents: DraftDocument[];
  fees: { lines: DraftFeeLine[]; currency: string };
  sla: { days: number };
  outputs: { instrumentType: string | null; instrumentClass: string | null; validityMonths: number | null; notifications: never[]; templates: never[] };
}
export interface Inference { field: string; value: string; evidence: string }
export interface Note { en: string; ar: string }
export interface Template { id: string; key: string; name: string; nameAr?: string | null; category?: string | null; categoryAr?: string | null; domain?: number | null; subjectKind?: string | null; issuesInstrument?: string | null; description?: string | null; content?: Partial<DraftContent> | null }
export interface DefinitionDraft {
  key: string; code: string; name: string; nameAr: string; category: string; categoryAr: string; domain: number; subjectKind: string;
  description: string; descriptionAr: string | null; issuesInstrument: string | null; autoApprovable: false; changeNote: string;
  content: DraftContent;
  basedOn: { id: string; key: string; name: string } | null;
  inferred: Inference[]; gaps: Note[]; engine: string; citations: Citation[];
}

/* ------------------------------------------------------------------------------------------------ lexicons */

const CATEGORY_AR: Record<string, string> = {
  Registration: 'التسجيل', Licensing: 'الترخيص', Certification: 'الشهادات', Seafarers: 'البحارة', Accreditation: 'الاعتماد', Legislation: 'التشريعات',
  'Maritime centre': 'المركز البحري', Inspection: 'التفتيش', Security: 'الأمن', 'Port services': 'خدمات الموانئ', General: 'عام',
};
const DOMAIN_BY_SUBJECT: Record<string, number> = { VESSEL: 1, SEAFARER: 2, MET_INSTITUTION: 2, COMPANY: 7, PORT_FACILITY: 7, NONE: 0 };
const DOMAIN_BY_CATEGORY: Record<string, number> = { Inspection: 5, 'Port services': 6, Legislation: 3, 'Maritime centre': 4 };
const KEY_PREFIX: Record<string, string> = { VESSEL: 'vessel', SEAFARER: 'seafarer', MET_INSTITUTION: 'met', COMPANY: 'company', PORT_FACILITY: 'facility', NONE: 'general' };

/** The words that name each kind of applicant. Counted, then the applicant phrase and the instrument named settle ties. */
const SUBJECT_WORDS: [RegExp, SubjectKind][] = [
  [/\b(?:met\s+|maritime\s+)?(?:institut|academ|training\s+(?:centre|center|provider)|college)/g, 'MET_INSTITUTION'],
  [/\bport\s+facilit|\bterminal|\bjett|\bmarina|\bberth\s+operator|\bfacilit/g, 'PORT_FACILITY'],
  [/\bseafarer|\bcrew\b|\bmaster\b|\bofficer|\bratings?\b|\bcadet|\bmariner|\bseam[ae]n/g, 'SEAFARER'],
  [/\bvessel|\bships?\b|\bcraft\b|\bboat|\byacht|\btanker|\bbarge|\btugs?\b/g, 'VESSEL'],
  [/\bcompan|\bagen(?:t|cy|cies)\b|\bchandler|\bcontractor|\boperator|\bfirm\b|\bsupplier|\bbusiness|\blicensee|\byard\b|\bprovider|\borganis?z?ation/g, 'COMPANY'],
];
/** "for a ship chandler to …", "by a deck officer;": up to three words after the article, closed by a verb, a comma or the end. */
const APPLICANT_PHRASE = /\b(?:for|by|from|of)\s+(?:a|an|the|any|each|every)\s+([a-z-]+(?:\s+[a-z-]+){0,2}?)(?:\s+(?:to|who|which|that|wishing|seeking|operating|applying|holding|providing|supplying|carrying|serving)\b|\s*[,.;:]|$)/;

/** The instrument a description names, most specific phrase first; the type carries its subject kind and class. */
const INSTRUMENT_WORDS: [RegExp, string][] = [
  [/\bbunker\s+liability|\bbunkers\s+convention/, 'BUNKER_LIABILITY_CERTIFICATE'], [/\bwreck\s+removal/, 'WRECK_REMOVAL_LIABILITY'], [/\bcivil\s+liability|\bclc\b/, 'CIVIL_LIABILITY_CERTIFICATE'],
  [/\bsafety\s+construction/, 'CARGO_SHIP_SAFETY_CONSTRUCTION'], [/\bsafety\s+equipment/, 'CARGO_SHIP_SAFETY_EQUIPMENT'], [/\bsafety\s+radio/, 'CARGO_SHIP_SAFETY_RADIO'], [/\bload\s+line/, 'INTERNATIONAL_LOAD_LINE'],
  [/\biopp\b|\boil\s+pollution/, 'IOPP_CERTIFICATE'], [/\biapp\b|\bair\s+pollution/, 'IAPP_CERTIFICATE'], [/\bsewage/, 'SEWAGE_POLLUTION_PREVENTION'], [/\bsafety\s+management|\bsmc\b/, 'SAFETY_MANAGEMENT_CERTIFICATE'],
  [/\bship\s+security|\bissc\b/, 'SHIP_SECURITY_CERTIFICATE'], [/\bmaritime\s+labour|\bmlc\b/, 'MARITIME_LABOUR_CERTIFICATE'], [/\btonnage/, 'TONNAGE_CERTIFICATE'], [/\bsafe\s+manning/, 'MINIMUM_SAFE_MANNING_DOCUMENT'],
  [/\bcontinuous\s+synopsis|\bcsr\b/, 'CONTINUOUS_SYNOPSIS_RECORD'], [/\bexemption/, 'EXEMPTION_CERTIFICATE'], [/\bcertificate\s+of\s+ownership/, 'CERTIFICATE_OF_OWNERSHIP'], [/\bballast\s+water|\bbwm\b/, 'BALLAST_WATER_MANAGEMENT'],
  [/\banti.?fouling|\bafs\b/, 'ANTI_FOULING_SYSTEM'], [/\bdocument\s+of\s+compliance/, 'DOCUMENT_OF_COMPLIANCE'],
  [/\bshipping\s+agen/, 'SHIPPING_AGENCY'], [/\bbunker/, 'BUNKER_SUPPLIER'], [/\bchandl/, 'SHIP_CHANDLER'], [/\brepair\s+yard|\bshipyard|\bship\s+repair/, 'REPAIR_YARD'], [/\bmanning\s+agen|\bcrewing\s+agen/, 'MANNING_AGENCY'],
  [/\bsurveyor/, 'MARINE_SURVEYOR'], [/\btraining\s+(?:institute|centre|center|provider)/, 'TRAINING_INSTITUTE'], [/\bstevedor/, 'STEVEDORE'], [/\bdiving/, 'DIVING_CONTRACTOR'], [/\bship\s+management/, 'SHIP_MANAGEMENT'],
  [/\bmarina|\bjetty/, 'MARINA_OR_JETTY'], [/\brecogni[sz]ed\s+organi[sz]ation/, 'RECOGNISED_ORGANISATION'], [/\bcompass/, 'COMPASS_CALIBRATION'], [/\blife.?saving|\blsa\b|\bliferaft/, 'LSA_SERVICING'],
  [/\bfire.?fighting|\bffa\b|\bextinguisher/, 'FFA_SERVICING'], [/\bsmall\s+vessel\s+survey/, 'SMALL_VESSEL_SURVEY'], [/\bpest|\bderatt|\bfumigat/, 'PEST_CONTROL'], [/\btowage|\btugs?\b/, 'TOWAGE_CERTIFICATION'],
  [/\bisps\b|\bstatement\s+of\s+compliance|\bport\s+facility\s+security/, 'ISPS'],
  [/\bnavigation\s+licen[cs]e/, 'NAVIGATION_LICENCE'], [/\bforeign(?:-|\s+)(?:flag(?:ged)?\s+)?vessel/, 'FOREIGN_VESSEL_PERMIT'],
  [/\bcompetenc/, 'CERTIFICATE_OF_COMPETENCY'], [/\bproficienc/, 'CERTIFICATE_OF_PROFICIENCY'], [/\bflag\s+state\s+endorsement/, 'FLAG_STATE_ENDORSEMENT'], [/\breceipt\s+of\s+application/, 'CERTIFICATE_OF_RECEIPT_OF_APPLICATION'],
  [/\bseam[ae]n'?s?\s+(?:card|book)|\bseafarer\s+identity/, 'SEAMAN_CARD'], [/\bgmdss/, 'GMDSS_CERTIFICATE'], [/\bmedical\s+fitness/, 'MEDICAL_FITNESS_CERTIFICATE'],
  [/\bmet\s+institution|\binstitution\s+accreditation/, 'MET_INSTITUTION_ACCREDITATION'], [/\bprogramme?\s+approval|\bcourse\s+approval/, 'MET_PROGRAMME_APPROVAL'],
  [/\bno.?objection|\bnoc\b/, 'VESSEL_NOC'],
];
const CLASS_WORDS: [RegExp, string][] = [
  [/\baccreditation|\baccredit/, 'ACCREDITATION'], [/\bendorsement|\bendorse/, 'ENDORSEMENT'], [/\bno.?objection|\bnoc\b/, 'NOC'], [/\bpermit/, 'PERMIT'], [/\blicen[cs]e|\blicensing/, 'LICENCE'], [/\bcertificate|\bcertification|\bcertif/, 'CERTIFICATE'],
];

/** The documents a description asks for: the phrase, then the checklist entry it becomes. */
const DOCUMENT_WORDS: [RegExp, string, string, string][] = [
  [/\btrade\s+licen[cs]e|\bcommercial\s+licen[cs]e|\bbusiness\s+licen[cs]e/, 'TRADE_LICENCE', 'Trade licence', 'الرخصة التجارية'],
  [/\binsurance/, 'INSURANCE', 'Insurance certificate', 'شهادة التأمين'],
  [/\bcertificate\s+of\s+registry|\bregistration\s+certificate|\bregistry\s+certificate/, 'CERT_REGISTRY', 'Certificate of registry', 'شهادة التسجيل'],
  [/\bcrew\s+list/, 'CREW_LIST', 'Crew list', 'قائمة الطاقم'],
  [/\bpassport(?!\s+(?:photo|size|-size))/, 'PASSPORT', 'Passport copy', 'نسخة جواز السفر'],
  [/\bemirates\s+id|\bnational\s+id|\bidentity\s+card|\bid\s+card/, 'ID_CARD', 'Identity card', 'بطاقة الهوية'],
  [/\bmedical\s+(?:certificate|fitness|report)/, 'MEDICAL', 'Medical fitness certificate', 'شهادة اللياقة الطبية'],
  [/\bcertificate\s+of\s+competency|\bcoc\b/, 'COC', 'Certificate of competency', 'شهادة الكفاءة'],
  [/\bclass(?:ification)?\s+(?:certificate|status)/, 'CLASS_CERT', 'Classification certificate', 'شهادة التصنيف'],
  [/\btonnage\s+certificate/, 'TONNAGE_CERT', 'Tonnage certificate', 'شهادة الحمولة'],
  [/\bsafety\s+management\s+certificate|\bsmc\b/, 'SMC', 'Safety management certificate', 'شهادة إدارة السلامة'],
  [/\bsecurity\s+plan|\bssp\b|\bpfsp\b/, 'SECURITY_PLAN', 'Security plan', 'خطة الأمن'],
  [/\bbill\s+of\s+sale/, 'BILL_OF_SALE', 'Bill of sale', 'عقد البيع'],
  [/\bbuilder'?s\s+certificate/, 'BUILDER_CERT', "Builder's certificate", 'شهادة البناء'],
  [/\bdeletion\s+certificate/, 'DELETION_CERT', 'Deletion certificate', 'شهادة الشطب'],
  [/\bphotograph|\bphotos?\b/, 'PHOTO', 'Photograph', 'صورة'],
  [/\bstcw|\btraining\s+certificate|\btraining\s+record/, 'STCW_CERT', 'STCW training certificate', 'شهادة تدريب STCW'],
  [/\bvehicle/, 'VEHICLE_LIST', 'Vehicle list', 'قائمة المركبات'],
  [/\bstaff\s+list|\blist\s+of\s+staff|\bpersonnel\s+list|\bemployee\s+list|\bqualified\s+staff|\bqualifications\s+of\s+staff/, 'STAFF_LIST', 'Staff list with qualifications', 'قائمة الموظفين ومؤهلاتهم'],
  [/\bundertaking|\bdeclaration/, 'UNDERTAKING', 'Signed undertaking', 'تعهد موقّع'],
  [/\bpower\s+of\s+attorney/, 'POA', 'Power of attorney', 'وكالة قانونية'],
  [/\bproof\s+of\s+payment|\bpayment\s+receipt/, 'RECEIPT', 'Proof of payment', 'إثبات الدفع'],
  [/\bdrawings?\b|\bplans\b|\bgeneral\s+arrangement/, 'DRAWINGS', 'Plans and drawings', 'المخططات والرسومات'],
  [/\bmanual/, 'MANUAL', 'Operating manual', 'دليل التشغيل'],
  [/\bsurvey\s+report|\binspection\s+report/, 'SURVEY_REPORT', 'Survey report', 'تقرير المعاينة'],
  [/\blease|\btenancy/, 'LEASE', 'Lease agreement', 'عقد الإيجار'],
  [/\bcompany\s+profile|\borgani[sz]ation\s+chart/, 'COMPANY_PROFILE', 'Company profile', 'ملف الشركة'],
  [/\bcalibration\s+(?:certificate|record)/, 'CALIBRATION', 'Calibration records', 'سجلات المعايرة'],
  [/\bequipment\s+list|\blist\s+of\s+equipment/, 'EQUIPMENT_LIST', 'Equipment list', 'قائمة المعدات'],
  [/\bprevious\s+(?:certificate|licen[cs]e)|\bexisting\s+(?:certificate|licen[cs]e)/, 'PREVIOUS_INSTRUMENT', 'Previous certificate or licence', 'الشهادة أو الرخصة السابقة'],
  [/\bno.?objection\s+(?:certificate|letter)|\bnoc\s+from/, 'NOC', 'No-objection certificate', 'شهادة عدم ممانعة'],
];

/** English phrases and words as they read in an Arabic service name; longest phrase wins at each position. */
const AR_PHRASES: [string, string][] = [
  ['ship chandler', 'مورّد السفن'], ['shipping agency', 'وكالة ملاحية'], ['shipping agent', 'وكيل ملاحي'], ['bunker supplier', 'مورّد وقود السفن'], ['repair yard', 'حوض إصلاح'], ['manning agency', 'وكالة تزويد الطواقم'],
  ['marine surveyor', 'مساح بحري'], ['training institute', 'معهد تدريب'], ['diving contractor', 'مقاول غوص'], ['ship management', 'إدارة السفن'], ['port facility', 'منشأة مينائية'], ['pest control', 'مكافحة الآفات'],
  ['compass calibration', 'معايرة البوصلة'], ['navigation licence', 'رخصة الملاحة'], ['foreign vessel', 'سفينة أجنبية'], ['no objection certificate', 'شهادة عدم ممانعة'], ['certificate of competency', 'شهادة الكفاءة'],
  ['certificate of proficiency', 'شهادة الأهلية'], ['medical fitness', 'اللياقة الطبية'], ['seaman card', 'بطاقة البحّار'], ['load line', 'خط الشحن'], ['safety management', 'إدارة السلامة'], ['ship security', 'أمن السفينة'],
  ['maritime labour', 'العمل البحري'], ['safe manning', 'التطقيم الآمن'], ['ballast water', 'مياه الصابورة'], ['anti-fouling', 'مانع الحشف'], ['wreck removal', 'إزالة الحطام'], ['civil liability', 'المسؤولية المدنية'],
  ['provisional registration', 'التسجيل المؤقت'], ['permanent registration', 'التسجيل الدائم'], ['prior approval', 'الموافقة المسبقة'],
  ['registration', 'تسجيل'], ['renewal', 'تجديد'], ['amendment', 'تعديل'], ['approval', 'اعتماد'], ['accreditation', 'اعتماد'], ['authorisation', 'تفويض'], ['authorization', 'تفويض'], ['licence', 'رخصة'], ['license', 'رخصة'],
  ['licensing', 'ترخيص'], ['permit', 'تصريح'], ['certificate', 'شهادة'], ['certification', 'شهادة'], ['endorsement', 'تصديق'], ['exemption', 'إعفاء'], ['inspection', 'تفتيش'], ['survey', 'معاينة'], ['audit', 'تدقيق'],
  ['towage', 'القطر'], ['tug', 'قاطرة'], ['tugs', 'قاطرات'], ['pilotage', 'الإرشاد'], ['bunkering', 'التزويد بالوقود'], ['provisions', 'المؤن'], ['supply', 'توريد'], ['stores', 'المستلزمات'], ['diving', 'الغوص'], ['dredging', 'التجريف'],
  ['vessel', 'سفينة'], ['vessels', 'السفن'], ['ship', 'سفينة'], ['ships', 'السفن'], ['yacht', 'يخت'], ['yachts', 'اليخوت'], ['boat', 'قارب'], ['boats', 'القوارب'], ['crew', 'طاقم'], ['seafarer', 'بحّار'], ['seafarers', 'البحارة'],
  ['company', 'شركة'], ['companies', 'الشركات'], ['agent', 'وكيل'], ['agents', 'الوكلاء'], ['operator', 'مشغّل'], ['operators', 'المشغّلون'], ['contractor', 'مقاول'], ['contractors', 'المقاولون'], ['supplier', 'مورّد'], ['suppliers', 'الموردون'],
  ['facility', 'منشأة'], ['facilities', 'المنشآت'], ['terminal', 'محطة'], ['marina', 'مرسى'], ['jetty', 'رصيف'], ['berth', 'رصيف'], ['port', 'ميناء'], ['ports', 'الموانئ'], ['harbour', 'ميناء'], ['institute', 'معهد'], ['institution', 'مؤسسة'],
  ['programme', 'برنامج'], ['program', 'برنامج'], ['course', 'دورة'], ['training', 'تدريب'], ['application', 'طلب'], ['annual', 'سنوي'], ['temporary', 'مؤقت'], ['provisional', 'مؤقت'], ['new', 'جديد'], ['foreign', 'أجنبي'],
  ['alongside', 'بجانب الرصيف'], ['at', 'في'], ['in', 'في'], ['and', 'و'], ['of', ''], ['for', ''], ['a', ''], ['an', ''], ['the', ''], ['to', ''], ['with', 'مع'], ['or', 'أو'],
];
const HEAD_NOUNS = new Set(['approval', 'accreditation', 'authorisation', 'authorization', 'licence', 'license', 'licensing', 'permit', 'certificate', 'certification', 'endorsement', 'exemption', 'registration', 'renewal', 'amendment', 'inspection', 'survey', 'audit', 'application']);
const NUMBER_WORDS: Record<string, number> = { one: 1, a: 1, an: 1, two: 2, three: 3, four: 4, five: 5, six: 6, ten: 10 };
const STOP = new Set(['for', 'a', 'an', 'the', 'to', 'of', 'at', 'in', 'on', 'by', 'and', 'or', 'with', 'from', 'who', 'that', 'which', 'is', 'are', 'be', 'as', 'its', 'their', 'this', 'any', 'each']);

/* ------------------------------------------------------------------------------------------------ helpers */

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const cap = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const words = (s: string) => s.toLowerCase().split(/[^a-z0-9']+/).filter(Boolean);
/** The first clause of the description — the sentence that names the service. */
const firstClause = (text: string) => text.split(/(?<=[a-z0-9)])[.;:](?=\s|$)|\s+[—–-]\s+|,\s+(?=(?:it|which|who|that|needs?|requires?|requiring|needing|fee|fees|cost|decision|decided|valid|with)\b)/i)[0].trim();
const arabicName = (name: string) => {
  const ws = words(name.replace(/[—–-]/g, ' ')); const out: string[] = []; let head = '';
  for (let i = 0; i < ws.length;) {
    let hit: [string, string] | undefined; let len = 0;
    for (const p of AR_PHRASES) { const pw = p[0].split(' '); if (pw.length > len && ws.slice(i, i + pw.length).join(' ') === p[0]) { hit = p; len = pw.length; } }
    if (!hit) { out.push(ws[i]); i += 1; continue; }
    if (i + len === ws.length && HEAD_NOUNS.has(hit[0]) && !head) head = hit[1]; else if (hit[1]) out.push(hit[1]);
    i += len;
  }
  return [head, ...out].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
};
const hasLatin = (s: string) => /[A-Za-z]/.test(s);

/* ------------------------------------------------------------------------------------------------ the composer */

/**
 * Composes the definition from the description and, when one is given, the template. Pure: the same words
 * always give the same definition, which is what makes the proposal reviewable and testable.
 */
export function composeDefinition(input: DefinitionDraftInput, template: Template | null = null): DefinitionDraft {
  const text = input.description.replace(/\s+/g, ' ').trim(); const lc = text.toLowerCase();
  const inferred: Inference[] = []; const gaps: Note[] = [];
  const infer = (field: string, value: string, evidence: string) => inferred.push({ field, value, evidence });
  const gap = (en: string, ar: string) => gaps.push({ en, ar });

  // the name: given, or the first clause of the description
  const clause = firstClause(text);
  const name = cap((input.name?.trim() || clause).replace(/\s+/g, ' ').slice(0, 120).trim());
  if (!input.name?.trim()) infer('name', name, clause);
  const nameLc = name.toLowerCase();

  // the instrument named, and its class
  let instrumentType: string | null = null; let instrumentEvidence = '';
  for (const [re, type] of INSTRUMENT_WORDS) { const m = lc.match(re); if (m) { instrumentType = type; instrumentEvidence = m[0]; break; } }
  let instrumentClass: string | null = null;
  for (const [re, cls] of CLASS_WORDS) { const m = nameLc.match(re) ?? lc.match(re); if (m) { instrumentClass = cls; if (!instrumentEvidence) instrumentEvidence = m[0]; break; } }

  // the applicant: stated, then the phrase "for a …", then the instrument's own subject, then the words counted
  const counts = new Map<SubjectKind, number>(); const evidence = new Map<SubjectKind, string>();
  for (const [re, kind] of SUBJECT_WORDS) { const ms = lc.match(re) ?? []; if (ms.length) { counts.set(kind, ms.length); evidence.set(kind, ms[0] ?? ''); } }
  let subjectKind: string = 'NONE'; let subjectEvidence = '';
  const stated = String(input.subjectKind ?? '').toUpperCase();
  if ((SUBJECT_KINDS as readonly string[]).includes(stated)) subjectKind = stated;
  else {
    const phrase = lc.match(APPLICANT_PHRASE)?.[1];
    if (phrase && !HEAD_NOUNS.has(phrase.split(/\s+/)[0])) {
      // the head noun of the applicant phrase decides ("ship chandler" is a company, "deck officer" a seafarer); the whole phrase only when the head says nothing
      const head = phrase.trim().split(/\s+/).pop() ?? '';
      for (const probe of [head, phrase]) { for (const [re, kind] of SUBJECT_WORDS) if (new RegExp(re.source).test(probe)) { subjectKind = kind; subjectEvidence = phrase; break; } if (subjectKind !== 'NONE') break; }
    }
    if (subjectKind === 'NONE' && instrumentType && instrumentType !== 'ISPS') {
      const owner = (Object.keys(LICENSE_TYPES_BY_SUBJECT) as SubjectKind[]).find((k) => LICENSE_TYPES_BY_SUBJECT[k].includes(instrumentType!));
      if (owner) { subjectKind = owner; subjectEvidence = instrumentEvidence; }
    }
    if (subjectKind === 'NONE' && counts.size) { const best = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]; subjectKind = best[0]; subjectEvidence = evidence.get(best[0]) ?? ''; }
    if (subjectKind === 'NONE' && template?.subjectKind) { subjectKind = template.subjectKind; subjectEvidence = `template ${template.key}`; }
    if (subjectKind === 'NONE') gap('Who applies is not stated; the subject kind is left as none.', 'لم يُذكر مقدّم الطلب؛ تُرك نوع الجهة فارغاً.');
    else infer('subjectKind', subjectKind, subjectEvidence);
  }
  if (instrumentType === 'ISPS') instrumentType = subjectKind === 'PORT_FACILITY' ? 'ISPS_STATEMENT_OF_COMPLIANCE' : 'PORT_FACILITY_ISPS';
  if (instrumentType) { instrumentClass = INSTRUMENT_CLASS_BY_TYPE[instrumentType] ?? instrumentClass ?? 'LICENCE'; infer('instrumentType', instrumentType, instrumentEvidence); }
  else if (instrumentClass) {
    infer('instrumentClass', instrumentClass, instrumentEvidence);
    gap(`The service issues a ${instrumentClass.toLowerCase()} that matches no type in the register; choose the instrument type in outputs before publishing.`, `تُصدر الخدمة ${instrumentClass === 'LICENCE' ? 'رخصة' : instrumentClass === 'PERMIT' ? 'تصريحاً' : instrumentClass === 'CERTIFICATE' ? 'شهادة' : 'وثيقة'} لا تطابق أي نوع في السجل؛ اختر نوع الوثيقة في المخرجات قبل النشر.`);
  }
  if (!instrumentType && template?.issuesInstrument && !instrumentClass) { instrumentType = template.issuesInstrument; instrumentClass = INSTRUMENT_CLASS_BY_TYPE[instrumentType] ?? 'LICENCE'; infer('instrumentType', instrumentType, `template ${template.key}`); }

  // category and domain
  let category = ''; let categoryEvidence = '';
  const statedCat = String(input.category ?? '').trim();
  if (statedCat && CATEGORY_AR[statedCat]) category = statedCat;
  else if (/\bregist/.test(nameLc)) { category = 'Registration'; categoryEvidence = 'regist'; }
  else if (/\binspect|\bsurvey|\baudit/.test(nameLc)) { category = 'Inspection'; categoryEvidence = nameLc.match(/\binspect\w*|\bsurvey\w*|\baudit\w*/)![0]; }
  else if (/\bisps\b|\bsecurity/.test(nameLc)) { category = 'Security'; categoryEvidence = 'security'; }
  else if (/\bpilot|\btowage|\btugs?\b|\bmooring|\bbunkering|\bport\s+service/.test(lc) && !instrumentType) { category = 'Port services'; categoryEvidence = lc.match(/\bpilot\w*|\btowage|\btugs?\b|\bmooring|\bbunkering|\bport\s+service\w*/)![0]; }
  else if (subjectKind === 'SEAFARER' || subjectKind === 'MET_INSTITUTION') { category = 'Seafarers'; categoryEvidence = subjectKind.toLowerCase(); }
  else if (instrumentClass === 'ACCREDITATION') { category = 'Accreditation'; categoryEvidence = instrumentEvidence; }
  else if (instrumentClass === 'CERTIFICATE') { category = 'Certification'; categoryEvidence = instrumentEvidence; }
  else if (instrumentClass) { category = 'Licensing'; categoryEvidence = instrumentEvidence; }
  else if (template?.category && CATEGORY_AR[template.category]) { category = template.category; categoryEvidence = `template ${template.key}`; }
  else { category = 'General'; gap('No category could be read; General is set.', 'تعذّر تحديد الفئة؛ وُضعت "عام".'); }
  if (categoryEvidence) infer('category', category, categoryEvidence);
  const domain = DOMAIN_BY_CATEGORY[category] ?? DOMAIN_BY_SUBJECT[subjectKind] ?? 0;

  // the documents the description asks for, read from the words after the name
  const rest = lc.length > clause.length + 3 ? lc.slice(clause.length) : lc;
  const documents: DraftDocument[] = []; const seen = new Set<string>();
  const found: { at: number; doc: DraftDocument; evidence: string }[] = [];
  for (const [re, code, label, labelAr] of DOCUMENT_WORDS) {
    const m = rest.match(re); if (!m || seen.has(code)) continue;
    seen.add(code);
    const at = rest.indexOf(m[0]);
    // "optional" counts only inside the same item of the list: up to the nearest comma, semicolon, full stop or "and"
    const before = rest.slice(Math.max(0, at - 40), at).split(/[,;.]|\band\b/).pop() ?? '';
    const after = rest.slice(at + m[0].length, at + m[0].length + 40).split(/[,;.]|\band\b/)[0] ?? '';
    const optional = /\boptional(?:ly)?\b|\bif\s+(?:any|available|applicable)\b|\bmay\s+(?:also\s+)?(?:attach|lodge|provide)\b/.test(`${before} ${after}`);
    found.push({ at, doc: { code, label, labelAr, required: !optional, docType: 'PDF', acceptedFormats: 'PDF, JPG, PNG' }, evidence: m[0] });
  }
  for (const f of found.sort((a, b) => a.at - b.at)) { documents.push(f.doc); infer('document', f.doc.code, f.evidence); }
  if (template?.content?.documents?.length) for (const d of template.content.documents) if (!seen.has(d.code)) { seen.add(d.code); documents.push({ ...d, required: d.required ?? true }); }
  if (!documents.length) gap('No document is named; the checklist is empty.', 'لم يُسمَّ أي مستند؛ قائمة المستندات فارغة.');

  // fees
  const lines: DraftFeeLine[] = [];
  if (/\bfree\s+of\s+charge|\bno\s+fee|\bwithout\s+(?:a\s+)?fee|\bno\s+charge/.test(lc)) infer('fees', 'none', lc.match(/\bfree\s+of\s+charge|\bno\s+fee|\bwithout\s+(?:a\s+)?fee|\bno\s+charge/)![0]);
  else {
    const amounts: { amount: number; evidence: string; kind: 'APP' | 'ISS' | 'RENEW' | null }[] = [];
    const re = /(?:\b(?:aed|dhs?\.?|dirhams?)\s*([\d,]+(?:\.\d{1,2})?))|(?:([\d,]+(?:\.\d{1,2})?)\s*(?:aed|dhs?\b|dirhams?))/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const amount = Number((m[1] ?? m[2]).replace(/,/g, '')); if (!Number.isFinite(amount) || amount <= 0 || amount > 10_000_000) continue;
      const around = text.slice(Math.max(0, m.index - 40), m.index + m[0].length + 20).toLowerCase();
      amounts.push({ amount, evidence: m[0], kind: /\bissu/.test(around) ? 'ISS' : /\brenew/.test(around) ? 'RENEW' : /\bapplication|\bprocessing|\bfiling/.test(around) ? 'APP' : null });
    }
    amounts.forEach((a, i) => {
      const kind = a.kind ?? (i === 0 ? 'APP' : i === 1 ? 'ISS' : null);
      const meta = kind === 'APP' ? ['APP', 'Application fee', 'رسم الطلب'] : kind === 'ISS' ? ['ISS', 'Issue fee', 'رسم الإصدار'] : kind === 'RENEW' ? ['RENEW', 'Renewal fee', 'رسم التجديد'] : [`FEE${i + 1}`, `Fee ${i + 1}`, `رسم ${i + 1}`];
      if (lines.some((l) => l.code === meta[0])) meta[0] = `${meta[0]}${i + 1}`;
      lines.push({ code: meta[0], description: meta[1], descriptionAr: meta[2], amount: a.amount, taxable: true });
      infer('fee', `${meta[0]} ${a.amount}`, a.evidence);
    });
    if (!lines.length && template?.content?.fees?.lines?.length) { for (const l of template.content.fees.lines) lines.push({ ...l, descriptionAr: l.descriptionAr ?? '' }); infer('fees', 'template', `template ${template.key}`); }
    if (!lines.length) gap('No fee is stated; add the fee lines or name a fee rule set.', 'لم يُذكر أي رسم؛ أضف بنود الرسوم أو سمِّ مجموعة قواعد الرسوم.');
  }

  // the service level
  let days = 0; let slaEvidence = '';
  const within = lc.match(/\b(?:within|in|inside)\s+(\d{1,3})\s+(?:working\s+|business\s+|calendar\s+)?days?\b/) ?? lc.match(/\b(\d{1,3})\s+(?:working\s+|business\s+|calendar\s+)?days?\b/);
  if (within) { days = Number(within[1]); slaEvidence = within[0]; }
  else if (/\bsame\s+day|\bimmediately|\bon\s+the\s+spot/.test(lc)) { days = 1; slaEvidence = lc.match(/\bsame\s+day|\bimmediately|\bon\s+the\s+spot/)![0]; }
  else if (template?.content?.sla?.days) { days = template.content.sla.days; slaEvidence = `template ${template.key}`; }
  if (days) infer('sla', `${days} days`, slaEvidence); else { days = 10; gap('No decision time is stated; the service level is set at 10 days.', 'لم تُذكر مدة القرار؛ وُضع مستوى الخدمة عند 10 أيام.'); }

  // validity
  let validityMonths: number | null = null;
  const validity = lc.match(/\bvalid(?:ity)?(?:\s+(?:for|of|period(?:\s+of)?))?\s+(?:(\d{1,2})|(one|two|three|four|five|six|ten|a|an))\s+(years?|months?)\b/);
  if (validity) { const n = validity[1] ? Number(validity[1]) : NUMBER_WORDS[validity[2]] ?? 1; validityMonths = validity[3].startsWith('year') ? n * 12 : n; infer('validity', `${validityMonths} months`, validity[0]); }
  else if (/\bannual(?:ly)?\b|\byearly\b|\bevery\s+year\b|\beach\s+year\b|\bper\s+year\b/.test(lc)) { validityMonths = 12; infer('validity', '12 months', lc.match(/\bannual(?:ly)?\b|\byearly\b|\bevery\s+year\b|\beach\s+year\b|\bper\s+year\b/)![0]); }
  else if (template?.content?.outputs?.validityMonths) { validityMonths = template.content.outputs.validityMonths; infer('validity', `${validityMonths} months`, `template ${template.key}`); }
  else if (instrumentType || instrumentClass) gap('How long the instrument stays valid is not stated.', 'لم تُذكر مدة سريان الوثيقة.');

  // form fields: what the description asks the applicant to state, plus the remarks every form carries
  const fields: DraftField[] = [];
  const field = (key: string, label: string, labelAr: string, type: DraftField['type'], required: boolean, extra: Partial<DraftField> = {}) => { if (!fields.some((f) => f.key === key)) fields.push({ key, label, labelAr, type, required, options: [], section: 'Application', help: '', helpAr: null, multiline: false, lookup: null, ...extra }); };
  if (/\bports?\b|\bharbour/.test(lc)) { field('port', 'Port', 'الميناء', 'text', true); infer('field', 'port', lc.match(/\bports?\b|\bharbour/)![0]); }
  if (/\bfrom\s+\S+\s+to\s+\S+|\bperiod\b|\bdates?\s+of\b|\bstart(?:ing)?\s+date|\bcommenc/.test(lc)) { field('validFrom', 'Requested start', 'تاريخ البدء المطلوب', 'date', true); field('validTo', 'Requested end', 'تاريخ الانتهاء المطلوب', 'date', false); infer('field', 'validFrom, validTo', lc.match(/\bfrom\s+\S+\s+to\s+\S+|\bperiod\b|\bdates?\s+of\b|\bstart(?:ing)?\s+date|\bcommenc\w*/)![0]); }
  const count = lc.match(/\b(?:number|count|no\.?)\s+of\s+([a-z]+)|\bhow\s+many\s+([a-z]+)/); if (count) { const noun = count[1] ?? count[2] ?? ''; field(`${slug(noun).replace(/-/g, '')}Count`, `Number of ${noun}`, `عدد ${noun}`, 'number', true); infer('field', `${noun} count`, count[0]); }
  if (/\bvehicle/.test(lc)) { field('vehicleCount', 'Number of vehicles', 'عدد المركبات', 'number', true); infer('field', 'vehicleCount', 'vehicle'); }
  if (/\bstaff|\bpersonnel|\bemployees?\b|\bqualified\s+staff/.test(lc)) { field('staffCount', 'Qualified staff', 'عدد الموظفين المؤهلين', 'number', true); infer('field', 'staffCount', lc.match(/\bstaff|\bpersonnel|\bemployees?\b/)![0]); }
  if (/\bpremises|\baddress|\blocation|\bwarehouse|\boffice/.test(lc)) { field('premises', 'Premises address', 'عنوان المقر', 'text', true); infer('field', 'premises', lc.match(/\bpremises|\baddress|\blocation|\bwarehouse|\boffice/)![0]); }
  if (/\bpurpose|\breason|\bjustification|\bscope\s+of/.test(lc)) { field('purpose', 'Purpose of the application', 'الغرض من الطلب', 'text', true, { multiline: true }); infer('field', 'purpose', lc.match(/\bpurpose|\breason|\bjustification|\bscope\s+of/)![0]); }
  if (/\bimo\b|\bcall\s+sign|\bflag\b/.test(lc) && subjectKind !== 'VESSEL') { field('vesselName', 'Vessel concerned', 'السفينة المعنية', 'text', true); infer('field', 'vesselName', lc.match(/\bimo\b|\bcall\s+sign|\bflag\b/)![0]); }
  if (template?.content?.form?.fields?.length) for (const f of template.content.form.fields) field(f.key, f.label, f.labelAr ?? '', f.type as DraftField['type'], !!f.required, { options: f.options ?? [], section: f.section ?? 'Application', help: f.help ?? '', multiline: !!f.multiline, lookup: f.lookup ?? null });
  field('remarks', 'Remarks', 'ملاحظات', 'text', false, { multiline: true });

  // the key, the code, and the Arabic name
  const keyWords = words(name).filter((w) => !STOP.has(w)).slice(0, 4);
  const key = `${KEY_PREFIX[subjectKind] ?? 'general'}.${(keyWords.length ? keyWords : ['service']).join('-')}`.replace(/[^a-z0-9._-]/g, '').slice(0, 80);
  let code = keyWords.join('-').toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 40).replace(/-+$/, ''); if (code.length < 2) code = 'NEW-SERVICE';
  let nameAr = template?.nameAr && (template.name ?? '').toLowerCase() === nameLc ? template.nameAr : arabicName(name);
  if (!nameAr.trim()) nameAr = name;
  if (hasLatin(nameAr)) gap('The Arabic name is a suggestion with words the composer could not translate; confirm the wording.', 'الاسم العربي اقتراح يحوي كلمات لم يتمكن المؤلّف من ترجمتها؛ أكّد الصياغة.');
  else gap('The Arabic name is a suggestion; confirm the wording.', 'الاسم العربي اقتراح؛ أكّد الصياغة.');
  gap('Write the Arabic description; it is empty.', 'اكتب الوصف العربي؛ فهو فارغ.');
  gap('The standard workflow applies: submit, completeness screening, technical assessment, decision, issue. Adjust the stages in the Studio if the service needs others.', 'يُطبَّق سير العمل المعياري: التقديم، فحص الاكتمال، التقييم الفني، القرار، الإصدار. عدّل المراحل في الاستوديو إذا احتاجت الخدمة غيرها.');

  return {
    key, code, name, nameAr, category, categoryAr: CATEGORY_AR[category] ?? category, domain, subjectKind,
    description: text.slice(0, 2000), descriptionAr: null, issuesInstrument: instrumentType, autoApprovable: false,
    changeNote: 'Drafted with the assistant from a plain-language description; not yet reviewed',
    content: {
      form: { fields, sections: [{ key: 'Application', label: 'Application', labelAr: 'الطلب' }] },
      documents, fees: { lines, currency: 'AED' }, sla: { days },
      outputs: { instrumentType, instrumentClass, validityMonths, notifications: [], templates: [] },
    },
    basedOn: template ? { id: template.id, key: template.key, name: template.name } : null,
    inferred, gaps, engine: 'platform composer',
    citations: template ? [{ id: template.id, label: template.name, kind: 'serviceDefinition', ref: template.key, link: '/services/studio' }] : [],
  };
}

/* ------------------------------------------------------------------------------------------------ templates through the gateway */

const contentOf = (d: Row): Partial<DraftContent> | null => {
  const v = d.live ?? d.version ?? null; if (!v || typeof v !== 'object') return null;
  return { form: v.form ?? undefined, documents: v.documents ?? undefined, fees: v.fees ?? undefined, sla: v.sla ?? undefined, outputs: v.outputs ?? undefined };
};
const templateOf = (d: Row): Template => ({ id: String(d.id), key: String(d.key), name: String(d.name), nameAr: d.nameAr ?? null, category: d.category ?? null, categoryAr: d.categoryAr ?? null, domain: d.domain ?? null, subjectKind: d.subjectKind ?? null, issuesInstrument: d.issuesInstrument ?? null, description: d.description ?? null, content: contentOf(d) });

/** One definition, by key or id, read through the gateway as the officer asking. Null when it is not there or may not be read. */
export async function readTemplate(reader: DefinitionDraftReader, ref: string): Promise<Template | null> {
  if (!reader.gateway) return null;
  try {
    const r = await reader.gateway.run('assistant', 'services.definition', { id: ref }, { userToken: reader.userToken, cause: 'definition-draft' });
    if (r.outcome !== 'OK' || !r.data) return null;
    const d = r.data as Row; if (!d.key) return null;
    return templateOf(d);
  } catch { return null; }
}

/** The published service the description shares the most words with, when it shares at least two; read through the gateway. */
export async function findTemplate(reader: DefinitionDraftReader, description: string): Promise<Template | null> {
  if (!reader.gateway) return null;
  try {
    const r = await reader.gateway.run('assistant', 'services.catalogue', {}, { userToken: reader.userToken, cause: 'definition-draft' });
    if (r.outcome !== 'OK' || !r.data) return null;
    const cats = ((r.data as Row).categories ?? []) as Row[];
    const services = cats.flatMap((c) => (c.services ?? []) as Row[]);
    const mine = new Set(words(description).filter((w) => w.length > 3 && !STOP.has(w)));
    let best: { s: Row; score: number } | null = null;
    for (const s of services) {
      const theirs = new Set(words(`${s.name ?? ''} ${s.description ?? ''}`).filter((w) => w.length > 3 && !STOP.has(w)));
      let score = 0; for (const w of mine) if (theirs.has(w)) score += 1;
      if (score >= 2 && (!best || score > best.score || (score === best.score && theirs.size < words(`${best.s.name ?? ''} ${best.s.description ?? ''}`).length))) best = { s, score };
    }
    if (!best) return null;
    return (await readTemplate(reader, String(best.s.id ?? best.s.key))) ?? templateOf(best.s);
  } catch { return null; }
}
