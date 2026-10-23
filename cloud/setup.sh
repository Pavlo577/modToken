#!/usr/bin/env bash
# Setup script line for a Claude Code cloud environment (claude.ai/code → environment → Setup script):
#   curl -fsSL https://raw.githubusercontent.com/Pavlo577/modToken/main/cloud/setup.sh | bash -s -- https://your-site
# Installs the token-tracker Stop hook for every session in that environment. Safe to run again.
set -u
SITE="${1:-}"
[ -n "$SITE" ] || { echo "token-tracker: usage: setup.sh https://your-site" >&2; exit 0; }
RAW="https://raw.githubusercontent.com/Pavlo577/modToken/main"
DIR="$HOME/.claude/token-tracker"
mkdir -p "$DIR"

curl -fsSL "$RAW/cloud/stop-hook.mjs" -o "$DIR/stop-hook.mjs" \
  && curl -fsSL "$RAW/worker/public/admin/parse.mjs" -o "$DIR/parse.mjs" \
  || { echo "token-tracker: could not download the hook (is raw.githubusercontent.com allowed?)" >&2; exit 0; }
printf '%s\n' "${SITE%/}" > "$DIR/url"

# Add the Stop hook to ~/.claude/settings.json, keeping whatever is already there.
node - "$HOME/.claude/settings.json" <<'JS' || echo "token-tracker: could not write settings.json" >&2
const fs = require('fs')
const file = process.argv[2]
let s = {}
try { s = JSON.parse(fs.readFileSync(file, 'utf8')) } catch {}
const command = 'node "$HOME/.claude/token-tracker/stop-hook.mjs"'
s.hooks ??= {}
s.hooks.Stop ??= []
if (!JSON.stringify(s.hooks.Stop).includes('token-tracker/stop-hook.mjs')) {
  s.hooks.Stop.push({ matcher: '', hooks: [{ type: 'command', command }] })
}
fs.mkdirSync(require('path').dirname(file), { recursive: true })
fs.writeFileSync(file, JSON.stringify(s, null, 2))
JS
echo "token-tracker: installed for $SITE"
exit 0
