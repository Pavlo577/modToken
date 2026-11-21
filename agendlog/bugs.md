# Журнал багів (`modToken`)

## 2026-11-21
- [x] **Cloudflare 403 (`error code: 1010`) при відправці з Python-скриптів плагіна Antigravity**
  - **Симптом:** у `~/.gemini/antigravity-cli/token-tracker/last-error.txt` з'являлася помилка `statusline: HTTPError`, дані не доходили до `https://ait.bdev.pp.ua`.
  - **Причина:** Cloudflare Browser Integrity Check блокує дефолтний `User-Agent: Python-urllib/...` із кодом `403 error code: 1010`.
  - **Виправлення:** додано явний заголовок `User-Agent: modToken-antigravity/1.0` у `hooks/statusline.py`, `hooks/activity.py`, `hooks/statusline.ps1`, `hooks/activity.ps1`.
- [x] **Хуки `SessionStart` / `PreInvocation` / `Stop` у `hooks.json` не спрацьовували**
  - **Симптом:** папка `token-tracker/activity/` не створювалася під час роботи `agy`.
  - **Причина:** для не-tool подій (`SessionStart`, `PreInvocation`, `Stop`) Antigravity вимагає плоский масив обробників `[{"type":"command",...}]`, а не обгортку `[{"hooks":[...]}]` (яка використовується лише для `PreToolUse`/`PostToolUse` із `matcher`).
  - **Виправлення:** оновлено `mods/antigravity-tracker/hooks.json`, `scripts/install-antigravity.sh`, `scripts/install-antigravity.ps1` та додано перевірку в `test/antigravity.test.mjs`.
- [x] **Неповний `context_tokens` у `last_context`**
  - **Симптом:** у живому пейлоаді `statusLine` поле `current_usage.input_tokens` містить лише некешований ввід (`2568`), а кешований контекст лежить у `cache_read_input_tokens` (`264960`).
  - **Виправлення:** `last_context.tokens` тепер рахує суму `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`, що відповідає `used_percentage`.
