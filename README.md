# token-tracker

A Claude Code mod that records token usage and timing for every turn (session, model, input/output/cache tokens, duration) and sends it to your own Cloudflare Worker, so several devices roll up under one account. The site (sign-in by email, invite only) shows the statistics and creates one-time codes that link devices.

```
device (mod) ──/api/ingest──▶ Worker ──▶ D1
browser ──Cloudflare Access (email PIN)──▶ /admin  (devices, dashboard)
```

## Deploy the backend (once, by the owner)
```bash
cd worker && npm install
npx wrangler d1 create modtoken            # put the printed database_id into wrangler.jsonc
npx wrangler d1 execute modtoken --remote --file=schema.sql
npx wrangler deploy
```
Then protect the admin in Cloudflare Zero Trust → Access → Applications → Self-hosted:
- Application paths: `track.brolafkodev.pp.ua/admin*` and `track.brolafkodev.pp.ua/api/admin*` (**not** `/api/ingest` and `/api/link`: devices authenticate with their own token).
- Login method: One-time PIN. Policy: Allow, Emails = the people you invite (add an email to invite someone).
- Copy the application's **Audience (AUD) tag** and your team domain (`https://<team>.cloudflareaccess.com`) into `TEAM_DOMAIN` and `POLICY_AUD` in `wrangler.jsonc`, then `npx wrangler deploy` again.

## Use it
1. Install the mod: `/plugin marketplace add Pavlo577/modToken`, then `/plugin install token-tracker@modtoken`.
2. Optional: `/tracker-setup https://<your-site>` if your site is not the default one in `hooks/register.ts`.
3. On the site: Devices → create a code (valid 10 minutes, links one device only).
4. On the device: `/tracker-link <code>`.

The status line shows `token-tracker: ok` after an upload. Failed uploads are queued and retried at the next session start. A device can be revoked on the site at any time.

## Cloud sessions (claude.ai/code)
Plugins from marketplaces are not installed in cloud sessions, so the mod cannot run there. Instead the cloud *environment* is set up once, and every session in it reports through a Stop hook (it runs at the end of each turn, not at the end of the conversation):
1. On the site: Devices, "Cloud sessions", create a token. The page shows the Setup script line and the token (once).
2. claude.ai/code, the environment's menu, Edit, **Setup script**: paste `curl -fsSL https://raw.githubusercontent.com/Pavlo577/modToken/main/cloud/setup.sh | bash -s -- https://your-site` (it downloads `cloud/stop-hook.mjs` and the parser and adds the hook to `~/.claude/settings.json`).
3. Same dialog, **Network secrets**: host = your site, a custom header named `x-device-token` with no prefix, value = the token. Anthropic's proxy adds the header outside the VM, so the token never enters the session.

Needs Node.js in the environment (cloud sessions ship it) and `raw.githubusercontent.com` reachable while the setup script runs. All sessions of the environment report as one device; revoking it on the site stops them. Set up each environment you use. Turns are keyed by session id, so a session that continues in a second log file (after a `cd`) is not counted twice, and a turn the log had not fully written yet is completed by the next report.

## Import old history
The mod only counts turns after a device is linked. To bring in earlier history from the device's own logs, run `/tracker-import` there (needs Node.js on that device; with the npm install of Claude Code it is always there). It reads `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`) with `import-logs.mjs` and sends only token counts, timestamps and model names. Nothing runs automatically; run it once after `/tracker-link`.

Without Node.js, or for logs copied from another machine, use the site instead: Devices, "Import old data", pick the device and the `projects` folder (`scp -r user@host:~/.claude/projects ./projects` brings a server's logs over). Both ways build the same turn ids, so running one after the other never counts a turn twice.

Only history from before the device was linked is imported (later turns are collected live), and a repeat import adds nothing. Imported turns are grouped by prompt; their duration is the time from the prompt to the last reply, so it includes waiting for approvals and can look longer than live-tracked turns.

## Dashboard (worker/web)
The admin page is TypeScript, bundled with [bun](https://bun.sh) (`bun install`, then `bun run build` in `worker/`; Cloudflare runs the same build on deploy). Layout:
- `worker/web/*.ts`: code (`app.ts` page logic, `charts.ts` SVG charts, `stats.ts` aggregation by the viewer's time zone, cost and limits maths, `devices.ts` the Devices tab).
- `worker/public/admin/styles.css`: all styles and colour variables, edit freely.
- `worker/public/admin/index.html`: page shell. `prices.json`: USD per million tokens used for the cost estimate (update when prices change).
First time locally (in `worker/`): `bun install`, put `DEV_EMAIL=me@example.com` in `.dev.vars`, `bun run db:local` (creates the tables in the local database), `bun run build`. Then `bun run dev` serves it locally; `bun run typecheck` checks both Worker and page code; `node worker/test/seed.mjs` fills a local dev server with demo data.

Subscription limits (5-hour and weekly percent used) are sent by the mod on devices with a subscription; cloud sessions do not report them.

## Tests
`bun run test` (in `worker/`) checks the log parser, including against real logs in `~/.claude/projects` when present. `worker/test/smoke.sh` runs against `wrangler dev` (put `DEV_EMAIL=me@example.com` in `worker/.dev.vars` first); `smoke.sh --gate` runs against a dev server started without it and checks that the admin API refuses unauthenticated and forged requests.
