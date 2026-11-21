# Архітектурні рішення (`modToken`)

## 2026-11-21 — Інтеграція Antigravity CLI (`agy`) через `statusLine` + Plugin Hooks

### Контекст
- Antigravity CLI (`agy`) не має вбудованого OTLP/OTLP-HTTP експортера, проте надає два офіційно задокументованих механізми:
  1. **`statusLine` command** (`~/.gemini/antigravity-cli/settings.json`), що передає у `stdin` структурований JSON із `conversation_id`, `model`, `context_window` (`total_input_tokens`, `total_output_tokens`, `context_window_size`, `used_percentage`, `current_usage`), `cost` (`total_usd`, `subagent_usd`) та `quota` (ліміти підписки).
  2. **Native Plugin Hooks** (`~/.gemini/config/plugins/token-tracker/hooks.json`) з подіями `SessionStart`, `PreInvocation`, `Stop`.

### Прийняте рішення
- **Не парсити внутрішню SQLite/protobuf БД (`~/.gemini/antigravity/conversations/*.db`)**, оскільки її wire-схема не задокументована і може змінюватися між оновленнями.
- **Використати зв'язку `statusLine` → OTLP/HTTP JSON (`POST /v1/logs`) + `/v1/limits` + `hooks/activity.py` → `/v1/activity`:**
  - `hooks/statusline.py` (та `.ps1` для Windows) рахує дельти по `conversation_id`, зберігає стан атомарно, відправляє стандартні OTLP-записи `antigravity.api_request` (`service.name: "antigravity-cli"`) у фоновому процесі (`--deliver`), щоб `statusLine` завершувався миттєво і ніколи не блокував TUI, а також зберігає поточне заповнення контексту для хука `Stop`.
  - Квоти підписки нормалізуються до `five_hour` / `seven_day` (максимальний `%` використання у групі вікон), що дає повну сумісність із вкладкою «Вартість і ліміти».
  - `hooks/activity.py` (`SessionStart`, `PreInvocation`, `Stop`) ділиться активним `turn.id` зі `statusline.py`, щоб усі OTLP-виклики одного ходу групувалися під спільним `prompt.id`.
  - Якщо у користувача вже був свій `statusLine`, інсталятор зберігає його в `chain_command`, не затираючи.

### Приватність
- Суворий allow-list на стороні плагіна та Worker: `email`, `conversation_title`, `cwd`, `workspacePaths`, `transcript_path`, `lastUserInput` ніколи не відправляються на сервер.
- Репозиторій (`owner/name` або `h:<sha256[:12]>`) обчислюється локально лише за дозволом `GET /v1/config` (`project_mode`).
