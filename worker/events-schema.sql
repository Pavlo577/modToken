-- The events database (binding EVENTS): every event an agent exports, with its harmless attributes, for the statistics.
-- Kept 90 days. Never holds: who the user is, prompt or answer text, anything that is not a number, a flag or an identifier-like word.
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT NOT NULL,
  user_email TEXT NOT NULL,
  dedupe TEXT NOT NULL,
  ts TEXT NOT NULL,
  name TEXT NOT NULL,
  service TEXT NOT NULL,
  session_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  surface TEXT NOT NULL,
  attrs TEXT NOT NULL,
  UNIQUE (device_id, dedupe)
);
CREATE INDEX IF NOT EXISTS events_user_ts_idx ON events (user_email, ts);
CREATE INDEX IF NOT EXISTS events_user_name_ts_idx ON events (user_email, name, ts);
CREATE INDEX IF NOT EXISTS events_session_idx ON events (session_id);
