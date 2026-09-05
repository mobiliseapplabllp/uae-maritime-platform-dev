/** How one meta field of a master is edited in Data Studio: the key inside `meta`, its label, and the input it needs. */
export interface LookupMetaField { key: string; label: string; labelAr?: string; type?: 'text' | 'number' | 'select' | 'date' | 'boolean'; options?: string[]; placeholder?: string }
export interface LookupCategory {
  key: string; label: string; labelAr?: string;
  /** The Data Studio group the master is shown under. */ group: string;
  /** One line on what the master is for. */ desc?: string; descAr?: string;
  /** Meta fields the master carries beyond code and label — the screen builds its editor from these. */ metaFields?: LookupMetaField[];
  /** Masters the platform's own rules read (cycle lengths, reminder windows): deleting an entry is refused while records reference it. */ system?: boolean;
}
const MF = (key: string, label: string, labelAr: string, type: LookupMetaField['type'] = 'text', extra: Partial<LookupMetaField> = {}): LookupMetaField => ({ key, label, labelAr, type, ...extra });

/* Every vocabulary the platform reads from Data Studio rather than from code. State machines (a company's
 * standing, an instrument's status, a request's status) and the statutory instrument codes stay in code: they
 * are law, not configuration. Everything a clerk might legitimately add a value to is here. */
export const LOOKUP_CATEGORIES: LookupCategory[] = [
  // geography
  { key: 'country',        label: 'Countries', labelAr: 'الدول', group: 'Geography', desc: 'Trade-lane and registry countries' },
  { key: 'state',          label: 'Emirates / States', labelAr: 'الإمارات / الولايات', group: 'Geography', desc: 'Administrative regions in the operational footprint', metaFields: [MF('country', 'Country code', 'رمز الدولة', 'text', { placeholder: 'AE' })] },
  { key: 'city',           label: 'Cities', labelAr: 'المدن', group: 'Geography', desc: 'Cities used across addresses and offices', metaFields: [MF('state', 'Region code', 'رمز المنطقة'), MF('country', 'Country code', 'رمز الدولة')] },
  { key: 'port',           label: 'Ports (UN/LOCODE)', labelAr: 'الموانئ', group: 'Geography', desc: 'Trade-lane ports with UN/LOCODEs', metaFields: [MF('country', 'Country', 'الدولة')] },
  // commercial
  { key: 'uom',            label: 'Units of Measure', labelAr: 'وحدات القياس', group: 'Commercial', desc: 'Quantity units used in cargo, tariffs and services' },
  { key: 'currency',       label: 'Currencies', labelAr: 'العملات', group: 'Commercial', desc: 'Billing currencies', metaFields: [MF('symbol', 'Symbol', 'الرمز', 'text', { placeholder: 'AED' })] },
  { key: 'agent',          label: 'Shipping Agents', labelAr: 'الوكلاء الملاحيون', group: 'Commercial', desc: 'Licensed boarding agents with tax registration', metaFields: [MF('address', 'Address', 'العنوان'), MF('taxId', 'Tax registration (sample)', 'رقم التسجيل الضريبي (نموذج)')] },
  // marine
  { key: 'vesselType',     label: 'Vessel Types', labelAr: 'أنواع السفن', group: 'Marine', desc: 'Registry vessel classifications' },
  { key: 'cargoType',      label: 'Cargo Types', labelAr: 'أنواع البضائع', group: 'Marine', desc: 'Commodity groups with units and MT factors', metaFields: [MF('group', 'Statistical group', 'المجموعة الإحصائية', 'select', { options: ['container', 'dryBulk', 'liquid', 'breakBulk', 'roro'] }), MF('unit', 'Unit', 'الوحدة', 'text', { placeholder: 'MT / TEU / UNITS' }), MF('mtFactor', 'MT factor', 'معامل الطن', 'number')] },
  { key: 'voyageArea',     label: 'Areas of Operation', labelAr: 'مناطق التشغيل', group: 'Marine', desc: 'Trading areas a navigation licence can be issued for' },
  { key: 'movementType',   label: 'Vessel Movements', labelAr: 'أنواع حركة السفن', group: 'Marine', desc: 'Movements a no-objection certificate can cover' },
  { key: 'callPurpose',    label: 'Purposes of Call', labelAr: 'أغراض الرسو', group: 'Marine', desc: 'Why a foreign-flag vessel calls under a permit' },
  { key: 'recognisedOrganisation', label: 'Recognised Organisations', labelAr: 'الهيئات المعترف بها', group: 'Marine', desc: 'Classification societies authorised to survey on the flag\'s behalf', metaFields: [MF('iacs', 'IACS member', 'عضو في IACS', 'boolean')] },
  // ship registry
  { key: 'registrationKind', label: 'Registration Variants', labelAr: 'أنواع التسجيل', group: 'Ship Registry', desc: 'The kinds of registry entry the registrar grants, with their SLA and evidence', system: true,
    metaFields: [MF('slaDays', 'SLA (days)', 'مدة الإنجاز (أيام)', 'number'), MF('validityMonths', 'Validity (months, blank for permanent)', 'مدة الصلاحية (أشهر)', 'number'), MF('issuesCertificate', 'Issues a certificate of registry', 'تصدر شهادة تسجيل', 'boolean'), MF('closesRegistry', 'Closes the registry entry', 'تغلق قيد التسجيل', 'boolean')] },
  { key: 'registryTransactionType', label: 'Registry Transactions', labelAr: 'معاملات السجل', group: 'Ship Registry', desc: 'What can be recorded against a registered ship: mortgages, transfers, changes of name and the like', system: true,
    metaFields: [MF('affectsTitle', 'Affects title', 'يؤثر على الملكية', 'boolean'), MF('requiresConsent', 'Needs mortgagee consent', 'يتطلب موافقة الدائن المرتهن', 'boolean'), MF('feeCode', 'Fee code', 'رمز الرسم')] },
  { key: 'amendmentType',  label: 'Registry Amendments', labelAr: 'تعديلات السجل', group: 'Ship Registry', desc: 'Particulars that can be altered on a registry entry' },
  { key: 'deletionReason', label: 'Registry Closure Grounds', labelAr: 'أسباب إغلاق التسجيل', group: 'Ship Registry', desc: 'Grounds on which a registry entry is closed' },
  { key: 'tradingArea',    label: 'Trading Areas', labelAr: 'مناطق الإبحار', group: 'Ship Registry', desc: 'The trading area a minimum safe manning document is issued for', metaFields: [MF('order', 'Sort order', 'ترتيب العرض', 'number')] },
  // seafarers and training
  { key: 'seafarerRank',   label: 'Seafarer Ranks', labelAr: 'رتب البحارة', group: 'Seafarers & MET', desc: 'Ranks on the crew register, the safe manning scale and the FAL-5 crew list', metaFields: [MF('department', 'Department', 'القسم', 'select', { options: ['DECK', 'ENGINE', 'CATERING', 'OTHER'] }), MF('officer', 'Officer rank', 'رتبة ضابط', 'boolean'), MF('cocGrade', 'Certificate of competency grade the rank needs (cocGrade code, blank for ratings)', 'درجة شهادة الكفاءة المطلوبة للرتبة'), MF('order', 'Sort order', 'ترتيب العرض', 'number')] },
  { key: 'seafarerCertType', label: 'Seafarer Certificates', labelAr: 'شهادات البحارة', group: 'Seafarers & MET', desc: 'Certificates and documents a seafarer carries; the sign-on gate and the crew-list check read the mandatory ones', metaFields: [MF('kind', 'Kind', 'النوع', 'select', { options: ['COMPETENCY', 'PROFICIENCY', 'MEDICAL', 'IDENTITY', 'ENDORSEMENT', 'RECORD'] }), MF('convention', 'Convention / regulation', 'الاتفاقية'), MF('validityMonths', 'Validity (months)', 'مدة الصلاحية (أشهر)', 'number'), MF('mandatory', 'Required to sign on', 'مطلوب للالتحاق', 'boolean')] },
  { key: 'cocGrade',       label: 'Certificate of Competency Grades', labelAr: 'درجات شهادة الكفاءة', group: 'Seafarers & MET', desc: 'STCW capacities a certificate of competency is issued for', metaFields: [MF('regulation', 'STCW regulation', 'لائحة STCW'), MF('seaServiceMonths', 'Sea service required (months)', 'الخدمة البحرية المطلوبة (أشهر)', 'number')] },
  { key: 'copCourse',      label: 'Proficiency Courses', labelAr: 'دورات الإتقان', group: 'Seafarers & MET', desc: 'Courses a certificate of proficiency attests', metaFields: [MF('regulation', 'STCW regulation', 'لائحة STCW'), MF('validityMonths', 'Validity (months)', 'مدة الصلاحية (أشهر)', 'number')] },
  { key: 'gmdssGrade',     label: 'GMDSS Certificates', labelAr: 'شهادات GMDSS', group: 'Seafarers & MET', desc: 'Radio operator certificate grades' },
  { key: 'deliveryOffice', label: 'Collection Offices', labelAr: 'مكاتب الاستلام', group: 'Seafarers & MET', desc: 'Offices where a seafarer collects a card or a record book', metaFields: [MF('city', 'City', 'المدينة'), MF('hours', 'Opening hours', 'ساعات العمل')] },
  { key: 'recordBookReason', label: 'Record Book Issue Reasons', labelAr: 'أسباب إصدار سجل الخدمة', group: 'Seafarers & MET', desc: 'Why a seafarer record book is issued or replaced' },
  { key: 'metProgramme',   label: 'MET Programmes', labelAr: 'برامج التعليم والتدريب البحري', group: 'Seafarers & MET', desc: 'Training programmes an institution can be approved to deliver', metaFields: [MF('regulation', 'STCW regulation', 'لائحة STCW'), MF('hours', 'Contact hours', 'ساعات التدريب', 'number'), MF('simulator', 'Needs a simulator', 'يتطلب جهاز محاكاة', 'boolean')] },
  { key: 'metInstitutionType', label: 'MET Institution Types', labelAr: 'أنواع مؤسسات التعليم البحري', group: 'Seafarers & MET', desc: 'Kinds of maritime education and training provider' },
  { key: 'crewListSource', label: 'Crew List Sources', labelAr: 'مصادر قوائم الطاقم', group: 'Seafarers & MET', desc: 'Where a FAL-5 crew list arrives from' },
  // legislation
  { key: 'legalInstrumentType', label: 'Legal Instrument Types', labelAr: 'أنواع الصكوك التشريعية', group: 'Legislation', desc: 'Acts, rules, circulars, notices, orders and conventions; the prefix is the series the register numbers the type in', metaFields: [MF('citable', 'Shown on the public portal', 'يُعرض على البوابة العامة', 'boolean'), MF('refPrefix', 'Reference prefix (series)', 'بادئة المرجع (السلسلة)'), MF('order', 'Sort order', 'ترتيب العرض', 'number')] },
  { key: 'legalLinkKind',  label: 'Instrument Link Kinds', labelAr: 'أنواع الروابط بين الصكوك', group: 'Legislation', desc: 'How one instrument relates to another' },
  { key: 'imoSource',      label: 'IMO Sources', labelAr: 'مصادر المنظمة البحرية الدولية', group: 'Legislation', desc: 'The IMO bodies and series the legislation desk monitors', metaFields: [MF('body', 'IMO body', 'الجهة'), MF('series', 'Document series', 'سلسلة الوثائق'), MF('url', 'Source URL', 'رابط المصدر'), MF('pollHours', 'Poll every (hours)', 'الفحص كل (ساعات)', 'number')] },
  // industry directory
  { key: 'companyCategory', label: 'Company Categories', labelAr: 'فئات الشركات', group: 'Industry', desc: 'How companies on the directory are classed' },
  { key: 'accreditationCategory', label: 'Accreditation Categories', labelAr: 'فئات الاعتماد', group: 'Industry', desc: 'The annual accreditation schemes a company can be approved under, with each one\'s cycle', system: true,
    metaFields: [MF('instrumentType', 'Instrument type issued', 'نوع الصك الصادر'), MF('cycleMonths', 'Cycle (months)', 'الدورة (أشهر)', 'number'), MF('visitsPerCycle', 'Inspection visits per cycle', 'زيارات التفتيش في الدورة', 'number'), MF('reminderDays', 'Renewal reminders (days before, comma-separated)', 'تذكيرات التجديد (أيام قبل الانتهاء)'), MF('ratingWeight', 'Weight in the performance rating', 'الوزن في تقييم الأداء', 'number')] },
  { key: 'facilityType',   label: 'Port Facility Types', labelAr: 'أنواع المرافق المينائية', group: 'Industry', desc: 'Berths, terminals, jetties, yards, moorings and anchorages' },
  { key: 'facilityCapability', label: 'Facility Capabilities', labelAr: 'قدرات المرافق', group: 'Industry', desc: 'What a port facility is approved to handle' },
  { key: 'visitType',      label: 'Inspection Visit Types', labelAr: 'أنواع زيارات التفتيش', group: 'Industry', desc: 'Kinds of visit the desk pays a company or facility', system: true, metaFields: [MF('ratingWeight', 'Weight in the performance rating', 'الوزن في تقييم الأداء', 'number'), MF('scheduled', 'Planned in advance', 'مخططة مسبقاً', 'boolean')] },
  { key: 'obligationKind', label: 'Obligation Kinds', labelAr: 'أنواع الالتزامات', group: 'Industry', desc: 'What a regulated subject can owe the administration', metaFields: [MF('defaultDueDays', 'Default days to clear', 'المهلة الافتراضية (أيام)', 'number')] },
  { key: 'auditType',      label: 'Audit Types', labelAr: 'أنواع التدقيق', group: 'Industry', desc: 'ISM and company audit kinds' },
  // inspection
  { key: 'inspectionRegime', label: 'Inspection Regimes', labelAr: 'أنظمة التفتيش', group: 'Compliance', desc: 'The regimes surveys are carried out under, and the subject each one applies to', system: true,
    metaFields: [MF('subjectKind', 'Subject', 'الموضوع', 'select', { options: ['VESSEL', 'COMPANY', 'PORT_FACILITY', 'MET_INSTITUTION'] }), MF('intervalMonths', 'Interval (months)', 'الفاصل الزمني (أشهر)', 'number'), MF('convention', 'Convention', 'الاتفاقية')] },
  { key: 'deficiencyCode', label: 'Deficiency Codes', labelAr: 'رموز أوجه القصور', group: 'Compliance', desc: 'PSC deficiency codes with categories', metaFields: [MF('category', 'Category', 'الفئة')] },
  { key: 'actionCode',     label: 'PSC Action Codes', labelAr: 'رموز إجراءات رقابة دولة الميناء', group: 'Compliance', desc: 'Action codes applied to survey findings' },
  { key: 'documentType',   label: 'Document Types', labelAr: 'أنواع الوثائق', group: 'Compliance', desc: 'Attachment classes for incidents and compliance' },
  { key: 'incidentArea',   label: 'Incident Locations', labelAr: 'مواقع الحوادث', group: 'Compliance', desc: 'Named areas used when logging incidents' },
  // assets and organisation
  { key: 'equipmentType',  label: 'Equipment Types', labelAr: 'أنواع المعدات', group: 'Assets', desc: 'Classes of cargo-handling and response equipment' },
  { key: 'equipment',      label: 'Equipment & Assets', labelAr: 'المعدات والأصول', group: 'Assets', desc: 'The asset register — cranes, conveyors, response kit', metaFields: [MF('type', 'Equipment type code', 'رمز نوع المعدة', 'text', { placeholder: 'STS' }), MF('terminal', 'Terminal / location', 'المحطة / الموقع'), MF('status', 'Status', 'الحالة', 'select', { options: ['OPERATIONAL', 'MAINTENANCE', 'OUT_OF_SERVICE'] }), MF('make', 'Make / model', 'الصانع / الطراز')] },
  { key: 'department',     label: 'Departments', labelAr: 'الإدارات', group: 'Organisation', desc: 'Organisation departments' },
  { key: 'designation',    label: 'Designations', labelAr: 'المسميات الوظيفية', group: 'Organisation', desc: 'Designations mapped to departments', metaFields: [MF('department', 'Department', 'الإدارة')] },
  { key: 'shift',          label: 'Shifts', labelAr: 'الورديات', group: 'Organisation', desc: 'Working shifts for terminal and marine crews', metaFields: [MF('start', 'Start (HH:MM)', 'البداية'), MF('end', 'End (HH:MM)', 'النهاية')] },
  { key: 'holiday',        label: 'Holiday Calendar', labelAr: 'تقويم العطلات', group: 'Organisation', desc: 'Gazetted holidays — marine operations stay 24×365', metaFields: [MF('date', 'Date', 'التاريخ', 'date'), MF('working', 'Working note', 'ملاحظة العمل')] },
];
export const LOOKUP_CATEGORY_KEYS: string[] = LOOKUP_CATEGORIES.map((c) => c.key);
export const lookupCategory = (key: string): LookupCategory | undefined => LOOKUP_CATEGORIES.find((c) => c.key === key);

/** Per-module settings — defaults merged under the setting key `module:<key>`. */
export const MODULE_SETTING_DEFAULTS: Record<string, Record<string, unknown>> = {
  ops:       { vcnPrefix: 'REF', anchorageAlertHrs: 24, defaultTugsUnder250m: 2, defaultTugsOver250m: 3, scheduleWindowDays: 5, channelSpeedLimitKn: 8, aisGapAlertMin: 30, anchorDriftNm: 0.2, zoneEntryWatch: true },
  ships:     { certExpiringDays: 30, dryDockReminderDays: 60, riskRefreshMinutes: 30 },
  crew:      { medicalExpiringDays: 45, minRestHours: 10, cocVerifyOnSignOn: true },
  legis:     { ackRequiredDefault: false, ackReminderDays: 7, showSupersededDays: 365 },
  incidents: { mttaTargetMin: 30, mttrTargetHrs: 24, autoNotifySeverity: 'HIGH', reopenWindowDays: 30, injuryReportHrs: 24 },
  inspect:   { findingDueDays: 14, detentionThreshold: 1, passScorePct: 80, requireEvidencePhotos: false },
  facil:     { licenceValidityYears: 2, auditIntervalMonths: 12, renewalReminderDays: 90 },
  finance:   { invoicePrefix: 'REF/INV', paymentTermsDays: 30, overdueReminderDays: 7, roundTotalsToWholeUnit: true },
  mis:       { defaultPeriodMonths: 12, exportFooter: 'Generated by the Maritime Platform' },
  masters:   { allowHardDelete: false },
  agents:    { defaultAutonomy: 'SUPERVISED', escalationHours: 4, suspensionNoticeHours: 4 },
  admin:     { sessionTimeoutMin: 60, passwordMinLength: 8, auditRetentionDays: 1825, mfaRequiredForStaff: true },
};

export const SETTING_SECTIONS = ['org', 'operations', 'billing', 'notifications', 'smtp', 'ai', 'riskWeights'] as const;
export const CERT_EXPIRING_DAYS = 30;
export const SEAFARER_RANKS = ['Master', 'Chief Officer', 'Second Officer', 'Third Officer', 'Chief Engineer',
  'Second Engineer', 'Third Engineer', 'Fourth Engineer', 'Electro-Technical Officer', 'Bosun', 'Able Seaman',
  'Ordinary Seaman', 'Oiler', 'Fitter', 'Cook', 'Steward', 'Deck Cadet', 'Engine Cadet'] as const;
export const SEAFARER_CERT_TYPES = ['Certificate of Competency', 'GMDSS GOC', 'Medical Fitness (ILO/MLC)',
  'STCW Basic Safety Training', 'Advanced Fire Fighting', 'Medical First Aid', 'Ship Security Officer',
  'Tanker Familiarisation', 'Certificate of Discharge (CDC)'] as const;
export const RESOURCE_TYPES = ['TUG', 'PILOT_LAUNCH', 'MOORING_BOAT', 'PILOT', 'SURVEY_LAUNCH'] as const;
export const DEFAULT_RISK_WEIGHTS = { age: 15, certificates: 25, deficiencies: 20, detentions: 20, inspectionGap: 10, agentPerformance: 10 };
export const NOTIFICATION_SEVERITIES = ['info', 'success', 'warning', 'error'] as const;
export type NotificationSeverity = (typeof NOTIFICATION_SEVERITIES)[number];

/** Tenancy scopes carried on identities and records. */
export const SCOPE_LEVELS = ['NATIONAL', 'PORT', 'ZONE', 'FACILITY', 'COMPANY'] as const;
export type ScopeLevel = (typeof SCOPE_LEVELS)[number];
export interface TenancyScope { level: ScopeLevel; ports?: string[]; zones?: string[]; facilities?: string[]; companies?: string[] }
export const NATIONAL_SCOPE: TenancyScope = { level: 'NATIONAL' };
