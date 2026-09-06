-- The hourly sweep chases a decision left unreviewed and reminds the desk of an agent left suspended; each is chased once.
ALTER TABLE decisions ADD COLUMN IF NOT EXISTS chased_at timestamptz;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS suspension_noticed_at timestamptz;
