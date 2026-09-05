-- Phase 3, Smart Inspection: every dated fact the inspection service publishes about a survey — planned, boarded,
-- closed, dossier prepared, report drafted and issued, notice drafted and issued, restriction recommended, routed
-- and decided, prediction recorded and scored — projected as it arrives, so the six programme KPIs are measured
-- here from the events themselves, with the same evaluator the survey desk uses.
CREATE TABLE IF NOT EXISTS rm_inspection_timeline (
  id bigserial PRIMARY KEY,
  event_id text NOT NULL UNIQUE,
  inspection_id text NOT NULL, number text NOT NULL DEFAULT '', kind text NOT NULL, at timestamptz NOT NULL, source text NOT NULL DEFAULT '',
  meta jsonb NOT NULL DEFAULT '{}'::jsonb, scope_port text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rm_inspection_timeline_kind_idx ON rm_inspection_timeline (kind, at);
CREATE INDEX IF NOT EXISTS rm_inspection_timeline_inspection_idx ON rm_inspection_timeline (inspection_id);
CREATE INDEX IF NOT EXISTS rm_inspection_timeline_scope_idx ON rm_inspection_timeline (scope_port);
