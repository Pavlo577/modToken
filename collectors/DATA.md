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

## 3b. Claude Code: where each value comes from (`~/.claude/projects/**/*.jsonl`, or `$CLAUDE_CONFIG_DIR/projects`)
Done by `worker/public/admin/parse.mjs` (shared with the dashboard's browser import, `import-logs.mjs` and the cloud hook) through `collectors/agents/claude.mjs`:
- A turn = one user prompt and every reply of the model until the next prompt. Replies are keyed by the API message id: the same message logged once per content block (same `usage`) counts once (the largest of its figures), and a message that also appears in another log (a session copied after a `cd` or a resume) counts once, in the first log that has it.
- `input_tokens`, `output_tokens`, `cache_read_tokens` (`cache_read_input_tokens`), `cache_creation_tokens` (`cache_creation_input_tokens`) are summed over the replies of the turn; `input_tokens` is already the NEW input (Claude counts the cache apart). `model` = the model of the reply with the most output; `ts` = the time of the last reply; `duration_ms` = last reply minus the prompt (so it includes waiting for approvals); `is_subagent` = a sidechain reply was in the turn. Turns with no tokens and the `<synthetic>` replies are dropped. Prompt text is only looked at to find where a turn begins.
- Ids: live turns `cc:<log name = session id>:<n>`; the history `imp:<path of the log under projects>:<n>` (sent to `/api/import`, which keeps only turns older than the device and ignores repeats). `provider` = `claude`.
- Which turns are collected live: the ones that ended at or after `since` in `~/.token-tracker/config.json` (written when the device is linked, or by the mod when it hands a device over). Older ones are history.
- The subscription limits are not in the logs: the mod sends `{rows: [], limits}`, `kind` `five_hour` / `seven_day` (`$.session.usage().rateLimits`).

## 4. Never send, read into a result, log or print
Prompts, `input-messages`, `last-assistant-message`, tool output, file contents, `cwd`, file names, the device token. The JSON passed by Codex to `notify` and to the `Stop` hook contains such text: look at it in memory for yes/no flags or for the session file path, drop the rest at once. `lib/contract.mjs` makes this structural for the upload (an unknown field is dropped); the diagnostic log has its own rule (see `lib/notify-log.mjs`).

## 5. OTLP: what the Worker receives and keeps (a second way in; built for Claude Code, other agents get an adapter when their telemetry is verified)
An agent that has no readable session log (Gemini CLI, Mistral Vibe) or that cannot run our program (cloud sessions) can export OpenTelemetry instead, straight to the site. The Worker takes **OTLP/HTTP in JSON** (`POST /v1/logs`, header `x-device-token` as for `/api/ingest`) and turns it into the one structure below. Everything else in the payload is dropped on arrival, so the privacy boundary here is the Worker's allow-list, not the client (the program's `contract.mjs` is the client-side one).

**What arrives (OTLP/JSON, only `resourceLogs[].scopeLogs[].logRecords[]` matters).** Integers come as strings (`"intValue": "86013"`); an attribute is `{ "key", "value": { "stringValue" | "intValue" | "doubleValue" | "boolValue" } }`; the event name is the `event.name` attribute (accept it with or without the `claude_code.` prefix); the time is `timeUnixNano`.
```json
{ "resourceLogs": [{ "resource": { "attributes": [{ "key": "service.name", "value": { "stringValue": "claude-code" } }] },
  "scopeLogs": [{ "logRecords": [{
    "timeUnixNano": "1761300000123456789",
    "attributes": [
      { "key": "event.name",            "value": { "stringValue": "claude_code.api_request" } },
      { "key": "session.id",            "value": { "stringValue": "01a16d7a-..." } },
      { "key": "prompt.id",             "value": { "stringValue": "b7e0..." } },
      { "key": "request_id",            "value": { "stringValue": "req_01..." } },
      { "key": "model",                 "value": { "stringValue": "claude-sonnet-x" } },
      { "key": "input_tokens",          "value": { "intValue": "86013" } },
      { "key": "output_tokens",         "value": { "intValue": "5189" } },
      { "key": "cache_read_tokens",     "value": { "intValue": "467328" } },
      { "key": "cache_creation_tokens", "value": { "intValue": "0" } },
      { "key": "duration_ms",           "value": { "intValue": "10243" } },
      { "key": "user.email",            "value": { "stringValue": "dropped on arrival" } }
    ] }] }] }] }
```

**The structure the Worker extracts: one `ModelCall` per request to the model (agent-neutral).**
```ts
type ModelCall = {
  provider: 'claude' | 'codex' | 'gemini' | 'mistral'  // from the device's setting / resource service.name
  call_id: string        // idempotency key: the same call sent twice is counted once
  session_id: string     // the conversation
  turn_key: string       // what groups calls into one turn
  ts: string             // ISO UTC, from timeUnixNano
  model: string
  input_tokens: number           // NEW input only: the cached part excluded
  output_tokens: number          // reasoning included
  cache_read_tokens: number
  cache_creation_tokens: number
  duration_ms: number            // of this call
  is_subagent: boolean
}
```
| Field | Claude Code (**verified** in its monitoring docs: event `claude_code.api_request`) | Codex / Gemini CLI / Mistral Vibe (**not verified**: read their telemetry docs first) |
|---|---|---|
| `call_id` | `request_id` | the agent's request id; else a hash of `(session, timeUnixNano, sequence)` |
| `session_id` | `session.id` | the agent's session / thread attribute |
| `turn_key` | `prompt.id` | the agent's turn id / `prompt_id` (Gemini) / trace id (Mistral) |
| `ts` | `timeUnixNano` (or `event.timestamp`) | the same |
| tokens | `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_creation_tokens` | Gemini counts cached inside input: subtract it; Codex `input` includes cached too |
| `duration_ms` | `duration_ms` | the agent's duration attribute |
| `is_subagent` | false until the attribute is verified (**assumption**: `agent.name`) | from the agent's metadata, never from text |

**How calls become the turn row of section 2.** The Worker groups calls by `(device, provider, session_id, turn_key)`; the row has `turn_id = otlp:<provider>:<session_id>:<turn_key>`, `ts` = the last call's time, `model` = the model of the last call that had output, and the four token counters are **sums** of the calls (additive, unlike section 2 where a resend keeps the maximum). A call is added once: a table `otlp_calls (device_id, call_id)` (kept 14 days) records what was counted, and a call that is already there changes nothing. `duration_ms` is the sum of the calls' durations, so it is shorter than a log-based turn (which is prompt to last reply, waiting included): a device uses one source per agent, never both.

**Dropped on arrival, never stored:** `user.email`, `user.id`, `user.account_uuid`, `user.account_id`, `organization.id`, `prompt`, `tool_*`, request and response bodies, `cost_usd` (the dashboard computes the cost from `prices.json` itself) and every attribute not named above. If an exporter sends prompt text anyway (`OTEL_LOG_USER_PROMPTS=1`, Gemini's `logPrompts`, Codex's `log_user_prompt`), it is ignored and never read past the allow-list; the setup instructions must tell the user to leave those switches off (Gemini's `logPrompts` is **on** by default: set it to `false`).

**What OTLP does not carry:** the subscription limits (Claude Code exports none: the mod still sends them) and any history from before the exporter was switched on (the log import covers it). Delivery is best effort: exporters batch (Claude Code: metrics every 60 s, logs every 5 s) and there is no local queue, so the log-based collection stays the exact one where the logs can be read.

## 6. Adding another agent
Make `agents/<name>.mjs` returning rows in exactly this shape (the contract above, with its own `provider` and `turn_id` prefix), reading only numeric fields from the agent's own files or telemetry. Prove "no text leaves" with a test that plants a secret word in the fixture and greps the request body, the state files and the log (see `worker/test/codex-collector.sh`).
