-- Module dashboards: the service desk's applications join the read models, and an invoice carries its due date and what
-- has been paid on it, so the Command Centre can say what is owed and what is overdue without asking the ledger.
CREATE TABLE IF NOT EXISTS rm_service_requests (
  id uuid PRIMARY KEY,
  number text NOT NULL, definition_key text NOT NULL DEFAULT '', definition_name text NOT NULL DEFAULT '', category text, subject_kind text, subject_name text,
  applicant_org text, applicant_org_code text, status text NOT NULL, current_state text,
  sla_due_at timestamptz, sla_breached boolean NOT NULL DEFAULT false, submitted_at timestamptz, decided_at timestamptz, closed_at timestamptz,
  fees_total numeric, payment_status text, created_at timestamptz,
  scope_company text NOT NULL DEFAULT '', updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS rm_service_requests_status_idx ON rm_service_requests (status, submitted_at);
ALTER TABLE rm_invoices ADD COLUMN IF NOT EXISTS due_at timestamptz;
ALTER TABLE rm_invoices ADD COLUMN IF NOT EXISTS paid_amount numeric NOT NULL DEFAULT 0;
