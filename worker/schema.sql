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

CREATE TABLE IF NOT EXISTS link_codes (
  code_hash TEXT PRIMARY KEY,
  user_email TEXT NOT NULL,
  device_name TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);

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
  -- which agent wrote the turn: claude, codex, gemini ... (see PROVIDERS in src/events.ts)
  provider TEXT NOT NULL DEFAULT 'claude',
  UNIQUE (device_id, turn_id)
);
CREATE INDEX IF NOT EXISTS events_user_ts_idx ON token_events (user_email, ts);
CREATE INDEX IF NOT EXISTS events_user_provider_ts_idx ON token_events (user_email, provider, ts);

-- Snapshots of the subscription's rate-limit windows (five_hour, seven_day), sent by the mod (Claude) or the
-- Codex collector on devices signed in with a subscription. Only a changed reading is stored.
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
