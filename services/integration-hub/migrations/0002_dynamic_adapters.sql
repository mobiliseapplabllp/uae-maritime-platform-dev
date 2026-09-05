-- An adapter is configured at runtime, not only switched: its counterpart's address, how it authenticates, the
-- headers it needs, its patience and persistence, what "test the connection" should ask, and — for a counterpart the
-- registry never named — its operations too. Credentials rest sealed and are never read back out.
ALTER TABLE adapters
  ADD COLUMN IF NOT EXISTS kind          text NOT NULL DEFAULT 'system' CHECK (kind IN ('system','custom')),
  ADD COLUMN IF NOT EXISTS protocol      text NOT NULL DEFAULT 'rest' CHECK (protocol IN ('rest','soap')),
  ADD COLUMN IF NOT EXISTS description   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reference     text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS auth          jsonb NOT NULL DEFAULT '{"type":"none"}'::jsonb,
  ADD COLUMN IF NOT EXISTS secrets       jsonb NOT NULL DEFAULT '{}'::jsonb,   -- sealed; presence is reported, values never are
  ADD COLUMN IF NOT EXISTS headers       jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS operations    jsonb NOT NULL DEFAULT '[]'::jsonb,   -- a custom adapter's operations; a system adapter's live in code
  ADD COLUMN IF NOT EXISTS health_path   text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS schedule      jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS inbound_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS inbound_secret  text,                                -- sealed signing key for deliveries the counterpart pushes to us
  ADD COLUMN IF NOT EXISTS updated_by    text NOT NULL DEFAULT '';

-- What a counterpart pushed to the platform: each delivery once, verified against the adapter's signing key, and
-- handed to the bus for whichever service owns the subject. The row is the receipt.
CREATE TABLE IF NOT EXISTS inbound_events (
  id           bigserial PRIMARY KEY,
  adapter      text NOT NULL REFERENCES adapters(key) ON DELETE CASCADE,
  delivery_id  text NOT NULL,
  event_type   text NOT NULL DEFAULT '',
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  received_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (adapter, delivery_id)
);
CREATE INDEX IF NOT EXISTS inbound_adapter_idx ON inbound_events (adapter, received_at DESC);
