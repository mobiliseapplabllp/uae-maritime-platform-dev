-- Access controls: a second factor on the account, session families with idle tracking, privileged grants held for a
-- second administrator, access review cycles, and dormancy.
ALTER TABLE roles ADD COLUMN IF NOT EXISTS mfa_required boolean NOT NULL DEFAULT true;

ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_secret text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_pending_secret text;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_enrolled_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_last_step bigint;
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_recovery text[] NOT NULL DEFAULT '{}';
ALTER TABLE users ADD COLUMN IF NOT EXISTS mfa_due_at timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS dormant_since timestamptz;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deactivated_reason text NOT NULL DEFAULT '';

ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS family uuid;
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS user_agent text NOT NULL DEFAULT '';
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS ip text NOT NULL DEFAULT '';
ALTER TABLE refresh_tokens ADD COLUMN IF NOT EXISTS last_used_at timestamptz NOT NULL DEFAULT now();
UPDATE refresh_tokens SET family = id WHERE family IS NULL;
CREATE INDEX IF NOT EXISTS refresh_tokens_family_idx ON refresh_tokens(family);

-- A privileged grant waits here for a second administrator.
CREATE TABLE IF NOT EXISTS change_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind text NOT NULL CHECK (kind IN ('USER_CREATE', 'USER_ROLE', 'USER_ACTIVATE', 'ROLE_MATRIX')),
  subject_id uuid NOT NULL,
  subject_label text NOT NULL DEFAULT '',
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text NOT NULL DEFAULT '',
  requested_by_id uuid,
  requested_by text NOT NULL DEFAULT '',
  requested_at timestamptz NOT NULL DEFAULT now(),
  status text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  decided_by_id uuid,
  decided_by text NOT NULL DEFAULT '',
  decided_at timestamptz,
  decision_note text NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS change_requests_status_idx ON change_requests(status, requested_at DESC);
CREATE INDEX IF NOT EXISTS change_requests_subject_idx ON change_requests(subject_id);

-- Who still holds what: opened on a cadence, every active account attested by a second person.
CREATE TABLE IF NOT EXISTS access_review_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  opened_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  closed_at timestamptz,
  opened_by text NOT NULL DEFAULT '',
  closed_by text NOT NULL DEFAULT '',
  total int NOT NULL DEFAULT 0,
  note text NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS access_review_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_id uuid NOT NULL REFERENCES access_review_cycles(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  user_name text NOT NULL DEFAULT '',
  user_email text NOT NULL DEFAULT '',
  role_name text NOT NULL DEFAULT '',
  scope jsonb NOT NULL DEFAULT '{"level":"NATIONAL"}'::jsonb,
  last_login_at timestamptz,
  dormant boolean NOT NULL DEFAULT false,
  privileged boolean NOT NULL DEFAULT false,
  decision text NOT NULL DEFAULT 'PENDING' CHECK (decision IN ('PENDING', 'CONFIRMED', 'REVOKED')),
  decided_by_id uuid,
  decided_by text NOT NULL DEFAULT '',
  decided_at timestamptz,
  note text NOT NULL DEFAULT '',
  UNIQUE (cycle_id, user_id)
);
CREATE INDEX IF NOT EXISTS access_review_items_cycle_idx ON access_review_items(cycle_id, decision);
