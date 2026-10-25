CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen TEXT
);
CREATE INDEX IF NOT EXISTS devices_user_idx ON devices (user_email);

-- One row per turn (a prompt and the model calls it caused), made of the OTLP model calls of the device.
CREATE TABLE IF NOT EXISTS token_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  is_subagent INTEGER NOT NULL DEFAULT 0,
  -- which agent made the call: claude, and later codex, gemini ... (one OTLP adapter each, src/otlp.ts)
  provider TEXT NOT NULL DEFAULT 'claude',
  -- the agent's own price estimate of the turn in millionths of a dollar (Claude Code: cost_usd_micros); 0 = unknown, the page then prices the tokens itself
  cost_micros INTEGER NOT NULL DEFAULT 0,
  UNIQUE (device_id, turn_id)
);
CREATE INDEX IF NOT EXISTS events_user_ts_idx ON token_events (user_email, ts);
CREATE INDEX IF NOT EXISTS events_user_provider_ts_idx ON token_events (user_email, provider, ts);

-- OTLP: the model calls already counted (so a call sent twice is not added twice). Old rows are dropped after 14 days.
CREATE TABLE IF NOT EXISTS otlp_calls (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  call_id TEXT NOT NULL,
  seen_at TEXT NOT NULL,
  PRIMARY KEY (device_id, call_id)
);
CREATE INDEX IF NOT EXISTS otlp_calls_seen_idx ON otlp_calls (seen_at);

-- OTLP diagnostics: the records that were NOT recognised as model calls, counted by service, event name and attribute names (never values).
CREATE TABLE IF NOT EXISTS otlp_seen (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  event TEXT NOT NULL,
  keys TEXT NOT NULL,
  lens TEXT NOT NULL DEFAULT '',
  sample TEXT NOT NULL DEFAULT '',
  n INTEGER NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (device_id, service, event)
);
