-- The security review the federal authority runs on a port facility: the reference it was submitted under and the
-- outcome as last reported, whether polled or pushed.
ALTER TABLE port_facilities ADD COLUMN IF NOT EXISTS icp_review jsonb;
