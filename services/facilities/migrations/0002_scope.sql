-- Tenancy on the industry directory.
--
-- A company entry is owned by the company it describes: the operator reads and maintains their own, the
-- administration reads the register. A port facility is owned by the company that operates it — a terminal
-- operator sees their own berths and sheds, not a competitor's — and contained by the port it stands in.
--
-- Both keys are already on the row under another name, so they are backfilled rather than left for a reseed.

ALTER TABLE companies       ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';
ALTER TABLE port_facilities ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';
ALTER TABLE port_facilities ADD COLUMN IF NOT EXISTS scope_port    text NOT NULL DEFAULT '';

UPDATE companies SET scope_company = code WHERE scope_company = '' AND code <> '';
UPDATE port_facilities f SET scope_company = c.code
  FROM companies c WHERE c.id = f.operator_id AND f.scope_company = '' AND c.code <> '';

-- The operator is set on every write to a facility and the code is the company's own, so both are kept in
-- step by the database rather than by each of the paths that writes one.
CREATE OR REPLACE FUNCTION sync_company_scope() RETURNS trigger AS $$
BEGIN
  NEW.scope_company := COALESCE(NULLIF(NEW.code, ''), NEW.scope_company, '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS companies_scope ON companies;
CREATE TRIGGER companies_scope BEFORE INSERT OR UPDATE OF code ON companies
  FOR EACH ROW EXECUTE FUNCTION sync_company_scope();

CREATE OR REPLACE FUNCTION sync_facility_scope() RETURNS trigger AS $$
DECLARE code text;
BEGIN
  SELECT c.code INTO code FROM companies c WHERE c.id = NEW.operator_id;
  NEW.scope_company := COALESCE(code, NEW.scope_company, '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS port_facilities_scope ON port_facilities;
CREATE TRIGGER port_facilities_scope BEFORE INSERT OR UPDATE OF operator_id ON port_facilities
  FOR EACH ROW EXECUTE FUNCTION sync_facility_scope();

CREATE INDEX IF NOT EXISTS companies_scope_idx       ON companies(scope_company);
CREATE INDEX IF NOT EXISTS port_facilities_scope_idx ON port_facilities(scope_port, scope_company);

-- An obligation and an audit belong to whoever they were raised against: the record of a company's
-- shortcomings is that company's to read, and nobody else's. The subject already names them, so the owner
-- is derived from it and kept in step by a trigger on the same columns.
ALTER TABLE obligations ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';
ALTER TABLE audits      ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';

-- The triggers go first because they depend on the function, and a function's parameters cannot be renamed
-- by CREATE OR REPLACE — only by dropping it, which a trigger would otherwise hold open.
DROP TRIGGER IF EXISTS obligations_scope ON obligations;
DROP TRIGGER IF EXISTS audits_scope ON audits;
DROP FUNCTION IF EXISTS scope_of_subject(text, text);

-- Parameters are prefixed because plpgsql resolves a bare name to the column first: `WHERE c.id = id`
-- reads as `c.id = c.id`, which is not an error but is always true.
CREATE OR REPLACE FUNCTION scope_of_subject(p_kind text, p_id text) RETURNS text AS $$
DECLARE v_code text;
BEGIN
  IF p_kind = 'COMPANY' THEN
    SELECT c.code INTO v_code FROM companies c WHERE c.id = p_id;
  ELSIF p_kind = 'PORT_FACILITY' THEN
    SELECT f.scope_company INTO v_code FROM port_facilities f WHERE f.id = p_id;
  END IF;
  RETURN COALESCE(v_code, '');
END;
$$ LANGUAGE plpgsql STABLE;

UPDATE obligations SET scope_company = scope_of_subject(subject_kind, subject_id) WHERE scope_company = '';
UPDATE audits      SET scope_company = scope_of_subject(subject_kind, subject_id) WHERE scope_company = '';

CREATE OR REPLACE FUNCTION sync_subject_scope() RETURNS trigger AS $$
BEGIN
  NEW.scope_company := scope_of_subject(NEW.subject_kind, NEW.subject_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS obligations_scope ON obligations;
CREATE TRIGGER obligations_scope BEFORE INSERT OR UPDATE OF subject_kind, subject_id ON obligations
  FOR EACH ROW EXECUTE FUNCTION sync_subject_scope();
DROP TRIGGER IF EXISTS audits_scope ON audits;
CREATE TRIGGER audits_scope BEFORE INSERT OR UPDATE OF subject_kind, subject_id ON audits
  FOR EACH ROW EXECUTE FUNCTION sync_subject_scope();

CREATE INDEX IF NOT EXISTS obligations_scope_idx ON obligations(scope_company);
CREATE INDEX IF NOT EXISTS audits_scope_idx      ON audits(scope_company);
