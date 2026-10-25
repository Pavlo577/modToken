-- Diagnostics: the token counts of each turn as the otlp-check mod sees them (POST /v1/check), to compare with what OTLP counted (token_events).
-- Never added to token_events: these numbers are only compared, never counted. Drop the table when the comparison is done.
CREATE TABLE IF NOT EXISTS check_turns (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  is_subagent INTEGER NOT NULL,
  PRIMARY KEY (device_id, turn_id)
);
CREATE INDEX IF NOT EXISTS check_turns_user_idx ON check_turns (user_email, ts);
