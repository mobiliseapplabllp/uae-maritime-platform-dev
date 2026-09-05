-- The last word the labour ministry gave on a seafarer's employment and sponsor, with when it was asked.
ALTER TABLE seafarers ADD COLUMN IF NOT EXISTS employment_check jsonb;
