CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS rule_sets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  name_ar text,
  kind text NOT NULL CHECK (kind IN ('ELIGIBILITY', 'VALIDATION', 'FEE', 'SLA')),
  description text NOT NULL DEFAULT '',
  description_ar text,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rule_sets_kind_idx ON rule_sets(kind);
CREATE TABLE IF NOT EXISTS rule_set_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_set_id uuid NOT NULL REFERENCES rule_sets(id) ON DELETE CASCADE,
  version int NOT NULL,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  definition jsonb NOT NULL DEFAULT '{}'::jsonb,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_note text NOT NULL DEFAULT '',
  created_by text,
  published_by text,
  published_at timestamptz,
  retired_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (rule_set_id, version)
);
CREATE INDEX IF NOT EXISTS rule_set_versions_status_idx ON rule_set_versions(rule_set_id, status);
CREATE TABLE IF NOT EXISTS rule_set_history (
  id bigserial PRIMARY KEY,
  rule_set_id uuid NOT NULL REFERENCES rule_sets(id) ON DELETE CASCADE,
  version int,
  action text NOT NULL,
  actor jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rule_set_history_idx ON rule_set_history(rule_set_id, id);
