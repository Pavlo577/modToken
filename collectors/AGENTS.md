# The collector (`token-tracker`): the brief for the `codex` branch

This file is for whoever works on the **`codex` branch** (the Codex side of the collector). Branch rules and the split between the agents are in `/AGENTS.md`: you own the Codex-specific files listed there; the shared layer (`token-tracker.mjs`, `wizard.mjs`, `lib/{core,contract,notify-log}.mjs`, `DATA.md`, the release workflow) is owned by the `claude` branch, so a change there is a request: write it to `requests/codex.md` (format in `requests/README.md`) and in the pull request, do not edit those files. Your work goes to the project through a pull request into the **`claude`** branch.

A small program that sends the token usage of AI coding agents (now: OpenAI Codex) to the tracker site. One file for the user: built with `bun build --compile` from `token-tracker.mjs` (no Node on the user's machine), released as `token-tracker-{windows-x64.exe,macos-arm64,macos-x64,linux-x64,linux-arm64}` by `.github/workflows/collector-release.yml` (Actions → Collector release → Run workflow with `tag` = `collector-vX.Y.Z`; tag pushes from the cloud sandbox are blocked). Read `/AGENTS.md` first (branches, privacy, commands).

## What it does for the user
Double click → a guide (`wizard.mjs`, Ukrainian): first run links the device with a code from the site (Devices tab), sends the existing history, offers the automatic update; later runs show a status screen and send what is new. Commands for scripts: `link <CODE> [--url]`, `sync [--full] [--file <rollout>]`, `status`, `setup`, `log`, `hook-stop`, `notify`.

## Layout
- `token-tracker.mjs` the entry (CLI, `notify`, `hook-stop`). `codex.mjs` is only the old name (imports it).
- `wizard.mjs` the interactive guide and status screen. `agents/index.mjs` the list of agents; `agents/codex.mjs` everything Codex-specific (rollout files, sync, `notify` and `hooks.json` editing). **A new agent is a file next to it with the same shape** (`id, title, home, detect, sync, status, ...`) added to `index.mjs`.
- `lib/core.mjs` paths (`~/.token-tracker`, `TOKEN_TRACKER_HOME`), link, post, lock, how the program starts itself (`self`, handles the compiled program on every OS: the Windows url shows `~BUN` as `%7EBUN`). `lib/toml-notify.mjs` reads/writes the top-level `notify = [...]` of `config.toml` without a TOML library. `lib/notify-chain.mjs` how our notify sits next to others (`--then`, Codex Desktop's `--previous-notify` form). `lib/hooks-json.mjs` our `Stop` hook in `hooks.json`. `lib/notify-log.mjs` the diagnostic log.
- The parser lives in `../worker/public/admin/parse-codex.mjs` (shared with the browser import).

## Contract with the Worker (change only together with the other owner)
**What exactly is sent, field by field, with examples and the Codex mapping: `collectors/DATA.md`. In code: `lib/contract.mjs` (types + an allow-list that `post()` applies to every row and limit, so an unlisted field can never leave the machine; extend it deliberately, with a test).** Short form:
- `POST {url}/api/link` body `{"code": "..."}` → `200 {"token","device"}`; `403` wrong/used/expired code. The token is a device token: kept in `~/.token-tracker/config.json` with mode 600, never printed.
- `POST {url}/api/ingest` header `x-device-token`, body `{"rows":[...], "limits":[...]}` (or just an array of rows). At most 500 rows per call (the collector sends 300), at most 8 limits. `401` = revoked token (tell the user to link again).
- Row: `provider` (`claude|codex|gemini|mistral|opencode`; missing = claude), `turn_id` (unique per device; Codex: `codex:<thread>:<turn>`), `session_id`, `ts` (ISO), `model`, `input_tokens` (**without** the cached part), `output_tokens` (includes reasoning), `cache_read_tokens`, `cache_creation_tokens`, `duration_ms`, `is_subagent`. A row sent again with larger numbers raises them (MAX), so a growing turn may be resent; equal ones change nothing.
- Limit: `{provider, kind: "five_hour"|"seven_day", percentUsed, resetsAt (ISO or "")}`; only a changed reading needs sending.
- The dashboard groups by **device name**: the Codex link must use the same name as the Claude device so the numbers merge.

## How Codex tells us a turn ended (verified in `openai/codex` source, not on every real install)
1. **`Stop` hook (preferred).** `~/.codex/hooks.json`: `{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"<line>","timeout":10}]}]}}`; only the keys `description` and `hooks` are allowed at the top. Codex runs the line through `cmd.exe /C "<line>"` (Windows) or `sh -lc` and writes JSON on stdin: `session_id, turn_id, model, cwd, transcript_path (the rollout file), last_assistant_message, stop_hook_active, permission_mode, hook_event_name`. No token counts: they are read from the rollout. **A Stop hook must print nothing and exit 0** (JSON with `decision: "block"` makes Codex continue). Several hooks coexist; a new hook may need the user's trust confirmation in Codex.
2. **`notify` (fallback, older Codex).** `config.toml` `notify = [argv...]`, ONE command only, Codex appends one JSON argument (type, thread-id, turn-id, cwd, input-messages, last-assistant-message). Codex Desktop's own `codex-computer-use.exe turn-ended` takes this slot and rewrites it into `[..., "--previous-notify", "<JSON array of the previous command>"]`, moving our command into that argument; its path contains a hash that changes on updates. We chain with `--then <old command>` (or the helper's own form), keep a copy of `config.toml`, and can restore it exactly.
3. Plain `sync` on every open of the program catches up in any case (mtime+size of each rollout and a sent-signature per turn make it cheap and idempotent).

## Known gaps / what to do next (suggested order)
1. **Verify on a real Windows Codex Desktop 0.146+**: that the `Stop` hook is run (trust prompt, exit code, the `cmd.exe /C` quoting with a path like `...\Downloads\token-tracker-windows-x64 (2).exe`), what `transcript_path` holds, whether `notify` still fires next to it. Record findings here and fix what differs.
2. macOS and Windows builds are only built, never run by the author (no machine): run them; Gatekeeper/SmartScreen notes are in the README.
3. Offer a scheduled sync (Windows Task Scheduler / launchd / systemd timer) as a third way when neither hook nor notify works.
4. Next agents as `agents/<name>.mjs`: **Gemini CLI** via its OpenTelemetry local file (`telemetry.enabled`, `target: local`, `outfile`, **`logPrompts: false`**: it defaults to true and would write prompts; event `gemini_cli.api_response`, input includes cached, need a real `telemetry.log` first); **Mistral Vibe**: interactive sessions hold no usage, only OTLP traces or `export.json`: deferred. The Worker already accepts the `gemini` and `mistral` providers; the dashboard needs a label and colour for each (`worker/web/core/palette.ts`, owned by the other side).
5. Prices of new models live in `worker/public/admin/prices.json` (other side; `bun run prices` updates the OpenAI ones).

## Tests worth keeping green
`worker/test/codex.test.mjs` (parser), `notify.test.mjs` (toml, chaining, log), `hook.test.mjs` (hooks.json, `hook-stop`), `codex-collector.sh` (end to end, script and compiled). They share one temporary Codex home through `worker/test/codex-home.mjs` (the collector reads `CODEX_HOME` when loaded).
