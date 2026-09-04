CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The model registry. A model is a capability the platform offers — "predict which arrivals are worth
-- inspecting" — and it is versioned separately from the code that calls it, because a regulator has to be
-- able to say which version decided a case and when it changed.
CREATE TABLE IF NOT EXISTS models (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  name_ar text,
  task text NOT NULL CHECK (task IN ('CLASSIFICATION', 'REGRESSION', 'RANKING', 'EXTRACTION', 'VISION', 'SPEECH', 'EMBEDDING', 'GENERATION')),
  purpose text NOT NULL DEFAULT '',
  purpose_ar text,
  owner text NOT NULL DEFAULT '',
  framework text NOT NULL DEFAULT '',
  -- Where inference physically happens. Recorded per model rather than assumed platform-wide, because the
  -- answer differs between a model served in-country and one called out to a hosted endpoint, and a
  -- deployment to production is refused when the region is not one the deployment allows.
  residency_region text NOT NULL DEFAULT 'AE',
  residency_note text NOT NULL DEFAULT '',
  status text NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')) DEFAULT 'ACTIVE',
  current_version int,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS models_task_idx ON models(task, status);

-- A training run. Kept even when it fails: "we tried this and it was worse" is the part of a model's history
-- that stops the same experiment being repeated in two years' time.
CREATE TABLE IF NOT EXISTS training_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  dataset_ref text NOT NULL DEFAULT '',
  dataset_rows int NOT NULL DEFAULT 0,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('RUNNING', 'SUCCEEDED', 'FAILED')) DEFAULT 'RUNNING',
  note text NOT NULL DEFAULT '',
  initiated_by text,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS training_runs_model_idx ON training_runs(model_id, started_at DESC);

-- A version moves DRAFT -> VALIDATED -> APPROVED -> DEPLOYED -> RETIRED. Approval is a person, recorded,
-- and deployment is refused without it: the same maker-checker rule the rest of the platform applies to a
-- decision applies to the model that informs one.
CREATE TABLE IF NOT EXISTS model_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  version int NOT NULL,
  artifact_ref text NOT NULL DEFAULT '',
  framework text NOT NULL DEFAULT '',
  training_run_id uuid REFERENCES training_runs(id),
  metrics jsonb NOT NULL DEFAULT '{}'::jsonb,
  params jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL CHECK (status IN ('DRAFT', 'VALIDATED', 'APPROVED', 'DEPLOYED', 'RETIRED')) DEFAULT 'DRAFT',
  change_note text NOT NULL DEFAULT '',
  created_by text,
  validated_by text,
  approved_by text,
  approved_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, version)
);
CREATE INDEX IF NOT EXISTS model_versions_status_idx ON model_versions(model_id, status);

CREATE TABLE IF NOT EXISTS deployments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  version int NOT NULL,
  environment text NOT NULL CHECK (environment IN ('DEV', 'UAT', 'PROD')),
  status text NOT NULL CHECK (status IN ('ACTIVE', 'SUPERSEDED', 'ROLLED_BACK')) DEFAULT 'ACTIVE',
  endpoint text NOT NULL DEFAULT '',
  replicas int NOT NULL DEFAULT 1,
  residency_region text NOT NULL DEFAULT 'AE',
  note text NOT NULL DEFAULT '',
  deployed_by text,
  deployed_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);
-- One live version per model per environment. Promotion supersedes rather than accumulates, so "what is
-- serving right now" has exactly one answer.
CREATE UNIQUE INDEX IF NOT EXISTS deployments_one_active ON deployments(model_id, environment) WHERE status = 'ACTIVE';
CREATE INDEX IF NOT EXISTS deployments_model_idx ON deployments(model_id, deployed_at DESC);

-- Every inference, with the latency it took. This is the evidence behind the sub-five-second commitment and
-- the input to drift detection, so it is written on the failure paths too: a request that timed out is the
-- one most worth having a record of.
CREATE TABLE IF NOT EXISTS inferences (
  id bigserial PRIMARY KEY,
  model_key text NOT NULL,
  model_id uuid REFERENCES models(id) ON DELETE SET NULL,
  version int NOT NULL DEFAULT 0,
  environment text NOT NULL DEFAULT 'DEV',
  status text NOT NULL CHECK (status IN ('OK', 'TIMEOUT', 'ERROR', 'REFUSED')) DEFAULT 'OK',
  latency_ms int NOT NULL DEFAULT 0,
  within_sla boolean NOT NULL DEFAULT true,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  confidence numeric,
  subject text NOT NULL DEFAULT '',
  actor jsonb NOT NULL DEFAULT '{}'::jsonb,
  correlation_id text,
  error text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inferences_model_at_idx ON inferences(model_key, at DESC);
CREATE INDEX IF NOT EXISTS inferences_sla_idx ON inferences(at DESC) WHERE within_sla = false;

-- The distribution a model version was accepted against. Drift is meaningless without one: "the inputs
-- changed" is only a statement about a reference point, and the reference point has to be captured
-- deliberately rather than inferred from whatever the data looked like last week.
CREATE TABLE IF NOT EXISTS baselines (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  version int NOT NULL,
  captured_from timestamptz NOT NULL,
  captured_to timestamptz NOT NULL,
  sample_size int NOT NULL DEFAULT 0,
  features jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text NOT NULL DEFAULT '',
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (model_id, version)
);

CREATE TABLE IF NOT EXISTS drift_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model_id uuid NOT NULL REFERENCES models(id) ON DELETE CASCADE,
  version int NOT NULL,
  baseline_id uuid REFERENCES baselines(id) ON DELETE SET NULL,
  window_from timestamptz NOT NULL,
  window_to timestamptz NOT NULL,
  sample_size int NOT NULL DEFAULT 0,
  verdict text NOT NULL CHECK (verdict IN ('STABLE', 'MODERATE', 'SIGNIFICANT', 'INSUFFICIENT')) DEFAULT 'INSUFFICIENT',
  max_psi numeric NOT NULL DEFAULT 0,
  results jsonb NOT NULL DEFAULT '[]'::jsonb,
  run_by text,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS drift_runs_model_idx ON drift_runs(model_id, at DESC);
