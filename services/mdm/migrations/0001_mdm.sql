CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS lookups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category text NOT NULL,
  code text NOT NULL,
  label text NOT NULL,
  label_ar text,
  meta jsonb NOT NULL DEFAULT '{}'::jsonb,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (category, code)
);
CREATE INDEX IF NOT EXISTS lookups_category_idx ON lookups(category, active);
CREATE TABLE IF NOT EXISTS settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text
);
CREATE TABLE IF NOT EXISTS companies (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  name_ar text,
  category text NOT NULL DEFAULT 'SERVICE_PROVIDER',
  types text[] NOT NULL DEFAULT '{}',
  contact_name text NOT NULL DEFAULT '',
  contact_email text NOT NULL DEFAULT '',
  contact_phone text NOT NULL DEFAULT '',
  tax_id text NOT NULL DEFAULT '',
  registration_no text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'ACTIVE',
  onboarded_at date,
  rating numeric(3,1) NOT NULL DEFAULT 0,
  real boolean NOT NULL DEFAULT false,
  record_status text NOT NULL DEFAULT 'PUBLISHED',
  scope jsonb NOT NULL DEFAULT '{"level":"NATIONAL"}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS companies_name_idx ON companies(lower(name));
CREATE TABLE IF NOT EXISTS vessels_golden (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  imo text NOT NULL UNIQUE,
  name text NOT NULL,
  name_ar text,
  mmsi text,
  call_sign text,
  flag text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT 'GEN',
  built int,
  dwt int, grt int, loa numeric(7,1), beam numeric(6,1), max_draft numeric(5,1),
  owner text NOT NULL DEFAULT '', operator text NOT NULL DEFAULT '', manager text NOT NULL DEFAULT '',
  agent_code text, class_society text, teu_capacity int,
  liner boolean NOT NULL DEFAULT false, real boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'ACTIVE',
  record_status text NOT NULL DEFAULT 'PUBLISHED',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vessels_golden_name_idx ON vessels_golden(lower(name));
