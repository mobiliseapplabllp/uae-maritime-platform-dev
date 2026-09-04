-- Every external system the platform talks to is an adapter here, and every call it makes is a row.
-- The point is that an integration cannot fail silently: a call that never returned, a payload that
-- was retried, or a counterpart that went away all leave evidence a duty officer can read.

CREATE TABLE IF NOT EXISTS adapters (
  key           text PRIMARY KEY,
  name          text NOT NULL,
  name_ar       text,
  counterpart   text NOT NULL,              -- the organisation on the other end
  -- 'stub' answers from a recorded fixture; 'live' calls the counterpart. Live connection dates are
  -- the client's to grant, so the switch is per adapter and the build never waits on one.
  mode          text NOT NULL DEFAULT 'stub' CHECK (mode IN ('stub','live')),
  base_url      text,
  enabled       boolean NOT NULL DEFAULT true,
  -- The contract this adapter is certified against; a certification pack references it.
  contract_ver  text NOT NULL DEFAULT '1.0.0',
  timeout_ms    integer NOT NULL DEFAULT 8000,
  max_attempts  integer NOT NULL DEFAULT 3,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- One row per call attempt sequence, keyed by the caller's idempotency key where it supplied one.
CREATE TABLE IF NOT EXISTS calls (
  id              bigserial PRIMARY KEY,
  adapter         text NOT NULL REFERENCES adapters(key) ON DELETE CASCADE,
  operation       text NOT NULL,
  -- A caller that repeats a call with the same key gets the first result back rather than a second
  -- call to the counterpart. This is what makes a retry safe across a service restart.
  idempotency_key text,
  request         jsonb NOT NULL DEFAULT '{}'::jsonb,
  response        jsonb,
  status          text NOT NULL CHECK (status IN ('pending','ok','failed','dead')),
  http_status     integer,
  attempts        integer NOT NULL DEFAULT 0,
  duration_ms     integer,
  mode            text NOT NULL,
  error           text,
  correlation_id  text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS calls_idem_idx ON calls (adapter, operation, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS calls_adapter_started_idx ON calls (adapter, started_at DESC);
CREATE INDEX IF NOT EXISTS calls_status_idx ON calls (status) WHERE status IN ('failed','dead');

-- A call that exhausted its attempts. Kept separate from `calls` so the queue an operator works
-- through is a small table, not a scan of every call the platform has ever made.
CREATE TABLE IF NOT EXISTS dead_letters (
  id           bigserial PRIMARY KEY,
  call_id      bigint NOT NULL REFERENCES calls(id) ON DELETE CASCADE,
  adapter      text NOT NULL REFERENCES adapters(key) ON DELETE CASCADE,
  operation    text NOT NULL,
  request      jsonb NOT NULL,
  error        text,
  attempts     integer NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  replayed_at  timestamptz,
  replayed_by  text
);
CREATE INDEX IF NOT EXISTS dead_open_idx ON dead_letters (adapter) WHERE replayed_at IS NULL;

-- The certification pack: evidence that an adapter was exercised against a recorded contract.
-- This is what is handed over when a counterpart asks how their interface was verified.
CREATE TABLE IF NOT EXISTS certifications (
  id           bigserial PRIMARY KEY,
  adapter      text NOT NULL REFERENCES adapters(key) ON DELETE CASCADE,
  contract_ver text NOT NULL,
  operations   integer NOT NULL,
  passed       integer NOT NULL,
  evidence     jsonb NOT NULL DEFAULT '{}'::jsonb,
  certified_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS cert_adapter_idx ON certifications (adapter, certified_at DESC);
