-- Tenancy on the request register.
--
-- The service already narrowed a non-staff reader to what they personally lodged, keyed off a permission.
-- That is nearly right and one step short: a company with two employees had each of them seeing only their
-- own applications and neither seeing the company's, and the rule keyed off `services.assess` rather than
-- off what the reader is scoped to, so a scoped principal who happened to hold a staff permission read
-- everything. The partition is what the reader is, not what they may do.
--
-- Both rules now apply, and they compose with AND so the result can only narrow: a company principal is
-- confined to their company, a non-staff principal is still confined to their own, and a national officer
-- is confined by neither.
--
-- The key is the applicant's company code. The applicant block used to carry only the company's name — a
-- label a reader recognises, not an identifier the platform can match on — so the code was added to it and
-- is what this partitions by.

ALTER TABLE service_requests ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';

UPDATE service_requests SET scope_company = applicant->>'organisationCode'
  WHERE scope_company = '' AND COALESCE(applicant->>'organisationCode', '') <> '';

-- Kept in step by the database, so no path that lodges or reassigns a request has to remember to stamp it.
CREATE OR REPLACE FUNCTION sync_request_scope() RETURNS trigger AS $$
BEGIN
  NEW.scope_company := COALESCE(NULLIF(NEW.applicant->>'organisationCode', ''), '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS service_requests_scope ON service_requests;
CREATE TRIGGER service_requests_scope BEFORE INSERT OR UPDATE OF applicant ON service_requests
  FOR EACH ROW EXECUTE FUNCTION sync_request_scope();

CREATE INDEX IF NOT EXISTS service_requests_scope_idx ON service_requests(scope_company);
