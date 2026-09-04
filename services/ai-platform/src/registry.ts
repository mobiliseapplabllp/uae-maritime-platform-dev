import type { Distribution } from './drift';
import type { ModelTask } from './serving';

export const MODEL_TASKS = ['CLASSIFICATION', 'REGRESSION', 'RANKING', 'EXTRACTION', 'VISION', 'SPEECH', 'EMBEDDING', 'GENERATION'] as const;
export const VERSION_STATUSES = ['DRAFT', 'VALIDATED', 'APPROVED', 'DEPLOYED', 'RETIRED'] as const;
export const ENVIRONMENTS = ['DEV', 'UAT', 'PROD'] as const;
export type VersionStatus = (typeof VERSION_STATUSES)[number];
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * The lifecycle a version may move through. A version reaches serving only by way of a person approving it,
 * and there is no edge from DRAFT to DEPLOYED — the same maker-checker rule the platform applies to a
 * licence decision, applied to the model that informs one.
 */
export const VERSION_TRANSITIONS: Record<VersionStatus, VersionStatus[]> = {
  DRAFT: ['VALIDATED', 'RETIRED'],
  VALIDATED: ['APPROVED', 'DRAFT', 'RETIRED'],
  APPROVED: ['DEPLOYED', 'VALIDATED', 'RETIRED'],
  DEPLOYED: ['RETIRED'],
  RETIRED: [],
};
export const canMove = (from: VersionStatus, to: VersionStatus): boolean => VERSION_TRANSITIONS[from].includes(to);

export interface ModelRow {
  id: string; key: string; name: string; name_ar: string | null; task: ModelTask; purpose: string; purpose_ar: string | null;
  owner: string; framework: string; residency_region: string; residency_note: string; status: 'ACTIVE' | 'RETIRED';
  current_version: number | null; created_by: string | null; created_at: Date; updated_at: Date;
}
export interface VersionRow {
  id: string; model_id: string; version: number; artifact_ref: string; framework: string; training_run_id: string | null;
  metrics: Record<string, unknown>; params: Record<string, unknown>; status: VersionStatus; change_note: string;
  created_by: string | null; validated_by: string | null; approved_by: string | null; approved_at: Date | null;
  retired_at: Date | null; created_at: Date; updated_at: Date;
}
export interface TrainingRunRow {
  id: string; model_id: string; dataset_ref: string; dataset_rows: number; params: Record<string, unknown>;
  metrics: Record<string, unknown>; status: 'RUNNING' | 'SUCCEEDED' | 'FAILED'; note: string;
  initiated_by: string | null; started_at: Date; finished_at: Date | null;
}
export interface DeploymentRow {
  id: string; model_id: string; version: number; environment: Environment; status: 'ACTIVE' | 'SUPERSEDED' | 'ROLLED_BACK';
  endpoint: string; replicas: number; residency_region: string; note: string; deployed_by: string | null;
  deployed_at: Date; retired_at: Date | null;
}
export interface BaselineRow {
  id: string; model_id: string; version: number; captured_from: Date; captured_to: Date; sample_size: number;
  features: Record<string, Distribution>; output: Distribution | Record<string, never>; note: string;
  created_by: string | null; created_at: Date;
}
export interface DriftRunRow {
  id: string; model_id: string; version: number; baseline_id: string | null; window_from: Date; window_to: Date;
  sample_size: number; verdict: string; max_psi: string; results: unknown[]; run_by: string | null; at: Date;
}

export const modelToApi = (r: ModelRow) => ({
  id: r.id, key: r.key, name: r.name, nameAr: r.name_ar, task: r.task, purpose: r.purpose, purposeAr: r.purpose_ar,
  owner: r.owner, framework: r.framework,
  residency: { region: r.residency_region, note: r.residency_note },
  status: r.status, currentVersion: r.current_version, createdBy: r.created_by, createdAt: r.created_at, updatedAt: r.updated_at,
});
export const versionToApi = (r: VersionRow) => ({
  id: r.id, modelId: r.model_id, version: r.version, artifactRef: r.artifact_ref, framework: r.framework,
  trainingRunId: r.training_run_id, metrics: r.metrics, params: r.params, status: r.status, changeNote: r.change_note,
  createdBy: r.created_by, validatedBy: r.validated_by, approvedBy: r.approved_by, approvedAt: r.approved_at,
  retiredAt: r.retired_at, createdAt: r.created_at, updatedAt: r.updated_at,
});
export const trainingToApi = (r: TrainingRunRow) => ({
  id: r.id, modelId: r.model_id, datasetRef: r.dataset_ref, datasetRows: r.dataset_rows, params: r.params,
  metrics: r.metrics, status: r.status, note: r.note, initiatedBy: r.initiated_by, startedAt: r.started_at, finishedAt: r.finished_at,
});
export const deploymentToApi = (r: DeploymentRow) => ({
  id: r.id, modelId: r.model_id, version: r.version, environment: r.environment, status: r.status,
  endpoint: r.endpoint, replicas: r.replicas, residencyRegion: r.residency_region, note: r.note,
  deployedBy: r.deployed_by, deployedAt: r.deployed_at, retiredAt: r.retired_at,
});
export const baselineToApi = (r: BaselineRow) => ({
  id: r.id, modelId: r.model_id, version: r.version, capturedFrom: r.captured_from, capturedTo: r.captured_to,
  sampleSize: r.sample_size, features: Object.keys(r.features), note: r.note, createdBy: r.created_by, createdAt: r.created_at,
});
export const driftToApi = (r: DriftRunRow) => ({
  id: r.id, modelId: r.model_id, version: r.version, baselineId: r.baseline_id, windowFrom: r.window_from,
  windowTo: r.window_to, sampleSize: r.sample_size, verdict: r.verdict, maxPsi: Number(r.max_psi),
  results: r.results, runBy: r.run_by, at: r.at,
});
