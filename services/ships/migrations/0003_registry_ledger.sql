-- The registry ledger.
--
-- A registration journey ends in a grant; what the grant did to the entry is a transaction, and so is
-- everything the registrar records against the entry directly — a mortgage, its discharge, a caveat, a
-- transcript. The ledger is the complete history of a ship's entry in date order, and the transcript is
-- assembled from it rather than stored, so the two cannot disagree.
ALTER TABLE registrations ADD COLUMN IF NOT EXISTS particulars jsonb NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS registry_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  vessel_id uuid NOT NULL REFERENCES vessels(id) ON DELETE CASCADE,
  vessel_name text NOT NULL DEFAULT '',
  official_number text NOT NULL DEFAULT '',
  type text NOT NULL,
  registration_id uuid,
  application_no text NOT NULL DEFAULT '',
  particulars jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'RECORDED',
  recorded_on timestamptz NOT NULL DEFAULT now(),
  recorded_by_id text,
  recorded_by text NOT NULL DEFAULT '',
  notes text NOT NULL DEFAULT '',
  digest text NOT NULL DEFAULT '',
  scope_company text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS registry_transactions_vessel_idx ON registry_transactions(vessel_id, recorded_on DESC);
CREATE INDEX IF NOT EXISTS registry_transactions_type_idx ON registry_transactions(type, recorded_on DESC);
CREATE INDEX IF NOT EXISTS registry_transactions_scope_idx ON registry_transactions(scope_company);

-- Mortgages, liens and charges against the entry itself — registered on grant of the application that
-- carried them, or directly by the registrar, and discharged by a transaction of their own.
CREATE TABLE IF NOT EXISTS registry_encumbrances (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id uuid NOT NULL REFERENCES vessels(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'MORTGAGE',
  holder text NOT NULL,
  amount numeric(16,2) NOT NULL DEFAULT 0,
  currency text NOT NULL DEFAULT '',
  registered_on timestamptz NOT NULL DEFAULT now(),
  discharged_on timestamptz,
  reference text NOT NULL DEFAULT '',
  registration_id uuid,
  transaction_id uuid,
  discharge_transaction_id uuid,
  notes text NOT NULL DEFAULT '',
  scope_company text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS registry_encumbrances_vessel_idx ON registry_encumbrances(vessel_id, discharged_on);
CREATE INDEX IF NOT EXISTS registry_encumbrances_scope_idx ON registry_encumbrances(scope_company);

-- Tenancy follows the ship: what is recorded against an entry is the ship's agent's to read.
CREATE OR REPLACE FUNCTION sync_ledger_scope() RETURNS trigger AS $$
DECLARE v_scope text;
BEGIN
  SELECT v.scope_company INTO v_scope FROM vessels v WHERE v.id = NEW.vessel_id;
  NEW.scope_company := COALESCE(v_scope, '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS registry_transactions_scope ON registry_transactions;
CREATE TRIGGER registry_transactions_scope BEFORE INSERT OR UPDATE OF vessel_id ON registry_transactions FOR EACH ROW EXECUTE FUNCTION sync_ledger_scope();
DROP TRIGGER IF EXISTS registry_encumbrances_scope ON registry_encumbrances;
CREATE TRIGGER registry_encumbrances_scope BEFORE INSERT OR UPDATE OF vessel_id ON registry_encumbrances FOR EACH ROW EXECUTE FUNCTION sync_ledger_scope();
