# Ідеї та майбутні покращення (`modToken`)

## 2026-11-21
- [ ] **Підтримка `PreToolUse` / `PostToolUse` для Antigravity (`perm_asks`, `perm_denied`, `perm_wait_ms`):** дослідити, чи дає реальний хук Antigravity достатньо метаданих для точного підрахунку запитів дозволу від користувача (без авто-рішень).
- [ ] **Реальний тест на живому `agy`:** після першої живої сесії з підключеним `statusLine` перевірити фактичні імена бакетів у `quota` та формулу `total_input_tokens` vs `cache_read_input_tokens` у живому пейлоаді й за потреби підкоригувати мапінг.
- [x] **Автооновлення `prices.json` та динамічний прайс для моделей Antigravity/OpenAI/Anthropic** (Gemini 4 Neon / Argon / Hydrogen, Gemini 3.8 Flash + кеш у `app_meta` через Cron і `/api/admin/prices`), як резервний розрахунок вартості на випадок, якщо `cost.total_usd` відсутній.
- [x] **Мультіагентна вкладка «Інсайти» (`?provider=`), кеш ПК у плагіні Antigravity `1.1.0`, `hourly_buckets` і Cron-ретенція** — реалізовано у рамках Етапу 3 та пункту 7 аналізу слабких місць.

## 2026-11-22
- [x] **Групування пристроїв за агентами, перейменування та автоназва пристрою з ПК:** на вкладці «Пристрої» список розбито на секції `Claude Code`, `Codex`, `Antigravity` з кнопками швидкого додавання `+ Додати в ...`, поле назви при створенні токена зроблено необов'язковим (автогенерація `<agent>-<place>` + автоматичне підтягування `<agent>-<hostname>` під час запуску інсталятора через `GET /v1/config?agent=...&host=...`), додано кнопку «Перейменувати» (`PATCH /api/admin/devices/:id`).
- [x] **Кросплатформна консольна програма `modtoken` (`worker/scripts/modtoken.sh`, `worker/scripts/modtoken.ps1`):** інтерактивне меню та CLI (`modtoken`, `modtoken status`, `modtoken update`, `modtoken doctor`, `modtoken install`) для Windows PowerShell і Linux/macOS з автовиявленням встановлених агентів (Claude Code, Codex, Antigravity), автоматичним підхопленням уже наявного токена на ПК без повторного копіювання з сайту, оновленням усіх плагінів/хуків/OTLP однією командою та діагностикою.
