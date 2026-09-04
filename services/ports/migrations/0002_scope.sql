-- Tenancy on the harbour registers.
--
-- Two partitions, because a record belongs to two different kinds of thing and they do not behave alike.
-- `scope_port` contains: a call, a berth and a craft belong to one port, and a record naming no port is
-- above them all and shared. `scope_company` owns: a call belongs to the agent who lodged it, an invoice to
-- the party billed, and a record naming no company belongs to nobody rather than to everybody.
--
-- Both default to empty, and both defaults are safe: an unstamped record is shared across ports and owned by
-- no company. The seed stamps them from the world; nothing here guesses a port code it cannot know.

ALTER TABLE port_calls ADD COLUMN IF NOT EXISTS scope_port text NOT NULL DEFAULT '';
ALTER TABLE port_calls ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';
ALTER TABLE berths     ADD COLUMN IF NOT EXISTS scope_port text NOT NULL DEFAULT '';
ALTER TABLE resources  ADD COLUMN IF NOT EXISTS scope_port text NOT NULL DEFAULT '';
ALTER TABLE invoices   ADD COLUMN IF NOT EXISTS scope_port text NOT NULL DEFAULT '';
ALTER TABLE invoices   ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';
ALTER TABLE companies  ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';

-- The owner is already on these rows under another name, so it is backfilled from what is there rather than
-- left for a reseed: a call is the lodging agent's, an invoice is the billed party's, a company is its own.
UPDATE port_calls SET scope_company = agent_code WHERE scope_company = '' AND agent_code <> '';
UPDATE invoices i SET scope_company = pc.scope_company
  FROM port_calls pc WHERE pc.id::text = i.port_call_id AND i.scope_company = '' AND pc.scope_company <> '';
UPDATE companies  SET scope_company = code       WHERE scope_company = '' AND code <> '';

-- The predicate is (partition = '' OR partition = ANY(keys)), so the index that serves it is on the column
-- itself, ahead of whatever else the query filters on.
CREATE INDEX IF NOT EXISTS port_calls_scope_idx ON port_calls(scope_port, scope_company);
CREATE INDEX IF NOT EXISTS berths_scope_idx     ON berths(scope_port);
CREATE INDEX IF NOT EXISTS resources_scope_idx  ON resources(scope_port);
CREATE INDEX IF NOT EXISTS invoices_scope_idx   ON invoices(scope_port, scope_company);
CREATE INDEX IF NOT EXISTS companies_scope_idx  ON companies(scope_company);

-- A call's port is the port of the berth it is at; before a berth is allocated it is not yet any port's, and
-- empty is exactly right for that — a call nobody has taken is visible to every port's desk. Keeping that in
-- step with the berth is the database's job rather than the caller's, for the same reason the geography
-- column is: a handler added later cannot forget a trigger.
CREATE OR REPLACE FUNCTION sync_call_scope() RETURNS trigger AS $$
BEGIN
  IF NEW.berth_id IS NOT NULL THEN
    SELECT b.scope_port INTO NEW.scope_port FROM berths b WHERE b.id = NEW.berth_id;
  END IF;
  IF NEW.scope_port IS NULL THEN NEW.scope_port := ''; END IF;
  -- the call belongs to the agent named on it, whoever keyed it in
  NEW.scope_company := COALESCE(NULLIF(NEW.agent_code, ''), NEW.scope_company, '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS port_calls_scope ON port_calls;
CREATE TRIGGER port_calls_scope BEFORE INSERT OR UPDATE OF berth_id, agent_code ON port_calls
  FOR EACH ROW EXECUTE FUNCTION sync_call_scope();
