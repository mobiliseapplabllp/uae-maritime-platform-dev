CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- The berth estate: every quay the harbour master can allocate, with its physical limits.
CREATE TABLE IF NOT EXISTS berths (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  terminal text NOT NULL,
  berth_type text NOT NULL DEFAULT 'MULTIPURPOSE',
  loa_max numeric(7,1) NOT NULL DEFAULT 0,
  draft_max numeric(5,1) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'OPERATIONAL',
  remarks text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Windows a berth was, or will be, out of service: planned works, breakdowns, dredging, weather stand-downs.
CREATE TABLE IF NOT EXISTS berth_outages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  berth_id uuid NOT NULL REFERENCES berths(id) ON DELETE CASCADE,
  from_at timestamptz NOT NULL,
  to_at timestamptz NOT NULL,
  days numeric(6,1) NOT NULL DEFAULT 0,
  kind text NOT NULL DEFAULT 'PLANNED',
  reason text NOT NULL DEFAULT '',
  recorded_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS berth_outages_berth_idx ON berth_outages(berth_id, from_at);
-- Local projections of the facts other domains own, fed by their read-model events: the ship register, the company directory, the rate card and the invoices raised on calls.
CREATE TABLE IF NOT EXISTS vessels (
  id text PRIMARY KEY,
  imo text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT 'GEN',
  flag text NOT NULL DEFAULT '',
  grt int,
  dwt int,
  loa numeric(7,1),
  max_draft numeric(5,1),
  agent_code text,
  status text NOT NULL DEFAULT 'ACTIVE',
  real boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vessels_name_idx ON vessels(lower(name));
CREATE INDEX IF NOT EXISTS vessels_imo_idx ON vessels(imo);
CREATE TABLE IF NOT EXISTS companies (
  id text PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL DEFAULT '',
  category text,
  status text NOT NULL DEFAULT 'ACTIVE',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS companies_code_idx ON companies(code);
CREATE TABLE IF NOT EXISTS tariffs (
  id text PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL DEFAULT '',
  category text,
  unit text NOT NULL DEFAULT '',
  rate numeric(14,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'AED',
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS tariffs_code_idx ON tariffs(code);
CREATE TABLE IF NOT EXISTS invoices (
  id text PRIMARY KEY,
  number text NOT NULL DEFAULT '',
  port_call_id text,
  status text NOT NULL DEFAULT 'DRAFT',
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  tax_amount numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'AED',
  issued_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoices_call_idx ON invoices(port_call_id);
-- The vessel-call register: one row per call from announcement to sailing. Services, cargo operations, statement-of-facts entries, the status trail and the PDA snapshot travel with the call.
CREATE TABLE IF NOT EXISTS port_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vcn text NOT NULL UNIQUE,
  vessel_id text NOT NULL,
  vessel_name text NOT NULL DEFAULT '',
  vessel_imo text NOT NULL DEFAULT '',
  vessel_type text,
  vessel_flag text,
  agent_code text NOT NULL DEFAULT '',
  agent_name text NOT NULL DEFAULT '',
  purpose text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ANNOUNCED',
  eta timestamptz NOT NULL,
  etb timestamptz,
  etd timestamptz,
  ata timestamptz,
  atb timestamptz,
  atd timestamptz,
  berth_id uuid REFERENCES berths(id) ON DELETE SET NULL,
  berth_code text,
  prev_port text NOT NULL DEFAULT '',
  next_port text NOT NULL DEFAULT '',
  draft_arrival numeric(5,1),
  draft_departure numeric(5,1),
  crew jsonb NOT NULL DEFAULT '{"count":0,"master":""}'::jsonb,
  remarks text NOT NULL DEFAULT '',
  detention boolean NOT NULL DEFAULT false,
  services jsonb NOT NULL DEFAULT '[]'::jsonb,
  cargo_ops jsonb NOT NULL DEFAULT '[]'::jsonb,
  sof_entries jsonb NOT NULL DEFAULT '[]'::jsonb,
  status_history jsonb NOT NULL DEFAULT '[]'::jsonb,
  pda jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS port_calls_status_idx ON port_calls(status);
CREATE INDEX IF NOT EXISTS port_calls_vessel_idx ON port_calls(vessel_id);
CREATE INDEX IF NOT EXISTS port_calls_berth_idx ON port_calls(berth_id, status);
CREATE INDEX IF NOT EXISTS port_calls_eta_idx ON port_calls(eta);
CREATE INDEX IF NOT EXISTS port_calls_atd_idx ON port_calls(atd);
-- Marine craft and pilots: each carries its own service record (jobs) and out-of-service windows.
CREATE TABLE IF NOT EXISTS resources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  type text NOT NULL DEFAULT 'TUG',
  spec text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'AVAILABLE',
  current_task text NOT NULL DEFAULT '',
  master text NOT NULL DEFAULT '',
  user_id text,
  contact text NOT NULL DEFAULT '',
  remarks text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS resource_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  at timestamptz NOT NULL,
  ended_at timestamptz,
  kind text NOT NULL DEFAULT '',
  vcn text NOT NULL DEFAULT '',
  port_call_id text,
  vessel_name text NOT NULL DEFAULT '',
  berth text NOT NULL DEFAULT '',
  hours numeric(6,1) NOT NULL DEFAULT 0,
  remarks text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resource_jobs_resource_idx ON resource_jobs(resource_id, at DESC);
CREATE TABLE IF NOT EXISTS resource_outages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  resource_id uuid NOT NULL REFERENCES resources(id) ON DELETE CASCADE,
  from_at timestamptz NOT NULL,
  to_at timestamptz NOT NULL,
  days numeric(6,1) NOT NULL DEFAULT 0,
  reason text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS resource_outages_resource_idx ON resource_outages(resource_id, from_at);
