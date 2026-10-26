-- The otlp-check diagnostics (POST /v1/check, table check_turns, migration 0012, removed) are done: the mod and OTLP agreed token for token,
-- the difference being OTLP's background requests. It only ever existed on the preview database; elsewhere this does nothing.
DROP TABLE IF EXISTS check_turns;
