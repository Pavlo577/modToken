# Token Tracker: who works on what

A tracker of AI-agent token usage from many devices, in one place: a Cloudflare Worker + D1 database + a static dashboard (`worker/`), a mod for Claude Code (`hooks/`, `cloud/`, `import-logs.mjs`), and a collector program for other agents (`collectors/`). Site: https://track.brolafkodev.pp.ua. User-facing text is Ukrainian, code, comments and docs are English.

## Ownership (to keep two people's work apart)
| Area | Owner |
|---|---|
| `collectors/**`, `.github/workflows/collector-release.yml`, `worker/test/{codex-home,notify,hook}.test.mjs`, `worker/test/codex-collector.sh`, the collector part of `README.md` | **Codex** (this file's reader): see `collectors/AGENTS.md`, the data it sends: `collectors/DATA.md` |
| `worker/**` (Worker, D1 schema, dashboard), `hooks/**`, `cloud/**`, `import-logs.mjs` | Claude Code + the user |

Rules:
- Work on a branch named `collector` made from `dev`; open pull requests into `dev`. Never push to `main`: it goes live (Cloudflare builds and deploys it) and only the user says when.
- Do not edit the other owner's areas. If the collector needs a change there (an API field, a new agent label in the dashboard, a schema column), describe it in the pull request and stop; the other side makes it.
- Shared file: `worker/public/admin/parse-codex.mjs` is the Codex session parser used by the collector **and** by the browser import of the dashboard. Changes are welcome but `worker/test/codex.test.mjs` must stay green and the pull request must say what changed in the counting.
- Never commit secrets, device tokens, real session files or anything with prompt text. Test fixtures are synthetic.

## Privacy (hard rules, not preferences)
Only numbers leave a machine: token counts, timestamps, model names, ids, limits. Never read into a result, send, print or log: prompts, answers, tool output, `cwd`, file contents. The JSON that Codex passes to `notify` and to hooks holds the prompt and the answer: it may be parsed in memory for yes/no flags, never stored. The diagnostic log (`~/.token-tracker/notify.log`) holds service fields only; tests check that no secret word reaches it.

## Commands (from `worker/`)
- `npm test` (Node's runner, the official one) and `bun test` must both pass; `bun run typecheck`.
- Local site for end-to-end tests: `bun run db:local` once, then `npx wrangler dev --port 8787` (`DEV_EMAIL` comes from `.dev.vars`); `bash test/codex-collector.sh` needs a fresh DB each time (`rm -rf .wrangler/state && bun run db:local`) and also runs against the compiled program: `COLLECTOR_BIN=path/to/token-tracker bash test/codex-collector.sh`.
- Build the program: `bun build --compile --minify --target=bun-linux-x64 ../collectors/token-tracker.mjs --outfile /tmp/token-tracker` (Windows and macOS targets are built by the GitHub Action).
