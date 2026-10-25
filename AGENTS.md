# Token Tracker (OTLP): notes for agents working here

A tracker of AI-agent token usage from many devices, built only on OpenTelemetry: a Cloudflare Worker + D1 + a static dashboard (`worker/`), and `docs/OTLP.md` for the data. No collector program, mod or hook (the older design lives on the `claude` / `dev` branches). The one exception to "data only from OTLP" is the history import in the dashboard: it parses Claude Code's local logs **in the browser** (`src/history.ts`) and sends numbers only; never move that parsing to the server. User-facing text is Ukrainian; code, comments and docs are English.

## Rules
- **Only numbers are kept**: token counts, timestamps, model names, ids. Never store, print or log prompts, answers, tool output, `cwd`, file contents, emails or account ids. The one thing that cannot be avoided, decided by the user: Claude Code adds `user.email` and account ids to its events; the Worker drops them on arrival (`worker/src/otlp.ts`: an allow-list, not a block-list) and the tests check it.
- The events database (`EVENTS`) keeps every event's attributes through `safeAttrs` only: numbers, flags and identifier-like words, never identity or text. Do not widen that filter; add a test with a planted secret if you touch it.
- **Every field an agent sends is listed in `worker/src/otlp-fields.ts`** (the registry: name, events, type, meaning, what the Worker does with it). A new field is added there, then `bun run fields` regenerates `docs/OTLP-fields.md` (never edit that file by hand); `test/fields.test.mjs` fails when the registry and the code disagree, and the Insights tab lists fields that arrive but are missing from the registry.
- A new agent is a new adapter in `worker/src/otlp.ts` (`ADAPTERS`, keyed by `service.name`) that returns `ModelCall`s, a test with a synthetic payload that plants a secret word and checks it never reaches the result, and a row in `docs/OTLP.md`. Event and attribute names must come from the agent's own documentation or a real payload, never a guess.
- Never commit secrets, device tokens or real session data. Test fixtures are synthetic.
- Push to `main` (it goes live) only when the user says so. Applying `migrations/*.sql` to the production database needs the user's explicit confirmation.

## Commands (from `worker/`)
- `npm test` and `bun test` must both pass; `bun run typecheck`.
- End to end: fresh local DB (`rm -rf .wrangler/state && bun run db:local`), `npx wrangler dev --port 8787` (`DEV_EMAIL` from `.dev.vars`), then `bash test/otlp.sh`; `bash test/gate.sh` against a server started without `DEV_EMAIL`.
- The dashboard is built by `bun run build` (web/ → public/admin/app.js, not committed).
