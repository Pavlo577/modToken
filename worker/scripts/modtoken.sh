#!/bin/bash
# Token Tracker CLI (modtoken) for Linux / macOS:
# Interactive and command-line manager that auto-detects installed AI agents (Claude Code, Codex, Antigravity),
# reuses any existing device token already configured on the computer, installs or updates all plugins/hooks/OTLP
# settings in one step, and runs diagnostics (doctor).
#
# Usage:
#   modtoken                              # interactive console menu
#   modtoken status                       # show detected agents, versions, and OTLP/hook status
#   modtoken update                       # update modtoken + all configured agents on this computer
#   modtoken doctor                       # full diagnostics (server reachability, token, versions, hooks, last-error)
#   modtoken install [all|claude|codex|antigravity] [https://site] [token]
#   modtoken token <https://site> <token> # save or switch site & device token
set -u

RAW="${TT_RAW:-https://raw.githubusercontent.com/Pavlo577/modToken/main/worker}"
MT_DIR="${MODTOKEN_HOME:-$HOME/.modtoken}"
MT_CFG="$MT_DIR/config.json"
BIN_DIR="${MODTOKEN_BIN_DIR:-$HOME/.local/bin}"
BIN_PATH="$BIN_DIR/modtoken"

CLAUDE_DIR="${CLAUDE_CONFIG_DIR:-$HOME/.claude}"
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
AGY_CLI_DIR="${ANTIGRAVITY_CLI_DIR:-$HOME/.gemini/antigravity-cli}"
AGY_CFG_DIR="${GEMINI_CONFIG_DIR:-$HOME/.gemini/config}"
AGY_DATA_DIR="${ANTIGRAVITY_TRACKER_DIR:-$AGY_CLI_DIR/token-tracker}"

SITE=""
TOKEN=""
TOKEN_SOURCE=""

mask_token() {
  local t="${1:-}"
  if [ "${#t}" -ge 12 ]; then
    printf '%s…%s' "${t:0:4}" "${t: -4}"
  elif [ -n "$t" ]; then
    printf '***'
  else
    printf 'не задано'
  fi
}

json_get() {
  local file="$1" expr="$2"
  [ -f "$file" ] || return 0
  if command -v python3 >/dev/null 2>&1; then
    python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1], encoding='utf-8'))
    v = $expr
    if isinstance(v, str) and v.strip(): print(v.strip())
except Exception:
    pass
" "$file" 2>/dev/null
  elif command -v node >/dev/null 2>&1; then
    node -e "
const fs = require('fs');
try {
  const d = JSON.parse(fs.readFileSync(process.argv[1], 'utf8'));
  const v = $expr;
  if (typeof v === 'string' && v.trim()) console.log(v.trim());
} catch {}
" "$file" 2>/dev/null
  fi
}

# Auto-discover site and device token from ~/.modtoken/config.json or any already-configured agent on this computer.
discover_credentials() {
  local s="" t=""
  if [ -f "$MT_CFG" ]; then
    s=$(json_get "$MT_CFG" "d.get('site', '')")
    t=$(json_get "$MT_CFG" "d.get('token', '')")
    if [ -n "$s" ] && [ -n "$t" ]; then
      SITE="${s%/}"; TOKEN="$t"; TOKEN_SOURCE="$MT_CFG"; return 0
    fi
  fi
  if [ -f "$CLAUDE_DIR/settings.json" ]; then
    local ep hdr
    ep=$(json_get "$CLAUDE_DIR/settings.json" "(d.get('env') or {}).get('OTEL_EXPORTER_OTLP_LOGS_ENDPOINT', '')")
    hdr=$(json_get "$CLAUDE_DIR/settings.json" "(d.get('env') or {}).get('OTEL_EXPORTER_OTLP_LOGS_HEADERS', '')")
    s="${ep%/v1/logs}"
    t=$(printf '%s' "$hdr" | sed -nE 's/.*x-device-token=([0-9a-fA-F_-]{6,128}).*/\1/p')
    if [ -n "$s" ] && [ -n "$t" ]; then
      SITE="${s%/}"; TOKEN="$t"; TOKEN_SOURCE="Claude ($CLAUDE_DIR/settings.json)"
      save_credentials "$SITE" "$TOKEN"
      return 0
    fi
  fi
  if [ -f "$CODEX_DIR/config.toml" ]; then
    s=$(sed -nE 's/.*endpoint = "(https?:\/\/[^"]+)\/v1\/logs".*/\1/p' "$CODEX_DIR/config.toml" | head -n 1)
    t=$(sed -nE 's/.*"x-device-token" = "([^"]+)".*/\1/p' "$CODEX_DIR/config.toml" | head -n 1)
    if [ -n "$s" ] && [ -n "$t" ]; then
      SITE="${s%/}"; TOKEN="$t"; TOKEN_SOURCE="Codex ($CODEX_DIR/config.toml)"
      save_credentials "$SITE" "$TOKEN"
      return 0
    fi
  fi
  if [ -f "$AGY_DATA_DIR/config.json" ]; then
    s=$(json_get "$AGY_DATA_DIR/config.json" "d.get('site', '')")
    t=$(json_get "$AGY_DATA_DIR/config.json" "d.get('token', '')")
    if [ -n "$s" ] && [ -n "$t" ]; then
      SITE="${s%/}"; TOKEN="$t"; TOKEN_SOURCE="Antigravity ($AGY_DATA_DIR/config.json)"
      save_credentials "$SITE" "$TOKEN"
      return 0
    fi
  fi
  return 1
}

save_credentials() {
  local s="${1%/}" t="${2:-}"
  [ -z "$s" ] || [ -z "$t" ] && return 1
  mkdir -p "$MT_DIR"
  umask 077
  printf '{\n  "site": "%s",\n  "token": "%s"\n}\n' "$s" "$t" > "$MT_CFG"
  chmod 600 "$MT_CFG" 2>/dev/null || true
  SITE="$s"; TOKEN="$t"
}

ensure_cli_installed() {
  mkdir -p "$BIN_DIR" "$MT_DIR"
  if [ -f "$0" ] && [ "$0" != "$BIN_PATH" ] && [ "$(basename "$0")" = "modtoken.sh" -o "$(basename "$0")" = "modtoken" ]; then
    cp "$0" "$BIN_PATH" 2>/dev/null || true
    chmod +x "$BIN_PATH" 2>/dev/null || true
  elif [ ! -f "$BIN_PATH" ]; then
    curl -fsSL --max-time 30 "$RAW/scripts/modtoken.sh" -o "$BIN_PATH" 2>/dev/null && chmod +x "$BIN_PATH" 2>/dev/null || true
  fi
  if [ "$BIN_DIR" = "$HOME/.local/bin" ]; then
    for rc in "$HOME/.bashrc" "$HOME/.zshrc"; do
      if [ -f "$rc" ] && ! grep -q '\.local/bin' "$rc" 2>/dev/null; then
        printf '\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc" 2>/dev/null || true
      fi
    done
  fi
}

claude_detected() { [ -d "$CLAUDE_DIR" ] || command -v claude >/dev/null 2>&1; }
codex_detected()  { [ -d "$CODEX_DIR" ]  || command -v codex  >/dev/null 2>&1; }
agy_detected()    { [ -d "$AGY_CLI_DIR" ] || [ -d "$AGY_CFG_DIR" ] || command -v agy >/dev/null 2>&1; }

claude_configured() { [ -f "$CLAUDE_DIR/settings.json" ] && grep -q 'OTEL_EXPORTER_OTLP_LOGS_ENDPOINT' "$CLAUDE_DIR/settings.json" 2>/dev/null; }
codex_configured()  { [ -f "$CODEX_DIR/config.toml" ] && grep -q 'x-device-token' "$CODEX_DIR/config.toml" 2>/dev/null; }
agy_configured()    { [ -f "$AGY_DATA_DIR/config.json" ] && [ -f "$AGY_CLI_DIR/settings.json" ] && grep -q 'statusline' "$AGY_CLI_DIR/settings.json" 2>/dev/null; }

claude_version() { json_get "$CLAUDE_DIR/mods/token-tracker/.claude-plugin/plugin.json" "d.get('version', '')"; }
codex_version()  { json_get "$CODEX_DIR/token-tracker/plugins/token-tracker/.codex-plugin/plugin.json" "d.get('version', '')"; }
agy_version()    { json_get "$AGY_CFG_DIR/plugins/token-tracker/plugin.json" "d.get('version', '')"; }

remote_version() {
  local rel="$1" tmp
  tmp=$(mktemp)
  if curl -fsSL --max-time 10 "$RAW/$rel" -o "$tmp" 2>/dev/null; then
    json_get "$tmp" "d.get('version', '')"
  fi
  rm -f "$tmp"
}

print_status() {
  discover_credentials >/dev/null 2>&1 || true
  local host
  host=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "linux-pc")
  echo "╔════════════════════════════════════════════════════════════════╗"
  echo "║  Token Tracker CLI (modtoken) · Управління агентами та OTLP    ║"
  echo "╚════════════════════════════════════════════════════════════════╝"
  echo "  Комп'ютер: $host"
  echo "  Сервер:    ${SITE:-не налаштовано}"
  echo "  Токен:     $(mask_token "$TOKEN")${TOKEN_SOURCE:+ (знайдено в: $TOKEN_SOURCE)}"
  echo ""
  echo "  Стан агентів на цьому ПК:"

  local cv xv av
  cv=$(claude_version); xv=$(codex_version); av=$(agy_version)
  if claude_configured; then
    echo "    [✓] Claude Code   OTLP: увімкнено · Мод: v${cv:-?}"
  elif claude_detected; then
    echo "    [•] Claude Code   виявлено на ПК, ще не підключено до Token Tracker"
  else
    echo "    [ ] Claude Code   не виявлено"
  fi

  if codex_configured; then
    local h_state="немає hooks.json"
    [ -f "$CODEX_DIR/hooks.json" ] && grep -q 'token-tracker' "$CODEX_DIR/hooks.json" 2>/dev/null && h_state="hooks.json активний"
    echo "    [✓] Codex         OTLP: увімкнено · Хуки: v${xv:-?} ($h_state)"
  elif codex_detected; then
    echo "    [•] Codex         виявлено на ПК, ще не підключено до Token Tracker"
  else
    echo "    [ ] Codex         не виявлено"
  fi

  if agy_configured; then
    echo "    [✓] Antigravity   statusLine: увімкнено · Плагін: v${av:-?}"
  elif agy_detected; then
    echo "    [•] Antigravity   виявлено на ПК, ще не підключено до Token Tracker"
  else
    echo "    [ ] Antigravity   не виявлено"
  fi
  echo ""
}

run_agent_installer() {
  local agent="$1" script_name=""
  case "$agent" in
    claude)      script_name="install.sh" ;;
    codex)       script_name="install-codex.sh" ;;
    antigravity) script_name="install-antigravity.sh" ;;
    *) echo "Невідомий агент: $agent"; return 1 ;;
  esac
  if [ -z "$SITE" ] || [ -z "$TOKEN" ]; then
    echo "  Помилка: спочатку задайте сервер і токен (modtoken token <сайт> <токен>)"
    return 1
  fi
  local tmp
  tmp=$(mktemp)
  if curl -fsSL --max-time 30 "$RAW/scripts/$script_name" -o "$tmp"; then
    TT_RAW="$RAW" bash "$tmp" "$SITE" "$TOKEN"
    rm -f "$tmp"
  else
    rm -f "$tmp"
    echo "  Не вдалося завантажити $script_name з $RAW"
    return 1
  fi
}

prompt_credentials_if_missing() {
  discover_credentials >/dev/null 2>&1 || true
  if [ -n "$SITE" ] && [ -n "$TOKEN" ]; then return 0; fi
  echo "Токен пристрою на цьому ПК ще не знайдено."
  printf "Адреса сервера [https://ait.bdev.pp.ua]: "
  local in_site="" in_tok=""
  read -r in_site || true
  in_site="${in_site:-https://ait.bdev.pp.ua}"
  printf "Вставте токен пристрою з дашборду (Пристрої → Створити токен): "
  read -r in_tok || true
  in_tok=$(printf '%s' "$in_tok" | tr -d '[:space:]')
  if [ -z "$in_tok" ]; then
    echo "Токен не введено."
    return 1
  fi
  save_credentials "$in_site" "$in_tok"
  echo "  Токен збережено в $MT_CFG"
}

cmd_install() {
  local target="${1:-all}" arg_site="${2:-}" arg_token="${3:-}"
  if [ -n "$arg_site" ] && [ -n "$arg_token" ]; then
    save_credentials "$arg_site" "$arg_token"
  else
    prompt_credentials_if_missing || return 1
  fi
  ensure_cli_installed

  case "$target" in
    claude|codex|antigravity)
      run_agent_installer "$target"
      ;;
    all)
      local any=0
      if claude_detected || claude_configured; then run_agent_installer claude; any=1; fi
      if codex_detected  || codex_configured;  then run_agent_installer codex;  any=1; fi
      if agy_detected    || agy_configured;    then run_agent_installer antigravity; any=1; fi
      if [ "$any" = 0 ]; then
        echo "  Жодного агента ще не виявлено у стандартних папках — налаштовую Claude Code та Codex:"
        run_agent_installer claude
        run_agent_installer codex
      fi
      ;;
    *)
      echo "Використання: modtoken install [all|claude|codex|antigravity] [https://сайт] [токен]"
      return 1
      ;;
  esac
}

cmd_update() {
  discover_credentials >/dev/null 2>&1 || true
  if [ -z "$SITE" ] || [ -z "$TOKEN" ]; then
    prompt_credentials_if_missing || return 1
  fi
  echo "Оновлення Token Tracker CLI та всіх підключених агентів..."
  mkdir -p "$BIN_DIR"
  if curl -fsSL --max-time 30 "$RAW/scripts/modtoken.sh" -o "$BIN_PATH.new" 2>/dev/null; then
    chmod +x "$BIN_PATH.new" 2>/dev/null || true
    mv "$BIN_PATH.new" "$BIN_PATH" 2>/dev/null || true
    echo "  [✓] Команду modtoken ($BIN_PATH) оновлено"
  fi
  local updated=0
  if claude_configured || claude_detected; then
    local old_v new_v
    old_v=$(claude_version)
    run_agent_installer claude
    new_v=$(claude_version)
    echo "  [✓] Claude Code: v${old_v:-—} → v${new_v:-?}"
    updated=1
  fi
  if codex_configured || codex_detected; then
    local old_v new_v
    old_v=$(codex_version)
    run_agent_installer codex
    new_v=$(codex_version)
    echo "  [✓] Codex: v${old_v:-—} → v${new_v:-?}"
    updated=1
  fi
  if agy_configured || agy_detected; then
    local old_v new_v
    old_v=$(agy_version)
    run_agent_installer antigravity
    new_v=$(agy_version)
    echo "  [✓] Antigravity: v${old_v:-—} → v${new_v:-?}"
    updated=1
  fi
  if [ "$updated" = 0 ]; then
    echo "  Підключених агентів не знайдено. Запустіть: modtoken install all"
  fi
}

cmd_doctor() {
  print_status
  echo "  Діагностика (doctor):"
  if command -v python3 >/dev/null 2>&1; then
    echo "    [✓] python3: $(python3 --version 2>&1)"
  else
    echo "    [!] python3 не знайдено (потрібен для хуків Codex та Antigravity на Linux/macOS)"
  fi
  if command -v node >/dev/null 2>&1; then
    echo "    [✓] node: $(node --version 2>&1)"
  fi

  if [ -n "$SITE" ] && [ -n "$TOKEN" ]; then
    local host code body
    host=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo "")
    body=$(mktemp)
    code=$(curl -s -o "$body" -w '%{http_code}' --max-time 8 -H "x-device-token: $TOKEN" -H "user-agent: modToken-cli/1.0" "$SITE/v1/config?host=$host" 2>/dev/null || echo "000")
    if [ "$code" = "200" ]; then
      echo "    [✓] Зв'язок із сервером $SITE/v1/config: HTTP 200 OK ($(cat "$body" 2>/dev/null))"
    elif [ "$code" = "401" ]; then
      echo "    [✗] Сервер відхилив токен (HTTP 401): токен відкликано або невірний. Видайте «Новий токен» у дашборді."
    else
      echo "    [✗] Не вдалося з'єднатися з $SITE/v1/config (HTTP $code)"
    fi
    rm -f "$body"
  else
    echo "    [!] Сервер і токен ще не налаштовані"
  fi

  local r_claude r_codex r_agy l_claude l_codex l_agy
  r_claude=$(remote_version "mods/token-tracker/.claude-plugin/plugin.json")
  r_codex=$(remote_version "mods/codex-tracker/.codex-plugin/plugin.json")
  r_agy=$(remote_version "mods/antigravity-tracker/plugin.json")
  l_claude=$(claude_version); l_codex=$(codex_version); l_agy=$(agy_version)

  [ -n "$l_claude" ] && echo "    [•] Версія мода Claude:      локальна v$l_claude / остання v${r_claude:-?}"
  [ -n "$l_codex" ]  && echo "    [•] Версія хуків Codex:      локальна v$l_codex / остання v${r_codex:-?}"
  [ -n "$l_agy" ]    && echo "    [•] Версія плагіна Antigravity: локальна v$l_agy / остання v${r_agy:-?}"

  if [ -f "$CODEX_DIR/config.toml" ] && grep -A2 'token-tracker@token-tracker-local' "$CODEX_DIR/config.toml" 2>/dev/null | grep -q 'enabled = true'; then
    echo "    [!] У $CODEX_DIR/config.toml досі активний старий плагін token-tracker@token-tracker-local (запустіть: modtoken update)"
  fi

  for err_file in "$CLAUDE_DIR/mods/token-tracker/last-error.txt" "$CODEX_DIR/token-tracker/last-error.txt" "$AGY_DATA_DIR/last-error.txt"; do
    if [ -f "$err_file" ]; then
      echo "    [!] Остання помилка в $err_file: $(tail -n 1 "$err_file" 2>/dev/null)"
    fi
  done
  echo ""
}

interactive_menu() {
  ensure_cli_installed
  while true; do
    print_status
    echo "  Оберіть дію:"
    echo "    1) Оновити все (плагіни, хуки, OTLP та команду modtoken)"
    echo "    2) Підключити / налаштувати всі виявлені агенти на цьому ПК"
    echo "    3) Підключити окремий агент (Claude Code / Codex / Antigravity)"
    echo "    4) Діагностика (doctor: перевірка сервера, версій, хуків і помилок)"
    echo "    5) Змінити сервер або токен пристрою"
    echo "    0) Вихід"
    printf "\n  Ваш вибір [1-5, 0]: "
    local ch=""
    read -r ch || break
    echo ""
    case "$ch" in
      1) cmd_update; break ;;
      2) cmd_install all; break ;;
      3)
        printf "  Який агент підключити? (1 = Claude Code, 2 = Codex, 3 = Antigravity): "
        local ach=""
        read -r ach || break
        case "$ach" in
          1|claude)      cmd_install claude ;;
          2|codex)       cmd_install codex ;;
          3|antigravity) cmd_install antigravity ;;
          *) echo "  Невірний вибір." ;;
        esac
        break
        ;;
      4) cmd_doctor; break ;;
      5)
        SITE=""; TOKEN=""
        rm -f "$MT_CFG"
        prompt_credentials_if_missing || true
        ;;
      0|q|exit|"") break ;;
      *) echo "  Невірний вибір." ;;
    esac
  done
}

CMD="${1:-menu}"
case "$CMD" in
  menu)    interactive_menu ;;
  status)  print_status ;;
  update)  cmd_update ;;
  doctor)  cmd_doctor ;;
  install) shift; cmd_install "${1:-all}" "${2:-}" "${3:-}" ;;
  token)
    shift
    if [ -z "${1:-}" ] || [ -z "${2:-}" ]; then
      echo "Використання: modtoken token https://<сайт> <токен>"
      exit 1
    fi
    save_credentials "$1" "$2"
    ensure_cli_installed
    echo "Токен збережено в $MT_CFG"
    ;;
  https://*|http://*)
    # Shorthand: modtoken https://site <token> -> saves token & installs all detected agents
    if [ -n "${2:-}" ]; then
      cmd_install all "$1" "$2"
    else
      echo "Використання: modtoken https://<сайт> <токен>"
      exit 1
    fi
    ;;
  *)
    echo "Використання: modtoken [status|update|doctor|install [all|claude|codex|antigravity]|token <сайт> <токен>]"
    exit 1
    ;;
esac
