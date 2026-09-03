CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- One agent on the register. Everything that decides what it may do is a column, not a constant in code: the
-- domain it serves, what triggers it, how much latitude it holds, the confidence it must reach before acting,
-- whether a human must confirm, what it may never do alone, and whether it is switched on at all. The runtime
-- reads these rows on every decision, so narrowing an agent takes effect on its next run and needs no deploy.
CREATE TABLE IF NOT EXISTS agents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL UNIQUE,
  name text NOT NULL,
  name_ar text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  description_ar text NOT NULL DEFAULT '',
  role text NOT NULL DEFAULT '',
  domain int NOT NULL DEFAULT 0,
  mandated boolean NOT NULL DEFAULT false,
  -- trigger: an event subject the agent reacts to, a schedule it runs on, or a hand on the console
  trigger_kind text NOT NULL DEFAULT 'EVENT',
  trigger_subjects text[] NOT NULL DEFAULT '{}',
  cadence text NOT NULL DEFAULT 'EVENT',
  cron text NOT NULL DEFAULT '',
  timezone text NOT NULL DEFAULT 'UTC',
  -- the ladder: SUPERVISED (suggest only) → ASSISTED (act with confirmation) → AUTONOMOUS (act within limits)
  autonomy_level text NOT NULL DEFAULT 'SUPERVISED',
  confidence_threshold numeric(4,3) NOT NULL DEFAULT 0.900,
  requires_confirmation boolean NOT NULL DEFAULT true,
  max_actions_per_hour int NOT NULL DEFAULT 100,
  escalate_to text NOT NULL DEFAULT 'agents.review',
  enabled boolean NOT NULL DEFAULT true,
  suspended boolean NOT NULL DEFAULT false,
  suspended_reason text NOT NULL DEFAULT '',
  suspended_by text NOT NULL DEFAULT '',
  suspended_at timestamptz,
  last_run_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agents_domain_idx ON agents(domain, name);
CREATE INDEX IF NOT EXISTS agents_level_idx ON agents(autonomy_level);

-- Every change to what an agent may do, kept for the governance record: who widened or narrowed it, when, and why.
-- Raising latitude without a written reason is refused by the service, so this table can answer "who allowed this?".
CREATE TABLE IF NOT EXISTS agent_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
  field text NOT NULL,
  from_value text NOT NULL DEFAULT '',
  to_value text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now(),
  by_id text NOT NULL DEFAULT '',
  by text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS agent_changes_agent_idx ON agent_changes(agent_id, at DESC);

-- One recorded decision: what the agent saw, what it concluded, why, how sure it was, the autonomy in force at the
-- time, what the runtime let it do about it, and what a human did afterwards. The register is append-only — a review
-- never rewrites a row, it writes a superseding one that points back at the original through supersedes_id.
CREATE TABLE IF NOT EXISTS decisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id text NOT NULL,
  agent_name text NOT NULL DEFAULT '',
  action text NOT NULL DEFAULT '',
  -- what the action would do to the world: nothing (ADVISORY), something undoable (REVERSIBLE), something not (IRREVERSIBLE)
  effect text NOT NULL DEFAULT 'ADVISORY',
  entity_type text NOT NULL DEFAULT '',
  entity_id text NOT NULL DEFAULT '',
  entity_label text NOT NULL DEFAULT '',
  inputs jsonb NOT NULL DEFAULT '{}'::jsonb,
  output jsonb NOT NULL DEFAULT '{}'::jsonb,
  explanation text NOT NULL DEFAULT '',
  -- the weighted factors that drove the conclusion, so a reviewer sees why and not only what
  factors jsonb NOT NULL DEFAULT '[]'::jsonb,
  confidence numeric(4,3) NOT NULL DEFAULT 0,
  autonomy_level text NOT NULL DEFAULT 'SUPERVISED',
  threshold numeric(4,3) NOT NULL DEFAULT 0,
  disposition text NOT NULL DEFAULT 'AWAITING_REVIEW',
  review_status text NOT NULL DEFAULT 'PENDING',
  escalation_code text NOT NULL DEFAULT '',
  escalation_reason text NOT NULL DEFAULT '',
  applied boolean NOT NULL DEFAULT false,
  reviewed_by_id text,
  reviewed_by text NOT NULL DEFAULT '',
  reviewed_at timestamptz,
  override_reason text NOT NULL DEFAULT '',
  supersedes_id uuid REFERENCES decisions(id) ON DELETE SET NULL,
  superseded boolean NOT NULL DEFAULT false,
  -- the profile the runtime was configured with, never a provider's own identifier
  model_key text NOT NULL DEFAULT '',
  model_version text NOT NULL DEFAULT '',
  latency_ms int NOT NULL DEFAULT 0,
  -- the dimensions the record actually carries, kept so outcomes can be compared across cohorts
  cohort jsonb NOT NULL DEFAULT '{}'::jsonb,
  at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS decisions_agent_idx ON decisions(agent_id, at DESC);
CREATE INDEX IF NOT EXISTS decisions_at_idx ON decisions(at DESC);
CREATE INDEX IF NOT EXISTS decisions_disposition_idx ON decisions(disposition);
CREATE INDEX IF NOT EXISTS decisions_review_idx ON decisions(review_status) WHERE review_status = 'PENDING';
CREATE INDEX IF NOT EXISTS decisions_entity_idx ON decisions(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS decisions_supersedes_idx ON decisions(supersedes_id);

-- How often an agent has acted in the last hour, so the autonomous limit is a fact and not an intention.
CREATE TABLE IF NOT EXISTS agent_actions (
  id bigserial PRIMARY KEY,
  agent_id text NOT NULL,
  decision_id uuid,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_actions_window_idx ON agent_actions(agent_id, at DESC);

/* Local snapshots of the facts the agents reason over. Each is projected from the owning service's read-model
 * events, so an agent scores a ship from the same record the register shows and never reaches across a database
 * boundary to do it. */
CREATE TABLE IF NOT EXISTS vessels (
  id text PRIMARY KEY, imo text NOT NULL DEFAULT '', name text NOT NULL DEFAULT '', type text NOT NULL DEFAULT '', flag text NOT NULL DEFAULT '',
  built int NOT NULL DEFAULT 0, grt int NOT NULL DEFAULT 0, class_society text NOT NULL DEFAULT '', status text NOT NULL DEFAULT 'ACTIVE',
  real boolean NOT NULL DEFAULT false, payload jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS vessel_certificates (
  id text PRIMARY KEY, vessel_id text NOT NULL DEFAULT '', cert_type text NOT NULL DEFAULT '', issue_date date, expiry_date date,
  state text NOT NULL DEFAULT 'VALID', payload jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vessel_certificates_vessel_idx ON vessel_certificates(vessel_id);
CREATE TABLE IF NOT EXISTS inspections (
  id text PRIMARY KEY, number text NOT NULL DEFAULT '', vessel_id text NOT NULL DEFAULT '', type text NOT NULL DEFAULT '', status text NOT NULL DEFAULT '',
  result text NOT NULL DEFAULT '', detention boolean NOT NULL DEFAULT false, planned_at timestamptz, started_at timestamptz, closed_at timestamptz,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb, payload jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inspections_vessel_idx ON inspections(vessel_id);
CREATE TABLE IF NOT EXISTS instruments (
  id text PRIMARY KEY, licence_no text NOT NULL DEFAULT '', entity_type text NOT NULL DEFAULT '', subject_kind text NOT NULL DEFAULT '',
  subject_id text NOT NULL DEFAULT '', subject_label text NOT NULL DEFAULT '', status text NOT NULL DEFAULT '', issue_date date, expiry_date date,
  in_force boolean NOT NULL DEFAULT true, payload jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS instruments_subject_idx ON instruments(subject_kind, subject_id);
CREATE TABLE IF NOT EXISTS incidents (
  id text PRIMARY KEY, number text NOT NULL DEFAULT '', title text NOT NULL DEFAULT '', type text NOT NULL DEFAULT '', severity text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '', vessel_id text, reported_at timestamptz, payload jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS invoices (
  id text PRIMARY KEY, number text NOT NULL DEFAULT '', party text NOT NULL DEFAULT '', vessel_id text, total bigint NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT '', issued_at timestamptz, due_at timestamptz, paid_at timestamptz, payload jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS port_calls (
  id text PRIMARY KEY, vcn text NOT NULL DEFAULT '', vessel_id text NOT NULL DEFAULT '', vessel_name text NOT NULL DEFAULT '', status text NOT NULL DEFAULT '',
  berth_code text NOT NULL DEFAULT '', eta timestamptz, atb timestamptz, atd timestamptz, payload jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS port_calls_vessel_idx ON port_calls(vessel_id);
CREATE TABLE IF NOT EXISTS service_requests (
  id text PRIMARY KEY, request_no text NOT NULL DEFAULT '', service_id text NOT NULL DEFAULT '', service_code text NOT NULL DEFAULT '',
  service_name text NOT NULL DEFAULT '', applicant text NOT NULL DEFAULT '', subject_kind text NOT NULL DEFAULT '', subject_id text,
  subject_label text NOT NULL DEFAULT '', status text NOT NULL DEFAULT '', current_stage text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, submitted_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_requests_status_idx ON service_requests(status);
CREATE TABLE IF NOT EXISTS service_definitions (
  id text PRIMARY KEY, code text NOT NULL DEFAULT '', name text NOT NULL DEFAULT '', payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS legal_instruments (
  id text PRIMARY KEY, ref_no text NOT NULL DEFAULT '', title text NOT NULL DEFAULT '', type text NOT NULL DEFAULT '', status text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
