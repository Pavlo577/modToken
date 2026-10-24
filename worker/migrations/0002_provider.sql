-- Existing databases: which agent wrote each turn / limit reading (the column defaults to 'claude').
-- Run once (a fresh database already has the columns through schema.sql):
--   npx wrangler d1 execute modtoken --remote --file=migrations/0002_provider.sql      (local: --local)
ALTER TABLE token_events ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
ALTER TABLE plan_limits ADD COLUMN provider TEXT NOT NULL DEFAULT 'claude';
CREATE INDEX IF NOT EXISTS events_user_provider_ts_idx ON token_events (user_email, provider, ts);
