-- Phase 3, Smart Inspection: a survey against any subject the regime master names, and the dated records the
-- six programme KPIs are measured from — the dossier before boarding, the report and the notices drafted on the
-- survey, the restriction the rules recommend and the decision on it, the prediction made before boarding and
-- how it scored — each kept as a row of its own and as a fact on the survey's timeline.

ALTER TABLE inspections ADD COLUMN IF NOT EXISTS subject_kind text NOT NULL DEFAULT 'VESSEL';
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS subject_id text;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS subject_name text NOT NULL DEFAULT '';
UPDATE inspections SET subject_id = vessel_id::text, subject_name = vessel_name WHERE subject_id IS NULL AND vessel_id IS NOT NULL;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS dossier jsonb;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS dossier_prepared_at timestamptz;
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS dossier_source text NOT NULL DEFAULT '';
-- what the close-out classified the survey as, and what the rules recommended on it
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS severity text NOT NULL DEFAULT '';
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS recommendation text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS inspections_subject_idx ON inspections (subject_kind, subject_id);

-- the subjects other domains own, as they publish them: companies, port facilities (the berths) and training institutions
CREATE TABLE IF NOT EXISTS subjects (
  kind text NOT NULL, id text NOT NULL, code text NOT NULL DEFAULT '', name text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'ACTIVE',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (kind, id)
);
CREATE INDEX IF NOT EXISTS subjects_name_idx ON subjects (kind, lower(name));

CREATE TABLE IF NOT EXISTS inspection_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  version int NOT NULL DEFAULT 1,
  source text NOT NULL DEFAULT 'MANUAL',   -- AI (the assistant drafted it) | MANUAL (an officer wrote it)
  status text NOT NULL DEFAULT 'DRAFT',    -- DRAFT | ISSUED | SUPERSEDED
  draft_id text,                            -- the assistant's draft this came from, when it did
  title text NOT NULL DEFAULT '', summary text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
  severity text NOT NULL DEFAULT '', recommendation text NOT NULL DEFAULT '',
  drafted_at timestamptz NOT NULL DEFAULT now(), drafted_by_id text, drafted_by text NOT NULL DEFAULT '',
  issued_at timestamptz, issued_by_id text, issued_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (inspection_id, version)
);
CREATE TABLE IF NOT EXISTS inspection_notices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  number text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'DEFICIENCY',  -- DEFICIENCY | DETENTION | WARNING | RECTIFICATION
  source text NOT NULL DEFAULT 'MANUAL',
  status text NOT NULL DEFAULT 'DRAFT',     -- DRAFT | ISSUED | WITHDRAWN
  draft_id text, addressed_to text NOT NULL DEFAULT '', subject text NOT NULL DEFAULT '', body text NOT NULL DEFAULT '',
  finding_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  drafted_at timestamptz NOT NULL DEFAULT now(), drafted_by_id text, drafted_by text NOT NULL DEFAULT '',
  issued_at timestamptz, issued_by_id text, issued_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inspection_notices_inspection_idx ON inspection_notices (inspection_id, drafted_at);
CREATE TABLE IF NOT EXISTS restriction_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'DETENTION',   -- DETENTION | RESTRICTION | BAN
  source text NOT NULL DEFAULT 'RULES',     -- RULES | AI | MANUAL
  grounds text NOT NULL DEFAULT '', finding_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  recommended_at timestamptz NOT NULL DEFAULT now(), recommended_by_id text, recommended_by text NOT NULL DEFAULT '',
  routed_at timestamptz, routed_to text NOT NULL DEFAULT '',
  decided_at timestamptz, decided_by_id text, decided_by text NOT NULL DEFAULT '', decision text NOT NULL DEFAULT '', decision_note text NOT NULL DEFAULT '',
  detention_id uuid,
  status text NOT NULL DEFAULT 'PENDING',   -- PENDING | APPROVED | REJECTED | DEFERRED
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS restriction_recommendations_inspection_idx ON restriction_recommendations (inspection_id);
CREATE INDEX IF NOT EXISTS restriction_recommendations_status_idx ON restriction_recommendations (status, recommended_at DESC);
CREATE TABLE IF NOT EXISTS inspection_predictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL UNIQUE REFERENCES inspections(id) ON DELETE CASCADE,
  source text NOT NULL DEFAULT 'RULES',     -- A5 (the Smart Inspection agent) | RULES (this service's own history rules)
  decision_id text, predicted_at timestamptz NOT NULL DEFAULT now(),
  risk_score numeric(5,1), band text NOT NULL DEFAULT '', predicted_codes jsonb NOT NULL DEFAULT '[]'::jsonb, basis jsonb NOT NULL DEFAULT '{}'::jsonb,
  scored_at timestamptz, outcome jsonb, correlated boolean,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
-- the latest judgement the Smart Inspection agent published for each ship, so a survey planned against her carries it
CREATE TABLE IF NOT EXISTS vessel_predictions (
  vessel_id text PRIMARY KEY, decision_id text, agent_id text NOT NULL DEFAULT '', predicted_at timestamptz NOT NULL,
  risk_score numeric(5,1), band text NOT NULL DEFAULT '', predicted_codes jsonb NOT NULL DEFAULT '[]'::jsonb, dossier jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
-- every dated fact about a survey, in the order it happened: the source the KPI evaluator reads
CREATE TABLE IF NOT EXISTS inspection_timeline (
  id bigserial PRIMARY KEY,
  inspection_id uuid NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  number text NOT NULL DEFAULT '', kind text NOT NULL, at timestamptz NOT NULL, source text NOT NULL DEFAULT '',
  meta jsonb NOT NULL DEFAULT '{}'::jsonb, event_id text, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inspection_timeline_inspection_idx ON inspection_timeline (inspection_id, at);
CREATE INDEX IF NOT EXISTS inspection_timeline_kind_idx ON inspection_timeline (kind, at);
CREATE UNIQUE INDEX IF NOT EXISTS inspection_timeline_event_idx ON inspection_timeline (event_id) WHERE event_id IS NOT NULL;
