CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- A conversation belongs to the person who started it and to nobody else: the assistant answers from the
-- platform's records under that person's permissions, so their history is theirs alone to read.
CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id text NOT NULL,
  user_name text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  language text NOT NULL DEFAULT 'en',
  message_count int NOT NULL DEFAULT 0,
  last_message_at timestamptz,
  archived boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS conversations_user_idx ON conversations(user_id, last_message_at DESC NULLS LAST);

-- Every turn, with what the answer was built from: the records it cited, the tools it was allowed to call, the
-- ones it refused for want of a permission, and anything in the retrieved content that tried to give it orders.
CREATE TABLE IF NOT EXISTS messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  seq int NOT NULL DEFAULT 1,
  role text NOT NULL DEFAULT 'user',
  text text NOT NULL DEFAULT '',
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  tools jsonb NOT NULL DEFAULT '[]'::jsonb,
  refusals jsonb NOT NULL DEFAULT '[]'::jsonb,
  flagged jsonb NOT NULL DEFAULT '[]'::jsonb,
  engine text NOT NULL DEFAULT '',
  latency_ms int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS messages_conversation_idx ON messages(conversation_id, seq);

/* The retrieval corpus: the platform's own content, indexed at seed time.
 *
 * `terms` is the document's vector — the deterministic offline embedding, a normalised tf-idf map computed from
 * this corpus and nothing else, so the same corpus always produces the same ranking with no network anywhere.
 * `permission` is what a reader must hold to be shown the passage at all: retrieval is scoped before it ranks,
 * never after, so a passage a user may not see never reaches the answer to be filtered out of it. */
CREATE TABLE IF NOT EXISTS corpus (
  id text PRIMARY KEY,
  kind text NOT NULL,
  ref text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  title_ar text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  link text NOT NULL DEFAULT '',
  permission text NOT NULL DEFAULT '',
  entity_type text NOT NULL DEFAULT '',
  entity_id text NOT NULL DEFAULT '',
  terms jsonb NOT NULL DEFAULT '{}'::jsonb,
  token_count int NOT NULL DEFAULT 0,
  /* Content that arrived from a record and tries to instruct the reader. It is kept, marked, and quoted as data. */
  untrusted boolean NOT NULL DEFAULT false,
  injection_markers jsonb NOT NULL DEFAULT '[]'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS corpus_kind_idx ON corpus(kind);
CREATE INDEX IF NOT EXISTS corpus_permission_idx ON corpus(permission);

-- Document frequency for every term in the corpus, so a query is embedded against the same statistics the
-- documents were.
CREATE TABLE IF NOT EXISTS corpus_terms (
  term text PRIMARY KEY,
  df int NOT NULL DEFAULT 0,
  idf numeric(10,6) NOT NULL DEFAULT 0
);

-- A prepared draft: a notice, a decision letter or an inspection summary, written from platform records and
-- carrying the citations it was written from. A draft is never issued from here — it is handed to a human.
CREATE TABLE IF NOT EXISTS drafts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL,
  subject_type text NOT NULL DEFAULT '',
  subject_id text NOT NULL DEFAULT '',
  subject_label text NOT NULL DEFAULT '',
  title text NOT NULL DEFAULT '',
  body text NOT NULL DEFAULT '',
  citations jsonb NOT NULL DEFAULT '[]'::jsonb,
  facts jsonb NOT NULL DEFAULT '{}'::jsonb,
  language text NOT NULL DEFAULT 'en',
  status text NOT NULL DEFAULT 'DRAFT',
  engine text NOT NULL DEFAULT '',
  prepared_by_id text NOT NULL DEFAULT '',
  prepared_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS drafts_kind_idx ON drafts(kind, created_at DESC);
CREATE INDEX IF NOT EXISTS drafts_subject_idx ON drafts(subject_type, subject_id);

/* Local snapshots of the records the assistant is allowed to read on a user's behalf. Each carries the
 * permission a reader must hold, so the tool surface enforces the same rule the owning service would. */
CREATE TABLE IF NOT EXISTS vessels (
  id text PRIMARY KEY, imo text NOT NULL DEFAULT '', name text NOT NULL DEFAULT '', type text NOT NULL DEFAULT '', flag text NOT NULL DEFAULT '',
  built int NOT NULL DEFAULT 0, status text NOT NULL DEFAULT 'ACTIVE', risk_score int, risk_band text NOT NULL DEFAULT '',
  real boolean NOT NULL DEFAULT false, payload jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vessels_name_idx ON vessels(lower(name));
CREATE TABLE IF NOT EXISTS vessel_certificates (
  id text PRIMARY KEY, vessel_id text NOT NULL DEFAULT '', vessel_name text NOT NULL DEFAULT '', cert_type text NOT NULL DEFAULT '',
  expiry_date date, state text NOT NULL DEFAULT 'VALID', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS vessel_certificates_vessel_idx ON vessel_certificates(vessel_id);
CREATE TABLE IF NOT EXISTS port_calls (
  id text PRIMARY KEY, vcn text NOT NULL DEFAULT '', vessel_id text NOT NULL DEFAULT '', vessel_name text NOT NULL DEFAULT '', status text NOT NULL DEFAULT '',
  berth_code text NOT NULL DEFAULT '', agent_name text NOT NULL DEFAULT '', eta timestamptz, atb timestamptz, atd timestamptz,
  cargo jsonb NOT NULL DEFAULT '[]'::jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS port_calls_status_idx ON port_calls(status);
CREATE TABLE IF NOT EXISTS invoices (
  id text PRIMARY KEY, number text NOT NULL DEFAULT '', party text NOT NULL DEFAULT '', vessel_name text NOT NULL DEFAULT '',
  total bigint NOT NULL DEFAULT 0, currency text NOT NULL DEFAULT 'AED', status text NOT NULL DEFAULT '',
  issued_at timestamptz, paid_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invoices_status_idx ON invoices(status);
CREATE TABLE IF NOT EXISTS inspections (
  id text PRIMARY KEY, number text NOT NULL DEFAULT '', vessel_id text NOT NULL DEFAULT '', vessel_name text NOT NULL DEFAULT '',
  type text NOT NULL DEFAULT '', status text NOT NULL DEFAULT '', result text NOT NULL DEFAULT '', detention boolean NOT NULL DEFAULT false,
  open_findings int NOT NULL DEFAULT 0, total_findings int NOT NULL DEFAULT 0, closed_at timestamptz, planned_at timestamptz,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS inspections_vessel_idx ON inspections(vessel_id);
CREATE TABLE IF NOT EXISTS incidents (
  id text PRIMARY KEY, number text NOT NULL DEFAULT '', title text NOT NULL DEFAULT '', type text NOT NULL DEFAULT '',
  severity text NOT NULL DEFAULT '', status text NOT NULL DEFAULT '', vessel_name text NOT NULL DEFAULT '',
  reported_at timestamptz, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS instruments (
  id text PRIMARY KEY, number text NOT NULL DEFAULT '', entity_name text NOT NULL DEFAULT '', entity_type text NOT NULL DEFAULT '',
  subject_kind text NOT NULL DEFAULT '', subject_id text NOT NULL DEFAULT '', status text NOT NULL DEFAULT '',
  issue_date date, expiry_date date, in_force boolean NOT NULL DEFAULT true, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS instruments_number_idx ON instruments(number);
