CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  key text NOT NULL UNIQUE,
  name text NOT NULL,
  name_ar text,
  cron text NOT NULL,
  timezone text NOT NULL DEFAULT 'Asia/Dubai',
  event_type text NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  enabled boolean NOT NULL DEFAULT true,
  next_run_at timestamptz,
  last_run_at timestamptz,
  last_status text,
  last_error text,
  runs int NOT NULL DEFAULT 0,
  owner text NOT NULL DEFAULT 'platform',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS jobs_due_idx ON jobs(next_run_at) WHERE enabled;
CREATE TABLE IF NOT EXISTS job_runs (
  id bigserial PRIMARY KEY,
  job_key text NOT NULL REFERENCES jobs(key) ON DELETE CASCADE ON UPDATE CASCADE,
  scheduled_for timestamptz,
  fired_at timestamptz NOT NULL DEFAULT now(),
  trigger text NOT NULL DEFAULT 'SCHEDULE',
  status text NOT NULL,
  event_id uuid,
  event_type text NOT NULL,
  error text,
  triggered_by jsonb
);
CREATE INDEX IF NOT EXISTS job_runs_job_idx ON job_runs(job_key, fired_at DESC);
