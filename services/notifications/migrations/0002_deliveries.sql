-- Every message the platform sends outside itself — an email or an SMS through the messaging adapter — is a row,
-- so "did the officer get the email" has an answer in a table rather than in a mail server's memory.
CREATE TABLE IF NOT EXISTS deliveries (
  id              bigserial PRIMARY KEY,
  notification_id uuid REFERENCES notifications(id) ON DELETE CASCADE,
  channel         text NOT NULL CHECK (channel IN ('email','sms')),
  recipient       text NOT NULL,
  status          text NOT NULL CHECK (status IN ('sent','failed','skipped')),
  message_id      text NOT NULL DEFAULT '',
  call_id         text,
  mode            text NOT NULL DEFAULT '',
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS deliveries_created_idx ON deliveries(created_at DESC);
CREATE INDEX IF NOT EXISTS deliveries_notification_idx ON deliveries(notification_id);
