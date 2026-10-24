-- OTLP diagnostics: the records that were NOT recognised as model calls, counted by service, event name and attribute names (never values).
CREATE TABLE IF NOT EXISTS otlp_seen (
  device_id TEXT NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  service TEXT NOT NULL,
  event TEXT NOT NULL,
  keys TEXT NOT NULL,
  lens TEXT NOT NULL DEFAULT '',
  sample TEXT NOT NULL DEFAULT '',
  n INTEGER NOT NULL,
  last_seen TEXT NOT NULL,
  PRIMARY KEY (device_id, service, event)
);
