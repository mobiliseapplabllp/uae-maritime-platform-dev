CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- The service catalogue: one row per service, its live PROD version and lifecycle.
CREATE TABLE IF NOT EXISTS service_definitions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  name_ar text,
  category text NOT NULL DEFAULT 'General',
  category_ar text,
  domain int NOT NULL DEFAULT 0,
  subject_kind text NOT NULL DEFAULT 'NONE' CHECK (subject_kind IN ('COMPANY', 'VESSEL', 'SEAFARER', 'PORT_FACILITY', 'MET_INSTITUTION', 'NONE')),
  description text NOT NULL DEFAULT '',
  description_ar text,
  owner_module text NOT NULL DEFAULT 'workflow',
  issues_instrument text,
  auto_approvable boolean NOT NULL DEFAULT false,
  current_version int,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'PUBLISHED', 'RETIRED')),
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_definitions_category_idx ON service_definitions(category, status);
-- Versioned definition content per environment; a version is promoted DEV -> UAT -> PROD and published in each.
CREATE TABLE IF NOT EXISTS service_definition_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  definition_id uuid NOT NULL REFERENCES service_definitions(id) ON DELETE CASCADE,
  version int NOT NULL,
  environment text NOT NULL DEFAULT 'DEV' CHECK (environment IN ('DEV', 'UAT', 'PROD')),
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'IN_REVIEW', 'APPROVED', 'PUBLISHED', 'RETIRED')),
  form jsonb NOT NULL DEFAULT '{"fields":[],"sections":[]}'::jsonb,
  documents jsonb NOT NULL DEFAULT '[]'::jsonb,
  fees jsonb NOT NULL DEFAULT '{}'::jsonb,
  sla jsonb NOT NULL DEFAULT '{"days":10}'::jsonb,
  workflow jsonb NOT NULL DEFAULT '{"states":[],"transitions":[]}'::jsonb,
  outputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  change_note text NOT NULL DEFAULT '',
  created_by text,
  submitted_by text,
  approved_by text,
  published_by text,
  published_at timestamptz,
  retired_at timestamptz,
  promoted_from text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (definition_id, version, environment)
);
CREATE INDEX IF NOT EXISTS service_definition_versions_live_idx ON service_definition_versions(definition_id, environment, status);
-- The request register: one application against one published definition version, carrying its own SLA clock.
CREATE TABLE IF NOT EXISTS service_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  definition_id uuid NOT NULL REFERENCES service_definitions(id),
  definition_key text NOT NULL,
  definition_name text NOT NULL,
  definition_name_ar text,
  definition_version int NOT NULL,
  environment text NOT NULL DEFAULT 'PROD',
  category text NOT NULL DEFAULT 'General',
  domain int NOT NULL DEFAULT 0,
  subject_kind text NOT NULL DEFAULT 'NONE',
  subject_id text,
  subject_name text NOT NULL DEFAULT '',
  subject jsonb NOT NULL DEFAULT '{}'::jsonb,
  applicant jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'DRAFT' CHECK (status IN ('DRAFT', 'SUBMITTED', 'UNDER_ASSESSMENT', 'INFO_REQUESTED', 'APPROVED', 'REJECTED', 'ISSUED', 'WITHDRAWN')),
  current_state text NOT NULL DEFAULT 'DRAFT',
  form_data jsonb NOT NULL DEFAULT '{}'::jsonb,
  documents jsonb NOT NULL DEFAULT '[]'::jsonb,
  fees jsonb NOT NULL DEFAULT '{}'::jsonb,
  payment jsonb NOT NULL DEFAULT '{}'::jsonb,
  assignee jsonb,
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  sla_due_at timestamptz,
  sla_breached boolean NOT NULL DEFAULT false,
  sla_breached_at timestamptz,
  submitted_at timestamptz,
  decided_at timestamptz,
  closed_at timestamptz,
  issued_instrument jsonb,
  timeline jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_requests_status_idx ON service_requests(status, sla_due_at);
CREATE INDEX IF NOT EXISTS service_requests_definition_idx ON service_requests(definition_key, created_at DESC);
CREATE INDEX IF NOT EXISTS service_requests_applicant_idx ON service_requests((applicant->>'userId'), created_at DESC);
CREATE INDEX IF NOT EXISTS service_requests_assignee_idx ON service_requests((assignee->>'userId'));
CREATE INDEX IF NOT EXISTS service_requests_open_sla_idx ON service_requests(sla_due_at) WHERE closed_at IS NULL;
CREATE TABLE IF NOT EXISTS request_notes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id uuid NOT NULL REFERENCES service_requests(id) ON DELETE CASCADE,
  author jsonb NOT NULL DEFAULT '{}'::jsonb,
  body text NOT NULL,
  internal boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS request_notes_request_idx ON request_notes(request_id, created_at);
-- Published rule sets mirrored from the rules service (seed + rules.ruleset.published events) so guards and fees evaluate in-process.
CREATE TABLE IF NOT EXISTS rule_set_cache (
  key text PRIMARY KEY,
  kind text NOT NULL,
  version int NOT NULL,
  definition jsonb NOT NULL,
  parameters jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
