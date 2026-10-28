# Token Tracker (OTLP)

Token usage of AI agents (Claude Code now; Codex, Gemini and Mistral through their own OpenTelemetry adapters later) from many devices, in one dashboard. Everything arrives as **OpenTelemetry**: the agent exports its API-request events to the site, there is no program, mod or hook to install.

- **Worker** (`worker/src`): Cloudflare Worker + D1. `POST /v1/logs` receives OTLP/HTTP JSON; `/api/admin/*` serves the dashboard behind Cloudflare Access.
- **Dashboard** (`worker/web` → `worker/public/admin`): overview, analytics, **insights** (where the money goes, speed, tools, permissions, surfaces, hooks), cost, sessions, devices.
- **Two databases**: `DB` (devices, one row per turn with tokens and the agent's own cost) and `EVENTS` (every event with its harmless attributes, kept 90 days; `worker/events-schema.sql`). The Worker counts tokens without `EVENTS`; the Insights tab needs it.
- **Docs**: `docs/OTLP.md` says exactly what is received, what is kept and what is dropped.

## Deploy (once, by the owner)
1. Create the D1 databases `modtoken` and `modtoken-events`, put their ids in `worker/wrangler.jsonc`; `cd worker && bun install && npx wrangler d1 execute modtoken --remote --file=schema.sql && npx wrangler d1 execute modtoken-events --remote --file=events-schema.sql`.
2. Put the whole site behind Cloudflare Access except `/v1/*` (devices send there with their own token); set `TEAM_DOMAIN` and `POLICY_AUD` in `wrangler.jsonc`.
3. `bun run deploy` (or let Workers Builds deploy the branch). An existing database of the older collector/mod version: `migrations/0004_otlp_only.sql` drops the tables this project does not use (**destructive**).

## Add a device
Dashboard → **Пристрої** → name → **Створити токен**. Paste the shown block into `~/.claude/settings.json` (or set the shown variables in a shell or in a claude.ai/code environment, whose Network access must allow the site) and restart Claude Code. New sessions start sending after that.

### History and its limits
- **Import of local history**: Devices tab → *Імпорт історії*: pick the device and the folder `~/.claude/projects`. The logs are read in the browser; only numbers, the model name and ids are sent (`POST /api/admin/import`, one turn per assistant message, idempotent). Turns from the time the device already reports through OTLP are skipped, so nothing is counted twice.
- **Since when OTLP counts**: `devices.otlp_since` (migration `0007_otlp_since.sql`) is the first OTLP call of a device. Charts draw a dashed vertical line there: tokens before it (imported or from an older collector) may be incomplete.
- **Time step of the main chart**: for *День* 5, 15, 30, 60 min or every record; for *Тиждень* and *Місяць* the same plus 12 h and 24 h (`web/lib/steps.ts`). 60 min and longer come from the hourly buckets already loaded; 5, 15 and 30 min from `GET /api/admin/series` (cached a minute), every record from `GET /api/admin/turns?last=1` (the latest 5000). *День* pages through days with ‹ ›; **Скинути** (back to today) appears while another day is shown.
- **Calendars and the pager** do not go further back than the month of the oldest turn (`GET /api/admin/bounds`) and stop at the current month.

Privacy: the counting keeps only token counts, model, ids, times and the cost the agent states. The events database keeps, per event, only numbers, flags and short identifier-like words (tool names, durations, sizes, status codes); never who the user is, prompt or answer text, or anything with spaces or an address (`safeAttrs` in `worker/src/otlp.ts`, tested). Prompt text is never requested (`OTEL_LOG_USER_PROMPTS` is not set). Claude Code attaches `user.email` and account ids to its events and offers no switch for the email; the Worker drops them on arrival and stores nothing of them.

## Develop (from `worker/`)
```
bun install && bun run db:local            # local D1
npx wrangler dev --port 8787               # DEV_EMAIL in .dev.vars acts as the signed-in user
bash test/otlp.sh                          # end to end on a fresh DB: rm -rf .wrangler/state && bun run db:local
node test/seed.mjs                         # demo data, sent as OTLP
npm test && bun test && bun run typecheck
```
`bash test/gate.sh` runs against `wrangler dev` started without `DEV_EMAIL` and checks the Access gate and that `/v1/logs` needs a token.
