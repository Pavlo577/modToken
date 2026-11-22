#!/bin/bash
# Token Tracker for Antigravity CLI (`agy`) on macOS / Linux, one command from the dashboard's "Add device" box:
#   curl -fsSL <raw url of this file> | bash -s -- https://<your-site> <device token>
# Installs the Antigravity plugin (`mods/antigravity-tracker`) into ~/.gemini/config/plugins/token-tracker, saves the site and
# device token into ~/.gemini/antigravity-cli/token-tracker/config.json (chmod 600, never printed), and adds our statusLine
# command to ~/.gemini/antigravity-cli/settings.json (`stack_with_default: true`, chaining any existing custom statusLine).
set -u
ORIGIN="${1%/}"; TOKEN="${2:-}"
[ -z "$ORIGIN" ] || [ -z "$TOKEN" ] && { echo "Використання: curl -fsSL …/install-antigravity.sh | bash -s -- https://<сайт> <токен пристрою>"; exit 1; }
CLI_DIR="${ANTIGRAVITY_CLI_DIR:-$HOME/.gemini/antigravity-cli}"
CFG_DIR="${GEMINI_CONFIG_DIR:-$HOME/.gemini/config}"
DATA_DIR="${ANTIGRAVITY_TRACKER_DIR:-$CLI_DIR/token-tracker}"
PLUGIN="$CFG_DIR/plugins/token-tracker"
SETTINGS="$CLI_DIR/settings.json"
RAW="${TT_RAW:-https://raw.githubusercontent.com/Pavlo577/modToken/main/worker}"

echo "Token Tracker для Antigravity CLI: $CLI_DIR"
command -v python3 >/dev/null || { echo "  Потрібен python3 для роботи плагіна та statusLine"; exit 1; }

mkdir -p "$PLUGIN/hooks" "$DATA_DIR" "$CLI_DIR"
GOT=1
for f in plugin.json hooks.json hooks/statusline.py hooks/activity.py hooks/statusline.ps1 hooks/activity.ps1; do
  curl -fsSL --max-time 30 "$RAW/mods/antigravity-tracker/$f" -o "$PLUGIN/$f" || GOT=0
done
if [ "$GOT" = 0 ]; then
  echo "  Не вдалося завантажити файли плагіна"
  exit 1
fi
chmod +x "$PLUGIN/hooks/statusline.py" "$PLUGIN/hooks/activity.py" 2>/dev/null || true

TT_ORIGIN="$ORIGIN" TT_TOKEN="$TOKEN" TT_PLUGIN="$PLUGIN" TT_DATA="$DATA_DIR" TT_SETTINGS="$SETTINGS" python3 - <<'PY'
import json, os, stat

origin = os.environ['TT_ORIGIN']
token = os.environ['TT_TOKEN']
plugin = os.environ['TT_PLUGIN']
data_dir = os.environ['TT_DATA']
settings_path = os.environ['TT_SETTINGS']

def load_json(p):
    try:
        with open(p, encoding='utf-8') as f:
            v = json.load(f)
            return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}

# 1. Write resolved hooks.json at plugin root (flat handler list for SessionStart, PreInvocation, Stop)
act_cmd = f'python3 "{os.path.join(plugin, "hooks", "activity.py")}"'
hooks = {
    'token-tracker': {
        ev: [{'type': 'command', 'command': f'{act_cmd} {ev}', 'timeout': 10}]
        for ev in ('SessionStart', 'PreInvocation', 'Stop')
    }
}
with open(os.path.join(plugin, 'hooks.json'), 'w', encoding='utf-8') as f:
    json.dump(hooks, f, indent=2)
    f.write('\n')

# 2. Update settings.json (preserve other keys; chain an existing foreign statusLine command)
settings = load_json(settings_path)
sl_script = os.path.join(plugin, 'hooks', 'statusline.py')
sl_cmd = f'python3 "{sl_script}"'
cfg_path = os.path.join(data_dir, 'config.json')
cfg = load_json(cfg_path)
chain = cfg.get('chain_command') if isinstance(cfg.get('chain_command'), str) else ''

prev_sl = settings.get('statusLine')
if isinstance(prev_sl, dict):
    prev_cmd = prev_sl.get('command')
    if isinstance(prev_cmd, str) and prev_cmd.strip() and 'token-tracker/hooks/statusline.py' not in prev_cmd:
        chain = prev_cmd.strip()

settings['statusLine'] = {
    'type': 'command',
    'command': sl_cmd,
    'stack_with_default': True,
}
with open(settings_path, 'w', encoding='utf-8') as f:
    json.dump(settings, f, indent=2)
    f.write('\n')

# 3. Save token-tracker config (mode 600)
new_cfg = {'site': origin, 'token': token}
if chain:
    new_cfg['chain_command'] = chain
with open(cfg_path, 'w', encoding='utf-8') as f:
    json.dump(new_cfg, f, indent=2)
    f.write('\n')
os.chmod(cfg_path, stat.S_IRUSR | stat.S_IWUSR)
PY

echo "  Плагін встановлено в $PLUGIN"
echo "  statusLine підключено в $SETTINGS"
case "$RAW" in file://*) ;; *) (HOST_NAME=$(hostname -s 2>/dev/null || hostname 2>/dev/null || echo ""); [ -n "$HOST_NAME" ] && curl -fsSL --connect-timeout 2 --max-time 3 -H "x-device-token: $TOKEN" -H "user-agent: modToken-antigravity/1.0" "$ORIGIN/v1/config?agent=antigravity&host=$HOST_NAME" </dev/null >/dev/null 2>&1) & ;; esac
echo "Готово. Перезапусти Antigravity CLI (agy); дані з'являться на дашборді після першої відповіді."
