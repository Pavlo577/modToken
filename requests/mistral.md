# Mistral Vibe OTLP Request: Real Event Names and Attributes

**Status:** ⏳ Awaiting verification from Mistral Vibe real-world testing
**Priority:** High (blocks OTLP-based collection for Mistral Vibe)
**Related:** collectors/agents/mistral.mjs, collectors/DATA.md section 5

---

## Background

Mistral Vibe can export OpenTelemetry traces via OTLP/HTTP (see [Mistral Vibe SKILL.md](https://github.com/mistralai/mistral-vibe/blob/main/vibe/plugins/builtins/vibe/skills/vibe/SKILL.md#opentelemetry-tracing)). The modToken Worker already accepts OTLP/JSON at `/v1/logs` and extracts a `ModelCall` structure (collectors/DATA.md §5), but we need the **exact event names and attribute keys** that Mistral Vibe uses to map them correctly.

The current Worker code (worker/src/ingest.ts) handles OTLP for Claude Code with:
- `service.name = "claude-code"` → provider = "claude"
- `event.name = "claude_code.api_request"` → ModelCall

For Mistral Vibe, we need to know:
1. What `service.name` does it use?
2. What event names carry token usage?
3. What attribute keys hold: session_id, turn_id, model, input_tokens, output_tokens, cache tokens, duration

---

## Current Assumptions (from Mistral Vibe docs and code)

From [mistral-vibe/vibe/plugins/builtins/vibe/skills/vibe/SKILL.md](https://github.com/mistralai/mistral-vibe/blob/main/vibe/plugins/builtins/vibe/skills/vibe/SKILL.md):

> Set `enable_otel = true` to export traces for **agent, model, and tool operations** over OTLP/HTTP.

From [docs.mistral.ai/vibe/code/cli/configuration](https://docs.mistral.ai/vibe/code/cli/configuration):

> OpenTelemetry tracing is also listed, which matters if you need to see what an agent run actually did after the fact rather than watching it scroll past.

**Hypothesis:** Mistral Vibe likely uses spans (not logs) for model calls, similar to Claude Code's approach.

---

## What We Need to Verify

### 1. Resource Attributes
```json
{
  "resource": {
    "attributes": [
      { "key": "service.name", "value": { "stringValue": "???" } },
      { "key": "service.version", "value": { "stringValue": "???" } }
    ]
  }
}
```
**Question:** What is the `service.name` value?
- Expected: `"mistral-vibe"` or `"vibe"` or `"mistral"`

### 2. Span Names
**Question:** What span names contain token usage?
- Hypothesis: `"model.generate"` (common in LLM telemetry)
- Alternative: `"mistral.api_request"` or `"vibe.model_call"`

### 3. Span Attributes for Token Usage
```json
{
  "name": "model.generate",
  "attributes": [
    { "key": "model", "value": { "stringValue": "mistral-medium-latest" } },
    { "key": "session_id", "value": { "stringValue": "session-abc123" } },
    { "key": "???", "value": { "stringValue": "turn-xyz456" } },  // turn_id equivalent
    { "key": "input_tokens", "value": { "intValue": "1234" } },
    { "key": "output_tokens", "value": { "intValue": "567" } },
    { "key": "duration_ms", "value": { "intValue": "4500" } },
    { "key": "finish_reason", "value": { "stringValue": "stop" } }
  ]
}
```

**Key Questions:**
1. What attribute holds the **session ID**? (Claude Code uses `session.id`)
2. What attribute holds the **turn/unique call ID**? (Claude Code uses `request_id` for call_id, `prompt.id` for turn_key)
3. Are `input_tokens` and `output_tokens` **delta values** (per call) or **cumulative**?
4. Does Mistral Vibe export **cache tokens**? If so, what attribute names?

### 4. Timing Attributes
- `startTimeUnixNano` / `endTimeUnixNano` → used for `ts`
- `durationNanos` → used for `duration_ms`

---

## Verification Plan

### Option A: Test with Real Mistral Vibe

1. **Setup OTLP endpoint** that logs all incoming data:
   ```bash
   # Simple OTLP receiver that dumps everything to stdout
   npx @opentelemetry/opentelemetry-collector --config=otel-dump.yaml
   ```
   
   `otel-dump.yaml`:
   ```yaml
   receivers:
     otlp:
       protocols:
         http:
   processors:
     batch:
   exporters:
     logging:
       logLevel: debug
   service:
     pipelines:
       traces:
         receivers: [otlp]
         processors: [batch]
         exporters: [logging]
   ```

2. **Configure Mistral Vibe** (`~/.vibe/config.toml`):
   ```toml
   [session_logging]
   enable_otel = true
   otel_endpoint = "http://localhost:4318/v1/traces"
   otel_redaction = "default"
   ```

3. **Run a test session**:
   ```bash
   vibe "Write a hello world program in Python"
   ```

4. **Capture the output** and document the actual:
   - `service.name` value
   - Span names with token data
   - All attribute keys and their values

### Option B: Check Mistral Vibe Source Code

Search the Mistral Vibe codebase for:
- OTLP exporter configuration
- Span creation for model calls
- Attribute naming conventions

Key files to check:
- `vibe/telemetry/` or `vibe/tracing/`
- `vibe/cli/` for CLI-specific telemetry
- Search for `OpenTelemetry`, `Tracer`, `Span`

---

## Expected Output Format

Once verified, we need to update:

1. **`worker/src/ingest.ts`** (or wherever OTLP is processed):
   - Add mapping for Mistral Vibe's `service.name` → provider = "mistral"
   - Add mapping for Mistral Vibe's event/span names → ModelCall extraction

2. **`collectors/DATA.md` section 5**:
   - Add Mistral Vibe column to the mapping table

3. **`requests/mistral.md`**:
   - Document the verified event names and attributes (this file)

---

## Mapping Table (To Be Filled)

| Field | Claude Code (verified) | Mistral Vibe (TBD) | Notes |
|-------|----------------------|-------------------|-------|
| provider | from `service.name = "claude-code"` | from `service.name = ???` | |
| call_id | `request_id` | `???` | |
| session_id | `session.id` | `???` | |
| turn_key | `prompt.id` | `???` | |
| ts | `timeUnixNano` | `endTimeUnixNano` | |
| model | `model` | `model` | |
| input_tokens | `input_tokens` | `input_tokens` | Delta or cumulative? |
| output_tokens | `output_tokens` | `output_tokens` | Delta or cumulative? |
| cache_read_tokens | `cache_read_tokens` | `???` | May not exist |
| cache_creation_tokens | `cache_creation_tokens` | `???` | May not exist |
| duration_ms | `duration_ms` | `durationNanos` or `duration_ms` | |
| is_subagent | `agent.name` (assumed) | `???` | |

---

## Temporary Workaround

Until verification is complete, the **local file-based collector** (`collectors/agents/mistral.mjs`) will be the primary method for Mistral Vibe, as it:
- Reads `~/.vibe/logs/session/*.jsonl` directly
- Uses stable IDs from the session files
- Does not depend on OTLP event naming

---

## References

1. [Mistral Vibe OTLP Documentation](https://github.com/mistralai/mistral-vibe/blob/main/vibe/plugins/builtins/vibe/skills/vibe/SKILL.md#opentelemetry-tracing)
2. [modToken DATA.md §5: OTLP](https://github.com/Pavlo577/modToken/blob/dev/collectors/DATA.md#5-otlp-what-the-worker-receives-and-keeps-a-second-way-in-planned-not-built-yet)
3. [OpenTelemetry Semantic Conventions](https://github.com/open-telemetry/semantic-conventions)
