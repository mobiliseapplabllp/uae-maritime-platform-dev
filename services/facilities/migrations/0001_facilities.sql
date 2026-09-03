CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- The regulated-company directory. Master data owns the golden record — who the company is, its
-- registration and its address — and this table holds the regulatory overlay on the same id: the
-- standing this administration grants it, why that standing last changed, and the performance rating
-- its compliance audits have earned. Identity fields are mirrored so the directory renders, searches
-- and exports from one database; they are refreshed from master data's events and never edited here.
CREATE TABLE IF NOT EXISTS companies (
  id text PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  name_ar text,
  category text NOT NULL DEFAULT 'SERVICE_PROVIDER',
  types jsonb NOT NULL DEFAULT '[]'::jsonb,
  contact_name text NOT NULL DEFAULT '',
  contact_email text NOT NULL DEFAULT '',
  contact_phone text NOT NULL DEFAULT '',
  tax_id text NOT NULL DEFAULT '',
  registration_no text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  city text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ACTIVE',
  status_reason text NOT NULL DEFAULT '',
  status_changed_at timestamptz,
  status_changed_by_id text,
  status_changed_by text NOT NULL DEFAULT '',
  rating numeric(3,1) NOT NULL DEFAULT 0,
  onboarded_at date,
  remarks text NOT NULL DEFAULT '',
  real boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS companies_code_idx ON companies(upper(code));
CREATE INDEX IF NOT EXISTS companies_status_idx ON companies(status);
CREATE INDEX IF NOT EXISTS companies_category_idx ON companies(category, status);
CREATE INDEX IF NOT EXISTS companies_rating_idx ON companies(rating DESC);

-- Every change of standing, with the reason it was made on. Suspension and blacklisting are decisions
-- taken against a company, so the register keeps the whole line of them rather than only the last one.
CREATE TABLE IF NOT EXISTS company_status_history (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  from_status text NOT NULL DEFAULT '',
  to_status text NOT NULL,
  reason text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now(),
  by_id text,
  by text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS company_status_history_idx ON company_status_history(company_id, at DESC);

-- Berthing and terminal facilities as regulated subjects. The physical particulars are the harbour
-- estate's (projected from its events); what is held here is the regulatory overlay: who operates the
-- facility, where it stands under the ISPS Code, and what it is approved to handle.
CREATE TABLE IF NOT EXISTS port_facilities (
  id text PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL,
  name_ar text,
  facility_type text NOT NULL DEFAULT 'BERTH',
  terminal text NOT NULL DEFAULT '',
  berth_type text NOT NULL DEFAULT '',
  operator_id text,
  operator_name text NOT NULL DEFAULT '',
  isps_status text NOT NULL DEFAULT 'NOT_APPLICABLE',
  isps_level int NOT NULL DEFAULT 1,
  soc_no text NOT NULL DEFAULT '',
  soc_expiry timestamptz,
  psso_name text NOT NULL DEFAULT '',
  psso_phone text NOT NULL DEFAULT '',
  capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  loa_max numeric(6,1),
  draft_max numeric(5,2),
  capacity_value numeric(12,1),
  capacity_unit text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'OPERATIONAL',
  remarks text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS port_facilities_code_idx ON port_facilities(upper(code));
CREATE INDEX IF NOT EXISTS port_facilities_operator_idx ON port_facilities(operator_id);
CREATE INDEX IF NOT EXISTS port_facilities_isps_idx ON port_facilities(isps_status);
CREATE INDEX IF NOT EXISTS port_facilities_status_idx ON port_facilities(status);

-- A compliance audit of a regulated subject — a company or a port facility. The result and its remarks
-- are what the performance rating is computed from, so an audit is a row of its own and never a blob.
CREATE TABLE IF NOT EXISTS audits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  subject_kind text NOT NULL DEFAULT 'COMPANY',
  subject_id text NOT NULL,
  subject_name text NOT NULL DEFAULT '',
  audited_on timestamptz NOT NULL DEFAULT now(),
  auditor_id text,
  auditor text NOT NULL DEFAULT '',
  result text NOT NULL DEFAULT 'SATISFACTORY',
  scope text NOT NULL DEFAULT '',
  remarks text NOT NULL DEFAULT '',
  instrument_id text,
  instrument_no text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audits_subject_idx ON audits(subject_kind, subject_id, audited_on DESC);
CREATE INDEX IF NOT EXISTS audits_result_idx ON audits(result);

-- What a regulated subject still owes the administration: a finding to clear, an instrument to renew,
-- a condition to meet or a document to produce. The renewal work list is built from the instrument
-- snapshot rather than from here, so an obligation is only ever raised once a person has decided one.
CREATE TABLE IF NOT EXISTS obligations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_kind text NOT NULL DEFAULT 'COMPANY',
  subject_id text NOT NULL,
  subject_name text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'CONDITION',
  title text NOT NULL,
  detail text NOT NULL DEFAULT '',
  source_ref text NOT NULL DEFAULT '',
  due_at timestamptz,
  status text NOT NULL DEFAULT 'OPEN',
  raised_at timestamptz NOT NULL DEFAULT now(),
  raised_by_id text,
  raised_by text NOT NULL DEFAULT '',
  cleared_at timestamptz,
  cleared_by_id text,
  cleared_by text NOT NULL DEFAULT '',
  clearance_note text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS obligations_subject_idx ON obligations(subject_kind, subject_id, status);
CREATE INDEX IF NOT EXISTS obligations_open_idx ON obligations(due_at) WHERE status = 'OPEN';
CREATE UNIQUE INDEX IF NOT EXISTS obligations_source_idx ON obligations(subject_id, kind, source_ref) WHERE source_ref <> '';

-- Local snapshot of the instrument register, projected from `readmodel.upserted { kind: 'instrument' }`.
-- The register itself belongs to the instruments service and is never duplicated here: this table
-- exists so a company record can show what it holds and the renewal work list can be built from expiry
-- dates without a synchronous call to another service while a page is rendering.
CREATE TABLE IF NOT EXISTS instruments (
  id text PRIMARY KEY,
  number text NOT NULL DEFAULT '',
  subject_kind text NOT NULL DEFAULT 'COMPANY',
  subject_id text,
  entity_name text NOT NULL DEFAULT '',
  entity_type text NOT NULL DEFAULT '',
  type_label text NOT NULL DEFAULT '',
  instrument_class text NOT NULL DEFAULT 'LICENCE',
  class_label text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'APPLIED',
  applied_date timestamptz,
  issue_date timestamptz,
  expiry_date timestamptz,
  statutory boolean NOT NULL DEFAULT false,
  in_force boolean NOT NULL DEFAULT false,
  signed boolean NOT NULL DEFAULT false,
  performance_rating numeric(3,1),
  audits_count int NOT NULL DEFAULT 0,
  conditions text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS instruments_subject_idx ON instruments(subject_kind, subject_id);
CREATE INDEX IF NOT EXISTS instruments_expiry_idx ON instruments(expiry_date) WHERE status = 'ISSUED';
CREATE INDEX IF NOT EXISTS instruments_status_idx ON instruments(status);
