# Token Tracker (OTLP)

Token usage of AI agents (Claude Code now; Codex, Gemini and Mistral through their own OpenTelemetry adapters later) from many devices, in one dashboard. Everything arrives as **OpenTelemetry**: the agent exports its API-request events to the site, there is no program, mod or hook to install.

- **Worker** (`worker/src`): Cloudflare Worker + D1. `POST /v1/logs` receives OTLP/HTTP JSON; `/api/admin/*` serves the dashboard behind Cloudflare Access.
- **Dashboard** (`worker/web` → `worker/public/admin`): overview, analytics, cost, sessions, devices.
- **Docs**: `docs/OTLP.md` says exactly what is received, what is kept and what is dropped.

## Deploy (once, by the owner)
1. Create the D1 database `modtoken` and put its id in `worker/wrangler.jsonc`; `cd worker && bun install && npx wrangler d1 execute modtoken --remote --file=schema.sql`.
2. Put the whole site behind Cloudflare Access except `/v1/*` (devices send there with their own token); set `TEAM_DOMAIN` and `POLICY_AUD` in `wrangler.jsonc`.
3. `bun run deploy` (or let Workers Builds deploy the branch). An existing database of the older collector/mod version: `migrations/0004_otlp_only.sql` drops the tables this project does not use (**destructive**).

## Add a device
Dashboard → **Пристрої** → name → **Створити токен**. Paste the shown block into `~/.claude/settings.json` (or set the shown variables in a shell or in a claude.ai/code environment, whose Network access must allow the site) and restart Claude Code. New sessions start sending after that.

Privacy: only token counts, model, ids and times are kept. Prompt text is never requested (`OTEL_LOG_USER_PROMPTS` is not set). Claude Code attaches `user.email` and account ids to its events and offers no switch for the email; the Worker drops them on arrival and stores nothing of them.

## Develop (from `worker/`)
```
bun install && bun run db:local            # local D1
npx wrangler dev --port 8787               # DEV_EMAIL in .dev.vars acts as the signed-in user
bash test/otlp.sh                          # end to end on a fresh DB: rm -rf .wrangler/state && bun run db:local
node test/seed.mjs                         # demo data, sent as OTLP
npm test && bun test && bun run typecheck
```
`bash test/gate.sh` runs against `wrangler dev` started without `DEV_EMAIL` and checks the Access gate and that `/v1/logs` needs a token.
