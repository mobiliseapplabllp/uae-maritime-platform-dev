-- Tenancy on the ship register.
--
-- The register is national — a ship is entered on the flag's register, not a port's — so no port partition
-- applies here and a port officer reads all of it. What does apply is ownership: an agent acting for a ship
-- sees their own fleet, their own registrations and their own certificates, and nobody else's.
--
-- The key is the appointed agent, not the registered owner. The owner is a name on the row with nothing
-- behind it; the agent is the party that actually holds an account on this platform and acts through it, so
-- the agent is who "mine" can mean. The column already carries them, so it is backfilled from the row.

ALTER TABLE vessels             ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';
ALTER TABLE registrations       ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';
ALTER TABLE vessel_certificates ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';

UPDATE vessels SET scope_company = agent_code WHERE scope_company = '' AND agent_code <> '';
UPDATE registrations r SET scope_company = v.scope_company
  FROM vessels v WHERE v.id = r.vessel_id AND r.scope_company = '' AND v.scope_company <> '';
UPDATE vessel_certificates c SET scope_company = v.scope_company
  FROM vessels v WHERE v.id = c.vessel_id AND c.scope_company = '' AND v.scope_company <> '';

-- The ship's agent changes; everything hanging off her follows, in the database rather than in each of the
-- paths that reassigns one.
CREATE OR REPLACE FUNCTION sync_vessel_scope() RETURNS trigger AS $$
BEGIN
  NEW.scope_company := COALESCE(NULLIF(NEW.agent_code, ''), '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS vessels_scope ON vessels;
CREATE TRIGGER vessels_scope BEFORE INSERT OR UPDATE OF agent_code ON vessels
  FOR EACH ROW EXECUTE FUNCTION sync_vessel_scope();

/* The cascade fires on `agent_code`, not on `scope_company`, and that distinction is the whole point.
 * Postgres decides `UPDATE OF <column>` from the columns named in the statement's SET clause — not from what
 * a BEFORE trigger went on to change. `scope_company` is only ever set by the BEFORE trigger above, so a
 * cascade listening for it would never fire on the one statement that matters: the reassignment of a ship
 * to a new agent, which writes `agent_code` alone. */
CREATE OR REPLACE FUNCTION resync_for_vessel() RETURNS trigger AS $$
BEGIN
  UPDATE registrations       SET scope_company = NEW.scope_company WHERE vessel_id = NEW.id AND scope_company IS DISTINCT FROM NEW.scope_company;
  UPDATE vessel_certificates SET scope_company = NEW.scope_company WHERE vessel_id = NEW.id AND scope_company IS DISTINCT FROM NEW.scope_company;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS vessels_scope_cascade ON vessels;
CREATE TRIGGER vessels_scope_cascade AFTER INSERT OR UPDATE OF agent_code, scope_company ON vessels
  FOR EACH ROW EXECUTE FUNCTION resync_for_vessel();

-- A registration lodged before the ship is on the register has no vessel to inherit from; it takes its
-- owner when the vessel is entered and the cascade runs.
CREATE OR REPLACE FUNCTION sync_registration_scope() RETURNS trigger AS $$
DECLARE v_code text;
BEGIN
  IF NEW.vessel_id IS NOT NULL THEN
    SELECT v.scope_company INTO v_code FROM vessels v WHERE v.id = NEW.vessel_id;
  END IF;
  NEW.scope_company := COALESCE(v_code, NEW.scope_company, '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS registrations_scope ON registrations;
CREATE TRIGGER registrations_scope BEFORE INSERT OR UPDATE OF vessel_id ON registrations
  FOR EACH ROW EXECUTE FUNCTION sync_registration_scope();

-- A certificate is written after the ship it belongs to, so the cascade above has already run by the time
-- it arrives: it needs its own rule, deriving from the vessel exactly as a registration does.
CREATE OR REPLACE FUNCTION sync_certificate_scope() RETURNS trigger AS $$
DECLARE v_code text;
BEGIN
  IF NEW.vessel_id IS NOT NULL THEN
    SELECT v.scope_company INTO v_code FROM vessels v WHERE v.id = NEW.vessel_id;
  END IF;
  NEW.scope_company := COALESCE(v_code, NEW.scope_company, '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS vessel_certificates_scope ON vessel_certificates;
CREATE TRIGGER vessel_certificates_scope BEFORE INSERT OR UPDATE OF vessel_id ON vessel_certificates
  FOR EACH ROW EXECUTE FUNCTION sync_certificate_scope();

CREATE INDEX IF NOT EXISTS vessels_scope_idx             ON vessels(scope_company);
CREATE INDEX IF NOT EXISTS registrations_scope_idx       ON registrations(scope_company);
CREATE INDEX IF NOT EXISTS vessel_certificates_scope_idx ON vessel_certificates(scope_company);
