# Ідеї та майбутні покращення (`modToken`)

## 2026-11-21
- [ ] **Підтримка `PreToolUse` / `PostToolUse` для Antigravity (`perm_asks`, `perm_denied`, `perm_wait_ms`):** дослідити, чи дає реальний хук Antigravity достатньо метаданих для точного підрахунку запитів дозволу від користувача (без авто-рішень).
- [ ] **Реальний тест на живому `agy`:** після першої живої сесії з підключеним `statusLine` перевірити фактичні імена бакетів у `quota` та формулу `total_input_tokens` vs `cache_read_input_tokens` у живому пейлоаді й за потреби підкоригувати мапінг.
- [x] **Автооновлення `prices.json` та динамічний прайс для моделей Antigravity/OpenAI/Anthropic** (Gemini 4 Neon / Argon / Hydrogen, Gemini 3.8 Flash + кеш у `app_meta` через Cron і `/api/admin/prices`), як резервний розрахунок вартості на випадок, якщо `cost.total_usd` відсутній.
- [x] **Мультіагентна вкладка «Інсайти» (`?provider=`), кеш ПК у плагіні Antigravity `1.1.0`, `hourly_buckets` і Cron-ретенція** — реалізовано у рамках Етапу 3 та пункту 7 аналізу слабких місць.
