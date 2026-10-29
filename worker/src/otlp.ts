// OTLP/HTTP in JSON → the one structure the Worker keeps (collectors/DATA.md, section 5). Pure: no database, no request.
// Only the fields named here are read; everything else in the payload (user.email, account ids, prompts, tool details ...) is never looked at again.
import { int, str } from './util.ts'

/** One request to the model, whatever the agent. */
export interface ModelCall {
  provider: 'claude' | 'codex'
  /** The same call sent twice is counted once. */
  call_id: string
  session_id: string
  /** What groups calls into one turn (Claude Code: prompt.id). */
  turn_key: string
  ts: string
  model: string
  /** New input only: the cached part excluded. */
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_creation_tokens: number
  duration_ms: number
  /** The agent's own price estimate of the call in millionths of a dollar (Claude Code: cost_usd_micros); 0 when it does not say. */
  cost_micros: number
  is_subagent: boolean
  /**
   * main: the session's own work (one row per prompt, counted as a turn); sub: a sub-agent; bg: background requests Claude makes by itself
   * (prompt suggestions, titles, summaries, compaction); step: one model call of a turn that has its main row elsewhere (Codex)
   */
  kind: CallKind
}

export type CallKind = 'main' | 'sub' | 'bg' | 'step'
/** query_source of the session's own requests (terminal / IDE, the app and the cloud); an empty one is the main session too */
const MAIN_SOURCES = new Set(['', 'repl_main_thread', 'sdk'])

type Scalar = string | number | boolean
type Attrs = Map<string, Scalar>

interface AnyValue { stringValue?: string; intValue?: string | number; doubleValue?: number; boolValue?: boolean }
interface KeyValue { key?: string; value?: AnyValue }
interface LogRecord { timeUnixNano?: string | number; body?: AnyValue; attributes?: KeyValue[] }
interface OtlpLogs { resourceLogs?: { resource?: { attributes?: KeyValue[] }; scopeLogs?: { logRecords?: LogRecord[] }[] }[] }

/** OTLP/JSON writes an int64 as a string ("86013"): numbers come out as numbers here. */
function attrs(list: KeyValue[] | undefined): Attrs {
  const out: Attrs = new Map()
  for (const kv of Array.isArray(list) ? list : []) {
    const v = kv?.value
    if (!kv || typeof kv.key !== 'string' || !v) continue
    if (typeof v.stringValue === 'string') out.set(kv.key, v.stringValue)
    else if (v.intValue !== undefined) out.set(kv.key, Number(v.intValue))
    else if (typeof v.doubleValue === 'number') out.set(kv.key, v.doubleValue)
    else if (typeof v.boolValue === 'boolean') out.set(kv.key, v.boolValue)
  }
  return out
}

const text = (a: Attrs, key: string, n = 200): string => {
  const v = a.get(key)
  return typeof v === 'string' ? str(v, n) : typeof v === 'number' ? String(v) : ''
}
const count = (a: Attrs, key: string): number => {
  const v = a.get(key)
  return typeof v === 'number' ? int(v) : 0
}

/** Nanoseconds since the epoch (a string of up to 19 digits) to an ISO time; '' when it is not one. */
function isoFromNanos(ns: string | number | undefined): string {
  try {
    if (ns === undefined || ns === '') return ''
    const ms = Number(BigInt(ns) / 1_000_000n)
    const d = new Date(ms)
    return Number.isNaN(d.getTime()) || ms <= 0 ? '' : d.toISOString()
  } catch {
    return ''
  }
}

/**
 * Claude Code: the event `claude_code.api_request` (once per request to the API). Verified against its monitoring documentation:
 * model, duration_ms, input_tokens (the cache excluded), output_tokens, cache_read_tokens, cache_creation_tokens, request_id,
 * prompt.id (all the events of one user prompt), session.id.
 */
function claudeCall(a: Attrs, rec: LogRecord): ModelCall | null {
  const name = (text(a, 'event.name') || (typeof rec.body?.stringValue === 'string' ? rec.body.stringValue : '')).replace(/^claude_code\./, '')
  if (name !== 'api_request') return null
  const ts = isoFromNanos(rec.timeUnixNano) || (Date.parse(text(a, 'event.timestamp')) ? new Date(text(a, 'event.timestamp')).toISOString() : '')
  const input = count(a, 'input_tokens'), output = count(a, 'output_tokens'), read = count(a, 'cache_read_tokens'), write = count(a, 'cache_creation_tokens')
  if (!ts || input + output + read + write === 0) return null // no time, or a request that cost nothing (an error)
  const session = text(a, 'session.id')
  const call = text(a, 'request_id') || `${session}:${rec.timeUnixNano ?? ts}:${text(a, 'event.sequence')}`
  // a sub-agent's call: `agent_id` is set on its events (Claude Code 2.1.310+), and its `query_source` is "subagent" or "agent:<type>";
  // the main session's is repl_main_thread, sdk or none; anything else is Claude working by itself (prompt_suggestion, generate_session_title ...)
  const source = text(a, 'query_source')
  const kind: CallKind = text(a, 'agent_id') !== '' || source === 'subagent' || source.startsWith('agent:') ? 'sub' : MAIN_SOURCES.has(source) ? 'main' : 'bg'
  const model = text(a, 'model') || 'unknown'
  const prompt = text(a, 'prompt.id') || str(call)
  return {
    // one row per prompt for the session's own work; a sub-agent's or a background request's calls get rows of their own, by model,
    // so that neither is counted as the prompt's model nor marks the whole prompt as a sub-agent's
    provider: 'claude', call_id: str(call), session_id: session, turn_key: kind === 'main' ? prompt : `${prompt}:${kind}:${model}`, ts, kind,
    model, input_tokens: input, output_tokens: output, cache_read_tokens: read, cache_creation_tokens: write,
    duration_ms: count(a, 'duration_ms'),
    cost_micros: count(a, 'cost_usd_micros') || (typeof a.get('cost_usd') === 'number' ? Math.round((a.get('cost_usd') as number) * 1e6) : 0),
    is_subagent: kind === 'sub',
  }
}

/**
 * Codex CLI (openai/codex, crate codex-rs/otel; not yet checked against a real payload). Every event carries `conversation.id` and `model`.
 * - `codex.sse_event` with `event.kind` = response.completed: one model call. `input_token_count` holds the whole input, the cached part
 *   (`cached_token_count`) and the cache writes (`cache_write_token_count`) included, so both are taken out of it; `output_token_count`
 *   already holds `reasoning_token_count`. The event has no turn id, so each call is a `step` row of its own.
 * - `codex.user_prompt`: the user's message (its text is "[REDACTED]" unless log_user_prompt is on, and never read here) becomes the
 *   turn's `main` row with no tokens, so that a turn is counted once whatever the number of calls it makes.
 */
function codexCall(a: Attrs, rec: LogRecord): ModelCall | null {
  const name = text(a, 'event.name') || (typeof rec.body?.stringValue === 'string' ? rec.body.stringValue : '')
  const ts = isoFromNanos(rec.timeUnixNano) || (Date.parse(text(a, 'event.timestamp')) ? new Date(text(a, 'event.timestamp')).toISOString() : '')
  const session = text(a, 'conversation.id')
  if (!ts || !session) return null
  const at = String(rec.timeUnixNano ?? ts)
  const model = text(a, 'model') || 'unknown'
  const base = { provider: 'codex' as const, session_id: session, ts, model, duration_ms: count(a, 'duration_ms'), cost_micros: 0, is_subagent: false }
  if (name === 'codex.user_prompt') {
    const id = str(`${session}:prompt:${at}`)
    return { ...base, call_id: id, turn_key: id, kind: 'main', input_tokens: 0, output_tokens: 0, cache_read_tokens: 0, cache_creation_tokens: 0 }
  }
  if (name !== 'codex.sse_event' || text(a, 'event.kind') !== 'response.completed') return null
  const read = count(a, 'cached_token_count'), write = count(a, 'cache_write_token_count'), output = count(a, 'output_token_count')
  const input = Math.max(0, count(a, 'input_token_count') - read - write)
  if (input + output + read + write === 0) return null
  const id = str(`${session}:call:${at}`)
  return { ...base, call_id: id, turn_key: id, kind: 'step', input_tokens: input, output_tokens: output, cache_read_tokens: read, cache_creation_tokens: write }
}

/** Which agent an exporter is, by its `service.name`; one adapter per agent (Gemini and Mistral follow once their telemetry is read). */
const ADAPTERS: Record<string, ((a: Attrs, rec: LogRecord) => ModelCall | null) | undefined> = {
  'claude-code': claudeCall,
  codex: codexCall,
}

/**
 * `claude-code` (terminal), `claude-code-desktop` (the Claude app) and the like: one adapter, matched by the start of the name. Codex names
 * the service after its originator (codex_cli_rs, codex_exec, codex_vscode ...), so every name that starts with `codex` is Codex.
 */
const adapterFor = (service: string) =>
  ADAPTERS[service] ?? (service.startsWith('claude-code') ? ADAPTERS['claude-code'] : service.startsWith('codex') ? ADAPTERS.codex : undefined)

export const MAX_RECORDS = 5000

/** The calls in an OTLP logs payload and how many records were not one (other events, other services, empty requests). */
export interface Seen { service: string; event: string; keys: string; lens: string; sample: string; n: number }

/** Attributes that may carry the text of the conversation. Only their LENGTH (and whether they look like a redaction placeholder) is ever reported. */
const CONTENT_KEYS = ['prompt', 'prompt_text', 'response', 'tool_input', 'tool_parameters', 'tool_result', 'tool_output', 'error', 'body', 'arguments', 'output', 'error.message']
/** Identity attributes: in a sample only their length is shown. */
const MASKED_KEYS = ['user.email', 'user.id', 'user.account_uuid', 'user.account_id', 'organization.id', 'process.owner']
/**
 * One record as `name: value` for finding out what an exporter sends. Only identifier-like values (no spaces, up to 40 characters) and
 * numbers are shown; identity attributes, conversation attributes and any prose are replaced by their length.
 */
export function sampleOf(a: Attrs, raw = false): string {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of [...a.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    const key = NAME(k)
    if (raw) out[key] = typeof v === 'string' ? v.slice(0, 500) : v // the temporary raw mode (DEBUG_OTLP = 'raw'): nothing masked
    else if (typeof v !== 'string') out[key] = v
    else if (MASKED_KEYS.includes(k) || CONTENT_KEYS.includes(k)) out[key] = `<masked:${v.length}>`
    else out[key] = /^[\w.:/+-]{0,40}$/.test(v) ? v : `<text:${v.length}>`
  }
  return JSON.stringify(out).slice(0, 6000)
}
const lensOf = (a: Attrs): string =>
  CONTENT_KEYS.flatMap(k => { const v = a.get(k); return typeof v === 'string' ? [`${k}=${v.length}${/^\W*redact/i.test(v) ? 'R' : ''}`] : [] }).join(',')

/** What the exporter sent, by names only: the service, the event and the attribute NAMES (never a value), counted. For finding out why nothing was recognised. */
const NAME = (v: string) => v.replace(/[^\w.:-]/g, '').slice(0, 80)

/** One event as it is kept in the events database: what happened, when, where, and its harmless attributes (numbers, flags, identifier-like words). */
export interface EventRow {
  /** Unique per device: the same event sent twice is stored once. */
  dedupe: string
  ts: string
  name: string
  service: string
  session_id: string
  prompt_id: string
  /** Where the agent ran: terminal.type (non-interactive = the Claude app, pycharm, ssh-session, linux = cloud ...). */
  surface: string
  /** Attributes as JSON. */
  attrs: string
}

/** Attributes that are never kept: who the user is, and anything that may hold the text of the conversation. */
const NEVER_KEPT = new Set([...MASKED_KEYS, ...CONTENT_KEYS, 'user.email', 'user.groups', 'identity.source', 'server_name', 'hook_matcher', 'hook_definitions', 'managed_settings.helper.path', 'managed_settings.settings'])
/** Attributes that already have a column of their own. */
const COLUMN_KEYS = new Set(['event.name', 'event.timestamp', 'session.id', 'conversation.id', 'prompt.id', 'terminal.type', 'service.name'])

/**
 * The attributes worth keeping, by construction safe: numbers, flags and short identifier-like words only (no spaces, no '@'), so a
 * sentence or an address cannot get through whatever its attribute is called. Numbers that arrive as strings ("1227") become numbers.
 */
export function safeAttrs(a: Attrs): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [k, v] of [...a.entries()].sort(([x], [y]) => x.localeCompare(y))) {
    if (NEVER_KEPT.has(k) || COLUMN_KEYS.has(k) || k.startsWith('user.') || Object.keys(out).length >= 60) continue
    const key = NAME(k)
    if (!key) continue
    if (typeof v === 'number') { if (Number.isFinite(v)) out[key] = v }
    else if (typeof v === 'boolean') out[key] = v
    else if (/^-?\d{1,15}(\.\d+)?$/.test(v)) out[key] = Number(v)
    else if (/^[\w.:/+-]{1,64}$/.test(v)) out[key] = v
  }
  return out
}

function eventRowOf(service: string, a: Attrs, rec: LogRecord): EventRow | null {
  const name = NAME((text(a, 'event.name') || (typeof rec.body?.stringValue === 'string' ? rec.body.stringValue : '')).replace(/^claude_code\./, ''))
  const ts = isoFromNanos(rec.timeUnixNano) || (Date.parse(text(a, 'event.timestamp')) ? new Date(text(a, 'event.timestamp')).toISOString() : '')
  if (!name || !ts) return null
  const session = text(a, 'session.id') || text(a, 'conversation.id') // conversation.id: Codex
  return {
    dedupe: `${session}|${name}|${text(a, 'event.sequence')}|${ts}`.slice(0, 200), ts, name, service: NAME(service), session_id: session, prompt_id: text(a, 'prompt.id'),
    surface: NAME(text(a, 'terminal.type')), attrs: JSON.stringify(safeAttrs(a)).slice(0, 3000),
  }
}

export function parseOtlpLogs(payload: unknown, sampleAll: boolean | 'raw' = false): { calls: ModelCall[]; ignored: number; seen: Seen[]; events: EventRow[] } | null {
  const doc = payload as OtlpLogs
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.resourceLogs)) return null
  const calls: ModelCall[] = []
  const events: EventRow[] = []
  const names = new Map<string, Seen>()
  let ignored = 0
  let seen = 0
  for (const rl of doc.resourceLogs) {
    const service = text(attrs(rl?.resource?.attributes), 'service.name')
    const adapter = adapterFor(service)
    for (const scope of Array.isArray(rl?.scopeLogs) ? rl.scopeLogs : []) {
      for (const rec of Array.isArray(scope?.logRecords) ? scope.logRecords : []) {
        if (++seen > MAX_RECORDS) return null
        const recAttrs = rec ? attrs(rec.attributes) : null
        const call = adapter && rec && recAttrs ? adapter(recAttrs, rec) : null
        const row = adapter && rec && recAttrs ? eventRowOf(service, recAttrs, rec) : null
        if (row) events.push(row)
        if (call) calls.push(call)
        else ignored++
        if ((!call || sampleAll) && rec && names.size < 50) {
          const a = attrs(rec.attributes)
          const event = NAME(text(a, 'event.name') || (typeof rec.body?.stringValue === 'string' ? rec.body.stringValue : ''))
          const key = `${NAME(service)}|${event}`
          const hit = names.get(key)
          if (hit) hit.n++
          else names.set(key, { service: NAME(service), event, keys: [...a.keys()].map(NAME).sort().join(',').slice(0, 600), lens: lensOf(a), sample: sampleOf(a, sampleAll === 'raw'), n: 1 })
        }
      }
    }
  }
  return { calls, ignored, seen: [...names.values()], events }
}
