#!/bin/bash
# Token Tracker for Codex CLI on a computer (macOS / Linux), one command from the dashboard's "Add device" box:
#   curl -fsSL <raw url of this file> | bash -s -- https://<your-site> <device token>
# Writes the [otel] table that exports Codex's log events to the site (OTLP/HTTP JSON, the device token as a header) into
# ~/.codex/config.toml ($CODEX_HOME if set), between marker lines, so running it again replaces only that block. A config that
# already has an [otel] table of its own is left as it is (TOML allows one): the script says what to add by hand.
# The prompt text stays off (log_user_prompt = false). The token is written to config.toml only, never printed.
# Limits: OTLP carries none, so the token-tracker plugin (mods/codex-tracker: a Stop hook that reads them from Codex's session files,
# needs python3) goes into a local marketplace in ~/.codex/token-tracker and is installed with `codex plugin`. Codex runs a plugin's hook
# only after the user approves it once in Codex.
set -u
ORIGIN="${1%/}"; TOKEN="${2:-}"
[ -z "$ORIGIN" ] || [ -z "$TOKEN" ] && { echo "Використання: curl -fsSL …/install-codex.sh | bash -s -- https://<сайт> <токен пристрою>"; exit 1; }
DIR="${CODEX_HOME:-$HOME/.codex}"
CONFIG="$DIR/config.toml"
RAW="${TT_RAW:-https://raw.githubusercontent.com/Pavlo577/modToken/main/worker}"
MARKET="$DIR/token-tracker"; PLUGIN="$MARKET/plugins/token-tracker"
BEGIN='# >>> token-tracker (written by the Token Tracker install command; run it again to update)'
END='# <<< token-tracker'
echo "Token Tracker для Codex: $CONFIG"
mkdir -p "$DIR"; touch "$CONFIG"

# the file without our earlier block
REST=$(awk -v e="$END" 'index($0, "# >>> token-tracker") == 1 { skip = 1; next } $0 == e { skip = 0; next } !skip' "$CONFIG" | sed '/./,$!d')
if printf '%s\n' "$REST" | grep -Eq '^[[:space:]]*\[otel(\]|\.)'; then
  echo "  У $CONFIG уже є своя секція [otel]; її не чіпаю. Додай у неї вручну:"
  echo "    log_user_prompt = false"
  echo "    exporter = { otlp-http = { endpoint = \"$ORIGIN/v1/logs\", protocol = \"json\", headers = { \"x-device-token\" = \"<токен>\" } } }"
  exit 1
fi

# a table goes at the end: keys above it stay at the top level
{
  [ -n "$REST" ] && printf '%s\n\n' "$REST"
  printf '%s\n' "$BEGIN" '[otel]' 'log_user_prompt = false' \
    "exporter = { otlp-http = { endpoint = \"$ORIGIN/v1/logs\", protocol = \"json\", headers = { \"x-device-token\" = \"$TOKEN\" } } }" "$END"
} > "$CONFIG.tt-new" && mv "$CONFIG.tt-new" "$CONFIG"
chmod 600 "$CONFIG" 2>/dev/null
echo "  OpenTelemetry налаштовано"

# the limits: the plugin in a local marketplace, installed when the codex command is there (after the config is written: `codex plugin`
# adds its own entries to it)
mkdir -p "$MARKET/.agents/plugins" "$PLUGIN/.codex-plugin" "$PLUGIN/hooks"
GOT=1
for f in .codex-plugin/plugin.json hooks/hooks.json hooks/limits.py hooks/limits.ps1; do
  curl -fsSL --max-time 30 "$RAW/mods/codex-tracker/$f" -o "$PLUGIN/$f" || GOT=0
done
cat > "$MARKET/.agents/plugins/marketplace.json" <<'JSON'
{ "name": "token-tracker-local", "plugins": [{ "name": "token-tracker", "source": "./plugins/token-tracker" }] }
JSON
if [ "$GOT" = 0 ]; then
  echo "  Не вдалося завантажити плагін: ліміти Codex не надсилатимуться"
elif command -v codex >/dev/null; then
  codex plugin marketplace add "$MARKET" >/dev/null 2>&1
  if codex plugin add token-tracker@token-tracker-local >/dev/null 2>&1; then echo "  плагін лімітів встановлено (у Codex дозволь його хук, коли спитає)"
  else echo "  плагін не вдалося встановити: codex plugin marketplace add \"$MARKET\" && codex plugin add token-tracker@token-tracker-local"; fi
  command -v python3 >/dev/null || echo "  Немає python3: плагін не зможе надсилати ліміти"
else
  echo "  Команди codex не знайдено. Плагін лімітів лежить у $MARKET; встанови його:"
  echo "    codex plugin marketplace add \"$MARKET\" && codex plugin add token-tracker@token-tracker-local"
fi
echo "Готово. Перезапусти Codex; дані з'являться на дашборді після першого запиту."
