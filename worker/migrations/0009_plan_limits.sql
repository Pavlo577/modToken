-- Snapshots of the subscription's rate-limit windows (five_hour, seven_day), sent by the token-tracker mod (POST /v1/limits): OTLP carries none.
-- Only a changed reading is stored. The same table as the older mod version used, so a database that has it keeps its rows.
CREATE TABLE IF NOT EXISTS plan_limits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  ts TEXT NOT NULL,
  kind TEXT NOT NULL,
  percent_used REAL NOT NULL,
  resets_at TEXT,
  provider TEXT NOT NULL DEFAULT 'claude'
);
CREATE INDEX IF NOT EXISTS limits_user_ts_idx ON plan_limits (user_email, ts);
