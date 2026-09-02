import { getJurisdiction, type RuleSetKind } from '@maritime/contracts';
import type { WorldTariff } from './finance';
import type { WorldServiceDefinition } from './services';

/** One versioned rule set of the rules service: fee schedules, eligibility and validation checks and SLA clocks, all data.
 * Expressions are JSON-logic style (`{ "<op>": [args] }`); `params.*` and lookup tables come from `parameters`. */
export interface WorldRuleSet {
  key: string; name: string; nameAr?: string; kind: RuleSetKind; description: string; descriptionAr?: string;
  definition: unknown; parameters: Record<string, unknown>; changeNote: string;
}

const LIQUID_CARGO = ['CRUDE', 'POL', 'EDIBLE', 'LNG', 'LPG', 'CHEMICAL'];
const v = (path: string, dflt?: unknown) => (dflt === undefined ? { var: path } : { var: [path, dflt] });
/** Quantity of cargo operations matching a predicate — the wharfage lines sum per unit kind. */
const cargoQty = (pred: unknown) => ({ sum: [v('cargoOps', []), { if: [pred, v('qty', 0), 0] }] });

/** The port-call fee schedule mirrors the reference invoice maths: GRT-based port dues, pilotage in and out, tugs each way,
 * berth hire per GRT-day, anchorage beyond a day's wait, wharfage by cargo kind and the optional supplies. */
function portCallFees(profile: string, tariffs: WorldTariff[]): WorldRuleSet[] {
  const j = getJurisdiction(profile);
  const t = Object.fromEntries(tariffs.map((x) => [x.code, x]));
  const rates = Object.fromEntries(tariffs.map((x) => [x.code, x.rate]));
  const line = (code: string, qty: unknown, when?: unknown) => ({ code, description: t[code].name, descriptionAr: t[code].nameAr ?? null, unit: t[code].unit, qty, rate: v(`params.tariffs.${code}`), taxable: true, ...(when ? { when } : {}) });
  const marine = [
    line('PD', v('vessel.grt', 0)),
    line('PIL', v('call.movements', 2)),
    line('TUG', { '*': [{ lookup: ['tugsByLoa', v('vessel.loa', 0), 2] }, v('call.movements', 2)] }),
    line('BH', { '*': [v('vessel.grt', 0), { max: [1, v('call.stayDays', 1)] }] }),
    line('ANC', { ceil: [{ '/': [v('call.waitedHours', 0), 24] }] }, { '>': [v('call.waitedHours', 0), 24] }),
    line('WTR', v('services.freshWaterMt', 0), { '>': [v('services.freshWaterMt', 0), 0] }),
    line('GBG', 1, { '!!': v('services.garbage', false) }),
  ];
  const wharfage = [
    line('WFC', cargoQty({ '==': [v('unit'), 'TEU'] })),
    line('WFR', cargoQty({ '==': [v('unit'), 'UNITS'] })),
    line('WFL', cargoQty({ and: [{ '!=': [v('unit'), 'TEU'] }, { '!=': [v('unit'), 'UNITS'] }, { in: [v('cargoType', ''), LIQUID_CARGO] }] })),
    line('WFB', cargoQty({ and: [{ '!=': [v('unit'), 'TEU'] }, { '!=': [v('unit'), 'UNITS'] }, { '!': { in: [v('cargoType', ''), LIQUID_CARGO] } }] })),
  ];
  const parameters = { currency: j.currency.code, tariffs: rates, tugsByLoa: [{ to: 250, value: 2 }, { from: 250, value: 3 }], liquidCargo: LIQUID_CARGO };
  return [
    { key: 'fees.port-call', name: 'Port call charges', nameAr: 'رسوم رسو السفينة', kind: 'FEE', description: 'Port dues, pilotage, towage, berth hire, anchorage, wharfage and supplies for one call — context { vessel: { grt, loa }, call: { movements, stayDays, waitedHours }, services: { freshWaterMt, garbage }, cargoOps: [{ unit, qty, cargoType }] }.',
      descriptionAr: 'رسوم الميناء والإرشاد والقطر وشغل الرصيف والمرساة ورسوم الرصيف للرسو الواحد', definition: { lines: [...marine, ...wharfage] }, parameters, changeNote: `Tariff card ${new Date().getUTCFullYear()}` },
    { key: 'fees.wharfage', name: 'Wharfage', nameAr: 'رسوم الرصيف', kind: 'FEE', description: 'Wharfage by cargo kind — containers per TEU, ro-ro per unit, liquid and dry bulk per tonne — context { cargoOps: [{ unit, qty, cargoType }] }.',
      descriptionAr: 'رسوم الرصيف حسب نوع البضاعة', definition: { lines: wharfage }, parameters, changeNote: 'Cargo tariff card' },
  ];
}

/** One fee set per chargeable catalogue service: the application and issue fee lines of the definition. */
function serviceFees(profile: string, defs: WorldServiceDefinition[]): WorldRuleSet[] {
  const j = getJurisdiction(profile);
  return defs.filter((d) => d.feeLines.length > 0).map((d) => ({
    key: `fee.${d.key}`, name: `${d.name} — fees`, nameAr: d.nameAr ? `${d.nameAr} — الرسوم` : undefined, kind: 'FEE' as const,
    description: `Fee schedule of service ${d.code}.`, descriptionAr: d.nameAr ? `جدول رسوم الخدمة ${d.code}` : undefined,
    definition: { lines: d.feeLines.map((l) => ({ code: l.code, description: l.label, descriptionAr: l.labelAr ?? null, amount: l.amount, taxable: true, unit: 'application' })) },
    parameters: { currency: j.currency.code, serviceCode: d.code }, changeNote: 'Fee schedule from the service catalogue',
  }));
}

function eligibility(profile: string): WorldRuleSet[] {
  const j = getJurisdiction(profile);
  const now = { now: [] };
  return [
    { key: 'eligibility.registration', name: 'Ship registration eligibility', nameAr: 'أهلية تسجيل السفينة', kind: 'ELIGIBILITY',
      description: 'Ownership and nationality conditions of the registry, tonnage measurement and the age of the ship — context { subject: { ownerNationality, grt, built, classSociety } }.',
      descriptionAr: 'شروط الملكية والجنسية وقياس الحمولة وعمر السفينة',
      definition: { checks: [
        { code: 'OWNER_NATIONALITY', severity: 'ERROR', message: j.registry.nationalityRule, messageAr: 'يجب أن تستوفي السفينة شروط الملكية والجنسية المنصوص عليها في القانون البحري', when: { '!': { in: [v('subject.ownerNationality', ''), v('params.qualifyingNationalities')] } } },
        { code: 'TONNAGE_MEASURED', severity: 'ERROR', message: 'Tonnage must be measured and recorded before the ship is registered', messageAr: 'يجب قياس الحمولة وتسجيلها قبل تسجيل السفينة', when: { '!!': { missing: ['subject.grt'] } } },
        { code: 'VESSEL_AGE', severity: 'WARN', message: 'The ship is older than the registry age guideline; a condition survey is required', messageAr: 'عمر السفينة يتجاوز الحد الإرشادي للتسجيل؛ تلزم معاينة حالة', when: { '>': [{ '-': [{ year: [now] }, v('subject.built', { year: [now] })] }, v('params.maxAgeYears')] } },
        { code: 'CLASS_SOCIETY', severity: 'WARN', message: 'No classification society is recorded for the ship', messageAr: 'لم تُسجل هيئة تصنيف للسفينة', when: { '!!': { missing: ['subject.classSociety'] } } },
      ] },
      parameters: { qualifyingNationalities: [j.name, j.code], maxAgeYears: 25, minimumQualifyingSharePct: 51 }, changeNote: `Registry conditions — ${j.name}` },
    { key: 'eligibility.coc', name: 'Certificate of Competency eligibility', nameAr: 'أهلية شهادة الكفاءة', kind: 'ELIGIBILITY',
      description: 'Approved sea service for the grade applied for, a medical certificate valid long enough and the minimum age — context { form: { grade, seaServiceMonths }, subject: { medicalExpiry, dob } }.',
      descriptionAr: 'الخدمة البحرية المعتمدة للدرجة وصلاحية الشهادة الطبية والحد الأدنى للعمر',
      definition: { checks: [
        { code: 'SEA_SERVICE', severity: 'ERROR', message: 'Approved sea service is below the months required for the grade applied for', messageAr: 'الخدمة البحرية المعتمدة أقل من الأشهر المطلوبة للدرجة', when: { '<': [v('form.seaServiceMonths', 0), { lookup: ['seaServiceMonthsByGrade', v('form.grade', ''), 12] }] } },
        { code: 'MEDICAL_VALID', severity: 'ERROR', message: 'The medical fitness certificate must remain valid for at least the minimum period after issue', messageAr: 'يجب أن تبقى شهادة اللياقة الطبية سارية للحد الأدنى من المدة بعد الإصدار', when: { '<': [{ daysBetween: [now, v('subject.medicalExpiry', now)] }, v('params.medicalMinDays')] } },
        { code: 'MIN_AGE', severity: 'WARN', message: 'The applicant appears to be below the minimum age for certification', messageAr: 'يبدو أن مقدم الطلب دون الحد الأدنى للعمر', when: { and: [{ '!': { missing: ['subject.dob'] } }, { '<': [{ '/': [{ daysBetween: [v('subject.dob'), now] }, 365.25] }, v('params.minAge')] }] } },
      ] },
      parameters: { seaServiceMonthsByGrade: { Master: 36, 'Chief Mate': 24, 'Officer in Charge of a Navigational Watch': 12, 'Chief Engineer': 36, 'Second Engineer': 24 }, medicalMinDays: 90, minAge: 18 }, changeNote: 'STCW sea-service and medical conditions' },
    { key: 'validation.documents', name: 'Document checklist validation', nameAr: 'التحقق من قائمة المستندات', kind: 'VALIDATION',
      description: 'Every mandatory document of the checklist is attached and verified — context { documents: [{ code, required, verified }] }.', descriptionAr: 'كل مستند إلزامي مرفق ومُتحقق منه',
      definition: { checks: [
        { code: 'DOCS_VERIFIED', severity: 'ERROR', message: 'All mandatory documents must be verified before approval', messageAr: 'يجب التحقق من جميع المستندات الإلزامية قبل الاعتماد', when: { some: [v('documents', []), { and: [v('required', false), { '!': v('verified', false) }] }] } },
      ] }, parameters: {}, changeNote: 'Checklist rule' },
    { key: 'sla.standard', name: 'Standard service level', nameAr: 'مستوى الخدمة القياسي', kind: 'SLA',
      description: 'The definition’s SLA in days, halved for expedited requests — context { definition: { slaDays }, request: { expedited } }.', descriptionAr: 'مدة الخدمة بالأيام، وتُخفض للنصف للطلبات العاجلة',
      definition: { days: { if: [v('request.expedited', false), { max: [1, { round: [{ '/': [v('definition.slaDays', 10), 2] }, 0] }] }, v('definition.slaDays', 10)] } }, parameters: {}, changeNote: 'Standard clock' },
  ];
}

/** Every rule set the platform ships with: the port-call tariff schedules, one fee set per chargeable service, the eligibility and validation checks and the standard SLA clock. */
export function buildRuleSets(profile: string, tariffs: WorldTariff[], defs: WorldServiceDefinition[]): WorldRuleSet[] {
  return [...portCallFees(profile, tariffs), ...serviceFees(profile, defs), ...eligibility(profile)];
}
