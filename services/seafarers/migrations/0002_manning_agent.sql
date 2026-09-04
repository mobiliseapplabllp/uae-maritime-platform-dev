-- Who a seafarer is placed by, and what that lets them see.
--
-- The register held no employer at all, which had two consequences. The domain one: a seafarer's record did
-- not say who recruited them, although that is a fact the administration licenses and supervises — a
-- recruitment and placement service is licensed under MLC 2006 Regulation 1.4 and answers for the seafarers
-- it places. The tenancy one: with nothing on the row to partition by, the register could only be national,
-- so a manning agency could not be shown its own crew and the policy said so in as many words.
--
-- The agent is the stable relationship and is therefore what the register partitions on. The alternative —
-- the operator of whichever ship the seafarer is aboard this month — would make a manning agent's view
-- flicker every time a contract ended, and would hand a shipping agent the discharge history of a person
-- they have no standing over.
--
-- An empty agent means a seafarer engaged directly by a shipowner, which is the other lawful route. Under
-- ownership semantics that record belongs to the administration and to no company, which is the right
-- answer: it is not shared with every agency for want of a better one.

ALTER TABLE seafarers ADD COLUMN IF NOT EXISTS manning_agent_code text NOT NULL DEFAULT '';
ALTER TABLE seafarers ADD COLUMN IF NOT EXISTS manning_agent_name text NOT NULL DEFAULT '';
ALTER TABLE seafarers ADD COLUMN IF NOT EXISTS scope_company     text NOT NULL DEFAULT '';

UPDATE seafarers SET scope_company = manning_agent_code WHERE scope_company = '' AND manning_agent_code <> '';

-- Kept in step by the database rather than by each of the paths that can change a placement.
CREATE OR REPLACE FUNCTION sync_seafarer_scope() RETURNS trigger AS $$
BEGIN
  NEW.scope_company := COALESCE(NEW.manning_agent_code, '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS seafarers_scope ON seafarers;
CREATE TRIGGER seafarers_scope BEFORE INSERT OR UPDATE OF manning_agent_code ON seafarers
  FOR EACH ROW EXECUTE FUNCTION sync_seafarer_scope();

CREATE INDEX IF NOT EXISTS seafarers_scope_idx ON seafarers(scope_company);
CREATE INDEX IF NOT EXISTS seafarers_manning_idx ON seafarers(manning_agent_code);
