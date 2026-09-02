CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  name text NOT NULL,
  doc_type text NOT NULL DEFAULT 'OTHER',
  mime text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  version int NOT NULL DEFAULT 1,
  uploaded_by jsonb NOT NULL DEFAULT '{}'::jsonb,
  audience_perm text NOT NULL,
  virus_status text NOT NULL DEFAULT 'PENDING',
  scan_detail text,
  retention_until timestamptz,
  legal_hold boolean NOT NULL DEFAULT false,
  legal_hold_reason text,
  note text NOT NULL DEFAULT '',
  scope jsonb NOT NULL DEFAULT '{"level":"NATIONAL"}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  CONSTRAINT documents_virus_status_chk CHECK (virus_status IN ('PENDING', 'CLEAN', 'INFECTED', 'SKIPPED'))
);
CREATE INDEX IF NOT EXISTS documents_entity_idx ON documents(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS documents_created_idx ON documents(created_at DESC);
CREATE INDEX IF NOT EXISTS documents_sha256_idx ON documents(sha256);
CREATE INDEX IF NOT EXISTS documents_retention_idx ON documents(retention_until) WHERE retention_until IS NOT NULL AND legal_hold = false;
CREATE TABLE IF NOT EXISTS document_versions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version int NOT NULL,
  name text NOT NULL,
  mime text NOT NULL,
  size_bytes bigint NOT NULL,
  sha256 text NOT NULL,
  storage_key text NOT NULL,
  uploaded_by jsonb NOT NULL DEFAULT '{}'::jsonb,
  note text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);
CREATE TABLE IF NOT EXISTS document_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  entity_type text NOT NULL,
  entity_id text NOT NULL,
  relation text NOT NULL DEFAULT 'RELATED',
  created_by jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, entity_type, entity_id)
);
CREATE INDEX IF NOT EXISTS document_links_entity_idx ON document_links(entity_type, entity_id);
