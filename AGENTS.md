# Token Tracker: who works on what

A tracker of AI-agent token usage from many devices, in one place: a Cloudflare Worker + D1 database + a static dashboard (`worker/`), a mod for Claude Code (`hooks/`, `cloud/`, `import-logs.mjs`), and a collector program for the other agents (`collectors/`, one module per agent). Site: https://track.brolafkodev.pp.ua. User-facing text is Ukrainian, code, comments and docs are English.

## Branches and flow: agents work in their own branch and hand over through `claude`
| Branch | Who | Works on (and only on) |
|---|---|---|
| `claude` | Claude Code, the **integrator** | `worker/**` (Worker, D1 schema, dashboard), `hooks/**`, `cloud/**`, `import-logs.mjs`, and the shared collector layer below. Receives the other agents' pull requests |
| `codex` | Codex | everything Codex-specific: `collectors/agents/codex.mjs`, `collectors/lib/{toml-notify,notify-chain,hooks-json}.mjs`, `worker/public/admin/parse-codex.mjs`, `worker/test/{codex,notify,hook}.test.mjs`, `worker/test/codex-collector.sh`, `collectors/AGENTS.md` (its brief) |
| `mistral`, `gemini`, ... | one agent each, created when that agent starts | its own `collectors/agents/<agent>.mjs`, its helpers `collectors/lib/<agent>-*.mjs`, its tests `worker/test/<agent>*.test.mjs`. **Each agent implements its own way of collecting tokens**: a different file format, OpenTelemetry, an API; nothing forces it to look like Codex's |
| `dev` | integration | **only Claude merges here**, from `claude`, when `claude` is green |
| `main` | live | goes live (Cloudflare builds and deploys it); **only the user says when** |

The flow, always in this direction:
```
<agent branch> --pull request--> claude --(Claude, when green)--> dev --(the user says "push to main")--> main
```
1. An agent creates its branch from `dev`, commits and pushes **only its own branch**.
2. When a piece of work is ready it opens a **pull request into `claude`** (never into `dev` or `main`). It never merges its own pull request.
3. Claude reviews it (checklist below), merges it into `claude`, runs the tests, and brings `claude` into `dev`. The agent then rebases/merges `dev` into its branch before the next piece.
4. `main` is the user's decision alone.

Rules (for every agent, Claude included):
- Stay inside your own area (table above). Never push to `main`, to `dev`, or to another agent's branch (Claude, as the integrator, is the only one who writes to `dev`).
- **Do not edit the main (shared) files; write a request instead.** The main files are everything outside your area: the Worker and dashboard (`worker/**` except your own parser/tests), the Claude mod, and the shared collector layer. If your work needs a change there (a new field in the contract, a dashboard label and colour for your agent, a schema column, a different behaviour of the program, a price), do all of this:
  - add an entry to **your own** file `requests/<agent>.md` (format in `requests/README.md`): which file, what exactly must change, why, and a suggested patch if you have one;
  - repeat it in the pull request description under the heading `Requests for the main files`;
  - where the change would go, you may leave a one-line comment `// REQUEST(<agent>): <what and why>` **in your own files** next to the code that depends on it, but not in the main files;
  - then carry on with the part that does not depend on it. Claude makes the change in `claude` (or answers why not) and the request is marked done.
- **Shared collector layer (owner: `claude`)**: `collectors/token-tracker.mjs`, `collectors/wizard.mjs`, `collectors/lib/{core,contract,notify-log}.mjs`, `collectors/DATA.md`, `.github/workflows/collector-release.yml`. This layer defines what may be sent and how the program starts, links and reports; every agent plugs into it. The one edit every agent may make there is registering itself in `collectors/agents/index.mjs` (one import and one array entry).
- **The data contract is the same for every agent**: `collectors/DATA.md` and `collectors/lib/contract.mjs` say exactly which fields may leave a machine. A new agent returns rows in that shape; a missing field is a request, never a workaround.
- Shared file: `worker/public/admin/parse-codex.mjs` is Codex's session parser, also used by the dashboard's browser import. Codex owns it; a change needs `worker/test/codex.test.mjs` green and a pull request that says what changed in the counting.
- Never commit secrets, device tokens, real session files or anything with prompt text. Test fixtures are synthetic.

### Standing instruction for Claude Code (given by the user)
After reviewing another agent's code (a pull request into `claude`), Claude merges it into `claude`, runs the tests, and **pushes to `dev` straight away, without asking again**. Pushing to `main` is still only on the user's explicit command. Claude cannot create or delete tags and branches on GitHub from its sandbox (the proxy blocks it); releases are started by the user from the Actions page.

### What Claude checks in a pull request
Only its own area was touched (plus the one line in `agents/index.mjs`); the data contract is respected and no new field leaves the machine; the privacy tests are there and green (`npm test`, `bun test`, `bun run typecheck`, the end-to-end `codex-collector.sh`-style test for the agent); the requests are written in `requests/<agent>.md` and in the description; no secrets or real session files.

### Adding an agent (checklist)
1. `git checkout -b <agent> dev`; read `collectors/DATA.md` and `collectors/agents/codex.mjs` as the example of the shape (`id, title, home, detect, sync, status`), not as a template to copy.
2. Write `collectors/agents/<agent>.mjs` (+ `collectors/lib/<agent>-*.mjs` if needed) returning `TurnRow`s and, if the agent reports them, `LimitReading`s, and add it to `collectors/agents/index.mjs`.
3. Tests in `worker/test/<agent>*.test.mjs` with synthetic fixtures, including one that plants a secret word in the fixture and checks that it never reaches the request body, the state files or the log.
4. Write to `requests/<agent>.md`: the dashboard label and colour of the agent, prices of its models (`worker/public/admin/prices.json`), and anything else the main files need.
5. Open a pull request into `claude`.

## Privacy (hard rules, not preferences)
Only numbers leave a machine: token counts, timestamps, model names, ids, limits. Never read into a result, send, print or log: prompts, answers, tool output, `cwd`, file contents. The JSON that Codex passes to `notify` and to hooks holds the prompt and the answer: it may be parsed in memory for yes/no flags, never stored. The diagnostic log (`~/.token-tracker/notify.log`) holds service fields only; tests check that no secret word reaches it.

## Commands (from `worker/`)
- `npm test` (Node's runner, the official one) and `bun test` must both pass; `bun run typecheck`.
- Local site for end-to-end tests: `bun run db:local` once, then `npx wrangler dev --port 8787` (`DEV_EMAIL` comes from `.dev.vars`); `bash test/codex-collector.sh` needs a fresh DB each time (`rm -rf .wrangler/state && bun run db:local`) and also runs against the compiled program: `COLLECTOR_BIN=path/to/token-tracker bash test/codex-collector.sh`.
- Build the program: `bun build --compile --minify --target=bun-linux-x64 ../collectors/token-tracker.mjs --outfile /tmp/token-tracker` (Windows and macOS targets are built by the GitHub Action).
