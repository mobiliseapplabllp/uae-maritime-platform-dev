/* Agent-console constants and pure helpers — autonomy levels, decision dispositions and the wording of a run summary. */
import type { ChipColor } from '../../utils/status';
import type { AutonomyLevel, Disposition, RunResult } from './types';

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

/** Longest bar in the factor breakdown, so contributions are drawn relative to the biggest one. */
export const maxContribution = (factors: { contribution?: number }[]) => Math.max(1, ...factors.map((f) => Math.abs(f.contribution || 0)));
/** What an on-demand run did, in one sentence: "Berth Sentinel ran over live records — 3 decision(s) recorded (2 auto applied, 1 escalated)." */
export function runSummary(r: RunResult): string {
  const by = Object.entries(r.byDisposition || {}).map(([k, v]) => `${v} ${k.toLowerCase().replace(/_/g, ' ')}`).join(', ');
  return `${r.ran} ran over live records — ${r.recorded} decision(s) recorded${by ? ` (${by})` : ''}.`;
}
