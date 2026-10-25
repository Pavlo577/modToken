-- A log of what Claude Code's statusLine command is given (POST /v1/statusline): the last SHAPE per device (key paths, numbers, flags, ISO times; other strings by length only).
CREATE TABLE IF NOT EXISTS statusline_seen (
  device_id TEXT NOT NULL PRIMARY KEY REFERENCES devices(id) ON DELETE CASCADE,
  n INTEGER NOT NULL,
  keys TEXT NOT NULL,
  sample TEXT NOT NULL,
  last_seen TEXT NOT NULL
);
