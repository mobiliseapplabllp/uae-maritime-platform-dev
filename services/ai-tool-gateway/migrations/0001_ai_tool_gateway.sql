-- The tool gateway's own record: the tools it exposes, who may call them and how much, and every call and inference it
-- has carried. Nothing here is a copy of another service's data — the gateway holds policy and evidence, not records.

-- A tool: a named, tiered capability that maps onto one call against a platform service.
CREATE TABLE IF NOT EXISTS tools (
  name text PRIMARY KEY,
  module text NOT NULL,
  label text NOT NULL,
  label_ar text NOT NULL DEFAULT '',
  description text NOT NULL DEFAULT '',
  -- READ answers a question; PROPOSE writes a proposal for a person; ACT changes a record; INFER reaches a hosted model
  tier text NOT NULL DEFAULT 'READ' CHECK (tier IN ('READ', 'PROPOSE', 'ACT', 'INFER')),
  -- the permission the data sits behind; the caller's principal must hold it, and the upstream checks it again
  permission text NOT NULL,
  -- who may see it in a catalogue: the assistant, the agents, or both
  exposure text NOT NULL DEFAULT 'BOTH' CHECK (exposure IN ('ASSISTANT', 'AGENT', 'BOTH')),
  upstream jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_schema jsonb NOT NULL DEFAULT '{}'::jsonb,
  triggers text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- A caller: the assistant, one agent, or a service, with what it may call and how often.
CREATE TABLE IF NOT EXISTS callers (
  caller_id text PRIMARY KEY,
  label text NOT NULL,
  kind text NOT NULL DEFAULT 'AGENT' CHECK (kind IN ('ASSISTANT', 'AGENT', 'SERVICE')),
  -- '*' allows every enabled tool up to the ceiling; otherwise the names listed
  allowed_tools text[] NOT NULL DEFAULT '{*}',
  max_tier text NOT NULL DEFAULT 'READ' CHECK (max_tier IN ('READ', 'PROPOSE', 'ACT', 'INFER')),
  hourly_quota int NOT NULL DEFAULT 600,
  daily_quota int NOT NULL DEFAULT 5000,
  enabled boolean NOT NULL DEFAULT true,
  note text NOT NULL DEFAULT '',
  updated_by text NOT NULL DEFAULT '',
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Every tool call, whether it ran, was refused or failed. Arguments are kept redacted and hashed, never raw.
CREATE TABLE IF NOT EXISTS tool_calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  caller_id text NOT NULL,
  principal_id text NOT NULL DEFAULT '',
  principal_name text NOT NULL DEFAULT '',
  principal_kind text NOT NULL DEFAULT 'user',
  tool text NOT NULL,
  tier text NOT NULL,
  module text NOT NULL DEFAULT '',
  args_hash text NOT NULL DEFAULT '',
  args_redacted jsonb NOT NULL DEFAULT '{}'::jsonb,
  outcome text NOT NULL CHECK (outcome IN ('OK', 'REFUSED', 'FAILED', 'DRY_RUN')),
  refusal_code text NOT NULL DEFAULT '',
  reason text NOT NULL DEFAULT '',
  http_status int,
  upstream text NOT NULL DEFAULT '',
  latency_ms int NOT NULL DEFAULT 0,
  redactions int NOT NULL DEFAULT 0,
  cause text NOT NULL DEFAULT '',
  decision_id text
);
CREATE INDEX IF NOT EXISTS tool_calls_at_idx ON tool_calls (at DESC);
CREATE INDEX IF NOT EXISTS tool_calls_caller_at_idx ON tool_calls (caller_id, at DESC);
CREATE INDEX IF NOT EXISTS tool_calls_tool_idx ON tool_calls (tool, at DESC);

-- Every external inference: what left the platform, redacted and fenced, and what came back — fingerprinted, never verbatim.
CREATE TABLE IF NOT EXISTS inferences (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  at timestamptz NOT NULL DEFAULT now(),
  caller_id text NOT NULL,
  principal_id text NOT NULL DEFAULT '',
  principal_name text NOT NULL DEFAULT '',
  purpose text NOT NULL DEFAULT 'answer',
  provider text NOT NULL,
  profile text NOT NULL DEFAULT '',
  residency text NOT NULL DEFAULT '',
  prompt_fingerprint text NOT NULL,
  prompt_chars int NOT NULL DEFAULT 0,
  grounding_blocks int NOT NULL DEFAULT 0,
  redactions int NOT NULL DEFAULT 0,
  redaction_kinds jsonb NOT NULL DEFAULT '{}'::jsonb,
  injection_score numeric(4,3) NOT NULL DEFAULT 0,
  injection_flags text[] NOT NULL DEFAULT '{}',
  outcome text NOT NULL CHECK (outcome IN ('OK', 'REFUSED', 'FAILED', 'LOCAL')),
  reason text NOT NULL DEFAULT '',
  latency_ms int NOT NULL DEFAULT 0,
  tokens_in int NOT NULL DEFAULT 0,
  tokens_out int NOT NULL DEFAULT 0,
  reply_chars int NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS inferences_at_idx ON inferences (at DESC);
CREATE INDEX IF NOT EXISTS inferences_caller_idx ON inferences (caller_id, at DESC);
