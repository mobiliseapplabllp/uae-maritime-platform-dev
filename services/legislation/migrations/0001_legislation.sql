CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- One legal instrument: an act, a set of rules, a circular, a notice, an order or a convention the
-- administration has adopted. The governance chain is kept in columns rather than in a side table
-- because every stage of it — who drafted, who reviewed, who cleared it legally, who put it in force
-- and who withdrew it — has to be readable in the same query that renders the register row, and the
-- maker-checker rule compares the drafter against the approver on every publication attempt.
CREATE TABLE IF NOT EXISTS legal_instruments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ref_no text NOT NULL UNIQUE,
  title text NOT NULL,
  title_ar text,
  type text NOT NULL DEFAULT 'CIRCULAR',
  category text NOT NULL DEFAULT 'General',
  status text NOT NULL DEFAULT 'DRAFT',
  issued_by text NOT NULL DEFAULT '',
  issued_date timestamptz NOT NULL DEFAULT now(),
  effective_date timestamptz,
  expiry_date timestamptz,
  summary text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  -- the keyword classification the register search reads alongside the subject (category)
  tags jsonb NOT NULL DEFAULT '[]'::jsonb,
  attachments jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- both sides of a supersession chain, so the register can walk it in either direction
  supersedes text NOT NULL DEFAULT '',
  superseded_by text NOT NULL DEFAULT '',
  ack_required boolean NOT NULL DEFAULT false,
  -- the class of recipients an acknowledgement is required from: ALL_STAFF, or a role or department
  ack_class text NOT NULL DEFAULT 'ALL_STAFF',
  ack_class_value text NOT NULL DEFAULT '',
  ack_due_days int,
  drafted_by_id text,
  drafted_by text NOT NULL DEFAULT '',
  reviewed_by_id text,
  reviewed_by text NOT NULL DEFAULT '',
  reviewed_at timestamptz,
  review_note text NOT NULL DEFAULT '',
  cleared_by_id text,
  cleared_by text NOT NULL DEFAULT '',
  cleared_at timestamptz,
  clearance_note text NOT NULL DEFAULT '',
  approved_by_id text,
  approved_by text NOT NULL DEFAULT '',
  approved_at timestamptz,
  withdrawn_by_id text,
  withdrawn_by text NOT NULL DEFAULT '',
  withdrawn_at timestamptz,
  withdrawal_reason text NOT NULL DEFAULT '',
  source_note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS legal_instruments_status_idx ON legal_instruments(status);
CREATE INDEX IF NOT EXISTS legal_instruments_type_idx ON legal_instruments(type, status);
CREATE INDEX IF NOT EXISTS legal_instruments_category_idx ON legal_instruments(category);
CREATE INDEX IF NOT EXISTS legal_instruments_issued_idx ON legal_instruments(issued_date DESC);
CREATE INDEX IF NOT EXISTS legal_instruments_ack_idx ON legal_instruments(ack_required) WHERE ack_required;

-- Who has acknowledged an instrument and when. One row per person per instrument, so the outstanding
-- list is the recipient class minus this table rather than a counter that can drift.
CREATE TABLE IF NOT EXISTS instrument_acknowledgements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  instrument_id uuid NOT NULL REFERENCES legal_instruments(id) ON DELETE CASCADE,
  user_id text NOT NULL,
  name text NOT NULL DEFAULT '',
  role_name text NOT NULL DEFAULT '',
  note text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS instrument_ack_unique_idx ON instrument_acknowledgements(instrument_id, user_id);
CREATE INDEX IF NOT EXISTS instrument_ack_user_idx ON instrument_acknowledgements(user_id);

-- Amendments, supersessions and plain cross-references between instruments. A link is stored once, in
-- the direction it was made; the reverse side is read back from the same table under its inverse name,
-- so neither side of an amendment can go missing.
CREATE TABLE IF NOT EXISTS instrument_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_id uuid NOT NULL REFERENCES legal_instruments(id) ON DELETE CASCADE,
  to_id uuid REFERENCES legal_instruments(id) ON DELETE CASCADE,
  from_ref text NOT NULL DEFAULT '',
  to_ref text NOT NULL DEFAULT '',
  kind text NOT NULL DEFAULT 'REFERS_TO',
  note text NOT NULL DEFAULT '',
  by_id text,
  by text NOT NULL DEFAULT '',
  at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS instrument_links_unique_idx ON instrument_links(from_id, kind, coalesce(to_id::text, to_ref));
CREATE INDEX IF NOT EXISTS instrument_links_to_idx ON instrument_links(to_id);

-- Local snapshot of the staff roll, projected from identity's read-model events. The outstanding
-- acknowledgement list is a set difference against this table, so the register never calls another
-- service synchronously to work out who still owes a receipt.
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  name text NOT NULL DEFAULT '',
  email text NOT NULL DEFAULT '',
  role_name text NOT NULL DEFAULT '',
  designation text NOT NULL DEFAULT '',
  department text NOT NULL DEFAULT '',
  active boolean NOT NULL DEFAULT true,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS users_role_idx ON users(role_name) WHERE active;
CREATE INDEX IF NOT EXISTS users_department_idx ON users(department) WHERE active;
