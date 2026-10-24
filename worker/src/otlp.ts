// OTLP/HTTP in JSON → the one structure the Worker keeps (collectors/DATA.md, section 5). Pure: no database, no request.
// Only the fields named here are read; everything else in the payload (user.email, account ids, prompts, tool details ...) is never looked at again.
import { int, str } from './util.ts'

/** One request to the model, whatever the agent. */
export interface ModelCall {
  provider: 'claude'
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
  is_subagent: boolean
}

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
  return {
    provider: 'claude', call_id: str(call), session_id: session, turn_key: text(a, 'prompt.id') || str(call), ts,
    model: text(a, 'model') || 'unknown', input_tokens: input, output_tokens: output, cache_read_tokens: read, cache_creation_tokens: write,
    duration_ms: count(a, 'duration_ms'),
    // `agent_id` is set on the events of sub-agents only (Claude Code 2.1.310+, monitoring docs); the main session has none.
    is_subagent: text(a, 'agent_id') !== '',
  }
}

/** Which agent an exporter is, by its `service.name`; one adapter per agent (Codex, Gemini and Mistral follow once their telemetry is read). */
const ADAPTERS: Record<string, ((a: Attrs, rec: LogRecord) => ModelCall | null) | undefined> = {
  'claude-code': claudeCall,
}

/** `claude-code` (terminal), `claude-code-desktop` (the Claude app) and the like: one adapter, matched by the start of the name. */
const adapterFor = (service: string) => ADAPTERS[service] ?? (service.startsWith('claude-code') ? ADAPTERS['claude-code'] : undefined)

export const MAX_RECORDS = 5000

/** The calls in an OTLP logs payload and how many records were not one (other events, other services, empty requests). */
export interface Seen { service: string; event: string; keys: string; lens: string; sample: string; n: number }

/** Attributes that may carry the text of the conversation. Only their LENGTH (and whether they look like a redaction placeholder) is ever reported. */
const CONTENT_KEYS = ['prompt', 'prompt_text', 'response', 'tool_input', 'tool_parameters', 'tool_result', 'tool_output', 'error', 'body']
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

export function parseOtlpLogs(payload: unknown, sampleAll: boolean | 'raw' = false): { calls: ModelCall[]; ignored: number; seen: Seen[] } | null {
  const doc = payload as OtlpLogs
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.resourceLogs)) return null
  const calls: ModelCall[] = []
  const names = new Map<string, Seen>()
  let ignored = 0
  let seen = 0
  for (const rl of doc.resourceLogs) {
    const service = text(attrs(rl?.resource?.attributes), 'service.name')
    const adapter = adapterFor(service)
    for (const scope of Array.isArray(rl?.scopeLogs) ? rl.scopeLogs : []) {
      for (const rec of Array.isArray(scope?.logRecords) ? scope.logRecords : []) {
        if (++seen > MAX_RECORDS) return null
        const call = adapter && rec ? adapter(attrs(rec.attributes), rec) : null
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
  return { calls, ignored, seen: [...names.values()] }
}
