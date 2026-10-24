// WHAT THE COLLECTOR MAY SEND: the one definition of the data that leaves a machine. Everything goes through `sanitizeRow` /
// `sanitizeLimit` in `post()` (lib/core.mjs), so a field that is not listed here can never be sent, whatever an agent module returns.
// Plain numbers, ids, times and model names only: no prompts, answers, tool output, paths or file names.
// The Worker (worker/src/events.ts, ingest.ts, util.ts) validates the same fields again and cuts strings to 200 characters.
// Human-readable version with examples and the Codex mapping: collectors/DATA.md.

/** At most this many rows in one /api/ingest call (the Worker refuses more than 500). */
export const MAX_ROWS = 500
/** What the collector sends per call. */
export const BATCH = 300
/** At most this many limit readings per call (the Worker ignores the rest). */
export const MAX_LIMITS = 8
/** Agents the Worker accepts. A new agent needs a label and colour in the dashboard (worker/web/core/palette.ts) too. */
export const PROVIDERS = ['claude', 'codex', 'gemini', 'mistral', 'opencode']

/**
 * One turn = one question of the user and everything the model did until it finished (several model calls, tools),
 * counted as ONE row. The same turn may be sent again later with larger numbers (it grew): the Worker keeps the maximum.
 *
 * @typedef {object} TurnRow
 * @property {string} provider        which agent: one of PROVIDERS ('codex' for Codex).
 * @property {string} turn_id         identifies the turn on this device; the same id = the same turn. Prefix by agent: `codex:<thread id>:<turn id>`. Max 200 characters.
 * @property {string} session_id      the conversation (Codex: the thread id from `session_meta.payload.id`). Max 200 characters.
 * @property {string} ts              ISO 8601 UTC time of the LAST model response of the turn (`new Date(ms).toISOString()`).
 * @property {string} model           model name as the agent reports it, e.g. 'gpt-5.6-sol'; 'unknown' if none. Max 200 characters.
 * @property {number} input_tokens    NEW input tokens: input WITHOUT the part read from the cache (Codex: input - cached - cache_write). Integer >= 0.
 * @property {number} output_tokens   output tokens including the reasoning ones (Codex already counts reasoning inside output). Integer >= 0.
 * @property {number} cache_read_tokens      input tokens served from the cache (Codex: cached_input_tokens). Integer >= 0.
 * @property {number} cache_creation_tokens  input tokens written to the cache (Codex: cache_write_input_tokens, 0 if absent). Integer >= 0.
 * @property {number} duration_ms     how long the turn took (Codex: `task_complete.duration_ms`, else last response minus start). Integer >= 0.
 * @property {boolean} is_subagent    true for a turn of a sub-agent / forked helper thread (counted, but shown apart).
 */

/**
 * The state of the user's subscription limit, as the agent reported it last. Send only when it changed.
 *
 * @typedef {object} LimitReading
 * @property {string} provider     as in TurnRow.
 * @property {'five_hour'|'seven_day'} kind  the window: 5 hours or 7 days (Codex: `rate_limits.primary` with window_minutes 240-480 = five_hour, `secondary` with 7200-14400 = seven_day).
 * @property {number} percentUsed  0..100 (the Worker clamps to 0..1000).
 * @property {string} resetsAt     ISO 8601 UTC time when the window resets, or '' if unknown (Codex gives unix seconds in `resets_at`).
 */

const ROW_KEYS = ['provider', 'turn_id', 'session_id', 'ts', 'model', 'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_creation_tokens', 'duration_ms', 'is_subagent']
const int = v => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0)
const str = (v, n = 200) => String(v ?? '').slice(0, n)

/** The row with only the listed fields, typed and cut like the Worker does; null if it cannot be a turn (no id, bad time, unknown agent). */
export function sanitizeRow(r) {
  if (!r || typeof r !== 'object') return null
  const ts = new Date(str(r.ts))
  const provider = r.provider === undefined || r.provider === '' ? 'claude' : String(r.provider)
  if (!str(r.turn_id) || Number.isNaN(ts.getTime()) || !PROVIDERS.includes(provider)) return null
  return {
    provider, turn_id: str(r.turn_id), session_id: str(r.session_id), ts: ts.toISOString(), model: str(r.model) || 'unknown',
    input_tokens: int(r.input_tokens), output_tokens: int(r.output_tokens), cache_read_tokens: int(r.cache_read_tokens),
    cache_creation_tokens: int(r.cache_creation_tokens), duration_ms: int(r.duration_ms), is_subagent: r.is_subagent === true,
  }
}

/** The limit reading with only the listed fields; null if it is not a reading the dashboard knows. */
export function sanitizeLimit(l) {
  if (!l || typeof l !== 'object') return null
  const provider = l.provider === undefined || l.provider === '' ? 'claude' : String(l.provider)
  const pct = Number(l.percentUsed)
  if (!PROVIDERS.includes(provider) || !['five_hour', 'seven_day'].includes(l.kind) || !Number.isFinite(pct)) return null
  const at = l.resetsAt ? new Date(str(l.resetsAt)) : null
  return { provider, kind: l.kind, percentUsed: Math.min(1000, Math.max(0, pct)), resetsAt: at && !Number.isNaN(at.getTime()) ? at.toISOString() : '' }
}

export { ROW_KEYS }
