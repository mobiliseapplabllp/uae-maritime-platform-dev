-- Tenancy on the document store.
--
-- The store already recorded a scope on every upload — the uploader's, copied whole into a jsonb column and
-- then never read by anything. Two problems with that, and this fixes both.
--
-- It was never enforced: a document carried a scope and every query ignored it, which is the shape a tenancy
-- model takes when it looks present and is not.
--
-- And it recorded the wrong thing. An officer posted to two ports has a scope naming both; copying it onto
-- a document says the document belongs to two ports, which is a statement about the uploader rather than
-- about the record. A record belongs to one key or to none. So the partition columns take the single key the
-- uploader unambiguously had, and an uploader with more than one leaves the document unpartitioned — shared
-- across ports, owned by no company — rather than assigned to whichever key came first.

ALTER TABLE documents ADD COLUMN IF NOT EXISTS scope_port    text NOT NULL DEFAULT '';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';

UPDATE documents SET scope_port = scope->'ports'->>0
  WHERE scope_port = '' AND scope->>'level' = 'PORT' AND jsonb_array_length(COALESCE(scope->'ports', '[]'::jsonb)) = 1;
UPDATE documents SET scope_company = scope->'companies'->>0
  WHERE scope_company = '' AND scope->>'level' = 'COMPANY' AND jsonb_array_length(COALESCE(scope->'companies', '[]'::jsonb)) = 1;

CREATE INDEX IF NOT EXISTS documents_scope_idx ON documents(scope_port, scope_company);
