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

## 2026-11-22
- [x] **Фейкова оранжева смужка на `0.0%`, розбіжність «Використано / Залишилось», приховані агенти та пули квот на вкладці «Вартість і ліміти»**
  - **Симптоми:** за нульового ліміту (`0.0%`) на початку бару малювалася вузька оранжева смужка; у режимі «Усі агенти» відображався лише один агент; Antigravity IDE / Codex показують залишок (`Remaining`), тоді як дашборд показував лише «використано» без другого значення; 3 пули Antigravity (`Gemini Models`, `Claude and GPT models`, `Gemini 4 Argon`) зливалися у 2 бакети; при порожньому `resets_at` виводилось `0 хв (02:00, 1 січ.)`.
  - **Першопричини & Виправлення:**
    - `.meter b` у `worker/public/admin/styles.css` мав безумовний `padding-right: 10px`, а `money.ts` завжди створював `<b>` навіть при `0%` → додано `.meter b:not(:empty)` і рендер `<b>` лише при `barPct > 0`.
    - Додано перемикач `Використано / Залишилось` (`state.limitMode` у `worker/web/core/state.ts`, `index.html`, `controls.ts`) та показ обох значень у заголовку шкали (`money.ts`); додано мульти-агентний рендер при `Усі агенти` та включення `limits` у `load.ts` для формування перемикача агентів.
    - `worker/src/limits.ts` і `worker/web/lib/stats.ts` підтримують цифрові назви пулів (`gemini_4_argon_weekly`), а `statusline.py`/`statusline.ps1` (`1.1.1`) передають індивідуальні пули разом зі зведеними `five_hour`/`seven_day`, коли кілька бакетів ділять вікно.
- [x] **Codex-плагін (`win-pk-h-codex`) не оновлював ліміти (застрягло на `20 дн тому`)**
  - **Першопричина:** у `worker/mods/codex-tracker/` (`limits.py`, `limits.ps1`, `activity.*`, `history.*`) бракувало заголовка `User-Agent` (Cloudflare блокує стандартні UA з `403 error 1010`), `limits.ps1` читав лише `-Tail 400` без shared write/delete доступу (`IO.FileStream`) до відкритої сесії на Windows, а `limits.py`/`limits.ps1` переривали сканування, якщо останній `token_count` мав `rate_limits: { primary: null }`.
  - **Виправлення:** оновлено плагін до версії `1.4.1`: додано `User-Agent: modToken-codex/1.0`, читання останніх 512 КБ у `limits.ps1` через `IO.FileStream` з `ReadWrite | Delete`, та перевірку непорожніх вікон перед виходом зі сканування.
- [x] **Пропущені сесії після `otlp_since`, конфлікти `plan_limits` на кількох ПК, таймаут Codex-хуків >3с і спам `*.delta` в `EVENTS` D1**
  - **Першопричини:** `import.ts` різав будь-який backfill після найпершого `otlp_since`; `limits.ts` дедуплікував по `device_id` і писав серверний `now` замість `observedAt` клієнта; `codex-tracker/hooks/hooks.json` мав `timeout: 10` на `Interrupt`/`SessionEnd` (ліміт Codex 3 с); Codex IDE не читає plugin-bundled hooks; Codex за замовчуванням шле `log_sse_deltas = true`; `CLOUD_MOD_DIR` зашивав `/root/...`; `install.sh`/`.ps1` не додавали `CLAUDE_CODE_PLUGIN_DIRS` при відсутності CLI `claude`.
  - **Виправлення:** реалізовано P0-пакет стабільності (`0017_stability_indexes.sql`, `mode: 'reconcile'`, `shouldStoreLimit` + `observedAt`, фільтр `.delta`, `timeout: 3` + `$CODEX_HOME/hooks.json`, fallback `CLAUDE_CODE_PLUGIN_DIRS`, `User-Agent` у `token-tracker` `1.5.1`, Codex `1.4.2`, Antigravity `1.1.2`).
