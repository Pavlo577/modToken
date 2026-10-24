# What the collector sends (the data structure)

The single source of truth in code is `lib/contract.mjs` (types in JSDoc, an allow-list that **every** outgoing byte passes through in `post()`); this file explains it with examples. The Worker side that receives it: `worker/src/ingest.ts`, `events.ts`, `util.ts`; the table: `token_events` in `worker/schema.sql`.

## 1. Link (once per device)
```
POST {site}/api/link        {"code": "A1B2C3D4E5"}
→ 200 {"token": "<64 hex>", "device": "home-pk"}      403 = wrong, used or expired code
```
The code is made by the user on the site (Devices tab) and is good for 10 minutes, once. The token is the device's password: saved in `~/.token-tracker/config.json` (mode 600), sent only as the `x-device-token` header, never printed, logged or put in an error text.

## 2. Ingest (every sync)
```
POST {site}/api/ingest      header x-device-token: <token>
{
  "rows": [ <TurnRow> ... ],        // 1..500, the collector sends 300 at a time
  "limits": [ <LimitReading> ... ]  // optional, at most 8
}
→ 204        401 = token revoked (the user must link again)       400 = a row was refused (bad time / unknown agent / too many rows)
```
An empty `rows` is allowed only together with `limits`.

### TurnRow: one turn of the agent = one row
```json
{
  "provider": "codex",
  "turn_id": "codex:01a16d7a-a908-7e72-b4e3-33ebbe759158:0199-turn-id",
  "session_id": "01a16d7a-a908-7e72-b4e3-33ebbe759158",
  "ts": "2026-10-24T10:37:05.123Z",
  "model": "gpt-5.6-sol",
  "input_tokens": 86013,
  "output_tokens": 5189,
  "cache_read_tokens": 467328,
  "cache_creation_tokens": 0,
  "duration_ms": 106243,
  "is_subagent": false
}
```
| Field | Meaning | Rule |
|---|---|---|
| `provider` | the agent | one of `claude codex gemini mistral opencode`; a missing value means `claude` |
| `turn_id` | identity of the turn **on this device** | stable: the same turn must always get the same id (Codex: `codex:<thread>:<turn id>`); different turns must never share one. Max 200 chars |
| `session_id` | the conversation the turn belongs to | Codex: the thread id. Max 200 chars |
| `ts` | when the turn ended | ISO 8601 UTC; time of the last model response of the turn |
| `model` | model name as reported | `unknown` if the agent gave none. Max 200 chars |
| `input_tokens` | NEW input tokens | **excludes** the cached part: `input - cached - cache_write`, never negative |
| `output_tokens` | output tokens | includes the reasoning tokens (do not add them again) |
| `cache_read_tokens` | input served from the cache | Codex `cached_input_tokens` |
| `cache_creation_tokens` | input written to the cache | Codex `cache_write_input_tokens`; 0 if the agent has none |
| `duration_ms` | how long the turn took | Codex `task_complete.duration_ms`; else last response minus the start |
| `is_subagent` | a helper thread of another turn | from the session metadata (`parent_thread_id`, `agent_path`, `source.subagent`), never from text |

All numbers are integers ≥ 0 (anything else becomes 0 in the Worker). **Resending is safe and expected:** a turn that grew since the last send is sent again with the same `turn_id` and the larger numbers; the Worker keeps the maximum of each counter, so equal or smaller numbers change nothing and nothing is counted twice. Do not send a turn twice under two different ids.

### LimitReading: the subscription limit (only when the agent reports one, send only when it changed)
```json
{ "provider": "codex", "kind": "five_hour", "percentUsed": 3, "resetsAt": "2026-10-24T15:57:00.000Z" }
{ "provider": "codex", "kind": "seven_day", "percentUsed": 0, "resetsAt": "2026-10-31T10:00:00.000Z" }
```
`kind` is only `five_hour` or `seven_day`. `percentUsed` 0..100. `resetsAt` ISO UTC or `""`. A reading with no limits (API-key use) is simply not sent: its absence is how the dashboard knows the billing type is unknown.

## 3. Codex: where each value comes from (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, also `archived_sessions/`)
Done by `worker/public/admin/parse-codex.mjs` (shared with the dashboard's browser import; its header explains every rule). In short:
- `session_meta.payload.id` → `session_id`; its timestamp = when the file began; `parent_thread_id` / `agent_path` / `source.subagent` → `is_subagent`.
- `turn_context.payload.{turn_id, model}`, `event_msg` `task_started` / `task_complete` (`turn_id`, `duration_ms`) → turn identity, model, duration.
- `event_msg` with `payload.type == "token_count"` → `info.total_token_usage` (**cumulative per thread**) and `info.last_token_usage` (last request only); `rate_limits` → limits. **A turn's tokens are the growth of the cumulative totals, not the sum of `last_token_usage`.** Rules: count only positive differences; an event whose totals did not change (only the limits did) counts nothing; events older than the file's start are a replayed parent history and only move the baseline; if a total goes down the thread restarted (count the last request); ignore `token_usage_record`. An event with no usable cumulative total (missing or malformed) still counts its own `last_token_usage`; the next event that has a total then counts only its own last request and adopts its total as the new baseline, so nothing is dropped and nothing is counted twice.
- `input_tokens` of Codex INCLUDES the cached part and `output_tokens` INCLUDES the reasoning part: hence `input_tokens(row) = input - cached - cache_write`.

## 4. Never send, read into a result, log or print
Prompts, `input-messages`, `last-assistant-message`, tool output, file contents, `cwd`, file names, the device token. The JSON passed by Codex to `notify` and to the `Stop` hook contains such text: look at it in memory for yes/no flags or for the session file path, drop the rest at once. `lib/contract.mjs` makes this structural for the upload (an unknown field is dropped); the diagnostic log has its own rule (see `lib/notify-log.mjs`).

## 5. Adding another agent
Make `agents/<name>.mjs` returning rows in exactly this shape (the contract above, with its own `provider` and `turn_id` prefix), reading only numeric fields from the agent's own files or telemetry. Prove "no text leaves" with a test that plants a secret word in the fixture and greps the request body, the state files and the log (see `worker/test/codex-collector.sh`).
