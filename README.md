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

## Other agents (Codex)
The site also takes the usage of **OpenAI Codex CLI**; a "provider" column says which agent wrote each turn, and the page gets an agent filter (shown when there is more than one) and a "By agent" card. Codex has no mods, so a small collector reads its own session files (`~/.codex/sessions`, `~/.codex/archived_sessions`) and sends only token counts, times, model names and ids, never prompts or answers. Subscription limits (5-hour and weekly) are taken from the same files when Codex wrote them.

**The easy way (no Node.js, nothing to install):** download the one-file program for your system from the repository's Releases page (`collector-v*`: `token-tracker-windows-x64.exe`, `-macos-arm64`, `-macos-x64`, `-linux-x64`, `-linux-arm64`; `SHA256SUMS` is next to them) and **open it** (double click; on macOS/Linux run it in a terminal). It is a small guide:
1. first start: it asks for a code (site, Devices tab, make a code with the **same device name** as your Claude device so the numbers merge), links the device, sends the existing history and offers to add one `notify = [...]` line to Codex's `config.toml` (a backup copy is made first; an existing `notify` of another program is never touched);
2. every later start: it sends what is new and shows the status (site, device, last sync, number of turns, whether `notify` is connected, last error). Between starts Codex wakes it by itself after each turn.

The program is not code-signed, so Windows SmartScreen / macOS Gatekeeper may warn on the first start (macOS: `xattr -d com.apple.quarantine token-tracker-macos-*`). Other agents (Gemini, ...) will be added to the same program.

For scripts the commands stay: `token-tracker link <CODE> [--url https://your-site]`, `sync [--full]`, `status`, `setup` (prints the `notify` line), or `node collectors/token-tracker.mjs ...` from a clone of this repository (`collectors/codex.mjs` is the old name, still works). Run `sync` from cron / Task Scheduler instead of `notify` if you prefer.

With nothing to install at all: Devices, "Import old data", pick the `~/.codex/sessions` folder. That is a manual one-off (no automatic updates, no limits).

The programs are built by `.github/workflows/collector-release.yml` (`bun build --compile`) when a tag `collector-vX.Y.Z` is pushed, or from the Actions page (Run workflow, with a tag to publish a release).

Codex's file format is internal and changes between versions; the parser (`worker/public/admin/parse-codex.mjs`) reads only the few fields it needs. Input is stored without the cached part (like Claude's "new input"), reasoning counts as output. Prices for GPT-5 models are in `prices.json`; models missing there are shown without a price. Existing databases need `worker/migrations/0002_provider.sql` once (a fresh one gets the column from `schema.sql`).

## Import old history
The mod only counts turns after a device is linked. To bring in earlier history from the device's own logs, run `/tracker-import` there (needs Node.js on that device; with the npm install of Claude Code it is always there). It reads `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`) with `import-logs.mjs` and sends only token counts, timestamps and model names. Nothing runs automatically; run it once after `/tracker-link`.

Without Node.js, or for logs copied from another machine, use the site instead: Devices, "Import old data", pick the device and the `projects` folder (`scp -r user@host:~/.claude/projects ./projects` brings a server's logs over). Both ways build the same turn ids, so running one after the other never counts a turn twice.

Only history from before the device was linked is imported (later turns are collected live), and a repeat import adds nothing. Imported turns are grouped by prompt; their duration is the time from the prompt to the last reply, so it includes waiting for approvals and can look longer than live-tracked turns.

## Code layout (worker/)
**Worker** (`src/`, TypeScript on Cloudflare): `index.ts` only routes. `ingest.ts` (device token: turns, limits, old-history import), `devices.ts` (create a device, link code), `events.ts` (turn rows and their SQL), `auth.ts` (Cloudflare Access login), `util.ts`, `env.ts`; `admin/` has one file per group of admin routes (`devices`, `data`, `stats`) and `index.ts` that checks the login and dispatches.

**Dashboard** (`web/`, TypeScript bundled with [bun](https://bun.sh): `bun install`, then `bun run build`; Cloudflare runs the same build on deploy). One folder per layer, with no import cycles:
- `lib/`: pure helpers without page state: `stats.ts` (grouping by the viewer's time zone, cost, limits; tested in Node), `types.ts`, `format.ts`, `dom.ts`, `api.ts`.
- `core/`: `state.ts` (what the viewer chose, saved in localStorage), `time.ts`, `range.ts` (the shown period), `store.ts` (loaded data, cached requests), `load.ts`, `palette.ts` (stable device colours), `actions.ts` (hooks the controls fill in, so data code can ask for a redraw without importing the controls).
- `charts/`: SVG charts (`line`, `bar`, `calendar`, `heat`, `donut`) on `base.ts` (tooltip, empty state) and `scale.ts` (axis maths). Each takes a container and redraws on resize.
- `ui/`: `controls.ts` (controls bar and tabs), `render.ts` (draws the open tab), `dropdown.ts`, `layout.ts`.
- `tabs/`: one file per tab (`overview`, `analytics` with `activity`, `money`, `sessions`, `devices`).
- `app.ts`: the entry, only wires the modules together.
Adding a tab: a file in `tabs/` with a render function, a `<section id="tab-...">` and a button in `public/admin/index.html`, one line each in `core/state.ts` (the tab list) and `ui/render.ts`.

Styles are one file, `public/admin/styles.css` (colours are variables at the top); `index.html` is the page shell; `prices.json` is USD per million tokens for the cost estimate (update when prices change). First time locally (in `worker/`): `bun install`, put `DEV_EMAIL=me@example.com` in `.dev.vars`, `bun run db:local` (creates the tables in the local database), `bun run build`. Then `bun run dev` serves it; `bun run typecheck` checks both parts; `node test/seed.mjs` fills a local dev server with demo data.

Subscription limits (5-hour and weekly percent used) are sent by the mod on devices with a subscription; cloud sessions do not report them.

## Tests
`bun run test` (in `worker/`) checks the log parser, including against real logs in `~/.claude/projects` when present. `worker/test/smoke.sh` runs against `wrangler dev` (put `DEV_EMAIL=me@example.com` in `worker/.dev.vars` first); `smoke.sh --gate` runs against a dev server started without it and checks that the admin API refuses unauthenticated and forged requests.
