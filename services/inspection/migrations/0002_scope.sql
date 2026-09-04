-- Tenancy on the survey and audit cell.
--
-- An inspection belongs to the port it was carried out in. This service does not own the call register — it
-- holds a snapshot of it — so the port is not derived here: it arrives on the call's read-model event,
-- stamped by the service that owns the call, and the inspection inherits it from the call it was raised
-- against. An inspection not tied to a call is no port's and is shared, which is right for a flag-state
-- survey arranged away from any berth.
--
-- Nothing here is company-readable. An inspection report is the administration's finding, not the operator's
-- copy of it: the vessel's agent learns of a detention through the notice served on them, not by reading the
-- inspection register. That is stated on the policy rather than defaulted.

ALTER TABLE port_calls  ADD COLUMN IF NOT EXISTS scope_port text NOT NULL DEFAULT '';
ALTER TABLE inspections ADD COLUMN IF NOT EXISTS scope_port text NOT NULL DEFAULT '';

UPDATE inspections i SET scope_port = pc.scope_port
  FROM port_calls pc WHERE pc.id = i.port_call_id AND i.scope_port = '' AND pc.scope_port <> '';

CREATE OR REPLACE FUNCTION sync_inspection_scope() RETURNS trigger AS $$
DECLARE v_port text;
BEGIN
  IF NEW.port_call_id IS NOT NULL AND NEW.port_call_id <> '' THEN
    SELECT pc.scope_port INTO v_port FROM port_calls pc WHERE pc.id = NEW.port_call_id;
  END IF;
  NEW.scope_port := COALESCE(v_port, '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS inspections_scope ON inspections;
CREATE TRIGGER inspections_scope BEFORE INSERT OR UPDATE OF port_call_id ON inspections
  FOR EACH ROW EXECUTE FUNCTION sync_inspection_scope();

-- When the call's own port changes, the inspections raised against it follow.
CREATE OR REPLACE FUNCTION resync_inspections_for_call() RETURNS trigger AS $$
BEGIN
  UPDATE inspections SET scope_port = NEW.scope_port WHERE port_call_id = NEW.id AND scope_port <> NEW.scope_port;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS port_calls_scope_cascade ON port_calls;
CREATE TRIGGER port_calls_scope_cascade AFTER INSERT OR UPDATE OF scope_port ON port_calls
  FOR EACH ROW EXECUTE FUNCTION resync_inspections_for_call();

CREATE INDEX IF NOT EXISTS inspections_scope_idx ON inspections(scope_port);
CREATE INDEX IF NOT EXISTS port_calls_scope_idx  ON port_calls(scope_port);
