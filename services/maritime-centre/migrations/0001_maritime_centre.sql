CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- One case file. The facts of the case live on this row; everything the desk adds while working it — the
-- communications thread, the response tasks, the documents, the operational log and the status trail — lives in
-- its own table, because each is append-only evidence that has to be addressable on its own.
CREATE TABLE IF NOT EXISTS incidents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  category text NOT NULL DEFAULT 'MARINE',
  type text NOT NULL,
  severity text NOT NULL DEFAULT 'MEDIUM',
  priority text NOT NULL DEFAULT 'P3',
  status text NOT NULL DEFAULT 'OPEN',
  title text NOT NULL,
  description text NOT NULL DEFAULT '',
  vessel_id uuid,
  vessel_name text NOT NULL DEFAULT '',
  berth_id text,
  berth_code text NOT NULL DEFAULT '',
  berth_terminal text NOT NULL DEFAULT '',
  location jsonb NOT NULL DEFAULT '{}'::jsonb,
  reported_at timestamptz NOT NULL DEFAULT now(),
  reported_by text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'PORTAL',
  assigned_to_id text,
  assigned_to text NOT NULL DEFAULT '',
  assets jsonb NOT NULL DEFAULT '[]'::jsonb,
  injuries int NOT NULL DEFAULT 0,
  pollution_tier int NOT NULL DEFAULT 0,
  weather jsonb NOT NULL DEFAULT '{}'::jsonb,
  rca jsonb NOT NULL DEFAULT '{}'::jsonb,
  acknowledged_at timestamptz,
  responding_at timestamptz,
  resolved_at timestamptz,
  closed_at timestamptz,
  outcome text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incidents_status_idx ON incidents(status);
CREATE INDEX IF NOT EXISTS incidents_reported_idx ON incidents(reported_at DESC);
CREATE INDEX IF NOT EXISTS incidents_vessel_idx ON incidents(vessel_id, reported_at DESC);
CREATE INDEX IF NOT EXISTS incidents_severity_idx ON incidents(severity);
CREATE INDEX IF NOT EXISTS incidents_category_idx ON incidents(category);
CREATE INDEX IF NOT EXISTS incidents_assignee_idx ON incidents(assigned_to_id);

CREATE TABLE IF NOT EXISTS incident_comms (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  by_id text,
  by_name text NOT NULL DEFAULT '',
  channel text NOT NULL DEFAULT 'PORTAL',
  direction text NOT NULL DEFAULT 'INTERNAL',
  message text NOT NULL
);
CREATE INDEX IF NOT EXISTS incident_comms_idx ON incident_comms(incident_id, at);

CREATE TABLE IF NOT EXISTS incident_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  title text NOT NULL,
  assignee_id text,
  assignee text NOT NULL DEFAULT '',
  due timestamptz,
  status text NOT NULL DEFAULT 'OPEN',
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incident_tasks_idx ON incident_tasks(incident_id, status);

CREATE TABLE IF NOT EXISTS incident_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  name text NOT NULL,
  doc_type text NOT NULL DEFAULT 'OTHER',
  size_kb int NOT NULL DEFAULT 0,
  uploaded_by_id text,
  uploaded_by text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now(),
  note text NOT NULL DEFAULT '',
  document_id text
);
CREATE INDEX IF NOT EXISTS incident_documents_idx ON incident_documents(incident_id, at);

CREATE TABLE IF NOT EXISTS incident_log (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  at timestamptz NOT NULL DEFAULT now(),
  by_id text,
  by_name text NOT NULL DEFAULT '',
  entry text NOT NULL
);
CREATE INDEX IF NOT EXISTS incident_log_idx ON incident_log(incident_id, at);

CREATE TABLE IF NOT EXISTS incident_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incident_id uuid NOT NULL REFERENCES incidents(id) ON DELETE CASCADE,
  from_status text NOT NULL DEFAULT '',
  to_status text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  by_id text,
  by_name text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS incident_status_history_idx ON incident_status_history(incident_id, at);

-- The last fix the platform holds for each tracked vessel, and the track behind it. The current fix is one row
-- per vessel so the picture is a single scan; the history is append-only and pruned by age, because the watch
-- needs the last day of a track, not the last year of one.
CREATE TABLE IF NOT EXISTS positions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id text NOT NULL UNIQUE,
  vessel_name text NOT NULL DEFAULT '',
  mmsi text NOT NULL DEFAULT '',
  lat numeric(9,5) NOT NULL DEFAULT 0,
  lon numeric(9,5) NOT NULL DEFAULT 0,
  sog numeric(5,1) NOT NULL DEFAULT 0,
  cog int NOT NULL DEFAULT 0,
  heading int NOT NULL DEFAULT 0,
  nav_status text NOT NULL DEFAULT 'UNDERWAY',
  destination text NOT NULL DEFAULT '',
  source text NOT NULL DEFAULT 'AIS-T (simulated)',
  received_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS position_history (
  id bigserial PRIMARY KEY,
  vessel_id text NOT NULL,
  lat numeric(9,5) NOT NULL,
  lon numeric(9,5) NOT NULL,
  sog numeric(5,1) NOT NULL DEFAULT 0,
  cog int NOT NULL DEFAULT 0,
  nav_status text NOT NULL DEFAULT 'UNDERWAY',
  received_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS position_history_fix_idx ON position_history(vessel_id, received_at);
CREATE INDEX IF NOT EXISTS position_history_vessel_idx ON position_history(vessel_id, received_at DESC);

-- Maritime domain awareness alerts: derived signals the watch acknowledges. Advisory only — nothing here
-- enforces anything by itself, which is why an alert carries an acknowledgement rather than an action.
CREATE TABLE IF NOT EXISTS mda_alerts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type text NOT NULL,
  severity text NOT NULL DEFAULT 'warning',
  vessel_id text,
  vessel_name text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now(),
  acknowledged boolean NOT NULL DEFAULT false,
  acknowledged_by_id text,
  acknowledged_by text NOT NULL DEFAULT '',
  acknowledged_at timestamptz,
  incident_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS mda_alerts_open_idx ON mda_alerts(at DESC) WHERE NOT acknowledged;
CREATE INDEX IF NOT EXISTS mda_alerts_vessel_idx ON mda_alerts(vessel_id, at DESC);

-- A proposed restriction on an area of water — a closure, a speed limit, a no-anchoring zone. The centre
-- proposes; the harbour master decides. The proposal carries the polygon it applies to so the traffic picture
-- can draw it while it is still only proposed.
CREATE TABLE IF NOT EXISTS restrictions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  kind text NOT NULL DEFAULT 'AREA_CLOSURE',
  label text NOT NULL,
  reason text NOT NULL DEFAULT '',
  area jsonb NOT NULL DEFAULT '[]'::jsonb,
  effective_from timestamptz,
  effective_to timestamptz,
  status text NOT NULL DEFAULT 'PROPOSED',
  incident_id uuid,
  proposed_by_id text,
  proposed_by text NOT NULL DEFAULT '',
  decided_by_id text,
  decided_by text NOT NULL DEFAULT '',
  decided_at timestamptz,
  decision_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS restrictions_status_idx ON restrictions(status, effective_from DESC);

-- Local snapshots of what other domains own: the fleet the picture tracks and cases are raised against, and the
-- berth estate a case is located at, both projected from their read-model events.
CREATE TABLE IF NOT EXISTS vessels (
  id text PRIMARY KEY,
  imo text NOT NULL DEFAULT '',
  mmsi text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT 'GEN',
  flag text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ACTIVE',
  real boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vessels_name_idx ON vessels(name);

CREATE TABLE IF NOT EXISTS berths (
  id text PRIMARY KEY,
  code text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  terminal text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'OPERATIONAL',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS berths_code_idx ON berths(code);
