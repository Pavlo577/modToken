# Ідеї та майбутні покращення (`modToken`)

## 2026-11-21
- [ ] **Підтримка `PreToolUse` / `PostToolUse` для Antigravity (`perm_asks`, `perm_denied`, `perm_wait_ms`):** дослідити, чи дає реальний хук Antigravity достатньо метаданих для точного підрахунку запитів дозволу від користувача (без авто-рішень).
- [ ] **Реальний тест на живому `agy`:** після першої живої сесії з підключеним `statusLine` перевірити фактичні імена бакетів у `quota` та формулу `total_input_tokens` vs `cache_read_input_tokens` у живому пейлоаді й за потреби підкоригувати мапінг.
- [ ] **Автооновлення `prices.json` для моделей Antigravity** (Gemini 4 Neon / Argon / Hydrogen, Gemini 3.8 Flash), як резервний розрахунок вартості на випадок, якщо `cost.total_usd` відсутній.
