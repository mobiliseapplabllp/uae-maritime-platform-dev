CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The fleet record. A ship's standing on the national register lives here too, but is only ever written
-- by a granted registration — nothing else in the service is allowed to touch the registry_* columns.
CREATE TABLE IF NOT EXISTS vessels (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  imo text NOT NULL UNIQUE,
  mmsi text NOT NULL DEFAULT '',
  call_sign text NOT NULL DEFAULT '',
  flag text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT 'GEN',
  built int,
  dwt int,
  grt int NOT NULL DEFAULT 0,
  loa numeric(7,1),
  beam numeric(6,1),
  max_draft numeric(5,1),
  owner text NOT NULL DEFAULT '',
  operator text NOT NULL DEFAULT '',
  manager text NOT NULL DEFAULT '',
  agent_code text NOT NULL DEFAULT '',
  class_society text NOT NULL DEFAULT '',
  pi_club text NOT NULL DEFAULT '',
  port_of_registry text NOT NULL DEFAULT '',
  yard text NOT NULL DEFAULT '',
  engine jsonb NOT NULL DEFAULT '{}'::jsonb,
  service_speed_kn numeric(4,1),
  teu_capacity int,
  last_dry_dock timestamptz,
  next_dry_dock timestamptz,
  liner boolean NOT NULL DEFAULT false,
  real boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE',
  remarks text NOT NULL DEFAULT '',
  registry_state text NOT NULL DEFAULT 'UNREGISTERED',
  official_number text NOT NULL DEFAULT '',
  registry_port text NOT NULL DEFAULT '',
  certificate_no text NOT NULL DEFAULT '',
  registered_on timestamptz,
  certificate_expires_on timestamptz,
  closed_on timestamptz,
  closure_reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vessels_name_idx ON vessels(name);
CREATE INDEX IF NOT EXISTS vessels_status_idx ON vessels(status);
CREATE INDEX IF NOT EXISTS vessels_registry_state_idx ON vessels(registry_state);
CREATE INDEX IF NOT EXISTS vessels_official_number_idx ON vessels(official_number) WHERE official_number <> '';

-- The certificate list a ship carries. Rows whose instrument_id is set were issued by the instruments
-- service and arrive as read-model events: they are read-only here, so a local edit can never quietly
-- overwrite what is on the instrument register.
CREATE TABLE IF NOT EXISTS vessel_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id uuid NOT NULL REFERENCES vessels(id) ON DELETE CASCADE,
  cert_type text NOT NULL,
  number text NOT NULL DEFAULT '',
  issuer text NOT NULL DEFAULT '',
  issue_date timestamptz,
  expiry_date timestamptz NOT NULL,
  remarks text NOT NULL DEFAULT '',
  instrument_id text,
  on_register boolean NOT NULL DEFAULT false,
  in_force boolean,
  force_reason text NOT NULL DEFAULT '',
  signed boolean NOT NULL DEFAULT false,
  endorsements_overdue int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vessel_certificates_vessel_idx ON vessel_certificates(vessel_id, expiry_date);
CREATE INDEX IF NOT EXISTS vessel_certificates_instrument_idx ON vessel_certificates(instrument_id) WHERE instrument_id IS NOT NULL;

-- One file with the registrar: a first registration, a provisional certificate, an alteration of the
-- entry, or its closure. Evidence, charges, checks and the file history travel with the file.
CREATE TABLE IF NOT EXISTS registrations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  application_no text NOT NULL UNIQUE,
  kind text NOT NULL,
  vessel_id uuid REFERENCES vessels(id) ON DELETE SET NULL,
  vessel_name text NOT NULL DEFAULT '',
  imo text NOT NULL DEFAULT '',
  port_of_registry text NOT NULL DEFAULT '',
  applicant jsonb NOT NULL DEFAULT '{}'::jsonb,
  owners jsonb NOT NULL DEFAULT '[]'::jsonb,
  tonnage jsonb NOT NULL DEFAULT '{}'::jsonb,
  previous_flag text NOT NULL DEFAULT '',
  previous_registry text NOT NULL DEFAULT '',
  previous_official_number text NOT NULL DEFAULT '',
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  encumbrances jsonb NOT NULL DEFAULT '[]'::jsonb,
  carving_note jsonb,
  amendment jsonb,
  deletion jsonb,
  status text NOT NULL DEFAULT 'DRAFT',
  checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  assigned_to_id text,
  assigned_to text NOT NULL DEFAULT '',
  official_number text NOT NULL DEFAULT '',
  certificate_no text NOT NULL DEFAULT '',
  granted_on timestamptz,
  granted_by text NOT NULL DEFAULT '',
  certificate_expires_on timestamptz,
  fee jsonb NOT NULL DEFAULT '{}'::jsonb,
  decision jsonb,
  submitted_at timestamptz,
  due_at timestamptz,
  closed_at timestamptz,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS registrations_vessel_idx ON registrations(vessel_id, created_at DESC);
CREATE INDEX IF NOT EXISTS registrations_status_idx ON registrations(status);
CREATE INDEX IF NOT EXISTS registrations_kind_idx ON registrations(kind);

-- Policy the registrar and the risk model run on: the model weights are settings, and every change to
-- them is audited, so they are stored rather than hard-coded.
CREATE TABLE IF NOT EXISTS ships_settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Local snapshots of what other domains own, projected from their read-model events: the calls this ship
-- has made, the inspections and incidents raised against her, the crew on board, her last AIS fix, the
-- agent directory and the money outstanding against her.
CREATE TABLE IF NOT EXISTS port_calls (
  id text PRIMARY KEY,
  vcn text NOT NULL DEFAULT '',
  vessel_id text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ANNOUNCED',
  eta timestamptz,
  etb timestamptz,
  etd timestamptz,
  ata timestamptz,
  atb timestamptz,
  atd timestamptz,
  berth_id text,
  berth_code text,
  berth_name text,
  terminal text,
  prev_port text,
  next_port text,
  purpose text,
  cargo_ops jsonb NOT NULL DEFAULT '[]'::jsonb,
  status_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS port_calls_vessel_idx ON port_calls(vessel_id, eta DESC);

CREATE TABLE IF NOT EXISTS inspections (
  id text PRIMARY KEY,
  number text NOT NULL DEFAULT '',
  vessel_id text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT 'PSC',
  status text NOT NULL DEFAULT 'PLANNED',
  result text,
  detention boolean NOT NULL DEFAULT false,
  open_findings int NOT NULL DEFAULT 0,
  total_findings int NOT NULL DEFAULT 0,
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  planned_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inspections_vessel_idx ON inspections(vessel_id, planned_at DESC);

CREATE TABLE IF NOT EXISTS incidents (
  id text PRIMARY KEY,
  number text NOT NULL DEFAULT '',
  vessel_id text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT '',
  severity text NOT NULL DEFAULT 'LOW',
  status text NOT NULL DEFAULT 'OPEN',
  reported_at timestamptz,
  closed_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS incidents_vessel_idx ON incidents(vessel_id, reported_at DESC);

CREATE TABLE IF NOT EXISTS crew (
  id text PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  rank text NOT NULL DEFAULT '',
  cdc_no text NOT NULL DEFAULT '',
  nationality text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ACTIVE',
  current_vessel_id text,
  cert_alerts int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crew_vessel_idx ON crew(current_vessel_id);

CREATE TABLE IF NOT EXISTS positions (
  vessel_id text PRIMARY KEY,
  lat numeric(9,5) NOT NULL DEFAULT 0,
  lon numeric(9,5) NOT NULL DEFAULT 0,
  speed numeric(5,1) NOT NULL DEFAULT 0,
  course int NOT NULL DEFAULT 0,
  nav_status text NOT NULL DEFAULT 'UNDER_WAY',
  received_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS companies (
  id text PRIMARY KEY,
  code text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  category text,
  status text NOT NULL DEFAULT 'ACTIVE',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS companies_code_idx ON companies(code);

CREATE TABLE IF NOT EXISTS invoices (
  id text PRIMARY KEY,
  number text NOT NULL DEFAULT '',
  vessel_id text,
  port_call_id text,
  status text NOT NULL DEFAULT 'DRAFT',
  total numeric(14,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'AED',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoices_vessel_idx ON invoices(vessel_id, status);
