#!/bin/bash
# Token Tracker, cloud session (claude.ai/code): installs the statusLine probe. Nothing secret here.
# Paste into "Setup script":  curl -fsSL <raw url of this file> | bash -s -- https://<your-worker-host>
# A setup script cannot read the environment's saved variables, so the OTLP settings and the token go into "Environment variables"
# instead (the dashboard's "Add device" box, step 3): Claude Code and the statusLine command see them while the session runs.
# Every step is written to ~/.claude/token-tracker-setup.log, so a new session can tell why something is missing.
mkdir -p "$HOME/.claude"
LOG="$HOME/.claude/token-tracker-setup.log"
say() { echo "Token Tracker: $*"; echo "$(date -u +%FT%TZ) $*" >> "$LOG"; }
say "start: user=$(id -un) home=$HOME"
ORIGIN="${1%/}"
[ -z "$ORIGIN" ] && { say "no origin given, statusLine stays off"; exit 0; }
# The probe (scripts/statusline-probe.mjs) POSTs the shape of statusLine's input to $TRACKER_ORIGIN/v1/statusline with $TRACKER_TOKEN.
PROBE_URL="${TT_PROBE_URL:-https://raw.githubusercontent.com/Pavlo577/modToken/claudesolo/worker/scripts/statusline-probe.mjs}"
PROBE="$HOME/.claude/statusline-probe.mjs"
curl -fsSL --max-time 20 "$PROBE_URL" -o "$PROBE" 2>/dev/null || { rm -f "$PROBE"; say "statusLine probe not downloaded, statusLine stays off"; exit 0; }
say "statusLine probe downloaded"
TT_ORIGIN="$ORIGIN" TT_PROBE="$PROBE" node -e '
const fs = require("fs");
const p = process.env.HOME + "/.claude/settings.json";
let s = {};
try { s = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
s.env = Object.assign(s.env || {}, { TRACKER_ORIGIN: process.env.TT_ORIGIN });
if (!s.statusLine) s.statusLine = { type: "command", command: "node " + process.env.TT_PROBE };
fs.writeFileSync(p, JSON.stringify(s, null, 2));
' && say "settings.json written: statusLine $(grep -q '"statusLine"' "$HOME/.claude/settings.json" && echo set || echo not set), origin $ORIGIN" || say "settings.json NOT written"
exit 0
