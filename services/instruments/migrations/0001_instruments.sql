CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- The polymorphic instrument register: one row per licence, permit, certificate, accreditation, endorsement or NOC, whatever it is issued against.
CREATE TABLE IF NOT EXISTS licences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  license_no text NOT NULL UNIQUE,
  subject_kind text NOT NULL DEFAULT 'COMPANY',
  subject_id text,
  subject_model text,
  instrument_class text NOT NULL DEFAULT 'LICENCE',
  entity_name text NOT NULL,
  entity_type text NOT NULL,
  status text NOT NULL DEFAULT 'APPLIED',
  issue_checks jsonb NOT NULL DEFAULT '[]'::jsonb,
  contact_person text NOT NULL DEFAULT '',
  phone text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  tax_id text NOT NULL DEFAULT '',
  applied_date timestamptz NOT NULL DEFAULT now(),
  issue_date timestamptz,
  expiry_date timestamptz,
  conditions text NOT NULL DEFAULT '',
  performance_rating numeric(3,1) NOT NULL DEFAULT 0,
  audits jsonb NOT NULL DEFAULT '[]'::jsonb,
  endorsements jsonb NOT NULL DEFAULT '[]'::jsonb,
  signature jsonb,
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  issuer text NOT NULL DEFAULT '',
  request_id text,
  request_no text,
  reminded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS licences_subject_idx ON licences(subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS licences_status_idx ON licences(status);
CREATE INDEX IF NOT EXISTS licences_type_idx ON licences(entity_type);
CREATE INDEX IF NOT EXISTS licences_expiry_idx ON licences(expiry_date) WHERE status = 'ISSUED';
CREATE UNIQUE INDEX IF NOT EXISTS licences_request_idx ON licences(request_id) WHERE request_id IS NOT NULL;
-- Every key the registry has ever signed with. A rotated key is retired, never deleted: certificates signed under it must stay verifiable for their whole term.
CREATE TABLE IF NOT EXISTS signing_keys (
  key_id text PRIMARY KEY,
  alg text NOT NULL DEFAULT 'Ed25519',
  public_key_pem text NOT NULL,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  retired_at timestamptz
);
-- Local projection of the facts the issue checks need about a subject (status, certificates, docking), fed by the read-model events of the owning services.
CREATE TABLE IF NOT EXISTS subjects (
  model text NOT NULL,
  id text NOT NULL,
  label text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '',
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (model, id)
);
