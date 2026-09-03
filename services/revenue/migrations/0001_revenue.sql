CREATE EXTENSION IF NOT EXISTS pgcrypto;
-- The published rate card. `rate` is the figure in force; `revisions` is the published trail that led to it, oldest first.
CREATE TABLE IF NOT EXISTS tariffs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code text NOT NULL UNIQUE,
  name text NOT NULL,
  name_ar text,
  category text NOT NULL DEFAULT 'MARINE',
  unit text NOT NULL DEFAULT '',
  rate numeric(14,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'AED',
  active boolean NOT NULL DEFAULT true,
  revisions jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- Invoices raised on vessel calls. Amounts are stored to two decimals and computed in integer minor units so totals never drift.
CREATE TABLE IF NOT EXISTS invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  port_call_id text,
  vcn text NOT NULL DEFAULT '',
  vessel_id text,
  vessel_name text NOT NULL DEFAULT '',
  vessel_imo text NOT NULL DEFAULT '',
  bill_to jsonb NOT NULL DEFAULT '{}'::jsonb,
  lines jsonb NOT NULL DEFAULT '[]'::jsonb,
  subtotal numeric(14,2) NOT NULL DEFAULT 0,
  tax_name text NOT NULL DEFAULT 'VAT',
  tax_rate_pct numeric(5,2) NOT NULL DEFAULT 0,
  tax_amount numeric(14,2) NOT NULL DEFAULT 0,
  total numeric(14,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT 'AED',
  status text NOT NULL DEFAULT 'DRAFT',
  proforma boolean NOT NULL DEFAULT false,
  issued_at timestamptz,
  due_at timestamptz,
  paid_at timestamptz,
  paid_amount numeric(14,2) NOT NULL DEFAULT 0,
  payment_ref text NOT NULL DEFAULT '',
  payments jsonb NOT NULL DEFAULT '[]'::jsonb,
  cancel_reason text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  history jsonb NOT NULL DEFAULT '[]'::jsonb,
  reminded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
-- One live invoice per call: a cancelled invoice can be re-raised, an open one cannot be duplicated (also what makes the event consumer idempotent).
CREATE UNIQUE INDEX IF NOT EXISTS invoices_open_call_idx ON invoices(port_call_id) WHERE status <> 'CANCELLED' AND port_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS invoices_status_idx ON invoices(status);
CREATE INDEX IF NOT EXISTS invoices_vessel_idx ON invoices(vessel_id);
CREATE INDEX IF NOT EXISTS invoices_issued_idx ON invoices(issued_at);
CREATE INDEX IF NOT EXISTS invoices_created_idx ON invoices(created_at);
-- Local projections of what billing needs from other domains: the call as the ports service last published it, the ship register and the company directory.
CREATE TABLE IF NOT EXISTS port_calls (
  id text PRIMARY KEY,
  vcn text NOT NULL DEFAULT '',
  vessel_id text,
  vessel_name text NOT NULL DEFAULT '',
  vessel_imo text NOT NULL DEFAULT '',
  agent_code text NOT NULL DEFAULT '',
  agent_name text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT '',
  eta timestamptz,
  etb timestamptz,
  etd timestamptz,
  ata timestamptz,
  atb timestamptz,
  atd timestamptz,
  berth_code text,
  services jsonb NOT NULL DEFAULT '[]'::jsonb,
  cargo_ops jsonb NOT NULL DEFAULT '[]'::jsonb,
  vessel jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS port_calls_vcn_idx ON port_calls(vcn);
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
CREATE TABLE IF NOT EXISTS companies (
  id text PRIMARY KEY,
  code text NOT NULL,
  name text NOT NULL DEFAULT '',
  address text NOT NULL DEFAULT '',
  tax_id text NOT NULL DEFAULT '',
  category text,
  status text NOT NULL DEFAULT 'ACTIVE',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS companies_code_idx ON companies(code);
