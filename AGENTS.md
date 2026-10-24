# Token Tracker: who works on what

A tracker of AI-agent token usage from many devices, in one place: a Cloudflare Worker + D1 database + a static dashboard (`worker/`), a mod for Claude Code (`hooks/`, `cloud/`, `import-logs.mjs`), and a collector program for the other agents (`collectors/`, one module per agent). Site: https://track.brolafkodev.pp.ua. User-facing text is Ukrainian, code, comments and docs are English.

## Branches: one branch per agent, each agent works only in its own
| Branch | Who | Works on (and only on) |
|---|---|---|
| `claude` | Claude Code | `worker/**` (Worker, D1 schema, dashboard), `hooks/**`, `cloud/**`, `import-logs.mjs`, and the shared collector layer below |
| `codex` | Codex | everything Codex-specific: `collectors/agents/codex.mjs`, `collectors/lib/{toml-notify,notify-chain,hooks-json}.mjs`, `worker/public/admin/parse-codex.mjs`, `worker/test/{codex,notify,hook}.test.mjs`, `worker/test/codex-collector.sh`, `collectors/AGENTS.md` (its brief) |
| `mistral`, `gemini`, ... | one agent each, created when that agent starts | its own `collectors/agents/<agent>.mjs`, its helpers `collectors/lib/<agent>-*.mjs`, its tests `worker/test/<agent>*.test.mjs`. **Each agent implements its own way of collecting tokens**: a different file format, OpenTelemetry, an API; nothing forces it to look like Codex's |
| `dev` | integration | `claude` is merged here once it is green (a fast-forward when nothing else changed) |
| `main` | live | goes live (Cloudflare builds and deploys it); **only the user says when** |

Rules (for every agent, Claude included):
- Create your branch from `dev`, commit only there, push only your own branch. **Your work reaches the project through a pull request into the `claude` branch** (Claude Code is the integrator: it reviews the pull request against these rules, merges it, runs the tests and brings `claude` into `dev`). Never push to `main`, never push to another agent's branch, never merge your own pull request.
- Stay inside your area. If you need a change outside it, describe it in your pull request and stop; the owner makes it. In particular a new agent asks Claude for its label and colour in the dashboard (`worker/web/core/palette.ts`) and for any Worker/schema change.
- **Shared collector layer (owner: `claude`; a change from another branch is a request, not an edit)**: `collectors/token-tracker.mjs`, `collectors/wizard.mjs`, `collectors/lib/{core,contract,notify-log}.mjs`, `collectors/DATA.md`, `.github/workflows/collector-release.yml`. This layer defines what may be sent and how the program starts, links and reports; every agent plugs into it. The one edit every agent is allowed to make there is registering itself in `collectors/agents/index.mjs` (one import and one array entry).
- **The data contract is the same for every agent**: `collectors/DATA.md` and `collectors/lib/contract.mjs` say exactly which fields may leave a machine. A new agent returns rows in that shape; if it needs a field the contract lacks, that is a request to the owner of the shared layer and of the Worker, never a workaround.
- Shared file: `worker/public/admin/parse-codex.mjs` is Codex's session parser, also used by the dashboard's browser import. Codex owns it; a change needs `worker/test/codex.test.mjs` green and a pull request that says what changed in the counting.
- Never commit secrets, device tokens, real session files or anything with prompt text. Test fixtures are synthetic.

### Adding an agent (checklist)
1. `git checkout -b <agent> dev`; read `collectors/DATA.md` and `collectors/agents/codex.mjs` as the example of the shape (`id, title, home, detect, sync, status`), not as a template to copy.
2. Write `collectors/agents/<agent>.mjs` (+ `collectors/lib/<agent>-*.mjs` if needed) returning `TurnRow`s and, if the agent reports them, `LimitReading`s, and add it to `collectors/agents/index.mjs`.
3. Tests in `worker/test/<agent>*.test.mjs` with synthetic fixtures, including one that plants a secret word in the fixture and checks that it never reaches the request body, the state files or the log.
4. Ask Claude for the dashboard label/colour and prices (`worker/public/admin/prices.json`) of the agent's models.

## Privacy (hard rules, not preferences)
Only numbers leave a machine: token counts, timestamps, model names, ids, limits. Never read into a result, send, print or log: prompts, answers, tool output, `cwd`, file contents. The JSON that Codex passes to `notify` and to hooks holds the prompt and the answer: it may be parsed in memory for yes/no flags, never stored. The diagnostic log (`~/.token-tracker/notify.log`) holds service fields only; tests check that no secret word reaches it.

## Commands (from `worker/`)
- `npm test` (Node's runner, the official one) and `bun test` must both pass; `bun run typecheck`.
- Local site for end-to-end tests: `bun run db:local` once, then `npx wrangler dev --port 8787` (`DEV_EMAIL` comes from `.dev.vars`); `bash test/codex-collector.sh` needs a fresh DB each time (`rm -rf .wrangler/state && bun run db:local`) and also runs against the compiled program: `COLLECTOR_BIN=path/to/token-tracker bash test/codex-collector.sh`.
- Build the program: `bun build --compile --minify --target=bun-linux-x64 ../collectors/token-tracker.mjs --outfile /tmp/token-tracker` (Windows and macOS targets are built by the GitHub Action).
