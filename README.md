# token-tracker

A small program (plus a Claude Code mod for the subscription limits) that records token usage and timing for every turn of Claude Code and Codex (session, model, input/output/cache tokens, duration) and sends it to your own Cloudflare Worker, so several devices and agents roll up under one account. The site (sign-in by email, invite only) shows the statistics and creates one-time codes that link devices.

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

## Use it (Claude Code and Codex on your own computer)
Two parts, one link:
- **The `token-tracker` program** (download it from Releases, see "Other agents" below) links the device, reads Claude Code's session logs (`~/.claude/projects`) and Codex's, and keeps itself up to date through each agent's **`Stop` hook**: Claude Code calls it after every turn with the path of the session log, the program sends the numbers of that turn. Double click it and answer the questions; it asks before it touches `~/.claude/settings.json` (a copy is made, other hooks stay) and sends the history from before the device was linked.
- **The mod** (optional, for the subscription limits): `/plugin marketplace add Pavlo577/modToken`, then `/plugin install token-tracker@modtoken`. The logs hold no rate limits, only the running Claude Code knows them, so the mod reads them after each turn and sends them when they change. It uses the site and the token of the program's config (`~/.token-tracker/config.json`), so you link only once, in the program. The site is fixed in the mod (`BACKEND_URL` in `hooks/register.ts`; change that line to host your own copy). Without the mod everything works except the limit cards and the "subscription" tag.

**Already used the mod (before 0.10)?** Update it (`/plugin update`) and start Claude Code once: the new mod hands your device's token over to the program (`~/.token-tracker/config.json`, with the moment it stops sending turns), so the program continues the **same** device. Then open the program and enable Claude Code: it collects every turn since that moment from the logs, nothing is lost and nothing is counted twice. Do **not** link the device again in the program: that would make a second device and count the history twice.

The mod's status line shows `token-tracker: ok` after the limits were sent. A device can be revoked on the site at any time.

## Cloud sessions (claude.ai/code)
Plugins from marketplaces are not installed in cloud sessions, so the mod cannot run there. Instead the cloud *environment* is set up once, and every session in it reports through a Stop hook (it runs at the end of each turn, not at the end of the conversation):
1. On the site: Devices, "Cloud sessions", create a token. The page shows the Setup script line and the token (once).
2. claude.ai/code, the environment's menu, Edit, **Setup script**: paste `curl -fsSL https://raw.githubusercontent.com/Pavlo577/modToken/main/cloud/setup.sh | bash -s -- https://your-site` (it downloads `cloud/stop-hook.mjs` and the parser and adds the hook to `~/.claude/settings.json`).
3. Same dialog, **Network secrets**: host = your site, a custom header named `x-device-token` with no prefix, value = the token. Anthropic's proxy adds the header outside the VM, so the token never enters the session.

Needs Node.js in the environment (cloud sessions ship it) and `raw.githubusercontent.com` reachable while the setup script runs. All sessions of the environment report as one device; revoking it on the site stops them. Set up each environment you use. Turns are keyed by session id, so a session that continues in a second log file (after a `cd`) is not counted twice, and a turn the log had not fully written yet is completed by the next report.

## The program and Codex
The site also takes the usage of **OpenAI Codex CLI** (and, through the same program, Claude Code as described above); a "provider" column says which agent wrote each turn, and the page gets an agent filter (shown when there is more than one) and a "By agent" card. Codex has no mods, so a small collector reads its own session files (`~/.codex/sessions`, `~/.codex/archived_sessions`) and sends only token counts, times, model names and ids, never prompts or answers. Subscription limits (5-hour and weekly) are taken from the same files when Codex wrote them.

**The easy way (no Node.js, nothing to install):** download the one-file program for your system from the repository's Releases page (`collector-v*`: `token-tracker-windows-x64.exe`, `-macos-arm64`, `-macos-x64`, `-linux-x64`, `-linux-arm64`; `SHA256SUMS` is next to them) and **open it** (double click; on macOS/Linux run it in a terminal). It is a small guide:
1. first start: it asks for a code (site, Devices tab, make a code with the **same device name** as your Claude device so the numbers merge), links the device, sends the existing history and offers to connect the automatic update. The recommended way is Codex's **`Stop` hook**: one entry in `~/.codex/hooks.json` (a copy of the file is made first, other programs' hooks are never touched, and several hooks live side by side). After each turn Codex runs `token-tracker hook-stop` and gives it a small JSON on stdin; the program uses only the path of the session file in it (to sync just that file), prints nothing, always exits with 0 and throws the answer text away. Codex may ask you once to trust the new hook. The older way, `notify`, stays as a fallback (menu item 4): Codex runs a single `notify` command; if another program already uses it (Codex Desktop's computer-use helper does), the guide offers to go first and start that command afterwards with the same arguments and the same JSON, or in the helper's own `--previous-notify` form, and the menu can switch it off again and put the old command back;
2. every later start: it sends what is new and shows the status (site, device, last sync, number of turns, whether `notify` is connected, last error). Between starts Codex wakes it by itself after each turn.

To see whether Codex really calls it: the status screen shows the last call (hook or `notify`) (time, whether the older command ended with code 0, whether the sync worked), and `token-tracker log` prints `~/.token-tracker/notify.log`, one line per event. The log holds only event names, times, exit codes and yes/no flags, never the JSON Codex passes (it has the prompt and the answer). If the helper that sits next to ours was moved by a Codex update, the status says so (menu item 3 reconnects).

The program is not code-signed, so Windows SmartScreen / macOS Gatekeeper may warn on the first start (macOS: `xattr -d com.apple.quarantine token-tracker-macos-*`). Other agents (Gemini, ...) will be added to the same program.

For scripts the commands stay: `token-tracker link <CODE> [--url https://your-site]`, `sync [--full]`, `status`, `setup` (prints the `notify` line), or `node collectors/token-tracker.mjs ...` from a clone of this repository (`collectors/codex.mjs` is the old name, still works). Run `sync` from cron / Task Scheduler instead of `notify` if you prefer.

With nothing to install at all: Devices, "Import old data", pick the `~/.codex/sessions` folder. That is a manual one-off (no automatic updates, no limits).

The programs are built by `.github/workflows/collector-release.yml` (`bun build --compile`) when a tag `collector-vX.Y.Z` is pushed, or from the Actions page (Run workflow, with a tag to publish a release).

Codex's file format is internal and changes between versions; the parser (`worker/public/admin/parse-codex.mjs`) reads only the few fields it needs. Input is stored without the cached part (like Claude's "new input"), reasoning counts as output. Prices for GPT-5 models are in `prices.json`; models missing there are shown without a price. Existing databases need `worker/migrations/0002_provider.sql` once (a fresh one gets the column from `schema.sql`).

## OTLP (optional second way in)
The Worker accepts OpenTelemetry logs (`POST /v1/logs`, OTLP/HTTP **JSON**, header `x-device-token` or `Authorization: Bearer <device token>`). For Claude Code the program sets it up (no log reading, no Stop hook):
```
token-tracker otlp enable      # writes the exporter into ~/.claude/settings.json, then restart Claude Code
token-tracker otlp status
token-tracker otlp disable     # removes it; "setup" brings the log collector back
```
The device token is **not** copied into `settings.json`: Claude Code runs `token-tracker otlp-headers` (setting `otelHeadersHelper`) to get it. If `settings.json` already has OpenTelemetry settings of its own they are left alone and `enable` stops. Claude Code attaches `user.email` and account ids to its events; the Worker drops them on arrival (they do cross the network, over HTTPS). One source per device and agent: `enable` removes our Stop hook and the log collector skips Claude. Sub-agent requests are told apart by `agent_id`. Details: `collectors/DATA.md` section 5. Apply `worker/migrations/0003_otlp.sql` before deploying.

## Import old history
The program does it for Claude Code by itself the first time (and `token-tracker import` repeats it): it reads `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`) and sends only token counts, timestamps and model names, as turns older than the device (the Worker keeps only those and ignores repeats, so running it again or on an old device is safe). The older way still works too: `/tracker-import` in the old mod (0.9) or `node import-logs.mjs`.

Without the program, or for logs copied from another machine, use the site: Devices, "Import old data", pick the device and the `projects` folder (`scp -r user@host:~/.claude/projects ./projects` brings a server's logs over). All ways build the same turn ids, so running one after the other never counts a turn twice.

Only history from before the device was linked is imported (later turns are collected by the Stop hook), and a repeat import adds nothing. Turns are grouped by prompt; their duration is the time from the prompt to the last reply, so it includes waiting for approvals and can look longer than the exact times Claude Code reported to the old mod.

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
