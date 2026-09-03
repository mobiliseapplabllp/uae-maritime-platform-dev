/* Agent-console constants and pure helpers — autonomy levels, decision dispositions, the refusal codes the
 * autonomy ladder raises, and the wording of a run summary. Every code the service can return is given a
 * sentence here: an officer reading the queue should never be shown a raw enum. */
import type { ChipColor } from '../../utils/status';
import type { AutonomyLevel, Disposition, Effect, EscalationCode, ReviewStatus, RunResult } from './types';

export const LEVELS: AutonomyLevel[] = ['SUPERVISED', 'ASSISTED', 'AUTONOMOUS'];
/** Label, chip colour and what the level actually permits — shown wherever a level is offered. */
export const LEVEL_META: Record<AutonomyLevel, { label: string; color: ChipColor; blurb: string }> = {
  SUPERVISED: { label: 'Supervised', color: 'default', blurb: 'Every recommendation is reviewed before it takes effect' },
  ASSISTED: { label: 'Assisted', color: 'info', blurb: 'Acts alone above the confidence threshold, escalates below it' },
  AUTONOMOUS: { label: 'Autonomous', color: 'success', blurb: 'Acts and notifies, within the approved guardrails' },
};
export const levelLabel = (level: string) => LEVEL_META[level as AutonomyLevel]?.label ?? level;
/** The mandated agents run over live records on demand; the analytics workforce runs on its own schedule. */
export const isRunnable = (agentId: string) => /^a\d_/.test(agentId);
/** Raising latitude is a governance decision — the service refuses it without a written reason. */
export const raisesAutonomy = (from: AutonomyLevel, to: AutonomyLevel) => LEVELS.indexOf(to) > LEVELS.indexOf(from);

/** Disposition wording on a decision card — the long form, which says who acted. */
export const DISPOSITION_META: Record<Disposition, { label: string; color: ChipColor }> = {
  AUTO_APPLIED: { label: 'Applied automatically', color: 'success' },
  ESCALATED: { label: 'Escalated to a human', color: 'warning' },
  AWAITING_REVIEW: { label: 'Awaiting review', color: 'default' },
  APPROVED_BY_HUMAN: { label: 'Approved by a human', color: 'info' },
  OVERRIDDEN: { label: 'Overturned by a human', color: 'error' },
  REJECTED_BY_HUMAN: { label: 'Rejected by a human', color: 'error' },
};
/** The same outcomes in the register's column and filter, where the row already names the agent. */
export const DISPOSITION_SHORT: Record<Disposition, { label: string; color: ChipColor }> = {
  AUTO_APPLIED: { label: 'Applied automatically', color: 'success' },
  ESCALATED: { label: 'Escalated', color: 'warning' },
  AWAITING_REVIEW: { label: 'Awaiting review', color: 'default' },
  APPROVED_BY_HUMAN: { label: 'Approved', color: 'info' },
  OVERRIDDEN: { label: 'Overturned', color: 'error' },
  REJECTED_BY_HUMAN: { label: 'Rejected', color: 'error' },
};
export const dispositionMeta = (d: string, short = false) => (short ? DISPOSITION_SHORT : DISPOSITION_META)[d as Disposition] ?? { label: d, color: 'default' as ChipColor };
/** Escalated and unreviewed decisions are the human queue. */
export const PENDING: Disposition[] = ['AWAITING_REVIEW', 'ESCALATED'];
export const isPending = (d: string) => PENDING.includes(d as Disposition);

/** The review state reporting projects, alongside the disposition the agent's own row carries. */
export const REVIEW_STATUS_META: Record<ReviewStatus, { label: string; color: ChipColor }> = {
  AUTO: { label: 'No review needed', color: 'success' },
  PENDING: { label: 'With a human', color: 'warning' },
  REVIEWED: { label: 'Reviewed', color: 'info' },
  OVERRIDDEN: { label: 'Overturned', color: 'error' },
};
export const reviewStatusMeta = (s: string) => REVIEW_STATUS_META[s as ReviewStatus] ?? { label: s, color: 'default' as ChipColor };

/** What the proposed action would have done to the world. An advisory conclusion changes nothing by being recorded. */
export const EFFECTS: Effect[] = ['ADVISORY', 'REVERSIBLE', 'IRREVERSIBLE'];
export const EFFECT_META: Record<Effect, { label: string; color: ChipColor }> = {
  ADVISORY: { label: 'Advisory', color: 'default' },
  REVERSIBLE: { label: 'Reversible', color: 'info' },
  IRREVERSIBLE: { label: 'Irreversible', color: 'error' },
};
export const effectLabel = (e?: string | null) => (e ? EFFECT_META[e as Effect]?.label ?? e : '—');

/* The eight refusals the ladder can raise. The code is what the service records; the sentence is what an
 * officer reads, so nothing in this console ever shows a bare enum. */
export const ESCALATION_CODES: EscalationCode[] = ['BELOW_THRESHOLD', 'OUTSIDE_AUTONOMY', 'IRREVERSIBLE_EFFECT', 'CONFIRMATION_REQUIRED', 'AGENT_SUSPENDED', 'AGENT_DISABLED', 'RATE_LIMIT', 'BELOW_FLOOR'];
export const ESCALATION_META: Record<EscalationCode, { label: string; color: ChipColor; blurb: string }> = {
  BELOW_THRESHOLD: { label: 'Below its threshold', color: 'warning', blurb: 'The agent was less sure than the confidence threshold set for it, so it put the conclusion to a human.' },
  OUTSIDE_AUTONOMY: { label: 'Outside its autonomy', color: 'default', blurb: 'The agent is supervised: every conclusion it reaches is reviewed before it takes effect, however sure it is.' },
  IRREVERSIBLE_EFFECT: { label: 'Effect cannot be undone', color: 'error', blurb: 'The action could not have been reversed, so it is put to a human at any level and at any confidence.' },
  CONFIRMATION_REQUIRED: { label: 'Confirmation required', color: 'info', blurb: 'The agent acts with confirmation: an officer confirms the conclusion before it takes effect.' },
  AGENT_SUSPENDED: { label: 'Agent suspended', color: 'error', blurb: 'The agent is suspended. It still reaches conclusions and every one of them is recorded, but nothing is applied.' },
  AGENT_DISABLED: { label: 'Agent switched off', color: 'default', blurb: 'The agent is disabled. The conclusion is on the record; nothing was applied from it.' },
  RATE_LIMIT: { label: 'Hourly ceiling reached', color: 'warning', blurb: 'The agent had already acted up to the ceiling set for it this hour, so the rest of its conclusions wait for a human.' },
  BELOW_FLOOR: { label: 'Below the platform floor', color: 'error', blurb: 'Confidence fell below the platform-wide minimum, which no agent configuration can lower.' },
};
export const escalationMeta = (code?: string | null) =>
  (code && ESCALATION_META[code as EscalationCode]) || { label: code ? code.toLowerCase().replace(/_/g, ' ') : 'Not escalated', color: 'default' as ChipColor, blurb: '' };
/** The readable sentence for a refusal — the service's own wording where it gave one, the code's meaning otherwise. */
export const escalationText = (code?: string | null, reason?: string | null) => (reason && reason.trim()) || escalationMeta(code).blurb;

/* The governance trail records the column that moved; an officer reads the setting it belongs to. */
export const FIELD_LABELS: Record<string, string> = {
  autonomyLevel: 'Autonomy level', confidenceThreshold: 'Confidence threshold', requiresConfirmation: 'Confirmation required',
  maxActionsPerHour: 'Max actions / hour', escalateTo: 'Escalates to', enabled: 'Switched on', suspended: 'Suspension',
};
export const fieldLabel = (f: string) => FIELD_LABELS[f] ?? f.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

/** The dimensions the bias audit reads, in the order the service returns them. */
export const BIAS_DIMENSION_LABELS: Record<string, string> = {
  flag: 'Flag state', vesselType: 'Vessel type', ageBand: 'Age band', classSociety: 'Class society', serviceCode: 'Service', applicantKind: 'Applicant kind',
};
export const dimensionLabel = (d: string) => BIAS_DIMENSION_LABELS[d] ?? d.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

/** A percentage the service may not be able to compute yet — no reviewed decisions means no rate, not zero. */
export const pctText = (v: number | null | undefined, digits = 1) => (v === null || v === undefined ? '—' : `${Number(v).toFixed(digits).replace(/\.0$/, '')}%`);
/** Confidence and thresholds are ratios in the register; two places is what a reviewer can act on. */
export const confText = (v: number | null | undefined) => (v === null || v === undefined ? '—' : Number(v).toFixed(2));
/** Longest bar in the factor breakdown, so contributions are drawn relative to the biggest one. */
export const maxContribution = (factors: { contribution?: number }[]) => Math.max(1, ...factors.map((f) => Math.abs(f.contribution || 0)));
/** What an on-demand run did, in one sentence: "Berth Sentinel ran over live records — 3 decision(s) recorded (2 auto applied, 1 escalated)." */
export function runSummary(r: RunResult): string {
  const by = Object.entries(r.byDisposition || {}).map(([k, v]) => `${v} ${k.toLowerCase().replace(/_/g, ' ')}`).join(', ');
  return `${r.ran} ran over live records — ${r.recorded} decision(s) recorded${by ? ` (${by})` : ''}.`;
}

/** How an agent is woken: by a domain event, by its schedule, or only by hand from this console. */
export const TRIGGER_LABEL: Record<string, string> = { EVENT: 'On event', SCHEDULE: 'On schedule', MANUAL: 'By hand' };
export const triggerLabel = (kind?: string | null, cadence?: string | null) => {
  const base = TRIGGER_LABEL[String(kind)] ?? String(kind || '—');
  return cadence && kind === 'SCHEDULE' ? `${base} · ${cadence.toLowerCase()}` : base;
};
