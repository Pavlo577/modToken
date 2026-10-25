-- What the token-tracker mod measures beyond the limits (POST /v1/activity): sessions (start, end, why it ended, the project if the device allows it)
-- and main-loop turns (wall-clock length, the pause before it, context fill, permission prompts). Numbers only; the project is a repository name
-- or a hash, and only when the device's project_mode says so.
ALTER TABLE devices ADD COLUMN project_mode TEXT NOT NULL DEFAULT 'off'; -- off | name | hash: what the mod may send about the session's repository
CREATE TABLE IF NOT EXISTS mod_sessions (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  user_email TEXT NOT NULL,
  session_id TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  end_reason TEXT,
  project TEXT,
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
