CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  name TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  revoked INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_seen TEXT,
  otlp_since TEXT, -- first OTLP call; tokens before it come from elsewhere and may be incomplete
  project_mode TEXT NOT NULL DEFAULT 'off' -- off | name | hash: what the mod may send about the session's repository
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
  -- main: the prompt's own calls (one row per prompt, counted as a turn); sub: a sub-agent's; bg: background requests (one row per prompt, kind and model)
  kind TEXT NOT NULL DEFAULT 'main',
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

-- What the token-tracker mod measures beyond the limits (POST /v1/activity); see migrations/0011_mod_activity.sql.
CREATE TABLE IF NOT EXISTS mod_sessions (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  project TEXT,
  project_note TEXT, -- why there is no project, when there is none: off, no_repo, config_failed ...
  PRIMARY KEY (device_id, session_id)
);
CREATE INDEX IF NOT EXISTS mod_sessions_user_idx ON mod_sessions (user_email, started_at);
CREATE TABLE IF NOT EXISTS mod_turns (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  session_id TEXT NOT NULL,
  turn_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  wall_ms INTEGER NOT NULL,
  think_ms INTEGER,
  outcome TEXT NOT NULL,
  context_pct REAL,
  context_tokens INTEGER,
  context_window INTEGER,
  perm_asks INTEGER NOT NULL DEFAULT 0,
  perm_denied INTEGER NOT NULL DEFAULT 0,
  perm_wait_ms INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, turn_id)
);
CREATE INDEX IF NOT EXISTS mod_turns_user_idx ON mod_turns (user_email, ts);

-- Diagnostics: see migrations/0012_check_turns.sql.
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
