-- An invoice offered for online payment carries the gateway's intent: its reference, where the payer was sent, and
-- what the gateway last said about it. Settlement arrives by callback or by asking; either way it lands here first.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_intent jsonb;
