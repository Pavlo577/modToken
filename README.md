# Token Tracker

Token usage of AI agents (Claude Code now; Codex, Gemini and Mistral through their own OpenTelemetry adapters later) from many devices, in one dashboard. Tokens arrive as **OpenTelemetry**: the agent exports its API-request events straight to the site. A small mod for Claude Code adds only what OpenTelemetry cannot carry (subscription limits, session timing). Only numbers are kept; no prompts, answers, emails or paths.

- **Worker** (`worker/src`): Cloudflare Worker + D1. `POST /v1/logs` receives OTLP/HTTP JSON; `POST /v1/limits`, `/v1/activity`, `/v1/import` and `GET /v1/config` serve the mod (all with the device's token); `/api/admin/*` serves the dashboard behind Cloudflare Access.
- **Dashboard** (`worker/web` → `worker/public/admin`): **Огляд** (tokens over time with a step of every record, 1 h, 12 h or 24 h, paging by day / week / month / year, an own interval), **Аналітика**, **Інсайти** (where the money goes, speed, tools, permissions, surfaces, hooks, new fields, and what the mod measures: context fill, turn time and pauses, sessions), **Вартість і ліміти** (cost, subscription limits), **Сесії**, **Пристрої** (add a device, history import, what the mod may send about the project).
- **The mod** (`worker/mods/token-tracker`): subscription rate-limit windows, sessions and turns (wall-clock time, pauses, context fill, permission prompts), the session's repository only as far as the device allows (`off` | `name` | `hash`), and `/tracker-import` for the old history. Never tokens: OTLP counts them.
- **Two databases**: `DB` (devices, one row per turn with tokens and the agent's own cost, limits, mod sessions and turns) and `EVENTS` (every event with its harmless attributes, kept 90 days; `worker/events-schema.sql`). The Worker counts tokens without `EVENTS`; the Insights tab needs it.
- **Docs**: `docs/OTLP.md` says exactly what is received, what is kept and what is dropped; `docs/OTLP-fields.md` lists every field (generated from `worker/src/otlp-fields.ts`, `bun run fields`). Rules for contributors and agents: `AGENTS.md`.

## Deploy (once, by the owner)
1. Create the D1 databases `modtoken-prod` and `modtoken-events-prod` and run the full schemas: `cd worker && bun install && npx wrangler d1 execute modtoken-prod --remote --file=schema.sql && npx wrangler d1 execute modtoken-events-prod --remote --file=events-schema.sql`; put their ids in `worker/wrangler.jsonc`. The older `modtoken`, `modtoken-solo` and `modtoken-events` are an archive; Worker Previews (branches other than `main`) use the `previews` block of `wrangler.jsonc` (`modtoken-solo` / `modtoken-events`).
2. Attach the site's domain to the Worker (Custom domain). In Cloudflare Access protect that host only on `admin*` and `api/admin*`; **`/v1/*` stays outside Access** (devices send there with their own token). Set `TEAM_DOMAIN` and `POLICY_AUD` in `wrangler.jsonc` (`POLICY_AUD` is the application's Audience tag; several tags can be listed separated by commas). Passkeys come from the identity provider, not from Access.
3. Push to `main`; Workers Builds deploys it (`bun run build`, no migrations: the schema files above are complete). An older database needs `worker/migrations/*.sql` applied in order, and `0004_otlp_only.sql` drops the tables this project does not use (**destructive**: ask the owner first).

## Add a device
Dashboard → **Пристрої** → name → **Створити токен**; the box shows the commands with the site's address and the token (the token is shown once and works until the device is revoked).
- **A computer** (macOS / Linux): `curl -fsSL https://raw.githubusercontent.com/Pavlo577/modToken/main/worker/scripts/install.sh | bash -s -- https://<site> <token>`; Windows: the PowerShell line from the box (`scripts/install.ps1`). It writes the OpenTelemetry settings with the token into `~/.claude/settings.json` and installs the mod as a plugin from `~/.claude/mods`; run it again to update. Then `claude plugin update token-tracker@token-tracker-local` and restart Claude Code.
- **Codex CLI** on a computer, the same device token: `curl -fsSL https://raw.githubusercontent.com/Pavlo577/modToken/main/worker/scripts/install-codex.sh | bash -s -- https://<site> <token>` (Windows: `scripts/install-codex.ps1`, the line from the box). It adds an `[otel]` table that exports Codex's log events here to `~/.codex/config.toml`, between marker lines (running it again replaces them); a config with an `[otel]` of its own is left alone and the script says what to add. Then restart Codex.
- **A cloud session** (claude.ai/code): the box shows a setup script (`scripts/cloud-setup.sh`) and the environment variables (OTLP settings, the token, `CLAUDE_CODE_PLUGIN_DIRS`); the environment's Network access must allow the site.
- **By hand**: the `env` block shown in the box goes into `~/.claude/settings.json`, or the same variables in a shell.
New sessions start sending after a restart of Claude Code. `/tracker-import` (the mod) or **Імпорт історії** (the dashboard) adds the history from before.

### History and its limits
- **Import of local history**: two ways, same result: the mod's `/tracker-import`, or Devices tab → *Імпорт історії* (pick the device and the folder `~/.claude/projects`). The logs are parsed on the device (`worker/src/history.ts`, never on the server); only numbers, the model name and ids are sent (`POST /v1/import` or `/api/admin/import`, idempotent). Turns from the time the device already reports through OTLP are skipped, so nothing is counted twice.
- **Since when OTLP counts**: `devices.otlp_since` is the first OTLP call of a device. Charts draw a dashed vertical line there: tokens before it (imported or from an older collector) may be incomplete.
- **Time step of the main chart** (`worker/web/lib/steps.ts`): *День* offers every record and 1 h; *Тиждень*, *Місяць* and *Свій* (more than a day) also 12 h and 24 h; the year is daily. 1 h, 12 h and 24 h are summed from the hourly buckets already loaded; "every record" reads `GET /api/admin/turns?last=1` (the latest 5000 turns). *День* pages through days with ‹ ›; **Скинути** (back to today) appears while another day is shown.
- **Calendars and the pager** do not go further back than the month of the oldest turn (`GET /api/admin/bounds`) and stop at the current month.
- **D1 rows read** are limited per day on the free plan (5 million): queries on the hot path use indexes, Insights is cached for two minutes (`?fresh=1` skips the cache). See `AGENTS.md`.

Privacy: the counting keeps only token counts, model, ids, times and the cost the agent states. The events database keeps, per event, only numbers, flags and short identifier-like words (tool names, durations, sizes, status codes); never who the user is, prompt or answer text, or anything with spaces or an address (`safeAttrs` in `worker/src/otlp.ts`, tested). Prompt text is never requested (`OTEL_LOG_USER_PROMPTS` is not set). Claude Code attaches `user.email` and account ids to its events and offers no switch for the email; the Worker drops them on arrival and stores nothing of them.

## Develop (from `worker/`)
```
bun install && bun run db:local            # local D1 (both databases)
npx wrangler dev --port 8787               # DEV_EMAIL in .dev.vars acts as the signed-in user
bash test/otlp.sh                          # end to end on a fresh DB: rm -rf .wrangler/state && bun run db:local
node test/seed.mjs                         # demo data, sent as OTLP
npm test && bun test && bun run typecheck && bun run build
```
`bash test/gate.sh` runs against `wrangler dev` started without `DEV_EMAIL` (move `.dev.vars` away) and checks the Access gate and that `/v1/*` needs a device token.
