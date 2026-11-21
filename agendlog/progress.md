# Журнал прогресу (`modToken`)

## 2026-11-21
- [x] Склоновано репозиторій `Pavlo577/modToken` у `/home/brolafkodev/CLI/modToken`.
- [x] Збережено попередній `origin/dev` (`e6d14d8`) у гілці `archive/old-dev`, гілку `dev` переведено на актуальний `main` (`0852b7c`).
- [x] Додано підтримку провайдера **`antigravity`** на стороні Worker:
  - OTLP-адаптер `antigravity-cli` (`antigravity.api_request`) у `worker/src/otlp.ts`;
  - Реєстр полів у `worker/src/otlp-fields.ts` та регенеровано `docs/OTLP-fields.md`, оновлено `docs/OTLP.md`;
  - Маршрутизація провайдера `antigravity` у `worker/src/limits.ts`, `worker/src/activity.ts`, `worker/src/import.ts`, `worker/src/pluginlog.ts`, `worker/src/admin/devices.ts`, `worker/src/admin/modstats.ts`.
- [x] Оновлено UI дашборду:
  - Лейбл і колір `Antigravity` у `worker/web/core/palette.ts`;
  - Майстер підключення пристрою для Antigravity (Linux/macOS, Windows, Cloud) у `worker/web/lib/setup.ts` та `worker/public/admin/index.html`;
  - Відображення статусу плагіна (`antigravity-plugin`) і підказок лімітів у `worker/web/tabs/devices.ts` та `worker/web/tabs/money.ts`.
- [x] Створено плагін і `statusLine`-міст `worker/mods/antigravity-tracker/` (`plugin.json`, `hooks.json`, `hooks/statusline.py`, `hooks/activity.py`, `hooks/statusline.ps1`, `hooks/activity.ps1`) та інсталятори `worker/scripts/install-antigravity.sh` і `worker/scripts/install-antigravity.ps1`.
- [x] Додано синтетичні тести з підкинутими секретами у `worker/test/antigravity.test.mjs` та оновлено `worker/test/setup.test.mjs` і `worker/package.json`.
- [x] Виправлено баг у дедуплікації квот `statusline.py` / `statusline.ps1`: при обчисленні `resetsAt` із `reset_in_seconds` час округлюється до хвилини, щоб уникнути зайвих повторних POST `/v1/limits` через мілісекундний дрейф.
- [x] Проведено повний E2E-тест на живому локальному `wrangler dev` + D1 (`DB` і `EVENTS`): пройшли всі 74 перевірки `test/otlp.sh` та повний цикл Antigravity (`install-antigravity.sh`, `SessionStart` → `PreInvocation` → фоновий `statusLine` (~165 ms) → `Stop` → перевірка `devices`, `turns`, `buckets`, `limits`, `mod-stats`, `plugin-log`, `insights` і нульовий витік секретів).
