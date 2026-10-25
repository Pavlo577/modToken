#!/bin/bash
# Token Tracker: switch on Claude Code's own OTLP export in a cloud session (claude.ai/code).
# Paste into "Setup script":  curl -fsSL <raw url of this file> | bash -s -- https://<your-worker-host>
# Needs the environment variable TRACKER_TOKEN (a device token from the dashboard). The token is never printed.
# The variables are the same as the dashboard's "Add device" box (web/lib/setup.ts): keep them in sync.
ORIGIN="${1%/}"
[ -z "$ORIGIN" ] && { echo "Token Tracker: no origin given, OTLP export stays off"; exit 0; }
[ -z "$TRACKER_TOKEN" ] && { echo "Token Tracker: TRACKER_TOKEN is not set, OTLP export stays off"; exit 0; }
mkdir -p "$HOME/.claude"
# The statusLine probe (scripts/statusline-probe.mjs): it POSTs the shape of statusLine's input to <origin>/v1/statusline. Skipped if the download fails.
PROBE_URL="${TT_PROBE_URL:-https://raw.githubusercontent.com/Pavlo577/modToken/claudesolo/worker/scripts/statusline-probe.mjs}"
PROBE="$HOME/.claude/statusline-probe.mjs"
curl -fsSL --max-time 20 "$PROBE_URL" -o "$PROBE" 2>/dev/null || { rm -f "$PROBE"; echo "Token Tracker: statusLine probe not downloaded, statusLine stays off"; }
TT_ORIGIN="$ORIGIN" TT_PROBE="$PROBE" node -e '
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
  TRACKER_ORIGIN: process.env.TT_ORIGIN, // read by the statusLine probe (the token is the container variable TRACKER_TOKEN)
});
if (fs.existsSync(process.env.TT_PROBE) && !s.statusLine) s.statusLine = { type: "command", command: "node " + process.env.TT_PROBE };
fs.writeFileSync(p, JSON.stringify(s, null, 2));
' && echo "Token Tracker: OTLP export configured for $ORIGIN"
exit 0
