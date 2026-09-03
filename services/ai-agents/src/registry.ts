import { EVENTS, type Actor, type EventEnvelope, makeEvent } from '@maritime/contracts';
import { enqueue, eventFromContext, type Queryable } from '@maritime/service-kit';
import type { Env } from './env';
import { type AgentPolicy, type AutonomyLevel } from './autonomy';

/* The agent register.
 *
 * An agent here is a row, not a class: its name in both languages, the domain it serves, what wakes it, how much
 * latitude it holds, the confidence it must reach, whether an officer confirms, and whether it is switched on.
 * The runtime reads that row on every decision, so the authority narrows an agent by editing a record — no
 * redeploy, no vendor. The catalogue below is only the starting posture the register is seeded with. */

export type Row = Record<string, any>;

export interface AgentRecord {
  id: string; agent_id: string; name: string; name_ar: string; description: string; description_ar: string; role: string; domain: number; mandated: boolean;
  trigger_kind: string; trigger_subjects: string[]; cadence: string; cron: string; timezone: string;
  autonomy_level: string; confidence_threshold: string | number; requires_confirmation: boolean; max_actions_per_hour: number; escalate_to: string;
  enabled: boolean; suspended: boolean; suspended_reason: string; suspended_by: string; suspended_at: Date | null; last_run_at: Date | null;
  created_at: Date; updated_at: Date;
}
export interface AgentStats { decisions: number; autoApplied: number; escalated: number; awaitingReview: number; overridden: number; approved: number; avgConfidence: number; lastRunAt: string | null }
export interface AgentChangeRecord { id: string; agent_id: string; field: string; from_value: string; to_value: string; at: Date; by_id: string; by: string; reason: string }

export const EMPTY_STATS: AgentStats = { decisions: 0, autoApplied: 0, escalated: 0, awaitingReview: 0, overridden: 0, approved: 0, avgConfidence: 0, lastRunAt: null };
const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null);
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/** Agreement between the agent and the humans who looked at it: reviewed decisions that were not overturned. */
export function agreementRate(s: AgentStats): number | null {
  const reviewed = s.approved + s.overridden;
  return reviewed ? Math.round((s.approved / reviewed) * 1000) / 10 : null;
}

export const changeApi = (c: AgentChangeRecord) => ({ field: c.field, from: c.from_value, to: c.to_value, at: iso(c.at)!, by: c.by, byId: c.by_id || null, reason: c.reason });

export function agentApi(a: AgentRecord, stats: AgentStats = EMPTY_STATS, changes?: AgentChangeRecord[]) {
  return {
    id: a.id, agentId: a.agent_id, name: a.name, nameAr: a.name_ar || null, description: a.description, descriptionAr: a.description_ar || null,
    role: a.role, domain: a.domain, mandated: a.mandated,
    trigger: { kind: a.trigger_kind, subjects: a.trigger_subjects ?? [], cron: a.cron, cadence: a.cadence },
    schedule: { cadence: a.cadence, cron: a.cron, timezone: a.timezone },
    enabled: a.enabled, autonomyLevel: a.autonomy_level as AutonomyLevel, confidenceThreshold: num(a.confidence_threshold),
    requiresConfirmation: a.requires_confirmation, maxActionsPerHour: a.max_actions_per_hour, escalateTo: a.escalate_to,
    suspended: a.suspended, suspendedReason: a.suspended_reason, suspendedBy: a.suspended_by, suspendedAt: iso(a.suspended_at),
    lastRunAt: iso(a.last_run_at), stats, agreementRate: agreementRate(stats),
    ...(changes ? { changes: changes.map(changeApi) } : {}),
    createdAt: iso(a.created_at), updatedAt: iso(a.updated_at),
  };
}
export type AgentApi = ReturnType<typeof agentApi>;

/** The configuration the ladder is applied from. Nothing else may decide what an agent is allowed to do. */
export const policyOf = (a: AgentRecord): AgentPolicy => ({
  agentId: a.agent_id, name: a.name, autonomyLevel: a.autonomy_level as AutonomyLevel, confidenceThreshold: num(a.confidence_threshold),
  requiresConfirmation: a.requires_confirmation, maxActionsPerHour: a.max_actions_per_hour, enabled: a.enabled, suspended: a.suspended, suspendedReason: a.suspended_reason,
});

/* Rolling counts per agent, read from the register itself rather than kept in a column that can drift from it.
 * Only the agent's own conclusions are counted — a reviewer's verdict is a superseding row, and counting both
 * would say the agent decided twice. The verdict is read off the original row's review state instead. */
export async function statsByAgent(c: Queryable): Promise<Map<string, AgentStats>> {
  const r = await c.query<Row>(`SELECT agent_id,
      count(*)::int AS decisions,
      count(*) FILTER (WHERE disposition = 'AUTO_APPLIED')::int AS auto_applied,
      count(*) FILTER (WHERE disposition = 'ESCALATED')::int AS escalated,
      count(*) FILTER (WHERE disposition = 'AWAITING_REVIEW')::int AS awaiting_review,
      count(*) FILTER (WHERE review_status = 'OVERRIDDEN')::int AS overridden,
      count(*) FILTER (WHERE review_status = 'REVIEWED')::int AS approved,
      avg(confidence) AS avg_confidence, max(at) AS last_run_at
    FROM decisions WHERE supersedes_id IS NULL GROUP BY agent_id`);
  const out = new Map<string, AgentStats>();
  for (const s of r.rows) {
    out.set(s.agent_id, {
      decisions: s.decisions, autoApplied: s.auto_applied, escalated: s.escalated, awaitingReview: s.awaiting_review,
      overridden: s.overridden, approved: s.approved, avgConfidence: Math.round(num(s.avg_confidence) * 1000) / 1000, lastRunAt: iso(s.last_run_at),
    });
  }
  return out;
}

export async function changesOf(c: Queryable, agentId: string): Promise<AgentChangeRecord[]> {
  return (await c.query<AgentChangeRecord>('SELECT * FROM agent_changes WHERE agent_id = $1 ORDER BY at DESC, id', [agentId])).rows;
}

/** Every configuration write publishes the record for the read models and the change itself for the governance trail. */
export async function publishAgent(c: Queryable, env: Env, a: AgentRecord, stats: AgentStats, opts: { event?: string; data?: Row; cause?: EventEnvelope; actor?: Actor } = {}) {
  const entity = agentApi(a, stats);
  const mk = <T,>(type: string, data: T) => (opts.cause
    ? makeEvent({ type, source: env.SERVICE_NAME, data, subject: a.agent_id, correlationId: opts.cause.correlationid, causationId: opts.cause.id, actor: opts.actor ?? opts.cause.actor })
    : eventFromContext(env.SERVICE_NAME, type, data, { subject: a.agent_id, actor: opts.actor }));
  await enqueue(c, mk(EVENTS.readModel.upserted, { kind: 'agent', entity }));
  if (opts.event) {
    await enqueue(c, mk(opts.event, {
      agentId: a.agent_id, name: a.name, autonomyLevel: a.autonomy_level, confidenceThreshold: num(a.confidence_threshold),
      enabled: a.enabled, suspended: a.suspended, agent: entity, ...(opts.data ?? {}),
    }));
  }
  return entity;
}

/* ------------------------------------------------------------------ the mandated catalogue --- */

/** The starting posture of one agent: what it is for, what wakes it, and how far it may go on its own. */
export interface AgentSeedDef {
  agentId: string; description: string; descriptionAr: string; mandated: boolean;
  triggerKind: 'EVENT' | 'SCHEDULE' | 'MANUAL'; triggerSubjects: string[]; requiresConfirmation: boolean;
}

/* The seven the RFP mandates, each woken by the domain event it is actually about. Confirmation is required
 * wherever the conclusion touches a person's application or a ship's standing; it is not required where the
 * agent only publishes a picture or answers an enquiry. */
export const MANDATED: AgentSeedDef[] = [
  {
    agentId: 'a1_document_intelligence', mandated: true, triggerKind: 'EVENT', requiresConfirmation: true,
    triggerSubjects: [EVENTS.workflow.requestSubmitted, EVENTS.workflow.requestDocument, EVENTS.documents.scanned],
    description: 'Reads the documents lodged with an application against the list the service requires, checks each one for presence, verification, date coherence and identifier integrity, and says what is missing.',
    descriptionAr: 'يفحص المستندات المقدمة مع الطلب مقابل القائمة التي تتطلبها الخدمة، ويتحقق من وجودها وتوثيقها واتساق تواريخها وسلامة معرفاتها، ويحدد الناقص منها.',
  },
  {
    agentId: 'a2_vessel_compliance', mandated: true, triggerKind: 'SCHEDULE', requiresConfirmation: true,
    triggerSubjects: [EVENTS.instruments.expiring, EVENTS.instruments.issued, EVENTS.ships.certUpdated],
    description: 'Rescores a ship against her certificates, her inspection history, her detentions and the instruments held in her name, and flags any that are no longer in force.',
    descriptionAr: 'يعيد تقييم السفينة استناداً إلى شهاداتها وسجل تفتيشها واحتجازاتها والتراخيص الصادرة باسمها، ويشير إلى ما لم يعد سارياً منها.',
  },
  {
    agentId: 'a3_service_processing', mandated: true, triggerKind: 'EVENT', requiresConfirmation: true,
    triggerSubjects: [EVENTS.workflow.requestSubmitted, EVENTS.workflow.requestTransitioned],
    description: 'Runs an application through the eligibility gates the service defines — documents, verification, subject on the register, fee, compliance holds and applicant history — and says whether it may issue or must be held.',
    descriptionAr: 'يمرّر الطلب عبر بوابات الأهلية التي تحددها الخدمة — المستندات والتوثيق ووجود الموضوع في السجل والرسوم وقيود الامتثال وسجل مقدم الطلب — ويحدد ما إذا كان يمكن إصداره أو يجب تعليقه.',
  },
  {
    agentId: 'a4_customer_guidance', mandated: true, triggerKind: 'EVENT', requiresConfirmation: false,
    triggerSubjects: [EVENTS.workflow.requestTransitioned, EVENTS.workflow.requestNotify],
    description: 'Tells an applicant where the application stands, what is outstanding, what happens next and how much of the service level remains.',
    descriptionAr: 'يبلغ مقدم الطلب بموقف طلبه وما هو مطلوب منه والخطوة التالية والمدة المتبقية من مستوى الخدمة.',
  },
  {
    agentId: 'a5_smart_inspection', mandated: true, triggerKind: 'SCHEDULE', requiresConfirmation: true,
    triggerSubjects: [EVENTS.ports.portCallScheduled, EVENTS.inspection.closed, EVENTS.inspection.detention],
    description: 'Selects ships for boarding from composite risk and time since last inspection, and hands the boarding party a dossier with the deficiencies her history predicts.',
    descriptionAr: 'يختار السفن للتفتيش استناداً إلى درجة الخطر المركبة والمدة منذ آخر تفتيش، ويزوّد فريق التفتيش بملف يتضمن أوجه القصور المتوقعة من سجلها.',
  },
  {
    agentId: 'a6_regulatory_intelligence', mandated: true, triggerKind: 'SCHEDULE', requiresConfirmation: true,
    triggerSubjects: [EVENTS.legislation.instrumentPublished, EVENTS.legislation.instrumentSuperseded],
    description: 'Reads the register of instruments for gaps and conflicts: supersession chains that do not close, instruments in force on the same subject, and the services each one bears on.',
    descriptionAr: 'يفحص سجل التشريعات بحثاً عن الفجوات والتعارضات: سلاسل الإلغاء غير المكتملة، والتشريعات السارية على الموضوع ذاته، والخدمات المتأثرة بكل منها.',
  },
  {
    agentId: 'a7_maritime_intelligence', mandated: true, triggerKind: 'SCHEDULE', requiresConfirmation: false,
    triggerSubjects: [EVENTS.maritimeCentre.incidentOpened, EVENTS.maritimeCentre.alertRaised, EVENTS.inspection.detention],
    description: 'Publishes the national maritime picture — open incidents by severity, certificate concentrations and recent detentions — and raises its level when the anomalies warrant it.',
    descriptionAr: 'ينشر الصورة البحرية الوطنية — الحوادث المفتوحة حسب شدتها وتركزات الشهادات والاحتجازات الأخيرة — ويرفع مستواها عند وجود ما يستدعي ذلك.',
  },
];

/* The analytics workforce that keeps the operational panels current. They read and summarise rather than decide,
 * which is why several of them sit higher on the ladder than the agents that touch a licence. */
export const WORKFORCE: AgentSeedDef[] = [
  { agentId: 'collector', mandated: false, triggerKind: 'SCHEDULE', requiresConfirmation: false, triggerSubjects: [EVENTS.scheduler.jobCompleted], description: 'Rebuilds the operational panels from the latest snapshot of the port record.', descriptionAr: 'يعيد بناء لوحات التشغيل من أحدث لقطة لسجل الميناء.' },
  { agentId: 'curator', mandated: false, triggerKind: 'SCHEDULE', requiresConfirmation: false, triggerSubjects: [], description: 'Reconciles each figure quoted in an analysis pack against the panel that produced it.', descriptionAr: 'يطابق كل رقم مذكور في حزمة التحليل مع اللوحة التي أنتجته.' },
  { agentId: 'sentinel', mandated: false, triggerKind: 'EVENT', requiresConfirmation: true, triggerSubjects: [EVENTS.ports.berthed, EVENTS.ports.sailed], description: 'Watches waiting time and berth occupancy against their baselines and flags a sustained departure.', descriptionAr: 'يراقب زمن الانتظار وإشغال الأرصفة مقارنة بخط الأساس ويشير إلى أي انحراف مستمر.' },
  { agentId: 'auditor', mandated: false, triggerKind: 'SCHEDULE', requiresConfirmation: true, triggerSubjects: [], description: 'Scores terminal service against the published benchmark for the berth class.', descriptionAr: 'يقيّم أداء المحطة مقارنة بالمعيار المنشور لفئة الرصيف.' },
  { agentId: 'planner', mandated: false, triggerKind: 'EVENT', requiresConfirmation: true, triggerSubjects: [EVENTS.ports.portCallScheduled], description: 'Proposes a berth window that fits declared length and draft with clearance either side.', descriptionAr: 'يقترح نافذة رسو تتوافق مع الطول والغاطس المعلنين مع هامش أمان على الجانبين.' },
  { agentId: 'analyst', mandated: false, triggerKind: 'SCHEDULE', requiresConfirmation: true, triggerSubjects: [], description: 'Identifies shifts in the cargo mix against the trailing year.', descriptionAr: 'يحدد التحولات في تركيبة البضائع مقارنة بالعام السابق.' },
  { agentId: 'examiner', mandated: false, triggerKind: 'EVENT', requiresConfirmation: false, triggerSubjects: [], description: 'Rejects a draft finding whose cited figures do not reconcile with their source.', descriptionAr: 'يرفض أي نتيجة مسودة لا تتطابق أرقامها المذكورة مع مصدرها.' },
  { agentId: 'validator', mandated: false, triggerKind: 'EVENT', requiresConfirmation: false, triggerSubjects: [], description: 'Validates a generated narrative by tracing every figure in it to the panel that produced it.', descriptionAr: 'يتحقق من صحة السرد المُولَّد بتتبع كل رقم فيه إلى اللوحة التي أنتجته.' },
  { agentId: 'supervisor', mandated: false, triggerKind: 'SCHEDULE', requiresConfirmation: true, triggerSubjects: [], description: 'Sequences the workforce, handing each agent the output the next one needs.', descriptionAr: 'ينظم تسلسل عمل الوكلاء، ويسلّم مخرجات كل وكيل إلى الوكيل التالي.' },
];

export const SEED_DEFS: AgentSeedDef[] = [...MANDATED, ...WORKFORCE];
export const SEED_DEF_BY_ID = new Map(SEED_DEFS.map((d) => [d.agentId, d]));
/** The agents an officer may run by hand from the console — the mandated seven work case by case. */
export const isRunnable = (agentId: string) => /^a\d_/.test(agentId);
/** Every event subject any agent is woken by, for the consumer's subscription. */
export const TRIGGER_SUBJECTS = [...new Set(SEED_DEFS.flatMap((d) => d.triggerSubjects))];
/** Which agents a given event subject wakes. */
export const agentsForSubject = (type: string) => SEED_DEFS.filter((d) => d.triggerSubjects.includes(type)).map((d) => d.agentId);
