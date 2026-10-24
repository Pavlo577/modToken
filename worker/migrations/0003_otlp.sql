-- Existing databases: the table the OTLP receiver (POST /v1/logs) remembers counted model calls in.
-- Run once (a fresh database already has it through schema.sql):
--   npx wrangler d1 execute modtoken --remote --file=migrations/0003_otlp.sql      (local: --local)
CREATE TABLE IF NOT EXISTS otlp_calls (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (device_id, call_id)
);
CREATE INDEX IF NOT EXISTS otlp_calls_seen_idx ON otlp_calls (seen_at);
