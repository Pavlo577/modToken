-- The OTLP-only project has no link codes (a device is made in the dashboard) and no subscription-limit readings (OTLP carries none).
-- DESTRUCTIVE for an existing database: do not apply to the database of the old collector/mod version unless that data is no longer wanted.
DROP TABLE IF EXISTS link_codes;
DROP TABLE IF EXISTS plan_limits;
