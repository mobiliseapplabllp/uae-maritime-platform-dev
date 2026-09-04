-- Monitoring data is high-volume and short-lived at the raw end, low-volume and long-lived once
-- rolled up. Keeping both in one table would make the monitor the very problem it exists to detect:
-- 23 targets probed every 15s is roughly 130k rows a day.

-- What gets probed. Seeded from the shared service registry on boot, so adding a service to the
-- registry is all it takes to start monitoring it.
CREATE TABLE IF NOT EXISTS targets (
  name        text PRIMARY KEY,
  kind        text NOT NULL CHECK (kind IN ('service','database','broker','sla')),
  category    text,                       -- service kind, or the SLA's domain
  url         text,
  enabled     boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Raw probe results. Retained briefly (OBSERVABILITY_RAW_RETENTION_HOURS, default 48) — long enough
-- to explain an incident that happened overnight, short enough to stay small.
CREATE TABLE IF NOT EXISTS samples (
  id          bigserial PRIMARY KEY,
  target      text NOT NULL REFERENCES targets(name) ON DELETE CASCADE,
  at          timestamptz NOT NULL DEFAULT now(),
  up          boolean NOT NULL,
  latency_ms  integer,
  -- Everything the probe returned: telemetry for a service, sizes for a database, stream state for
  -- the broker, the measured figure for an SLA. Shapes differ per kind, so it is kept as jsonb
  -- rather than forced into columns that would be null for most rows.
  detail      jsonb NOT NULL DEFAULT '{}'::jsonb,
  error       text
);
CREATE INDEX IF NOT EXISTS samples_target_at_idx ON samples (target, at DESC);
CREATE INDEX IF NOT EXISTS samples_at_idx ON samples (at);

-- Rolled-up history, kept long. One row per target per bucket per granularity.
CREATE TABLE IF NOT EXISTS rollups (
  target       text NOT NULL REFERENCES targets(name) ON DELETE CASCADE,
  granularity  text NOT NULL CHECK (granularity IN ('hour','day')),
  bucket       timestamptz NOT NULL,
  samples      integer NOT NULL,
  up_samples   integer NOT NULL,
  latency_p50  integer,
  latency_p95  integer,
  latency_max  integer,
  -- Carried forward so trends survive the raw retention window.
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY (target, granularity, bucket)
);
CREATE INDEX IF NOT EXISTS rollups_bucket_idx ON rollups (granularity, bucket DESC);

-- A target's state changes, so an outage is one row with a real duration rather than something you
-- reconstruct by eye from a chart.
CREATE TABLE IF NOT EXISTS incidents (
  id           bigserial PRIMARY KEY,
  target       text NOT NULL REFERENCES targets(name) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('outage','restart','degraded')),
  started_at   timestamptz NOT NULL,
  ended_at     timestamptz,
  duration_sec integer,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS incidents_open_idx ON incidents (target) WHERE ended_at IS NULL;
CREATE INDEX IF NOT EXISTS incidents_started_idx ON incidents (started_at DESC);

-- Last known state per target, so the live board is one small read rather than a scan of samples.
CREATE TABLE IF NOT EXISTS target_state (
  target        text PRIMARY KEY REFERENCES targets(name) ON DELETE CASCADE,
  up            boolean NOT NULL,
  since         timestamptz NOT NULL,
  last_seen_at  timestamptz,
  last_probe_at timestamptz NOT NULL,
  latency_ms    integer,
  uptime_sec    integer,
  detail        jsonb NOT NULL DEFAULT '{}'::jsonb,
  error         text
);
