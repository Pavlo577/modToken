#!/bin/bash
# Token Tracker on a computer (macOS / Linux), one command from the dashboard's "Add device" box:
#   curl -fsSL <raw url of this file> | bash -s -- https://<your-site> <device token>
# 1. OpenTelemetry: the export settings with the device token go into ~/.claude/settings.json (env), as in the box's step 1.
# 2. The token-tracker mod: downloaded to ~/.claude/mods/token-tracker and installed as a plugin from that folder (a local marketplace),
#    so it loads without any environment variable. The old mod and Stop hook of the collector version are removed.
# The token is written to settings.json only, never printed.
set -u
ORIGIN="${1%/}"; TOKEN="${2:-}"
[ -z "$ORIGIN" ] || [ -z "$TOKEN" ] && { echo "Використання: curl -fsSL …/install.sh | bash -s -- https://<сайт> <токен пристрою>"; exit 1; }
DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
RAW="${TT_RAW:-https://raw.githubusercontent.com/Pavlo577/modToken/main/worker}"
MODS="$DIR/mods"; MOD="$MODS/token-tracker"
echo "Token Tracker: встановлення в $DIR"

# 1. the mod's files and a local marketplace that lists it
mkdir -p "$MOD/.claude-plugin" "$MOD/hooks" "$MODS/.claude-plugin"
for f in .claude-plugin/plugin.json hooks/hooks.json hooks/register.ts hooks/history.ts; do
  curl -fsSL --max-time 30 "$RAW/mods/token-tracker/$f" -o "$MOD/$f" || { echo "Не вдалося завантажити $f"; exit 1; }
done
cat > "$MODS/.claude-plugin/marketplace.json" <<'JSON'
{ "name": "token-tracker-local", "owner": { "name": "Token Tracker" }, "plugins": [{ "name": "token-tracker", "source": "./token-tracker", "description": "Token Tracker: limits, sessions, history import" }] }
JSON
echo "  мод завантажено"

# 2. settings.json: the OTLP variables (merged into env), the old Stop hook removed
SETTINGS="$DIR/settings.json"
MERGE='
const fs = require("fs"); const [p, origin, token] = process.argv.slice(1);
let s = {}; try { s = JSON.parse(fs.readFileSync(p, "utf8")) } catch {}
s.env = Object.assign(s.env || {}, { CLAUDE_CODE_ENABLE_TELEMETRY: "1", OTEL_LOGS_EXPORTER: "otlp", OTEL_METRICS_EXPORTER: "none", OTEL_TRACES_EXPORTER: "none",
  OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json", OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: origin + "/v1/logs", OTEL_EXPORTER_OTLP_LOGS_HEADERS: "x-device-token=" + token });
if (s.hooks && Array.isArray(s.hooks.Stop)) {
  s.hooks.Stop = s.hooks.Stop.map(m => ({ ...m, hooks: (m.hooks || []).filter(h => !String(h.command || "").includes("token-tracker/stop-hook")) })).filter(m => m.hooks.length);
  if (!s.hooks.Stop.length) delete s.hooks.Stop
}
fs.writeFileSync(p, JSON.stringify(s, null, 2));'
MERGE_PY='
import json, sys
p, origin, token = sys.argv[1:4]
try: s = json.load(open(p))
except Exception: s = {}
env = s.setdefault("env", {})
env.update({"CLAUDE_CODE_ENABLE_TELEMETRY": "1", "OTEL_LOGS_EXPORTER": "otlp", "OTEL_METRICS_EXPORTER": "none", "OTEL_TRACES_EXPORTER": "none",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL": "http/json", "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT": origin + "/v1/logs", "OTEL_EXPORTER_OTLP_LOGS_HEADERS": "x-device-token=" + token})
stop = (s.get("hooks") or {}).get("Stop")
if isinstance(stop, list):
  stop = [dict(m, hooks=[h for h in m.get("hooks", []) if "token-tracker/stop-hook" not in str(h.get("command", ""))]) for m in stop]
  stop = [m for m in stop if m["hooks"]]
  if stop: s["hooks"]["Stop"] = stop
  else: del s["hooks"]["Stop"]
json.dump(s, open(p, "w"), indent=2)'
mkdir -p "$DIR"
if command -v node >/dev/null; then node -e "$MERGE" "$SETTINGS" "$ORIGIN" "$TOKEN"
elif command -v python3 >/dev/null; then python3 -c "$MERGE_PY" "$SETTINGS" "$ORIGIN" "$TOKEN"
else echo "Немає node чи python3: додай блок із кроку 1 у $SETTINGS вручну"; fi
echo "  OpenTelemetry налаштовано ($SETTINGS)"

# 3. the plugin: the old one out, the local one in
if command -v claude >/dev/null; then
  claude plugin uninstall token-tracker@modtoken >/dev/null 2>&1 && echo "  старий мод (modtoken) видалено"
  claude plugin marketplace add "$MODS" >/dev/null 2>&1 || claude plugin marketplace update token-tracker-local >/dev/null 2>&1
  if claude plugin install token-tracker@token-tracker-local --scope user >/dev/null 2>&1 || claude plugin enable token-tracker@token-tracker-local >/dev/null 2>&1; then echo "  мод увімкнено"
  else echo "  мод не вдалося встановити: запусти claude з --plugin-dir \"$MOD\""; fi
else
  echo "  Команди claude не знайдено: запускай claude з --plugin-dir \"$MOD\""
fi
echo "Готово. Перезапусти Claude Code; стару історію додасть команда /tracker-import."
