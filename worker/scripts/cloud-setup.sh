#!/bin/bash
# Token Tracker: switch on Claude Code's own OTLP export in a cloud session (claude.ai/code).
# Paste into "Setup script":  curl -fsSL <raw url of this file> | bash -s -- https://<your-worker-host>
# Needs the environment variable TRACKER_TOKEN (a device token from the dashboard). The token is never printed.
# The variables are the same as the dashboard's "Add device" box (web/lib/setup.ts): keep them in sync.
ORIGIN="${1%/}"
[ -z "$ORIGIN" ] && { echo "Token Tracker: no origin given, OTLP export stays off"; exit 0; }
[ -z "$TRACKER_TOKEN" ] && { echo "Token Tracker: TRACKER_TOKEN is not set, OTLP export stays off"; exit 0; }
mkdir -p "$HOME/.claude"
TT_ORIGIN="$ORIGIN" node -e '
const fs = require("fs");
const p = process.env.HOME + "/.claude/settings.json";
let s = {};
try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
s.env = Object.assign(s.env || {}, {
  CLAUDE_CODE_ENABLE_TELEMETRY: "1",
  OTEL_LOGS_EXPORTER: "otlp",
  OTEL_METRICS_EXPORTER: "none",
  OTEL_TRACES_EXPORTER: "none",
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
  OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: process.env.TT_ORIGIN + "/v1/logs",
  OTEL_EXPORTER_OTLP_LOGS_HEADERS: "x-device-token=" + process.env.TRACKER_TOKEN,
});
fs.writeFileSync(p, JSON.stringify(s, null, 2));
' && echo "Token Tracker: OTLP export configured for $ORIGIN"
exit 0
