-- An unread critical notice is escalated once: sent on to the people it was for, by the channels Settings → Notifications allows.
ALTER TABLE notifications ADD COLUMN IF NOT EXISTS escalated_at timestamptz;
CREATE INDEX IF NOT EXISTS notifications_escalation_idx ON notifications(created_at) WHERE severity = 'error' AND escalated_at IS NULL;
