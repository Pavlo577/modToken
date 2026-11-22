-- Pre-aggregated hourly UTC buckets and Worker metadata (auto-refreshed prices).
CREATE TABLE IF NOT EXISTS hourly_buckets (
  user_email TEXT NOT NULL,
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  h TEXT NOT NULL,
  model TEXT NOT NULL,
  provider TEXT NOT NULL DEFAULT 'claude',
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens INTEGER NOT NULL DEFAULT 0,
  cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  turns INTEGER NOT NULL DEFAULT 0,
  bg_output INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  sub INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (device_id, h, model, provider)
);
CREATE INDEX IF NOT EXISTS hourly_buckets_user_h_idx ON hourly_buckets (user_email, h);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

INSERT OR REPLACE INTO hourly_buckets
  (user_email, device_id, h, model, provider, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, duration_ms, turns, bg_output, cost_micros, sub)
SELECT user_email, device_id, substr(ts, 1, 13), model, provider,
       SUM(input_tokens), SUM(output_tokens), SUM(cache_read_tokens), SUM(cache_creation_tokens), SUM(duration_ms),
       SUM(CASE WHEN kind = 'main' THEN 1 ELSE 0 END),
       SUM(CASE WHEN kind = 'bg' THEN output_tokens ELSE 0 END),
       CASE WHEN MIN(cost_micros) > 0 THEN SUM(cost_micros) ELSE 0 END,
       SUM(is_subagent)
FROM token_events
GROUP BY user_email, device_id, substr(ts, 1, 13), model, provider;
