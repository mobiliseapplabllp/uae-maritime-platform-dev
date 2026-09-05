-- Phase 3, Legislation.
--
-- The public portal. An instrument in force is citable by its reference number, at an address that never
-- changes and never disappears: a circular that is later superseded still answers at its address, saying
-- what replaced it. The slug is the reference normalised for a URL; the content hash lets a citation say
-- which text it cited and lets a cache answer "unchanged".
ALTER TABLE legal_instruments ADD COLUMN IF NOT EXISTS public_slug text;
ALTER TABLE legal_instruments ADD COLUMN IF NOT EXISTS content_hash text NOT NULL DEFAULT '';
ALTER TABLE legal_instruments ADD COLUMN IF NOT EXISTS published_at timestamptz;
-- a desk may keep one instrument off the portal without changing its type (an in-force but sensitive order)
ALTER TABLE legal_instruments ADD COLUMN IF NOT EXISTS public boolean NOT NULL DEFAULT true;
UPDATE legal_instruments SET public_slug = lower(regexp_replace(ref_no, '[^A-Za-z0-9]+', '-', 'g')) WHERE public_slug IS NULL;
UPDATE legal_instruments SET published_at = COALESCE(approved_at, effective_date, issued_date) WHERE published_at IS NULL AND status <> 'DRAFT';
CREATE UNIQUE INDEX IF NOT EXISTS legal_instruments_slug_idx ON legal_instruments(public_slug);
CREATE INDEX IF NOT EXISTS legal_instruments_public_idx ON legal_instruments(status, public) WHERE status <> 'DRAFT';

-- The IMO watch. The desk monitors the IMO bodies the imoSource master names — each with its series, its
-- address and how often it is read. Every document a source produces becomes an item here, once; the desk
-- assesses each one (does it need transposing into a national instrument?) and links the instrument that
-- implements it. The poll state per source is what the sources panel shows.
CREATE TABLE IF NOT EXISTS imo_source_polls (
  source text PRIMARY KEY,
  last_polled_at timestamptz,
  last_status text NOT NULL DEFAULT 'NEVER',
  last_error text NOT NULL DEFAULT '',
  last_items int NOT NULL DEFAULT 0,
  new_items int NOT NULL DEFAULT 0,
  next_due_at timestamptz,
  polls int NOT NULL DEFAULT 0,
  mode text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS imo_watch_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL,
  body text NOT NULL DEFAULT '',
  series text NOT NULL DEFAULT '',
  reference text NOT NULL,
  title text NOT NULL,
  subject text NOT NULL DEFAULT '',
  published_on date,
  entry_into_force date,
  url text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'NEW',
  assessment text NOT NULL DEFAULT '',
  assessed_by_id text,
  assessed_by text NOT NULL DEFAULT '',
  assessed_at timestamptz,
  due_on date,
  instrument_id uuid REFERENCES legal_instruments(id) ON DELETE SET NULL,
  instrument_ref text NOT NULL DEFAULT '',
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  seen_count int NOT NULL DEFAULT 1,
  raw jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS imo_watch_items_ref_idx ON imo_watch_items(source, upper(reference));
CREATE INDEX IF NOT EXISTS imo_watch_items_status_idx ON imo_watch_items(status, published_on DESC);
CREATE INDEX IF NOT EXISTS imo_watch_items_instrument_idx ON imo_watch_items(instrument_id) WHERE instrument_id IS NOT NULL;
