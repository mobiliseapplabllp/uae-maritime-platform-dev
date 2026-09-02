/* The workflow every catalogue service runs unless its definition declares its own: the reference's request lifecycle
 * (submit → screening → assessment → decision → issue) expressed as states, transitions, roles and effects. */
import type { Effect, State, Transition, Workflow } from './schema';

export const CATEGORY_AR: Record<string, string> = {
  Registration: 'التسجيل', Licensing: 'الترخيص', Certification: 'الشهادات', Seafarers: 'البحارة', Accreditation: 'الاعتماد', Legislation: 'التشريعات',
  'Maritime centre': 'المركز البحري', Inspection: 'التفتيش', Security: 'الأمن', 'Port services': 'خدمات الموانئ', General: 'عام',
};
export const OWNER_MODULE_BY_DOMAIN: Record<number, string> = { 1: 'ships', 2: 'seafarers', 3: 'legislation', 4: 'maritime-centre', 5: 'inspection', 6: 'ports', 7: 'facilities' };
export const CATEGORY_ORDER = Object.keys(CATEGORY_AR);

export interface DefaultWorkflowOptions { issuesInstrument?: string | null; eligibilityRuleSetKey?: string | null; stageDays?: { screening?: number; technical?: number; approval?: number } }
/** Stage clocks the reference uses: a fifth for screening, half for the technical assessment, the rest for approval. */
export const stageDaysFor = (slaDays: number) => ({ screening: Math.max(1, Math.round(slaDays * 0.2)), technical: Math.max(1, Math.round(slaDays * 0.5)), approval: Math.max(1, Math.round(slaDays * 0.3)) });

const APPLICANT = ['services.apply', 'services.assess', 'services.manage'];
const ASSESSOR = ['services.assess', 'services.manage'];
const APPROVER = ['services.approve', 'services.manage'];
const state = (key: string, label: string, labelAr: string, kind: State['kind'], extra: Partial<State> = {}): State => ({ key, label, labelAr, kind, assignRole: null, slaDays: null, outcome: null, status: null, ...extra });
const tr = (from: string, to: string, action: string, label: string, labelAr: string, roles: string[], effects: Effect[] = [], extra: Partial<Transition> = {}): Transition => ({ from, to, action, label, labelAr, roles, effects, requireNote: false, ...extra });
const notify = (audience: 'applicant' | 'staff' | 'assignee', template: string): Effect => ({ type: 'notify', params: { audience, template } });
const effect = (type: Effect['type'], params: Record<string, unknown> = {}): Effect => ({ type, params });

export function defaultWorkflow(o: DefaultWorkflowOptions = {}): Workflow {
  const issues = !!o.issuesInstrument; const days = o.stageDays ?? {};
  const states: State[] = [
    state('DRAFT', 'Draft', 'مسودة', 'START', { status: 'DRAFT' }),
    state('SUBMITTED', 'Completeness screening', 'فحص الاكتمال', 'TASK', { assignRole: 'services.assess', slaDays: days.screening ?? 2, status: 'SUBMITTED' }),
    state('UNDER_ASSESSMENT', 'Technical assessment', 'التقييم الفني', 'TASK', { assignRole: 'services.assess', slaDays: days.technical ?? 5, status: 'UNDER_ASSESSMENT' }),
    state('INFO_REQUESTED', 'Information requested', 'طلب معلومات', 'TASK', { assignRole: 'services.apply', status: 'INFO_REQUESTED' }),
    issues ? state('APPROVED', 'Approved — awaiting issue', 'معتمد — بانتظار الإصدار', 'TASK', { assignRole: 'services.approve', slaDays: days.approval ?? 3, status: 'APPROVED' }) : state('APPROVED', 'Approved', 'معتمد', 'END', { outcome: 'APPROVED' }),
    ...(issues ? [state('ISSUED', 'Issued', 'صادر', 'END', { outcome: 'ISSUED' })] : []),
    state('REJECTED', 'Rejected', 'مرفوض', 'END', { outcome: 'REJECTED' }),
    state('WITHDRAWN', 'Withdrawn', 'مسحوب', 'END', { outcome: 'WITHDRAWN' }),
  ];
  const approveEffects: Effect[] = [effect('requireDocuments', { mode: 'verified' }), ...(o.eligibilityRuleSetKey ? [effect('callService', { service: 'rules', ruleSetKey: o.eligibilityRuleSetKey })] : []), notify('applicant', 'request.approved')];
  const transitions: Transition[] = [
    tr('DRAFT', 'SUBMITTED', 'submit', 'Submit application', 'تقديم الطلب', APPLICANT, [effect('computeFee'), notify('staff', 'request.submitted')]),
    tr('DRAFT', 'WITHDRAWN', 'withdraw', 'Withdraw', 'سحب', APPLICANT),
    tr('SUBMITTED', 'UNDER_ASSESSMENT', 'start_assessment', 'Start assessment', 'بدء التقييم', ASSESSOR, [notify('applicant', 'request.assessment-started')]),
    tr('SUBMITTED', 'WITHDRAWN', 'withdraw', 'Withdraw', 'سحب', APPLICANT, [notify('staff', 'request.withdrawn')]),
    tr('UNDER_ASSESSMENT', 'INFO_REQUESTED', 'request_info', 'Request information', 'طلب معلومات', ASSESSOR, [notify('applicant', 'request.info-requested')], { requireNote: true }),
    tr('INFO_REQUESTED', 'UNDER_ASSESSMENT', 'provide_info', 'Provide information', 'تقديم المعلومات', APPLICANT, [effect('setField', { field: 'infoProvidedAt', value: { now: [] } }), notify('assignee', 'request.info-provided')]),
    tr('INFO_REQUESTED', 'WITHDRAWN', 'withdraw', 'Withdraw', 'سحب', APPLICANT, [notify('staff', 'request.withdrawn')]),
    tr('UNDER_ASSESSMENT', 'APPROVED', 'approve', 'Approve', 'اعتماد', APPROVER, approveEffects),
    tr('UNDER_ASSESSMENT', 'REJECTED', 'reject', 'Reject', 'رفض', APPROVER, [notify('applicant', 'request.rejected')], { requireNote: true }),
    ...(issues ? [tr('APPROVED', 'ISSUED', 'issue', 'Issue instrument', 'إصدار الصك', APPROVER, [effect('issueInstrument'), notify('applicant', 'request.issued')])] : []),
  ];
  return { states, transitions };
}
