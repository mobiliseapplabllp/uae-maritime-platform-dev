-- Bilingual search. The registers hold Arabic names and titles; the read models did not carry them, so a
-- search in Arabic could not match anything however good the analysis chain was. These are the two read
-- models whose sources genuinely hold Arabic text today.
ALTER TABLE rm_companies ADD COLUMN IF NOT EXISTS name_ar text;
ALTER TABLE rm_legal_instruments ADD COLUMN IF NOT EXISTS title_ar text;

-- Trigram indexes for the PostgreSQL driver. Without them an ILIKE '%term%' over a growing register is a
-- sequential scan on every keystroke of the command palette; with them it is an index lookup. This is the
-- difference between the fallback driver being a real answer and being a demonstration.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE INDEX IF NOT EXISTS rm_vessels_name_trgm ON rm_vessels USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_vessels_imo_trgm ON rm_vessels USING gin (imo gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_port_calls_vcn_trgm ON rm_port_calls USING gin (vcn gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_seafarers_name_trgm ON rm_seafarers USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_seafarers_cdc_trgm ON rm_seafarers USING gin (cdc_no gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_companies_name_trgm ON rm_companies USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_companies_name_ar_trgm ON rm_companies USING gin (name_ar gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_incidents_title_trgm ON rm_incidents USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_incidents_number_trgm ON rm_incidents USING gin (number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_invoices_number_trgm ON rm_invoices USING gin (number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_legal_title_trgm ON rm_legal_instruments USING gin (title gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_legal_title_ar_trgm ON rm_legal_instruments USING gin (title_ar gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_instruments_number_trgm ON rm_instruments USING gin (number gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_instruments_entity_trgm ON rm_instruments USING gin (entity_name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_users_name_trgm ON rm_users USING gin (name gin_trgm_ops);
CREATE INDEX IF NOT EXISTS rm_users_email_trgm ON rm_users USING gin (email gin_trgm_ops);
