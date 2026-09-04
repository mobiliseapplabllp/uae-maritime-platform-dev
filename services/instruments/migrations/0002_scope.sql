-- Tenancy on the instrument register.
--
-- A licence names what it is issued against — a ship, a seafarer, a berth, a company — and that is not the
-- same question as who holds it. `entity_name` answered the first and nothing answered the second, which is
-- why this register could not be partitioned at all until now: there was no identifier on the row to
-- partition by, only a display name.
--
-- `holder_code` answers it. A vessel's certificate is held by the ship's appointed agent, a facility's
-- statement of compliance by the terminal operator, a company's licence by the company. A seafarer's
-- certificate is held by the seafarer and by no company at all, so it stays empty — and empty means nobody,
-- not everybody, which is the whole reason the two partitions have different rules.

ALTER TABLE licences ADD COLUMN IF NOT EXISTS holder_code   text NOT NULL DEFAULT '';
ALTER TABLE licences ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';

UPDATE licences SET scope_company = holder_code WHERE scope_company = '' AND holder_code <> '';

CREATE OR REPLACE FUNCTION sync_licence_scope() RETURNS trigger AS $$
BEGIN
  NEW.scope_company := COALESCE(NULLIF(NEW.holder_code, ''), '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS licences_scope ON licences;
CREATE TRIGGER licences_scope BEFORE INSERT OR UPDATE OF holder_code ON licences
  FOR EACH ROW EXECUTE FUNCTION sync_licence_scope();

CREATE INDEX IF NOT EXISTS licences_scope_idx ON licences(scope_company);
