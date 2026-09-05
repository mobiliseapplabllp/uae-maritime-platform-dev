-- What the classification society last reported for the ship: class standing, surveys due, conditions of class and
-- the statutory certificates it holds on delegation.
ALTER TABLE vessels ADD COLUMN IF NOT EXISTS class_status jsonb;
