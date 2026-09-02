-- Read models for reporting. Every table is a denormalised projection kept current by domain events
-- (see consumer.ts) and seeded from the shared world; the domain services stay the systems of record.
CREATE TABLE IF NOT EXISTS rm_users (
  id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL, role_name text, designation text, department text, phone text,
  active boolean NOT NULL DEFAULT true, last_login_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rm_berths (
  id uuid PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL, terminal text NOT NULL, berth_type text NOT NULL,
  loa_max numeric, draft_max numeric, status text NOT NULL DEFAULT 'OPERATIONAL', outages jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rm_vessels (
  id uuid PRIMARY KEY, imo text NOT NULL UNIQUE, name text NOT NULL, mmsi text, call_sign text, flag text, type text NOT NULL, built int, dwt numeric, grt numeric, loa numeric, beam numeric, max_draft numeric,
  owner text, operator text, manager text, agent_code text, agent_name text, class_society text, teu_capacity int, liner boolean NOT NULL DEFAULT false, real boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE', next_dry_dock date, registry_state text NOT NULL DEFAULT 'UNREGISTERED', registry jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rm_vessels_name_idx ON rm_vessels (lower(name));
CREATE TABLE IF NOT EXISTS rm_vessel_certificates (
  id uuid PRIMARY KEY, vessel_id uuid NOT NULL REFERENCES rm_vessels(id) ON DELETE CASCADE, cert_type text NOT NULL, number text, issuer text, issue_date date, expiry_date date NOT NULL,
  on_register boolean NOT NULL DEFAULT false, in_force boolean NOT NULL DEFAULT true, force_reason text, signed boolean NOT NULL DEFAULT false, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rm_vessel_certificates_vessel_idx ON rm_vessel_certificates (vessel_id);
CREATE TABLE IF NOT EXISTS rm_port_calls (
  id uuid PRIMARY KEY, vcn text NOT NULL UNIQUE, vessel_id uuid NOT NULL, vessel_name text NOT NULL, vessel_type text, agent_code text, agent_name text, status text NOT NULL,
  eta timestamptz NOT NULL, etb timestamptz, etd timestamptz, ata timestamptz, atb timestamptz, atd timestamptz, berth_id uuid, berth_code text, prev_port text, next_port text,
  cargo_ops jsonb NOT NULL DEFAULT '[]', cargo_mt numeric NOT NULL DEFAULT 0, teu int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rm_port_calls_status_idx ON rm_port_calls (status);
CREATE INDEX IF NOT EXISTS rm_port_calls_atd_idx ON rm_port_calls (atd);
CREATE INDEX IF NOT EXISTS rm_port_calls_eta_idx ON rm_port_calls (eta);
CREATE TABLE IF NOT EXISTS rm_invoices (
  id uuid PRIMARY KEY, number text NOT NULL UNIQUE, port_call_id uuid, vessel_id uuid, vessel_name text, bill_to_name text, subtotal numeric NOT NULL DEFAULT 0, tax_amount numeric NOT NULL DEFAULT 0, total numeric NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'AED', status text NOT NULL, issued_at timestamptz, paid_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rm_invoices_status_idx ON rm_invoices (status);
CREATE TABLE IF NOT EXISTS rm_inspections (
  id uuid PRIMARY KEY, number text NOT NULL UNIQUE, vessel_id uuid, vessel_name text, type text NOT NULL, inspector text, status text NOT NULL, result text, detention boolean NOT NULL DEFAULT false,
  planned_at timestamptz, started_at timestamptz, closed_at timestamptz, open_findings int NOT NULL DEFAULT 0, total_findings int NOT NULL DEFAULT 0, score_pct numeric, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rm_incidents (
  id uuid PRIMARY KEY, number text NOT NULL UNIQUE, title text NOT NULL, category text, type text NOT NULL, severity text NOT NULL, priority text, status text NOT NULL,
  vessel_id uuid, vessel_name text, assigned_to_name text, reported_at timestamptz NOT NULL, acknowledged_at timestamptz, resolved_at timestamptz, closed_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rm_seafarers (
  id uuid PRIMARY KEY, name text NOT NULL, rank text NOT NULL, cdc_no text NOT NULL, seafarer_id_no text, nationality text, phone text, status text NOT NULL,
  current_vessel_id uuid, current_vessel_name text, cert_alerts int NOT NULL DEFAULT 0, sea_service_days int NOT NULL DEFAULT 0, service_records int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rm_seafarers_name_idx ON rm_seafarers (lower(name));
CREATE TABLE IF NOT EXISTS rm_companies (
  id uuid PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL, category text, status text NOT NULL, address text, tax_id text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rm_instruments (
  id uuid PRIMARY KEY, number text NOT NULL UNIQUE, subject_kind text NOT NULL, subject_id uuid, entity_name text NOT NULL, entity_type text NOT NULL, instrument_class text NOT NULL, status text NOT NULL,
  applied_date date, issue_date date, expiry_date date, statutory boolean NOT NULL DEFAULT false, in_force boolean NOT NULL DEFAULT true, signed boolean NOT NULL DEFAULT false, performance_rating numeric, audits int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rm_legal_instruments (
  id uuid PRIMARY KEY, ref_no text NOT NULL UNIQUE, title text NOT NULL, type text NOT NULL, status text NOT NULL, issued_date date, ack_required boolean NOT NULL DEFAULT false, acknowledged_by jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rm_registrations (
  id uuid PRIMARY KEY, number text NOT NULL UNIQUE, vessel_id uuid, vessel_name text, kind text NOT NULL, status text NOT NULL, submitted_at timestamptz, closed_at timestamptz, due_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rm_tariffs (
  id uuid PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL, category text NOT NULL, unit text NOT NULL, rate numeric NOT NULL, active boolean NOT NULL DEFAULT true, revisions jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rm_resources (
  id uuid PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL, type text NOT NULL, status text NOT NULL, jobs jsonb NOT NULL DEFAULT '[]', outages jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rm_checklists (
  id uuid PRIMARY KEY, name text NOT NULL, inspection_type text NOT NULL, items int NOT NULL DEFAULT 0, active boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS rm_lookup_counts (category text PRIMARY KEY, entries int NOT NULL DEFAULT 0, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS rm_audit_activity (
  id uuid PRIMARY KEY, at timestamptz NOT NULL, actor_id text, actor_name text, action text NOT NULL, entity text NOT NULL, entity_label text, service text
);
CREATE INDEX IF NOT EXISTS rm_audit_activity_at_idx ON rm_audit_activity (at DESC);
CREATE TABLE IF NOT EXISTS rm_agent_decisions (
  id uuid PRIMARY KEY, agent_id text NOT NULL, disposition text NOT NULL, confidence numeric, review_status text NOT NULL, at timestamptz NOT NULL, entity_type text, entity_id uuid, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS report_definitions (
  key text PRIMARY KEY, name text NOT NULL, name_ar text, category text NOT NULL, description text NOT NULL DEFAULT '', perm text NOT NULL, params jsonb NOT NULL DEFAULT '[]', columns jsonb NOT NULL DEFAULT '[]', query_key text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
