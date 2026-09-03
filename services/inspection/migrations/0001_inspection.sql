CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- One survey: PSC, flag state, ISM, ISPS or MLC. The checklist is copied from a template when the survey is
-- planned, so a later edit to the template can never change what an inspector actually answered; the weighted
-- score is written at close from that copy and the template version the copy came from.
CREATE TABLE IF NOT EXISTS inspections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  vessel_id uuid,
  vessel_name text NOT NULL DEFAULT '',
  vessel_imo text NOT NULL DEFAULT '',
  vessel_flag text NOT NULL DEFAULT '',
  vessel_type text NOT NULL DEFAULT '',
  port_call_id text,
  vcn text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT 'PSC',
  template_id uuid,
  template_version int,
  inspector_id text,
  inspector text NOT NULL DEFAULT '',
  planned_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  closed_at timestamptz,
  status text NOT NULL DEFAULT 'PLANNED',
  result text NOT NULL DEFAULT '',
  score_pct int,
  pass_score_pct int,
  critical_fail boolean NOT NULL DEFAULT false,
  detention boolean NOT NULL DEFAULT false,
  checklist jsonb NOT NULL DEFAULT '[]'::jsonb,
  remarks text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inspections_vessel_idx ON inspections(vessel_id, planned_at DESC);
CREATE INDEX IF NOT EXISTS inspections_status_idx ON inspections(status);
CREATE INDEX IF NOT EXISTS inspections_type_idx ON inspections(type);
CREATE INDEX IF NOT EXISTS inspections_planned_idx ON inspections(planned_at DESC);
CREATE INDEX IF NOT EXISTS inspections_detention_idx ON inspections(detention) WHERE detention;

-- A deficiency raised on a survey. It carries its own code, category and severity so the deficiency register
-- reads without opening every survey, and a rectification deadline the fleet is measured against.
CREATE TABLE IF NOT EXISTS findings (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  seq int NOT NULL DEFAULT 1,
  deficiency_code text NOT NULL,
  deficiency_label text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  severity text NOT NULL DEFAULT 'MINOR',
  description text NOT NULL DEFAULT '',
  action_code text NOT NULL DEFAULT '',
  due_date timestamptz,
  status text NOT NULL DEFAULT 'OPEN',
  closed_at timestamptz,
  rectification_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS findings_inspection_idx ON findings(inspection_id, seq);
CREATE INDEX IF NOT EXISTS findings_status_idx ON findings(status);
CREATE INDEX IF NOT EXISTS findings_code_idx ON findings(deficiency_code);

-- A detention order and its release, kept apart from the survey so the order stands on its own record with the
-- grounds it was made on and the deficiencies that had to be cleared before the ship was released.
CREATE TABLE IF NOT EXISTS detentions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  inspection_id uuid NOT NULL REFERENCES inspections(id) ON DELETE CASCADE,
  vessel_id uuid,
  vessel_name text NOT NULL DEFAULT '',
  ordered_at timestamptz NOT NULL DEFAULT now(),
  ordered_by_id text,
  ordered_by text NOT NULL DEFAULT '',
  grounds text NOT NULL DEFAULT '',
  detainable_codes jsonb NOT NULL DEFAULT '[]'::jsonb,
  released_at timestamptz,
  released_by_id text,
  released_by text NOT NULL DEFAULT '',
  release_note text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ORDERED',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS detentions_inspection_idx ON detentions(inspection_id);
CREATE INDEX IF NOT EXISTS detentions_status_idx ON detentions(status);

-- A versioned checklist template: sections, questions, answer types, weights and the critical flag. A template is
-- never edited in place in a way that rewrites history — every save raises the version, and a retired template
-- stays on the register because surveys point at the version they were worked from.
CREATE TABLE IF NOT EXISTS checklist_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  inspection_type text NOT NULL DEFAULT 'PSC',
  description text NOT NULL DEFAULT '',
  items jsonb NOT NULL DEFAULT '[]'::jsonb,
  active boolean NOT NULL DEFAULT true,
  version int NOT NULL DEFAULT 1,
  pass_score_pct int NOT NULL DEFAULT 80,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS checklist_templates_name_idx ON checklist_templates(lower(name));
CREATE INDEX IF NOT EXISTS checklist_templates_type_idx ON checklist_templates(inspection_type, active);

-- Local snapshots of what other domains own: the fleet the surveys are raised against, the calls they are
-- attached to and the deficiency and action code masters, all projected from their read-model events.
CREATE TABLE IF NOT EXISTS vessels (
  id text PRIMARY KEY,
  imo text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT 'GEN',
  flag text NOT NULL DEFAULT '',
  grt int,
  built int,
  agent_code text,
  status text NOT NULL DEFAULT 'ACTIVE',
  real boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vessels_name_idx ON vessels(name);

CREATE TABLE IF NOT EXISTS port_calls (
  id text PRIMARY KEY,
  vcn text NOT NULL DEFAULT '',
  vessel_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ANNOUNCED',
  berth_code text,
  eta timestamptz,
  atb timestamptz,
  atd timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS port_calls_vessel_idx ON port_calls(vessel_id, eta DESC);

CREATE TABLE IF NOT EXISTS lookups (
  id text PRIMARY KEY,
  category text NOT NULL,
  code text NOT NULL,
  label text NOT NULL DEFAULT '',
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lookups_category_idx ON lookups(category, code);
