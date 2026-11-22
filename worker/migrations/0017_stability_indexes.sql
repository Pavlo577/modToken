-- Account-wide limits & per-session reconcile backfill indexes.
CREATE INDEX IF NOT EXISTS events_device_session_idx ON token_events (device_id, provider, session_id);
CREATE INDEX IF NOT EXISTS events_user_provider_session_idx ON token_events (user_email, provider, session_id);
CREATE INDEX IF NOT EXISTS limits_user_provider_kind_ts_idx ON plan_limits (user_email, provider, kind, ts);
