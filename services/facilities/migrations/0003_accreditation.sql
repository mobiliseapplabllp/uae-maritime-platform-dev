-- Annual accreditation and the inspection visits that feed a company's performance rating.
--
-- An accreditation is granted for a cycle — twelve months under each of the six schemes, though the cycle
-- length is the master's, not this file's — and renewed into the next one. The instrument register issues
-- the accreditation; what is kept here is the cycle it opened: when it started, when it runs out, how many
-- visits it calls for, how many have been paid, and where it stands today. One row per cycle, so the
-- history of a company under a scheme is a line of rows, not a rewritten one.
CREATE TABLE IF NOT EXISTS accreditation_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  company_id text NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  company_name text NOT NULL DEFAULT '',
  category text NOT NULL,
  instrument_id text,
  instrument_no text NOT NULL DEFAULT '',
  cycle_no int NOT NULL DEFAULT 1,
  starts_on date NOT NULL,
  ends_on date NOT NULL,
  status text NOT NULL DEFAULT 'CURRENT',
  status_reason text NOT NULL DEFAULT '',
  visits_required int NOT NULL DEFAULT 1,
  visits_done int NOT NULL DEFAULT 0,
  last_visit_at timestamptz,
  last_visit_result text NOT NULL DEFAULT '',
  next_visit_due date,
  rating numeric(3,1),
  reminders jsonb NOT NULL DEFAULT '[]'::jsonb,
  granted_by_id text,
  granted_by text NOT NULL DEFAULT '',
  scope_company text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS accreditation_cycles_instrument_idx ON accreditation_cycles(instrument_id) WHERE instrument_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS accreditation_cycles_company_idx ON accreditation_cycles(company_id, category, cycle_no DESC);
CREATE INDEX IF NOT EXISTS accreditation_cycles_status_idx ON accreditation_cycles(status, ends_on);
CREATE INDEX IF NOT EXISTS accreditation_cycles_scope_idx ON accreditation_cycles(scope_company);

-- A visit paid to a regulated subject: planned, then completed with a result, a score and findings — or
-- cancelled with a reason. A spot check is a visit created already complete. Completed visits and audits
-- together earn the rating; findings become obligations the subject has to clear.
CREATE TABLE IF NOT EXISTS visits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number text NOT NULL UNIQUE,
  subject_kind text NOT NULL DEFAULT 'COMPANY',
  subject_id text NOT NULL,
  subject_name text NOT NULL DEFAULT '',
  category text NOT NULL DEFAULT '',
  cycle_id uuid REFERENCES accreditation_cycles(id) ON DELETE SET NULL,
  visit_type text NOT NULL,
  status text NOT NULL DEFAULT 'SCHEDULED',
  scheduled_on date,
  visited_on timestamptz,
  inspector_id text,
  inspector text NOT NULL DEFAULT '',
  result text NOT NULL DEFAULT '',
  score numeric(5,1),
  findings jsonb NOT NULL DEFAULT '[]'::jsonb,
  remarks text NOT NULL DEFAULT '',
  report_document_id text,
  cancel_reason text NOT NULL DEFAULT '',
  scope_company text NOT NULL DEFAULT '',
  created_by_id text,
  created_by text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS visits_subject_idx ON visits(subject_kind, subject_id, visited_on DESC, scheduled_on DESC);
CREATE INDEX IF NOT EXISTS visits_status_idx ON visits(status, scheduled_on);
CREATE INDEX IF NOT EXISTS visits_cycle_idx ON visits(cycle_id);
CREATE INDEX IF NOT EXISTS visits_scope_idx ON visits(scope_company);

-- Tenancy: a cycle and a visit belong to the company they concern, the same way an audit does.
CREATE OR REPLACE FUNCTION sync_cycle_scope() RETURNS trigger AS $$
BEGIN
  NEW.scope_company := scope_of_subject('COMPANY', NEW.company_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
DROP TRIGGER IF EXISTS accreditation_cycles_scope ON accreditation_cycles;
CREATE TRIGGER accreditation_cycles_scope BEFORE INSERT OR UPDATE OF company_id ON accreditation_cycles
  FOR EACH ROW EXECUTE FUNCTION sync_cycle_scope();
DROP TRIGGER IF EXISTS visits_scope ON visits;
CREATE TRIGGER visits_scope BEFORE INSERT OR UPDATE OF subject_kind, subject_id ON visits
  FOR EACH ROW EXECUTE FUNCTION sync_subject_scope();
