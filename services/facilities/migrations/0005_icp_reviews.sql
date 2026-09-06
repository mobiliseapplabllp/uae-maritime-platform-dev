-- Every security review the federal authority has run on a port facility, one line per submission. The facility
-- row's icp_review is the latest of these; the history is what the desk reads a year later. The authority's
-- reference is kept as given — a recorded contract may hand the same one back, so it is not a key.
CREATE TABLE IF NOT EXISTS icp_reviews (
  id text PRIMARY KEY,
  facility_id text NOT NULL REFERENCES port_facilities(id) ON DELETE CASCADE,
  reference text NOT NULL,
  status text NOT NULL,
  reason text NOT NULL DEFAULT '',
  requested_at timestamptz NOT NULL DEFAULT now(),
  requested_by text NOT NULL DEFAULT '',
  expected_by date,
  decided_at timestamptz,
  conditions jsonb NOT NULL DEFAULT '[]'::jsonb,
  checked_at timestamptz NOT NULL DEFAULT now(),
  mode text NOT NULL DEFAULT 'stub'
);
CREATE INDEX IF NOT EXISTS icp_reviews_facility_idx ON icp_reviews(facility_id, requested_at DESC);
