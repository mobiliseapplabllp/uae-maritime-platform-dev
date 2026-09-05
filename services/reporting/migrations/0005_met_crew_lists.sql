-- Phase 3, Seafarers & MET: the MET register, the FAL-5 crew lists and the foreign seafarer ledger, projected
-- from the seafarers service's read-model events so the stat strips, the search palette and the reports read
-- them without asking the register.
CREATE TABLE IF NOT EXISTS rm_met_institutions (
  id uuid PRIMARY KEY, code text NOT NULL UNIQUE, name text NOT NULL, name_ar text, institution_type text NOT NULL, city text, status text NOT NULL DEFAULT 'ACTIVE',
  accreditation_status text NOT NULL DEFAULT 'NONE', accredited_until date, programmes int NOT NULL DEFAULT 0, approved_programmes int NOT NULL DEFAULT 0, seats_per_year int NOT NULL DEFAULT 0, instructors int NOT NULL DEFAULT 0,
  scope_company text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rm_met_name_trgm ON rm_met_institutions USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_met_name_ar_trgm ON rm_met_institutions USING gin (name_ar gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_met_code_trgm ON rm_met_institutions USING gin (code gin_trgm_ops);

CREATE TABLE IF NOT EXISTS rm_crew_lists (
  id uuid PRIMARY KEY, number text NOT NULL UNIQUE, vcn text, vessel_id text, vessel_name text NOT NULL DEFAULT '', movement text NOT NULL DEFAULT 'ARRIVAL', list_date timestamptz NOT NULL, source text NOT NULL,
  agent_code text, status text NOT NULL DEFAULT 'RECEIVED', ok boolean, row_count int NOT NULL DEFAULT 0, matched int NOT NULL DEFAULT 0, foreign_count int NOT NULL DEFAULT 0, flagged int NOT NULL DEFAULT 0, shortfalls int NOT NULL DEFAULT 0,
  scope_company text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rm_crew_lists_date_idx ON rm_crew_lists (list_date DESC);
CREATE INDEX IF NOT EXISTS rm_crew_lists_number_trgm ON rm_crew_lists USING gin (number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_crew_lists_vcn_trgm ON rm_crew_lists USING gin (vcn gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_crew_lists_vessel_trgm ON rm_crew_lists USING gin (vessel_name gin_trgm_ops);

-- The ledger is the administration's alone: no partition column, and the stat strip shows a company nothing of it.
CREATE TABLE IF NOT EXISTS rm_foreign_seafarers (
  id uuid PRIMARY KEY, name text NOT NULL, nationality text, id_number text NOT NULL, last_rank text, appearances int NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'LEDGER',
  endorsed boolean NOT NULL DEFAULT false, last_seen_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
