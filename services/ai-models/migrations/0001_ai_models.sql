CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The model server's own copies of the records it learns from, projected from the same read-model events every
-- other service consumes, and seeded from the shared world. It keeps only the columns a feature is read from.
CREATE TABLE IF NOT EXISTS rm_vessels (
  id text PRIMARY KEY, imo text NOT NULL DEFAULT '', name text NOT NULL DEFAULT '', type text NOT NULL DEFAULT '', flag text NOT NULL DEFAULT '',
  built int, class_society text NOT NULL DEFAULT '', real boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rm_inspections (
  id text PRIMARY KEY, number text NOT NULL DEFAULT '', vessel_id text, type text NOT NULL DEFAULT '', status text NOT NULL DEFAULT '', result text NOT NULL DEFAULT '',
  detention boolean NOT NULL DEFAULT false, planned_at timestamptz, closed_at timestamptz, total_findings int NOT NULL DEFAULT 0, subject_kind text NOT NULL DEFAULT 'VESSEL',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rm_inspections_vessel_idx ON rm_inspections (vessel_id, closed_at);
CREATE TABLE IF NOT EXISTS rm_port_calls (
  id text PRIMARY KEY, vcn text NOT NULL DEFAULT '', vessel_id text NOT NULL DEFAULT '', vessel_type text NOT NULL DEFAULT '', agent_code text NOT NULL DEFAULT '', status text NOT NULL DEFAULT '',
  eta timestamptz, etb timestamptz, ata timestamptz, atb timestamptz, atd timestamptz, prev_port text NOT NULL DEFAULT '', teu int NOT NULL DEFAULT 0, cargo_mt numeric NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rm_port_calls_eta_idx ON rm_port_calls (eta);

-- A dataset is what a run learned from: how many rows, how many positives, which features and how they were read.
-- It is kept so a version can say what it was fitted on, and a later fit can be compared like for like.
CREATE TABLE IF NOT EXISTS datasets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_key text NOT NULL,
  built_at timestamptz NOT NULL DEFAULT now(),
  rows int NOT NULL DEFAULT 0,
  positives int,
  label_mean numeric,
  label_std numeric,
  feature_schema jsonb NOT NULL DEFAULT '[]'::jsonb,
  sample jsonb NOT NULL DEFAULT '[]'::jsonb,
  note text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS datasets_model_idx ON datasets (model_key, built_at DESC);

-- A run is a fit that was actually executed here: its parameters, the metrics read off the held-out rows, and the
-- version it became. A failed run stays on the record with its error.
CREATE TABLE IF NOT EXISTS training_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_key text NOT NULL,
  dataset_id uuid REFERENCES datasets(id) ON DELETE SET NULL,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')) DEFAULT 'RUNNING',
  error text,
  initiated_by text NOT NULL DEFAULT '',
  version int,
  registry_version int,
  registry_run_id text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  duration_ms int
);
CREATE INDEX IF NOT EXISTS training_runs_model_idx ON training_runs (model_key, started_at DESC);

-- The artefact is the model: the trees, the feature schema they read, and the metrics of the fit. One per version;
-- serving answers only from an artefact, so a version that was never fitted here cannot be served.
CREATE TABLE IF NOT EXISTS artefacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_key text NOT NULL,
  version int NOT NULL,
  task text NOT NULL,
  model jsonb NOT NULL,
  feature_schema jsonb NOT NULL DEFAULT '[]'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  training_run_id uuid REFERENCES training_runs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_key, version)
);

-- Serving, lightly: how often and how fast each version answered. The platform keeps the full inference record.
CREATE TABLE IF NOT EXISTS inference_log (
  id bigserial PRIMARY KEY,
  model_key text NOT NULL,
  version int NOT NULL,
  latency_ms int NOT NULL DEFAULT 0,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inference_log_model_idx ON inference_log (model_key, at DESC);
