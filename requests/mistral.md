# Mistral Vibe: Session File Format and OTLP Verification

**Status:** ⏳ Awaiting verification from real Mistral Vibe session files
**Priority:** High (blocks accurate turn tracking)
**Related:** collectors/agents/mistral.mjs, collectors/DATA.md

---

## Background

Mistral Vibe stores session data in JSON Lines format at `~/.vibe/logs/session/session-<ID>.jsonl`.
The collector (`collectors/agents/mistral.mjs`) reads these files to extract token usage.

This document tracks:
1. The **exact format** of Mistral Vibe session files
2. How **turn IDs are generated** to ensure uniqueness
3. How **token deltas are calculated** from cumulative counts
4. OTLP event names and attributes (for future direct-to-Worker sending)

---

## Session File Format (To Be Verified)

### Assumed Structure

Based on Mistral Vibe documentation and similar tools (Codex, Claude Code), we assume session files contain JSON Lines with events like:

```json
{"type":"message","role":"user","content":"...","session_id":"session-abc123","turn_id":"turn-1","timestamp":"2024-01-01T12:00:00.000Z"}
{"type":"message","role":"assistant","content":"...","session_id":"session-abc123","turn_id":"turn-1","model":"mistral-medium-latest","token_usage":{"input_tokens":100,"output_tokens":50},"timestamp":"2024-01-01T12:00:05.000Z","duration_ms":5000}
{"type":"message","role":"assistant","content":"...","session_id":"session-abc123","turn_id":"turn-2","model":"mistral-medium-latest","token_usage":{"input_tokens":150,"output_tokens":75},"timestamp":"2024-01-01T12:01:00.000Z","duration_ms":6000}
```

### Key Observations

1. **Cumulative Token Counts**: The `token_usage` object appears to contain **cumulative** counts for the session, not per-turn deltas.
   - First event: `input_tokens: 100, output_tokens: 50`
   - Second event: `input_tokens: 150, output_tokens: 75` (cumulative)
   - Delta: `input_tokens: 50, output_tokens: 25`

2. **Turn Identification**: Each turn should have a unique identifier. The collector currently uses:
   - Format: `mistral:<session_id>:<turn_id>:<line_number>`
   - Fallback: If `turn_id` is missing, uses line number only
   - This ensures uniqueness even if `turn_id` is missing or duplicated

3. **Delta Calculation**: The collector tracks the last seen cumulative values and calculates deltas:
   ```javascript
   // For each message event with token_usage
   const inputDelta = currentInputTotal - lastInputTotal
   const outputDelta = currentOutputTotal - lastOutputTotal
   ```

### Verification Needed

We need to confirm:
1. ✅ Do session files exist at `~/.vibe/logs/session/session-<ID>.jsonl`?
2. ✅ Are they JSON Lines format?
3. ❓ What are the exact field names in message events?
   - Is it `session_id` or `session.id`?
   - Is it `turn_id` or `turn.id`?
   - Is it `token_usage` or `usage`?
4. ❓ Are token counts **cumulative** or **per-turn**?
5. ❓ Does every turn have a unique `turn_id`?
6. ❓ What other fields are present? (model, timestamp, duration_ms, etc.)

---

## Real Example Needed

If you have access to a real Mistral Vibe session file, please provide:
1. A **sample line** (with sensitive data redacted)
2. The **complete list of field names** in message events
3. Whether `token_usage` values are cumulative or per-turn

Example request:
```
Please share a sample line from ~/.vibe/logs/session/session-*.jsonl with:
- All field names (values can be replaced with placeholders)
- Confirmation if input_tokens/output_tokens are cumulative
```

---

## Turn ID Generation Strategy

### Current Implementation (collectors/agents/mistral.mjs)

To ensure **unique turn IDs** within a session, the collector uses:

```javascript
const sessionId = event.session_id || basename(path).replace('.jsonl', '')
const turnId = event.turn_id || String(lineIndex)
const stableTurnId = `mistral:${sessionId}:${turnId}:${lineIndex}`
```

### Why Line Number?

The original implementation used:
```javascript
const turnId = `mistral:${sessionId}:${Object.keys(tokenUsage).join('-')}`
```

**Problem**: `Object.keys(tokenUsage)` returns `['input_tokens', 'output_tokens']` for every turn, resulting in **identical turn IDs** for all turns in a session. The Worker then keeps only the maximum values, **silently losing data**.

**Solution**: Include the **line number** in the turn ID to ensure uniqueness:
```javascript
`mistral:${sessionId}:${turnId}:${lineIndex}`
```

This ensures:
- Each line in the file generates a unique turn ID
- Even if `turn_id` is missing or duplicated, line number provides uniqueness
- Deltas are still calculated correctly from cumulative counts

### Alternative Approaches

1. **Use a hash of the line content** (more robust but slower):
   ```javascript
   const lineHash = crypto.createHash('sha256').update(line).digest('hex').slice(0, 8)
   const stableTurnId = `mistral:${sessionId}:${lineHash}`
   ```

2. **Use timestamp + sequence number** (if available in the data):
   ```javascript
   const stableTurnId = `mistral:${sessionId}:${event.timestamp}:${event.sequence}`
   ```

3. **Use the file modification time + line number**:
   ```javascript
   const fileMtime = statSync(path).mtimeMs
   const stableTurnId = `mistral:${sessionId}:${fileMtime}:${lineIndex}`
   ```

**Current choice**: Line number is simplest and most reliable for JSON Lines format.

---

## Delta Calculation from Cumulative Counts

### The Problem

Mistral Vibe (like Codex) appears to store **cumulative token counts** per session, not per-turn values.

Example session file:
```json
// Turn 1
{"type":"message","token_usage":{"input_tokens":100,"output_tokens":50}}
// Turn 2
{"type":"message","token_usage":{"input_tokens":150,"output_tokens":75}}
// Turn 3
{"type":"message","token_usage":{"input_tokens":200,"output_tokens":100}}
```

### The Solution

The collector maintains **running totals** and calculates deltas:

```javascript
let lastInputTotal = 0
let lastOutputTotal = 0

for (const line of lines) {
  const event = JSON.parse(line)
  if (event.token_usage) {
    const inputTotal = event.token_usage.input_tokens
    const outputTotal = event.token_usage.output_tokens
    
    const inputDelta = inputTotal - lastInputTotal  // 100, 50, 50
    const outputDelta = outputTotal - lastOutputTotal  // 50, 25, 25
    
    // Send turn with delta values
    turns.push({
      input_tokens: inputDelta,
      output_tokens: outputDelta
    })
    
    lastInputTotal = inputTotal
    lastOutputTotal = outputTotal
  }
}
```

### Edge Cases

1. **Token counts go down** (session restart?):
   - Current: `Math.max(0, delta)` ensures non-negative values
   - Alternative: Reset running totals to current values

2. **Missing token_usage**: Skip the line

3. **Non-numeric token values**: Convert to Number, fallback to 0

---

## OTLP Integration (Future)

Once we have real OTLP data from Mistral Vibe, we need to verify:

### 1. Resource Attributes
```json
{
  "resource": {
    "attributes": [
      { "key": "service.name", "value": { "stringValue": "???" } }
    ]
  }
}
```
**Expected**: `service.name = "mistral-vibe"` or similar

### 2. Span/Log Attributes

For model calls, we need:
- Span name (e.g., `"model.generate"`, `"mistral.api_call"`)
- `session_id` attribute
- `turn_id` or equivalent attribute
- `input_tokens`, `output_tokens` attributes
- `model` attribute
- `duration_ms` or `durationNanos` attribute

### 3. Mapping to Worker's ModelCall

The Worker expects OTLP data at `/v1/logs` in this format:

```typescript
type ModelCall = {
  provider: 'mistral'  // from service.name
  call_id: string      // unique call identifier
  session_id: string   // conversation identifier
  turn_key: string     // groups calls into turns
  ts: string           // ISO UTC timestamp
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  duration_ms: number
  is_subagent: boolean
}
```

### 4. Verification Checklist

- [ ] Confirm `service.name` value for Mistral Vibe
- [ ] Identify span/log name containing token usage
- [ ] Map all required ModelCall fields
- [ ] Verify token counts are per-call (not cumulative)
- [ ] Test with real OTLP export from Mistral Vibe

---

## Testing Requirements

The collector needs tests to verify:

1. **No sensitive data leakage**:
   - Secret words in fixture files must NOT appear in:
     - HTTP request bodies
     - State files
     - Log output

2. **Correct delta calculation**:
   - Cumulative counts → correct deltas
   - Edge cases (resets, missing values) handled properly

3. **Unique turn IDs**:
   - No collisions within a session
   - Line numbers ensure uniqueness

4. **Error handling**:
   - Malformed lines skipped
   - Network errors propagated correctly
   - State cleaned up on errors

### Test File Location

Tests should be added to:
- `worker/test/mistral.test.mjs` (for Worker-side OTLP handling)
- `worker/test/mistral-collector.test.mjs` (for collector functionality)

Example test structure:
```javascript
// worker/test/mistral-collector.test.mjs
import { parseSessionFile } from '../../collectors/agents/mistral.mjs'
import { assert } from 'node:assert'

Deno.test('Mistral Vibe session parsing', () => {
  // Create fixture with known data
  const fixture = `...`
  
  // Parse and verify
  const turns = parseSessionFile(fixture)
  assert(turns.length > 0, 'Should parse turns')
  assert(turns[0].provider === 'mistral', 'Should set provider')
  
  // Verify no sensitive data
  const requestBody = JSON.stringify({ rows: turns })
  assert(!requestBody.includes('SECRET'), 'Should not leak secrets')
})
```

---

## References

1. [Mistral Vibe Configuration Docs](https://docs.mistral.ai/vibe/code/cli/configuration)
2. [Mistral Vibe OTLP Docs](https://github.com/mistralai/mistral-vibe/blob/main/vibe/plugins/builtins/vibe/skills/vibe/SKILL.md#opentelemetry-tracing)
3. [modToken DATA.md](https://github.com/Pavlo577/modToken/blob/dev/collectors/DATA.md)
4. [Codex Collector](https://github.com/Pavlo577/modToken/blob/dev/collectors/agents/codex.mjs) (similar approach)
