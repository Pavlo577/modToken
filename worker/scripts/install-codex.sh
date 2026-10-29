#!/bin/bash
# Token Tracker for Codex CLI on a computer (macOS / Linux), one command from the dashboard's "Add device" box:
#   curl -fsSL <raw url of this file> | bash -s -- https://<your-site> <device token>
# Writes the [otel] table that exports Codex's log events to the site (OTLP/HTTP JSON, the device token as a header) into
# ~/.codex/config.toml ($CODEX_HOME if set), between marker lines, so running it again replaces only that block. A config that
# already has an [otel] table of its own is left as it is (TOML allows one): the script says what to add by hand.
# The prompt text stays off (log_user_prompt = false). The token is written to config.toml only, never printed.
set -u
ORIGIN="${1%/}"; TOKEN="${2:-}"
[ -z "$ORIGIN" ] || [ -z "$TOKEN" ] && { echo "Використання: curl -fsSL …/install-codex.sh | bash -s -- https://<сайт> <токен пристрою>"; exit 1; }
DIR="${CODEX_HOME:-$HOME/.codex}"
CONFIG="$DIR/config.toml"
BEGIN='# >>> token-tracker (written by the Token Tracker install command; run it again to update)'
END='# <<< token-tracker'
echo "Token Tracker для Codex: $CONFIG"
mkdir -p "$DIR"; touch "$CONFIG"

# the file without our earlier block
REST=$(awk -v e="$END" 'index($0, "# >>> token-tracker") == 1 { skip = 1; next } $0 == e { skip = 0; next } !skip' "$CONFIG")
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
echo "Готово. Перезапусти Codex; дані з'являться на дашборді після першого запиту."
