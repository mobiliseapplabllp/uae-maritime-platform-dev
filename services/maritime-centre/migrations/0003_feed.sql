-- The feed's own ledger: when the AIS/LRIT adapter was last read, from what watermark, and what came of it. One row
-- per source, so the traffic screen can say "read two minutes ago, three fixes, all matched" rather than guess.
CREATE TABLE IF NOT EXISTS feed_polls (
  source          text PRIMARY KEY,
  last_polled_at  timestamptz,
  last_since      timestamptz,
  last_status     text NOT NULL DEFAULT '',
  last_error      text NOT NULL DEFAULT '',
  last_mode       text NOT NULL DEFAULT '',
  received        integer NOT NULL DEFAULT 0,
  matched         integer NOT NULL DEFAULT 0,
  polls           integer NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
