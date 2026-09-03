CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The seafarer register: identity, rank and where the seafarer stands right now.
-- `current_vessel_id` and `status` move together and only through sign-on and sign-off.
CREATE TABLE IF NOT EXISTS seafarers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cdc_no text NOT NULL UNIQUE,
  seafarer_id text NOT NULL DEFAULT '',
  seafarer_id_label text NOT NULL DEFAULT '',
  national_id text NOT NULL DEFAULT '',
  national_id_label text NOT NULL DEFAULT '',
  name text NOT NULL,
  dob date,
  nationality text NOT NULL DEFAULT '',
  rank text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ACTIVE',
  current_vessel_id text,
  current_vessel_name text,
  signed_on_at timestamptz,
  remarks text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS seafarers_name_idx ON seafarers(name);
CREATE INDEX IF NOT EXISTS seafarers_rank_idx ON seafarers(rank);
CREATE INDEX IF NOT EXISTS seafarers_status_idx ON seafarers(status);
CREATE INDEX IF NOT EXISTS seafarers_vessel_idx ON seafarers(current_vessel_id);

-- Competency, proficiency and medical documents. A row carrying an instrument_id was issued by the
-- instruments service and arrives as a read-model event: it is read-only here, and the endorsement this
-- administration recorded against a foreign certificate travels with it.
CREATE TABLE IF NOT EXISTS seafarer_certificates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seafarer_id uuid NOT NULL REFERENCES seafarers(id) ON DELETE CASCADE,
  cert_type text NOT NULL,
  grade text NOT NULL DEFAULT '',
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
  endorsement jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS seafarer_certificates_idx ON seafarer_certificates(seafarer_id, expiry_date);
CREATE INDEX IF NOT EXISTS seafarer_certificates_instrument_idx ON seafarer_certificates(instrument_id) WHERE instrument_id IS NOT NULL;

-- The service book: one row per tour. A verified record is one the desk has checked against the crew list
-- and the movement record; a sign-off writes its own, already verified.
CREATE TABLE IF NOT EXISTS sea_service (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  seafarer_id uuid NOT NULL REFERENCES seafarers(id) ON DELETE CASCADE,
  vessel_id text,
  vessel_name text NOT NULL DEFAULT '',
  imo text NOT NULL DEFAULT '',
  rank text NOT NULL DEFAULT '',
  from_at timestamptz NOT NULL,
  to_at timestamptz NOT NULL,
  verified boolean NOT NULL DEFAULT false,
  verified_by text NOT NULL DEFAULT '',
  verified_at timestamptz,
  remarks text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sea_service_idx ON sea_service(seafarer_id, from_at DESC);

-- Local snapshot of the fleet, projected from the ship register's read-model events: a sign-on names a ship
-- this service does not own, and the record shows her name rather than her id.
CREATE TABLE IF NOT EXISTS vessels (
  id text PRIMARY KEY,
  imo text NOT NULL DEFAULT '',
  name text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT 'GEN',
  flag text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ACTIVE',
  real boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vessels_name_idx ON vessels(name);
