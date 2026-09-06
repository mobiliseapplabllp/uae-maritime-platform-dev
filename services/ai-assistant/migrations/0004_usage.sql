-- What the assistant has spent today, against the daily token budget in Settings → AI assistant. Tokens are estimated from
-- the text that went in and came out; the budget is a ceiling on spend, not an accounting of a vendor's invoice.
CREATE TABLE IF NOT EXISTS ai_usage (
  day date PRIMARY KEY,
  tokens bigint NOT NULL DEFAULT 0,
  questions int NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);
