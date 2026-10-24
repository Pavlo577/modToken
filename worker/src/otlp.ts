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
    // Not told apart yet: which attribute marks a sub-agent's request is not verified, so none is guessed (a wrong guess would flag every turn).
    is_subagent: false,
  }
}

/** Which agent an exporter is, by its `service.name`; one adapter per agent (Codex, Gemini and Mistral follow once their telemetry is read). */
const ADAPTERS: Record<string, ((a: Attrs, rec: LogRecord) => ModelCall | null) | undefined> = {
  'claude-code': claudeCall,
}

export const MAX_RECORDS = 5000

/** The calls in an OTLP logs payload and how many records were not one (other events, other services, empty requests). */
export function parseOtlpLogs(payload: unknown): { calls: ModelCall[]; ignored: number } | null {
  const doc = payload as OtlpLogs
  if (!doc || typeof doc !== 'object' || !Array.isArray(doc.resourceLogs)) return null
  const calls: ModelCall[] = []
  let ignored = 0
  let seen = 0
  for (const rl of doc.resourceLogs) {
    const service = text(attrs(rl?.resource?.attributes), 'service.name')
    const adapter = ADAPTERS[service]
    for (const scope of Array.isArray(rl?.scopeLogs) ? rl.scopeLogs : []) {
      for (const rec of Array.isArray(scope?.logRecords) ? scope.logRecords : []) {
        if (++seen > MAX_RECORDS) return null
        const call = adapter && rec ? adapter(attrs(rec.attributes), rec) : null
        if (call) calls.push(call)
        else ignored++
      }
    }
  }
  return { calls, ignored }
}
