# OTLP: what the Worker receives and keeps
Token Tracker takes **OpenTelemetry only**: an agent exports its API-request events straight to the site and the Worker turns them into one structure (`ModelCall`, below). The Worker takes **OTLP/HTTP in JSON** (`POST /v1/logs`, header `x-device-token: <device token>` or `Authorization: Bearer <device token>`). Everything else in the payload is dropped on arrival, so the privacy boundary is the Worker's allow-list (`worker/src/otlp.ts`).

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

**How calls become a turn row.** The Worker groups calls by `(device, provider, session_id, turn_key)`; the row has `turn_id = otlp:<provider>:<session_id>:<turn_key>`, `ts` = the last call's time, `model` = the model of the last call that had output, and the four token counters are **sums** of the calls (additive, unlike section 2 where a resend keeps the maximum). A call is added once: a table `otlp_calls (device_id, call_id)` (kept 14 days) records what was counted, and a call that is already there changes nothing. `duration_ms` is the sum of the calls' durations, so it is shorter than a log-based turn (which is prompt to last reply, waiting included): 

**Dropped on arrival, never stored:** `user.email`, `user.id`, `user.account_uuid`, `user.account_id`, `organization.id`, `prompt`, `tool_*`, request and response bodies, `cost_usd` (the dashboard computes the cost from `prices.json` itself) and every attribute not named above. If an exporter sends prompt text anyway (`OTEL_LOG_USER_PROMPTS=1`, Gemini's `logPrompts`, Codex's `log_user_prompt`), it is ignored and never read past the allow-list; the setup instructions must tell the user to leave those switches off (Gemini's `logPrompts` is **on** by default: set it to `false`).

**What OTLP does not carry:** the subscription limits (Claude Code exports none) and any history from before the exporter was switched on. Delivery is best effort: exporters batch (Claude Code: metrics every 60 s, logs every 5 s) and there is no local queue, so a short outage loses the calls of that moment; the dashboard counts what arrived.

