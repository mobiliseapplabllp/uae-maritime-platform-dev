import { EVENTS, type Actor } from '@maritime/contracts';
import { enqueue, eventFromContext, type AiGatewayClient, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import type { Citation, Row } from './tools';
import { mayRead } from './retrieval';

/* Drafting.
 *
 * Four things an officer writes over and over from records they already hold: a notice to a shipowner, a
 * decision letter on an application, the summary of an inspection and a deficiency notice. The assistant
 * assembles each from the platform's own record, in English or in Arabic as asked, and hands it back as a draft
 * with the citations it was written from.
 *
 * What the assistant's own read models hold — vessels, inspections, instruments — is read here directly. An
 * application lives on the Service Desk and is read through the tool gateway as the officer asking, so the
 * gateway's log shows who had a letter drafted from which file.
 *
 * A draft is never issued from here. It has no number, no signature and no effect — issuing is the instruments
 * service's business and a human's decision, and the status column says DRAFT for exactly that reason. */

export const DRAFT_KINDS = ['NOTICE', 'DECISION_LETTER', 'INSPECTION_SUMMARY', 'DEFICIENCY_NOTICE'] as const;
export type DraftKind = (typeof DRAFT_KINDS)[number];

/** What a reader must hold to have a draft of each kind prepared for them. */
export const DRAFT_PERMISSION: Record<DraftKind, string> = {
  NOTICE: 'legislation.manage',
  DECISION_LETTER: 'services.assess',
  INSPECTION_SUMMARY: 'inspections.view',
  DEFICIENCY_NOTICE: 'inspections.edit',
};

export interface DraftRecord {
  id: string; kind: string; subject_type: string; subject_id: string; subject_label: string; title: string; body: string;
  citations: Row[]; facts: Row; language: string; status: string; engine: string;
  prepared_by_id: string; prepared_by: string; created_at: Date; updated_at: Date;
}
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const dateOnly = (v: unknown) => (v ? new Date(v as string).toISOString().slice(0, 10) : '—');

export const draftApi = (d: DraftRecord) => ({
  id: d.id, kind: d.kind, subjectType: d.subject_type, subjectId: d.subject_id, subjectLabel: d.subject_label,
  title: d.title, body: d.body, citations: d.citations ?? [], facts: d.facts ?? {}, language: d.language,
  status: d.status, engine: d.engine, preparedById: d.prepared_by_id, preparedBy: d.prepared_by,
  createdAt: iso(d.created_at), updatedAt: iso(d.updated_at),
});

export interface DraftInput { kind: DraftKind; subjectId: string; language?: string; note?: string }
/** How the drafter reaches a record the assistant does not hold itself: the tool gateway, as the person asking. */
export interface DraftReader { gateway?: AiGatewayClient; userToken?: string }
export interface PreparedDraft { title: string; body: string; citations: Citation[]; facts: Row; subjectType: string; subjectLabel: string }

const cite = (id: string, label: string, kind: string, ref: string, link: string): Citation => ({ id, label, kind, ref, link });
const lower = (v: unknown) => String(v ?? '').toLowerCase().replace(/_/g, ' ');
const num = (v: unknown) => (v == null || v === '' || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('en-AE'));

/** The two languages a draft is written in. Every sentence exists in both; the language asked for picks. */
type Lang = 'en' | 'ar';
const langOf = (v: unknown): Lang => (v === 'ar' ? 'ar' : 'en');

/** An application's standing as it reads in a letter, in each language. */
const STATE_WORDS: Record<string, [string, string]> = {
  DRAFT: ['still a draft and not yet submitted', 'ما زال مسودة ولم يُقدَّم بعد'],
  SUBMITTED: ['submitted and awaiting assessment', 'مُقدَّم وبانتظار التقييم'],
  UNDER_ASSESSMENT: ['under assessment', 'قيد التقييم'],
  INFO_REQUESTED: ['awaiting information from the applicant', 'بانتظار معلومات من مقدّم الطلب'],
  APPROVED: ['approved', 'موافَق عليه'],
  REJECTED: ['refused', 'مرفوض'],
  ISSUED: ['approved, and the instrument has been issued', 'موافَق عليه وقد صدرت الوثيقة'],
  WITHDRAWN: ['withdrawn by the applicant', 'مسحوب من قِبل مقدّم الطلب'],
};
const stateWords = (status: unknown, lang: Lang) => { const w = STATE_WORDS[String(status ?? '').toUpperCase()]; return w ? (lang === 'ar' ? w[1] : w[0]) : lower(status); };

/**
 * Assembles the draft from the records the subject actually has. Nothing is invented: where the record is silent
 * the draft says so, because a notice that fills a gap with a plausible sentence is worse than one that leaves
 * the gap visible to the officer who has to sign it.
 */
export async function prepareDraft(db: Queryable, input: DraftInput, preparedBy: string, reader: DraftReader = {}): Promise<PreparedDraft | null> {
  const today = new Date().toISOString().slice(0, 10);
  const lang = langOf(input.language);
  const t = (en: string, ar: string) => (lang === 'ar' ? ar : en);

  if (input.kind === 'INSPECTION_SUMMARY') {
    const r = await db.query<Row>('SELECT * FROM inspections WHERE id = $1 OR number = $1 LIMIT 1', [input.subjectId]);
    const i = r.rows[0];
    if (!i) return null;
    const findings: Row[] = (i.payload?.findings ?? []) as Row[];
    const open = findings.filter((f) => f.status === 'OPEN');
    const when = dateOnly(i.closed_at ?? i.planned_at);
    const body = [
      t(`INSPECTION SUMMARY — ${i.number}`, `ملخص التفتيش — ${i.number}`),
      '',
      t(`Vessel: ${i.vessel_name}`, `السفينة: ${i.vessel_name}`),
      t(`Inspection type: ${i.type}`, `نوع التفتيش: ${i.type}`),
      t(`Status: ${i.status}${i.result ? ` — ${i.result}` : ''}`, `الحالة: ${i.status}${i.result ? ` — ${i.result}` : ''}`),
      t(`Carried out: ${when}`, `تاريخ التنفيذ: ${when}`),
      '',
      t(`Deficiencies raised: ${i.total_findings}. Still open: ${open.length}.`, `الملاحظات المرصودة: ${i.total_findings}. ما زال مفتوحاً منها: ${open.length}.`),
      ...(findings.length
        ? ['', t('Deficiencies:', 'الملاحظات:'), ...findings.slice(0, 12).map((f, n) => `${n + 1}. ${f.deficiencyCode ?? ''} — ${f.description ?? f.deficiencyLabel ?? t('described on the file', 'موصوفة في الملف')} (${f.status ?? 'OPEN'})`)]
        : ['', t('No deficiencies were raised on this inspection.', 'لم تُرصد ملاحظات في هذا التفتيش.')]),
      ...(i.detention ? ['', t('The vessel was detained. The detention order and its grounds are on the inspection file.', 'احتُجزت السفينة. أمر الاحتجاز وأسبابه مدوّنان في ملف التفتيش.')] : []),
      ...(input.note ? ['', t(`Officer's note: ${input.note}`, `ملاحظة الموظف: ${input.note}`)] : []),
      '',
      t(`Prepared from the inspection record on ${today} by ${preparedBy}. This is a draft and carries no decision.`,
        `أُعدّ من سجل التفتيش بتاريخ ${today} بواسطة ${preparedBy}. هذه مسودة ولا تتضمن قراراً.`),
    ].join('\n');
    return {
      title: t(`Inspection summary — ${i.number} (${i.vessel_name})`, `ملخص التفتيش — ${i.number} (${i.vessel_name})`), body,
      facts: { number: i.number, result: i.result, openFindings: open.length, totalFindings: i.total_findings, detention: i.detention },
      subjectType: 'Inspection', subjectLabel: `${i.number} — ${i.vessel_name}`,
      citations: [cite(i.id, `Inspection ${i.number}`, 'inspection', i.number, `/inspections/${i.id}`), ...(i.vessel_id ? [cite(i.vessel_id, i.vessel_name, 'vessel', '', `/vessels/${i.vessel_id}`)] : [])],
    };
  }

  if (input.kind === 'DEFICIENCY_NOTICE') {
    const r = await db.query<Row>('SELECT * FROM inspections WHERE id = $1 OR number = $1 LIMIT 1', [input.subjectId]);
    const i = r.rows[0];
    if (!i) return null;
    const findings: Row[] = (i.payload?.findings ?? []) as Row[];
    const open = findings.filter((f) => f.status === 'OPEN');
    const subject = i.payload?.subjectName ?? i.vessel_name;
    const when = dateOnly(i.closed_at ?? i.planned_at);
    const line = (f: Row, n: number) => `${n + 1}. ${f.deficiencyCode ?? ''} — ${f.description ?? f.deficiencyLabel ?? t('described on the file', 'موصوفة في الملف')}${f.actionCode ? t(` (action code ${f.actionCode})`, ` (رمز الإجراء ${f.actionCode})`) : ''}${f.dueDate ? t(`, by ${dateOnly(f.dueDate)}`, `، في موعد أقصاه ${dateOnly(f.dueDate)}`) : ''}`;
    const body = [
      t(`${i.detention ? 'NOTICE OF DETENTION' : 'DEFICIENCY NOTICE'} — ${i.number}`, `${i.detention ? 'إشعار احتجاز' : 'إشعار بأوجه القصور'} — ${i.number}`),
      '',
      t(`To the owner, operator or master of: ${subject}`, `إلى مالك أو مشغّل أو ربّان: ${subject}`),
      t(`Following the ${i.type} inspection carried out on ${when}, the deficiencies below were recorded.`, `عقب تفتيش ${i.type} الذي أُجري بتاريخ ${when}، سُجّلت أوجه القصور المبيّنة أدناه.`),
      '',
      ...(open.length
        ? [t('The following deficiencies are to be rectified within the period stated against each:', 'يجب تصحيح أوجه القصور التالية خلال المدة المبيّنة أمام كل منها:'), ...open.map(line)]
        : [t('No deficiency remains open on the inspection file.', 'لا يوجد قصور مفتوح في ملف التفتيش.')]),
      ...(i.detention ? ['', t('The vessel is detained until the detainable deficiencies are rectified and verified by the Authority.', 'السفينة محتجزة حتى تصحيح أوجه القصور الموجبة للاحتجاز والتحقق منها من قِبل الهيئة.')] : []),
      ...(input.note ? ['', t(`Officer's direction: ${input.note}`, `توجيه الموظف: ${input.note}`)] : []),
      '',
      t('Evidence of rectification is to be submitted to the Authority before the date stated. Failure to rectify may lead to further action under the applicable instruments.',
        'يجب تقديم ما يثبت التصحيح إلى الهيئة قبل التاريخ المحدد. وقد يؤدي عدم التصحيح إلى إجراءات أخرى بموجب الوثائق المعمول بها.'),
      '',
      t(`Prepared from the inspection record on ${today} by ${preparedBy}. This is a draft and has not been issued.`,
        `أُعدّ من سجل التفتيش بتاريخ ${today} بواسطة ${preparedBy}. هذه مسودة ولم تُصدر.`),
    ].join('\n');
    return {
      title: t(`${i.detention ? 'Notice of detention' : 'Deficiency notice'} — ${i.number} (${subject})`, `${i.detention ? 'إشعار احتجاز' : 'إشعار بأوجه القصور'} — ${i.number} (${subject})`), body,
      facts: { number: i.number, openFindings: open.length, totalFindings: i.total_findings, detention: i.detention },
      subjectType: 'Inspection', subjectLabel: `${i.number} — ${subject}`,
      citations: [cite(i.id, `Inspection ${i.number}`, 'inspection', i.number, `/inspections/${i.id}`)],
    };
  }

  if (input.kind === 'NOTICE') {
    const r = await db.query<Row>('SELECT * FROM vessels WHERE id = $1 OR imo = $1 LIMIT 1', [input.subjectId]);
    const v = r.rows[0];
    if (!v) return null;
    const certs = (await db.query<Row>(`SELECT cert_type, expiry_date, state FROM vessel_certificates WHERE vessel_id = $1 AND state <> 'VALID' ORDER BY expiry_date NULLS LAST`, [v.id])).rows;
    const open = (await db.query<Row>(`SELECT number, result, open_findings FROM inspections WHERE vessel_id = $1 AND status <> 'CLOSED' ORDER BY planned_at DESC LIMIT 3`, [v.id])).rows;
    const nr = t('not recorded', 'غير مسجَّل');
    const body = [
      t(`NOTICE TO THE OWNER, MANAGER OR MASTER — ${v.name} (IMO ${v.imo})`, `إشعار إلى مالك السفينة أو مديرها أو ربّانها — ${v.name} (IMO ${v.imo})`),
      '',
      t(`Flag: ${v.flag || nr} · Type: ${v.type || nr} · Built: ${v.built || nr}`, `العلم: ${v.flag || nr} · النوع: ${v.type || nr} · سنة البناء: ${v.built || nr}`),
      t(`Standing on the register: ${v.status}${v.risk_band ? ` · composite risk band ${v.risk_band}` : ''}`, `الوضع في السجل: ${v.status}${v.risk_band ? ` · فئة المخاطر المركّبة ${v.risk_band}` : ''}`),
      '',
      certs.length
        ? t(`The following certificates are not in good standing and are to be regularised:\n${certs.map((c, n) => `${n + 1}. ${c.cert_type} — ${c.state.toLowerCase()} (expiry ${dateOnly(c.expiry_date)})`).join('\n')}`,
          `الشهادات التالية ليست سارية المفعول ويجب تسوية وضعها:\n${certs.map((c, n) => `${n + 1}. ${c.cert_type} — ${c.state.toLowerCase()} (انتهاء الصلاحية ${dateOnly(c.expiry_date)})`).join('\n')}`)
        : t('No certificate on the register is out of force for this vessel.', 'لا توجد في السجل شهادة خارج السريان لهذه السفينة.'),
      ...(open.length
        ? ['', t(`Open survey work: ${open.map((i) => `${i.number} (${i.open_findings} deficiency/deficiencies open)`).join('; ')}.`, `أعمال المعاينة المفتوحة: ${open.map((i) => `${i.number} (${i.open_findings} ملاحظة/ملاحظات مفتوحة)`).join('؛ ')}.`)]
        : []),
      ...(input.note ? ['', t(`Additional direction: ${input.note}`, `توجيه إضافي: ${input.note}`)] : []),
      '',
      t('A written response is required to the Authority within fourteen (14) days of the date of this notice.', 'يُطلب ردّ خطي إلى الهيئة خلال أربعة عشر (14) يوماً من تاريخ هذا الإشعار.'),
      '',
      t(`Prepared from the vessel record on ${today} by ${preparedBy}. This is a draft and has not been issued.`,
        `أُعدّ من سجل السفينة بتاريخ ${today} بواسطة ${preparedBy}. هذه مسودة ولم تُصدر.`),
    ].join('\n');
    return {
      title: t(`Notice — ${v.name} (IMO ${v.imo})`, `إشعار — ${v.name} (IMO ${v.imo})`), body,
      facts: { imo: v.imo, certificatesOutOfForce: certs.length, openInspections: open.length, riskBand: v.risk_band },
      subjectType: 'Vessel', subjectLabel: `${v.name} (IMO ${v.imo})`,
      citations: [cite(v.id, v.name, 'vessel', v.imo, `/vessels/${v.id}`), ...(certs.length ? [cite(`${v.id}-certs`, `${v.name} — certificates`, 'vesselCertificate', '', `/vessels/${v.id}`)] : [])],
    };
  }

  // DECISION_LETTER — on an instrument the register already holds, or on an application read from the Service Desk
  const r = await db.query<Row>('SELECT * FROM instruments WHERE id = $1 OR number = $1 LIMIT 1', [input.subjectId]);
  const ins = r.rows[0];
  if (!ins) return decisionOnApplication(db, input, preparedBy, reader, lang, today);
  const decided = ins.status === 'ISSUED' ? t('approved', 'تمت الموافقة عليه') : ins.status === 'REJECTED' ? t('refused', 'مرفوض') : lower(ins.status);
  const body = [
    t(`DECISION — ${ins.entity_type.replace(/_/g, ' ')}`, `قرار — ${ins.entity_type.replace(/_/g, ' ')}`),
    '',
    t(`Applicant / holder: ${ins.entity_name}`, `مقدّم الطلب / صاحب الوثيقة: ${ins.entity_name}`),
    t(`Instrument number: ${ins.number}`, `رقم الوثيقة: ${ins.number}`),
    t(`Decision: the application is ${decided}.`, `القرار: الطلب ${decided}.`),
    ins.status === 'ISSUED'
      ? t(`The instrument is valid from ${dateOnly(ins.issue_date)} to ${dateOnly(ins.expiry_date)} and is ${ins.in_force ? 'in force' : 'not currently in force'}.`,
        `الوثيقة سارية من ${dateOnly(ins.issue_date)} إلى ${dateOnly(ins.expiry_date)} وهي ${ins.in_force ? 'نافذة حالياً' : 'غير نافذة حالياً'}.`)
      : t('The reasons are recorded on the application file and may be appealed within the statutory period.', 'الأسباب مدوّنة في ملف الطلب ويجوز التظلم من القرار خلال المدة القانونية.'),
    ...(input.note ? ['', t(`Officer's reasons: ${input.note}`, `أسباب الموظف: ${input.note}`)] : []),
    '',
    t('This decision may be verified publicly against the instrument register using the number above.', 'يمكن التحقق من هذا القرار علناً في سجل الوثائق بالرقم المذكور أعلاه.'),
    '',
    t(`Prepared from the instrument register on ${today} by ${preparedBy}. This is a draft and has not been signed or issued.`,
      `أُعدّ من سجل الوثائق بتاريخ ${today} بواسطة ${preparedBy}. هذه مسودة لم تُوقَّع ولم تُصدر.`),
  ].join('\n');
  return {
    title: t(`Decision letter — ${ins.number} (${ins.entity_name})`, `خطاب قرار — ${ins.number} (${ins.entity_name})`), body,
    facts: { number: ins.number, status: ins.status, inForce: ins.in_force, entityType: ins.entity_type },
    subjectType: 'Instrument', subjectLabel: `${ins.number} — ${ins.entity_name}`,
    citations: [cite(ins.id, `Instrument ${ins.number}`, 'instrument', ins.number, '/certificates')],
  };
}

/**
 * The decision letter on an application file. The file is the Service Desk's, so it is read through the tool
 * gateway as the officer asking (`services.application`, which the gateway checks against `services.view` and
 * logs). Without a gateway, or when the gateway refuses, there is nothing to draft from and the caller hears so.
 */
async function decisionOnApplication(db: Queryable, input: DraftInput, preparedBy: string, reader: DraftReader, lang: Lang, today: string): Promise<PreparedDraft | null> {
  if (!reader.gateway) return null;
  const t = (en: string, ar: string) => (lang === 'ar' ? ar : en);
  let run: Awaited<ReturnType<AiGatewayClient['run']>>;
  try { run = await reader.gateway.run('assistant', 'services.application', { id: input.subjectId }, { userToken: reader.userToken, cause: 'draft' }); } catch { return null; }
  if (run.outcome !== 'OK' || !run.data) return null;
  const a = run.data as Row;
  if (!a.number) return null;
  const status = String(a.status ?? a.currentState ?? '').toUpperCase();
  const decidedYes = status === 'APPROVED' || status === 'ISSUED'; const decidedNo = status === 'REJECTED';
  const applicant = a.applicant?.name ? `${a.applicant.name}${a.applicant.organisation && a.applicant.organisation !== a.applicant.name ? `, ${a.applicant.organisation}` : ''}` : (a.subjectName ?? t('not recorded', 'غير مسجَّل'));
  const documents: Row[] = Array.isArray(a.documents) ? a.documents : [];
  const verified = documents.filter((d) => d.verified).length;
  const decision = (a.timeline as Row[] | undefined)?.filter((e) => e.to === 'APPROVED' || e.to === 'REJECTED').at(-1);
  const service = lang === 'ar' ? (a.definitionNameAr || a.definitionName) : a.definitionName;
  // the instrument the file says was issued, when the register already holds it
  const issuedNo = typeof a.issuedInstrument === 'string' ? a.issuedInstrument : a.issuedInstrument?.number;
  const held = issuedNo ? (await db.query<Row>('SELECT * FROM instruments WHERE number = $1 OR id = $1 LIMIT 1', [String(issuedNo)])).rows[0] : undefined;
  const body = [
    t(`DECISION — ${service}`, `قرار — ${service}`),
    '',
    t(`Application number: ${a.number}`, `رقم الطلب: ${a.number}`),
    t(`Applicant: ${applicant}`, `مقدّم الطلب: ${applicant}`),
    ...(a.subjectName ? [t(`Subject of the application: ${a.subjectName}`, `موضوع الطلب: ${a.subjectName}`)] : []),
    t(`Submitted: ${dateOnly(a.submittedAt)} · Decided: ${a.decidedAt ? dateOnly(a.decidedAt) : 'not yet'}`, `تاريخ التقديم: ${dateOnly(a.submittedAt)} · تاريخ القرار: ${a.decidedAt ? dateOnly(a.decidedAt) : 'لم يصدر بعد'}`),
    '',
    decidedYes ? t('Decision: the application is approved.', 'القرار: تمت الموافقة على الطلب.')
      : decidedNo ? t('Decision: the application is refused.', 'القرار: رُفض الطلب.')
        : t(`Decision: none has been recorded on the file; the application is ${stateWords(status, 'en')}.`, `القرار: لم يُسجَّل قرار في الملف بعد؛ الطلب ${stateWords(status, 'ar')}.`),
    ...(decision?.note ? [t(`Grounds recorded on the file: ${decision.note}`, `الأسباب المدوّنة في الملف: ${decision.note}`)] : []),
    ...(issuedNo
      ? [held
        ? t(`Instrument issued: ${held.number}, valid from ${dateOnly(held.issue_date)} to ${dateOnly(held.expiry_date)}.`, `الوثيقة الصادرة: ${held.number}، سارية من ${dateOnly(held.issue_date)} إلى ${dateOnly(held.expiry_date)}.`)
        : t(`Instrument issued: ${issuedNo}.`, `الوثيقة الصادرة: ${issuedNo}.`)]
      : []),
    '',
    documents.length
      ? t(`Documents: ${documents.length} lodged, ${verified} verified.`, `المستندات: أُودع ${documents.length}، وتم التحقق من ${verified}.`)
      : t('Documents: none lodged.', 'المستندات: لم يُودع أي مستند.'),
    a.fees?.total != null
      ? t(`Fees: ${a.fees.currency ?? 'AED'} ${num(a.fees.total)} — ${a.payment?.status === 'PAID' ? `paid on ${dateOnly(a.payment.paidAt)}` : 'outstanding'}.`,
        `الرسوم: ${num(a.fees.total)} ${a.fees.currency ?? 'AED'} — ${a.payment?.status === 'PAID' ? `مسدَّدة بتاريخ ${dateOnly(a.payment.paidAt)}` : 'غير مسدَّدة'}.`)
      : t('Fees: none assessed on this file.', 'الرسوم: لم تُقدَّر رسوم على هذا الملف.'),
    ...(input.note ? ['', t(`Officer's reasons: ${input.note}`, `أسباب الموظف: ${input.note}`)] : []),
    '',
    decidedYes ? t('The applicant may rely on this decision from the date of this letter; the conditions of the service apply.', 'يجوز لمقدّم الطلب الاعتماد على هذا القرار من تاريخ هذا الخطاب، وتسري عليه شروط الخدمة.')
      : decidedNo ? t('The reasons are recorded on the application file and may be appealed within the statutory period.', 'الأسباب مدوّنة في ملف الطلب ويجوز التظلم من القرار خلال المدة القانونية.')
        : t('This letter anticipates a decision that has not yet been recorded on the file; it must not be issued until it has.', 'يستبق هذا الخطاب قراراً لم يُسجَّل بعد في الملف، ولا يجوز إصداره قبل تسجيله.'),
    '',
    t(`Prepared from the application file on ${today} by ${preparedBy}. This is a draft and has not been signed or issued.`,
      `أُعدّ من ملف الطلب بتاريخ ${today} بواسطة ${preparedBy}. هذه مسودة لم تُوقَّع ولم تُصدر.`),
  ].join('\n');
  const label = a.subjectName ?? a.applicant?.organisation ?? a.applicant?.name ?? '';
  return {
    title: t(`Decision letter — ${a.number}${label ? ` (${label})` : ''}`, `خطاب قرار — ${a.number}${label ? ` (${label})` : ''}`), body,
    facts: { number: a.number, status, decidedAt: a.decidedAt ?? null, documents: documents.length, verified, feeTotal: a.fees?.total ?? null, paid: a.payment?.status === 'PAID', issuedInstrument: issuedNo ?? null, readThrough: 'ai-tool-gateway' },
    subjectType: 'Application', subjectLabel: `${a.number} — ${service}`,
    citations: [cite(String(a.id ?? input.subjectId), `Application ${a.number}`, 'application', a.number, `/services/requests/${a.id ?? input.subjectId}`), ...(held ? [cite(held.id, `Instrument ${held.number}`, 'instrument', held.number, '/certificates')] : [])],
  };
}

export const mayPrepare = (kind: DraftKind, permissions: readonly string[]) => mayRead(DRAFT_PERMISSION[kind], permissions);

export async function publishDraft(c: Queryable, env: Env, d: DraftRecord, opts: { actor?: Actor } = {}) {
  const entity = draftApi(d);
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.readModel.upserted, { kind: 'aiDraft', entity }, { subject: d.id, actor: opts.actor }));
  await enqueue(c, eventFromContext(env.SERVICE_NAME, EVENTS.ai.draftPrepared, {
    draftId: d.id, kind: d.kind, subjectType: d.subject_type, subjectId: d.subject_id, subjectLabel: d.subject_label,
    title: d.title, citations: d.citations ?? [], preparedBy: d.prepared_by, status: d.status, draft: entity,
  }, { subject: d.id, actor: opts.actor }));
  return entity;
}
