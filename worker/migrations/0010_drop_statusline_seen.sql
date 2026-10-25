-- The statusLine log (POST /v1/statusline, table statusline_seen) is gone: statusLine is not called in a cloud session, the limits come from the mod.
-- It only ever existed on the preview database; on any other database this does nothing.
DROP TABLE IF EXISTS statusline_seen;
