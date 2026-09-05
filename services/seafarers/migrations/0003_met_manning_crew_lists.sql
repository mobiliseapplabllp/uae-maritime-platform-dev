-- Phase 3, Seafarers & MET.
--
-- Vocabulary. The register stored a rank and a certificate type as the words on the form. The words stay —
-- they are what the record prints — and the master's code now travels beside them, so a rank renamed in
-- Data Studio does not orphan a row and a check can compare codes rather than spellings.
ALTER TABLE seafarers ADD COLUMN IF NOT EXISTS rank_code text NOT NULL DEFAULT '';
ALTER TABLE sea_service ADD COLUMN IF NOT EXISTS rank_code text NOT NULL DEFAULT '';
ALTER TABLE seafarer_certificates ADD COLUMN IF NOT EXISTS cert_code text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS seafarers_rank_code_idx ON seafarers(rank_code);
CREATE INDEX IF NOT EXISTS seafarer_certificates_code_idx ON seafarer_certificates(cert_code);

-- The MET register: maritime education and training providers accredited under STCW regulation I/8.
-- An institution is a company on the directory; the accreditation is an instrument and its cycle runs in
-- the facilities service. This table is the register's own overlay — type, capacity, simulators, the
-- quality system — and a mirror of where the accreditation stands, written from facilities' events.
CREATE TABLE IF NOT EXISTS met_institutions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  name_ar text NOT NULL DEFAULT '',
  institution_type text NOT NULL,
  city text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  contact_name text NOT NULL DEFAULT '',
  contact_email text NOT NULL DEFAULT '',
  contact_phone text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ACTIVE',
  status_reason text NOT NULL DEFAULT '',
  accreditation_status text NOT NULL DEFAULT 'NONE',
  accreditation_reason text NOT NULL DEFAULT '',
  accreditation_instrument_id text,
  accreditation_instrument_no text NOT NULL DEFAULT '',
  accreditation_cycle_id text,
  accreditation_cycle_no int NOT NULL DEFAULT 0,
  accredited_from timestamptz,
  accredited_until timestamptz,
  instructors int NOT NULL DEFAULT 0,
  capacity int NOT NULL DEFAULT 0,
  simulators jsonb NOT NULL DEFAULT '[]'::jsonb,
  quality_system text NOT NULL DEFAULT '',
  established_on date,
  remarks text NOT NULL DEFAULT '',
  scope_company text NOT NULL DEFAULT '',
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS met_institutions_code_idx ON met_institutions(upper(code));
CREATE INDEX IF NOT EXISTS met_institutions_company_idx ON met_institutions(company_id);
CREATE INDEX IF NOT EXISTS met_institutions_accr_idx ON met_institutions(accreditation_status);

-- The programmes an institution is approved to deliver, each a code of the metProgramme master.
CREATE TABLE IF NOT EXISTS met_programmes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  institution_id uuid NOT NULL REFERENCES met_institutions(id) ON DELETE CASCADE,
  programme text NOT NULL,
  title text NOT NULL DEFAULT '',
  regulation text NOT NULL DEFAULT '',
  seats_per_intake int NOT NULL DEFAULT 0,
  intakes_per_year int NOT NULL DEFAULT 1,
  status text NOT NULL DEFAULT 'PENDING',
  status_reason text NOT NULL DEFAULT '',
  approval_no text NOT NULL DEFAULT '',
  instrument_id text,
  approved_on timestamptz,
  expires_on timestamptz,
  remarks text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS met_programmes_unique_idx ON met_programmes(institution_id, programme);

-- The safe manning scale: what the minimum safe manning document (SOLAS V/14) says a ship must carry,
-- rank by rank, as a structured reading a crew list can be checked against. One scale per ship.
CREATE TABLE IF NOT EXISTS manning_scales (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id text NOT NULL UNIQUE,
  vessel_name text NOT NULL DEFAULT '',
  imo text NOT NULL DEFAULT '',
  msmd_no text NOT NULL DEFAULT '',
  instrument_id text,
  issued_on timestamptz,
  expires_on timestamptz,
  trading_area text NOT NULL DEFAULT '',
  rows jsonb NOT NULL DEFAULT '[]'::jsonb,
  remarks text NOT NULL DEFAULT '',
  recorded_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A light mirror of the port calls a crew list is lodged against, projected from the ports service's
-- read-model events: the reference, the ship, who lodged the call and the crew count the general
-- declaration gave, so the FAL-5 can be read against the FAL-1 without asking the ports service.
CREATE TABLE IF NOT EXISTS port_calls (
  id text PRIMARY KEY,
  vcn text NOT NULL,
  vessel_id text NOT NULL DEFAULT '',
  vessel_name text NOT NULL DEFAULT '',
  vessel_imo text NOT NULL DEFAULT '',
  agent_code text NOT NULL DEFAULT '',
  agent_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '',
  port text NOT NULL DEFAULT '',
  berth_code text,
  eta timestamptz,
  ata timestamptz,
  atd timestamptz,
  declared_crew int,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS port_calls_vcn_idx ON port_calls(vcn);
CREATE INDEX IF NOT EXISTS port_calls_vessel_idx ON port_calls(vessel_id, eta DESC);

-- The FAL form 5 crew list as received, one row per person, and what the desk found when it read it.
-- A list belongs to the agent who lodged the call it is attached to, which is what a company-scoped
-- reader is partitioned on; the administration reads them all.
CREATE TABLE IF NOT EXISTS crew_lists (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  vcn text NOT NULL DEFAULT '',
  port_call_id text,
  vessel_id text NOT NULL DEFAULT '',
  vessel_name text NOT NULL DEFAULT '',
  imo text NOT NULL DEFAULT '',
  port text NOT NULL DEFAULT '',
  movement text NOT NULL DEFAULT 'ARRIVAL',
  list_date timestamptz NOT NULL DEFAULT now(),
  source text NOT NULL,
  agent_code text NOT NULL DEFAULT '',
  agent_name text NOT NULL DEFAULT '',
  submitted_by text NOT NULL DEFAULT '',
  declared_crew int,
  row_count int NOT NULL DEFAULT 0,
  matched int NOT NULL DEFAULT 0,
  foreign_count int NOT NULL DEFAULT 0,
  flagged int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'RECEIVED',
  checks jsonb NOT NULL DEFAULT '{}'::jsonb,
  checked_at timestamptz,
  checked_by text NOT NULL DEFAULT '',
  decided_at timestamptz,
  decided_by text NOT NULL DEFAULT '',
  decision_note text NOT NULL DEFAULT '',
  remarks text NOT NULL DEFAULT '',
  scope_company text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crew_lists_vessel_idx ON crew_lists(vessel_id, list_date DESC);
CREATE INDEX IF NOT EXISTS crew_lists_vcn_idx ON crew_lists(vcn);
CREATE INDEX IF NOT EXISTS crew_lists_status_idx ON crew_lists(status);
CREATE INDEX IF NOT EXISTS crew_lists_scope_idx ON crew_lists(scope_company);

CREATE TABLE IF NOT EXISTS crew_list_rows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crew_list_id uuid NOT NULL REFERENCES crew_lists(id) ON DELETE CASCADE,
  seq int NOT NULL,
  family_name text NOT NULL DEFAULT '',
  given_names text NOT NULL DEFAULT '',
  rank text NOT NULL DEFAULT '',
  rank_code text NOT NULL DEFAULT '',
  nationality text NOT NULL DEFAULT '',
  dob date,
  pob text NOT NULL DEFAULT '',
  gender text NOT NULL DEFAULT '',
  id_type text NOT NULL DEFAULT '',
  id_number text NOT NULL DEFAULT '',
  id_expiry date,
  cdc_no text NOT NULL DEFAULT '',
  match text NOT NULL DEFAULT 'NEW',
  seafarer_id uuid,
  foreign_id uuid,
  issues jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crew_list_rows_list_idx ON crew_list_rows(crew_list_id, seq);
CREATE INDEX IF NOT EXISTS crew_list_rows_seafarer_idx ON crew_list_rows(seafarer_id) WHERE seafarer_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS crew_list_rows_foreign_idx ON crew_list_rows(foreign_id) WHERE foreign_id IS NOT NULL;

-- The foreign seafarer ledger: every person a crew list named who is not on the national register, keyed
-- on the identity document they travelled on, with each appearance counted. A ledger entry becomes a
-- register entry only by the desk reconciling it — the ledger never creates a seafarer on its own.
CREATE TABLE IF NOT EXISTS foreign_seafarers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  id_type text NOT NULL DEFAULT '',
  id_number text NOT NULL,
  family_name text NOT NULL DEFAULT '',
  given_names text NOT NULL DEFAULT '',
  nationality text NOT NULL DEFAULT '',
  dob date,
  id_expiry date,
  cdc_no text NOT NULL DEFAULT '',
  last_rank text NOT NULL DEFAULT '',
  last_rank_code text NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  appearances int NOT NULL DEFAULT 0,
  vessels jsonb NOT NULL DEFAULT '[]'::jsonb,
  status text NOT NULL DEFAULT 'LEDGER',
  status_reason text NOT NULL DEFAULT '',
  reconciled_seafarer_id uuid,
  reconciled_at timestamptz,
  reconciled_by text NOT NULL DEFAULT '',
  -- the flag's endorsement of a foreign officer's certificate (STCW I/10), recorded here because the person is on no register of ours
  endorsement_no text NOT NULL DEFAULT '',
  endorsement_issuer text NOT NULL DEFAULT '',
  endorsement_expiry date,
  remarks text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS foreign_seafarers_key_idx ON foreign_seafarers(upper(id_number), upper(nationality));
CREATE INDEX IF NOT EXISTS foreign_seafarers_name_idx ON foreign_seafarers(family_name, given_names);
CREATE INDEX IF NOT EXISTS foreign_seafarers_status_idx ON foreign_seafarers(status);
