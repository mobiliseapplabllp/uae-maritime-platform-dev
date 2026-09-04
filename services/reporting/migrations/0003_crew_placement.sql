-- The crew read model gains the placement it projects.
--
-- The register partitions seafarers on the recruitment and placement service named on the record; a
-- projection of a partitioned register that does not carry the partition is a way around it, so the columns
-- come across with the event and reporting applies the same predicate.

ALTER TABLE rm_seafarers ADD COLUMN IF NOT EXISTS manning_agent_code text NOT NULL DEFAULT '';
ALTER TABLE rm_seafarers ADD COLUMN IF NOT EXISTS manning_agent_name text NOT NULL DEFAULT '';
ALTER TABLE rm_seafarers ADD COLUMN IF NOT EXISTS scope_company      text NOT NULL DEFAULT '';

UPDATE rm_seafarers SET scope_company = manning_agent_code WHERE scope_company = '' AND manning_agent_code <> '';

CREATE INDEX IF NOT EXISTS rm_seafarers_scope_idx ON rm_seafarers (scope_company);
