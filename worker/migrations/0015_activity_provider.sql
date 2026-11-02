-- Which agent a session and a turn of the activity (POST /v1/activity) belong to: the Claude mod's (claude, all rows so far) or the Codex
-- plugin's (codex). The "Робота з агентом" cards filter by it like the rest of the dashboard.
ALTER TABLE mod_sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE mod_turns ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
-- when each agent last sent from a device (the device list): MAX(ts) per device and provider reads one index entry instead of the device's rows
CREATE INDEX IF NOT EXISTS events_device_provider_ts_idx ON token_events (device_id, provider, ts);
