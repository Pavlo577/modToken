#!/bin/bash
# Token Tracker for Codex CLI on a computer (macOS / Linux), one command from the dashboard's "Add device" box:
#   curl -fsSL <raw url of this file> | bash -s -- https://<your-site> <device token>
# Writes the [otel] table that exports Codex's log events to the site (OTLP/HTTP JSON, the device token as a header) into
# ~/.codex/config.toml ($CODEX_HOME if set), between marker lines, so running it again replaces only that block. A config that
# already has an [otel] table of its own is left as it is (TOML allows one): the script says what to add by hand.
# The prompt text stays off (log_user_prompt = false). The token is written to config.toml only, never printed.
# Limits & activity: OTLP carries none, so the hook scripts (mods/codex-tracker) are saved into ~/.codex/token-tracker/plugins/token-tracker
# and registered once in ~/.codex/hooks.json (working across Codex CLI, Desktop, and IDE extensions; needs python3).
# Any previously installed token-tracker@token-tracker-local plugin entry in config.toml is disabled automatically to prevent double firing.
set -u
ORIGIN="${1%/}"; TOKEN="${2:-}"
[ -z "$ORIGIN" ] || [ -z "$TOKEN" ] && { echo "Використання: curl -fsSL …/install-codex.sh | bash -s -- https://<сайт> <токен пристрою>"; exit 1; }
DIR="${CODEX_HOME:-$HOME/.codex}"
CONFIG="$DIR/config.toml"
RAW="${TT_RAW:-https://raw.githubusercontent.com/Pavlo577/modToken/main/worker}"
PLUGIN="$DIR/token-tracker/plugins/token-tracker"
BEGIN='# >>> token-tracker (written by the Token Tracker install command; run it again to update)'
END='# <<< token-tracker'
echo "Token Tracker для Codex: $CONFIG"
mkdir -p "$DIR"; touch "$CONFIG"

# the file without our earlier block; also disable legacy plugin duplicate if previously enabled in config.toml
RAW_REST=$(awk -v e="$END" 'index($0, "# >>> token-tracker") == 1 { skip = 1; next } $0 == e { skip = 0; next } !skip' "$CONFIG" | sed '/./,$!d')
if [ -n "$RAW_REST" ]; then
  REST=$(printf '%s\n' "$RAW_REST" | awk '
    /^[[:space:]]*\[plugins\.["\047]token-tracker@token-tracker-local["\047]\][[:space:]]*(#.*)?$/ { in_plug = 1; print; next }
    /^[[:space:]]*\[/ { in_plug = 0; print; next }
    in_plug && /^[[:space:]]*enabled[[:space:]]*=[[:space:]]*true([[:space:]]*(#.*)?)?$/ { sub(/true/, "false"); print; next }
    /^[[:space:]]*plugins\.["\047]token-tracker@token-tracker-local["\047]\.enabled[[:space:]]*=[[:space:]]*true([[:space:]]*(#.*)?)?$/ { sub(/true/, "false"); print; next }
    { print }
  ')
else
  REST=""
fi
DISABLED_OLD=0; [ "$RAW_REST" != "$REST" ] && DISABLED_OLD=1
if printf '%s\n' "$REST" | grep -Eq '^[[:space:]]*\[otel(\]|\.)'; then
  echo "  У $CONFIG уже є своя секція [otel]; її не чіпаю. Додай у неї вручну:"
  echo "    log_user_prompt = false"
  echo "    log_agent_responses = false"
  echo "    log_guardian_assessments = false"
  echo "    log_sse_deltas = false"
  echo "    exporter = { otlp-http = { endpoint = \"$ORIGIN/v1/logs\", protocol = \"json\", headers = { \"x-device-token\" = \"<токен>\" } } }"
  exit 1
fi

# a table goes at the end: keys above it stay at the top level
{
  [ -n "$REST" ] && printf '%s\n\n' "$REST"
  printf '%s\n' "$BEGIN" '[otel]' 'log_user_prompt = false' \
    'log_agent_responses = false' 'log_guardian_assessments = false' 'log_sse_deltas = false' \
    "exporter = { otlp-http = { endpoint = \"$ORIGIN/v1/logs\", protocol = \"json\", headers = { \"x-device-token\" = \"$TOKEN\" } } }" "$END"
} > "$CONFIG.tt-new" && mv "$CONFIG.tt-new" "$CONFIG"
chmod 600 "$CONFIG" 2>/dev/null
echo "  OpenTelemetry налаштовано"
[ "$DISABLED_OLD" = 1 ] && echo "  Старий плагін token-tracker@token-tracker-local вимкнено в $CONFIG, щоб хуки не запускалися двічі"

# hook scripts live in ~/.codex/token-tracker/plugins/token-tracker and are registered once in ~/.codex/hooks.json
mkdir -p "$PLUGIN/.codex-plugin" "$PLUGIN/hooks"
GOT=1
for f in .codex-plugin/plugin.json hooks/hooks.json hooks/limits.py hooks/limits.ps1 hooks/history.py hooks/history.ps1 hooks/activity.py hooks/activity.ps1; do
  curl -fsSL --max-time 30 "$RAW/mods/codex-tracker/$f" -o "$PLUGIN/$f" || GOT=0
done

# Register user-level $CODEX_HOME/hooks.json as the single canonical hook source (works across CLI, Desktop, and IDE)
HOOKS_PY='
import json, os, sys
p, plug = sys.argv[1:3]
try: doc = json.load(open(p, encoding="utf-8"))
except Exception: doc = {}
if not isinstance(doc, dict): doc = {}
hooks = doc.get("hooks") if isinstance(doc.get("hooks"), dict) else {}
cmd = lambda s: f"python3 \"{plug}/hooks/{s}\""
ours = {
  "SessionStart": [{"hooks": [{"type": "command", "command": cmd("history.py"), "timeout": 15}, {"type": "command", "command": cmd("activity.py"), "timeout": 10}]}],
  "Stop": [{"hooks": [{"type": "command", "command": cmd("limits.py"), "timeout": 15}, {"type": "command", "command": cmd("activity.py"), "timeout": 10}]}],
  "UserPromptSubmit": [{"hooks": [{"type": "command", "command": cmd("activity.py"), "timeout": 10}]}],
  "Interrupt": [{"hooks": [{"type": "command", "command": cmd("activity.py"), "timeout": 3}]}],
  "SessionEnd": [{"hooks": [{"type": "command", "command": cmd("activity.py"), "timeout": 3}]}],
}
is_ours = lambda g: isinstance(g, dict) and any("token-tracker" in str(h.get("command", "")) or "token-tracker" in str(h.get("commandWindows", "")) for h in (g.get("hooks") or []) if isinstance(h, dict))
for ev, grp in ours.items():
  cur = [g for g in (hooks.get(ev) if isinstance(hooks.get(ev), list) else []) if not is_ours(g)]
  hooks[ev] = cur + grp
doc["hooks"] = hooks
open(p, "w", encoding="utf-8").write(json.dumps(doc, indent=2) + "\n")
'
HOOKS_JS='
const fs = require("fs"); const [p, plug] = process.argv.slice(1);
let doc = {}; try { doc = JSON.parse(fs.readFileSync(p, "utf8")); } catch {}
if (!doc || typeof doc !== "object" || Array.isArray(doc)) doc = {};
const hooks = doc.hooks && typeof doc.hooks === "object" && !Array.isArray(doc.hooks) ? doc.hooks : {};
const cmd = s => `python3 "${plug}/hooks/${s}"`;
const ours = {
  SessionStart: [{ hooks: [{ type: "command", command: cmd("history.py"), timeout: 15 }, { type: "command", command: cmd("activity.py"), timeout: 10 }] }],
  Stop: [{ hooks: [{ type: "command", command: cmd("limits.py"), timeout: 15 }, { type: "command", command: cmd("activity.py"), timeout: 10 }] }],
  UserPromptSubmit: [{ hooks: [{ type: "command", command: cmd("activity.py"), timeout: 10 }] }],
  Interrupt: [{ hooks: [{ type: "command", command: cmd("activity.py"), timeout: 3 }] }],
  SessionEnd: [{ hooks: [{ type: "command", command: cmd("activity.py"), timeout: 3 }] }],
};
const isOurs = g => g && Array.isArray(g.hooks) && g.hooks.some(h => String(h && (h.command || h.commandWindows) || "").includes("token-tracker"));
for (const [ev, grp] of Object.entries(ours)) {
  const cur = Array.isArray(hooks[ev]) ? hooks[ev].filter(g => !isOurs(g)) : [];
  hooks[ev] = [...cur, ...grp];
}
doc.hooks = hooks;
fs.writeFileSync(p, JSON.stringify(doc, null, 2) + "\n");
'
HOOKS_OK=0
if [ "$GOT" = 1 ]; then
  if command -v python3 >/dev/null; then python3 -c "$HOOKS_PY" "$DIR/hooks.json" "$PLUGIN" && HOOKS_OK=1
  elif command -v node >/dev/null; then node -e "$HOOKS_JS" "$DIR/hooks.json" "$PLUGIN" && HOOKS_OK=1
  fi
fi

if [ "$GOT" = 0 ]; then
  echo "  Не вдалося завантажити скрипти хуків: ліміти Codex не надсилатимуться"
elif [ "$HOOKS_OK" = 1 ]; then
  echo "  Хуки встановлено в $DIR/hooks.json (працюють у Codex CLI, Desktop та IDE)"
  command -v python3 >/dev/null || echo "  Немає python3: хуки не зможуть надсилати ліміти"
else
  echo "  Немає python3/node, щоб оновити $DIR/hooks.json; скрипти збережено в $PLUGIN/hooks"
fi
case "$RAW" in file://*) ;; *) (HOST_NAME=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo ""); [ -n "$HOST_NAME" ] && curl -fsSL --connect-timeout 2 --max-time 3 -H "x-device-token: $TOKEN" -H "user-agent: modToken-codex/1.0" "$ORIGIN/v1/config?agent=codex&host=$HOST_NAME" </dev/null >/dev/null 2>&1) & ;; esac
echo "Готово. Перезапусти Codex і схвали хуки (/hooks або Settings → Hooks → Review hooks); дані з'являться після першого запиту."
