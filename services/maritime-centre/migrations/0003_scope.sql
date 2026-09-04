-- Tenancy on the maritime centre.
--
-- A case belongs to the port it happened in. Unlike the harbour registers, this service does not own the
-- estate — it holds a snapshot of it — so the port is not derived here: it arrives on the berth's read-model
-- event, stamped by the service that owns the berth, and the case inherits it from the berth it names. A
-- consumer deriving tenancy for itself would be guessing at another service's fact and would drift from it
-- the first time that fact changed.
--
-- A case with no berth is not yet any port's and is shared, which is right: an incident reported at sea is
-- every desk's business until it is placed.

ALTER TABLE berths    ADD COLUMN IF NOT EXISTS scope_port text NOT NULL DEFAULT '';
ALTER TABLE incidents ADD COLUMN IF NOT EXISTS scope_port text NOT NULL DEFAULT '';

UPDATE incidents i SET scope_port = b.scope_port
  FROM berths b WHERE b.id = i.berth_id AND i.scope_port = '' AND b.scope_port <> '';

-- Kept in step by the database rather than by each of the paths that moves a case to a berth.
CREATE OR REPLACE FUNCTION sync_incident_scope() RETURNS trigger AS $$
DECLARE v_port text;
BEGIN
  IF NEW.berth_id IS NOT NULL AND NEW.berth_id <> '' THEN
    SELECT b.scope_port INTO v_port FROM berths b WHERE b.id = NEW.berth_id;
  END IF;
  NEW.scope_port := COALESCE(v_port, '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS incidents_scope ON incidents;
CREATE TRIGGER incidents_scope BEFORE INSERT OR UPDATE OF berth_id ON incidents
  FOR EACH ROW EXECUTE FUNCTION sync_incident_scope();

-- When the estate's own port changes — a berth transferred between ports — the cases at it follow.
CREATE OR REPLACE FUNCTION resync_incidents_for_berth() RETURNS trigger AS $$
BEGIN
  UPDATE incidents SET scope_port = NEW.scope_port WHERE berth_id = NEW.id AND scope_port <> NEW.scope_port;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS berths_scope_cascade ON berths;
CREATE TRIGGER berths_scope_cascade AFTER INSERT OR UPDATE OF scope_port ON berths
  FOR EACH ROW EXECUTE FUNCTION resync_incidents_for_berth();

CREATE INDEX IF NOT EXISTS incidents_scope_idx ON incidents(scope_port);
CREATE INDEX IF NOT EXISTS berths_scope_idx    ON berths(scope_port);
