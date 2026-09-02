CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title text NOT NULL,
  title_ar text,
  body text NOT NULL DEFAULT '',
  body_ar text,
  severity text NOT NULL DEFAULT 'info',
  link text,
  audience_perm text,
  user_id text,
  source text NOT NULL DEFAULT 'system',
  event_type text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS notifications_created_idx ON notifications(created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_audience_idx ON notifications(audience_perm);
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id);
CREATE TABLE IF NOT EXISTS notification_reads (
  notification_id uuid NOT NULL REFERENCES notifications(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  read_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (notification_id, user_id)
);
