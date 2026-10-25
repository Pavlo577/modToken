-- The OTLP project has no link codes (a device is made in the dashboard).
-- DESTRUCTIVE for an existing database: do not apply to the database of the old collector/mod version unless that data is no longer wanted.
-- plan_limits is kept: the token-tracker mod still sends the subscription's limits (POST /v1/limits, migration 0009).
DROP TABLE IF EXISTS link_codes;
