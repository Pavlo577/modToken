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

## 2026-11-22 — Ціноутворення, мультіагентні інсайти, кеш ПК, `hourly_buckets` і Cron-ретенція

1. **Автоматичні ціни моделей (`worker/src/prices-lib.ts`, `worker/src/prices.ts`):**
   - Єдина логіка парсингу LiteLLM та фолбеку `priceFor`/`estimateCostMicros` для OpenAI, Gemini та версійних моделей Anthropic.
   - `worker/scripts/update-prices.mjs` оновлює статичний `worker/public/admin/prices.json`, а Worker кешує актуальний прайс у `DB.app_meta` (ключ `prices_v1`) з добовим оновленням у `scheduled()` Cron і віддає через `GET /api/admin/prices` (з фолбеком на статичний JSON).
2. **Мультіагентні «Інсайти» (`worker/src/admin/insights.ts`, `worker/web/tabs/insights.ts`):**
   - Додано фільтрацію `?provider=` (`claude` / `codex` / `antigravity` / усі) і нормалізацію `api_request` / `codex.api_request` / `antigravity.api_request` в одному запиті `aggregateCallEvents` (з підстановкою `estimateCostMicros`, якщо `cost_usd_micros` відсутній).
   - Claude-специфічні вибірки (`user_prompt`, `api_error`, `tool_decision` тощо) виконуються лише за потреби (або об'єднано в один запит), що зменшує навантаження на `EVENTS` D1 для Codex/Antigravity.
3. **Локальне буферування плагіна Antigravity `1.1.0` (`worker/mods/antigravity-tracker/`):**
   - `statusline.py` / `statusline.ps1` акумулюють OTLP `logRecords` і квоти в локальному `queue.json` (ліміт 500 записів, блокування файлом у Python) та виконують батч-доставку при `idle`, `>= 10` записів, закінченні інтервалу `flush_seconds` (за замовчуванням 15 с), на `--flush` (хук `Stop`) або `--sync`; при мережевій помилці записи залишаються в черзі для повторної спроби.
   - Дисплейні імена моделей нормалізуються перед відправкою (`normalize_model`: нижній регістр, крапки/пробіли/дужки → `-`, щоб відповідати ключам прайсу).
4. **Преагреговані `hourly_buckets` + Cron-ретенція (`worker/src/buckets.ts`, `worker/src/maintenance.ts`):**
   - Таблиця `hourly_buckets` (міграція `0016_hourly_buckets_and_meta.sql`) інкрементально оновлюється при прийомі OTLP (`otlp-ingest.ts`), імпорті історії (`import.ts`) і видаленні пристроїв (`devices.ts`); `GET /api/admin/buckets` читає її напряму (із безпечним фолбеком на `token_events`, якщо міграція ще не застосована).
   - Періодичні `DELETE` (`otlp_calls` > 14 днів, `events` > 90 днів) винесені з гарячого шляху OTLP у погодинний Cloudflare Cron (`scheduled()` → `runMaintenance`). У `storeEvents` збережено дешевий in-memory фільтр 90 днів до запису, щоб старі події не потрапляли в `EVENTS` між запусками Cron.
5. **Точність `devices.last_seen` і прибирання мертвого ендпоїнта:**
   - `/v1/limits` і `/v1/activity` оновлюють `devices.last_seen` через `MAX(COALESCE(last_seen, ?1), ?1)`. Видалено невикористовуваний `worker/src/admin/stats.ts`.

## 2026-11-22 (P0 стабільність і мультидевайс) — Reconcile backfill, Account-wide ліміти та фікси плагінів

1. **Per-`session_id` backfill (`worker/src/import.ts`, `migrations/0017_stability_indexes.sql`, `maintenance.ts`):**
   - Додано `mode: 'reconcile'`, який замість глобального відсікання за `devices.otlp_since` перевіряє наявність `session_id` в OTLP на цьому пристрої (`events_device_session_idx`) і в інших пристроїв користувача (`events_user_provider_session_idx`). Це дозволяє автоматично дозаливати сесії, втрачені під час тимчасового офлайну або з Desktop/IDE, без дублювання при синхронізованих логах.
   - Збільшено ретенцію `otlp_calls` до `45` днів у `maintenance.ts` і ввімкнено `mode: 'reconcile'` у веб-імпорті та плагінах Claude і Codex.
2. **Account-wide `plan_limits` з `observedAt` (`worker/src/limits.ts`, `web/tabs/money.ts`):**
   - Квоти підписки тепер перевіряються на рівні `(user_email, provider, kind)` через `shouldStoreLimit`: відкидаються застарілі знімки з офлайн-черг (`observedAt`), старіші вікна `resetsAt`, крос-пристрійні дублі (`|delta| < 0.05%`) та хибні падіння >3% між різними пристроями протягом 5 хв.
   - Верхня картка й графік лімітів у `money.ts` показують спільний стан підписки незалежно від обраного фільтра пристрою.
3. **Придушення спаму `*.delta` Codex та підтримка Claude Cowork (`worker/src/otlp.ts`, інсталятори):**
   - У `eventRowOf` відкидаються `codex.sse_event` із `event.kind`, що закінчується на `.delta`, а `install-codex.sh`/`.ps1` + `setup.ts` прописують `log_sse_deltas = false`, `log_agent_responses = false`, `log_guardian_assessments = false`.
   - `adapterFor` розпізнає `cowork` / `claude-cowork`.
   - `install-codex.*` використовує user-level `$CODEX_HOME/hooks.json` як єдине джерело хуків для Codex CLI, Desktop та IDE (автоматично вимикаючи попередній дубль `[plugins."token-tracker@token-tracker-local"]` у `config.toml`); `install.*` додає `CLAUDE_CODE_PLUGIN_DIRS` fallback для Desktop/IDE, коли `claude` CLI відсутній; `CLOUD_MOD_DIR` змінено на `~/.claude/mods/token-tracker`.
