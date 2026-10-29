#!/bin/bash
# Token Tracker for Codex CLI on a computer (macOS / Linux), one command from the dashboard's "Add device" box:
#   curl -fsSL <raw url of this file> | bash -s -- https://<your-site> <device token>
# Writes the [otel] table that exports Codex's log events to the site (OTLP/HTTP JSON, the device token as a header) into
# ~/.codex/config.toml ($CODEX_HOME if set), between marker lines, so running it again replaces only that block. A config that
# already has an [otel] table of its own is left as it is (TOML allows one): the script says what to add by hand.
# The prompt text stays off (log_user_prompt = false). The token is written to config.toml only, never printed.
# Limits: OTLP carries none, so codex-limits.py is put into ~/.codex/token-tracker and run by Codex after every turn (`notify`, a top-level
# key, in a second marked block at the top of the file); it needs python3. A `notify` of the user's own is left as it is.
set -u
ORIGIN="${1%/}"; TOKEN="${2:-}"
[ -z "$ORIGIN" ] || [ -z "$TOKEN" ] && { echo "Використання: curl -fsSL …/install-codex.sh | bash -s -- https://<сайт> <токен пристрою>"; exit 1; }
DIR="${CODEX_HOME:-$HOME/.codex}"
CONFIG="$DIR/config.toml"
RAW="${TT_RAW:-https://raw.githubusercontent.com/Pavlo577/modToken/main/worker}"
LIMITS="$DIR/token-tracker/codex-limits.py"
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

# the limits: the script, and `notify` unless the config has one of its own
NOTIFY=''
if printf '%s\n' "$REST" | grep -Eq '^[[:space:]]*notify[[:space:]]*='; then
  echo "  У $CONFIG уже є свій notify; ліміти Codex не надсилатимуться (запусти з нього: python3 \"$LIMITS\")"
elif ! command -v python3 >/dev/null; then
  echo "  Немає python3: ліміти Codex не надсилатимуться"
elif mkdir -p "$DIR/token-tracker" && curl -fsSL --max-time 30 "$RAW/scripts/codex-limits.py" -o "$LIMITS"; then
  NOTIFY="notify = ['python3', '$LIMITS']"
  echo "  збирач лімітів встановлено"
else
  echo "  Не вдалося завантажити codex-limits.py: ліміти Codex не надсилатимуться"
fi

# `notify` is a top-level key, so its block goes first; a table goes at the end: keys above it stay at the top level
{
  [ -n "$NOTIFY" ] && printf '%s\n' "$BEGIN" "$NOTIFY" "$END" ''
  [ -n "$REST" ] && printf '%s\n\n' "$REST"
  printf '%s\n' "$BEGIN" '[otel]' 'log_user_prompt = false' \
    "exporter = { otlp-http = { endpoint = \"$ORIGIN/v1/logs\", protocol = \"json\", headers = { \"x-device-token\" = \"$TOKEN\" } } }" "$END"
} > "$CONFIG.tt-new" && mv "$CONFIG.tt-new" "$CONFIG"
chmod 600 "$CONFIG" 2>/dev/null
echo "  OpenTelemetry налаштовано"
echo "Готово. Перезапусти Codex; дані з'являться на дашборді після першого запиту."
