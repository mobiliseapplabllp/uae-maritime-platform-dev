-- Tenancy on the ledger.
--
-- An invoice belongs to the party billed and to nobody else, which makes this the register where the
-- distinction between containment and ownership matters most: an invoice carrying no company is the
-- administration's own, not everybody's. `scope_company` is therefore matched exactly — there is no empty
-- value that means "shared" here, and the predicate in the service-kit enforces that.
--
-- The owner is already on the row, inside the bill-to block, so it is backfilled rather than left for a
-- reseed. The key is the company's code, the same key an account's scope carries.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';
ALTER TABLE companies ADD COLUMN IF NOT EXISTS scope_company text NOT NULL DEFAULT '';

UPDATE invoices i SET scope_company = c.code
  FROM companies c WHERE c.id = (i.bill_to->>'companyId') AND i.scope_company = '' AND c.code <> '';
UPDATE companies SET scope_company = code WHERE scope_company = '' AND code <> '';

-- The bill-to block is written by the invoicing code on every issue and re-issue, so the owner is kept in
-- step by the database rather than by each of the paths that writes one.
CREATE OR REPLACE FUNCTION sync_invoice_scope() RETURNS trigger AS $$
DECLARE code text;
BEGIN
  SELECT c.code INTO code FROM companies c WHERE c.id = (NEW.bill_to->>'companyId');
  NEW.scope_company := COALESCE(code, NEW.scope_company, '');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS invoices_scope ON invoices;
CREATE TRIGGER invoices_scope BEFORE INSERT OR UPDATE OF bill_to ON invoices
  FOR EACH ROW EXECUTE FUNCTION sync_invoice_scope();

CREATE INDEX IF NOT EXISTS invoices_scope_idx ON invoices(scope_company);
CREATE INDEX IF NOT EXISTS companies_scope_idx ON companies(scope_company);
