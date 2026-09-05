/* Survey & Audit Cell constants and pure helpers — the regime master the screens read, answer types, the weighted compliance score and checklist editing. */
import type { Answer, AnswerType, ChecklistAnswer, ChecklistItem, ChecklistTemplate, InspectionResult, KpiStatus, SubjectKind } from './types';

/** The master every regime select and filter reads — a regime added in Data Studio appears on every screen without a release. */
export const REGIME_LOOKUP = 'inspectionRegime';
export const SUBJECT_KINDS: SubjectKind[] = ['VESSEL', 'COMPANY', 'PORT_FACILITY', 'MET_INSTITUTION'];
/** How the dashboard colours a KPI's standing; the standing itself comes from the evaluator. */
export const KPI_STATUS_COLOR: Record<KpiStatus, 'success' | 'info' | 'error' | 'default'> = { MET: 'success', ON_TRACK: 'info', BEHIND: 'error', NOT_CAPTURED: 'default' };
export const RECOMMENDATION_STATUS_COLOR: Record<string, 'warning' | 'error' | 'success' | 'default' | 'info'> = { PENDING: 'warning', APPROVED: 'error', REJECTED: 'success', DEFERRED: 'info' };
export const ANSWER_TYPES: [AnswerType, string][] = [['YES_NO', 'Yes / No'], ['YES_NO_NA', 'Yes / No / N.A.'], ['TEXT', 'Free text'], ['NUMBER', 'Number']];
export const answerTypeLabel = (v: string) => (ANSWER_TYPES.find(([k]) => k === v) || [v, v])[1];
export const DEFAULT_PASS_PCT = 80;
export const ANSWERS: Answer[] = ['YES', 'NO', 'NA'];

export interface LiveScore { pct: number | null; criticalFail: boolean; suggested: InspectionResult }
/** Live weighted compliance, mirroring the service's scoring at close: N/A and unanswered items are left out, a NO on a critical question fails the survey. */
export function scoreChecklist(checklist: ChecklistAnswer[], tpl: ChecklistTemplate | null, passScorePct = DEFAULT_PASS_PCT): LiveScore {
  const weightOf = new Map((tpl?.items || []).map((it) => [it.text, { w: it.weight || 1, critical: !!it.critical }]));
  let got = 0; let max = 0; let criticalFail = false;
  for (const c of checklist) {
    if (!c.answer || c.answer === 'NA') continue;
    const meta = weightOf.get(c.text) || { w: 1, critical: false };
    max += meta.w;
    if (c.answer === 'YES') got += meta.w; else if (meta.critical) criticalFail = true;
  }
  const pct = max > 0 ? Math.round((got / max) * 100) : null;
  const suggested: InspectionResult = criticalFail ? 'DETAINED' : pct !== null && pct < passScorePct ? 'DEFICIENCIES' : 'SATISFACTORY';
  return { pct, criticalFail, suggested };
}

export type IndexedItem = ChecklistItem & { idx: number };
/** Questions grouped by section in first-seen order, each carrying its position in the template. */
export function groupSections(items: ChecklistItem[]): [string, IndexedItem[]][] {
  const by = new Map<string, IndexedItem[]>();
  items.forEach((it, idx) => { if (!by.has(it.category)) by.set(it.category, []); by.get(it.category)!.push({ ...it, idx }); });
  return [...by.entries()];
}
export const reseq = (items: ChecklistItem[]): ChecklistItem[] => items.map((it, k) => ({ ...it, seq: k + 1 }));
export function moveItem(items: ChecklistItem[], idx: number, dir: -1 | 1): ChecklistItem[] {
  const j = idx + dir;
  if (j < 0 || j >= items.length) return items;
  const next = [...items];
  [next[idx], next[j]] = [next[j], next[idx]];
  return reseq(next);
}
export const totalWeight = (items: ChecklistItem[]) => items.reduce((s, i) => s + (i.weight || 1), 0);
export const slug = (name: string) => (name || 'new').toLowerCase().replace(/[^a-z0-9]+/g, '-');
export const newTemplate = (): ChecklistTemplate => ({ name: '', inspectionType: 'HSE', description: '', items: [], active: true, passScorePct: DEFAULT_PASS_PCT, version: 1 });
