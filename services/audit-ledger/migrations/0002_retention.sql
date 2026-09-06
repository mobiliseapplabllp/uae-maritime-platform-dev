-- Retention. The ledger is append-only by trigger, so a purge under the retention policy is the one sanctioned
-- exception: rows older than the cut-off leave in ledger order, and the hash of the last row to leave is kept as
-- the anchor the chain is verified from — so what remains still proves itself, and what left is accounted for.
CREATE TABLE IF NOT EXISTS audit_anchor (
  id int PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  seq bigint NOT NULL,
  hash text NOT NULL,
  purged bigint NOT NULL DEFAULT 0,
  purged_before timestamptz,
  at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION audit_retention_purge(cutoff timestamptz)
RETURNS TABLE(purged bigint, anchor_seq bigint, anchor_hash text) LANGUAGE plpgsql AS $$
DECLARE last_seq bigint; last_hash text; n bigint;
BEGIN
  SELECT e.seq, e.hash INTO last_seq, last_hash FROM audit_entries e WHERE e.at < cutoff ORDER BY e.seq DESC LIMIT 1;
  IF last_seq IS NULL THEN RETURN QUERY SELECT 0::bigint, NULL::bigint, NULL::text; RETURN; END IF;
  ALTER TABLE audit_entries DISABLE TRIGGER audit_entries_no_update;
  DELETE FROM audit_entries e WHERE e.seq <= last_seq;
  GET DIAGNOSTICS n = ROW_COUNT;
  ALTER TABLE audit_entries ENABLE TRIGGER audit_entries_no_update;
  INSERT INTO audit_anchor(id, seq, hash, purged, purged_before, at) VALUES (1, last_seq, last_hash, n, cutoff, now())
    ON CONFLICT (id) DO UPDATE SET seq = EXCLUDED.seq, hash = EXCLUDED.hash, purged = audit_anchor.purged + EXCLUDED.purged, purged_before = EXCLUDED.purged_before, at = now();
  RETURN QUERY SELECT n, last_seq, last_hash;
END $$;
