-- Tenancy on the read models.
--
-- The registers behind these projections are partitioned, but a projection of a partitioned record is not
-- partitioned by itself. Until this migration, every reporting surface — the search palette, the hover cards,
-- the stat strips — answered from national data regardless of who asked, which quietly reopened the very
-- boundary the registers enforce.
--
-- The columns mirror the source tables exactly, so the same predicate (scopeWhere) applies here and there.
-- '' means unpartitioned, which for a containment column (port) means shared and for an ownership column
-- (company) means internal to the administration.

ALTER TABLE rm_vessels             ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';
ALTER TABLE rm_vessel_certificates ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';
ALTER TABLE rm_registrations       ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';
ALTER TABLE rm_instruments         ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';
ALTER TABLE rm_companies           ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';

ALTER TABLE rm_port_calls          ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';
ALTER TABLE rm_port_calls          ADD COLUMN IF NOT EXISTS scope_port    text NOT NULL DEFAULT '';
ALTER TABLE rm_invoices            ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';

ALTER TABLE rm_berths              ADD COLUMN IF NOT EXISTS scope_port    text NOT NULL DEFAULT '';
ALTER TABLE rm_resources           ADD COLUMN IF NOT EXISTS scope_port    text NOT NULL DEFAULT '';
ALTER TABLE rm_incidents           ADD COLUMN IF NOT EXISTS scope_port    text NOT NULL DEFAULT '';
ALTER TABLE rm_inspections         ADD COLUMN IF NOT EXISTS scope_port    text NOT NULL DEFAULT '';

CREATE INDEX IF NOT EXISTS rm_vessels_scope_idx      ON rm_vessels (scope_company);
CREATE INDEX IF NOT EXISTS rm_port_calls_scope_idx   ON rm_port_calls (scope_company, scope_port);
CREATE INDEX IF NOT EXISTS rm_invoices_scope_idx     ON rm_invoices (scope_company);
CREATE INDEX IF NOT EXISTS rm_instruments_scope_idx  ON rm_instruments (scope_company);
CREATE INDEX IF NOT EXISTS rm_companies_scope_idx    ON rm_companies (scope_company);
CREATE INDEX IF NOT EXISTS rm_incidents_scope_idx    ON rm_incidents (scope_port);
CREATE INDEX IF NOT EXISTS rm_inspections_scope_idx  ON rm_inspections (scope_port);
