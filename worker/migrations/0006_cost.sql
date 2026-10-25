-- The agent's own price estimate of a turn (millionths of a dollar); 0 = unknown.
ALTER TABLE token_events ADD COLUMN cost_micros INTEGER NOT NULL DEFAULT 0;
