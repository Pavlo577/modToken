# Requests for the main files

An agent branch (`codex`, `mistral`, ...) must not edit files outside its own area (see `/AGENTS.md`). When its work needs such a change, the agent **writes a request** here instead, and Claude (owner of the main files) makes the change on the `claude` branch or says why not.

- One file per agent, edited only by that agent: `requests/<agent>.md`. Claude answers in the pull request and on the `claude` branch, never by editing your file.
- Newest request at the top. Mark `Status: done` yourself once you see the change in `dev`.
- Repeat open requests in the pull request description under `Requests for the main files`.

## Entry format
```
## <short title>
Status: open            (open | done | declined: <why>)
Needs: <file or area, e.g. collectors/lib/contract.mjs, worker/web/core/palette.ts, worker/public/admin/prices.json>
What: <exactly what must change; the field, the value, the behaviour>
Why: <what in your agent depends on it>
Patch: <optional: a diff or the lines you propose>
Blocks: <what you cannot finish without it, or "nothing, carrying on">
```

## Typical requests
- a dashboard label and colour for a new agent (`worker/web/core/palette.ts`);
- prices of the agent's models (`worker/public/admin/prices.json`);
- a new field in the data contract (`collectors/DATA.md`, `collectors/lib/contract.mjs`, and the Worker `worker/src/events.ts`, `schema.sql`);
- a change in the shared program (`token-tracker.mjs`, `wizard.mjs`, `lib/core.mjs`).
