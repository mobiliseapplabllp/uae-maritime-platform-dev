-- What an applied or accepted conclusion did to the record, as the tool gateway carried it: one entry per tool
-- call with its outcome, kept whether it ran, was refused or failed. Empty for the agents that only conclude.
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS execution jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS executed_at timestamptz;
