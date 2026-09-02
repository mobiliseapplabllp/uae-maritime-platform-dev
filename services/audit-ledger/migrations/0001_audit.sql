CREATE TABLE IF NOT EXISTS audit_entries (
  seq bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  at timestamptz NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  service text NOT NULL,
  actor_id text NOT NULL,
  actor_name text NOT NULL DEFAULT '',
  actor_email text NOT NULL DEFAULT '',
  actor_kind text NOT NULL DEFAULT 'user',
  action text NOT NULL,
  entity text NOT NULL,
  entity_id text,
  entity_label text,
  before jsonb,
  after jsonb,
  note text,
  ip text,
  correlation_id text,
  prev_hash text NOT NULL,
  hash text NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_entries_at_idx ON audit_entries(at DESC);
CREATE INDEX IF NOT EXISTS audit_entries_entity_idx ON audit_entries(entity, entity_id);
CREATE INDEX IF NOT EXISTS audit_entries_actor_idx ON audit_entries(actor_id);
CREATE INDEX IF NOT EXISTS audit_entries_action_idx ON audit_entries(action);
-- Append-only by construction: no role may update or delete ledger rows.
CREATE OR REPLACE FUNCTION audit_entries_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit ledger is append-only'; END $$;
DROP TRIGGER IF EXISTS audit_entries_no_update ON audit_entries;
CREATE TRIGGER audit_entries_no_update BEFORE UPDATE OR DELETE ON audit_entries FOR EACH ROW EXECUTE FUNCTION audit_entries_immutable();
